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
/**
 * `release` — фаза `hold` плюс запись шага: прекращение удержания И записывает
 * прицеливание тика в очередной незаполненный шаг (ABIL-5), И завершает фазу.
 * Этим видом описывается «держать, целясь, отпустить» — одной кнопкой, без
 * отдельного бита подтверждения.
 */
export const PHASE_RELEASE = 3;

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

/**
 * Класс баффа (BUFF-2). Значения НОРМАТИВНЫ и следуют порядку закрытого набора,
 * начиная с единицы: по этому полю отбирает контент на рассеивании (BUFF-6), и
 * значение, выбранное реализацией, развело бы два ядра при одном и том же
 * документе сцены (CLI-6). Ноль — «класса ещё нет» (`NO_BUFF_CLASS`).
 */
export const BUFF_POSITIVE = 1;
export const BUFF_NEGATIVE = 2;

/**
 * Политика стакинга (BUFF-3). Коды внутренние: наружу политика адресуется
 * именем из закрытого набора, а в мире её не лежит вовсе — она свойство
 * определения, а не инстанса.
 */
export const STACKING_REFRESH = 0;
export const STACKING_STACK = 1;
export const STACKING_INDEPENDENT = 2;

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
  readonly trigger: 'hold' | 'auto' | 'commit' | 'release';
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

// ------------------------------------------- определение баффа (BUFF-2)

/**
 * Статовая правка (BUFF-4): «список источников — значение-выражение».
 * Постановку и снятие выполняет существующий механизм слотов-модификаторов
 * (TIME-7, TIME-8), а не собственное хранилище платформы.
 */
export interface BuffStatModDef {
  /** Имя компонента-списка источников: `TimeScaleModifiers`, `VisionModifiers`. */
  readonly component: string;
  /** Множитель слота, Q16.16; нейтральное значение свободного слота — `FIXED_ONE`. */
  readonly value: Expression;
}

/** Периодика (BUFF-5): период в тиках и список действий. */
export interface BuffPeriodicDef {
  /** Число тиков — сырое целое (EXPR-2), а не Q16.16. */
  readonly everyTicks: Expression;
  readonly do: readonly Action[];
}

/** Реакция на событие шины текущего тика (BUFF-5, EVT-2). */
export interface BuffTriggerDef {
  readonly type: string;
  /** Имя, которым событие связано в списке действий; по умолчанию `event`. */
  readonly as?: string;
  readonly do: readonly Action[];
}

export interface BuffDef {
  /** Человеко-читаемое имя для авторинга; в мире определение адресует индекс (BUFF-1). */
  readonly id: string;
  readonly class: 'positive' | 'negative';
  /** Отсутствие поля либо неположительное значение — постоянный бафф (BUFF-2, BUFF-6). */
  readonly durationTicks?: Expression;
  readonly stacking?: 'refresh' | 'stack' | 'independent';
  /** Потолок стаков; обязателен при политике `stack` (BUFF-3). */
  readonly maxStacks?: Expression;
  readonly statMods?: readonly BuffStatModDef[];
  readonly periodic?: BuffPeriodicDef;
  readonly triggers?: readonly BuffTriggerDef[];
  readonly onExpire?: readonly Action[];
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
  /** Таблица определений баффов (BUFF-2); от `abilities` независима (SER-7). */
  readonly buffs?: readonly BuffDef[];
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

/** Статовая правка в скомпилированном виде (BUFF-4). */
export interface CompiledStatMod {
  readonly component: string;
  readonly value: Expression;
}

/** Реакция на событие в скомпилированном виде (BUFF-5). */
export interface CompiledBuffTrigger {
  readonly type: string;
  readonly as: string;
  readonly actions: readonly Action[];
}

/**
 * Определение баффа во внутреннем представлении (BUFF-2). Раскладка та же, что
 * у способности, и по той же причине: коды видов числами, списки — срезами
 * общих массивов, списки действий уже провалидированными деревьями (ABIL-10).
 */
export interface CompiledBuff {
  readonly id: string;
  /** Код класса (BUFF-2); имя поля не `class` — оно занято ключевым словом. */
  readonly klass: number;
  readonly durationTicks: Expression | undefined;
  readonly stacking: number;
  /** Потолок стаков; есть ровно при политике `stack`. */
  readonly maxStacks: Expression | undefined;
  readonly statStart: number;
  readonly statCount: number;
  /** Период; есть ровно тогда, когда объявлен блок периодики. */
  readonly everyTicks: Expression | undefined;
  readonly periodic: readonly Action[];
  readonly triggerStart: number;
  readonly triggerCount: number;
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
  /** Таблица определений баффов — та же таблица сцены, тот же разбор (BUFF-2). */
  readonly buffs: readonly CompiledBuff[];
  readonly statMods: readonly CompiledStatMod[];
  readonly buffTriggers: readonly CompiledBuffTrigger[];
  readonly buffIndex: ReadonlyMap<string, number>;
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
