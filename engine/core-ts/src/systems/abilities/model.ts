/**
 * Формат определений способностей (ABIL-2) и их внутреннее представление
 * (ABIL-10).
 *
 * Два набора типов живут вместе намеренно: первый — то, что пишет дизайнер в
 * конфиге сцены (SER-7), второй — то, во что это приводится ОДИН раз на
 * загрузке. Разбор определения на тике не происходит: определения иммутабельны
 * и разделяются всеми слотами, ссылающимися на них.
 *
 * Внутреннее представление плоское — коды видов числами, списки фаз и шагов
 * срезами общих массивов с индексом начала и длиной, списки действий уже
 * провалидированными деревьями. Дерева объектов на способность нет: системы
 * платформы читают эти массивы и на тике не аллоцируют (ABIL-10).
 *
 * Вид способности здесь не хранится и не выводится (ABIL-2): «активная
 * мгновенная», «кастуемая», «таргетная», «аура» — производные от состава
 * блоков, а поля-перечисления вида не существует.
 */
import type { Action } from '../../dsl/actions.js';
import type { SystemDef } from '../../dsl/evaluatedSystem.js';
import type { Expression } from '../../dsl/expr.js';

// ------------------------------------------------------- коды видов (ABIL-2)

/** Вид триггера (ABIL-3). Набор закрыт: расширение — правка требования. */
export const TRIGGER_INPUT = 0;
export const TRIGGER_EVENT = 1;
export const TRIGGER_ALWAYS = 2;

/** Вид перехода фазы (ABIL-4). */
export const PHASE_HOLD = 0;
export const PHASE_AUTO = 1;
export const PHASE_COMMIT = 2;

/** Вид шага прицеливания (ABIL-5). */
export const STEP_NONE = 0;
export const STEP_POINT = 1;
export const STEP_UNIT = 2;
export const STEP_VECTOR = 3;

/**
 * Исход `timeout` (ABIL-4). Неотрицательное значение — индекс фазы в списке
 * определения, отрицательные — зарезервированные исходы и «блока нет».
 */
export const TIMEOUT_NONE = -1;
export const TIMEOUT_COMMIT = -2;
export const TIMEOUT_CANCEL = -3;

/** Судьба кулдауна на прерывании (ABIL-6). */
export const COOLDOWN_REFUND = 0;
export const COOLDOWN_PARTIAL = 1;
export const COOLDOWN_FULL = 2;

/** Судьба накопленного прицеливания на прерывании (ABIL-6). */
export const STAGED_RESET = 0;
export const STAGED_KEEP = 1;

// -------------------------------------------- формат конфига сцены (SER-7)

/**
 * Фигура шага (ABIL-5): словарь общий со словарём форм коллайдера (PHYS-2), и
 * второго словаря фигур не заводится. Конус выражается кругом с полууглом —
 * ровно то, что рукописная система захвата считает сегодня руками.
 */
export interface AbilityShapeDef {
  readonly kind: 'circle' | 'aabb';
  /** Радиус круга. */
  readonly radius?: Expression;
  /** Полуоси AABB. */
  readonly halfX?: Expression;
  readonly halfY?: Expression;
  /** Полуугол сектора; вместе с `circle` это и есть конус. */
  readonly halfAngle?: Expression;
}

export interface AbilityStepDef {
  readonly kind: 'none' | 'point' | 'unit' | 'vector';
  /** Предикат над сущностью-кандидатом; кандидат связан именем `candidate`. */
  readonly filter?: Expression;
  /** Предел расстояния от начала шага, в единицах координат мира. */
  readonly range?: Expression;
  readonly shape?: AbilityShapeDef;
}

export interface AbilityTargetingDef {
  readonly steps: readonly AbilityStepDef[];
}

/**
 * Исход прерывания на пару «фаза, источник» (ABIL-6) и, для источников,
 * распознаваемых по данным определения, — сами эти данные.
 */
export interface AbilityInterruptDef {
  readonly cooldown?: 'refund' | 'partial' | 'full';
  /** Доля кулдауна для `partial` — Q16.16 (например 32768 — половина). */
  readonly refund?: Expression;
  readonly staged?: 'reset' | 'keep';
  /** `disable`: маска лока, пересечение с которой прерывает каст (LOC-7). */
  readonly mask?: number;
  /** `displacement`: предикат над владельцем. */
  readonly when?: Expression;
  /** `damaged`: порог урона за тик; по умолчанию ноль — любой урон. */
  readonly threshold?: Expression;
}

export type AbilityInterruptsDef = Readonly<Record<string, AbilityInterruptDef>>;

export interface AbilityPhaseDef {
  readonly id: string;
  readonly trigger: 'hold' | 'auto' | 'commit';
  /** Число тиков — сырое целое, как номер тика (EXPR-2), а не Q16.16. */
  readonly durationTicks?: Expression;
  readonly onEnter?: readonly Action[];
  readonly onExit?: readonly Action[];
  readonly onCancel?: readonly Action[];
  readonly timeout?: { readonly then: string };
  readonly interrupts?: AbilityInterruptsDef;
}

/** Ровно один из трёх видов (ABIL-3). */
export interface AbilityTriggerDef {
  readonly input?: { readonly bit: number };
  readonly event?: { readonly type: string; readonly as?: string };
  readonly always?: unknown;
}

/** Блок доставки «снаряд» (ABIL-9). */
export interface AbilityProjectileDef {
  readonly onHit?: readonly Action[];
  readonly onFade?: readonly Action[];
}

/** Блок доставки «эффект с длительностью» (ABIL-9). */
export interface AbilityDurationDef {
  readonly onExpire?: readonly Action[];
}

export interface AbilityDef {
  /** Человеко-читаемое имя для авторинга и диагностики; в мире адресует индекс (ABIL-2). */
  readonly id: string;
  readonly trigger: AbilityTriggerDef;
  /** Условие срабатывания сверх триггера (ABIL-3) — предикат определения. */
  readonly condition?: Expression;
  /** Бит подтверждения шага и завершения фазы `commit`; смысл битов — данные сцены (INP-4). */
  readonly confirmBit?: number;
  /** Бит отмены — источник прерывания `cancelInput` (ABIL-6). */
  readonly cancelBit?: number;
  readonly phases?: readonly AbilityPhaseDef[];
  readonly targeting?: AbilityTargetingDef;
  readonly interrupts?: AbilityInterruptsDef;
  readonly cooldownTicks?: Expression;
  readonly effects: readonly Action[];
  readonly projectile?: AbilityProjectileDef;
  readonly duration?: AbilityDurationDef;
}

/**
 * Биндинги сцены (ABIL-8): то, что понятия игрока, здоровья, урона, команды и
 * смерти значат в конкретной сцене. Каждый необязателен, и его отсутствие
 * делает недоступной ровно ту часть платформы, которая на нём стоит.
 */
export interface AbilityRuntimeDef {
  readonly deadMarker?: string;
  readonly actionLock?: string;
  /** Компонент и поле стороны сущности: `["Player", "slot"]`. */
  readonly teamField?: readonly [string, string];
  readonly damageEvent?: {
    readonly type: string;
    readonly entityField: string;
    readonly amountField: string;
  };
  /**
   * Имя компонента ввода (TICK-4). Биндингом ABIL-8 не является — это тот же
   * параметр, что `inputComponent` у локомоушена (LOC-1): раскладку полей
   * пишет `InputSystem`, а имя компонента остаётся выбором сцены.
   */
  readonly inputComponent?: string;
}

/**
 * То, что компиляции нужно от конфига сцены (SER-7). Срез, а не весь `SceneDef`,
 * потому что зависимость обязана идти в одну сторону: загрузчик знает о
 * платформе, платформа о загрузчике — нет.
 *
 * `systems` здесь ради одной проверки: система, публикующая событие урона,
 * обязана стоять раньше системы прерываний (ABIL-6).
 */
export interface AbilityCatalogDef {
  readonly abilities?: readonly AbilityDef[];
  readonly abilityRuntime?: AbilityRuntimeDef;
  readonly systems?: readonly SystemDef[];
}

// ------------------------------------------- внутреннее представление (ABIL-10)

/** Исход одной пары «фаза, источник» (ABIL-6) в скомпилированном виде. */
export interface CompiledOutcome {
  readonly source: number;
  readonly cooldown: number;
  /** Доля для `partial`; у прочих исходов не читается. */
  readonly part: Expression | undefined;
  readonly staged: number;
}

export interface CompiledStep {
  readonly kind: number;
  readonly filter: Expression | undefined;
  readonly range: Expression | undefined;
  /** Код формы из словаря коллайдеров (PHYS-2) либо −1, если фигура не объявлена. */
  readonly shapeKind: number;
  /** Радиус круга либо полуось X прямоугольника. */
  readonly shapeA: Expression | undefined;
  /** Полуось Y прямоугольника. */
  readonly shapeB: Expression | undefined;
  readonly halfAngle: Expression | undefined;
}

export interface CompiledPhase {
  readonly id: string;
  readonly trigger: number;
  readonly durationTicks: Expression | undefined;
  readonly onEnter: readonly Action[];
  readonly onExit: readonly Action[];
  readonly onCancel: readonly Action[];
  readonly timeoutThen: number;
  /** Срез общей таблицы исходов: переопределения этой фазы. */
  readonly outcomeStart: number;
  readonly outcomeCount: number;
}

export interface CompiledAbility {
  readonly id: string;
  readonly triggerKind: number;
  /** Индекс бита триггера при `input`, иначе −1. */
  readonly triggerBit: number;
  /** Тип события при `event`, иначе пустая строка. */
  readonly eventType: string;
  /** Имя, которым связывается событие в списках действий. */
  readonly eventAs: string;
  readonly condition: Expression | undefined;
  readonly confirmBit: number;
  readonly cancelBit: number;
  readonly phaseStart: number;
  readonly phaseCount: number;
  readonly stepStart: number;
  readonly stepCount: number;
  readonly outcomeStart: number;
  readonly outcomeCount: number;
  readonly cooldownTicks: Expression | undefined;
  readonly effects: readonly Action[];
  /** Маска объявленных определением источников прерывания: бит `код − 1`. */
  readonly declared: number;
  /** `disable`: маска лока, названная определением (ABIL-6). */
  readonly disableMask: number;
  /** `displacement`: предикат определения над владельцем. */
  readonly displacement: Expression | undefined;
  /** `damaged`: порог урона за тик. */
  readonly damageThreshold: Expression | undefined;
  readonly onHit: readonly Action[];
  readonly onFade: readonly Action[];
  readonly onExpire: readonly Action[];
}

/**
 * Биндинги сцены, разрешённые по миру: имена уже сверены с составом
 * компонентов, а флаги отвечают на вопросы, которые иначе задавались бы на
 * каждом тике.
 */
export interface CompiledBindings {
  readonly deadMarker: string | undefined;
  readonly actionLock: string | undefined;
  readonly teamComponent: string | undefined;
  readonly teamFieldName: string | undefined;
  readonly damageType: string | undefined;
  readonly damageEntityField: string | undefined;
  readonly damageAmountField: string | undefined;
  readonly inputComponent: string;
  /** Компонент ввода объявлен сценой: без него триггер `input` не срабатывает. */
  readonly hasInput: boolean;
  /** У компонента ввода есть поля точки прицела (TICK-2, фаза протокола ввода). */
  readonly hasAimPoint: boolean;
}

/**
 * Скомпилированная таблица определений сцены. Иммутабельна, строится один раз
 * загрузчиком и живёт на `Simulation` рядом с `TerrainApi` и `ArenaApi`: она
 * порождена данными сцены и в снапшот не входит, как и они (ABIL-1 — состояние
 * способностей целиком лежит в полях компонентов).
 */
export interface AbilityCatalog {
  readonly abilities: readonly CompiledAbility[];
  readonly phases: readonly CompiledPhase[];
  readonly steps: readonly CompiledStep[];
  readonly outcomes: readonly CompiledOutcome[];
  /** `id` определения → его индекс: авторинг и диагностика, не горячий путь. */
  readonly index: ReadonlyMap<string, number>;
  readonly bindings: CompiledBindings;
}

/** Поля компонента ввода, которые читает платформа (TICK-4). */
export const INPUT_BUTTONS_FIELD = 'buttons';
export const INPUT_PREV_BUTTONS_FIELD = 'prevButtons';
export const INPUT_TARGET_X_FIELD = 'targetX';
export const INPUT_TARGET_Y_FIELD = 'targetY';

/**
 * Поле маски компонента лока действий — та же конвенция, что у локомоушена
 * (LOC-7): параметризуется имя компонента, а не раскладка его полей.
 */
export const ACTION_LOCK_MASK_FIELD = 'mask';
