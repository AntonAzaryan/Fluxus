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
import type { NavigationOptions, PhysicsOptions, SceneDef, VisibilityOptions } from '@fluxus/core';

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
  /**
   * Включение и параметры поиска пути (NTR-14): зависимость сборки наравне с
   * физикой и пересчётом видимости, приезжает из одного описания матча обеим
   * сторонам — иначе предсказание водило бы NPC не там, где сервер.
   */
  readonly navigation?: NavigationOptions;
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
    ...(options.navigation !== undefined ? { navigation: options.navigation } : {}),
    ...(options.names !== undefined ? { names: options.names } : {}),
  });
  options.worker.postMessage(init, ports);
}
