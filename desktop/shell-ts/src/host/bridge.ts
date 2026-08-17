/**
 * Сборка моста по профилю (DSK-5) — то место, где whitelist перестаёт быть
 * словом и становится формой объекта.
 *
 * Возможность, которой профиль не объявил, здесь не появляется вовсе: не
 * метод, отвечающий отказом, а отсутствующее поле. Поэтому «игра пытается
 * писать» — не проверка времени исполнения, а отсутствие канала: в собранном
 * для игрового профиля мосте `write` нет ни в одном слое — ни в главном
 * процессе, ни в preload, ни в странице.
 *
 * Отказы, которые всё же нужны, — про корни, а не про возможности: имя корня
 * приходит из страницы, и «такого корня профиль не объявлял» обязано быть
 * ответом, а не молчанием. Второй такой отказ — запись в корень, объявленный
 * только на чтение: возможность `write` профиль дал, но не на все корни.
 *
 * Модуль — чистый Node: ни Electron, ни IPC. Именно он проверяется контрактным
 * сьютом в гейте (DSK-6), а клей реализации только маршрутизирует в него вызовы.
 */
import { profileGrants, type AppProfile } from '../bridge/profile.js';
import {
  BRIDGE_API,
  BRIDGE_VERSION,
  type BridgeCapability,
  type BridgeChoice,
  type BridgeChoiceRequest,
  type BridgeCloseHandler,
  type BridgeRootId,
  type BridgeRootView,
  type BridgeServiceId,
  type BridgeSession,
  type DesktopBridge,
} from '../bridge/types.js';
import type { HostPath } from './paths.js';
import type { HostRoot } from './root.js';
import type { HostServices } from './service.js';

/** Диалоги среды. Отсутствие диалога и отказ автора — одинаково `undefined`. */
export interface HostDialogs {
  choose(request: BridgeChoiceRequest, root: HostRoot): Promise<HostPath | undefined>;
}

/** Оконная сторона среды: то, что видно снаружи окна. */
export interface HostWindowSink {
  setTitle(title: string): void;
  setUnsaved(unsaved: boolean): void;
}

export interface HostBridgeOptions {
  readonly profile: AppProfile;
  /** Корни на диске; их имена обязаны совпадать с объявленными профилем. */
  readonly roots: readonly HostRoot[];
  /** Базовый адрес раздачи корня (DSK-4); по умолчанию раздачи нет. */
  readonly baseFor?: (root: HostRoot) => string;
  readonly dialogs?: HostDialogs;
  readonly window?: HostWindowSink;
  /** Объявленные сервисы (DSK-7); без них возможность `service` не собирается. */
  readonly services?: HostServices;
}

export interface HostBridgeHandle {
  /** Ровно то, что видит страница. */
  readonly bridge: DesktopBridge;
  readonly session: BridgeSession;
  /**
   * Контейнер спрашивает страницу о закрытии. `true` — закрывать безопасно;
   * обработчиков нет — тоже `true`.
   */
  requestClose(): Promise<boolean>;
  /** Что страница выставила окну: заголовок и признак несохранённого. */
  readonly title: string;
  readonly unsaved: boolean;
  close(): void;
}

function refuse(what: string): Error {
  return new Error(`мост контейнера: ${what}`);
}

export function createHostBridge(options: HostBridgeOptions): HostBridgeHandle {
  const { profile } = options;
  const byId = new Map<BridgeRootId, HostRoot>();
  for (const root of options.roots) {
    if (byId.has(root.id)) throw refuse(`корень "${root.id}" передан дважды`);
    byId.set(root.id, root);
  }
  for (const declared of profile.roots) {
    const root = byId.get(declared.id);
    if (root === undefined) throw refuse(`профиль объявил корень "${declared.id}", а его реализации нет`);
    if (root.writable !== declared.writable) {
      throw refuse(
        `корень "${declared.id}": профиль объявил запись=${String(declared.writable)}, реализация — ${String(root.writable)}`,
      );
    }
  }
  for (const root of options.roots) {
    if (!profile.roots.some((declared) => declared.id === root.id)) {
      throw refuse(`корень "${root.id}" не объявлен профилем "${profile.id}" (DSK-5)`);
    }
  }

  const baseFor = options.baseFor ?? ((): string => '');
  const rootViews: readonly BridgeRootView[] = profile.roots.map((declared) => {
    const root = byId.get(declared.id)!;
    return {
      id: declared.id,
      label: declared.label,
      writable: declared.writable,
      base: declared.serve ? baseFor(root) : '',
    };
  });

  const session: BridgeSession = {
    profile: profile.id,
    capabilities: profile.capabilities,
    roots: rootViews,
    services: profile.services.map((declared) => declared.id),
  };

  const rootOf = (id: BridgeRootId): HostRoot => {
    const root = byId.get(id);
    if (root === undefined) throw refuse(`корень "${id}" профилем не объявлен (DSK-5)`);
    return root;
  };

  const grants = (capability: BridgeCapability): boolean => profileGrants(profile, capability);

  const closeHandlers = new Set<BridgeCloseHandler>();
  const unsubscribers = new Set<() => void>();
  let title = profile.title;
  let unsaved = false;

  // Операции дерева — async, и это не украшение: у реализации, где мост едет
  // через IPC, отказ приходит отвергнутым промисом, а не исключением на месте
  // вызова. Контракт обязан быть одним для обеих, поэтому «корня нет» отвергает
  // промис и здесь.
  const read = {
    read: async (root: BridgeRootId, path: string) => rootOf(root).read(path),
    stat: async (root: BridgeRootId, path: string) => rootOf(root).stat(path),
    list: async (root: BridgeRootId, path: string) => rootOf(root).list(path),
  };

  const write = {
    write: async (root: BridgeRootId, path: string, bytes: Uint8Array) =>
      rootOf(root).write(path, bytes),
  };

  const watch = {
    watch: (root: BridgeRootId, listener: Parameters<HostRoot['watch']>[0]) => {
      const stop = rootOf(root).watch(listener);
      unsubscribers.add(stop);
      return () => {
        unsubscribers.delete(stop);
        stop();
      };
    },
  };

  const dialogs = options.dialogs;
  const choose = {
    choose: async (request: BridgeChoiceRequest): Promise<BridgeChoice | undefined> => {
      const root = rootOf(request.root);
      if (dialogs === undefined) return undefined;
      const path = await dialogs.choose(request, root);
      return path === undefined ? undefined : { root: root.id, path };
    },
  };

  const sink = options.window;
  const windowSurface = {
    setTitle: (next: string): void => {
      title = next;
      sink?.setTitle(next);
    },
    setUnsaved: (next: boolean): void => {
      unsaved = next;
      sink?.setUnsaved(next);
    },
    onCloseRequest: (handler: BridgeCloseHandler) => {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
  };

  // Сервисы: возможность объявлена профилем, а реализацию даёт контейнер.
  // Объявлена без реализации — дефект сборки, а не отказ странице: профиль
  // обещал возможность, которой в этой сессии нет (DSK-5).
  const services = options.services;
  if (grants('service') && services === undefined) {
    throw refuse(`профиль "${profile.id}" объявил возможность "service", а реализации сервисов нет`);
  }
  const serviceSurface = {
    startService: async (id: BridgeServiceId) => services!.start(id),
    stopService: async (id: BridgeServiceId) => services!.stop(id),
    serviceState: async (id: BridgeServiceId) => services!.state(id),
  };

  const bridge: DesktopBridge = {
    api: BRIDGE_API,
    version: BRIDGE_VERSION,
    session,
    ...(grants('read') ? read : {}),
    ...(grants('write') ? write : {}),
    ...(grants('watch') ? watch : {}),
    ...(grants('dialog') ? choose : {}),
    ...(grants('window') ? windowSurface : {}),
    ...(grants('service') ? serviceSurface : {}),
  };

  return {
    bridge,
    session,
    get title(): string {
      return title;
    },
    get unsaved(): boolean {
      return unsaved;
    },
    async requestClose(): Promise<boolean> {
      for (const handler of [...closeHandlers]) {
        if (!(await handler())) return false;
      }
      return true;
    },
    close(): void {
      for (const stop of [...unsubscribers]) stop();
      unsubscribers.clear();
      closeHandlers.clear();
    },
  };
}
