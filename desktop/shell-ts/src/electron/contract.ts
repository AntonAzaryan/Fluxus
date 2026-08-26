/**
 * Режим контрактного прогона (`--contract`): реализация на Electron под общим
 * сьютом границы (DSK-6).
 *
 * DSK-6 требует, чтобы контрактный сьют проходила ЛЮБАЯ реализация контейнера,
 * а гейт при этом оставался зелёным без установленного контейнера. Отсюда два
 * прогона одного и того же сьюта: в гейте — поверх чистого Node
 * (`test/hostBridge.contract.test.ts`), вне гейта — поверх настоящего окна
 * (`test/electron/contract.ts`, команда `npm run contract:electron`). Второй
 * проверяет ровно то, чего первый не видит: маршрутизацию через IPC, сборку
 * поверхности в preload, раздачу protocol handler'ом и запрос закрытия окна.
 *
 * ## Почему прогон живёт здесь, а не во втором главном процессе
 *
 * По той же причине, что и smoke-режим рядом: копия main'а проверяла бы копию.
 * Ветка одна, поведения контейнера она не меняет и включается единственным
 * аргументом командной строки.
 *
 * ## Что именно ездит через границу
 *
 * Ничего сверх словаря DSK-2. Прогон исполняет вызовы В СТРАНИЦЕ — на том самом
 * объекте, который положил туда preload, — и возвращает вызывающему пути,
 * байты (base64, потому что канал текстовый) и события. Сам сьют об этом канале
 * не знает вовсе: он говорит с `DesktopBridge`, а собирает этот объект поверх
 * канала уже сторона теста.
 *
 * Сверх моста помощник умеет ровно две вещи, которые мостом и не являются:
 * запросить раздачу обычным `fetch` и открыть `WebSocket` — то есть сделать то,
 * что страница делает СВОИМИ силами. Второе нужно закреплению сертификата
 * (DSK-8): проверку сертификата проходит настоящий Chromium, и увидеть её
 * результат можно только из страницы.
 */
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { createInterface } from 'node:readline';
import type { OpenedApp } from '../host/index.js';

/** Строка ответа в stdout. Тем же приёмом отвечает smoke-режим. */
const MARK = 'CONTRACT ';

/**
 * Операции, которым очередь противопоказана. Всё остальное исполняется строго
 * по одной: сьют вправе рассчитывать, что подписка, поданная раньше записи,
 * раньше и доедет. Но `drain` и `closeAnswer` — не операции границы, а канал
 * ответа: ответ страницы о закрытии приходит, ПОКА запрос закрытия ещё
 * исполняется, и очередь превратила бы это в взаимную блокировку.
 */
const IMMEDIATE = new Set(['drain', 'closeAnswer']);

/**
 * Помощник, живущий в странице. Он не расширяет мост и не обходит его: всё,
 * что он умеет, — позвать объект, который страница и так видит, и сложить
 * события в очередь, потому что вытянуть их наружу можно только по запросу.
 */
const HELPER = `(() => {
  const bridge = globalThis.fluxusDesktop;
  const NAMES = ['read', 'stat', 'list', 'write', 'watch', 'choose', 'setTitle', 'setUnsaved', 'onCloseRequest', 'startService', 'stopService', 'serviceState'];
  const events = [];
  const stops = new Map();
  const closes = new Map();
  const asks = new Map();
  let tokens = 0;
  let asked = 0;
  const encode = (bytes) => {
    let text = '';
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text);
  };
  const decode = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const shown = (result) => (result instanceof Uint8Array ? { bytes: encode(result) } : result);
  globalThis.__contract = {
    surface: () => ({
      api: bridge.api,
      version: bridge.version,
      session: bridge.session,
      surface: NAMES.filter((name) => typeof bridge[name] === 'function'),
    }),
    call: async (method, args) => {
      try {
        const ready = method === 'write' ? [args[0], args[1], decode(args[2])] : args;
        return { ok: true, value: shown(await bridge[method].apply(bridge, ready)) };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    watchOn: async (root) => {
      const token = ++tokens;
      stops.set(token, bridge.watch(root, (change) => events.push({ kind: 'change', token, change })));
      // Отписку preload отдаёт сразу, а сама подписка едет в главный процесс по
      // IPC. Любой следующий вызов моста приходит туда ПОСЛЕ неё — им и ждём:
      // иначе запись, поданная сразу за подпиской, обгонит её.
      if (typeof bridge.stat === 'function') await bridge.stat(root, '');
      return token;
    },
    watchOff: (token) => {
      const stop = stops.get(token);
      stops.delete(token);
      if (stop !== undefined) stop();
      return true;
    },
    closeOn: (id) => {
      closes.set(
        id,
        bridge.onCloseRequest(
          () =>
            new Promise((done) => {
              const ask = ++asked;
              asks.set(ask, done);
              events.push({ kind: 'close', id, ask });
            }),
        ),
      );
      return true;
    },
    closeOff: (id) => {
      const stop = closes.get(id);
      closes.delete(id);
      if (stop !== undefined) stop();
      return true;
    },
    closeAnswer: (ask, allow) => {
      const done = asks.get(ask);
      asks.delete(ask);
      if (done !== undefined) done(allow);
      return true;
    },
    drain: () => events.splice(0),
    // Шифрованный канал ИЗ СТРАНИЦЫ (DSK-8): открылся или нет — единственное,
    // что о нём спрашивают. Открывает его тот же WebSocket, которым страница
    // менеджера идёт к локальному агенту (MGR-5), и проверку сертификата он
    // проходит настоящую. (Обратных кавычек здесь быть не должно: код помощника
    // живёт в шаблонной строке, и первая же кавычка оборвала бы её.)
    socket: (url) =>
      new Promise((done) => {
        let settled = false;
        let channel = null;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          try {
            if (channel !== null) channel.close();
          } catch (error) {
            void error;
          }
          done(result);
        };
        try {
          channel = new WebSocket(url);
        } catch (error) {
          finish({ open: false, error: String(error) });
          return;
        }
        channel.onopen = () => finish({ open: true });
        channel.onerror = () => finish({ open: false, error: 'канал отвергнут' });
        channel.onclose = () => finish({ open: false, error: 'канал закрылся, не открывшись' });
        setTimeout(() => finish({ open: false, error: 'канал не ответил' }), 10000);
      }),
    fetch: async (path) => {
      const response = await fetch(path);
      return {
        ok: response.ok,
        body: response.ok ? await response.text() : undefined,
        mime: response.headers.get('content-type') ?? undefined,
      };
    },
  };
  return true;
})()`;

interface ContractRequest {
  readonly id: number;
  readonly op: string;
  readonly method?: string;
  readonly args?: readonly unknown[];
  readonly root?: string;
  readonly token?: number;
  readonly handler?: number;
  readonly ask?: number;
  readonly allow?: boolean;
  readonly path?: string;
  /** Адрес шифрованного канала, который открывает страница (DSK-8). */
  readonly url?: string;
}

/** Вызов помощника в странице: код собирается из JSON-безопасных значений. */
function inPage(window: BrowserWindow, call: string, ...args: readonly unknown[]): Promise<unknown> {
  const list = args.map((value) => JSON.stringify(value)).join(', ');
  return window.webContents.executeJavaScript(`globalThis.__contract.${call}(${list})`) as Promise<unknown>;
}

async function answer(window: BrowserWindow, opened: OpenedApp, request: ContractRequest): Promise<unknown> {
  switch (request.op) {
    case 'surface':
      return await inPage(window, 'surface');
    case 'call':
      return await inPage(window, 'call', request.method, request.args ?? []);
    case 'fetch':
      return await inPage(window, 'fetch', request.path);
    case 'socket':
      return await inPage(window, 'socket', request.url);
    case 'watchOn':
      return await inPage(window, 'watchOn', request.root);
    case 'watchOff':
      return await inPage(window, 'watchOff', request.token);
    case 'closeOn':
      return await inPage(window, 'closeOn', request.handler);
    case 'closeOff':
      return await inPage(window, 'closeOff', request.handler);
    case 'closeAnswer':
      return await inPage(window, 'closeAnswer', request.ask, request.allow);
    case 'drain':
      return await inPage(window, 'drain');
    // Спрашивает контейнер, отвечает страница — тот же путь, которым идёт
    // закрытие окна, а не его подобие (DSK-2).
    case 'requestClose':
      return await opened.handle.requestClose();
    default:
      throw new Error(`операция "${request.op}" контрактному прогону неизвестна`);
  }
}

/**
 * Поднимает канал прогона и держит процесс, пока прогон не скажет `bye`.
 * Возвращает промис — вызывающий (`main.ts`) на нём и стоит.
 */
export async function serveContract(window: BrowserWindow, opened: OpenedApp): Promise<void> {
  await window.webContents.executeJavaScript(HELPER);
  const reply = (value: unknown): void => {
    process.stdout.write(`${MARK}${JSON.stringify(value)}\n`);
  };

  await new Promise<void>((done) => {
    const lines = createInterface({ input: process.stdin });
    let queue: Promise<void> = Promise.resolve();

    const run = async (request: ContractRequest): Promise<void> => {
      try {
        reply({ id: request.id, ok: true, value: await answer(window, opened, request) });
      } catch (error) {
        reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    lines.on('line', (line) => {
      const request = JSON.parse(line) as ContractRequest;
      if (request.op === 'bye') {
        reply({ id: request.id, ok: true, value: null });
        lines.close();
        done();
        return;
      }
      if (IMMEDIATE.has(request.op)) {
        void run(request);
        return;
      }
      queue = queue.then(() => run(request));
    });

    reply({ ready: true, profile: opened.profile.id });
  });

  app.exit(0);
}
