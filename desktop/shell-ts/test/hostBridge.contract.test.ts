/**
 * Node-реализация контейнера против общего контрактного сьюта (DSK-6).
 *
 * Это и есть «проверки контракта SHALL исполняться без запуска самого
 * контейнера в гейте»: Electron здесь не участвует — поднимаются корни на
 * диске, раздача и мост, собранный по профилю. Клей Electron маршрутизирует
 * вызовы в те же самые модули, поэтому проверенным оказывается ровно то
 * поведение, которое увидит страница в настоящем окне.
 *
 * Отвязываемый сервис (DSK-7) проверяется здесь же и обеими ветвями: сессия
 * открывается ПОВТОРНО на том же каталоге состояния — так приложение открывают
 * во второй раз, — и переживший процесс обязан найтись по адресному файлу.
 *
 * Вторая реализация контейнера регистрируется здесь же — вызовом
 * `describeContainerContract` со своей функцией `open`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppProfile } from '../src/bridge/profile.js';
import { openApp } from '../src/host/app.js';
import { detachedFiles, pidAlive, readPid } from '../src/host/detached.js';
import {
  CONTENT,
  SERVICE,
  describeContainerContract,
  type ContractCase,
  type ContractSession,
} from './contractSuite.js';
import {
  DETACHED_SERVICE_SCRIPT,
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

/** Что переживает пересоздание сессии: дерево, порт сервиса и его состояние. */
interface Ground {
  readonly workspace: string;
  readonly port: number;
  readonly stateDir: string;
  readonly marks: string;
}

async function openOn(kase: ContractCase, ground: Ground): Promise<ContractSession> {
  const { workspace, port, stateDir, marks } = ground;
  const bundleDirectory = join(workspace, 'bundle');
  const contentDirectory = join(workspace, 'content');
  for (const [path, content] of Object.entries(kase.bundle ?? {})) {
    await putFile(bundleDirectory, path, content);
  }
  for (const [path, content] of Object.entries(kase.content ?? {})) {
    await putFile(contentDirectory, path, content);
  }

  const observer = fakeObserver();
  const detached = kase.detachedService === true;
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
              // Отвязываемому нужен процесс, который пишет свой адрес и
              // отмечает запуски; обычному хватает пустышки.
              script: detached ? DETACHED_SERVICE_SCRIPT : SERVICE_SCRIPT,
              args: detached
                ? ['--port', '{port}', '--address-file', '{addressFile}', '--mark', marks]
                : ['--port', '{port}'],
              address: `tcp://127.0.0.1:${String(port)}`,
              ...(detached ? { detached: true } : {}),
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
    services: { stateDir },
  });

  /** Жив ли процесс сервиса: свой — по записи контейнера, чужой — по pid-файлу. */
  const alive = (): boolean => {
    if ((app.services?.owned() ?? 0) > 0) return true;
    const files = detachedFiles(stateDir, SERVICE);
    return pidAlive(readPid(files.pidFile));
  };

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
    serviceAlive: () => Promise.resolve(alive()),
    serviceStarts: () =>
      Promise.resolve(existsSync(marks) ? readFileSync(marks, 'utf8').trim().split('\n').length : 0),
    // Вторая сессия того же профиля на том же состоянии: дерево, порт и каталог
    // состояния сервисов остаются прежними — меняется только сессия.
    reopen: () => openOn(kase, ground),
    async close() {
      app.close();
      await app.services?.closeAll();
      // Дерево уносится только тогда, когда уносить безопасно: у отвязываемого
      // сервиса оно переживает сессию вместе с ним — там лежат его адресный
      // файл и pid, которыми его найдёт следующая сессия (DSK-7).
      if (!alive()) await dropTree(workspace);
    },
  };
}

describeContainerContract('node-хост', async (kase): Promise<ContractSession> => {
  const workspace = await makeTree();
  // Адрес сервиса объявляет профиль (DSK-7), поэтому порт выбирается ДО
  // запуска; в аргументы он приезжает подстановкой из адреса, а не второй
  // записью числа.
  const port = await freePort();
  return openOn(kase, {
    workspace,
    port,
    stateDir: join(workspace, 'services'),
    marks: join(workspace, 'starts.log'),
  });
});
