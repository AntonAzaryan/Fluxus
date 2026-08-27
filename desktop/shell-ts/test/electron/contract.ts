/**
 * Реализация на Electron под общим контрактным сьютом границы (DSK-6) — прогон
 * ВНЕ гейта: `npm run contract:electron -w @fluxus/desktop-shell`.
 *
 * DSK-6: «Любая реализация контейнера SHALL проходить один общий контрактный
 * тест-сьют границы», и «полный прогон в контейнере — отдельная проверка вне
 * гейта». Отсюда ровно два прогона ОДНОГО сьюта и ни одного второго набора
 * утверждений: в `npm run check` его исполняет чистый Node
 * (`test/hostBridge.contract.test.ts`), здесь — настоящее окно с preload'ом,
 * IPC и protocol handler'ом. Проверенным оказывается то, чего первый прогон не
 * видит по построению: отказ границы, доехавший через IPC; события живого
 * `fs.watch` и отписка от них; поверхность, собранная preload'ом, а не
 * сборщиком моста; ответ страницы на запрос закрытия окна.
 *
 * Имя файла — не `*.test.ts` намеренно: `vitest run` пакета его не подхватывает,
 * и гейт остаётся зелёным в окружении без установленного контейнера. Свой
 * конфиг лежит рядом.
 *
 * ## Мост собирается из того, что видит страница
 *
 * `open` не строит `DesktopBridge` по профилю — он спрашивает страницу, какие
 * функции в ней на самом деле есть, и делает объект ровно из них. Иначе
 * утверждение «возможности, которой профиль не давал, нет» проверяло бы
 * согласие теста с самим собой.
 *
 * ## Чего этот файл НЕ делает
 *
 * Не повторяет ни одного утверждения сьюта: всё, что здесь есть, — поднятие
 * контейнера и перевод вызовов границы в его канал.
 *
 * Свои утверждения здесь ровно про одно — про доверие сертификату (DSK-8), и
 * живут они здесь по необходимости: общий сьют границы выразить их не может.
 * Проверке нужна НАСТОЯЩАЯ проверка сертификата, которую контейнер дополняет; у
 * реализации на чистом Node её нет вовсе — там некому отвергнуть self-signed
 * сертификат и, значит, нечего дополнять. Порядок оснований, книга доверия и
 * схлопывание вопросов проверены в гейте на чистом Node (`test/trust.test.ts`);
 * здесь проверяется то, чего тот прогон не видит, — что решение доезжает до
 * настоящего Chromium и открывает (или не открывает) настоящий канал. Вопрос
 * человеку заменён автоответом (`--trust-answer`): диалог предъявлять некому.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  BridgeChange,
  BridgeChangeListener,
  BridgeChoice,
  BridgeChoiceRequest,
  BridgeCloseHandler,
  BridgeEntry,
  BridgeRootId,
  BridgeServiceState,
  BridgeSession,
  DesktopBridge,
} from '../../src/bridge/types.js';
import type { TrustQuestion } from '../../src/host/index.js';
import {
  CONTENT,
  SERVICE,
  describeContainerContract,
  type ContractCase,
  type ContractResponse,
  type ContractSession,
} from '../contractSuite.js';
import {
  dropTree,
  freePort,
  linkOutside,
  makeTree,
  putFile,
  readText,
  SERVICE_SCRIPT,
  TLS_SERVICE_SCRIPT,
} from '../support.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = join(PACKAGE, 'src/electron/entry.mjs');
const MARK = 'CONTRACT ';
/** Как часто вытягиваются события страницы: у текстового канала их канал — опрос. */
const DRAIN_MS = 20;

/** Путь к бинарю Electron. Его отсутствие названо вслух, а не изображает отказ контейнера. */
function electronBinary(): string {
  let path: unknown = null;
  try {
    path = createRequire(import.meta.url)('electron');
  } catch {
    path = null;
  }
  if (typeof path !== 'string' || !existsSync(path)) {
    throw new Error(
      'Electron не установлен: прогон контракта в контейнере требует его бинаря ' +
        '(`npm install` без ELECTRON_SKIP_BINARY_DOWNLOAD). Гейт `npm run check` его не требует (DSK-6).',
    );
  }
  return path;
}

const BINARY = electronBinary();

/**
 * Флаги окружения, а не контейнера: снятая песочница ПРОЦЕССА под root и
 * программный WebGL на машине без GPU. Основания — те же, что у `bin/smoke.mjs`.
 */
function launchFlags(): string[] {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return [
    ...(asRoot ? ['--no-sandbox'] : []),
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ];
}

interface Answer {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly ready?: boolean;
}

/** Событие, скопившееся в странице: изменение дерева либо вопрос о закрытии. */
interface PageEvent {
  readonly kind: 'change' | 'close';
  readonly token?: number;
  readonly change?: BridgeChange;
  readonly id?: number;
  readonly ask?: number;
}

interface PageSurface {
  readonly api: string;
  readonly version: number;
  readonly session: BridgeSession;
  readonly surface: readonly string[];
}

const decodeBytes = (value: unknown): Uint8Array =>
  Uint8Array.from(Buffer.from((value as { bytes: string }).bytes, 'base64'));
const encodeBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface Channel {
  send(op: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** Вызов моста В СТРАНИЦЕ: отказ страницы становится отказом здесь. */
  call(method: string, args: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

/** Канал к поднятому контейнеру: строка JSON туда, строка JSON обратно. */
function connect(child: ChildProcess, ready: () => void, log: string[]): Channel {
  const pending = new Map<number, { ok: (value: unknown) => void; no: (error: Error) => void }>();
  let next = 0;

  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line: string) => {
    if (!line.startsWith(MARK)) {
      log.push(line);
      return;
    }
    const message = JSON.parse(line.slice(MARK.length)) as Answer;
    if (message.ready === true) {
      ready();
      return;
    }
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (waiting === undefined) return;
    if (message.ok) waiting.ok(message.value);
    else waiting.no(new Error(message.error ?? 'контейнер отказал без причины'));
  });
  child.stderr?.on('data', (chunk: Buffer) => log.push(String(chunk)));
  // Контейнер, упавший посреди прогона, обязан краснить сразу и с причиной:
  // без этого повисшие вызовы досидели бы до срока теста, и «контейнер упал»
  // выглядело бы как «граница молчит».
  child.on('close', (code) => {
    for (const waiting of pending.values()) {
      waiting.no(new Error(`контейнер закрылся посреди прогона (код ${String(code)}):\n${log.join('\n')}`));
    }
    pending.clear();
  });

  const send = (op: string, payload: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((ok, no) => {
      const id = ++next;
      pending.set(id, { ok, no });
      child.stdin!.write(`${JSON.stringify({ id, op, ...payload })}\n`);
    });

  return {
    send,
    async call(method, args) {
      const result = (await send('call', { method, args })) as {
        ok: boolean;
        value?: unknown;
        error?: string;
      };
      if (!result.ok) throw new Error(result.error ?? `вызов "${method}" отказал без причины`);
      return result.value;
    },
    async close() {
      await send('bye').catch(() => undefined);
      lines.close();
    },
  };
}

/** Манифест профиля под случай сьюта: контейнер запускается только с профилем (DSK-5). */
function manifestOf(
  kase: ContractCase,
  bundle: string,
  content: string,
  servicePort: number,
): string {
  return JSON.stringify({
    id: 'contract',
    title: 'Fluxus Contract',
    bundle,
    roots: [{ id: CONTENT, label: 'content', directory: content, writable: kase.writable, serve: true }],
    capabilities: kase.capabilities,
    // Сервис-пустышка (DSK-7): его поднимает уже настоящий контейнер — тем же
    // исполняемым файлом, что и себя, с `ELECTRON_RUN_AS_NODE`.
    services: kase.capabilities.includes('service')
      ? [
          {
            id: SERVICE,
            script: SERVICE_SCRIPT,
            args: ['--port', '{port}'],
            address: `tcp://127.0.0.1:${String(servicePort)}`,
          },
        ]
      : [],
    window: { width: 900, height: 700 },
  });
}

async function open(kase: ContractCase): Promise<ContractSession> {
  const workspace = await makeTree();
  const bundleDirectory = join(workspace, 'bundle');
  const contentDirectory = join(workspace, 'content');
  await mkdir(bundleDirectory, { recursive: true });
  await mkdir(contentDirectory, { recursive: true });
  for (const [path, content] of Object.entries(kase.bundle ?? {})) {
    await putFile(bundleDirectory, path, content);
  }
  for (const [path, content] of Object.entries(kase.content ?? {})) {
    await putFile(contentDirectory, path, content);
  }
  const manifest = join(workspace, 'contract.app.json');
  await writeFile(manifest, manifestOf(kase, bundleDirectory, contentDirectory, await freePort()));

  const log: string[] = [];
  const child = spawn(BINARY, [ENTRY, ...launchFlags(), '--app', manifest, '--contract'], {
    cwd: PACKAGE,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let markReady: () => void = () => undefined;
  const started = new Promise<void>((done, fail) => {
    markReady = done;
    child.on('error', (error) => {
      fail(error);
    });
    child.on('close', (code) => {
      fail(new Error(`контейнер закрылся, не начав прогон (код ${String(code)}):\n${log.join('\n')}`));
    });
  });
  const channel = connect(child, () => {
    markReady();
  }, log);
  await started;

  const described = (await channel.send('surface')) as PageSurface;
  const listeners = new Map<number, BridgeChangeListener>();
  const closeHandlers = new Map<number, BridgeCloseHandler>();
  let handlers = 0;

  /**
   * Подписка по контракту синхронна, а здесь она едет через IPC в другой
   * процесс: `watch` отдаёт отписку сразу, а слушатель заводится за границей
   * окна. Правка мимо моста, поданная в ту же миллисекунду, обгоняет её — и
   * теряется по-настоящему. Сьют ждёт этого момента вызовом `flush`; здесь он
   * — хвост цепочки поданного.
   */
  let inflight: Promise<unknown> = Promise.resolve();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight = Promise.allSettled([inflight, work]);
    return work;
  };

  // Опрос очереди страницы: сама она наружу не дотянется. Той же дорогой едет
  // ответ на запрос закрытия — контейнер спрашивает страницу, а отвечает за неё
  // обработчик, живущий здесь.
  let draining = false;
  const drain = setInterval(() => {
    if (draining) return;
    draining = true;
    void channel
      .send('drain')
      .then(async (raw) => {
        for (const event of raw as readonly PageEvent[]) {
          if (event.kind === 'change') {
            if (event.token !== undefined) listeners.get(event.token)?.(event.change!);
            continue;
          }
          const handler = event.id === undefined ? undefined : closeHandlers.get(event.id);
          const allow = handler === undefined ? true : await handler();
          await channel.send('closeAnswer', { ask: event.ask, allow });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        draining = false;
      });
  }, DRAIN_MS);

  const has = (name: string): boolean => described.surface.includes(name);
  const bridge: DesktopBridge = {
    api: described.api,
    version: described.version,
    session: described.session,
    ...(has('read')
      ? {
          read: async (root: BridgeRootId, path: string): Promise<Uint8Array> =>
            decodeBytes(await channel.call('read', [root, path])),
          stat: async (root: BridgeRootId, path: string): Promise<BridgeEntry | undefined> =>
            (await channel.call('stat', [root, path])) as BridgeEntry | undefined,
          list: async (root: BridgeRootId, path: string): Promise<readonly BridgeEntry[]> =>
            (await channel.call('list', [root, path])) as readonly BridgeEntry[],
        }
      : {}),
    ...(has('write')
      ? {
          write: async (root: BridgeRootId, path: string, bytes: Uint8Array): Promise<void> => {
            await channel.call('write', [root, path, encodeBytes(bytes)]);
          },
        }
      : {}),
    ...(has('watch')
      ? {
          watch: (root: BridgeRootId, listener: BridgeChangeListener) => {
            let token: number | null = null;
            let stopped = false;
            void track(
              channel.send('watchOn', { root }).then((id) => {
                token = id as number;
                if (stopped) return channel.send('watchOff', { token });
                listeners.set(token, listener);
                return undefined;
              }),
            );
            return (): void => {
              stopped = true;
              if (token === null) return;
              listeners.delete(token);
              void track(channel.send('watchOff', { token }));
            };
          },
        }
      : {}),
    ...(has('choose')
      ? {
          choose: async (request: BridgeChoiceRequest): Promise<BridgeChoice | undefined> =>
            (await channel.call('choose', [request])) as BridgeChoice | undefined,
        }
      : {}),
    ...(has('startService')
      ? {
          startService: async (id: string) =>
            (await channel.call('startService', [id])) as BridgeServiceState,
          stopService: async (id: string) =>
            (await channel.call('stopService', [id])) as BridgeServiceState,
          serviceState: async (id: string) =>
            (await channel.call('serviceState', [id])) as BridgeServiceState,
        }
      : {}),
    ...(has('setTitle')
      ? {
          setTitle: (title: string): void => {
            void channel.call('setTitle', [title]);
          },
          setUnsaved: (unsaved: boolean): void => {
            void channel.call('setUnsaved', [unsaved]);
          },
          onCloseRequest: (handler: BridgeCloseHandler) => {
            const id = ++handlers;
            closeHandlers.set(id, handler);
            void channel.send('closeOn', { handler: id });
            return (): void => {
              closeHandlers.delete(id);
              void channel.send('closeOff', { handler: id });
            };
          },
        }
      : {}),
  };

  return {
    bridge,
    touch: (path, content) => putFile(contentDirectory, path, content),
    remove: (path) => rm(join(contentDirectory, path), { force: true }),
    peek: (path) => readText(contentDirectory, path),
    linkOutside: (path) => linkOutside(contentDirectory, path, join(workspace, 'outside')),
    flush: async () => {
      await inflight;
    },
    fetch: async (pathname) => (await channel.send('fetch', { path: pathname })) as ContractResponse,
    requestClose: async () => (await channel.send('requestClose')) as boolean,
    async close() {
      clearInterval(drain);
      const ended = new Promise<void>((done) => {
        child.once('close', () => {
          done();
        });
      });
      await channel.close();
      await ended;
      await dropTree(workspace);
    },
  };
}

describeContainerContract('electron-контейнер', open);

/**
 * Профиль с ШИФРОВАННЫМ объявленным сервисом (DSK-8). Закрепление обещает та же
 * подстановка, что и адрес: объявление, подставляющее `{pinFile}`, — и есть
 * признак (решение D2 change'а `service-cert-pinning`). Сервис отвязываемый:
 * файлы, которыми он называет свой адрес и своё закрепление, лежат в каталоге
 * состояния.
 */
function pinningManifest(bundle: string, id: string, port: number, pinned: boolean): string {
  return JSON.stringify({
    id: 'contract-pinning',
    title: 'Fluxus Contract TLS',
    bundle,
    roots: [],
    capabilities: ['service'],
    services: [
      {
        id,
        script: TLS_SERVICE_SCRIPT,
        args: [
          '--port',
          '{port}',
          '--address-file',
          '{addressFile}',
          ...(pinned ? ['--pin-file', '{pinFile}'] : []),
        ],
        address: `wss://127.0.0.1:${String(port)}`,
        detached: true,
      },
    ],
    window: { width: 900, height: 700 },
  });
}

/** Что вернула страница, попытавшись открыть шифрованный канал. */
interface SocketAttempt {
  readonly open: boolean;
  readonly error?: string;
}

/**
 * Случай шифрованного сервиса.
 *
 * Имя сервиса — СВОЁ у каждого случая и отличное от имени сьюта (`SERVICE`):
 * каталог состояния сервисов у контейнера один на все прогоны
 * (`userData/services`), а файлы отвязываемого сервиса именуются его
 * идентификатором (DSK-7). Общее имя означало бы, что случай видит адресный и
 * пин-файл, оставленные ЧУЖИМ прогоном — оборванным или соседним, — и «канал не
 * открылся» могло бы значить «подключились не туда».
 */
interface TlsCase {
  readonly id: string;
  /** Пишет ли сервис закрепление своего сертификата (DSK-8). */
  readonly pinned: boolean;
  /**
   * Ответ ВМЕСТО человека: диалог предъявлять в прогоне некому (DSK-6). Сам
   * вопрос при этом задаётся настоящий — тот же обработчик `certificate-error`.
   */
  readonly trust: 'yes' | 'no';
  /** Чем заполнена книга доверия ДО запуска: так выглядит прежняя сессия. */
  readonly book?: (origin: string) => Record<string, string>;
}

/** Шифрованный сервис под контейнером и то, что о нём спрашивает случай. */
interface TlsRun {
  /** Состояние поднятого сервиса: адрес в нём — тот, что он написал сам (DSK-7). */
  readonly service: BridgeServiceState;
  /** Origin соединения — ключ книги доверия (решение D1). */
  readonly origin: string;
  /** Открыть канал ИЗ СТРАНИЦЫ по адресу сервиса. */
  socket(): Promise<SocketAttempt>;
  /** Вопросы доверия, заданные контейнером за прогон (DSK-8). */
  asked(): Promise<readonly TrustQuestion[]>;
  /** Книга доверия контейнера, прочитанная с диска. */
  book(): Promise<Record<string, string>>;
}

/**
 * Поднимает контейнер на профиле с шифрованным сервисом, даёт странице открыть к
 * нему канал и уносит за собой всё: сервис отвязываемый и сессию переживает
 * намеренно (DSK-7), поэтому останавливается ЯВНО.
 *
 * Книга доверия у случая СВОЯ (`--trust-file` в рабочем каталоге), а не общая с
 * контейнером человека: origin складывается из порта, порт случаю выдаёт ОС, и
 * повторно выданный номер означал бы решение, оставленное прошлым прогоном, —
 * «незнакомый сертификат» превращался бы в «смену отпечатка» через раз.
 */
async function withTlsService(kase: TlsCase, body: (run: TlsRun) => Promise<void>): Promise<void> {
  const workspace = await makeTree();
  const bundleDirectory = join(workspace, 'bundle');
  await mkdir(bundleDirectory, { recursive: true });
  await putFile(bundleDirectory, 'index.html', '<!doctype html><title>pinning</title>');
  const port = await freePort();
  const origin = `wss://127.0.0.1:${String(port)}`;
  const manifest = join(workspace, 'pinning.app.json');
  await writeFile(manifest, pinningManifest(bundleDirectory, kase.id, port, kase.pinned));
  const trustFile = join(workspace, 'trust.json');
  if (kase.book !== undefined) await writeFile(trustFile, JSON.stringify(kase.book(origin), null, 2));

  const log: string[] = [];
  const child = spawn(
    BINARY,
    [
      ENTRY,
      ...launchFlags(),
      '--app',
      manifest,
      '--contract',
      '--trust-file',
      trustFile,
      '--trust-answer',
      kase.trust,
    ],
    {
      cwd: PACKAGE,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    },
  );
  let markReady: () => void = () => undefined;
  const started = new Promise<void>((done, fail) => {
    markReady = done;
    child.on('error', fail);
    child.on('close', (code) => {
      fail(new Error(`контейнер закрылся, не начав прогон (код ${String(code)}):\n${log.join('\n')}`));
    });
  });
  const channel = connect(child, () => {
    markReady();
  }, log);
  await started;

  try {
    const service = (await channel.call('startService', [kase.id])) as BridgeServiceState;
    await body({
      service,
      origin,
      // Адрес пишет сам процесс (DSK-7): контейнер отдал странице ту строку,
      // которую нашёл в его адресном файле.
      socket: async () => (await channel.send('socket', { url: service.address })) as SocketAttempt,
      asked: async () => (await channel.send('trust')) as readonly TrustQuestion[],
      book: async () => {
        const written = await readFile(trustFile, 'utf8').catch(() => '');
        return written === '' ? {} : (JSON.parse(written) as Record<string, string>);
      },
    });
  } finally {
    const ended = new Promise<void>((done) => {
      child.once('close', () => {
        done();
      });
    });
    // Отказ остановки ГЛОТАЕТСЯ намеренно: бросок из `finally` подменил бы собой
    // находку случая. Осиротеть при этом некому больше, чем одному процессу
    // пустышки: имя сервиса своё у каждого случая, и следующий прогон найдёт
    // его же, а не примет чужие файлы за свои.
    await channel.call('stopService', [kase.id]).catch(() => undefined);
    await channel.close();
    await ended;
    await dropTree(workspace);
  }
}

/**
 * Сервис вправду поднят и вправду шифрованный.
 *
 * Проверяется в КАЖДОМ случае, и в отрицательных это не педантизм: «канал не
 * открылся» само по себе выполнимо и тем, что подключаться было не к чему —
 * пустышка не поднялась, — а такой случай не сказал бы о доверии ничего.
 */
function servingEncrypted(service: BridgeServiceState): void {
  expect(service.running, JSON.stringify(service)).toBe(true);
  expect(service.address.startsWith('wss://'), service.address).toBe(true);
}

describe('electron-контейнер: закрепление сертификата объявленного сервиса (DSK-8)', () => {
  it('страница открывает шифрованный канал к сервису с закреплением, без вопросов', async () => {
    await withTlsService({ id: 'pinned-tls', pinned: true, trust: 'no' }, async (run) => {
      servingEncrypted(run.service);
      // Штатная проверка платформы этот сертификат отвергает — цепочки у него
      // нет, — и открыть канал позволяет ровно одно: его отпечаток равен
      // закреплению, которое сервис написал сам.
      const attempt = await run.socket();
      expect(attempt.error ?? '').toBe('');
      expect(attempt.open).toBe(true);
      // Порядок оснований (решение D4): закрепления спрашиваются ПЕРВЫМИ, и
      // локальный агент до диалога не доходит никогда — вопрос человеку про
      // него был бы регрессом MGR-5 «без вопросов человеку». Автоответ здесь
      // «отклонить» ровно затем, чтобы этот порядок был виден: дойди дело до
      // вопроса — канал бы не открылся.
      expect(await run.asked()).toEqual([]);
    });
  }, 120_000);

  it('тот же сервис без закрепления — вопрос человеку, и отказ отвергает канал', async () => {
    await withTlsService({ id: 'refused-tls', pinned: false, trust: 'no' }, async (run) => {
      // Сервис тот же и поднят так же — разница ровно одна: пин-файла он не
      // писал, потому что его объявление не подставляет `{pinFile}`.
      servingEncrypted(run.service);
      // Сценарий «Чужой self-signed сертификат»: путь для него — тот же диалог
      // доверия, а отказ в диалоге отвергает соединение так же, как браузер без
      // контейнера.
      expect((await run.socket()).open).toBe(false);
      const asked = await run.asked();
      expect(asked.length).toBeGreaterThanOrEqual(1);
      expect(asked[0]).toMatchObject({ origin: run.origin, known: '' });
      // «Отказ в книгу не записывается»: книги нет вовсе (решение D5).
      expect(await run.book()).toEqual({});
      // «...и следующая попытка спрашивает заново».
      expect((await run.socket()).open).toBe(false);
      expect((await run.asked()).length).toBeGreaterThan(asked.length);
    });
  }, 120_000);
});

describe('electron-контейнер: доверие по решению человека (DSK-8, TOFU)', () => {
  it('согласие открывает канал, пишет книгу, и повтор вопросов не задаёт', async () => {
    await withTlsService({ id: 'tofu-tls', pinned: false, trust: 'yes' }, async (run) => {
      servingEncrypted(run.service);
      // Сценарий «Незнакомый сертификат — вопрос человеку»: согласие открывает
      // соединение и записывает отпечаток в книгу.
      const attempt = await run.socket();
      expect(attempt.error ?? '').toBe('');
      expect(attempt.open).toBe(true);
      const asked = await run.asked();
      expect(asked).toHaveLength(1);
      expect(asked[0]!.origin).toBe(run.origin);
      expect(asked[0]!.known).toBe('');
      expect(await run.book()).toEqual({ [run.origin]: asked[0]!.fingerprint });

      // Сценарий «Известный origin молчит»: второго вопроса нет. Ответить на
      // повтор вправе и сам Chromium (принятую ошибку сертификата он помнит), и
      // книга — важно, что человека не тревожат ни в том, ни в другом случае.
      expect((await run.socket()).open).toBe(true);
      expect(await run.asked()).toHaveLength(1);
    });
  }, 120_000);

  it('смена отпечатка известного origin предъявляется как СМЕНА', async () => {
    const previous = 'a'.repeat(64);
    await withTlsService(
      {
        id: 'tofu-changed-tls',
        pinned: false,
        trust: 'yes',
        // Так выглядит прежняя сессия: origin книге знаком, а отпечаток за ним
        // записан ДРУГОЙ — пустышка рождает свой сертификат на каждом запуске.
        book: (origin) => ({ [origin]: previous }),
      },
      async (run) => {
        servingEncrypted(run.service);
        const attempt = await run.socket();
        expect(attempt.open).toBe(true);
        // Сценарий «Отпечаток известного origin изменился»: молчаливого
        // принятия нет — вопрос задан, и в нём названы ОБА отпечатка.
        const asked = await run.asked();
        expect(asked).toHaveLength(1);
        expect(asked[0]!.origin).toBe(run.origin);
        expect(asked[0]!.known).toBe(previous);
        expect(asked[0]!.fingerprint).not.toBe(previous);
        // «...новым явным согласием, которое переписывает запись книги».
        expect(await run.book()).toEqual({ [run.origin]: asked[0]!.fingerprint });
      },
    );
  }, 120_000);
});
