/**
 * Приложение, поднятое по манифесту профиля: корни на диске, раздача и мост
 * (DSK-1, DSK-4, DSK-5).
 *
 * Здесь сходятся обе стороны, которыми контейнер трогает дерево, — раздача
 * (protocol handler читает) и мост (страница читает и пишет), — и сходятся они
 * на ОДНИХ корнях (`HostRoot`), а не на двух независимых реализациях доступа.
 * Это решение design'а, а не удобство: разъехавшись, они дали бы «записал через
 * мост, а раздача отдаёт прежние байты» — расхождение, которое не ловится
 * ничем, кроме глаз автора.
 *
 * Клея Electron тут нет: модуль — чистый Node, и именно он поднимается в
 * контрактном сьюте гейта (DSK-6).
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { normalizeAppProfile, type AppProfile } from '../bridge/profile.js';
import type { BridgeRootId } from '../bridge/types.js';
import { createHostBridge, type HostBridgeHandle, type HostBridgeOptions } from './bridge.js';
import type { DirectoryObserver } from './observe.js';
import { createHostRoot, type HostRoot } from './root.js';
import { createHostServices, type HostServices, type HostServicesOptions } from './service.js';
import { createStaticServer, type StaticServer } from './serve.js';

/** Имя внутреннего корня бандла: слой раздачи, который мост не показывает. */
export const BUNDLE_ROOT: BridgeRootId = 'bundle';

/**
 * Читает манифест профиля и приводит его пути к абсолютным относительно самого
 * манифеста. Профиль — данные рядом с контейнером, и его пути естественно
 * писать от него, а не от каталога, из которого случился запуск.
 */
export async function loadAppProfile(manifestPath: string): Promise<AppProfile> {
  const file = resolve(manifestPath);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(
      `манифест профиля "${file}" не прочитан: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`манифест профиля "${file}" — не JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolveProfilePaths(normalizeAppProfile(raw, file), dirname(file));
}

/** Пути профиля от каталога `base`; уже абсолютные остаются как есть. */
export function resolveProfilePaths(profile: AppProfile, base: string): AppProfile {
  const at = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));
  return {
    ...profile,
    bundle: at(profile.bundle),
    roots: profile.roots.map((root) => ({ ...root, directory: at(root.directory) })),
    services: profile.services.map((service) => ({ ...service, script: at(service.script) })),
  };
}

export interface OpenAppOptions {
  readonly profile: AppProfile;
  /** Базовый адрес раздачи (DSK-4): его сообщает реализация контейнера. */
  readonly base?: string;
  readonly observer?: DirectoryObserver;
  readonly report?: (text: string) => void;
  readonly dialogs?: HostBridgeOptions['dialogs'];
  readonly window?: HostBridgeOptions['window'];
  /** Как запускать объявленные сервисы (DSK-7); рантайм и среда — дело реализации. */
  readonly services?: Omit<HostServicesOptions, 'profile'>;
}

export interface OpenedApp {
  readonly profile: AppProfile;
  /** Корень бандла: раздаётся, но мостом не показывается. */
  readonly bundle: HostRoot;
  readonly roots: readonly HostRoot[];
  readonly server: StaticServer;
  readonly handle: HostBridgeHandle;
  /** Сервисы сессии; у профиля без возможности `service` их нет (DSK-5). */
  readonly services: HostServices | undefined;
  close(): void;
}

/**
 * Поднимает приложение профиля. Корни открываются в объявленном порядке, бандл
 * идёт первым слоем раздачи (см. основание в `serve.ts`).
 */
/**
 * Имена верхнего уровня раздаваемого корня, которые БАНДЛ заслоняет собой: он
 * идёт первым слоем раздачи, и совпадение имён означает, что запрос ассета
 * получит копию из бандла вместо живого дерева (DSK-4).
 *
 * Копия эта заводится не по злому умыслу: обычная веб-сборка приложения кладёт
 * дерево контента внутрь бандла (`publicDir`), потому что в вебе раздаёт его
 * она сама. В контейнере дерево раздаёт контейнер — и раздаёт ЖИВОЕ, чтобы
 * правка документа доезжала до кадра; заслонённое снимком, оно перестало бы
 * меняться, а виноватым выглядел бы контейнер. Отсюда `*:desktop`-сборки
 * приложений и эта сверка на старте.
 *
 * Сравниваются КАТАЛОГИ верхнего уровня, а не всякое совпадение имён: копия
 * дерева приезжает целиком, каталогами (`scenes`, `matches`, `visuals`), а
 * одинокий одноимённый ФАЙЛ — обычное дело и ровно то, ради чего слои
 * упорядочены (`index.html` бандла закрывает собой одноимённый файл корня).
 *
 * Каталог, которого нет, ничего не заслоняет; нечитаемый — не повод падать
 * вместо запуска (профиль проверяется дальше, и его отказ точнее).
 */
export function shadowedNames(bundleDir: string, rootDir: string): readonly string[] {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && statSync(join(bundleDir, entry.name), { throwIfNoEntry: false })?.isDirectory() === true)
    .map((entry) => entry.name);
}

export function openApp(options: OpenAppOptions): OpenedApp {
  const { profile } = options;
  if (profile.roots.some((root) => root.id === BUNDLE_ROOT)) {
    throw new Error(`профиль "${profile.id}": имя корня "${BUNDLE_ROOT}" занято слоем бандла`);
  }
  // Бандл со снимком раздаваемого корня — НАЗВАННЫЙ отказ на старте, а не
  // молчаливая раздача копии: «базовый адрес дерева контента сообщается
  // приложению контейнером» (DSK-4), и приложение вправе считать, что по нему
  // лежит то же, что на диске. Проверка ровно та же, что у раздачи агента хоста
  // (`server-control` SRV-8), и повторена она здесь, а не заимствована: контейнер
  // не зависит от пакетов репозитория (DSK-3).
  for (const root of profile.roots) {
    if (!root.serve) continue;
    const shadowed = shadowedNames(profile.bundle, root.directory);
    if (shadowed.length > 0) {
      throw new Error(
        `профиль "${profile.id}": бандл "${profile.bundle}" несёт в себе копию корня ` +
          `"${root.id}" (${shadowed.join(', ')}) и заслонил бы живое дерево (DSK-4). ` +
          'Соберите бандл без копии дерева — сборкой `*:desktop`',
      );
    }
  }
  const shared = {
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    ...(options.report === undefined ? {} : { report: options.report }),
  };
  const bundle = createHostRoot({
    id: BUNDLE_ROOT,
    label: profile.id,
    directory: profile.bundle,
    serve: true,
    ...shared,
  });
  const roots = profile.roots.map((declared) =>
    createHostRoot({
      id: declared.id,
      label: declared.label,
      directory: declared.directory,
      writable: declared.writable,
      serve: declared.serve,
      ...shared,
    }),
  );
  const server = createStaticServer({
    layers: [bundle, ...roots.filter((root) => root.serve)],
    entry: profile.entry,
  });
  const base = options.base ?? '';
  // Сервисы поднимаются только объявившему их профилю: без возможности
  // `service` их нет ни объектом, ни полем моста (DSK-5).
  const services =
    profile.services.length === 0
      ? undefined
      : createHostServices({
          profile,
          ...(options.report === undefined ? {} : { report: options.report }),
          ...(options.services ?? {}),
        });
  const handle = createHostBridge({
    profile,
    roots,
    baseFor: () => base,
    ...(options.dialogs === undefined ? {} : { dialogs: options.dialogs }),
    ...(options.window === undefined ? {} : { window: options.window }),
    ...(services === undefined ? {} : { services }),
  });

  return {
    profile,
    bundle,
    roots,
    server,
    handle,
    services,
    close(): void {
      handle.close();
      bundle.close();
      for (const root of roots) root.close();
      // Сервис не переживает сессию, которая его подняла (DSK-7): осиротевший
      // процесс держал бы адрес занятым, а приложения, ради которого он поднят,
      // уже нет.
      void services?.closeAll();
    },
  };
}
