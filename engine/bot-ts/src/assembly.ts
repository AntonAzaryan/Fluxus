/**
 * Сборка бота: пара портов, один конец — серверной стороне, другой уезжает
 * воркеру бота (design D3).
 *
 * Место исполнения бота — свойство сборки, а не кода (BOT-4, `net-session`
 * SES-1): хост принимает `Transport`, и кто держит другой его конец — второй
 * воркер вкладки, поток `worker_threads` или сокет на другом континенте — ни
 * сервер, ни клиент не различают (NTR-2).
 *
 * Транспорт поверх портов здесь не пишется заново: `portTransport` оболочки
 * (`client-shell` SHELL-3) уже абстрагирует структурный минимум порта, общий
 * для браузерного `MessagePort` и node `worker_threads`. Импорт — узкими
 * подпутями пакета оболочки: боту не нужны ни DOM, ни рендер, и тянуть их
 * корневым модулем ради сорока строк транспорта незачем.
 */
import type { PhysicsOptions, SceneDef, VisibilityOptions } from '@game-mvp/core';
import type { Transport, TransportServer } from '@game-mvp/net';
import { shellPort } from '@game-mvp/client/protocol';
import { portTransport } from '@game-mvp/client/portTransport';
import type { BotProfile } from './profile.js';
import type { BrainKind } from './brains/registry.js';

/** Сырой порт до оборачивания в `ShellPort`: DOM `MessagePort` или node-порт. */
export type RawPort = Parameters<typeof shellPort>[0];

/** Пара связанных портов: `MessageChannel` браузера и `worker_threads` одинаковы. */
export interface MessageChannelLike {
  readonly port1: RawPort;
  readonly port2: RawPort;
}

/**
 * Серверная сторона портовых каналов как обычный `TransportServer` (NTR-2):
 * `MatchHost` не узнаёт, что соединение приехало портом, а не сокетом, и
 * ветвления «для бота» в сервере не появляется (BOT-1, SES-2).
 */
export class PortConnections implements TransportServer {
  private handler: ((transport: Transport) => void) | undefined;
  private readonly pending: Transport[] = [];
  private readonly opened: Transport[] = [];

  onConnection(handler: (transport: Transport) => void): void {
    this.handler = handler;
    while (this.pending.length > 0) handler(this.pending.shift()!);
  }

  /**
   * Новый канал: серверный конец становится соединением матча, ботский
   * возвращается наружу — его сборка отдаёт воркеру transfer'ом.
   */
  open(channel: MessageChannelLike): RawPort {
    const transport = portTransport(shellPort(channel.port1));
    this.opened.push(transport);
    if (this.handler === undefined) this.pending.push(transport);
    else this.handler(transport);
    return channel.port2;
  }

  /** Не `async`: закрытие портов синхронно, а `Promise` требует интерфейс. */
  close(): Promise<void> {
    this.handler = undefined;
    this.pending.length = 0;
    for (const transport of this.opened) transport.close('bot-host-closed');
    this.opened.length = 0;
    return Promise.resolve();
  }
}

/** Один бот в init-сообщении воркера: кто он, каким мозгом и по какому профилю. */
export interface BotWorkerSeat {
  readonly playerId: string;
  readonly brain: BrainKind;
  readonly profile: BotProfile;
}

/**
 * Init-сообщение бот-воркеру — данные, и только данные: фабрику мозга по имени
 * резолвит сам воркер (`brains/registry.ts`), потому что функция через
 * structured clone не ездит, а имя мозга — такой же параметр сборки, как профиль.
 *
 * Сцена едет здесь потому, что контент-пак клиент резолвит локально (`netcode`
 * NET-16): сервер сцену не раздаёт ни человеку, ни боту.
 */
export interface BotWorkerInit {
  readonly t: 'bot-init';
  readonly seats: readonly BotWorkerSeat[];
  /** По порту на бота, в порядке `seats`: соединение на бота, как у людей. */
  readonly ports: readonly RawPort[];
  readonly buildId: string;
  readonly sceneRef: string;
  readonly scene: SceneDef;
  /** Зависимости сборки мира (NTR-14) — те же значения, что у сервера матча. */
  readonly physics?: PhysicsOptions;
  readonly visibility?: VisibilityOptions;
}

/** Узнавание init-сообщения на входе воркера: чужое сообщение — не бот. */
export function isBotWorkerInit(message: unknown): message is BotWorkerInit {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { t?: unknown }).t === 'bot-init'
  );
}

/**
 * Сборка init-сообщения с проверкой парности «бот — порт». Несовпадение здесь
 * даёт бота без канала или порт без бота, и обнаружилось бы оно молчанием
 * посреди матча.
 */
export function botWorkerInit(init: Omit<BotWorkerInit, 't'>): BotWorkerInit {
  if (init.seats.length !== init.ports.length) {
    throw new Error(
      `botWorkerInit: ботов ${init.seats.length}, портов ${init.ports.length} — по порту на бота (BOT-4)`,
    );
  }
  if (init.seats.length === 0) throw new Error('botWorkerInit: ни одного бота');
  return { t: 'bot-init', ...init };
}
