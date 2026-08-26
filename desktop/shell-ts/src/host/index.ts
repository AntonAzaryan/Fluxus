/**
 * Node-слой контейнера: корни на диске, раздача байтов, сборка моста по
 * профилю. Ни Electron, ни DOM — весь слой проверяется на чистом Node, и это
 * то, что делает гейт независимым от установленного контейнера (DSK-6).
 */
export { BUNDLE_ROOT, loadAppProfile, openApp, resolveProfilePaths } from './app.js';
export type { OpenAppOptions, OpenedApp } from './app.js';

export { certificateFingerprint, isFingerprint } from './certificate.js';

export { createHostBridge } from './bridge.js';
export type { HostBridgeHandle, HostBridgeOptions, HostDialogs, HostWindowSink } from './bridge.js';

export { NODE_OBSERVER } from './observe.js';
export type { DirectoryObservation, DirectoryObserver, DirectoryObserverOptions } from './observe.js';

export {
  compareHostNames,
  hostPathExtension,
  hostPathName,
  joinHostPath,
  normalizeHostPath,
} from './paths.js';
export type { HostPath } from './paths.js';

export { createHostRoot, insideRoot } from './root.js';
export type { HostRoot, HostRootOptions } from './root.js';

export { createHostServices, endpointOf, serviceArgs } from './service.js';
export type { HostServices, HostServicesOptions } from './service.js';

export { createStaticServer, mimeOf, requestPath } from './serve.js';
export type { ServeRefusal, ServeResult, ServedFile, StaticServer, StaticServerOptions } from './serve.js';
