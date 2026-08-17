/**
 * Контракт границы контейнера (DSK-2, DSK-5) — и больше ничего. Слой без единой
 * зависимости: его вправе импортировать и главный процесс контейнера, и
 * страница приложения, и тест на чистом Node.
 */
export {
  BRIDGE_API,
  BRIDGE_CAPABILITIES,
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  desktopBridgeOf,
  sessionGrants,
  sessionRoot,
} from './types.js';
export type {
  BridgeCapability,
  BridgeChange,
  BridgeChangeKind,
  BridgeChangeListener,
  BridgeChoice,
  BridgeChoiceRequest,
  BridgeCloseHandler,
  BridgeEntry,
  BridgeEntryKind,
  BridgePath,
  BridgeRootId,
  BridgeRootView,
  BridgeServiceId,
  BridgeServiceState,
  BridgeSession,
  BridgeUnsubscribe,
  DesktopBridge,
} from './types.js';

export { normalizeAppProfile, profileGrants, profileRoot, profileService } from './profile.js';
export type { AppProfile, ProfileRoot, ProfileService } from './profile.js';
