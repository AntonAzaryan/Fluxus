/**
 * RenderHost — рендер как внешний наблюдатель симуляции (REND-1).
 *
 * Реализует `TickObserver` ядра: в `onTick` копирует нужный минимум из
 * `TickResult` в собственное presentation-состояние (OBS-3 запрещает держать
 * view ядра), здесь же — единственная во всём пакете точка конверсии
 * Q16.16 → float. Обратного канала нет: хост не вызывает ни одного
 * мутирующего API мира и не является зависимостью ядра.
 *
 * Кадр отвязан от тика (REND-2): состояние держит два последних тика,
 * `frame(now)` считает альфу интерполяции и зовёт подсистемы. Подсистемы
 * (REND-8) вызываются строго в порядке регистрации.
 */
import {
  FIXED_ONE,
  FLOOR_COMPONENT,
  POSITION_COMPONENT,
  cellAt,
  world,
  type EntityId,
  type TerrainGrid,
  type TickObserver,
  type TickResult,
  type WorldState,
} from '@game-mvp/core';
import { FloorMirror } from './floorMirror.js';
import type {
  EntityView,
  RenderContext,
  RenderEvent,
  RenderHostConfig,
  RenderSubsystem,
  TickView,
} from './types.js';

/** Конвенция физики ядра: компонент скорости с полями `x`/`y` (Q16.16 за тик). */
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
/** Скачок позиции за тик больше этого — телепорт: интерполяция «проехала бы» пол-арены. */
const DEFAULT_SNAP_DISTANCE = 2;
/** Порог скорости (единиц за тик) состояния `move`; ниже — дрожание стоящих не считается бегом. */
const DEFAULT_MOVE_EPSILON = 1e-3;
/** Направление каста держится ~0.75 с при 60 тиках, дальше торс возвращается к движению. */
const DEFAULT_AIM_HOLD_TICKS = 45;

/**
 * Резолвер визуального типа по тегам сущности: ядро не хранит имя prefab'а,
 * но теги prefab'а копируются на сущность при спавне. Кандидаты — ключи
 * манифеста визуалов (связь «манифест → sim-идентификатор», ASSET-6).
 */
export function kindByTags(
  kinds: readonly string[],
): (state: WorldState, entity: EntityId) => string | null {
  return (state, entity) => {
    for (const kind of kinds) {
      if (world.hasTag(state, entity, kind)) return kind;
    }
    return null;
  };
}

/** Внутренняя запись сущности: EntityView плюс служебные поля прицеливания. */
interface EntityRecord extends EntityView {
  prevX: number;
  prevY: number;
  currX: number;
  currY: number;
  prevLevel: number;
  currLevel: number;
  snap: boolean;
  spawned: boolean;
  moving: boolean;
  facingYaw: number;
  aimYaw: number | null;
  /** Последняя цель каста и тик, на котором она поставлена. */
  aimStoredYaw: number | null;
  aimTick: number;
}

export class RenderHost implements TickObserver {
  readonly name = 'render';

  private readonly context: RenderContext;
  private readonly subsystems: RenderSubsystem[] = [];
  private readonly records = new Map<EntityId, EntityRecord>();
  /** Тип сущности вычисляется один раз: generation в ID делает кэш безопасным. */
  private readonly kinds = new Map<EntityId, string | null>();
  private readonly mirror: FloorMirror | null;
  private readonly grid: TerrainGrid | undefined;

  private readonly tickSeconds: number;
  private readonly kindOf: (state: WorldState, entity: EntityId) => string | null;
  private readonly velocityComponent: string;
  private readonly snapDistanceSq: number;
  private readonly moveEpsilonSq: number;
  private readonly aimEvents: ReadonlySet<string>;
  private readonly aimHoldTicks: number;
  private readonly clock: () => number;

  private hasTick = false;
  private lastTickAtMs = 0;
  private lastFrameAtMs: number | null = null;

  /** Presentation-состояние последнего тика; подсистемы получают его в syncTick. */
  readonly view: TickView;

  constructor(context: RenderContext, config: RenderHostConfig) {
    this.context = context;
    this.tickSeconds = config.tickSeconds;
    this.kindOf = config.kindOf;
    this.velocityComponent = config.velocityComponent ?? DEFAULT_VELOCITY_COMPONENT;
    const snapDistance = config.snapDistance ?? DEFAULT_SNAP_DISTANCE;
    this.snapDistanceSq = snapDistance * snapDistance;
    const moveEpsilon = config.moveEpsilon ?? DEFAULT_MOVE_EPSILON;
    this.moveEpsilonSq = moveEpsilon * moveEpsilon;
    this.aimEvents = new Set(config.aimEvents ?? []);
    this.aimHoldTicks = config.aimHoldTicks ?? DEFAULT_AIM_HOLD_TICKS;
    this.clock = config.clock ?? (() => performance.now());
    this.grid = config.terrainGrid;
    this.mirror = this.grid === undefined ? null : new FloorMirror(this.grid);
    this.view = {
      tick: 0,
      mode: 'Running',
      isReplay: false,
      snapAll: false,
      freshEvents: false,
      entities: this.records,
      events: [],
      floorBits: this.mirror?.bits ?? null,
      floorChangedCells: [],
    };
  }

  /** Регистрирует подсистему; порядок регистрации = порядок вызовов (REND-8). */
  register(subsystem: RenderSubsystem): this {
    this.subsystems.push(subsystem);
    subsystem.init(this.context);
    return this;
  }

  // -------------------------------------------------------------- onTick

  onTick(result: TickResult): void {
    const state = result.state.world;
    const view = this.view;

    const tickAdvanced = !this.hasTick || result.tick !== view.tick;
    const modeChanged = this.hasTick && result.mode !== view.mode;
    // Разрыв непрерывности мира: rewind/replay и смена режима (REND-2).
    const snapAll = result.isReplay || modeChanged;
    const freshEvents = tickAdvanced && !result.isReplay && result.mode === 'Running';

    this.copyEntities(state, result.tick, tickAdvanced, snapAll);
    const events = this.copyEvents(result);
    if (freshEvents) this.captureAim(state, result.tick, events);
    this.expireAim(result.tick);

    // Зеркало пола: перечитываем только когда дельта тика тронула компонент
    // либо при разрыве непрерывности (rewind мог откатить пол без дельты).
    let floorChanged: readonly number[] = [];
    if (this.mirror !== null) {
      const floorDirty = result.changes.changedEntities(FLOOR_COMPONENT).size > 0;
      if (floorDirty || snapAll || !this.hasTick) floorChanged = this.mirror.sync(state);
    }

    view.tick = result.tick;
    view.mode = result.mode;
    view.isReplay = result.isReplay;
    view.snapAll = snapAll;
    view.freshEvents = freshEvents;
    view.events = events;
    view.floorChangedCells = floorChanged;

    if (tickAdvanced || !this.hasTick) this.lastTickAtMs = this.clock();
    this.hasTick = true;

    for (const subsystem of this.subsystems) subsystem.syncTick(view);
  }

  private copyEntities(
    state: WorldState,
    tick: number,
    tickAdvanced: boolean,
    snapAll: boolean,
  ): void {
    const seen = new Set<EntityId>();
    const alive = world.listAlive(state);
    for (let i = 0; i < alive.length; i++) {
      const entity = alive[i]!;
      if (!world.hasComponent(state, entity, POSITION_COMPONENT)) continue;
      seen.add(entity);

      const fx = world.getField(state, entity, POSITION_COMPONENT, 'x');
      const fy = world.getField(state, entity, POSITION_COMPONENT, 'y');
      // Единственная точка конверсии Q16.16 → float во всём рендере (REND-1).
      const x = fx / FIXED_ONE;
      const y = fy / FIXED_ONE;
      const level =
        this.grid === undefined ? 0 : this.grid.levels[cellAt(this.grid, { x: fx, y: fy })]!;

      let record = this.records.get(entity);
      if (record === undefined) {
        record = {
          id: entity,
          kind: this.resolveKind(state, entity),
          prevX: x,
          prevY: y,
          currX: x,
          currY: y,
          prevLevel: level,
          currLevel: level,
          snap: true,
          spawned: true,
          moving: false,
          facingYaw: 0,
          aimYaw: null,
          aimStoredYaw: null,
          aimTick: 0,
        };
        this.records.set(entity, record);
      } else if (snapAll) {
        record.prevX = record.currX = x;
        record.prevY = record.currY = y;
        record.prevLevel = record.currLevel = level;
        record.snap = true;
        record.spawned = false;
      } else if (!tickAdvanced) {
        // Замороженный тик (Paused): мир не изменился, буфер не двигаем.
        record.spawned = false;
      } else {
        const dx = x - record.currX;
        const dy = y - record.currY;
        const teleport = dx * dx + dy * dy > this.snapDistanceSq;
        record.prevX = teleport ? x : record.currX;
        record.prevY = teleport ? y : record.currY;
        record.prevLevel = teleport ? level : record.currLevel;
        record.currX = x;
        record.currY = y;
        record.currLevel = level;
        record.snap = teleport;
        record.spawned = false;
      }

      this.copyMotion(state, entity, record);
    }

    for (const id of this.records.keys()) {
      if (!seen.has(id)) {
        this.records.delete(id);
        this.kinds.delete(id);
      }
    }
  }

  private copyMotion(state: WorldState, entity: EntityId, record: EntityRecord): void {
    if (!world.hasComponent(state, entity, this.velocityComponent)) {
      record.moving = false;
      return;
    }
    const vx = world.getField(state, entity, this.velocityComponent, 'x') / FIXED_ONE;
    const vy = world.getField(state, entity, this.velocityComponent, 'y') / FIXED_ONE;
    record.moving = vx * vx + vy * vy > this.moveEpsilonSq;
    if (record.moving) record.facingYaw = Math.atan2(vy, vx);
  }

  private resolveKind(state: WorldState, entity: EntityId): string | null {
    let kind = this.kinds.get(entity);
    if (kind === undefined) {
      kind = this.kindOf(state, entity);
      this.kinds.set(entity, kind);
    }
    return kind;
  }

  private copyEvents(result: TickResult): RenderEvent[] {
    // Копия переживает dispatch (OBS-3): view ядра дальше не удерживается.
    const events: RenderEvent[] = [];
    for (const event of result.events) {
      events.push({ type: event.type, data: { ...event.data } });
    }
    return events;
  }

  /**
   * Направление атаки/каста для bone-контроля (REND-5) из событий тика.
   * Конвенции полей события: `entity`/`source` — кастующий (EVENT_ENTITY_FIELDS
   * ядра); направление — `dirX`/`dirY` (вектор Q16.16), иначе `x`/`y` (точка
   * мира), иначе `target` (сущность — берём её позицию).
   */
  private captureAim(state: WorldState, tick: number, events: readonly RenderEvent[]): void {
    for (const event of events) {
      if (!this.aimEvents.has(event.type)) continue;
      const caster = event.data['entity'] ?? event.data['source'];
      if (caster === undefined) continue;
      const record = this.records.get(caster);
      if (record === undefined) continue;
      const yaw = this.aimYawOf(state, event, record);
      if (yaw === null) continue;
      record.aimStoredYaw = yaw;
      record.aimTick = tick;
    }
  }

  private aimYawOf(state: WorldState, event: RenderEvent, record: EntityRecord): number | null {
    const dirX = event.data['dirX'];
    const dirY = event.data['dirY'];
    if (dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0)) {
      return Math.atan2(dirY / FIXED_ONE, dirX / FIXED_ONE);
    }
    const px = event.data['x'];
    const py = event.data['y'];
    if (px !== undefined && py !== undefined) {
      return Math.atan2(py / FIXED_ONE - record.currY, px / FIXED_ONE - record.currX);
    }
    const target = event.data['target'];
    if (
      target !== undefined &&
      world.isAlive(state, target) &&
      world.hasComponent(state, target, POSITION_COMPONENT)
    ) {
      const tx = world.getField(state, target, POSITION_COMPONENT, 'x') / FIXED_ONE;
      const ty = world.getField(state, target, POSITION_COMPONENT, 'y') / FIXED_ONE;
      return Math.atan2(ty - record.currY, tx - record.currX);
    }
    return null;
  }

  private expireAim(tick: number): void {
    for (const record of this.records.values()) {
      record.aimYaw =
        record.aimStoredYaw !== null && tick - record.aimTick <= this.aimHoldTicks
          ? record.aimStoredYaw
          : null;
    }
  }

  // --------------------------------------------------------------- frame

  /**
   * Кадр: считает dt и альфу интерполяции между двумя последними тиками и
   * зовёт `updateFrame` подсистем в порядке регистрации (REND-2, REND-8).
   * `now` — миллисекунды тех же часов, что `config.clock`.
   */
  frame(now: number = this.clock()): void {
    if (!this.hasTick) return;
    const dtMs = this.lastFrameAtMs === null ? 0 : now - this.lastFrameAtMs;
    this.lastFrameAtMs = now;
    // Кламп dt: после паузы вкладки первый кадр не должен «доигрывать» минуты.
    const dt = Math.min(Math.max(dtMs / 1000, 0), 0.25);
    const alpha =
      this.tickSeconds <= 0
        ? 1
        : Math.min(Math.max((now - this.lastTickAtMs) / 1000 / this.tickSeconds, 0), 1);
    for (const subsystem of this.subsystems) subsystem.updateFrame(dt, alpha);
  }
}
