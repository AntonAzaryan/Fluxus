/**
 * Шов среды (ED-12): один интерфейс хоста, обход дерева поверх него, переходник
 * к модулю ассетов и реализация в памяти. Веб-реализация живёт в
 * `@fluxus/editor-ui`, десктопная — в оболочке; здесь их нет и быть не может:
 * в `lib` этого пакета нет DOM, а файловой системы у веба нет вовсе.
 */
export type {
  ChoiceRequest,
  CloseRequestHandler,
  ContentChange,
  ContentChangeKind,
  ContentEntry,
  ContentEntryKind,
  ContentPicker,
  ContentRootInfo,
  ContentTreeHost,
  ContentWatcher,
  EnvironmentHost,
  WindowHost,
} from './types.js';

export {
  compareContentNames,
  contentPathExtension,
  contentPathName,
  contentPathParent,
  isInsideContentPath,
  joinContentPath,
  normalizeContentPath,
} from './paths.js';
export type { ContentPath } from './paths.js';

export { createMemoryHost } from './memory.js';
export type {
  MemoryChoices,
  MemoryFileContent,
  MemoryHost,
  MemoryHostOptions,
  MemoryWindowState,
} from './memory.js';

export { createOverlayHost } from './overlay.js';
export type { OverlayHost, OverlayHostOptions } from './overlay.js';

export { DEFAULT_WALK_DEPTH, walkContentTree } from './walk.js';
export type { WalkOptions } from './walk.js';

export { createHostAssetSource } from './assetSource.js';
export type { ContentAssetSource, HostAssetSource, StaleListener } from './assetSource.js';
