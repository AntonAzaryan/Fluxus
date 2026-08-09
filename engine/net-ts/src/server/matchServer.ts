/**
 * Авторитетный сервер матча (NTR-3): владеет симуляцией, принимает разобранные
 * сообщения, отдаёт адресованные исходящие — и не делает ввода-вывода.
 *
 * Ни сокетов, ни таймеров, ни системных часов внутри: расписание держит
 * драйвер снаружи и зовёт `advance()`. Это не стилистика, а условие
 * проверяемости — сервер, который сам зовёт таймер, тестируется только
 * ожиданием реального времени или подменой таймеров, а сервер, которому тик
 * продвигают вызовом, тестируется как функция. В автотесте и в живом матче
 * исполняется один и тот же код (NTR-12).
 */
import {
  dispatch,
  filterSnapshot,
  snapshotToPlain,
  tick as advanceTick,
  VIEWPOINT_ALL,
  type EventVisibility,
  type InputFrame,
  type LocomotionOptions,
  type PhysicsOptions,
  type ScenarioDef,
  type ScenarioSpawn,
  type SceneDef,
  type Snapshot,
  type TickObserver,
  type VisibilityOptions,
} from '@game-mvp/core';
import { buildMatchWorld } from '../match/world.js';
import { createServerMetrics, type ServerMetrics } from '../metrics.js';
import type { ConnectionId } from '../transport/transport.js';
import type {
  ClientMessage,
  GameVersion,
  Pacing,
  RejectReason,
  ServerMessage,
  WireInput,
} from '../protocol/messages.js';
import { toInputFrame } from '../protocol/messages.js';

export interface MatchConfig {
  /** Версия матча — версия серверной сборки (NET-16). */
  readonly version: GameVersion;
  /** Слоты: индекс в списке и есть слот (TICK-5). Число слотов — величина конфига, не константа (NTR-6). */
  readonly players: readonly string[];
  readonly seed: number;
  /** Ссылка на сцену в контент-паке. Содержимое сцены клиенту не уходит (NET-16). */
  readonly sceneRef: string;
  readonly scene: SceneDef;
  readonly initial?: readonly ScenarioSpawn[];
  readonly name?: string;
  /**
   * `viewpoint` слота (NET-12). По умолчанию — сам слот: в FFA каждый игрок сам
   * себе команда. Умолчание безопасное: сцена без тумана даёт пустой запрос
   * видимости, и фильтр не режет ничего, а сцена с туманом режет по своей
   * команде. Умолчания «всё видно» здесь быть не может — это wallhack по
   * невнимательности.
   */
  readonly teams?: readonly number[];
  readonly tickRate?: number;
  readonly snapshotRate?: number;
  readonly inputDelay?: number;
  /**
   * Верхняя граница окна приёма ввода в тиках (NTR-7). Механизм — конечность
   * границы, политика — само число: без неё размер буфера неприменённого ввода
   * на слот задаёт клиент, а не конфиг матча. Не меньше `inputDelay`, иначе
   * корректно помеченный клиентом кадр не проходит проверку сервера.
   */
  readonly inputWindow?: number;
  /** Порог молчания слота в тиках; по умолчанию 10 секунд при текущем `tickRate`. */
  readonly silenceTicks?: number;
  readonly allowObserver?: boolean;
  readonly physics?: PhysicsOptions;
  readonly locomotion?: LocomotionOptions;
  readonly visibility?: VisibilityOptions;
  /** Политика видимости событий (NET-13) — параметр, а не зашитое решение (NTR-9). */
  readonly eventVisibility?: EventVisibility;
  readonly observers?: readonly TickObserver[];
}

export type MatchPhase = 'lobby' | 'running' | 'ended';

/** Исходящее: сообщение конкретному соединению и признак «после этого закрыть». */
export interface Outgoing {
  readonly to: ConnectionId;
  readonly message: ServerMessage;
  readonly closeAfter: boolean;
}

type ConnectionPhase = 'greeting' | 'player' | 'observer';

interface Connection {
  readonly id: ConnectionId;
  phase: ConnectionPhase;
  /** Слот игрока; у наблюдателя — `-1`. */
  slot: number;
}

const DEFAULTS = {
  tickRate: 60,
  snapshotRate: 30,
  inputDelay: 2,
  /** Четверть секунды при 60 Гц (NTR-7): больше половины круга на играбельном канале и всё же конечная величина. */
  inputWindow: 15,
  silenceSeconds: 10,
} as const;

export class MatchServer {
  readonly config: MatchConfig;
  readonly worldInitHash: string;
  readonly metrics: ServerMetrics;

  private readonly tickRate: number;
  private readonly snapshotRate: number;
  private readonly snapshotEvery: number;
  private readonly inputDelay: number;
  private readonly inputWindow: number;
  private readonly silenceTicks: number;
  private readonly maxLead: number;

  private readonly sim: ReturnType<typeof buildMatchWorld>['sim'];
  private readonly state: ReturnType<typeof buildMatchWorld>['state'];

  private readonly connections = new Map<ConnectionId, Connection>();
  /** Соединение, занимающее слот; `undefined` — слот свободен либо игрок отвалился. */
  private readonly slotConnection: (ConnectionId | undefined)[];
  private readonly slotClaimed: boolean[];
  /** Пришедший, но ещё не исполненный ввод: слот → тик → кадр. */
  private readonly pending: Map<number, InputFrame>[];
  private readonly lastFrame: (InputFrame | undefined)[];

  private readonly canonical: InputFrame[] = [];
  private readonly outbox: Outgoing[] = [];
  private matchPhase: MatchPhase = 'lobby';

  /**
   * Пара `(эпоха, тик)` последнего разосланного авторитетного состояния
   * (NTR-16). Эпоха выводится из самой последовательности состояний, а не из
   * наблюдения за переходами машины состояний мира: вход в `Rewinding` номера
   * тика не двигает, а одно `seekTo` даёт до десятка восстановлений.
   */
  private currentEpoch = 0;
  /** `-1` — не разослано ещё ничего, и сравнивать не с чем. */
  private lastBroadcastTick = -1;

  constructor(config: MatchConfig) {
    if (config.players.length === 0) throw new Error('MatchConfig: нужен хотя бы один слот');
    if (new Set(config.players).size !== config.players.length) {
      throw new Error('MatchConfig: игрок указан дважды');
    }
    // `viewpoint` игрока обязан быть номером команды (FOW-2, `[0, 31]`).
    // Проверяется, а не подразумевается: `VIEWPOINT_ALL` — это -1, и конфиг с
    // отрицательным номером команды выдал бы игроку поток без фильтрации, то
    // есть ровно то, что NTR-9 запрещает «ни при каких условиях».
    config.teams?.forEach((team, slot) => {
      if (!Number.isInteger(team) || team < 0 || team > 31) {
        throw new Error(`MatchConfig: команда слота ${slot} вне диапазона [0, 31] (FOW-2): ${team}`);
      }
    });
    this.config = config;
    this.tickRate = config.tickRate ?? DEFAULTS.tickRate;
    this.snapshotRate = config.snapshotRate ?? DEFAULTS.snapshotRate;
    // Кратность — не придирка: при некратной частоте интервал между рассылками
    // плавал бы от тика к тику, и замер отклика мерил бы дрожание расписания.
    if (this.tickRate % this.snapshotRate !== 0) {
      throw new Error(
        `MatchConfig: snapshotRate (${this.snapshotRate}) не делит tickRate (${this.tickRate}) нацело`,
      );
    }
    this.snapshotEvery = this.tickRate / this.snapshotRate;
    this.inputDelay = config.inputDelay ?? DEFAULTS.inputDelay;
    this.inputWindow = config.inputWindow ?? DEFAULTS.inputWindow;
    // Окно уже запаса задержки означало бы, что сервер отвергает собственную
    // разметку: клиент помечает кадр тиком `serverTick + inputDelay` по тому же
    // конфигу, который прислал сервер (NTR-7).
    if (this.inputWindow < this.inputDelay) {
      throw new Error(
        `MatchConfig: inputWindow (${this.inputWindow}) меньше inputDelay (${this.inputDelay})`,
      );
    }
    this.silenceTicks = config.silenceTicks ?? this.tickRate * DEFAULTS.silenceSeconds;
    // Окно приёма: запас задержки плюс секунда. Кадр дальше него — не опоздание
    // и не спешка, а рассинхронизация оценки тика либо мусор, и молча копить его
    // в памяти нельзя.
    this.maxLead = this.inputDelay + this.tickRate;

    const built = buildMatchWorld({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.locomotion !== undefined ? { locomotion: config.locomotion } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
    });
    this.sim = built.sim;
    this.state = built.state;
    this.worldInitHash = built.worldInitHash;

    const slots = config.players.length;
    this.metrics = createServerMetrics(slots);
    this.slotConnection = Array.from({ length: slots }, () => undefined);
    this.slotClaimed = Array.from({ length: slots }, () => false);
    this.pending = Array.from({ length: slots }, () => new Map<number, InputFrame>());
    this.lastFrame = Array.from({ length: slots }, () => undefined);
  }

  get tick(): number {
    return this.state.tick;
  }

  /** Текущая эпоха матча (NTR-16): в мир она не попадает и живёт только здесь. */
  get epoch(): number {
    return this.currentEpoch;
  }

  /** Расписание матча. Читает драйвер — он держит темп, сервер часов не знает (NTR-3). */
  get pacing(): Pacing {
    return {
      tickRate: this.tickRate,
      snapshotRate: this.snapshotRate,
      inputDelay: this.inputDelay,
      inputWindow: this.inputWindow,
    };
  }

  get phase(): MatchPhase {
    return this.matchPhase;
  }

  /** Канонический ввод матча, включая predicted-кадры (NTR-8). */
  get canonicalInputs(): readonly InputFrame[] {
    return this.canonical;
  }

  /**
   * Полное состояние матча копией — вход проверки парности (NTR-8) и дебага.
   * Копия, а не ссылка: наружу канонический мир не отдаётся, его читает только
   * сам сервер (NET-12).
   */
  snapshot(viewpoint: number = VIEWPOINT_ALL): Snapshot {
    return filterSnapshot(this.state, viewpoint);
  }

  // ------------------------------------------------------------- соединения

  connect(id: ConnectionId): void {
    if (this.connections.has(id)) throw new Error(`MatchServer: соединение ${id} уже зарегистрировано`);
    this.connections.set(id, { id, phase: 'greeting', slot: -1 });
  }

  disconnect(id: ConnectionId): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    if (connection.slot < 0) return;
    this.slotConnection[connection.slot] = undefined;
    // До старта слот освобождается — состав ещё не зафиксирован. После старта
    // он остаётся за игроком (NTR-6): матч продолжается на predicted-кадрах, и
    // занять чужой слот посреди матча нельзя.
    if (this.matchPhase === 'lobby') this.slotClaimed[connection.slot] = false;
  }

  /** Разбор кадра не удался либо сообщение недопустимо — исход называется, соединение рвётся (NTR-4). */
  protocolError(id: ConnectionId, reason: RejectReason, detail: string): void {
    this.metrics.rejectedMessages++;
    this.reject(id, reason, detail);
  }

  receive(id: ConnectionId, message: ClientMessage): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;

    switch (message.type) {
      case 'Hello':
        if (connection.phase !== 'greeting') {
          this.protocolError(id, 'protocol-error', 'повторный Hello в установленном соединении');
          return;
        }
        this.greet(connection, message.playerId, message.version, message.observer);
        return;
      case 'Input':
        if (connection.phase !== 'player') {
          this.protocolError(id, 'protocol-error', 'ввод от соединения без игрового слота');
          return;
        }
        this.ingest(connection.slot, message.frames);
        return;
      case 'Bye':
        // Осознанный уход отличается от разрыва канала: игрок сообщил намерение,
        // и ждать порога молчания незачем (NTR-6).
        this.disconnect(id);
        if (this.matchPhase === 'running') this.end('player-left');
        return;
    }
  }

  private greet(
    connection: Connection,
    playerId: string,
    version: GameVersion,
    observer: boolean,
  ): void {
    // Сверка версии — до того, как о матче сообщено что-либо (NTR-5). Половина
    // называется отдельно: «обновить сборку» и «обновить контент» — разные
    // действия игрока (NET-16).
    if (version.buildId !== this.config.version.buildId) {
      this.reject(connection.id, 'build-mismatch', `версия сборки матча: ${this.config.version.buildId}`);
      return;
    }
    if (version.contentPackHash !== this.config.version.contentPackHash) {
      this.reject(
        connection.id,
        'content-mismatch',
        `хеш контент-пака матча: ${this.config.version.contentPackHash}`,
      );
      return;
    }

    if (observer) {
      if (this.config.allowObserver !== true) {
        this.reject(connection.id, 'observer-not-allowed', 'сервер запущен без разрешения на наблюдателя');
        return;
      }
      connection.phase = 'observer';
      // Наблюдателю слот не выдаётся, поэтому и `Welcome` со слотом ему не
      // адресован: он не игрок, состава матча не занимает и `Start` дождётся
      // вместе со всеми.
      return;
    }

    const slot = this.config.players.indexOf(playerId);
    if (slot < 0) {
      this.reject(connection.id, 'unknown-player', `игрок "${playerId}" не заявлен в матче`);
      return;
    }
    if (this.matchPhase !== 'lobby') {
      // Реконнекта в MVP нет, и отсутствует он явно, а не молчанием (NTR-6).
      this.reject(connection.id, 'match-in-progress', 'матч уже идёт, реконнект не поддержан');
      return;
    }
    if (this.slotClaimed[slot] === true) {
      this.reject(connection.id, 'slot-taken', `слот ${slot} уже занят`);
      return;
    }

    connection.phase = 'player';
    connection.slot = slot;
    this.slotClaimed[slot] = true;
    this.slotConnection[slot] = connection.id;

    this.send(connection.id, {
      type: 'Welcome',
      slot,
      players: this.config.players,
      seed: this.config.seed,
      match: { sceneRef: this.config.sceneRef, initial: this.config.initial ?? [] },
      worldInitHash: this.worldInitHash,
      pacing: this.pacing,
    });

    if (this.slotClaimed.every(Boolean)) this.start();
  }

  private start(): void {
    this.matchPhase = 'running';
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      this.send(connection.id, { type: 'Start', tick: this.state.tick });
    }
  }

  private ingest(slot: number, frames: readonly WireInput[]): void {
    const counters = this.metrics.slots[slot]!;
    const pending = this.pending[slot]!;
    const playerId = this.config.players[slot]!;
    for (const wire of frames) {
      if (wire.tick <= this.state.tick) {
        // Мир назад не переигрывается (NET-1). Отброс наблюдаем, потому что
        // «ввод теряется» и «ввод ощущается вяло» — разные дефекты (NTR-7).
        counters.late++;
        continue;
      }
      if (wire.tick > this.state.tick + this.maxLead) {
        counters.outOfWindow++;
        continue;
      }
      pending.set(wire.tick, toInputFrame(wire, playerId, wire.tick));
    }
  }

  // ------------------------------------------------------------------- тик

  /**
   * Один тик матча. Вне `running` — no-op: до заполнения слотов мир стоит на
   * `worldInit` (NTR-6), после конца матча двигать нечего.
   */
  advance(): void {
    if (this.matchPhase !== 'running') return;

    const tick = this.state.tick + 1;
    const frames: InputFrame[] = [];
    for (let slot = 0; slot < this.config.players.length; slot++) {
      frames.push(this.frameFor(slot, tick));
    }
    // Канонический лог пишется до тика: он и есть вход, который потом
    // прогоняется через `runScenario` (NTR-8).
    this.canonical.push(...frames);

    const result = advanceTick(this.sim, this.state, frames);
    dispatch(result, this.config.observers ?? []);

    if (tick % this.snapshotEvery === 0) this.broadcastSnapshots(tick);

    for (let slot = 0; slot < this.config.players.length; slot++) {
      if (this.metrics.slots[slot]!.silentTicks > this.silenceTicks) {
        this.end('player-silent');
        return;
      }
    }
  }

  private frameFor(slot: number, tick: number): InputFrame {
    const counters = this.metrics.slots[slot]!;
    const pending = this.pending[slot]!;
    const arrived = pending.get(tick);
    if (arrived !== undefined) {
      pending.delete(tick);
      this.lastFrame[slot] = arrived;
      counters.applied++;
      counters.silentTicks = 0;
      return arrived;
    }

    counters.predicted++;
    counters.silentTicks++;
    const last = this.lastFrame[slot];
    const playerId = this.config.players[slot]!;
    // Повтор последнего (TICK-2). До первого кадра повторять нечего — нулевой
    // ввод, а не отсутствие ввода: слот обязан присутствовать в каноническом
    // логе на каждом тике, иначе запись перестаёт быть воспроизводимой.
    if (last === undefined) {
      return { tick, playerId, seq: 0, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 };
    }
    return { ...last, tick };
  }

  /**
   * Тик исполнен один раз, снапшотов — по числу соединений (NET-12).
   *
   * ponytail: фильтрация зовётся на каждое соединение отдельно, даже когда у
   * двух совпадает `viewpoint`, и каждый вызов копирует мир целиком. На двух
   * игроках это две копии на рассылку; кэш по `viewpoint` и delta-компрессия
   * (NET-8) вводятся тогда, когда замер на десяти игроках покажет упор — это
   * ровно тот профиль нагрузки, который спека netcode просит замерить.
   */
  private broadcastSnapshots(tick: number): void {
    // Единственное место, где эпоха увеличивается (NTR-16). Правило —
    // «тик очередного авторитетного состояния меньше тика предыдущего», и оно
    // применяется здесь потому, что здесь формируется рассылка: любой будущий
    // источник состояния (рассылка по факту восстановления во время
    // `Rewinding`) проходит через эту же точку и второй нумерации не заводит.
    if (this.lastBroadcastTick >= 0 && tick < this.lastBroadcastTick) this.currentEpoch++;
    this.lastBroadcastTick = tick;
    const epoch = this.currentEpoch;

    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      const viewpoint =
        connection.phase === 'observer'
          ? VIEWPOINT_ALL
          : (this.config.teams?.[connection.slot] ?? connection.slot);
      const filtered =
        this.config.eventVisibility === undefined
          ? filterSnapshot(this.state, viewpoint)
          : filterSnapshot(this.state, viewpoint, this.config.eventVisibility);
      this.send(connection.id, { type: 'Snapshot', epoch, tick, snapshot: snapshotToPlain(filtered) });
      this.metrics.snapshotsSent++;
    }
  }

  private end(reason: 'player-silent' | 'player-left' | 'server-stopped'): void {
    if (this.matchPhase === 'ended') return;
    this.matchPhase = 'ended';
    for (const connection of this.connections.values()) {
      if (connection.phase === 'greeting') continue;
      this.send(connection.id, { type: 'End', reason, tick: this.state.tick }, true);
    }
  }

  /** Внешняя остановка — драйвером, а не по внутреннему условию. */
  stop(): void {
    this.end('server-stopped');
  }

  // -------------------------------------------------------------- исходящие

  private send(to: ConnectionId, message: ServerMessage, closeAfter = false): void {
    this.outbox.push({ to, message, closeAfter });
  }

  private reject(to: ConnectionId, reason: RejectReason, detail: string): void {
    this.send(to, { type: 'Reject', reason, detail }, true);
    this.connections.delete(to);
  }

  /** Забрать накопленные исходящие. Отправляет их транспортный слой (NTR-3). */
  drain(): Outgoing[] {
    if (this.outbox.length === 0) return [];
    return this.outbox.splice(0, this.outbox.length);
  }

  /**
   * Матч как сценарий прогона (NTR-8): та же тройка, что принимает
   * `runScenario` ядра. Прогон обязан дать побитово то же состояние — это и
   * есть доказательство, что сетевой слой не сломал детерминизм.
   */
  toScenario(): ScenarioDef {
    return {
      name: this.config.name ?? 'match',
      seed: this.config.seed,
      ticks: this.state.tick,
      scene: this.config.scene,
      initial: this.config.initial ?? [],
      inputs: this.canonical,
      players: this.config.players,
      ...(this.config.physics !== undefined ? { physics: this.config.physics } : {}),
      ...(this.config.locomotion !== undefined ? { locomotion: this.config.locomotion } : {}),
      ...(this.config.visibility !== undefined ? { visibility: this.config.visibility } : {}),
    };
  }
}
