/**
 * Клиент матча (NTR-10): шлёт ввод, применяет authoritative-снапшоты, ничего не
 * симулирует. `tick()` отсюда не вызывается — предсказания в MVP нет.
 *
 * Как и сервер, это чистый цикл без ввода-вывода: сообщения приходят вызовом,
 * исходящие забираются `drain()`, момент времени приезжает аргументом. Часов
 * внутри нет по той же причине, что у сервера, — иначе матч не прогнать в тесте.
 *
 * Шов под предсказание (NET-2/4/5) держится двумя вещами, и обе нужны уже
 * сейчас: кольцо своих кадров (метрика отклика) и локально поднятый `worldInit`
 * (сверка хешей, NTR-5). Включение предсказания добавит цикл симуляции, а
 * протокол не тронет: клиент с предсказанием и без для сервера неразличимы,
 * потому что оба шлют только ввод (NET-7).
 */
import {
  query,
  snapshotFromPlain,
  world as coreWorld,
  type ComponentSchema,
  type EntityId,
  type Fixed,
  type InputFrame,
  type PhysicsOptions,
  type PlainSnapshot,
  type SceneDef,
  type Snapshot,
  type Vec2,
  type VisibilityOptions,
  type WorldState,
} from '@game-mvp/core';
import { buildMatchWorld, orderedSchemas } from '../match/world.js';
import { createClientMetrics, recordInputToVisible, type ClientMetrics } from '../metrics.js';
import { InputRing, DEFAULT_RING_TICKS } from './inputRing.js';
import {
  InterpolationBuffer,
  type InterpolationSample,
  type PresentedState,
} from './interpolation.js';
import type {
  ClientCloseReason,
  ClientMessage,
  EventBatch,
  EventsMessage,
  GameVersion,
  MatchDescriptor,
  Pacing,
  ServerMessage,
  WireSnapshot,
} from '../protocol/messages.js';

/** Контент-пак клиента: сцена резолвится по ссылке локально — сервер её не раздаёт (NET-16). */
export interface ContentPack {
  scene(sceneRef: string): SceneDef | undefined;
}

export interface MatchClientOptions {
  readonly playerId: string;
  readonly version: GameVersion;
  readonly content: ContentPack;
  readonly observer?: boolean;
  /** Зависимости сборки (DI-3): приезжают со сборкой клиента, а не с провода. */
  readonly physics?: PhysicsOptions;
  readonly visibility?: VisibilityOptions;
  readonly inputRingTicks?: number;
  readonly interpolationDelayMs?: number;
  /** Имена компонентов ввода и слота — параметры `InputSystem` (TICK-4), не конвенция ядра. */
  readonly playerComponent?: string;
  readonly slotField?: string;
  readonly inputComponent?: string;
}

export interface InputSample {
  readonly move: Vec2;
  readonly aimDir: Fixed;
  readonly buttons: number;
}

/**
 * Доставка состояния рендеру: пара снапшотов с долей между ними (NET-3) плюс
 * признак разрыва непрерывности.
 *
 * Признак едет ИМЕННО здесь, а не рядом отдельным вызовом: «Признаки разрыва
 * непрерывности (rewind/replay, смена режима мира) SHALL передаваться в
 * доставке состояния» (`client-shell` SHELL-7). Состояние и указание рисовать
 * его snap'ом обязаны приезжать вместе, иначе между чтением одного и другого
 * появляется окно, в котором рендер уже знает новое состояние, но ещё не знает,
 * что интерполировать к нему нечего (REND-2).
 */
export interface MatchSample extends InterpolationSample {
  /** Состояние принадлежит другой ветви истории — рисовать snap'ом (SHELL-7, NTR-10). */
  readonly discontinuity: boolean;
}

/**
 * Факты одного тика, доставленные потребителю (NTR-15): пачка провода вместе с
 * эпохой своего диапазона. Номер тика едет с фактом, потому что картинка
 * отстаёт на буфер интерполяции (NET-3), и без него звук и VFX не с чем
 * совместить; эпоха — потому что один номер тика после перемотки называет два
 * разных момента матча (NTR-16).
 *
 * Порядок событий внутри пачки — порядок публикации (EVT-2) и сохранён как
 * приехал: сетевой слой его не пересортировывает, иначе представление получило
 * бы меньше, чем знает симуляция.
 */
export interface DeliveredEvents extends EventBatch {
  readonly epoch: number;
}

export type ClientPhase = 'greeting' | 'lobby' | 'playing' | 'closed';

const DEFAULTS = {
  playerComponent: 'Player',
  slotField: 'slot',
  inputComponent: 'Input',
} as const;

export class MatchClient {
  readonly metrics: ClientMetrics = createClientMetrics();

  private readonly options: MatchClientOptions;
  private readonly ring: InputRing;
  private readonly buffer: InterpolationBuffer;
  private readonly outbox: ClientMessage[] = [];

  private clientPhase: ClientPhase = 'greeting';
  private reason: ClientCloseReason | undefined;
  private detail = '';

  private assignedSlot: number | undefined;
  private matchPacing: Pacing | undefined;
  private descriptor: MatchDescriptor | undefined;

  /** Локально поднятый мир матча: даёт хеш для сверки и порядок компонентов для разбора снапшота. */
  private localWorld: WorldState | undefined;
  private localHash: string | undefined;
  private schemas: ComponentSchema[] | undefined;

  private estimatedTick = 0;
  private lastAppliedTick = -1;
  /**
   * Эпоха последнего применённого снапшота (NTR-16). До первого снапшота — 0:
   * матч начинается нулевой эпохой, и кадр, отправленный до первой рассылки,
   * помечен ею же.
   */
  private lastAppliedEpoch = 0;
  /** Разрыв непрерывности мира: взведён сменой эпохи, гасится чтением (SHELL-7). */
  private discontinuityPending = false;

  /**
   * Курсор потока событий (NTR-15) — пара `(эпоха, тик)` последнего применённого
   * тика, ОТДЕЛЬНАЯ от пары применённого снапшота выше.
   *
   * Раздельность — требование, а не удобство: снапшот отбрасывается по «не
   * больше применённого» (NTR-10), а события того же тика могут быть ещё не
   * применены — например, когда `Events` этой рассылки потерялся, а следующий
   * привёз его повтором уже после того, как снапшот более позднего тика
   * применён. Один курсор на двоих вернул бы потерю с другой стороны.
   *
   * Тик `-1` до первого применённого тика: тики матча неотрицательны, и события
   * тика 0 обязаны пройти курсор.
   */
  private eventEpoch = 0;
  private eventTick = -1;
  /**
   * Было ли применено хоть одно сообщение потока. Разрыв — это «диапазон
   * начался позже, чем кончился ПОСЛЕДНИЙ ПРИМЕНЁННЫЙ», и пока применённого нет,
   * сравнивать не с чем: первое сообщение разрывом не считается, где бы ни
   * начинался его диапазон.
   */
  private eventsSeen = false;
  /**
   * Доставленные факты, ждущие потребителя. Границы у очереди нет намеренно:
   * молча выброшенный факт есть ровно та потеря, против которой NTR-15 написан,
   * а слить очередь — контракт потребителя (`takeEvents`), а не забота слоя.
   */
  private readonly eventQueue: DeliveredEvents[] = [];
  private nextSeq = 1;
  private lastMeasuredSeq = 0;

  constructor(options: MatchClientOptions) {
    this.options = options;
    this.ring = new InputRing(options.inputRingTicks ?? DEFAULT_RING_TICKS);
    this.buffer = new InterpolationBuffer(
      options.interpolationDelayMs === undefined ? {} : { delayMs: options.interpolationDelayMs },
    );
  }

  get phase(): ClientPhase {
    return this.clientPhase;
  }

  get closeReason(): ClientCloseReason | undefined {
    return this.reason;
  }

  get closeDetail(): string {
    return this.detail;
  }

  get slot(): number | undefined {
    return this.assignedSlot;
  }

  get pacing(): Pacing | undefined {
    return this.matchPacing;
  }

  get worldInitHash(): string | undefined {
    return this.localHash;
  }

  get serverTick(): number {
    return this.estimatedTick;
  }

  /**
   * Последнее применённое состояние — вход для рендера и для проверок, в
   * презентационной проекции: снапшот БЕЗ шины (`PresentedState`, NTR-15).
   *
   * Шина в кадре на проводе остаётся и в буфере хранится: это состояние,
   * восстанавливаемое вместе с миром (SNAP-1). Наружу её не отдаёт ни этот
   * геттер, ни `sample()` — единственный источник фактов для представления
   * `takeEvents()`, и «не открывать шину вовсе» (задача 4.4) держится типом, а
   * не примечанием в документации.
   */
  get latest(): PresentedState | undefined {
    return this.buffer.latest;
  }

  /** Эпоха последнего применённого состояния (NTR-16) — вторая половина его номера. */
  get epoch(): number {
    return this.lastAppliedEpoch;
  }

  /**
   * Признак разрыва непрерывности, взведённый сменой эпохи (NTR-10): состояние
   * принадлежит другой ветви истории, промежуточных положений между ним и
   * предыдущим не существовало, и рисовать его нужно snap'ом (`client-shell`
   * SHELL-7, `rendering` REND-2).
   *
   * Потребителей состояния два, и признак ездит к обоим одинаково — вместе с
   * состоянием и гасясь чтением. Потребитель, берущий состояние `sample()`,
   * читает признак в поле `discontinuity` самого сэмпла и этот метод не зовёт
   * вовсе. Этот метод — для второго: того, кто рисует по `latest`, минуя буфер
   * интерполяции (RenderBridge оболочки). Гасит признак тот, кто первым взял
   * состояние: два независимых потребителя одного клиента поделили бы один
   * признак и один из них нарисовал бы «проезд» между ветвями истории.
   * Подглядеть, не гася, — `discontinuous`.
   */
  takeDiscontinuity(): boolean {
    const pending = this.discontinuityPending;
    this.discontinuityPending = false;
    return pending;
  }

  /** Тот же признак, но без гашения — для диагностики и проверок. */
  get discontinuous(): boolean {
    return this.discontinuityPending;
  }

  /**
   * Факты, доставленные с прошлого вызова (NTR-15), по возрастанию пары
   * `(эпоха, тик)`; внутри тика — в присланном порядке публикации (EVT-2).
   *
   * Наблюдаемый выход клиента MVP — принятые снапшоты и счётчики (NTR-12), и
   * поток событий встаёт туда же третьим наблюдаемым: не рядом с состоянием, а
   * рядом с ним. Отдельно от `sample()` он именно потому, что сэмпл — состояние
   * на момент времени, отдаваемое буфером интерполяции и не отдаваемое вовсе,
   * пока буфер не набрался; факт же однократен, и связать его доставку с
   * готовностью буфера значило бы терять факты ровно там, где картинка ещё не
   * поехала. Когда проигрывать факт относительно интерполированной картинки —
   * политика потребителя (REND-2), и механизм её не выбирает: он отдаёт факт с
   * номером тика.
   *
   * Слив, а не подписка и не накопление: очередь пустеет чтением, и потому
   * каждый факт достаётся потребителю ровно один раз — то же правило и по той
   * же причине, что у `takeDiscontinuity()`. Подглядеть, не сливая, —
   * `pendingEvents`.
   *
   * Единственный источник фактов — этот метод (NTR-15, «Шина внутри
   * снапшота»). Шина остаётся в кадре на проводе и в буфере как СОСТОЯНИЕ,
   * восстанавливаемое вместе с миром (SNAP-1), но презентационная поверхность
   * её не отдаёт: и `latest`, и `sample()` дают `PresentedState` — снапшот без
   * шины. Прочитай представление шину — события тиков рассылки проигрались бы
   * дважды.
   *
   * Факты стёртой перемоткой ветви, уже попавшие в очередь и ещё не слитые,
   * потребителю ДОЕДУТ: очередь — доставленное, а не предсказание того, что
   * доставку переживёт. Отличить их даёт `DeliveredEvents.epoch`, и решение —
   * проиграть или выбросить — принимает потребитель (решение 8 дизайна): для
   * него граница эпохи и так разрыв, рисуемый snap'ом (SHELL-7).
   */
  takeEvents(): DeliveredEvents[] {
    if (this.eventQueue.length === 0) return [];
    return this.eventQueue.splice(0, this.eventQueue.length);
  }

  /** Та же очередь, но без слива — для диагностики и проверок. */
  get pendingEvents(): readonly DeliveredEvents[] {
    return this.eventQueue;
  }

  /** Предъявление версии (NET-16) — первое, что уходит в соединение. */
  start(): void {
    this.outbox.push({
      type: 'Hello',
      playerId: this.options.playerId,
      version: this.options.version,
      observer: this.options.observer === true,
    });
  }

  drain(): ClientMessage[] {
    if (this.outbox.length === 0) return [];
    return this.outbox.splice(0, this.outbox.length);
  }

  /**
   * Состояние на момент `nowMs` вместе с признаком разрыва (SHELL-7).
   *
   * Признак гасится ровно тогда, когда сэмпл отдан: доставки состояния не
   * случилось — гасить нечего, и разрыв дождётся следующего вызова. Второй
   * потребитель, читающий `latest` мимо буфера, берёт тот же признак
   * `takeDiscontinuity()`; контракт описан там.
   */
  sample(nowMs: number): MatchSample | undefined {
    const sampled = this.buffer.sample(nowMs);
    if (sampled === undefined) return undefined;
    this.metrics.bufferLagMs = sampled.lagMs;
    return { ...sampled, discontinuity: this.takeDiscontinuity() };
  }

  /**
   * Локальная оценка серверного тика, продвигаемая драйвером в темпе `tickRate`.
   *
   * ponytail: компенсации половины круга здесь нет — оценка равна последнему
   * увиденному тику, дальше идёт своим темпом. На локальном прогоне это точно, а
   * на канале с плечом запас `inputDelay` частично съедается дорогой до сервера,
   * и часть кадров начнёт опаздывать. Компенсация вводится по замеру
   * `inputToVisibleMs` на реальном канале — то есть тогда, когда есть чем
   * проверить, что она помогла.
   */
  advance(): void {
    if (this.clientPhase === 'playing') this.estimatedTick++;
  }

  /** Ввод игрока: помечается тиком с запасом задержки (NTR-7) и уходит на сервер. */
  pushInput(sample: InputSample, nowMs: number): void {
    if (this.clientPhase !== 'playing' || this.matchPacing === undefined) return;
    // Ввод уезжает и в остановленном мире. Прежде клиент, увидев режим ≠
    // `Running`, молчал — «гигиена канала»: на симуляцию такой ввод всё равно не
    // повлияет (NET-11, REW-5), и отбрасывает его сервер. Но ровно в этих кадрах
    // едет контрольный бит ведения перемотки: живых тиков в `Rewinding` нет, и
    // другого пути у него не существует — второго канала под управление в
    // протоколе нет и заводить его нельзя (`netcode-transport` NTR-8).
    // Различить «мой бит ведёт скраб» и «мой бит — обычное действие» клиент не
    // может: инициатора знает сервер, у которого лежит запрос. Поэтому шлём всё,
    // а отбор остаётся там же, где и был, — авторитетным (`ingest`).
    const frame: InputFrame = {
      tick: this.estimatedTick + this.matchPacing.inputDelay,
      playerId: this.options.playerId,
      seq: this.nextSeq,
      move: sample.move,
      aimDir: sample.aimDir,
      buttons: sample.buttons,
    };
    this.nextSeq++;
    // Кольцо хранит кадр вместе с эпохой отправки (NTR-10): кадр стёртой
    // эпохи переотправке не подлежит, но остаётся материалом диагностики.
    this.ring.push(frame, nowMs, this.lastAppliedEpoch);
    // Ввод адресуется парой (NTR-7): номер тика без эпохи не называет тик
    // матча, в котором была перемотка, и кадр из стёртой ветви истории
    // применился бы тем успешнее, чем мельче был откат.
    this.outbox.push({
      type: 'Input',
      epoch: this.lastAppliedEpoch,
      frames: [
        {
          tick: frame.tick,
          seq: frame.seq,
          moveX: frame.move.x,
          moveY: frame.move.y,
          aimDir: frame.aimDir,
          buttons: frame.buttons,
        },
      ],
    });
    this.metrics.inputsSent++;
  }

  receive(message: ServerMessage, nowMs: number): void {
    if (this.clientPhase === 'closed') return;
    switch (message.type) {
      case 'Welcome':
        this.onWelcome(message.slot, message.players, message.match, message.worldInitHash, message.pacing);
        return;
      case 'Reject':
        this.close('rejected', `${message.reason}: ${message.detail}`);
        return;
      case 'Start':
        this.clientPhase = 'playing';
        this.estimatedTick = message.tick;
        return;
      case 'Snapshot':
        this.onSnapshot(message.epoch, message.tick, message.snapshot, nowMs);
        return;
      case 'Events':
        this.onEvents(message);
        return;
      case 'End':
        this.close('ended', message.reason);
        return;
    }
  }

  /** Канал закрылся не по нашей воле — состояние приводится к тому же виду. */
  onTransportClosed(): void {
    if (this.clientPhase !== 'closed') this.close('ended', 'соединение закрыто');
  }

  private onWelcome(
    slot: number,
    players: readonly string[],
    match: MatchDescriptor,
    serverHash: string,
    pacing: Pacing,
  ): void {
    const scene = this.options.content.scene(match.sceneRef);
    if (scene === undefined) {
      // Сцены нет в контент-паке — тот же исход, что у разошедшихся ассетов
      // (NTR-5). Досылать её сервер не станет и не должен (NET-16).
      this.close('data-mismatch', `сцена "${match.sceneRef}" отсутствует в контент-паке клиента`);
      return;
    }

    let built;
    try {
      built = buildMatchWorld({
        scene,
        seed: 0,
        players,
        initial: match.initial,
        ...(this.options.physics !== undefined ? { physics: this.options.physics } : {}),
        ...(this.options.visibility !== undefined ? { visibility: this.options.visibility } : {}),
      });
    } catch (error) {
      this.close('data-mismatch', `мир матча не поднимается: ${String(error)}`);
      return;
    }

    // Сверка данных матча (DET-1). Отличается от «версия устарела» исходом, а
    // не только текстом: расхождение здесь означает разные ассеты при одних
    // правилах, и лечится оно иначе (NTR-5).
    if (built.worldInitHash !== serverHash) {
      this.close(
        'data-mismatch',
        `worldInit не совпал: сервер ${serverHash}, клиент ${built.worldInitHash}`,
      );
      return;
    }

    this.assignedSlot = slot;
    this.matchPacing = pacing;
    this.descriptor = match;
    this.localWorld = built.state.world;
    this.localHash = built.worldInitHash;
    this.clientPhase = 'lobby';
  }

  private onSnapshot(epoch: number, tick: number, plain: unknown, nowMs: number): void {
    // Условие работы на неупорядоченном канале (NTR-10): устаревший снапшот
    // отбрасывается, и картинка назад не прыгает. Сравнение идёт по паре
    // (эпоха, тик) лексикографически, а не по одному тику (NTR-16): при
    // перемотке номера тиков идут назад, и сравнение по тику погасило бы ровно
    // те состояния, которые NET-11 велит показать, — «устаревший» и
    // «перемотанный» снапшоты по одному номеру тика неразличимы.
    //
    // Равная пара отбрасывается вместе с меньшей: одна эпоха и один тик
    // достижимы только повторной рассылкой того же состояния — живой тик
    // исполняется за эпоху один раз, — и другого состояния с этой парой не
    // существует (NTR-16).
    const stale =
      epoch < this.lastAppliedEpoch ||
      (epoch === this.lastAppliedEpoch && tick <= this.lastAppliedTick);
    if (stale) {
      // Асимметрия с правилом дедупа ввода (NTR-7) намеренная: повторно
      // разосланное состояние с равной парой считается здесь наравне с
      // устаревшим, тогда как повторно присланный кадр ввода не считается
      // дефектом нигде. Причина в том, что мерят эти счётчики разное.
      // `snapshotsDropped` — «сколько состояний доехало впустую», и повтор
      // доехал впустую ровно так же, как опоздавший: клиент показывать его не
      // станет. Счётчики NTR-11, которые правило дедупа бережёт, — про дефекты
      // КАНАЛА и отправителя, и избыточная отправка ввода там штатный режим.
      this.metrics.snapshotsDropped++;
      return;
    }
    const world = this.localWorld;
    if (world === undefined) {
      this.close('protocol-error', 'снапшот до Welcome');
      return;
    }

    let snapshot: Snapshot;
    try {
      const wire = plain as WireSnapshot;
      // Проекция с провода не несёт состояний стримов (NET-18), а плоская форма
      // ядра их требует: список стримов восстанавливается ПУСТЫМ, и это не
      // потеря, а состав кадра. Клиент MVP `tick()` не исполняет (NTR-10), то
      // есть тянуть случайность ему нечем и незачем; появится предсказание —
      // источник случайности для него придёт отдельным требованием, а не
      // возвратом серверных стримов в снапшот.
      const form: PlainSnapshot = { ...wire, rng: [] };
      // Порядок компонентов задаёт битовые id (SER-7) и берётся из живого мира
      // клиента, а не пересобирается раскладкой загрузчика (см. `orderedSchemas`).
      this.schemas ??= orderedSchemas(world, form.world);
      // ponytail: каждый снапшот поднимает мир заново, то есть аллоцирует SoA
      // целиком — 30 раз в секунду при `snapshotRate` 30. Применение плоской
      // формы в уже созданный мир снимет аллокации; вводить его имеет смысл по
      // замеру на реальной сцене, а не до него.
      snapshot = snapshotFromPlain(form, this.schemas);
    } catch (error) {
      this.close('data-mismatch', `снапшот не восстанавливается: ${String(error)}`);
      return;
    }

    // Рост эпохи читается как разрыв непрерывности мира (NTR-10) и разбирается
    // до применения состояния: буфер интерполяции сбрасывается, состояние
    // ложится в него первым и потому применяется snap'ом, признак разрыва
    // уходит оболочке (SHELL-7), а оценка серверного тика пересинхронизируется.
    const rewound = epoch > this.lastAppliedEpoch;
    this.lastAppliedEpoch = epoch;
    this.lastAppliedTick = tick;
    if (rewound) {
      this.buffer.reset();
      this.discontinuityPending = true;
      // Сколько ввода игрока унесла перемотка (NTR-10): кадры прежних эпох
      // остаются в кольце ровно ради этого ответа, и здесь у него появляется
      // потребитель. В мир и в канонический лог величина не попадает — она
      // клиентская и наблюдательная (NTR-11).
      this.metrics.inputsStranded = this.ring.strandedBefore(epoch);
    }
    this.resyncTick(tick, rewound);
    this.buffer.push(snapshot, nowMs);
    this.metrics.snapshotsApplied++;
    this.measureResponse(snapshot, nowMs);
  }

  /**
   * Поток фактов тиков (NTR-15). Мира не касается вовсе: события — выход
   * симуляции (OBS-1), а не её вход, и применяются они к очереди потребителя, а
   * не к состоянию.
   *
   * Три исхода, и они разные по смыслу.
   *
   * 1. Сообщение целиком не новее курсора — повтор, которым избыточность и
   *    работает: пачки отброшены, курсор на месте. Сюда же попадает диапазон
   *    стёртой перемоткой эпохи, доехавший после смены эпохи: по паре он меньше
   *    курсора, и другого решения у получателя нет (NTR-16).
   * 2. Диапазон начинается позже, чем кончился последний применённый, в ТОЙ ЖЕ
   *    эпохе — разрыв: сообщений потерялось больше, чем повторяет каждое
   *    следующее. Разрыв считается отдельным счётчиком, курсор перескакивает, и
   *    ничего не восстанавливается: догадка или запрос вернули бы reliable-канал
   *    поверх намеренно ненадёжного (NTR-2), а молчание сделало бы дыру
   *    невидимой.
   * 3. Рост эпохи — НЕ разрыв (NTR-16): номера тиков после перемотки идут
   *    заново, «позже» между эпохами не определено, а сама перемотка наблюдаема
   *    с обеих сторон и дефектом канала не является. Курсор перескакивает на
   *    начало диапазона новой эпохи, счётчик разрывов не растёт.
   */
  private onEvents(message: EventsMessage): void {
    const { epoch, from, to, batches } = message;

    // Сравнение лексикографическое по паре (NTR-16), как у снапшота. По одному
    // номеру тика курсор гасил бы события переисполненных после перемотки
    // тиков — ровно те факты, ради доставки которых поток и заведён.
    const fresh = epoch > this.eventEpoch || (epoch === this.eventEpoch && to > this.eventTick);
    if (!fresh) {
      this.metrics.eventBatchesDropped += batches.length;
      return;
    }

    if (this.eventsSeen && epoch === this.eventEpoch && from > this.eventTick + 1) {
      this.metrics.eventRangeGaps++;
    }

    // Порядок применения — по возрастанию тика (NTR-15), и он берётся из
    // содержимого, а не из веры в порядок пачек на проводе: канал
    // переупорядочивает сообщения (NTR-2), и полагаться на порядок внутри
    // сообщения означало бы полагаться на отправителя там, где проверить
    // дёшево. Внутри тика порядок публикации сохраняется как приехал (EVT-2).
    const ordered = [...batches].sort((left, right) => left.tick - right.tick);
    // Курсор двигается пачка за пачкой, чтобы повтор тика ВНУТРИ сообщения
    // отбрасывался тем же правилом, что и повтор между сообщениями. В новой
    // эпохе прежний тик курсора не сравним ни с чем: пара больше по эпохе.
    let cursor = epoch === this.eventEpoch ? this.eventTick : -1;
    for (const batch of ordered) {
      if (batch.tick <= cursor) {
        this.metrics.eventBatchesDropped++;
        continue;
      }
      this.eventQueue.push({ epoch, tick: batch.tick, events: batch.events });
      this.metrics.eventBatchesDelivered++;
      cursor = batch.tick;
    }

    // Курсор встаёт на конец ОБЪЯВЛЕННОГО диапазона, а не на последнюю непустую
    // пачку: диапазон покрыт полностью, и тик без пачки означает «событий не
    // было», а не «пачка потерялась» (NTR-15). Остановка курсора на последней
    // пачке превратила бы каждую тихую рассылку в разрыв следующей.
    this.eventEpoch = epoch;
    this.eventTick = to;
    this.eventsSeen = true;
  }

  /**
   * Оценка серверного тика по пришедшему снапшоту — в обе стороны.
   *
   * Подтягивание вверх очевидно: снапшот тика T доказывает, что сервер уже на T.
   * Ограничение сверху менее очевидно и важнее: собственный таймер клиента идёт
   * не ровно в темпе сервера, и односторонний `max` копил бы расхождение без
   * предела. Кадры уезжали бы всё дальше в будущее, пока не начали бы выпадать
   * из окна приёма (NTR-7) — то есть ввод исчезал бы целиком, и выглядело бы
   * это как «сервер меня не слышит», а не как разъехавшиеся часы.
   *
   * ponytail: верхняя граница не учитывает дорогу до сервера, поэтому на канале
   * с плечом она занижает оценку и часть кадров начнёт опаздывать. Правильная
   * граница — та же плюс половина круга; вводится вместе с компенсацией в
   * `advance()`, по замеру на реальном канале.
   *
   * На смене эпохи (`rewound`) оценка ставится ровно на тик первого снапшота
   * новой эпохи, а не подтягивается постепенно (NTR-10). Постепенное
   * подтягивание её не опустило бы вовсе — `max` держит прежнее значение, —
   * и собственные кадры клиента остались бы адресованными в стёртое будущее:
   * сервер отбрасывал бы их как вышедшие за окно приёма (NTR-7).
   */
  private resyncTick(snapshotTick: number, rewound: boolean): void {
    if (rewound) {
      this.estimatedTick = snapshotTick;
      return;
    }
    const pacing = this.matchPacing;
    if (pacing === undefined) {
      this.estimatedTick = Math.max(this.estimatedTick, snapshotTick);
      return;
    }
    const ceiling = snapshotTick + pacing.tickRate / pacing.snapshotRate + pacing.inputDelay;
    this.estimatedTick = Math.min(Math.max(this.estimatedTick, snapshotTick), ceiling);
  }

  /**
   * Задержка «нажал → увидел» без единого дополнительного сообщения в протоколе.
   *
   * `InputSystem` кладёт `seq` пришедшего кадра в компонент ввода на сущности
   * игрока (TICK-4), а своя сущность всегда есть в собственном снапшоте
   * (NET-15). Значит, `seq` возвращается сам, и остаётся вычесть момент
   * отправки из кольца. Отдельный Ping/Pong дал бы чистый круг до сервера, но
   * не ответил бы на вопрос, ради которого метрика заводится: в отклик входят и
   * канал, и буфер задержки ввода, и темп рассылки.
   */
  private measureResponse(snapshot: Snapshot, nowMs: number): void {
    const slot = this.assignedSlot;
    if (slot === undefined) return;
    const playerComponent = this.options.playerComponent ?? DEFAULTS.playerComponent;
    const slotField = this.options.slotField ?? DEFAULTS.slotField;
    const inputComponent = this.options.inputComponent ?? DEFAULTS.inputComponent;

    const own = this.ownEntity(snapshot, playerComponent, slotField, inputComponent, slot);
    if (own === undefined) return;
    const seq = coreWorld.getField(snapshot.world, own, inputComponent, 'seq');
    if (seq <= 0) return;
    // Каждый `seq` меряется один раз. Predicted-кадр повторяет последний
    // применённый вместе с его `seq` (TICK-2), поэтому одно и то же значение
    // приезжает в каждом следующем снапшоте, пока игрок молчит, — и метрика без
    // этой проверки показывала бы не отклик, а время с последнего нажатия.
    if (seq <= this.lastMeasuredSeq) return;
    this.lastMeasuredSeq = seq;
    const sent = this.ring.bySeq(seq);
    if (sent === undefined) return;
    recordInputToVisible(this.metrics, nowMs - sent.sentAtMs);
  }

  private ownEntity(
    snapshot: Snapshot,
    playerComponent: string,
    slotField: string,
    inputComponent: string,
    slot: number,
  ): EntityId | undefined {
    if (coreWorld.componentId(snapshot.world, playerComponent) === undefined) return undefined;
    if (coreWorld.componentId(snapshot.world, inputComponent) === undefined) return undefined;
    for (const entity of query(snapshot.world, { all: [playerComponent, inputComponent] })) {
      if (coreWorld.getField(snapshot.world, entity, playerComponent, slotField) === slot) return entity;
    }
    return undefined;
  }

  private close(reason: ClientCloseReason, detail: string): void {
    this.clientPhase = 'closed';
    this.reason = reason;
    this.detail = detail;
  }
}
