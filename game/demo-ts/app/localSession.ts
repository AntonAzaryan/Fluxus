/**
 * Сессия `local` прямо во вкладке (`net-session` SES-1, design D1): авторитетный
 * цикл матча исполняется в том же приложении, что и игрок, — но НЕ вторым путём
 * исполнения. Сервер тот же (`MatchServer`), хост тот же (`MatchHost`), клиент
 * тот же, транспорт настоящий (пара портов, NTR-2 — асинхронная доставка с
 * копированием байтов). Различие с выделенным стендом исчерпывается этим файлом
 * (SES-2), и потому демо ездит ровно тем кодом, что сетевой матч.
 *
 * Второй слот до заморозки ростера держит бот-заполнитель (BOT-7): дедлайн у
 * вкладки нулевой — второго человека здесь не ждут (design D2). Хостится бот
 * своим воркером (BOT-4); чем именно — решает сборка-entry, сюда приезжает
 * `WorkerLike`.
 *
 * Чего здесь нет: ни одной ветки «если local, то…». Сервер о том, что он живёт
 * во вкладке, не знает и знать не может — режим сессии до него не доходит
 * (SES-2).
 */
import type { Serializer } from '@game-mvp/core';
import {
  MatchHost,
  MatchServer,
  createSessionInfo,
  mergeTransportServers,
  type MatchConfig,
  type SessionInfo,
  type TransportServer,
} from '@game-mvp/net';
import {
  BotSlotFiller,
  PortConnections,
  attachBots,
  type BotBehaviorDocument,
  type BotProfile,
  type BotWireFormat,
  type BrainKind,
  type FillSchedule,
  type MessageChannelLike,
  type RawPort,
  type WorkerLike,
} from '@game-mvp/bot';

/**
 * Формат кадра, которым говорит эта сессия (`serialization` SER-3).
 *
 * Выводится из САМОГО сериализатора, а не выбирается вторым решением рядом:
 * формат полем протокола не согласовывается, и сборка, отдавшая серверу один
 * формат, а боту другой, получила бы не отказ, а тишину — `Hello` бота сервер
 * просто не разберёт, и матч навсегда останется в лобби. Незнакомое имя —
 * отказ сборки здесь и сейчас: назвать его боту нечем.
 */
function wireFormatOf(serializer: Serializer | undefined): BotWireFormat | undefined {
  if (serializer === undefined) return undefined;
  if (serializer.name === 'json' || serializer.name === 'msgpack') return serializer.name;
  throw new Error(
    `сессия демо: боту нечем назвать формат "${serializer.name}" — ` +
      'участники матча обязаны говорить одним форматом (SER-3)',
  );
}

/** Сборка бота: где он исполняется и кем является (BOT-2, BOT-4, BOT-6). */
export interface DemoBotAssembly {
  /** Поток ботов: `Worker` вкладки, а в тесте — объект, поднимающий хост у себя. */
  readonly worker: WorkerLike;
  /** Фабрика пары портов среды: `() => new MessageChannel()`. */
  readonly channel: () => MessageChannelLike;
  readonly brain: BrainKind;
  readonly profile: BotProfile;
  /**
   * Документ поведения (BOT-8), который назвал профиль. Необязателен: мозг
   * `scripted` ничего не выбирает, и политики у него нет вовсе.
   */
  readonly behavior?: BotBehaviorDocument;
}

export interface LocalSessionOptions {
  readonly config: MatchConfig;
  /** Слоты, которые основатель держит за своими людьми — за оболочкой вкладки. */
  readonly reserved: readonly string[];
  readonly bots: DemoBotAssembly;
  /** Пауза до заморозки; у вкладки — ноль: второго человека не ждём (D2). */
  readonly botFillMs?: number;
  readonly schedule?: FillSchedule;
  readonly serializer?: Serializer;
  /** Дополнительная слушающая сторона: тесту — loopback, вкладке — ничего. */
  readonly extraTransports?: TransportServer;
}

export class DemoLocalSession {
  /** Наблюдаемость сессии (SES-9): режим и фаза называются, а не выводятся. */
  readonly info: SessionInfo;
  readonly server: MatchServer;
  readonly host: MatchHost;
  readonly filler: BotSlotFiller;

  private readonly connections = new PortConnections();

  constructor(options: LocalSessionOptions) {
    this.server = new MatchServer(options.config);
    const transports =
      options.extraTransports === undefined
        ? this.connections
        : mergeTransportServers(this.connections, options.extraTransports);
    this.host = new MatchHost(this.server, transports, {
      ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
    });
    this.info = createSessionInfo('local', 'in-page');
    this.info.phase = 'lobby';

    const { bots, config } = options;
    const wireFormat = wireFormatOf(options.serializer);
    this.filler = new BotSlotFiller({
      players: config.players,
      reserved: options.reserved,
      deadlineMs: options.botFillMs ?? 0,
      frozen: () => this.server.phase !== 'lobby',
      attach: (playerIds) => {
        attachBots({
          worker: bots.worker,
          connections: this.connections,
          channel: bots.channel,
          seats: playerIds.map((playerId) => ({
            playerId,
            brain: bots.brain,
            profile: bots.profile,
            ...(bots.behavior === undefined ? {} : { behavior: bots.behavior }),
          })),
          buildId: config.version.buildId,
          sceneRef: config.sceneRef,
          scene: config.scene,
          // Тот же формат, который получил `MatchHost` выше: бот — обычный
          // участник, и «формат — свойство сборки» относится к нему наравне с
          // человеком (SER-3).
          ...(wireFormat !== undefined ? { wireFormat } : {}),
          ...(config.physics !== undefined ? { physics: config.physics } : {}),
          ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
        });
        // Места живут в потоке ботов — наблюдать их отсюда нечем (BOT-4).
        return [];
      },
      ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    });
  }

  /**
   * Канал участника: серверный конец уходит матчу обычным соединением, дальний
   * возвращается наружу — его сборка отдаёт клиенту transfer'ом.
   */
  connect(channel: MessageChannelLike): RawPort {
    return this.connections.open(channel);
  }

  /**
   * Запускает расписание матча и отсчёт до заморозки ростера. Порядок значим:
   * дедлайн взводится ПОСЛЕ того, как канал человека уже открыт, — иначе при
   * нулевой паузе бот успел бы предъявить `Hello` первым и занять слот, который
   * основатель держит за собой.
   */
  start(): void {
    this.host.start();
    this.filler.arm();
    this.info.phase = 'match';
  }

  async dispose(): Promise<void> {
    this.info.phase = 'ended';
    this.filler.dispose();
    await this.host.stop();
    // Каналы участников закрываются здесь и явно: порты — ресурс среды, и
    // брошенная пара переживает сессию, держа воркер бота на связи с матчем,
    // которого больше нет. `host.stop()` закрывает ту слушающую сторону,
    // которую ему отдали, — а отдана ему могла быть склейка (`extraTransports`).
    await this.connections.close();
  }
}

export function openLocalSession(options: LocalSessionOptions): DemoLocalSession {
  return new DemoLocalSession(options);
}
