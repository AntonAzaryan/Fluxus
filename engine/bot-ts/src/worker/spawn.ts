/**
 * Главная половина сборки бота (design D3): создать пару портов на каждого
 * бота, серверные концы отдать матчу, ботские — уехать воркеру одним
 * init-сообщением.
 *
 * Рантайм-агностично, как и всё остальное: пару портов создаёт переданная
 * фабрика (`() => new MessageChannel()` в браузере и в `node:worker_threads`),
 * а воркер здесь — что угодно, умеющее `postMessage` с transfer-списком. Так
 * dev-сборка вкладки и нагрузочный прогон node пользуются одним кодом.
 */
import { botWorkerInit, type BotWireFormat, type BotWorkerSeat, type MessageChannelLike, type PortConnections, type RawPort } from '../assembly.js';
import type { WorldViewNames } from '../worldView.js';
import type { PhysicsOptions, SceneDef, VisibilityOptions } from '@game-mvp/core';

/** Структурный минимум воркера: только отправка сообщения с переносом портов. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: readonly RawPort[]): void;
}

export interface AttachBotsOptions {
  readonly worker: WorkerLike;
  /** Серверная сторона каналов: её `MatchHost` уже принял как `TransportServer`. */
  readonly connections: PortConnections;
  /** Фабрика пары портов среды: `() => new MessageChannel()`. */
  readonly channel: () => MessageChannelLike;
  readonly seats: readonly BotWorkerSeat[];
  readonly buildId: string;
  readonly sceneRef: string;
  readonly scene: SceneDef;
  /** Формат кадра сервера матча (SER-3); отсутствие — умолчание протокола. */
  readonly wireFormat?: BotWireFormat;
  readonly physics?: PhysicsOptions;
  readonly visibility?: VisibilityOptions;
  readonly names?: WorldViewNames;
}

/**
 * Раздаёт концы каналов и отправляет init-сообщение. Порты уезжают transfer'ом:
 * порт — не копируемое значение, и без списка переноса воркер получил бы
 * сообщение, но не канал.
 */
export function attachBots(options: AttachBotsOptions): void {
  const ports = options.seats.map(() => options.connections.open(options.channel()));
  const init = botWorkerInit({
    seats: options.seats,
    ports,
    buildId: options.buildId,
    sceneRef: options.sceneRef,
    scene: options.scene,
    ...(options.wireFormat !== undefined ? { wireFormat: options.wireFormat } : {}),
    ...(options.physics !== undefined ? { physics: options.physics } : {}),
    ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
    ...(options.names !== undefined ? { names: options.names } : {}),
  });
  options.worker.postMessage(init, ports);
}
