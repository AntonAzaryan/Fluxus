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
 *
 * И здесь же принимается решение об обратном давлении рассылки состояний
 * (NTR-22): персональный снапшот соединению, задолженность отправки которого
 * переросла порог, не кодируется и не уходит вовсе. Решение принадлежит хосту, а
 * не транспорту и не серверу матча: транспорт сообщений не различает (NTR-2), а
 * сервер сокетов не видит (NTR-3).
 */
import type { Serializer } from '@fluxus/core';
import { serverCodec, DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import { ProtocolError, type ClientMessage, type ServerMessage } from '../protocol/messages.js';
import {
  transportBacklog,
  transportRtt,
  BACKLOG_UNSUPPORTED,
  RTT_UNSUPPORTED,
  type ConnectionId,
  type Transport,
  type TransportBacklog,
  type TransportRtt,
  type TransportServer,
} from '../transport/transport.js';
import { startPaced, type PacedTimer } from '../schedule.js';
import { DurationRing, summarize, type DurationSummary } from './hostMetrics.js';
import type { MatchServer, Outgoing } from './matchServer.js';

/**
 * Сколько записей по-соединениям держать: с запасом на ростер и недавние
 * реконнекты, но конечно — чтобы стенд, живущий сутками и переживающий
 * реконнекты, не копил записи наблюдения без предела.
 */
const CONNECTION_RETENTION = 256;

/**
 * Сколько персональных снапшотов вправе ждать в очереди отправки соединения,
 * пока хост не начнёт их пропускать (NTR-22, решение D2).
 *
 * Умолчание — не константа поведения, а величина сборки (`MatchHostOptions.
 * maxQueuedSnapshots`): порог — предмет замера, как `tickRate` и `inputWindow`.
 * Два — потому что очередь длиннее двух рассылок означает канал, отставший
 * больше чем на два периода рассылки, и следующая рассылка только удлинит хвост.
 */
const DEFAULT_MAX_QUEUED_SNAPSHOTS = 2;

export interface MatchHostOptions {
  readonly serializer?: Serializer;
  /**
   * Часы хоста в миллисекундах. Инъекция, а не зашитый `performance.now`, по
   * той же причине, по какой её принимает клиентский хост: замер обязан
   * проверяться тестом без ожидания реального времени.
   */
  readonly now?: () => number;
  /**
   * Порог обратного давления рассылки состояний (NTR-22): сколько персональных
   * снапшотов вправе ждать в очереди отправки соединения. Умолчание —
   * `DEFAULT_MAX_QUEUED_SNAPSHOTS`; `Infinity` выключает пропуск целиком.
   *
   * Единица — снапшоты, а не байты и не миллисекунды: величина не зависит от
   * машины и следует за размером снапшота, который у каждого соединения свой
   * (фильтр видимости, NTR-3). Порог в байтах пришлось бы подбирать под сцену,
   * порог в миллисекундах — под скорость канала, которой хост не знает.
   */
  readonly maxQueuedSnapshots?: number;
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
  /**
   * Снапшоты, НЕ отправленные этому соединению из-за его очереди (NTR-22): «канал
   * узкий» — третий ответ на вопрос «дорога, сервер или канал» рядом с кругом и
   * длительностью тика (NTR-11).
   */
  readonly snapshotsSkipped: number;
  /** Круг несущего канала либо названное его отсутствие (решение D7). */
  readonly rtt: TransportRtt;
  /**
   * Задолженность отправки несущего канала либо названное её отсутствие
   * (NTR-22): та самая очередь, по которой принято решение о пропуске. Ноль —
   * пустая очередь здорового канала, и с «очереди не видно» его путать нельзя.
   */
  readonly backlog: TransportBacklog;
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
  /** Снапшоты, пропущенные рассылкой из-за очереди отправки (NTR-22). */
  snapshotsSkipped: number;
  /**
   * Размер ПОСЛЕДНЕГО ушедшего этому соединению снапшота, байты; `0` — снапшотов
   * ещё не было. Им и меряется очередь (NTR-22): порог назван в снапшотах, а
   * размер снапшота у каждого соединения свой.
   */
  lastSnapshotBytes: number;
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
  private timer: PacedTimer | undefined;

  private readonly now: () => number;
  /** Порог обратного давления рассылки (NTR-22); `Infinity` — пропуска нет. */
  private readonly maxQueuedSnapshots: number;
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
    this.maxQueuedSnapshots = options.maxQueuedSnapshots ?? DEFAULT_MAX_QUEUED_SNAPSHOTS;
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
      snapshotsSkipped: 0,
      lastSnapshotBytes: 0,
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
      const snapshotAt = this.sendOutgoing(outgoing, transport);
      if (snapshotAt >= 0) lastSnapshotAt = snapshotAt;
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
   * Отправка одного исходящего своему соединению вместе с его учётом (NTR-11) —
   * либо ПРОПУСК персонального снапшота, если очередь соединения переросла порог
   * (NTR-22, см. `skipsSnapshot`).
   *
   * Возвращает отметку времени переданного персонального снапшота либо `-1` —
   * когда исходящее снапшотом не было ЛИБО снапшот пропущен: broadcast lag мерит
   * передачу последнего УШЕДШЕГО снапшота, а пропущенный не уходил.
   */
  private sendOutgoing(outgoing: Outgoing, transport: Transport): number {
    const counted = this.countedOf(outgoing.to);
    const isSnapshot = outgoing.message.type === 'Snapshot';
    // Решение о пропуске принимается ДО кодирования: пропущенный снапшот не
    // сериализуется вовсе — иначе узкий канал стоил бы серверу той же работы,
    // что широкий (NTR-22).
    if (isSnapshot && this.skipsSnapshot(transport, counted)) {
      counted.snapshotsSkipped++;
      // Ни байтов, ни счётчика снапшотов, ни отставания рассылки: пропущенный
      // снапшот не уходил, а broadcast lag мерит передачу ПОСЛЕДНЕГО ушедшего.
      return -1;
    }
    const bytes = this.codec.encode(outgoing.message);
    this.server.metrics.bytesSent += bytes.byteLength;
    counted.bytes += bytes.byteLength;
    if (isSnapshot) {
      counted.snapshotBytes += bytes.byteLength;
      counted.snapshots++;
      counted.lastSnapshotBytes = bytes.byteLength;
    }
    transport.send(bytes);
    // Отметка берётся ПОСЛЕ передачи в отправку: broadcast lag — это время до
    // передачи последнего персонального снапшота, а не до его формирования.
    let snapshotAt = -1;
    if (isSnapshot) {
      snapshotAt = this.now();
      // Серверная половина отклика (NTR-11): отметка прихода ввода
      // ПОТРЕБЛЯЕТСЯ первым же снапшотом — у молчащего игрока величина иначе
      // росла бы вместе с молчанием.
      if (counted.inputAt >= 0) {
        counted.responseMs = Math.max(0, snapshotAt - counted.inputAt);
        counted.inputAt = -1;
      }
    }
    if (outgoing.closeAfter) {
      this.attached.delete(outgoing.to);
      transport.close(outgoing.message.type === 'Reject' ? outgoing.message.reason : 'match-ended');
    }
    return snapshotAt;
  }

  /**
   * Обратное давление рассылки состояний (NTR-22): пропустить ли очередной
   * персональный снапшот этому соединению.
   *
   * Основание пропуска — самодостаточность снапшота (NTR-2, NTR-10): состояние
   * несёт свой тик, и следующее заменяет пропущенное целиком, тогда как очередь,
   * растущая без предела, означает канал, который поток состояний не тянет.
   * Пропускается ТОЛЬКО `Snapshot` (решение D3): хендшейк доставляется надёжно
   * (NTR-5), `Events` избыточен сам (NTR-15) и мал, `Pause` и `End` единичны и
   * решающи.
   */
  private skipsSnapshot(transport: Transport, counted: ConnectionBytes): boolean {
    // Первый снапшот соединению не пропускается никогда: пока размер снапшота
    // ИМЕННО ЭТОМУ соединению неизвестен, мерить очередь нечем, а клиент без
    // первого состояния не начинает вовсе (NTR-22).
    if (counted.lastSnapshotBytes === 0) return false;
    // Порог — величина сборки, и `Infinity` выключает политику целиком.
    if (this.maxQueuedSnapshots === Number.POSITIVE_INFINITY) return false;
    const backlog = transportBacklog(transport);
    // Очередь несущим каналом не показана: пропуск по неизвестной очереди был бы
    // пропуском по догадке (NTR-22).
    if (backlog.kind !== 'measured') return false;
    return backlog.bytes >= this.maxQueuedSnapshots * counted.lastSnapshotBytes;
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

  /**
   * Запереть слот (NTR-19) и снять запирание — с рассылкой, как `detach`.
   *
   * Здесь, а не только в `MatchServer`, ровно по той же причине: `bar` кладёт
   * исход владельцу в исходящее, а закрывает канал ХОЗЯИН канала — хост (NTR-3).
   * Оставь рассылку на совести вызывающего — и запертый клиент считал бы себя в
   * матче, пока кто-нибудь не сделает следующий шаг расписания.
   */
  bar(slot: number): void {
    this.server.bar(slot);
    this.flush();
  }

  unbar(slot: number): void {
    this.server.unbar(slot);
    this.flush();
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
      snapshotsSkipped: counted.snapshotsSkipped,
      // Круга у закрытого соединения нет и быть не может — отсутствие
      // называется явно, а не нулём (NTR-11).
      rtt: transport === undefined ? RTT_UNSUPPORTED : transportRtt(transport),
      // Очереди у закрытого соединения нет по той же причине и с тем же
      // правилом явного отсутствия (NTR-22): нулём её изобразить нельзя — ноль
      // означал бы здоровый пустой канал.
      backlog: transport === undefined ? BACKLOG_UNSUPPORTED : transportBacklog(transport),
      responseMs: counted.responseMs < 0 ? undefined : counted.responseMs,
    };
  }

  /**
   * Фиксированное расписание `tickRate` (NTR-7) — без дрейфа: шаги отсчитываются
   * от точки старта, а не от предыдущего срабатывания (`schedule.ts`). Голый
   * `setInterval(1000 / 60)` давал 61–62 Гц: период округляется до целых
   * миллисекунд, и матч шёл быстрее собственного темпа.
   */
  start(): void {
    if (this.timer !== undefined) return;
    const periodMs = 1000 / this.server.pacing.tickRate;
    this.timer = startPaced(periodMs, () => { this.step(); });
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.timer.stop();
      this.timer = undefined;
    }
    this.server.stop();
    this.flush();
    await this.transports.close();
  }
}
