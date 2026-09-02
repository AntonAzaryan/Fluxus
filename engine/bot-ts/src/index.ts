/**
 * Бот-игрок (capability `bot-player`): участник матча, управляемый
 * программой и неотличимый для сервера от человека.
 *
 * Пакет — потребитель уже существующих швов, а не новый слой протокола: клиент
 * матча (`netcode-transport` NTR-10), источник ввода (`input-devices` INP-1) и
 * транспорт (NTR-2) взяты как есть, `MatchServer`/`MatchClient`/протокол не
 * изменены ни строкой (`net-session` SES-2). Своего здесь три вещи: контракт
 * мозга (BOT-2), граница «мозг ↔ ввод» (BOT-5) и хостинг, соединяющий их с
 * клиентом (BOT-4).
 *
 * Зависимость на Yuka живёт ТОЛЬКО внутри микро-слоя мозга: запрет нулевых
 * зависимостей — правило ядра (`determinism-core`), и на слой вне симуляции оно
 * не распространяется, но и растекаться библиотеке по пакету незачем.
 */

// контракт мозга (BOT-2)
export type { BotBrain, BotBrainFactory, BotSelf } from './brain.js';

// профиль: человечность и состав способностей — контент, а не код (BOT-6)
export {
  BOT_ABILITY_HANDS,
  BOT_CAST_COMMITS,
  BOT_ABILITY_TARGETS,
  BOT_PROFILE_SCHEMA,
  BOT_STEP_AIMS,
  parseBotProfile,
} from './profile.js';
export type {
  BotAbilityCastProfile,
  BotAbilityHands,
  BotAbilityProfile,
  BotAbilityStepProfile,
  BotAbilityTarget,
  BotCastCommit,
  BotStepAim,
  BotAimProfile,
  BotDecisionProfile,
  BotMovementProfile,
  BotProfile,
  BotReactionProfile,
} from './profile.js';

// документ поведения: политика выбора действий — контент (BOT-8, BOT-9)
export {
  BOT_BEHAVIOR_SCHEMA,
  BOT_CURVES,
  BOT_EXECUTORS,
  BOT_INPUTS,
  parseBotBehavior,
} from './behavior.js';
export type {
  BotAction,
  BotBehaviorDocument,
  BotConsideration,
  BotCurve,
  BotCurveType,
  BotExecutor,
  BotInput,
} from './behavior.js';

// граница «мозг ↔ симуляция» (BOT-5, `input-devices` INP-3)
export { TURN_UNITS, aimToRadians, readFixedField, readIntField, toInputSample } from './boundary.js';
export type { BotAimPoint, BotIntent } from './boundary.js';
export { readWorldView } from './worldView.js';
export type { BotEntityView, BotSlotView, BotWorldView, WorldViewNames } from './worldView.js';

// рельеф сцены: приезжает сборкой, как центр арены (TERR-6, NET-16)
export { botTerrain } from './terrainView.js';
export type { BotTerrain } from './terrainView.js';

// хостинг (BOT-1, BOT-4)
export { BotHost, BotSeat } from './host.js';
export type { BotSeatOptions } from './host.js';

// заполнение слота (BOT-7): политика сборки-основателя, а не сервера
export { BotSlotFiller } from './fill.js';
export type { BotFillSeat, BotSlotFillerOptions, FillSchedule } from './fill.js';

// замещение отвалившегося игрока (BOT-14): та же сторона, что владеет ботом
export { BotSubstitutes } from './substitute.js';
export type { BotSubstitutesOptions } from './substitute.js';

// сборка: пара портов серверу и боту (design D3)
export { PortConnections, botWorkerInit, isBotWorkerInit } from './assembly.js';
export type { BotWireFormat, BotWorkerInit, BotWorkerSeat, MessageChannelLike, RawPort } from './assembly.js';

// мозги за контрактом: evaluator документа поведения (BOT-8) и скриптовый
export { scriptedBrain, walkToCenter } from './brains/scripted.js';
export type { ScriptedBrainOptions, ScriptedTarget } from './brains/scripted.js';
export { evaluatedBrain } from './brains/evaluated/evaluatedBrain.js';
export type { EvaluatedBrainOptions } from './brains/evaluated/evaluatedBrain.js';
export type {
  ActionTrace,
  BotDecisionRecord,
  BotDecisionSink,
  ConsiderationTrace,
} from './brains/evaluated/scoring.js';
export { brainFactoryByKind, BRAIN_KINDS } from './brains/registry.js';
export type { BrainAssembly, BrainKind } from './brains/registry.js';

// воркер-стороны (design D3)
export { startBotWorker } from './worker/botWorker.js';
export type { BotWorkerOptions } from './worker/botWorker.js';
export { attachBots } from './worker/spawn.js';
export type { AttachBotsOptions, WorkerLike } from './worker/spawn.js';
