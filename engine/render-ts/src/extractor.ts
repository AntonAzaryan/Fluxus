/**
 * Extractor — воркер-половина бывшего `RenderHost.onTick` (SHELL-2).
 *
 * Единственный читатель `WorldState` в рендер-пайплайне: реализует
 * `TickObserver`-совместимый вход `extract(TickResult)` и копирует нужный
 * минимум в плоскую SoA-форму `ExtractedTick`. Здесь же — единственная во
 * всём рендере точка конверсии Q16.16 → float (REND-1) и всё, чему нужен
 * доступ к миру: резолв визуального типа по тегам, чтение скорости,
 * направление каста из событий (цель может быть сущностью — нужна её
 * позиция), зеркало карты пола.
 *
 * Плоская форма — граница потоков: она либо скармливается `ViewBuffer`
 * прямым вызовом (однопоточная сборка), либо сериализуется каналом
 * оболочки. Колонки переиспользуются между тиками (аллокация только при
 * росте сцены); возвращённый объект валиден до следующего `extract`.
 */
import {
  FIXED_ONE,
  FLOOR_COMPONENT,
  LEVEL_OVERRIDE_COMPONENT,
  POSITION_COMPONENT,
  cellAt,
  world,
  type EntityId,
  type TerrainGrid,
  type TickResult,
  type WorldMode,
  type WorldState,
} from '@game-mvp/core';
import { FloorMirror } from './floorMirror.js';
import type { RenderEvent } from './types.js';

/** Конвенция физики ядра: компонент скорости с полями `x`/`y` (Q16.16 за тик). */
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
/** Порог скорости (единиц за тик) состояния `move`; ниже — дрожание стоящих не считается бегом. */
const DEFAULT_MOVE_EPSILON = 1e-3;
/** Направление каста держится ~0.75 с при 60 тиках, дальше торс возвращается к движению. */
const DEFAULT_AIM_HOLD_TICKS = 45;

/** Бит колонки `flags`: скорость выше порога — состояние `move` (REND-4). */
export const ENTITY_MOVING = 1;
/** Бит колонки `flags`: у сущности override уровня (TERR-4) — наклон по поверхности не применяется (REND-10). */
export const ENTITY_LEVEL_OVERRIDE = 2;

/**
 * Плоское presentation-состояние одного тика — то, что пересекает границу
 * потоков (SHELL-2). Колонки длиной >= `count`; `NaN` в `facingYaw` — сущность
 * стоит (курс не обновлять), `NaN` в `aimYaw` — цели нет. `kind` — индекс в
 * `kindTable`, −1 — сущность не рисуется. `floorDelta` — плоские пары
 * (клетка, бит пола): значения, а не переключения, чтобы переживать
 * conflation (SHELL-4).
 */
export interface ExtractedTick {
  tick: number;
  mode: WorldMode;
  isReplay: boolean;
  /** Разрыв непрерывности мира (rewind/смена режима): всем сущностям snap (REND-2). */
  snapAll: boolean;
  /** Первый честный проход тика: события можно проигрывать (OBS-5). */
  freshEvents: boolean;
  count: number;
  /** EntityId — 48-битный generational; Float64 хранит его точно. */
  id: Float64Array;
  kind: Int32Array;
  x: Float32Array;
  y: Float32Array;
  level: Uint8Array;
  flags: Uint8Array;
  facingYaw: Float32Array;
  aimYaw: Float32Array;
  /** События этого тика (копии, OBS-3), с номером тика — для reliable-доставки (SHELL-4). */
  events: readonly RenderEvent[];
  /** Пары (клетка, бит) реально изменившихся клеток пола (TERR-6 → REND-7). ArrayLike — читатель канала подставляет view в буфер доставки. */
  floorDelta: ArrayLike<number>;
  /** Живой словарь визуальных типов; растёт append-only (SHELL-5). */
  kindTable: readonly string[];
}

export interface ExtractorConfig {
  /** Визуальный тип сущности — ключ манифеста визуалов; null — не рисовать. */
  readonly kindOf: (state: WorldState, entity: EntityId) => string | null;
  /** Компонент скорости; конвенция физики ядра — 'Velocity' с полями x/y. */
  readonly velocityComponent?: string;
  /** Порог скорости (мировых единиц за тик) для состояния `move` (REND-4). */
  readonly moveEpsilon?: number;
  /** Сетка террейна сцены — уровень под сущностями и зеркало карты пола (REND-7). */
  readonly terrainGrid?: TerrainGrid;
  /** Типы событий, несущие направление атаки/каста для bone-контроля (REND-5). */
  readonly aimEvents?: readonly string[];
  /** Сколько тиков держится направление каста, прежде чем цель протухнет. */
  readonly aimHoldTicks?: number;
}

const EMPTY_EVENTS: readonly RenderEvent[] = [];
const EMPTY_DELTA: readonly number[] = [];

/** Направление последнего каста сущности и тик, на котором оно поставлено. */
interface AimEntry {
  yaw: number;
  tick: number;
}

export class Extractor {
  private readonly kindOf: (state: WorldState, entity: EntityId) => string | null;
  private readonly velocityComponent: string;
  private readonly moveEpsilonSq: number;
  private readonly aimEvents: ReadonlySet<string>;
  private readonly aimHoldTicks: number;
  private readonly grid: TerrainGrid | undefined;
  private readonly mirror: FloorMirror | null;

  /** Словарь kind'ов: растёт append-only, индексы стабильны (SHELL-5). */
  private readonly kindTable: string[] = [];
  private readonly kindIndexOf = new Map<string, number>();
  /** Тип сущности вычисляется один раз: generation в ID делает кэш безопасным. */
  private readonly kinds = new Map<EntityId, number>();
  private readonly aim = new Map<EntityId, AimEntry>();
  private readonly seen = new Set<EntityId>();

  private hasTick = false;
  private prevTick = 0;
  private prevMode: WorldMode = 'Running';

  /** Переиспользуемый выход: колонки перевыделяются только при росте сцены. */
  private readonly out: ExtractedTick;

  constructor(config: ExtractorConfig) {
    this.kindOf = config.kindOf;
    this.velocityComponent = config.velocityComponent ?? DEFAULT_VELOCITY_COMPONENT;
    const moveEpsilon = config.moveEpsilon ?? DEFAULT_MOVE_EPSILON;
    this.moveEpsilonSq = moveEpsilon * moveEpsilon;
    this.aimEvents = new Set(config.aimEvents ?? []);
    this.aimHoldTicks = config.aimHoldTicks ?? DEFAULT_AIM_HOLD_TICKS;
    this.grid = config.terrainGrid;
    this.mirror = this.grid === undefined ? null : new FloorMirror(this.grid);
    this.out = {
      tick: 0,
      mode: 'Running',
      isReplay: false,
      snapAll: false,
      freshEvents: false,
      count: 0,
      id: new Float64Array(0),
      kind: new Int32Array(0),
      x: new Float32Array(0),
      y: new Float32Array(0),
      level: new Uint8Array(0),
      flags: new Uint8Array(0),
      facingYaw: new Float32Array(0),
      aimYaw: new Float32Array(0),
      events: EMPTY_EVENTS,
      floorDelta: EMPTY_DELTA,
      kindTable: this.kindTable,
    };
  }

  /** Читает `TickResult` и возвращает плоскую форму; валидна до следующего вызова. */
  extract(result: TickResult): ExtractedTick {
    const state = result.state.world;
    const out = this.out;

    const tickAdvanced = !this.hasTick || result.tick !== this.prevTick;
    const modeChanged = this.hasTick && result.mode !== this.prevMode;
    // Разрыв непрерывности мира: rewind/replay и смена режима (REND-2).
    const snapAll = result.isReplay || modeChanged;
    const freshEvents = tickAdvanced && !result.isReplay && result.mode === 'Running';

    const events = this.copyEvents(result);
    if (freshEvents) this.captureAim(state, result.tick, events);

    this.copyEntities(state, result.tick);

    // Зеркало пола: перечитываем только когда дельта тика тронула компонент
    // либо при разрыве непрерывности (rewind мог откатить пол без дельты).
    let floorDelta: readonly number[] = EMPTY_DELTA;
    if (this.mirror !== null) {
      const floorDirty = result.changes.changedEntities(FLOOR_COMPONENT).size > 0;
      if (floorDirty || snapAll || !this.hasTick) {
        const changed = this.mirror.sync(state);
        if (changed.length > 0) {
          const pairs: number[] = [];
          for (const cell of changed) pairs.push(cell, this.mirror.bits[cell]!);
          floorDelta = pairs;
        }
      }
    }

    out.tick = result.tick;
    out.mode = result.mode;
    out.isReplay = result.isReplay;
    out.snapAll = snapAll;
    out.freshEvents = freshEvents;
    out.events = events;
    out.floorDelta = floorDelta;

    this.prevTick = result.tick;
    this.prevMode = result.mode;
    this.hasTick = true;
    return out;
  }

  private copyEntities(state: WorldState, tick: number): void {
    const out = this.out;
    const seen = this.seen;
    seen.clear();

    const alive = world.listAlive(state);
    this.ensureCapacity(alive.length);
    let count = 0;
    for (let i = 0; i < alive.length; i++) {
      const entity = alive[i]!;
      if (!world.hasComponent(state, entity, POSITION_COMPONENT)) continue;
      seen.add(entity);

      const fx = world.getField(state, entity, POSITION_COMPONENT, 'x');
      const fy = world.getField(state, entity, POSITION_COMPONENT, 'y');
      // Единственная точка конверсии Q16.16 → float во всём рендере (REND-1).
      out.id[count] = entity;
      out.kind[count] = this.resolveKind(state, entity);
      out.x[count] = fx / FIXED_ONE;
      out.y[count] = fy / FIXED_ONE;
      out.level[count] =
        this.grid === undefined ? 0 : this.grid.levels[cellAt(this.grid, { x: fx, y: fy })]!;

      let moving = false;
      let yaw = Number.NaN;
      if (world.hasComponent(state, entity, this.velocityComponent)) {
        const vx = world.getField(state, entity, this.velocityComponent, 'x') / FIXED_ONE;
        const vy = world.getField(state, entity, this.velocityComponent, 'y') / FIXED_ONE;
        moving = vx * vx + vy * vy > this.moveEpsilonSq;
        if (moving) yaw = Math.atan2(vy, vx);
      }
      let flags = moving ? ENTITY_MOVING : 0;
      if (world.hasComponent(state, entity, LEVEL_OVERRIDE_COMPONENT)) {
        flags |= ENTITY_LEVEL_OVERRIDE;
      }
      out.flags[count] = flags;
      out.facingYaw[count] = yaw;

      const aim = this.aim.get(entity);
      out.aimYaw[count] =
        aim !== undefined && tick - aim.tick <= this.aimHoldTicks ? aim.yaw : Number.NaN;

      count++;
    }
    out.count = count;

    for (const id of this.kinds.keys()) {
      if (!seen.has(id)) {
        this.kinds.delete(id);
        this.aim.delete(id);
      }
    }
  }

  private ensureCapacity(n: number): void {
    const out = this.out;
    if (out.id.length >= n) return;
    const capacity = Math.max(16, Math.ceil(n * 1.5));
    out.id = new Float64Array(capacity);
    out.kind = new Int32Array(capacity);
    out.x = new Float32Array(capacity);
    out.y = new Float32Array(capacity);
    out.level = new Uint8Array(capacity);
    out.flags = new Uint8Array(capacity);
    out.facingYaw = new Float32Array(capacity);
    out.aimYaw = new Float32Array(capacity);
  }

  private resolveKind(state: WorldState, entity: EntityId): number {
    let index = this.kinds.get(entity);
    if (index === undefined) {
      const kind = this.kindOf(state, entity);
      if (kind === null) {
        index = -1;
      } else {
        let interned = this.kindIndexOf.get(kind);
        if (interned === undefined) {
          interned = this.kindTable.length;
          this.kindTable.push(kind);
          this.kindIndexOf.set(kind, interned);
        }
        index = interned;
      }
      this.kinds.set(entity, index);
    }
    return index;
  }

  private copyEvents(result: TickResult): readonly RenderEvent[] {
    // Копия переживает dispatch (OBS-3): view ядра дальше не удерживается.
    // Массив на тик новый: view.events прошлого тика не мутируется под
    // подсистемой, удерживающей его до следующего syncTick.
    let events: RenderEvent[] | null = null;
    for (const event of result.events) {
      (events ??= []).push({ type: event.type, tick: result.tick, data: { ...event.data } });
    }
    return events ?? EMPTY_EVENTS;
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
      if (!world.isAlive(state, caster) || !world.hasComponent(state, caster, POSITION_COMPONENT)) {
        continue;
      }
      const yaw = this.aimYawOf(state, event, caster);
      if (yaw === null) continue;
      const entry = this.aim.get(caster);
      if (entry === undefined) {
        this.aim.set(caster, { yaw, tick });
      } else {
        entry.yaw = yaw;
        entry.tick = tick;
      }
    }
  }

  private aimYawOf(state: WorldState, event: RenderEvent, caster: EntityId): number | null {
    const dirX = event.data['dirX'];
    const dirY = event.data['dirY'];
    if (dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0)) {
      return Math.atan2(dirY / FIXED_ONE, dirX / FIXED_ONE);
    }
    const cx = world.getField(state, caster, POSITION_COMPONENT, 'x') / FIXED_ONE;
    const cy = world.getField(state, caster, POSITION_COMPONENT, 'y') / FIXED_ONE;
    const px = event.data['x'];
    const py = event.data['y'];
    if (px !== undefined && py !== undefined) {
      return Math.atan2(py / FIXED_ONE - cy, px / FIXED_ONE - cx);
    }
    const target = event.data['target'];
    if (
      target !== undefined &&
      world.isAlive(state, target) &&
      world.hasComponent(state, target, POSITION_COMPONENT)
    ) {
      const tx = world.getField(state, target, POSITION_COMPONENT, 'x') / FIXED_ONE;
      const ty = world.getField(state, target, POSITION_COMPONENT, 'y') / FIXED_ONE;
      return Math.atan2(ty - cy, tx - cx);
    }
    return null;
  }
}
