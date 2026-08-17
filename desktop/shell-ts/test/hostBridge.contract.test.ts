/**
 * Node-реализация контейнера против общего контрактного сьюта (DSK-6).
 *
 * Это и есть «проверки контракта SHALL исполняться без запуска самого
 * контейнера в гейте»: Electron здесь не участвует — поднимаются корни на
 * диске, раздача и мост, собранный по профилю. Клей Electron маршрутизирует
 * вызовы в те же самые модули, поэтому проверенным оказывается ровно то
 * поведение, которое увидит страница в настоящем окне.
 *
 * Вторая реализация контейнера регистрируется здесь же — вызовом
 * `describeContainerContract` со своей функцией `open`.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppProfile } from '../src/bridge/profile.js';
import { openApp } from '../src/host/app.js';
import {
  CONTENT,
  SERVICE,
  describeContainerContract,
  type ContractSession,
} from './contractSuite.js';
import {
  dropTree,
  fakeObserver,
  freePort,
  linkOutside,
  makeTree,
  putFile,
  readText,
  SERVICE_SCRIPT,
  text,
} from './support.js';

/** Базовый адрес раздачи: страница получает его от контейнера (DSK-4). */
const BASE = 'fluxus://app/';

describeContainerContract('node-хост', async (kase): Promise<ContractSession> => {
  const workspace = await makeTree();
  const bundleDirectory = join(workspace, 'bundle');
  const contentDirectory = join(workspace, 'content');
  for (const [path, content] of Object.entries(kase.bundle ?? {})) {
    await putFile(bundleDirectory, path, content);
  }
  for (const [path, content] of Object.entries(kase.content ?? {})) {
    await putFile(contentDirectory, path, content);
  }

  const observer = fakeObserver();
  // Адрес сервиса объявляет профиль (DSK-7), поэтому порт выбирается ДО
  // запуска; в аргументы он приезжает подстановкой из адреса, а не второй
  // записью числа.
  const port = await freePort();
  const profile = normalizeAppProfile(
    {
      id: 'contract',
      title: 'Fluxus Contract',
      bundle: bundleDirectory,
      roots: [
        {
          id: CONTENT,
          label: 'content',
          directory: contentDirectory,
          writable: kase.writable,
          serve: true,
        },
      ],
      capabilities: kase.capabilities,
      services: kase.capabilities.includes('service')
        ? [
            {
              id: SERVICE,
              script: SERVICE_SCRIPT,
              args: ['--port', '{port}'],
              address: `tcp://127.0.0.1:${String(port)}`,
            },
          ]
        : [],
    },
    'contract.app.json',
  );

  const app = openApp({
    profile,
    base: BASE,
    observer: observer.observer,
    // Диалоги и окно среды подставные: у чистого Node их нет, а контракт
    // проверяет не системный диалог, а то, что через границу проходит путь.
    dialogs: { choose: (request) => Promise.resolve(request.startIn ?? '') },
    window: { setTitle: () => undefined, setUnsaved: () => undefined },
  });

  return {
    bridge: app.handle.bridge,
    async touch(path, content) {
      await putFile(contentDirectory, path, content);
      observer.emit(path);
    },
    async remove(path) {
      await rm(join(contentDirectory, path), { force: true });
      observer.emit(path);
    },
    linkOutside: (path) => linkOutside(contentDirectory, path, join(workspace, 'outside')),
    peek: (path) => readText(contentDirectory, path),
    async fetch(pathname) {
      const result = await app.server.serve(pathname);
      return result.ok ? { ok: true, body: text(result.bytes), mime: result.mime } : { ok: false };
    },
    requestClose: () => app.handle.requestClose(),
    // Взгляд снаружи границы: сколько процессов держит контейнер. Отвечает и
    // после `close` — иначе «сервис не пережил сессию» осталось бы обещанием.
    serviceProcesses: () => Promise.resolve(app.services?.owned() ?? 0),
    async close() {
      app.close();
      await app.services?.closeAll();
      await dropTree(workspace);
    },
  };
});
