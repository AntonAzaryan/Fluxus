/**
 * Словарь управляющего протокола (SRV-2) — подпуть пакета `@fluxus/server-agent
 * /protocol`.
 *
 * Подпутём, а не корневым `index.ts`, потому что корень поднимает самого агента
 * и тянет за собой `node:*`, а словарь читается и в браузерной странице
 * менеджера (`server-manager` MGR-1), и в стенде демо (control-адаптер, решение
 * D2). Модули словаря ничего не импортируют — это условие такой переносимости, а
 * не аккуратность.
 */
export {
  ADMIN_OPS,
  CONTROL_PROTOCOL_VERSION,
  MATCH_PHASES,
  REFUSAL_REASONS,
  SERVER_STATES,
  SLOT_STATUSES,
} from './messages.js';
export type {
  AdminOp,
  AdminRequest,
  AgentVersions,
  ControlRequest,
  ControlResponse,
  ListRequest,
  LogRequest,
  MatchPhase,
  MatchesRequest,
  RefusalReason,
  RefusedResponse,
  ResultResponse,
  RevokeRequest,
  ServerEntry,
  ServerEvent,
  ServerMetricsView,
  ServerState,
  SlotRtt,
  SlotStatus,
  SlotView,
  StartParams,
  StartRequest,
  StopAllRequest,
  StopRequest,
  SubscribeRequest,
  TokenView,
  TokensRequest,
  UnsubscribeRequest,
  WelcomeResponse,
} from './messages.js';
export { ControlProtocolError, parseControlRequest, parseControlResponse } from './parse.js';
