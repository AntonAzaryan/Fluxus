/**
 * Контракты ядра. Реализации живут в соседних модулях; здесь только типы,
 * чтобы модули не зависели друг от друга напрямую (DI-1).
 */

// ---------------------------------------------------------------- fixed-point

/** Q16.16 в контейнере i32 (FP-1). Хранится как обычный `number`, всегда целый. */
export type Fixed = number;

export const FIXED_SHIFT = 16;
export const FIXED_ONE = 1 << FIXED_SHIFT;

export interface Vec2 {
  readonly x: Fixed;
  readonly y: Fixed;
}

/** Обязательная зависимость ядра (DI-2). */
export interface MathApi {
  readonly fromInt: (n: number) => Fixed;
  readonly toInt: (a: Fixed) => number;
  /** Только для ввода констант и тестов — в симуляции float запрещён (DET-2). */
  readonly fromFloat: (n: number) => Fixed;
  readonly toFloat: (a: Fixed) => number;
  readonly add: (a: Fixed, b: Fixed) => Fixed;
  readonly sub: (a: Fixed, b: Fixed) => Fixed;
  readonly mul: (a: Fixed, b: Fixed) => Fixed;
  readonly div: (a: Fixed, b: Fixed) => Fixed;
  readonly abs: (a: Fixed) => Fixed;
  readonly min: (a: Fixed, b: Fixed) => Fixed;
  readonly max: (a: Fixed, b: Fixed) => Fixed;
  readonly clamp: (a: Fixed, lo: Fixed, hi: Fixed) => Fixed;
  readonly sqrt: (a: Fixed) => Fixed;
  readonly vec: {
    readonly add: (a: Vec2, b: Vec2) => Vec2;
    readonly sub: (a: Vec2, b: Vec2) => Vec2;
    readonly scale: (a: Vec2, s: Fixed) => Vec2;
    readonly dot: (a: Vec2, b: Vec2) => Fixed;
    readonly lengthSq: (a: Vec2) => Fixed;
    readonly length: (a: Vec2) => Fixed;
    readonly normalize: (a: Vec2) => Vec2;
  };
}

/** Опциональная зависимость (DI-3): ядро собирается и тикает без неё. */
export interface PhysicsApi {
  readonly raycast: (from: Vec2, to: Vec2, options?: RaycastOptions) => RaycastHit | null;
}

export interface RaycastOptions {
  /** Тег коллайдеров, по которым считается пересечение; для LoS — `blocksVision` (PHYS-6). */
  readonly mask?: string;
  /** Сущность-источник: луч не должен упираться в собственный коллайдер (PHYS-6). */
  readonly ignore?: EntityId;
}

export interface RaycastHit {
  /** Отсутствует, если луч упёрся в статический коллайдер: сущности у него нет. */
  readonly entity?: EntityId;
  readonly point: Vec2;
}

// ------------------------------------------------------------------- terrain

/** Отрезок непроходимой границы между клетками (TERR-5). Выводится из карты уровней, не хранится в ассете. */
export interface CliffEdge {
  readonly from: Vec2;
  readonly to: Vec2;
}

/** Иммутабельная часть террейна: входит в `worldInit` (DET-1) и не снапшотится (TERR-6). */
export interface TerrainGrid {
  readonly width: number;
  readonly height: number;
  /** Размер клетки в Q16.16 — поле ассета, а не константа ядра (TERR-2). */
  readonly tileSize: Fixed;
  /** Уровень клетки, row-major, `[0, 15]` (TERR-1, TERR-3). */
  readonly levels: Uint8Array;
  /** Признак рампы, row-major (TERR-3). */
  readonly ramps: Uint8Array;
  /** Начальное состояние пола из ассета; живое — в компоненте (TERR-6). */
  readonly floor: Uint8Array;
  /** Производная геометрия обрывов; вход для статических коллайдеров физики (TERR-5). */
  readonly cliffs: readonly CliffEdge[];
}

/** Компонент-override уровня (ARENA-6) — вторая и последняя конвенция имён в ядре после `POSITION_COMPONENT`. */
export const LEVEL_OVERRIDE_COMPONENT = 'LevelOverride';

/** Запрос уровня и пола (TERR-4). Опциональна как и физика: сцена без террейна тикает штатно (DI-3). */
export interface TerrainApi {
  readonly grid: TerrainGrid;
  readonly levelAt: (position: Vec2) => number;
  /** Уровень сущности: override, если он есть, иначе производное от позиции (TERR-4, ARENA-6). */
  readonly levelOf: (entity: EntityId) => number;
  readonly hasFloorAt: (position: Vec2) => boolean;
}

// ---------------------------------------------------------------------- ecs

/** Непрозрачный идентификатор: упаковка index+generation — деталь реализации (ID-1). */
export type EntityId = number;

/** Закрытый набор — из него же порождается JSON-схема компонента (SER-5). */
export const FIELD_TYPES = ['i32', 'fixed'] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** JSON-схема компонента (ECS-3). Float-полей нет по DET-2. */
export interface ComponentSchema {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldType>>;
  readonly defaults?: Readonly<Record<string, number>>;
}

/** SoA-хранилище компонента: поле → TypedArray, индексируемый по index сущности (ECS-1). */
export type ComponentStore = Readonly<Record<string, Int32Array>>;

/** Имя компонента позиции — единственная конвенция, на которую опирается `withinRadius`. */
export const POSITION_COMPONENT = 'Position';

export interface QuerySpec {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
  readonly not?: readonly string[];
  readonly withinRadius?: { readonly center: Vec2; readonly radius: Fixed };
  readonly withTag?: string;
}

/** Переопределение значений полей prefab'а при спавне: компонент → поле → значение (CMD-6). */
export type FieldOverrides = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Единственный канал мутаций для системы (DET-7, CMD-1, CMD-4). */
export interface CommandBuffer {
  spawn(prefab: string, overrides?: FieldOverrides): void;
  destroy(entity: EntityId): void;
  addComponent(entity: EntityId, component: string, values?: Readonly<Record<string, number>>): void;
  removeComponent(entity: EntityId, component: string): void;
  setField(entity: EntityId, component: string, field: string, value: number): void;
}

// ---------------------------------------------------------------------- rng

export interface RngStream {
  /** Следующее значение генератора, u32 (RNG-1). */
  next(): number;
  /** Равномерное целое в [0, bound). */
  nextBelow(bound: number): number;
  /** Равномерное значение в [0, 1) как Q16.16. */
  nextFixed(): Fixed;
  /** Состояние для снапшота (RNG-5). */
  getState(): Uint32Array;
  setState(state: Uint32Array): void;
}

export interface RngStreams {
  /** Без аргумента — основной стрим системы, `hash(worldSeed, name)` (RNG-4). */
  stream(subStream?: string): RngStream;
}

// -------------------------------------------------------------------- events

export interface GameEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, number>>;
}

/** Read-only view на события тика (OBS-1, OBS-4). */
export interface ReadonlyEventLog {
  readonly length: number;
  at(index: number): GameEvent;
  [Symbol.iterator](): Iterator<GameEvent>;
}

export interface EventEmitter {
  emit(type: string, data?: Readonly<Record<string, number>>): void;
}

// ------------------------------------------------------------------- systems

export interface SystemContext {
  readonly tick: number;
  /** Float64Array, а не Uint32Array: EntityId 48-битный и в 32 бита не влезает (ID-1). */
  readonly query: (spec: QuerySpec) => Float64Array;
  readonly get: (entity: EntityId, component: string, field: string) => number;
  readonly has: (entity: EntityId, component: string) => boolean;
  readonly isAlive: (entity: EntityId) => boolean;
  readonly commands: CommandBuffer;
  readonly events: EventEmitter;
  readonly rng: RngStreams;
  readonly math: MathApi;
  readonly physics?: PhysicsApi;
  /** Есть, если сцена содержит террейн (TERR-4). */
  readonly terrain?: TerrainApi;
  readonly inputs: readonly InputFrame[];
}

export interface System {
  readonly name: string;
  /** Порядок исполнения; равные order недопустимы (DET-3). */
  readonly order: number;
  run(ctx: SystemContext): void;
}

// ---------------------------------------------------------------- tick loop

/** Ввод на пару (игрок, тик) — TICK-2. */
export interface InputFrame {
  readonly tick: number;
  readonly playerId: string;
  readonly seq: number;
  readonly move: Vec2;
  readonly aimDir: Fixed;
  readonly buttons: number;
}

export type WorldMode = 'Running' | 'Paused' | 'Rewinding';

/** Заглушка до этапа 14: интерфейс финальный, наполнение появится с dirty-tracking (OBS-6). */
export interface ChangeSet {
  readonly isEmpty: boolean;
  changedEntities(component: string): ReadonlySet<EntityId>;
}

export interface TickResult {
  readonly state: SimulationState;
  readonly tick: number;
  readonly mode: WorldMode;
  readonly isReplay: boolean;
  readonly events: ReadonlyEventLog;
  readonly changes: ChangeSet;
}

export interface TickObserver {
  readonly name: string;
  /** Единственное место, где легальны side-effect'ы (OBS-2). */
  onTick(result: TickResult): void;
}

/**
 * Непрозрачное содержимое ECS. Структура — деталь реализации `ecs/world.ts`;
 * снаружи меняется только через `tick()` (TICK-3).
 */
export interface WorldState {
  readonly __brand: 'WorldState';
}

/** Состояние одного RNG-стрима: четыре u32 плюс имя (RNG-5). */
export interface RngStreamState {
  readonly name: string;
  readonly state: Uint32Array;
}

/** Реестр именованных стримов; его состояние входит в снапшот мира (RNG-5, SNAP-1). */
export interface RngRegistry {
  forSystem(systemName: string): RngStreams;
  snapshot(): RngStreamState[];
  restore(entries: readonly RngStreamState[]): void;
}

/**
 * Состояние симуляции. Мутабельно (TICK-1): `tick()` продвигает его на месте,
 * а история прошлого живёт снапшотами в `HistoryProvider` (SNAP-4), а не
 * копией на каждом тике.
 */
export interface SimulationState {
  readonly world: WorldState;
  tick: number;
  readonly rng: RngRegistry;
}

/** Полная копия состояния для истории — то, из чего восстанавливается тик (SNAP-1). */
export interface Snapshot {
  readonly tick: number;
  readonly world: WorldState;
  readonly rng: readonly RngStreamState[];
}
