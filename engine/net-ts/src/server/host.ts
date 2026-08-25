/**
 * Связка сервера матча с транспортом — тот самый внешний слой, которого нет
 * внутри `MatchServer` (NTR-3). Здесь и только здесь живут сокеты, таймер и
 * системные часы.
 *
 * Один и тот же хост обслуживает внутрипроцессный транспорт в автотесте и
 * WebSocket в живом матче (NTR-12): различается объект, переданный в
 * конструктор, а не код.
 *
 * Здесь же меряются счётчики ХОСТА (NTR-11, решение D9): длительность
 * исполнения тика и broadcast lag — время от конца тика до передачи последнего
 * персонального снапшота в отправку, — а также размер снапшотов по каждому
 * соединению отдельно. Мерить это в `MatchServer` было бы нельзя: цикл и
 * рассылка живут ЗДЕСЬ, а сервер остаётся чистым тиком без часов.
 */
import type { Serializer } from '@fluxus/core';
import { serverCodec, DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import { ProtocolError, type ClientMessage, type ServerMessage } from '../protocol/messages.js';
import {
  transportRtt,
  RTT_UNSUPPORTED,
  type ConnectionId,
  type Transport,
  type TransportRtt,
  type TransportServer,
} from '../transport/transport.js';
import { DurationRing, summarize, type DurationSummary } from './hostMetrics.js';
import type { MatchServer } from './matchServer.js';

/**
 * Сколько записей по-соединениям держать: с запасом на ростер и недавние
 * реконнекты, но конечно — чтобы стенд, живущий сутками и переживающий
 * реконнекты, не копил записи наблюдения без предела.
 */
const CONNECTION_RETENTION = 256;

export interface MatchHostOptions {
  readonly serializer?: Serializer;
  /**
   * Часы хоста в миллисекундах. Инъекция, а не зашитый `performance.now`, по
   * той же причине, по какой её принимает клиентский хост: замер обязан
   * проверяться тестом без ожидания реального времени.
   */
  readonly now?: () => number;
}

/**
 * Наблюдаемые ОДНОГО соединения (NTR-11): размер снапшотов «по каждому
 * соединению отдельно» и круг несущего канала.
 */
export interface ConnectionMetrics {
  readonly id: ConnectionId;
  /** Байты сообщений `Snapshot`, ушедших ИМЕННО этому соединению. */
  readonly snapshotBytes: number;
  /** Байты всех сообщений соединения: снапшоты, поток событий и служебное. */
  readonly bytes: number;
  readonly snapshots: number;
  /** Круг несущего канала либо названное его отсутствие (решение D7). */
  readonly rtt: TransportRtt;
  /**
   * СЕРВЕРНАЯ половина отклика (NTR-11), мс: от прихода кадра ввода до
   * ближайшего персонального снапшота этому соединению. `undefined` — замера ещё
   * не было.
   *
   * Полная величина «нажал → увидел» принадлежит клиенту (`ClientMetrics.
   * inputToVisibleMs`): в неё входят и канал, и буфер задержки ввода, и темп
   * рассылки. Приехать сюда она не может и не должна — сообщения для неё в
   * закрытом наборе нет, и заводить его нельзя (NTR-4). Админу же на вопрос
   * «дорога или сервер» отвечают ровно две наблюдаемые: круг соединения и
   * длительность тика (NTR-11, сценарий «Дорога или сервер»), а эта — их шов.
   *
   * Отметка прихода ПОТРЕБЛЯЕТСЯ первым же снапшотом: иначе у молчащего игрока
   * величина росла бы вместе с молчанием — то самое «время с последнего
   * нажатия», которое NTR-11 объявляет негодной метрикой.
   */
  readonly responseMs: number | undefined;
}

/**
 * Отчёт хоста — то, что уезжает админ-каналу (`server-control` SRV-4).
 * Собирается ПО ЗАПРОСУ: перцентиль считается на чтении, и без читателя эта
 * работа не делается вовсе (решение D9).
 */
export interface HostReport {
  /** Длительность исполнения тика, включая p99 (NTR-11). */
  readonly tick: DurationSummary;
  /** Broadcast lag: от конца тика до передачи последнего снапшота в отправку. */
  readonly broadcast: DurationSummary;
  readonly connections: readonly ConnectionMetrics[];
}

/** Байты, посчитанные хостом по одному соединению. */
interface ConnectionBytes {
  snapshotBytes: number;
  bytes: number;
  snapshots: number;
  /** Отметка прихода кадра ввода, ждущая ближайшего снапшота; `-1` — не ждёт. */
  inputAt: number;
  /** Последняя измеренная серверная половина отклика, мс; `-1` — замеров не было. */
  responseMs: number;
}

export class MatchHost {
  readonly server: MatchServer;

  private readonly transports: TransportServer;
  private readonly codec: Codec<ServerMessage, ClientMessage>;
  private readonly attached = new Map<ConnectionId, Transport>();
  private nextId: ConnectionId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly now: () => number;
  private readonly tickRing = new DurationRing();
  private readonly broadcastRing = new DurationRing();
  /** Отметка конца последнего исполненного тика; `-1` — рассылать нечего. */
  private tickEndedAt = -1;
  /**
   * Байты по соединениям. Живут дольше самого соединения: разорванное
   * соединение остаётся в отчёте своей суммой, иначе «сколько мы отправили
   * этому игроку» пропадало бы ровно в момент, когда админ пришёл разбираться.
   *
   * Но не НАВСЕГДА: `ConnectionId` растёт с каждым принятым сокетом, и в
   * долгоживущем стенде реконнекты копили бы записи без предела (OBS-2 держит
   * замер во внешнем слое, но внешний слой тоже не должен течь). Карта
   * ограничена `CONNECTION_RETENTION`: при переполнении вымываются САМЫЕ СТАРЫЕ
   * УЖЕ ЗАКРЫТЫЕ соединения — живые не трогаются, а недавние закрытые
   * переживают отчёт (проверка «отчёт помнит разорванное соединение»). `Map`
   * хранит порядок вставки, поэтому «самый старый» — это первый ключ.
   */
  private readonly perConnection = new Map<ConnectionId, ConnectionBytes>();

  constructor(server: MatchServer, transports: TransportServer, options: MatchHostOptions = {}) {
    this.server = server;
    this.transports = transports;
    this.codec = serverCodec(options.serializer ?? DEFAULT_SERIALIZER);
    this.now = options.now ?? ((): number => performance.now());
    this.transports.onConnection((transport) => { this.attach(transport); });
  }

  private attach(transport: Transport): void {
    const id = this.nextId++;
    this.attached.set(id, transport);
    this.server.connect(id);

    transport.onMessage((bytes) => {
      try {
        const message = this.codec.decode(bytes);
        // Отметка прихода ВВОДА (NTR-11): от неё считается серверная половина
        // отклика. Ставится до исполнения — «пришёл кадр» есть факт канала, а не
        // факт тика, и тик его не двигает.
        if (message.type === 'Input') this.countedOf(id).inputAt = this.now();
        this.server.receive(id, message);
      } catch (error) {
        // Битый кадр, чужое направление и недопустимое для состояния соединения
        // сообщение — один исход: назвать и разорвать (NTR-4).
        const reason = error instanceof ProtocolError ? error.reason : 'protocol-error';
        this.server.protocolError(id, reason, error instanceof Error ? error.message : String(error));
      }
      this.flush();
    });

    transport.onClose(() => {
      this.attached.delete(id);
      this.server.disconnect(id);
      this.flush();
    });

    this.flush();
  }

  private countedOf(id: ConnectionId): ConnectionBytes {
    const existing = this.perConnection.get(id);
    if (existing !== undefined) return existing;
    const created: ConnectionBytes = {
      snapshotBytes: 0,
      bytes: 0,
      snapshots: 0,
      inputAt: -1,
      responseMs: -1,
    };
    this.perConnection.set(id, created);
    this.evictClosed();
    return created;
  }

  /**
   * Держит карту по-соединениям в пределах `CONNECTION_RETENTION`, вымывая
   * самые старые УЖЕ ЗАКРЫТЫЕ соединения. Живые не удаляются никогда — их байты
   * ещё растут; недавние закрытые остаются, пока есть место.
   */
  private evictClosed(): void {
    if (this.perConnection.size <= CONNECTION_RETENTION) return;
    for (const id of this.perConnection.keys()) {
      if (this.perConnection.size <= CONNECTION_RETENTION) break;
      if (!this.attached.has(id)) this.perConnection.delete(id);
    }
  }

  /** Отправляет накопленные сервером исходящие. Публичен: тесты гоняют матч без таймера. */
  flush(): void {
    /** Отметка последнего снапшота этой рассылки; `-1` — снапшотов не было. */
    let lastSnapshotAt = -1;
    for (const outgoing of this.server.drain()) {
      const transport = this.attached.get(outgoing.to);
      if (transport === undefined) continue;
      const bytes = this.codec.encode(outgoing.message);
      this.server.metrics.bytesSent += bytes.byteLength;
      const counted = this.countedOf(outgoing.to);
      counted.bytes += bytes.byteLength;
      if (outgoing.message.type === 'Snapshot') {
        counted.snapshotBytes += bytes.byteLength;
        counted.snapshots++;
      }
      transport.send(bytes);
      // Отметка берётся ПОСЛЕ передачи в отправку: broadcast lag — это время до
      // передачи последнего персонального снапшота, а не до его формирования.
      if (outgoing.message.type === 'Snapshot') {
        lastSnapshotAt = this.now();
        // Серверная половина отклика (NTR-11): отметка прихода ввода
        // ПОТРЕБЛЯЕТСЯ первым же снапшотом — у молчащего игрока величина иначе
        // росла бы вместе с молчанием.
        if (counted.inputAt >= 0) {
          counted.responseMs = Math.max(0, lastSnapshotAt - counted.inputAt);
          counted.inputAt = -1;
        }
      }
      if (outgoing.closeAfter) {
        this.attached.delete(outgoing.to);
        transport.close(outgoing.message.type === 'Reject' ? outgoing.message.reason : 'match-ended');
      }
    }
    // Отставание рассылки считается один раз на тик — от его конца до
    // ПОСЛЕДНЕГО персонального снапшота: именно последний адресат и определяет,
    // насколько рассылка отстала от симуляции (NTR-11).
    if (lastSnapshotAt >= 0 && this.tickEndedAt >= 0) {
      this.broadcastRing.record(Math.max(0, lastSnapshotAt - this.tickEndedAt));
      this.tickEndedAt = -1;
    }
  }

  /**
   * Принудительно отвязать соединение (`server-control` SRV-5): канал рвётся, и
   * дальше действует штатный реконнект (NTR-17) вместе с политикой замещения
   * сборки-основателя сессии (NTR-18). Кто и чем займёт опустевший слот, здесь
   * не названо и названо быть не может: происхождение арендатора сервер матча
   * не различает вовсе, и слова об этом в его исходниках нет (гейт-тест).
   *
   * Живёт операция ЗДЕСЬ, а не в `MatchServer`, по той же причине, по которой
   * здесь живут сокеты: канал принадлежит хосту (NTR-3), а сервер матча лишь
   * перестаёт числить соединение своим. `MatchServer.disconnect` в одиночку
   * оставил бы сокет открытым — клиент считал бы себя в матче, а сервер молча
   * отбрасывал бы его ввод.
   *
   * Возвращает `false`, если такого соединения хост не держит: отвязывать
   * нечего, и молчаливый «успех» здесь означал бы операцию, которой не было.
   */
  detach(id: ConnectionId, reason = 'admin-detach'): boolean {
    const transport = this.attached.get(id);
    this.attached.delete(id);
    this.server.disconnect(id);
    transport?.close(reason);
    this.flush();
    return transport !== undefined;
  }

  /** Один шаг расписания. Отдельно от `start()`, чтобы тест двигал матч сам. */
  step(): void {
    const startedAt = this.now();
    this.server.advance();
    const endedAt = this.now();
    this.tickRing.record(Math.max(0, endedAt - startedAt));
    this.tickEndedAt = endedAt;
    this.flush();
  }

  /**
   * Счётчики хоста (NTR-11) — СОБИРАЮТСЯ ЗДЕСЬ, на запросе: перцентиль считается
   * по кольцу, и без спрашивающего эта работа не делается (решение D9).
   */
  report(): HostReport {
    const connections: ConnectionMetrics[] = [];
    for (const [id, counted] of this.perConnection) connections.push(this.metricsOf(id, counted));
    return {
      tick: summarize(this.tickRing),
      broadcast: summarize(this.broadcastRing),
      connections,
    };
  }

  /** Наблюдаемые одного соединения; `undefined` — такого соединения хост не видел. */
  connectionMetrics(id: ConnectionId): ConnectionMetrics | undefined {
    const counted = this.perConnection.get(id);
    return counted === undefined ? undefined : this.metricsOf(id, counted);
  }

  private metricsOf(id: ConnectionId, counted: ConnectionBytes): ConnectionMetrics {
    const transport = this.attached.get(id);
    return {
      id,
      snapshotBytes: counted.snapshotBytes,
      bytes: counted.bytes,
      snapshots: counted.snapshots,
      // Круга у закрытого соединения нет и быть не может — отсутствие
      // называется явно, а не нулём (NTR-11).
      rtt: transport === undefined ? RTT_UNSUPPORTED : transportRtt(transport),
      responseMs: counted.responseMs < 0 ? undefined : counted.responseMs,
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    const periodMs = 1000 / this.server.pacing.tickRate;
    this.timer = setInterval(() => { this.step(); }, periodMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.server.stop();
    this.flush();
    await this.transports.close();
  }
}
