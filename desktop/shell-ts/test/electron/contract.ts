/**
 * Реализация на Electron под общим контрактным сьютом границы (DSK-6) — прогон
 * ВНЕ гейта: `npm run contract:electron -w @game-mvp/desktop-shell`.
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
 * Не повторяет ни одного утверждения сьюта и не заводит своих: всё, что здесь
 * есть, — поднятие контейнера и перевод вызовов границы в его канал.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
  BridgeChange,
  BridgeChangeListener,
  BridgeChoice,
  BridgeChoiceRequest,
  BridgeCloseHandler,
  BridgeEntry,
  BridgeRootId,
  BridgeSession,
  DesktopBridge,
} from '../../src/bridge/types.js';
import {
  CONTENT,
  describeContainerContract,
  type ContractCase,
  type ContractResponse,
  type ContractSession,
} from '../contractSuite.js';
import { dropTree, linkOutside, makeTree, putFile, readText } from '../support.js';

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
function manifestOf(kase: ContractCase, bundle: string, content: string): string {
  return JSON.stringify({
    id: 'contract',
    title: 'Fluxus Contract',
    bundle,
    roots: [{ id: CONTENT, label: 'content', directory: content, writable: kase.writable, serve: true }],
    capabilities: kase.capabilities,
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
  await writeFile(manifest, manifestOf(kase, bundleDirectory, contentDirectory));

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
