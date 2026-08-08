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
  /** Угол — binary angle measure: оборот = 2^16, т.е. Q16.16-доля оборота (FP-7). */
  readonly sin: (a: Fixed) => Fixed;
  readonly cos: (a: Fixed) => Fixed;
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
  /**
   * Радиус вписанной окружности коллайдера сущности (ARENA-5): у круга — его
   * радиус, у AABB — меньшая полуось. `undefined` — коллайдера на сущности нет.
   * Живёт в Physics API, а не в арене: имя компонента коллайдера — параметр
   * физики (PHYS-2), и второй конвенции имён ядро не вводит.
   */
  readonly inradiusOf: (entity: EntityId) => Fixed | undefined;
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

// ---------------------------------------------------------------- navigation

/**
 * Поиск пути (NAV-1). Опциональная зависимость (DI-4): в отличие от физики,
 * необязательна и для этой игры — крипов и NPC в MVP нет. Реализации в ядре
 * пока нет: зафиксирован только шов, через который она войдёт.
 */
export interface NavigationApi {
  readonly findPath: (from: Vec2, to: Vec2, options?: PathRequestOptions) => PathResult;
}

export interface PathRequestOptions {
  /** Радиус агента: проход уже его диаметра путём не считается. Величина контента, не ядра (NAV-1). */
  readonly agentRadius?: Fixed;
}

/**
 * `unreachable` — ответ о геометрии, `budgetExhausted` — исчерпан бюджет поиска;
 * исходы различимы намеренно, политика реагирует на них по-разному (NAV-5).
 */
export type PathStatus = 'found' | 'unreachable' | 'budgetExhausted';

export interface PathResult {
  readonly status: PathStatus;
  /**
   * Промежуточные цели в мировых координатах; последняя — конечная точка запроса.
   * `from` не входит, при статусе кроме `found` список пуст (NAV-1).
   */
  readonly waypoints: readonly Vec2[];
}

// ------------------------------------------------------------------- terrain

/** Отрезок непроходимой границы между клетками (TERR-5). Выводится из карты уровней, не хранится в ассете. */
export interface CliffEdge {
  readonly from: Vec2;
  readonly to: Vec2;
  /**
   * Уровни клеток по обе стороны ребра (TERR-5): направленный гейт обрыва
   * (PHYS-11) читает подъём из отрезка, не обращаясь к карте уровней второй
   * раз. Сторона — по оси нормали ребра: `levelNeg` — клетка с меньшей
   * координатой, `levelPos` — с большей.
   */
  readonly levelNeg: number;
  readonly levelPos: number;
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

/** Компонент-override уровня (ARENA-6) — конвенция имён в ядре наравне с `POSITION_COMPONENT`. */
export const LEVEL_OVERRIDE_COMPONENT = 'LevelOverride';

/** Компонент множителя симуляционной скорости (TIME-2); читается в `getEffectiveDelta`. */
export const TIME_SCALE_COMPONENT = 'TimeScale';

/** Запрос уровня и пола (TERR-4). Опциональна как и физика: сцена без террейна тикает штатно (DI-3). */
export interface TerrainApi {
  readonly grid: TerrainGrid;
  readonly levelAt: (position: Vec2) => number;
  /** Уровень сущности: override, если он есть, иначе производное от позиции (TERR-4, ARENA-6). */
  readonly levelOf: (entity: EntityId) => number;
  readonly hasFloorAt: (position: Vec2) => boolean;
  /**
   * Есть ли пол под опорной областью — кругом вокруг позиции (ARENA-5).
   * Пересечение круга с клеткой включающее (касание — опора), круг вне сетки
   * отвечает по ближайшей клетке — та же тотальность, что у `levelAt` (TERR-4).
   */
  readonly hasFloorWithin: (position: Vec2, radius: Fixed) => boolean;
  /**
   * Носитель карты пола (TERR-6): снятие пола адресует его команды буфера
   * (TERR-8). Поле, а не поиск по тегу prefab'а: тег — способ найти сущность
   * из контента, каналом механизма он быть не должен.
   */
  readonly floorEntity: EntityId;
}

// --------------------------------------------------------------------- arena

/**
 * Граница арены (ARENA-1..2). Центр иммутабелен и живёт здесь, радиус
 * мутабелен и лежит в компоненте на `entity`: сужение обязано попадать в
 * снапшот и откатываться вместе с миром (ARENA-4, SNAP-1).
 */
export interface ArenaApi {
  /** Носитель мутабельного радиуса: политика меняет его через `commands.setField` (ARENA-4). */
  readonly entity: EntityId;
  readonly center: Vec2;
  readonly radius: () => Fixed;
  /** Принадлежность точки арене, граница включающая (ARENA-2). */
  readonly contains: (position: Vec2) => boolean;
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
  /**
   * Значение поля, уже поставленное командой в этом буфере, либо `undefined`,
   * если команд на это поле в нём нет (CMD-5). Чтение точечное: перечисления
   * накопленных команд нет и быть не должно — оно сделало бы их состав и
   * порядок наблюдаемыми для систем.
   *
   * Нужно распределителям фиксированных слотов (TIME-7): мир до flush команд не
   * видит, и без этого чтения два добавления подряд сели бы в один слот. Другой
   * вариант — оверлей вне мира, который TICK-4 запрещает.
   */
  peekField(entity: EntityId, component: string, field: string): number | undefined;
}

// ---------------------------------------------------------------- modifiers

/**
 * Список источников-модификаторов одного компонента (TIME-7, FOW-3):
 * `{ sources: [{id, value}] }`, разложенный по фиксированным слотам
 * `id{N}`/`value{N}` (массивов в ECS нет, ECS-3). Экземпляр создаётся на сцену
 * загрузчиком (SER-7) — модульным синглтоном быть не может, иначе две
 * симуляции в одном процессе делили бы состояние (DI-1).
 *
 * Контракт живёт здесь, а реализация — в `systems/modifiers.ts`: на него
 * ссылается `SystemContext`, а `types.ts` не импортирует из `systems/`.
 */
export interface ModifierList {
  readonly component: string;
  readonly slots: number;
  readonly schema: ComponentSchema;
  /**
   * Произведение значений занятых слотов, клампленное в `[lo, hi]`. У
   * сущности без компонента источников — `FIXED_ONE`.
   */
  product(ctx: SystemContext, entity: EntityId, lo: Fixed, hi: Fixed): Fixed;
  /** Добавляет или обновляет источник по `id`. Бросает, если свободных слотов нет. */
  add(ctx: SystemContext, entity: EntityId, id: number, value: Fixed): void;
  /** Снимает источник по `id`; отсутствующий id — не ошибка (TIME-8). */
  remove(ctx: SystemContext, entity: EntityId, id: number): void;
}

/** Списки источников сцены по имени компонента: адрес действия `addModifier` — данные (ACT-1). */
export type ModifierRegistry = ReadonlyMap<string, ModifierList>;

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

/**
 * Шина тика целиком. Живёт в `SimulationState`, а не внутри `tick()`: события
 * входят в снапшот и откатываются вместе с миром (SNAP-1, REW-10).
 */
export interface EventLog extends EventEmitter, ReadonlyEventLog {
  clear(): void;
  restore(events: readonly GameEvent[]): void;
}

// --------------------------------------------------------------- diagnostics

/**
 * Уровень детализации трейса (DIAG-3). Регулирует объём штатной телеметрии и
 * НЕ выключает диагностику нарушенных инвариантов: при подключённом sink'е она
 * идёт на любом уровне, включая `off`.
 */
export const TRACE_LEVELS = ['off', 'systems', 'full'] as const;

export type TraceLevel = (typeof TRACE_LEVELS)[number];

/** Вид записи (DIAG-2). */
export type DiagnosticKind = 'assert' | 'invariant' | 'systemBegin' | 'systemEnd' | 'command' | 'event';

/** Важность записи (DIAG-2). Не путать с `TraceLevel` — это про сигнал, а не про объём. */
export type DiagnosticLevel = 'info' | 'warn' | 'error';

/**
 * Исход команды, определяемый на flush (DIAG-5). `dropped:dead-target` и
 * `overwritten` — штатные исходы, а не ошибки: CMD-7 объявляет отбрасывание
 * молчаливым, CMD-3 — перекрытие последней командой нормой.
 */
export type CommandOutcome = 'applied' | 'dropped:dead-target' | 'overwritten';

/**
 * Стабильные коды записей (DIAG-2). Идентификатор записи — код, а не текст
 * сообщения: формулировки правятся при вычитке, а потребители отбирают
 * записи автоматически.
 */
export const DIAGNOSTIC_CODES = [
  // нарушенные инварианты (FP-4)
  'ASSERT',
  'INVARIANT',
  'FIXED_OVERFLOW',
  'FIXED_DIV_BY_ZERO',
  'FIXED_SQRT_NEGATIVE',
  'ENTITY_CAPACITY_EXCEEDED',
  'ENTITY_GENERATION_OVERFLOW',
  'ENTITY_ID_OUT_OF_RANGE',
  'MASK_INDEX_OUT_OF_RANGE',
  'MASK_COMPONENT_OUT_OF_RANGE',
  'RNG_BOUND_INVALID',
  'SINK_THREW',
  // трейс
  'SYSTEM_BEGIN',
  'SYSTEM_END',
  'COMMAND',
  'EVENT',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** Данные записи: только скаляры — запись обязана быть самодостаточной (DIAG-4). */
export type DiagnosticData = Readonly<Record<string, number | string>>;

/**
 * Запись диагностики (DIAG-2). Отметки реального времени в ней нет намеренно:
 * часы здесь — пара «тик, порядковый номер», иначе трейс перестал бы быть
 * воспроизводимым (DIAG-6).
 */
export interface DiagnosticRecord {
  readonly tick: number;
  /** Сквозной номер внутри тика: задаёт порядок записей всех видов (DIAG-2). */
  readonly seq: number;
  /** Система, в границах которой возникла запись; вне систем отсутствует. */
  readonly system?: string;
  readonly kind: DiagnosticKind;
  readonly level: DiagnosticLevel;
  readonly code: DiagnosticCode;
  readonly data?: DiagnosticData;
  /** Только у записей о командах (DIAG-5). */
  readonly outcome?: CommandOutcome;
  /** Только в debug-сборке (FP-4): текст свободен и частью API не является. */
  readonly message?: string;
}

/**
 * Приёмник диагностики (DIAG-1). Опциональная зависимость сборки (DI-5):
 * живёт на `Simulation` рядом с Physics/Navigation API, а не в состоянии
 * симуляции и не в модульной переменной — иначе две симуляции в одном
 * процессе делили бы приёмник (DI-1).
 *
 * Контракт потребителя (DIAG-4): `record` MUST NOT бросать. Исключение из
 * середины применения команд оставило бы мир мутированным частично, то есть
 * наблюдатель изменил бы ход симуляции.
 */
export interface DiagnosticsSink {
  readonly trace: TraceLevel;
  record(entry: DiagnosticRecord): void;
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
  /** Публикация и чтение шины тика (EVT-2): система видит события систем с меньшим `order`. */
  readonly events: EventEmitter & ReadonlyEventLog;
  readonly rng: RngStreams;
  readonly math: MathApi;
  readonly physics?: PhysicsApi;
  /** Есть, если навигация собрана (DI-4); сцена без неё тикает штатно (NAV-6). */
  readonly navigation?: NavigationApi;
  /** Есть, если сцена содержит террейн (TERR-4). */
  readonly terrain?: TerrainApi;
  /** Есть, если сцена содержит арену (ARENA-1). */
  readonly arena?: ArenaApi;
  /** Списки источников-модификаторов сцены (TIME-7, FOW-3); адресуются по имени компонента. */
  readonly modifiers?: ModifierRegistry;
  readonly inputs: readonly InputFrame[];
  /**
   * `globalDelta * TimeScale.value` с клампом стакинга (TIME-3, TIME-7).
   * Учитывать его или нет — решает каждая система сама (TIME-4).
   */
  readonly getEffectiveDelta: (entity: EntityId, globalDelta: Fixed) => Fixed;
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
  /** Шина текущего тика; входит в снапшот и откатывается (REW-10). */
  readonly events: EventLog;
  /** Режим мира (WSM-1); переключается только через `RewindController` (WSM-5). */
  mode: WorldMode;
}

/** Полная копия состояния для истории — то, из чего восстанавливается тик (SNAP-1). */
export interface Snapshot {
  readonly tick: number;
  readonly world: WorldState;
  readonly rng: readonly RngStreamState[];
  readonly events: readonly GameEvent[];
  readonly mode: WorldMode;
}

/**
 * История снапшотов за интерфейсом (SNAP-2): rewind-ульта и netcode-
 * reconciliation используют разные реализации с разными интервалом и глубиной
 * (SNAP-4), а не общий компромиссный буфер.
 */
export interface HistoryProvider {
  /** Снимает снапшот, если текущий тик подходит под политику провайдера (SNAP-4). */
  record(state: SimulationState): void;
  /** Ближайший снапшот с тиком ≤ `tick`; при более глубоком запросе — самый старый (REW-1). */
  nearest(tick: number): Snapshot | undefined;
  /** Самый старый доступный тик — предел глубины перемотки (REW-1). */
  readonly oldestTick: number | undefined;
  readonly newestTick: number | undefined;
}
