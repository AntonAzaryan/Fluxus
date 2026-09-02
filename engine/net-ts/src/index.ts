/**
 * Сетевой слой (NTR-1). Зависимость на ядро строго односторонняя: здесь
 * импортируется `@fluxus/core`, обратного импорта нет и быть не может —
 * ядро о сети не знает (DI-3), и модуль делает это проверяемым сборкой, а не
 * ревью.
 *
 * Сетевому слою доступна только уже опубликованная поверхность ядра. Хелпер,
 * добавленный в ядро «для сети», и есть тот side-channel, который TICK-3
 * объявляет несуществующим, как бы он ни назывался.
 */

// протокол
export {
  parseClientMessage,
  parseServerMessage,
  toInputFrame,
  toWireSnapshot,
  ProtocolError,
  // Закрытые наборы паузы — ЗНАЧЕНИЯМИ, а не только типами (NTR-20). Внешний
  // разбор (управляющий протокол агента) иначе переписывает их у себя строковым
  // литералом, и четвёртое состояние стало бы у него молчаливым отказом на
  // проводе вместо ошибки типов.
  PAUSE_DENY_REASONS,
  PAUSE_STATES,
} from './protocol/messages.js';
export type {
  ByeMessage,
  ClientCloseReason,
  ClientMessage,
  ConnectionRole,
  EndMessage,
  EndReason,
  EventBatch,
  EventsMessage,
  GameVersion,
  HelloMessage,
  InputMessage,
  MatchDescriptor,
  Pacing,
  PauseAction,
  PauseDenyReason,
  PauseMessage,
  PauseRequestMessage,
  PauseState,
  RejectMessage,
  RejectReason,
  ServerMessage,
  SnapshotMessage,
  StartMessage,
  WelcomeMessage,
  WireInput,
  WireSnapshot,
} from './protocol/messages.js';
export {
  clientCodec,
  jsonSerializer,
  msgpackSerializer,
  serverCodec,
  DEFAULT_SERIALIZER,
} from './protocol/codec.js';
export type { Codec } from './protocol/codec.js';

// транспорт
export { BaseTransport, transportRtt, RTT_PENDING, RTT_UNSUPPORTED } from './transport/transport.js';
export type {
  ConnectionId,
  Transport,
  TransportRtt,
  TransportServer,
} from './transport/transport.js';
export { loopbackPair, LoopbackHub } from './transport/loopback.js';
export type { LoopbackOptions } from './transport/loopback.js';
export { connectWebSocket } from './transport/webSocketClient.js';
export { webSocketTransportServer, webSocketChannelServer } from './transport/webSocketServer.js';
export type { WebSocketChannelServer, WebSocketServerOptions } from './transport/webSocketServer.js';
export { mergeTransportServers } from './transport/merged.js';

// контент-пак
export { contentPack } from './content/pack.js';
export type { LoadedContentPack } from './content/pack.js';

// мир матча
export { buildMatchWorld, orderedSchemas } from './match/world.js';
export type { MatchWorld, MatchWorldDef } from './match/world.js';
export { BranchHistory } from './match/history.js';
export type { MatchHistory } from './match/history.js';
export { firstRewindRequest, warnToConsole, REWIND_REQUEST_EVENT } from './match/rewindRequest.js';
export type { RewindRequest, RewindRequestWarn } from './match/rewindRequest.js';
export { createMatchTrace } from './match/trace.js';
export type { MatchTrace, MatchTraceMark, MatchTraceMarkKind, TraceSelect } from './match/trace.js';
export { replaySegments } from './match/replay.js';
export type {
  ReplaySegment,
  SegmentedReplayDef,
  SegmentedReplayResult,
} from './match/replay.js';

// сервер
export { MatchServer } from './server/matchServer.js';
export type {
  MatchConfig,
  MatchPauseOptions,
  MatchPhase,
  MatchRewindOptions,
  MatchSegment,
  Outgoing,
  SlotLease,
  SlotLeaseEnd,
} from './server/matchServer.js';
export { MatchHost } from './server/host.js';
export type { ConnectionMetrics, HostReport, MatchHostOptions } from './server/host.js';
export type { DurationSummary } from './server/hostMetrics.js';

// клиент
export { MatchClient } from './client/matchClient.js';
export type {
  ClientPhase,
  ContentPack,
  DeliveredEvents,
  InputSample,
  MatchClientOptions,
  MatchSample,
} from './client/matchClient.js';
export type { DeliveredPause } from './client/pause.js';
export { ClientHost } from './client/host.js';
export { startPaced } from './schedule.js';
export type { PacedTimer } from './schedule.js';
export type { ClientHostOptions, ClientStep, InputSource } from './client/host.js';
export { InputRing, DEFAULT_RING_TICKS } from './client/inputRing.js';
export type { SentInput } from './client/inputRing.js';
export { InterpolationBuffer, vanishedEntities, DEFAULT_DELAY_MS } from './client/interpolation.js';
export type {
  InterpolationOptions,
  InterpolationSample,
  PresentedState,
} from './client/interpolation.js';

// лобби (SES-4) — свой закрытый набор сообщений, отдельный от набора матча
export {
  LobbyProtocolError,
  parseLobbyClientMessage,
  parseLobbyServerMessage,
} from './lobby/messages.js';
export type {
  BeginMessage,
  ClosedMessage,
  DeniedMessage,
  JoinMessage,
  JoinedMessage,
  LeaveMessage,
  LobbyClientMessage,
  LobbyCloseReason,
  LobbyDenyReason,
  LobbyServerMessage,
  RosterMessage,
} from './lobby/messages.js';
export { lobbyClientCodec, lobbyServerCodec } from './lobby/codec.js';
export { LobbyServer } from './lobby/lobbyServer.js';
export type { LobbyConfig, LobbyOutgoing, LobbyPhase } from './lobby/lobbyServer.js';
export { LobbyHost } from './lobby/host.js';
export type { LobbyHostOptions } from './lobby/host.js';
export { LobbyClient } from './lobby/lobbyClient.js';
export type { LobbyClientOptions, LobbyClientOutcome, LobbyClientPhase } from './lobby/lobbyClient.js';
export { LobbyClientHost } from './lobby/clientHost.js';
export type { LobbyClientHostOptions } from './lobby/clientHost.js';

// сессия (SES-1..9) — размещение авторитета и рандеву
export { createSessionInfo } from './session/session.js';
export type { SessionInfo, SessionMode, SessionPhase } from './session/session.js';
export { RendezvousError } from './session/rendezvous.js';
export type { PublishedSession, Rendezvous, SessionChannel } from './session/rendezvous.js';
export { decodeInvite, encodeInvite } from './session/invite.js';
export { randomToken } from './session/rendezvous/token.js';
export type { InvitePayload } from './session/invite.js';
export { InProcessRendezvous } from './session/rendezvous/inProcess.js';
export type { InProcessRendezvousOptions } from './session/rendezvous/inProcess.js';
export { WebSocketRendezvous } from './session/rendezvous/webSocket.js';
export type { WebSocketRendezvousOptions } from './session/rendezvous/webSocket.js';
export { HostSession } from './session/hostSession.js';
export type { HostSessionOptions, StartedMatch } from './session/hostSession.js';
export { DedicatedSession } from './session/dedicatedSession.js';
export type { DedicatedSessionOptions } from './session/dedicatedSession.js';
export { joinMatch, joinSession, SessionJoinError } from './session/joinSession.js';
export type {
  JoinMatchOptions,
  JoinSessionOptions,
  JoinedMatch,
  LobbyFailure,
} from './session/joinSession.js';

// наблюдаемость
export { createClientMetrics, createServerMetrics, recordInputToVisible } from './metrics.js';
export type { ClientMetrics, ServerMetrics, SlotCounters } from './metrics.js';
