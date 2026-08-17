/**
 * Preload: сборка поверхности моста по whitelist профиля (DSK-5).
 *
 * Поверхность собирается ОДИН РАЗ на старте окна и из описания сессии, которое
 * главный процесс отдаёт синхронно. Расширения на живой сессии поэтому не
 * бывает по построению: после `exposeInMainWorld` объект в странице заморожен
 * контекст-мостом, а второй возможности взяться неоткуда — в главном процессе
 * ручки IPC тоже заведены только под объявленные возможности.
 *
 * CommonJS и один файл — не стиль, а требование среды: preload исполняется в
 * песочнице (`sandbox: true`), где `require` соседнего модуля недоступен.
 * Отсюда единственный повтор в пакете — имена каналов, продублированные из
 * `channels.ts`; чтобы он не разъехался, его сверяет тест гейта
 * `test/electronGlue.test.ts`.
 *
 * `contextBridge` переносит через границу только клонируемое и функции.
 * Байты (`Uint8Array`) переживают перенос, а сложных объектов на границе моста
 * нет вовсе — это и есть словарь DSK-2: пути, байты, события.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  session: 'fluxus:session',
  read: 'fluxus:read',
  stat: 'fluxus:stat',
  list: 'fluxus:list',
  write: 'fluxus:write',
  watchOn: 'fluxus:watch-on',
  watchOff: 'fluxus:watch-off',
  change: 'fluxus:change',
  choose: 'fluxus:choose',
  title: 'fluxus:title',
  unsaved: 'fluxus:unsaved',
  closeRequest: 'fluxus:close-request',
  closeReply: 'fluxus:close-reply',
  serviceStart: 'fluxus:service-start',
  serviceStop: 'fluxus:service-stop',
  serviceState: 'fluxus:service-state',
};

const BRIDGE_API = 'fluxus-desktop-bridge';
const BRIDGE_VERSION = 2;
const BRIDGE_GLOBAL = 'fluxusDesktop';

/** Описание сессии: синхронно и до первого кадра страницы (DSK-4, DSK-5). */
const session = ipcRenderer.sendSync(CHANNELS.session);
const granted = (capability) => session.capabilities.includes(capability);

const surface = { api: BRIDGE_API, version: BRIDGE_VERSION, session };

if (granted('read')) {
  surface.read = (root, path) => ipcRenderer.invoke(CHANNELS.read, root, path);
  surface.stat = (root, path) => ipcRenderer.invoke(CHANNELS.stat, root, path);
  surface.list = (root, path) => ipcRenderer.invoke(CHANNELS.list, root, path);
}

if (granted('write')) {
  surface.write = (root, path, bytes) => ipcRenderer.invoke(CHANNELS.write, root, path, bytes);
}

if (granted('watch')) {
  // Подписка синхронна по контракту, а её регистрация в главном процессе —
  // нет. Слушатель заводится сразу, отписка ждёт выданный токен: событие,
  // пришедшее до его выдачи, теряться не должно.
  const listeners = new Map();
  ipcRenderer.on(CHANNELS.change, (_event, id, change) => {
    const listener = listeners.get(id);
    if (listener !== undefined) listener(change);
  });
  surface.watch = (root, listener) => {
    let token = null;
    let stopped = false;
    const pending = ipcRenderer.invoke(CHANNELS.watchOn, root).then((id) => {
      token = id;
      if (stopped) return ipcRenderer.invoke(CHANNELS.watchOff, id);
      listeners.set(id, listener);
      return undefined;
    });
    return () => {
      stopped = true;
      if (token !== null) {
        listeners.delete(token);
        void ipcRenderer.invoke(CHANNELS.watchOff, token);
        return;
      }
      void pending;
    };
  };
}

if (granted('dialog')) {
  surface.choose = (request) => ipcRenderer.invoke(CHANNELS.choose, request);
}

if (granted('window')) {
  const closeHandlers = new Set();
  ipcRenderer.on(CHANNELS.closeRequest, (_event, id) => {
    // Каждый обработчик страницы отвечает «можно/нельзя»; первый отказ
    // прекращает опрос. Ответ уходит контейнеру, решение принимает он.
    const ask = async () => {
      for (const handler of [...closeHandlers]) {
        if (!(await handler())) return false;
      }
      return true;
    };
    void ask().then(
      (allow) => ipcRenderer.send(CHANNELS.closeReply, id, allow),
      () => ipcRenderer.send(CHANNELS.closeReply, id, true),
    );
  });
  surface.setTitle = (title) => ipcRenderer.send(CHANNELS.title, title);
  surface.setUnsaved = (unsaved) => ipcRenderer.send(CHANNELS.unsaved, unsaved);
  surface.onCloseRequest = (handler) => {
    closeHandlers.add(handler);
    return () => closeHandlers.delete(handler);
  };
}

if (granted('service')) {
  // Через границу едет ОДНО имя объявленного сервиса (DSK-7): ни файла, ни
  // аргументов страница не передаёт, и передать их нечем — канал их не несёт.
  surface.startService = (id) => ipcRenderer.invoke(CHANNELS.serviceStart, id);
  surface.stopService = (id) => ipcRenderer.invoke(CHANNELS.serviceStop, id);
  surface.serviceState = (id) => ipcRenderer.invoke(CHANNELS.serviceState, id);
}

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, surface);
