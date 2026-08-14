/**
 * Главный процесс контейнера: окно, раздача, маршрутизация моста (DSK-1,
 * DSK-4, DSK-5).
 *
 * Клей тонкий по построению — вся логика уже проверена в `src/host/` на чистом
 * Node (DSK-6). Здесь только четыре вещи, которых на чистом Node не бывает:
 * окно, custom protocol, IPC и системные диалоги. Всё, что можно было решить
 * до Electron, решено до него: разбор профиля, границы корней, атомарная
 * запись, порядок слоёв раздачи и whitelist возможностей.
 *
 * ## Раздача — protocol handler, а не локальный HTTP-порт
 *
 * Порт наружу не открывается и жизненным циклом порта никто не управляет
 * (design D3). Схема `fluxus://app/` объявлена привилегированной: `standard`
 * даёт странице нормальное происхождение (а с ним — модульные воркеры
 * `client-shell` SHELL-1 и `fetch`), `secure` — то, чего требуют браузерные
 * API. Cross-origin isolation не включается: SHELL-3 её не требует, и требовать
 * её от приложения контейнер не вправе (DSK-4).
 *
 * ## Окно
 *
 * `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — в обоих
 * профилях и без исключений. Единственная поверхность хостовых возможностей —
 * мост, собранный preload'ом по whitelist профиля (DSK-5); прямого пути к
 * файловой системе и процессам у страницы нет.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BridgeChange, BridgeChoiceRequest, BridgeRootId } from '../bridge/types.js';
import { loadAppProfile, openApp, type HostRoot, type OpenedApp } from '../host/index.js';
import { insideRoot } from '../host/root.js';
import { CHANNELS } from './channels.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Схема раздачи и её единственный хост. Адрес страница получает от контейнера. */
const SCHEME = 'fluxus';
const HOST = 'app';
const BASE = `${SCHEME}://${HOST}/`;

/** Сколько ждём ответа страницы на запрос закрытия, прежде чем закрыть окно. */
const CLOSE_ANSWER_MS = 5000;

/**
 * Smoke-режим (`--smoke`): контейнер поднимается, страница грузится, отчёт о
 * том, что получила страница, уходит в stdout, окно закрывается.
 *
 * Режим живёт здесь, а не во втором главном процессе, ровно потому, что
 * проверять надо ЭТОТ клей: копия main'а под smoke проверяла бы копию.
 * Ветка одна и вся её работа — прочитать глобальный объект страницы и
 * напечатать; поведения контейнера она не меняет.
 */
async function reportSmoke(
  window: BrowserWindow,
  profile: { id: string },
  probe: string,
  roundtrip: string | null,
  complaints: readonly string[],
): Promise<void> {
  // Проба раздачи идёт ИЗ СТРАНИЦЫ и обычным `fetch` по пути от корня дерева —
  // тем же кодом, каким ассет грузит клиент в браузере (DSK-4, ASSET-2).
  const seen: unknown = await window.webContents.executeJavaScript(
    `(async () => {
      const bridge = globalThis.fluxusDesktop;
      const probe = await fetch(${JSON.stringify(probe)})
        .then(async (response) => ({
          status: response.status,
          bytes: response.ok ? (await response.arrayBuffer()).byteLength : 0,
        }))
        .catch((error) => ({ status: 0, error: String(error) }));
      if (bridge === undefined) return { bridge: false, probe };
      // Сквозная правка (ED-21, DSK-2): страница пишет документ мостом и
      // читает его обратно; байты на диске сверяет вызывающий прогон.
      let trip = null;
      const path = ${JSON.stringify(roundtrip)};
      if (path !== null && typeof bridge.write === 'function') {
        const root = bridge.session.roots[0].id;
        const text = '{"smoke":"правка из страницы"}\\n';
        await bridge.write(root, path, new TextEncoder().encode(text));
        const back = new TextDecoder().decode(await bridge.read(root, path));
        trip = { path, text, back, same: back === text };
      }
      return {
        trip,
        bridge: true,
        api: bridge.api,
        version: bridge.version,
        profile: bridge.session.profile,
        capabilities: [...bridge.session.capabilities],
        roots: bridge.session.roots.map((root) => ({ id: root.id, writable: root.writable, base: root.base })),
        surface: ['read', 'stat', 'list', 'write', 'watch', 'choose', 'setTitle', 'setUnsaved', 'onCloseRequest']
          .filter((name) => typeof bridge[name] === 'function'),
        title: document.title,
        workers: typeof Worker,
        probe,
      };
    })()`,
  );
  process.stdout.write(`SMOKE ${JSON.stringify({ app: profile.id, seen, complaints })}\n`);
}

/**
 * Какой профиль запускать. Аргументом — при запуске из репозитория; в
 * дистрибутиве его называет манифест самого приложения (`fluxus.app`, кладёт
 * `bin/pack.mjs`). Без профиля контейнер не стартует вовсе: профиль — это
 * выданные возможности, и умолчания у него быть не может (DSK-5).
 */
function manifestFrom(argv: readonly string[]): string {
  const at = argv.indexOf('--app');
  const value = at < 0 ? undefined : argv[at + 1];
  if (value !== undefined) return value;
  const home = app.getAppPath();
  try {
    const own = JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')) as {
      fluxus?: { app?: unknown };
    };
    const named = own.fluxus?.app;
    if (typeof named === 'string') return join(home, named);
  } catch {
    // Манифеста приложения нет или он не читается — отказ ниже, общий.
  }
  throw new Error('контейнер запускается с профилем: `--app <манифест.app.json>` (DSK-5)');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

/** Раздача: адрес запроса → байты слоя. Отказ — ответ, а не исключение. */
function serveWith(opened: OpenedApp): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response(`хост "${url.host}" контейнером не раздаётся`, { status: 404 });
    }
    const result = await opened.server.serve(url.pathname);
    if (!result.ok) return new Response(result.reason, { status: result.status });
    return new Response(result.bytes, { headers: { 'content-type': result.mime } });
  };
}

/**
 * Диалоги среды: выбор ВНУТРИ объявленного корня. Выбранное вне корня —
 * отказ, а не расширение доступа: профиль фиксируется на старте (DSK-5).
 */
async function chooseInside(
  window: BrowserWindow,
  request: BridgeChoiceRequest,
  root: HostRoot,
): Promise<string | undefined> {
  const filters =
    request.extensions === undefined
      ? []
      : [{ name: request.extensions.join(', '), extensions: request.extensions.map((e) => e.replace(/^\./, '')) }];
  const answer = await dialog.showOpenDialog(window, {
    properties: [request.kind === 'directory' ? 'openDirectory' : 'openFile'],
    defaultPath: request.startIn === undefined ? root.directory : root.resolve(request.startIn),
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(filters.length === 0 ? {} : { filters }),
  });
  const picked = answer.filePaths[0];
  if (answer.canceled || picked === undefined) return undefined;
  const inside = insideRoot(root, picked);
  return inside ?? undefined;
}

async function start(): Promise<void> {
  const profile = await loadAppProfile(manifestFrom(process.argv));
  let window: BrowserWindow | null = null;
  let closing = false;

  const opened = openApp({
    profile,
    base: BASE,
    report: (text) => {
      process.stderr.write(`[desktop-shell] ${text}\n`);
    },
    dialogs: {
      choose: (request, root) =>
        window === null ? Promise.resolve(undefined) : chooseInside(window, request, root),
    },
    window: {
      setTitle: (title) => {
        window?.setTitle(title);
      },
      setUnsaved: (unsaved) => {
        window?.setDocumentEdited(unsaved);
      },
    },
  });
  const bridge = opened.handle.bridge;

  protocol.handle(SCHEME, serveWith(opened));

  window = new BrowserWindow({
    width: profile.window.width,
    height: profile.window.height,
    title: profile.title,
    show: false,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const target = window;
  target.once('ready-to-show', () => {
    target.show();
  });

  // Жалобы страницы: воркеры и канал оболочки (SHELL-1..3) поднимаются на
  // загрузке, и сорвавшийся старт виден именно отсюда. Контейнер их только
  // собирает — печатает их smoke-прогон, обычный запуск молчит.
  const complaints: string[] = [];
  target.webContents.on('console-message', (event) => {
    if (event.level === 'error') complaints.push(event.message);
  });

  // Описание сессии страница получает синхронно на старте: базовый адрес
  // раздачи и список возможностей нужны ей до первого запроса (DSK-4, DSK-5).
  ipcMain.on(CHANNELS.session, (event) => {
    event.returnValue = bridge.session;
  });

  // Ручка IPC заводится ТОЛЬКО под объявленную возможность: канала, которого
  // профиль не дал, нет и в главном процессе — не только в preload (DSK-5).
  if (bridge.read !== undefined) {
    ipcMain.handle(CHANNELS.read, (_e, root: BridgeRootId, path: string) => bridge.read!(root, path));
    ipcMain.handle(CHANNELS.stat, (_e, root: BridgeRootId, path: string) => bridge.stat!(root, path));
    ipcMain.handle(CHANNELS.list, (_e, root: BridgeRootId, path: string) => bridge.list!(root, path));
  }
  if (bridge.write !== undefined) {
    ipcMain.handle(CHANNELS.write, (_e, root: BridgeRootId, path: string, bytes: Uint8Array) =>
      bridge.write!(root, path, bytes),
    );
  }
  if (bridge.watch !== undefined) {
    const stops = new Map<number, () => void>();
    let token = 0;
    ipcMain.handle(CHANNELS.watchOn, (event, root: BridgeRootId) => {
      const id = ++token;
      stops.set(
        id,
        bridge.watch!(root, (change: BridgeChange) => {
          event.sender.send(CHANNELS.change, id, change);
        }),
      );
      return id;
    });
    ipcMain.handle(CHANNELS.watchOff, (_event, id: number) => {
      stops.get(id)?.();
      stops.delete(id);
    });
  }
  if (bridge.choose !== undefined) {
    ipcMain.handle(CHANNELS.choose, (_e, request: BridgeChoiceRequest) => bridge.choose!(request));
  }
  if (bridge.setTitle !== undefined) {
    ipcMain.on(CHANNELS.title, (_event, title: string) => {
      bridge.setTitle!(title);
    });
    ipcMain.on(CHANNELS.unsaved, (_event, unsaved: boolean) => {
      bridge.setUnsaved!(unsaved);
    });
  }

  // Запрос закрытия: спрашивает контейнер, отвечает страница (DSK-2). Ответа
  // ждём с крайним сроком — окно, которое нельзя закрыть из-за молчащей
  // страницы, было бы хуже несохранённой правки.
  const answers = new Map<number, (allow: boolean) => void>();
  let ask = 0;
  ipcMain.on(CHANNELS.closeReply, (_event, id: number, allow: boolean) => {
    answers.get(id)?.(allow);
    answers.delete(id);
  });
  // Обработчик закрытия со стороны контейнера — переходник к странице: сами
  // обработчики живут в ней, и ответить за них главный процесс не может.
  bridge.onCloseRequest?.(
    () =>
      new Promise<boolean>((done) => {
        const id = ++ask;
        answers.set(id, done);
        target.webContents.send(CHANNELS.closeRequest, id);
        setTimeout(() => {
          if (answers.delete(id)) done(true);
        }, CLOSE_ANSWER_MS);
      }),
  );

  target.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    void opened.handle.requestClose().then((allow) => {
      if (!allow) return;
      closing = true;
      target.close();
    });
  });

  target.on('closed', () => {
    window = null;
    opened.close();
  });

  await target.loadURL(`${BASE}${profile.entry}`);

  if (process.argv.includes('--smoke')) {
    const at = process.argv.indexOf('--probe');
    const trip = process.argv.indexOf('--roundtrip');
    await reportSmoke(
      target,
      profile,
      at < 0 ? '/' : (process.argv[at + 1] ?? '/'),
      trip < 0 ? null : (process.argv[trip + 1] ?? null),
      complaints,
    );
    closing = true;
    app.exit(0);
  }
}

void app.whenReady().then(
  () =>
    start().catch((error: unknown) => {
      process.stderr.write(`[desktop-shell] ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(1);
    }),
  (error: unknown) => {
    process.stderr.write(`[desktop-shell] ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  },
);

app.on('window-all-closed', () => {
  app.quit();
});
