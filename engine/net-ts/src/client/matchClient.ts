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
  type SceneDef,
  type Snapshot,
  type Vec2,
  type VisibilityOptions,
  type WorldState,
} from '@game-mvp/core';
import { buildMatchWorld, orderedSchemas } from '../match/world.js';
import { createClientMetrics, recordInputToVisible, type ClientMetrics } from '../metrics.js';
import { InputRing, DEFAULT_RING_TICKS } from './inputRing.js';
import { InterpolationBuffer, type InterpolationSample } from './interpolation.js';
import type {
  ClientCloseReason,
  ClientMessage,
  GameVersion,
  MatchDescriptor,
  Pacing,
  ServerMessage,
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

  /** Последний применённый снапшот — вход для рендера и для проверок. */
  get latest(): Snapshot | undefined {
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
   * Читается вместе с состоянием и гасится чтением — как признаки разрыва в
   * канале оболочки, где они копятся до ближайшей доставки. Подглядеть, не
   * гася, — `discontinuous`.
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

  sample(nowMs: number): InterpolationSample | undefined {
    const sampled = this.buffer.sample(nowMs);
    if (sampled !== undefined) this.metrics.bufferLagMs = sampled.lagMs;
    return sampled;
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
      const form = plain as Parameters<typeof snapshotFromPlain>[0];
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
    }
    this.resyncTick(tick, rewound);
    this.buffer.push(snapshot, nowMs);
    this.metrics.snapshotsApplied++;
    this.measureResponse(snapshot, nowMs);
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
