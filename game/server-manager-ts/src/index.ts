/**
 * Fluxus Server Manager (`server-manager` MGR-1..MGR-5) — приложение управления
 * серверами: хосты, список серверов, детали и админ-операции.
 *
 * Пакет headless по составу: всё, что здесь есть, — состояние, описание
 * представления и стиль. Монтирование в DOM и мост десктоп-контейнера живут в
 * `app/`, потому что это уже сборка приложения, а не его предмет.
 */
export { createManagerSession } from './session.js';
export type {
  HostView,
  ManagerSession,
  ManagerSessionOptions,
  ManagerState,
  ServerDetails,
  ServerRow,
} from './session.js';
export { hostBook, hostIdOf, memoryStorage, pageStorage, HOST_BOOK_KEY } from './hostBook.js';
export type { HostBook, KnownHost, PageStorage } from './hostBook.js';
export { AGENT_SERVICE, managerBridge, parseLocalAgentAddress, startLocalAgent } from './localAgent.js';
export type { LocalAgentAddress, ManagerBridge } from './localAgent.js';
export { managerView, walk } from './view.js';
export type { UiNode } from './view.js';
export { MANAGER_STYLES, MANAGER_TOKENS } from './theme.js';
