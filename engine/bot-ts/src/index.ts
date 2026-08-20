/**
 * Бот-игрок (capability `bot-player`, BOT-1..6): участник матча, управляемый
 * программой и неотличимый для сервера от человека.
 *
 * Пакет — потребитель уже существующих швов, а не новый слой протокола: клиент
 * матча (`netcode-transport` NTR-10), источник ввода (`input-devices` INP-1) и
 * транспорт (NTR-2) взяты как есть, `MatchServer`/`MatchClient`/протокол не
 * изменены ни строкой (`net-session` SES-2). Своего здесь три вещи: контракт
 * мозга (BOT-2), граница «мозг ↔ ввод» (BOT-5) и хостинг, соединяющий их с
 * клиентом (BOT-4).
 *
 * Зависимость на Yuka живёт ТОЛЬКО внутри классического мозга: запрет нулевых
 * зависимостей — правило ядра (`determinism-core`), и на слой вне симуляции оно
 * не распространяется, но и растекаться библиотеке по пакету незачем.
 */

// контракт мозга (BOT-2)
export type { BotBrain, BotBrainFactory, BotSelf } from './brain.js';

// профиль поведения — контент, а не код (BOT-6)
export {
  BOT_ABILITY_HANDS,
  BOT_CAST_COMMITS,
  BOT_ABILITY_TARGETS,
  BOT_BEHAVIORS,
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
  BotBehavior,
  BotDecisionProfile,
  BotMovementProfile,
  BotProfile,
  BotReactionProfile,
} from './profile.js';

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

// сборка: пара портов серверу и боту (design D3)
export { PortConnections, botWorkerInit, isBotWorkerInit } from './assembly.js';
export type { BotWireFormat, BotWorkerInit, BotWorkerSeat, MessageChannelLike, RawPort } from './assembly.js';

// мозги за контрактом
export { scriptedBrain, walkToCenter } from './brains/scripted.js';
export type { ScriptedBrainOptions, ScriptedTarget } from './brains/scripted.js';
export { classicBrain } from './brains/classic/classicBrain.js';
export type { ClassicBrainOptions } from './brains/classic/classicBrain.js';
export { brainFactoryByKind, BRAIN_KINDS } from './brains/registry.js';
export type { BrainAssembly, BrainKind } from './brains/registry.js';

// воркер-стороны (design D3)
export { startBotWorker } from './worker/botWorker.js';
export type { BotWorkerOptions } from './worker/botWorker.js';
export { attachBots } from './worker/spawn.js';
export type { AttachBotsOptions, WorkerLike } from './worker/spawn.js';
