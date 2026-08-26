/**
 * Главный процесс контейнера: окно, раздача, маршрутизация моста (DSK-1,
 * DSK-4, DSK-5).
 *
 * Клей тонкий по построению — вся логика уже проверена в `src/host/` на чистом
 * Node (DSK-6). Здесь только пять вещей, которых на чистом Node не бывает:
 * окно, custom protocol, IPC, системные диалоги и проверка сертификата
 * Chromium (DSK-8). Всё, что можно было решить до Electron, решено до него:
 * разбор профиля, границы корней, атомарная запись, порядок слоёв раздачи,
 * whitelist возможностей и счёт отпечатка сертификата.
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
import type { Certificate, Event as ElectronEvent, WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppProfile } from '../bridge/profile.js';
import type {
  BridgeChange,
  BridgeChoiceRequest,
  BridgeRootId,
  BridgeServiceId,
} from '../bridge/types.js';
import {
  certificateFingerprint,
  loadAppProfile,
  openApp,
  type HostRoot,
  type OpenedApp,
} from '../host/index.js';
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

/**
 * Открытая сессия окна: то, что нужно режимам прогонов сверх самого окна.
 * Обычному запуску не нужно ничего — он открывает окно и молчит.
 */
interface Session {
  readonly target: BrowserWindow;
  readonly opened: OpenedApp;
  /** Ошибки страницы, собранные с загрузки: их печатает smoke-прогон. */
  readonly complaints: readonly string[];
  /** Закрыть окно, не спрашивая страницу: прогоны завершают процесс сами. */
  readonly force: () => void;
}

/**
 * Открывает окно приложения по УЖЕ зафиксированному профилю: раздача, мост,
 * ручки IPC и сама сессия живут ровно столько же, сколько окно.
 *
 * Функция вызывается повторно — на macOS процесс переживает закрытие
 * последнего окна, и клик по иконке в доке открывает окно заново. Поэтому всё,
 * что здесь регистрируется глобально (protocol handler и ручки IPC), на
 * закрытии снимается: оставленная регистрация уронила бы второе открытие
 * повторной, а не проявилась бы как чужая сессия.
 */
async function openSession(profile: AppProfile): Promise<Session> {
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
    // Скрипт сервиса запускается ЭТИМ же исполняемым файлом (DSK-7): у
    // упакованного приложения `node` в PATH пользовательской машины может не
    // быть вовсе, а Electron умеет быть Node по просьбе переменной среды.
    //
    // Каталог состояния сервисов — данные приложения: там живут адресный файл и
    // pid отвязываемого сервиса, которыми он пере-обнаруживается через границу
    // сессий (DSK-7, решение D6). Временный каталог для этого не годится —
    // «пережил сессию» обязано пережить и уборку /tmp.
    services: {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stateDir: join(app.getPath('userData'), 'services'),
    },
  });
  const bridge = opened.handle.bridge;

  protocol.handle(SCHEME, serveWith(opened));

  /**
   * Сертификат, отвергнутый штатной проверкой платформы (DSK-8, решение D6).
   *
   * Принимается РОВНО один случай: отпечаток предъявленного сертификата равен
   * закреплению объявленного сервиса зафиксированного профиля — тому, которое
   * сервис написал сам (`certificatePins`). Всё прочее остаётся отвергнутым:
   * доверие расширяется на закреплённые сертификаты и ни на что сверх них, а
   * глобального ослабления проверки (`--ignore-certificate-errors`,
   * `setCertificateVerifyProc`) в контейнере нет и быть не должно.
   *
   * `setCertificateVerifyProc` отвергнут именно поэтому: он подменяет проверку
   * целиком, а нужно ДОПОЛНИТЬ её одним основанием доверия.
   *
   * Счёт отпечатка живёт в `src/host/` на чистом Node и проверен в гейте: клей
   * вне гейта (DSK-6) и потому не решает здесь ничего сам.
   */
  const pinnedCertificate = (
    event: ElectronEvent,
    _contents: WebContents,
    _url: string,
    _error: string,
    certificate: Certificate,
    callback: (isTrusted: boolean) => void,
  ): void => {
    const shown = certificateFingerprint(certificate.data);
    // Закрепления читаются в момент вопроса: сервис мог написать своё уже после
    // открытия окна, а переживший сессию — задолго до него (DSK-7).
    const pinned = shown !== '' && (opened.services?.certificatePins() ?? []).includes(shown);
    if (!pinned) {
      callback(false);
      return;
    }
    event.preventDefault();
    callback(true);
  };
  app.on('certificate-error', pinnedCertificate);

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

  // Мост принадлежит СВОЕЙ странице: preload перезапускается на каждом
  // переходе WebContents, и чужой документ (перетащенный в окно файл или
  // ссылка, `window.open` — новое окно наследует webPreferences вместе с
  // preload'ом) получил бы возможности профиля целиком — доступ обходным
  // путём, который DSK-5 запрещает. Поэтому уход с собственной раздачи
  // гасится, а новых окон контейнер не открывает вовсе.
  target.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE)) event.preventDefault();
  });
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
  if (bridge.startService !== undefined) {
    ipcMain.handle(CHANNELS.serviceStart, (_e, id: BridgeServiceId) => bridge.startService!(id));
    ipcMain.handle(CHANNELS.serviceStop, (_e, id: BridgeServiceId) => bridge.stopService!(id));
    ipcMain.handle(CHANNELS.serviceState, (_e, id: BridgeServiceId) => bridge.serviceState!(id));
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
    // Раздача, проверка сертификата и ручки IPC — регистрации процесса, а не
    // окна, и снимаются здесь же: следующее открытие (macOS, клик по иконке)
    // регистрирует их заново. Оставленный обработчик закрепления держал бы
    // доверие сессии, которой уже нет (DSK-8).
    protocol.unhandle(SCHEME);
    app.off('certificate-error', pinnedCertificate);
    for (const channel of Object.values(CHANNELS)) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
    // `close()` снимает и поднятые сессией сервисы (DSK-7): переживший окно
    // процесс держал бы свой адрес занятым, а приложения, ради которого он
    // поднят, уже нет.
    opened.close();
  });

  await target.loadURL(`${BASE}${profile.entry}`);

  return {
    target,
    opened,
    complaints,
    force: () => {
      closing = true;
    },
  };
}

/**
 * Профиль, с которым открывать окно заново (macOS). Профиль фиксируется на
 * старте и на живой сессии не меняется (DSK-5) — повторное открытие берёт
 * ТОТ ЖЕ профиль, а не перечитывает манифест: иначе набор выданных
 * возможностей зависел бы от файла на диске между закрытием окна и кликом по
 * иконке в доке.
 */
let reopenWith: AppProfile | null = null;
let reopening = false;

async function start(): Promise<void> {
  const profile = await loadAppProfile(manifestFrom(process.argv));
  const session = await openSession(profile);

  // Контрактный прогон (DSK-6): общий сьют границы поверх ЭТОГО клея. Модуль
  // грузится только под флагом — обычному запуску он не нужен, а гейту не нужен
  // и сам контейнер.
  if (process.argv.includes('--contract')) {
    const { serveContract } = await import('./contract.js');
    await serveContract(session.target, session.opened);
    return;
  }

  if (process.argv.includes('--smoke')) {
    const at = process.argv.indexOf('--probe');
    const trip = process.argv.indexOf('--roundtrip');
    await reportSmoke(
      session.target,
      profile,
      at < 0 ? '/' : (process.argv[at + 1] ?? '/'),
      trip < 0 ? null : (process.argv[trip + 1] ?? null),
      session.complaints,
    );
    session.force();
    app.exit(0);
  }

  // Повторное открытие вооружаем только у обычного запуска: прогоны выше
  // завершают процесс сами, и окно им нужно ровно одно.
  reopenWith = profile;
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

/**
 * macOS живёт иначе остальных: закрытое окно там не означает закрытое
 * приложение — оно остаётся в доке, и клик по иконке открывает окно заново.
 * Поведение платформенное и потому в спеке контейнера его нет: DSK-1 требует
 * один контейнер на все приложения, а не одно поведение на все системы.
 */
const MAC = process.platform === 'darwin';

app.on('window-all-closed', () => {
  // Windows и Linux — как было: окон нет, приложения нет.
  if (!MAC) app.quit();
});

app.on('activate', () => {
  if (!MAC || reopening || BrowserWindow.getAllWindows().length > 0) return;
  const profile = reopenWith;
  // Профиля ещё нет — старт не дошёл до окна: первое окно открывает он сам.
  if (profile === null) return;
  reopening = true;
  void openSession(profile)
    .catch((error: unknown) => {
      process.stderr.write(`[desktop-shell] ${error instanceof Error ? error.message : String(error)}\n`);
    })
    .finally(() => {
      reopening = false;
    });
});
