/**
 * Extractor — воркер-половина бывшего `RenderHost.onTick` (SHELL-2).
 *
 * Единственный читатель `WorldState` в рендер-пайплайне: реализует
 * `TickObserver`-совместимый вход `extract(TickResult)` и копирует нужный
 * минимум в плоскую SoA-форму `ExtractedTick`. Здесь же — входная граница
 * ПОТОКА ТИКОВ, то есть его точка конверсии Q16.16 → float (REND-1; прочие
 * точки границы — приём сетки террейна в `subsystems/terrain.ts`,
 * `visualSurface.ts` и `camera/rig.ts`, полный перечень входов — `types.ts`),
 * и всё, чему нужен доступ к миру: резолв визуального типа по тегам, чтение
 * скорости, направление каста из событий (цель может быть сущностью — нужна её
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
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_NORMAL,
  LOCOMOTION_ROLL,
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
import {
  StatReader,
  flightPhaseOf,
  type FlightPhaseSource,
  type StatSource,
} from './statSources.js';
import type { RenderEvent } from './types.js';

/** Конвенция физики ядра: компонент скорости с полями `x`/`y` (Q16.16 за тик). */
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
/** Порог скорости (единиц за тик) состояния `move`; ниже — дрожание стоящих не считается бегом. */
const DEFAULT_MOVE_EPSILON = 1e-3;
/** Направление каста держится ~0.75 с при 60 тиках, дальше торс возвращается к движению. */
const DEFAULT_AIM_HOLD_TICKS = 45;
/** Дефолты имён компонентов локомоушена — те же, что у `LocomotionSystem` (LOC-1). */
const DEFAULT_LOCOMOTION_STATE_COMPONENT = 'LocomotionState';
const DEFAULT_LOCOMOTION_CONFIG_COMPONENT = 'Locomotion';

/**
 * Поле полной длительности манёвра в конфиг-компоненте — по его состоянию
 * (LOC-3). Имена ПОЛЕЙ, в отличие от имён компонентов, параметром не являются:
 * у самой системы ядра они тоже зашиты — это её контракт, а не конвенция ядра.
 * Состояния вне таблицы (`Normal`, окно даблтапа) манёвром не являются, фазы
 * у них нет.
 */
const MANEUVER_DURATION_FIELD: Readonly<Record<number, string>> = {
  [LOCOMOTION_DODGE]: 'dodgeTicks',
  [LOCOMOTION_ROLL]: 'rollTicks',
  [LOCOMOTION_AIRBORNE]: 'jumpTicks',
};

/** Бит колонки `flags`: скорость выше порога — состояние `move` (REND-4). */
export const ENTITY_MOVING = 1;
/** Бит колонки `flags`: у сущности override уровня (TERR-4) — наклон по поверхности не применяется (REND-10). */
export const ENTITY_LEVEL_OVERRIDE = 2;
/** Сдвиг битов состояний в колонке `flags`: бит i+STATE_BITS_SHIFT — i-я компонента `stateComponents`. */
export const STATE_BITS_SHIFT = 2;
/** Колонка `flags` — u8: биты 0..1 заняты, под состояния остаётся 6 бит. */
const MAX_STATE_COMPONENTS = 6;

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
  /**
   * Состояние машины локомоушена (LOC-3) последнего тика — значение поля
   * `state`; вне манёвра и у сущностей без локомоушена — `LOCOMOTION_NORMAL`.
   * Потребитель — выбор состояния анимации (REND-4).
   */
  motion: Uint8Array;
  /**
   * Фаза манёвра — доля пройденных тиков от их полного числа, `[0..1)`;
   * `NaN` — манёвра нет. Считается здесь, в воркере: длительность манёвра
   * лежит в конфиг-компоненте, а conflation (SHELL-4) вправе съесть тик входа
   * в манёвр, и главному потоку не от чего было бы её отсчитать (REND-12).
   */
  motionPhase: Float32Array;
  /**
   * Фаза полёта — доля пройденного пути `[0..1]`; `NaN` — сущность не летит
   * (или сборка фазы не объявила). Вход полётной дуги (REND-12): считается
   * здесь, в воркере, потому что источник — компонент мира, а рендер фазу
   * MUST NOT вычислять сам.
   */
  flightPhase: Float32Array;
  /**
   * Имена статов доставки (`match-hud` HUD-8) — словарь конфигурации сборки,
   * общий на все сущности и НЕИЗМЕННЫЙ за сессию: индексы пар ниже — позиции в
   * нём. Пустой список — сборка статов не объявила.
   */
  statNames: readonly string[];
  /**
   * Сколько пар «индекс имени → значение» у сущности `i`. Форма разреженная:
   * стат, которого у сущности нет, не едет вовсе, а не едет нулём (HUD-8 —
   * «нет данных» и «ноль» обязаны различаться).
   */
  statCount: Uint8Array;
  /** Индексы имён подряд по сущностям, длиной `statPairs`. */
  statIndex: Int32Array;
  /** Значения в том же порядке, длиной `statPairs`. */
  statValue: Float64Array;
  /** Сколько пар всего в этом тике — длина двух секций выше. */
  statPairs: number;
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
  /**
   * Компоненты, чьё присутствие на сущности зеркалируется битами в
   * `EntityView.states` (по порядку списка): вход длящихся эффектов камеры
   * (CAM-6). Не больше MAX_STATE_COMPONENTS.
   */
  readonly stateComponents?: readonly string[];
  /**
   * Компоненты локомоушена (LOC-1): состояние машины манёвров и конфигурация
   * с длительностями. Имена — параметры системы ядра, а значит и наши;
   * сборка без локомоушена просто не найдёт компонента и не заметит разницы.
   */
  readonly locomotion?: {
    readonly stateComponent?: string;
    readonly configComponent?: string;
  };
  /**
   * Источник фазы полёта (REND-12) — конфигурация СБОРКИ, а не конвенция ядра:
   * какой компонент считает оставшийся путь снаряда и сколько его всего.
   * Компонента у сущности нет — фазы нет (`NaN`), и полётной дуги не будет.
   *
   * Поле названо оставшимся ресурсом, а не пройденным, потому что именно так
   * его ведут системы контента (счётчик вниз до нуля); фаза — производная
   * `(total − left) / total`.
   */
  readonly flight?: FlightPhaseSource;
  /**
   * Геймплейные статы доставки (`match-hud` HUD-8): какие компоненты и поля
   * мира едут в плоскую форму и под какими именами. Объявление — данные
   * СБОРКИ: имена компонентов принадлежат контенту, и ни кодек, ни HUD их
   * смысла не знают. Новый стат — запись этого списка, а не правка кода.
   */
  readonly stats?: readonly StatSource[];
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
  private readonly stateComponents: readonly string[];
  private readonly locomotionState: string;
  private readonly locomotionConfig: string;
  private readonly flight: FlightPhaseSource | undefined;
  /** Читатель статов сборки (HUD-8); порядок записей задаёт индексы имён. */
  private readonly stats: StatReader;
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
    this.stateComponents = config.stateComponents ?? [];
    if (this.stateComponents.length > MAX_STATE_COMPONENTS) {
      throw new Error(
        `Extractor: stateComponents — ${this.stateComponents.length} компонент, колонка flags вмещает ${MAX_STATE_COMPONENTS}`,
      );
    }
    this.locomotionState =
      config.locomotion?.stateComponent ?? DEFAULT_LOCOMOTION_STATE_COMPONENT;
    this.locomotionConfig =
      config.locomotion?.configComponent ?? DEFAULT_LOCOMOTION_CONFIG_COMPONENT;
    this.flight = config.flight;
    this.stats = new StatReader(config.stats ?? []);
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
      motion: new Uint8Array(0),
      motionPhase: new Float32Array(0),
      flightPhase: new Float32Array(0),
      statNames: this.stats.names,
      statCount: new Uint8Array(0),
      statIndex: new Int32Array(0),
      statValue: new Float64Array(0),
      statPairs: 0,
      events: EMPTY_EVENTS,
      floorDelta: EMPTY_DELTA,
      kindTable: this.kindTable,
    };
  }

  /**
   * Имена статов сборки (HUD-8) — то, что оболочка кладёт в handshake (SHELL-5):
   * словарь неизменен за сессию, и возить его в каждом кадре незачем.
   */
  get statNames(): readonly string[] {
    return this.out.statNames;
  }

  /** Читает `TickResult` и возвращает плоскую форму; валидна до следующего вызова. */
  extract(result: TickResult): ExtractedTick {
    const state = result.state.world;
    const out = this.out;

    const tickAdvanced = !this.hasTick || result.tick !== this.prevTick;
    const modeChanged = this.hasTick && result.mode !== this.prevMode;
    // Разрыв непрерывности мира: replay, смена ветви истории (`isReplay`
    // оболочки — рост эпохи, SHELL-7) и смена режима — вход в перемотку и
    // выход из неё (REND-2). Скраб ВНУТРИ `Rewinding` разрывом не является:
    // режим тот же, состояния соседних исторических тиков идут подряд, и их
    // ViewBuffer интерполирует как живые — обратный ход обязан выглядеть
    // движением, а не чередой телепортов (REND-2, REND-25). Убывающий номер
    // тика сам по себе snap'а не даёт и давать не должен.
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
    out.statPairs = 0;
    // eslint-disable-next-line @typescript-eslint/prefer-for-of -- baseline
    for (let i = 0; i < alive.length; i++) {
      const entity = alive[i]!;
      if (!world.hasComponent(state, entity, POSITION_COMPONENT)) continue;
      seen.add(entity);

      const fx = world.getField(state, entity, POSITION_COMPONENT, 'x');
      const fy = world.getField(state, entity, POSITION_COMPONENT, 'y');
      // Точка конверсии Q16.16 → float для потока тиков — его входная граница
      // (REND-1). Глубже fixed-point не проникает: всё presentation-состояние
      // ниже — float в мировых единицах.
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
      for (let bit = 0; bit < this.stateComponents.length; bit++) {
        if (world.hasComponent(state, entity, this.stateComponents[bit]!)) {
          flags |= 1 << (bit + STATE_BITS_SHIFT);
        }
      }
      out.flags[count] = flags;
      out.facingYaw[count] = yaw;
      this.readMotion(state, entity, count);
      out.flightPhase[count] = flightPhaseOf(state, entity, this.flight);
      this.stats.read(state, entity, count, out);

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
    out.motion = new Uint8Array(capacity);
    out.motionPhase = new Float32Array(capacity);
    out.flightPhase = new Float32Array(capacity);
    out.statCount = new Uint8Array(capacity);
    // Худший случай — все статы у всех сущностей; перевыделение идёт вместе с
    // прочими колонками, то есть только при росте сцены (SHELL-3).
    out.statIndex = new Int32Array(capacity * this.stats.size);
    out.statValue = new Float64Array(capacity * this.stats.size);
  }

  /**
   * Состояние манёвра и его фаза (REND-4, REND-12). Сущность без компонента
   * состояния — `Normal` без фазы: участие определяется наличием данных, как и
   * в самой симуляции (LOC-1). Незаполненная длительность манёвра даёт `NaN`,
   * то есть «дуги нет», а не деление на ноль.
   */
  private readMotion(state: WorldState, entity: EntityId, index: number): void {
    const out = this.out;
    if (!world.hasComponent(state, entity, this.locomotionState)) {
      out.motion[index] = LOCOMOTION_NORMAL;
      out.motionPhase[index] = Number.NaN;
      return;
    }
    const motion = world.getField(state, entity, this.locomotionState, 'state');
    out.motion[index] = motion;

    const durationField = MANEUVER_DURATION_FIELD[motion];
    let phase = Number.NaN;
    if (
      durationField !== undefined &&
      world.hasComponent(state, entity, this.locomotionConfig)
    ) {
      const total = world.getField(state, entity, this.locomotionConfig, durationField);
      if (total > 0) {
        const left = world.getField(state, entity, this.locomotionState, 'ticksLeft');
        phase = (total - left) / total;
      }
    }
    out.motionPhase[index] = phase;
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
      const caster = event.data.entity ?? event.data.source;
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
    const dirX = event.data.dirX;
    const dirY = event.data.dirY;
    if (dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0)) {
      return Math.atan2(dirY / FIXED_ONE, dirX / FIXED_ONE);
    }
    const cx = world.getField(state, caster, POSITION_COMPONENT, 'x') / FIXED_ONE;
    const cy = world.getField(state, caster, POSITION_COMPONENT, 'y') / FIXED_ONE;
    const px = event.data.x;
    const py = event.data.y;
    if (px !== undefined && py !== undefined) {
      return Math.atan2(py / FIXED_ONE - cy, px / FIXED_ONE - cx);
    }
    const target = event.data.target;
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
