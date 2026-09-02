/**
 * Хостинг бота (BOT-1, BOT-4): бот входит в матч обычным участником — свой
 * `MatchClient` (`netcode-transport` NTR-10), свой слот ростера (`net-session`
 * SES-4), тот же поток сообщений. Ни сервер, ни клиент, ни протокол о боте не
 * знают: специальных сообщений и ветвлений «для бота» здесь нет по построению —
 * всё, что делает этот файл, это соединяет два существующих шва (SES-2).
 *
 * Швы ровно два, и мозг садится на них 1:1 (design D2):
 *
 * - `ClientStep` (выход шага клиента, NTR-15) → `BotBrain.observe`;
 * - `InputSource` (источник ввода клиента, `input-devices` INP-1) →
 *   `BotBrain.sample`.
 *
 * Своего цикла у хостинга нет — есть каденс шага клиента, и мозг к нему
 * пристёгнут. Стоимость мышления на этот каденс не влияет: `sample` синхронен и
 * отдаёт последнее готовое намерение либо ничего (BOT-2), а исполняется весь
 * хост вне потока авторитетного цикла матча (BOT-4) — свойство сборки, не кода.
 *
 * Рантайм-агностичность здесь принципиальна (design D3): хост принимает
 * `Transport`, а не порт и не сокет, поэтому один и тот же код работает во
 * внутрипроцессном транспорте автотеста, в паре портов воркера и в WebSocket
 * (NTR-2). Место исполнения выбирает сборка — `src/worker/`.
 */
import type {
  LocomotionOptions,
  NavigationOptions,
  PhysicsOptions,
  Serializer,
  VisibilityOptions,
} from '@fluxus/core';
import {
  ClientHost,
  MatchClient,
  startPaced,
  type ClientStep,
  type PacedTimer,
  type ConnectionRole,
  type ContentPack,
  type GameVersion,
  type InputSample,
  type Transport,
} from '@fluxus/net';
import type { BotBrain, BotBrainFactory } from './brain.js';
import { toInputSample } from './boundary.js';
import type { BotProfile } from './profile.js';

export interface BotSeatOptions {
  readonly playerId: string;
  /**
   * Роль соединения в слоте (`netcode-transport` NTR-18). Умолчание — владелец:
   * бот-заполнитель (BOT-7) доигрывает матч своим слотом. Заместитель
   * отвалившегося игрока (BOT-14) называет роль явно — и уступает слот
   * вернувшемуся владельцу вытеснением, которое проводит сервер.
   */
  readonly role?: ConnectionRole;
  /** Канал до сервера матча: по транспорту на бота — соединение как у человека (NTR-2). */
  readonly transport: Transport;
  /** Фабрика мозга (BOT-2): хост не знает, какая реализация под контрактом. */
  readonly brain: BotBrainFactory;
  /** Профиль поведения (BOT-6); читает его мозг на конструировании. */
  readonly profile: BotProfile;
  /** Контент-пак клиента: сцену клиент резолвит сам (`netcode` NET-16). */
  readonly content: ContentPack;
  readonly version: GameVersion;
  /** Зависимости сборки мира (NTR-14) — те же, что у клиента человека. */
  readonly physics?: PhysicsOptions;
  /** Как ввод превращается в движение (NTR-14) — наравне с физикой. */
  readonly locomotion?: LocomotionOptions;
  readonly visibility?: VisibilityOptions;
  /**
   * Включение и параметры поиска пути (NTR-14): зависимость сборки наравне с
   * физикой и пересчётом видимости, приезжает из одного описания матча обеим
   * сторонам — иначе предсказание водило бы NPC не там, где сервер.
   */
  readonly navigation?: NavigationOptions;
  readonly interpolationDelayMs?: number;
  readonly serializer?: Serializer;
  readonly now?: () => number;
}

/**
 * Один бот: клиент матча, его хост и мозг за контрактом.
 *
 * Мозг конструируется не в конструкторе, а на первом шаге после `Welcome`
 * (NTR-5): оттуда приезжают обе величины, которые мозг обязан знать о матче, —
 * слот, которым опознаётся своя сущность в персональном снапшоте (`tick-loop`
 * TICK-5), и темп, по которому считается всё, что мозг интегрирует по времени
 * (NTR-7). Ждать их честнее, чем выдумывать: до `Welcome` наблюдать ещё нечего,
 * состояния клиент не отдаёт вовсе.
 *
 * Отсюда же вход в ИДУЩИЙ матч (BOT-14): бот-заместитель начинает не с
 * `worldInit`, а с первого принятого персонального снапшота — потому что мозг
 * и в обычном матче начинает с него же. Ветки «вошёл с середины» здесь нет и
 * не нужно: она была бы вторым способом сделать то, что уже делается одним.
 * Граница честности при этом не сдвигается (BOT-2, BOT-3, NTR-9) — заместитель
 * получает тот же фильтрованный снапшот слота, что получал бы владелец.
 */
export class BotSeat {
  readonly playerId: string;
  readonly client: MatchClient;
  readonly host: ClientHost;

  private readonly transport: Transport;
  private readonly factory: BotBrainFactory;
  private readonly profile: BotProfile;
  private current: BotBrain | undefined;

  constructor(options: BotSeatOptions) {
    this.playerId = options.playerId;
    this.transport = options.transport;
    this.factory = options.brain;
    this.profile = options.profile;
    this.client = new MatchClient({
      playerId: options.playerId,
      version: options.version,
      content: options.content,
      ...(options.role !== undefined ? { role: options.role } : {}),
      ...(options.physics !== undefined ? { physics: options.physics } : {}),
      ...(options.locomotion !== undefined ? { locomotion: options.locomotion } : {}),
      ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
      ...(options.navigation !== undefined ? { navigation: options.navigation } : {}),
      ...(options.interpolationDelayMs !== undefined
        ? { interpolationDelayMs: options.interpolationDelayMs }
        : {}),
    });
    this.host = new ClientHost(this.client, options.transport, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
      // Шов ввода (INP-1): мозг — третий источник рядом со сценарием и
      // клавиатурой, и клиент не отличает его от них.
      input: (tick) => this.sampleInput(tick),
    });
  }

  /** Мозг, если он уже сконструирован. Наблюдательный доступ — для сборки и тестов. */
  get brain(): BotBrain | undefined {
    return this.current;
  }

  /**
   * Бот доиграл: канал закрыт с той или с этой стороны либо клиент закрылся сам
   * (`End`, отказ хендшейка, разрыв). Читается хостом, чтобы остановить темп:
   * тикать мёртвого клиента — работа без потребителя.
   *
   * Вытеснение владельцем (NTR-18) приезжает сюда штатным `Reject` и отпускает
   * канал тем же путём, что всякий отказ: пере-подключаться место не пытается —
   * слот занят владельцем, и решать, что делать дальше, будет сборка-основатель
   * (BOT-14).
   */
  get closed(): boolean {
    return this.transport.isClosed || this.client.phase === 'closed';
  }

  start(): void {
    this.host.start();
  }

  /**
   * Шаг клиента с наблюдением (BOT-3): состояние и факты, доехавшие к этому
   * моменту, уходят мозгу — и ничего, кроме них.
   *
   * Своим шагом, а не `ClientHost.run()`, именно поэтому: собственный таймер
   * клиента зовёт `step()` внутри себя и наблюдаемый выход никому не отдаёт, то
   * есть шов наблюдения на нём не собирается. Каденс от этого не меняется —
   * его задаёт `BotHost.run()` тем же темпом матча.
   */
  step(): ClientStep {
    const step = this.host.step();
    this.ensureBrain()?.observe(step);
    return step;
  }

  /**
   * Уход бота из матча: канал закрывается ЗДЕСЬ и явно.
   *
   * Молча брошенное соединение сервер держал бы до порога молчания слота
   * (NTR-6), подставляя за бота predicted-фреймы, а на портах утёк бы сам порт.
   * Уход человека выглядит для сервера так же — закрытым каналом.
   */
  dispose(): void {
    this.host.stop();
    this.current?.dispose?.();
    this.current = undefined;
    if (!this.transport.isClosed) this.transport.close('bot-disposed');
  }

  /**
   * Съём ввода на тик (BOT-2): синхронный и без ожидания. Мозг, не успевший
   * решить, отдаёт `undefined` — каденс отправки клиента не сбивается, а
   * опоздавшее намерение уедет вводом на более поздний тик, как запоздавший
   * ввод человека (NTR-7).
   *
   * Здесь же и единственная точка ограничения доменов (BOT-5, INP-3): мозг
   * отдаёт намерение, ввод из него делает `toInputSample`. Другого пути от
   * мозга к клиенту нет, поэтому «обойти клампы бот не может» — свойство
   * конструкции, а не договорённости.
   */
  private sampleInput(tick: number): InputSample | undefined {
    const intent = this.ensureBrain()?.sample(tick);
    return intent === undefined ? undefined : toInputSample(intent);
  }

  private ensureBrain(): BotBrain | undefined {
    if (this.current !== undefined) return this.current;
    const slot = this.client.slot;
    const pacing = this.client.pacing;
    // Слот и темп приезжают одним `Welcome` (NTR-5) — потому мозг и строится
    // здесь, а не в конструкторе: до хендшейка обе величины неизвестны, а
    // выдумывать их значило бы дать мозгу неправду о матче.
    if (slot === undefined || pacing === undefined) return undefined;
    // Мозгу передаётся профиль и то, кто он в матче, — и ничего больше (BOT-3):
    // ссылки на мир сервера в этих аргументах нет и появиться ей неоткуда.
    this.current = this.factory(this.profile, {
      playerId: this.playerId,
      slot,
      tickRate: pacing.tickRate,
    });
    return this.current;
  }
}

/**
 * Хост ботов: один процесс (воркер) — сколько угодно ботов (BOT-4). Граница
 * честности проходит по клиенту и его фильтру (BOT-3), а не по воркеру, поэтому
 * десять ботов в одном хосте и десять хостов по боту для сервера неразличимы.
 */
export class BotHost {
  private readonly seatList: BotSeat[] = [];
  private timer: PacedTimer | undefined;
  private timerRate: number | undefined;

  get seats(): readonly BotSeat[] {
    return this.seatList;
  }

  add(options: BotSeatOptions): BotSeat {
    const seat = new BotSeat(options);
    this.seatList.push(seat);
    return seat;
  }

  /** Предъявление версии всеми ботами (NTR-5). */
  start(): void {
    for (const seat of this.seatList) seat.start();
  }

  /**
   * Все ли боты хоста доиграли: матч кончился, каналы закрыты. Пустой хост
   * доигравшим не считается — ботов ему ещё могут добавить.
   */
  get finished(): boolean {
    return this.seatList.length > 0 && this.seatList.every((seat) => seat.closed);
  }

  /** Один шаг всех ботов. Отдельно от `run()`, чтобы тест двигал матч сам (NTR-12). */
  step(): void {
    for (const seat of this.seatList) {
      if (seat.closed) continue;
      seat.step();
    }
  }

  /**
   * Темп матча по данным ПРИНЯТОГО места (NTR-7): `Welcome` приезжает только
   * тому, кого сервер впустил, и место, которому отказали, темпа не знает
   * никогда. Брать первое место списка нельзя по этой самой причине —
   * заполнитель слотов предлагает бота и на слоты, занятые людьми (BOT-7), и
   * первым в списке вполне оказывается отвергнутый: хост навсегда остался бы на
   * запасных 60 Гц, тикая ботов не в темпе матча.
   */
  private get matchRate(): number | undefined {
    for (const seat of this.seatList) {
      const rate = seat.client.pacing?.tickRate;
      if (rate !== undefined) return rate;
    }
    return undefined;
  }

  /** Собственный темп: частота из `Welcome` принятого бота, до него — 60 Гц. */
  run(): void {
    this.ensureTimer(this.matchRate ?? 60);
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.timer.stop();
    this.timer = undefined;
    this.timerRate = undefined;
  }

  dispose(): void {
    this.stop();
    for (const seat of this.seatList) seat.dispose();
    this.seatList.length = 0;
  }

  /**
   * Темп ботов — то же расписание без дрейфа, что у клиентского и серверного
   * хостов (`@fluxus/net`, `startPaced`): бот, отстающий от сервера на процент
   * из-за округления периода, перешагивал бы номера тиков и жил бы на повторе —
   * выглядя лагающим на канале с нулевой задержкой.
   */
  private ensureTimer(rate: number): void {
    if (this.timer !== undefined && this.timerRate === rate) return;
    this.timer?.stop();
    this.timerRate = rate;
    this.timer = startPaced(1000 / rate, () => {
      const actual = this.matchRate;
      if (actual !== undefined && actual !== this.timerRate) this.ensureTimer(actual);
      this.step();
      // Темп ведёт хост, а не `ClientHost.run()` (см. `BotSeat.step`), поэтому
      // и самоостановка клиента на закрытии канала здесь не сработала бы:
      // остановиться обязан тот, кто тикает. Без этого воркер доигравшего матча
      // крутил бы таймер на 60 Гц до конца процесса.
      if (this.finished) this.stop();
    });
  }
}
