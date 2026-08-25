/**
 * Агент хоста (`server-control` SRV-1..SRV-8) — headless-супервизор процессов
 * серверов матча с одним управляющим эндпоинтом.
 *
 * Корень пакета — сторона АГЕНТА: она поднимает TLS, спавнит процессы и держит
 * каталог состояния, поэтому её место — Node. Словарь протокола и клиентская
 * библиотека живут подпутями (`/protocol`, `/client`): их читает и страница
 * менеджера, и стенд демо, а `node:*` им не нужен.
 */
export { startAgent, freePort, type Agent, type AgentOptions } from './agent.js';
export { createRegistry, type ServerRegistry, type RegistryOptions } from './registry.js';
export { startControlServer, type ControlServer, type ControlServerOptions } from './controlServer.js';
export { startHttpServe, type HttpServe, type HttpServeOptions } from './httpServer.js';
export { RefusalError, refusalOf } from './refusal.js';
export {
  ensureCertificate,
  fingerprintOf,
  normalizeFingerprint,
  type AgentCertificate,
} from './state/certificate.js';
export { agentPaths, defaultStateDir, STATE_DIR_ENV, type AgentPaths } from './state/paths.js';
export { processAlive, processBook, type BookEntry, type ProcessBook } from './state/book.js';
export {
  tokenStore,
  MAX_PAIRING_FAILURES,
  PAIRING_CODE_TTL_MS,
  type IssuedToken,
  type TokenStore,
} from './state/tokens.js';
export {
  startStandProcess,
  portBusy,
  LOG_LINE_LIMIT,
  LOG_RING,
  type StandProcess,
  type StandProcessOptions,
  type StandProcessState,
} from './stand/process.js';
