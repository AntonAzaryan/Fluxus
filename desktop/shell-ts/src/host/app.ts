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
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
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
export function openApp(options: OpenAppOptions): OpenedApp {
  const { profile } = options;
  if (profile.roots.some((root) => root.id === BUNDLE_ROOT)) {
    throw new Error(`профиль "${profile.id}": имя корня "${BUNDLE_ROOT}" занято слоем бандла`);
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
