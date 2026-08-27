/**
 * Форма документа поведения NPC (`npc-behavior` NPC-2) и её скомпилированное
 * представление.
 *
 * Разрез — тот же, что у пары «JSON-система / ядро-evaluator»: ПОЛИТИКА
 * (состав состояний и фаз, переходы, правила выбора цели и действия, пороги и
 * веса) живёт документом дерева контента, МЕХАНИЗМ (исполнение состояний,
 * threat-таблица, вычисление скоринга, применение через Command Buffer) —
 * кодом. Имена состояний и действий в механизме ветвлениями «по имени» не
 * живут: состояние адресуется индексом, действие — кодом исполнителя из
 * закрытого словаря (NPC-2).
 *
 * Числа документа — Q16.16 целыми, как всюду в контенте сцены: симуляция
 * считает в фиксированной точке (DET-2), и перевода из долей на загрузке здесь
 * нет ни одного.
 */
import type { FixedCurve, ScoringCurveType } from '../../dsl/scoring.js';
import type { Fixed } from '../../types.js';

/** Версия формы документа поведения NPC (NPC-2). */
export const NPC_BEHAVIOR_SCHEMA = 1;

/**
 * Tier — данные определения, разводящие массовых и особых агентов (NPC-4).
 * Он не «сложность» и не «сила»: единственное, что tier значит механизму, —
 * право решать каждый тик. Всё остальное различие живёт числами документа.
 */
export const NPC_TIERS = ['mass', 'elite'] as const;

export type NpcTier = (typeof NPC_TIERS)[number];

export const TIER_MASS = 0;
export const TIER_ELITE = 1;

/**
 * Исполнители — ЗАКРЫТЫЙ словарь кодовых веток (NPC-2). Документ выбирает
 * между ними и сочинить нового из примитивов не может: новый исполнитель —
 * правка кода с ревью, как новая нативная система рядом с JSON-системами.
 *
 * - `hold` — стоять; исполненное решение (идущий каст, атака в контакте)
 *   продолжается независимо (NPC-4);
 * - `followRoute` — идти по маршруту волны (NPC-6);
 * - `seekTarget` — сближаться с текущей целью;
 * - `cast` — публиковать событие способности; сам каст идёт штатной машиной
 *   фаз (NPC-7, ABIL-3/ABIL-4), второго пути исполнения способностей нет.
 */
export const NPC_EXECUTORS = ['hold', 'followRoute', 'seekTarget', 'cast'] as const;

export type NpcExecutor = (typeof NPC_EXECUTORS)[number];

export const EXEC_HOLD = 0;
export const EXEC_FOLLOW_ROUTE = 1;
export const EXEC_SEEK_TARGET = 2;
export const EXEC_CAST = 3;

/**
 * Входы considerations — ЗАКРЫТЫЙ словарь наблюдений, нормированных в [0, 1]
 * (NPC-3). Словарь СВОЙ, а не общий с ботом: у бота входы производны от его
 * отфильтрованного наблюдения (BOT-3), у NPC — от прямого чтения мира (NPC-1).
 * Общая у двух потребителей форма оценки, а не источники значений.
 *
 * - `always` — единица; ось-константа для действия без условий;
 * - `targetKnown` — есть ли живая цель;
 * - `targetDistance` — расстояние до цели в масштабе `ranges.sense`;
 * - `healthFraction` — доля здоровья агента (биндинг сцены);
 * - `crowding` — теснота: соседи-агенты в радиусе `ranges.separation`
 *   в масштабе ёмкости threat-таблицы;
 * - `stateElapsed` — сколько агент в текущем состоянии, в масштабе
 *   `decision.intervalTicks`;
 * - `routeRemaining` — осталось ли куда идти по маршруту.
 */
export const NPC_INPUTS = [
  'always',
  'targetKnown',
  'targetDistance',
  'healthFraction',
  'crowding',
  'stateElapsed',
  'routeRemaining',
] as const;

export type NpcInput = (typeof NPC_INPUTS)[number];

export const INPUT_ALWAYS = 0;
export const INPUT_TARGET_KNOWN = 1;
export const INPUT_TARGET_DISTANCE = 2;
export const INPUT_HEALTH_FRACTION = 3;
export const INPUT_CROWDING = 4;
export const INPUT_STATE_ELAPSED = 5;
export const INPUT_ROUTE_REMAINING = 6;

/**
 * Условия переходов HFSM — ЗАКРЫТЫЙ словарь (NPC-2, NPC-7). Ровно то, что
 * называет NPC-7: пороги доли здоровья, таймеры в тиках и события шины, плюс
 * условия о цели и маршруте, без которых крип не переходит из погони в атаку.
 */
export const NPC_CONDITIONS = [
  'healthBelow',
  'healthAbove',
  'elapsed',
  'event',
  'targetWithin',
  'targetBeyond',
  'hasTarget',
  'noTarget',
  'routeDone',
] as const;

export type NpcConditionKind = (typeof NPC_CONDITIONS)[number];

export const COND_HEALTH_BELOW = 0;
export const COND_HEALTH_ABOVE = 1;
export const COND_ELAPSED = 2;
export const COND_EVENT = 3;
export const COND_TARGET_WITHIN = 4;
export const COND_TARGET_BEYOND = 5;
export const COND_HAS_TARGET = 6;
export const COND_NO_TARGET = 7;
export const COND_ROUTE_DONE = 8;

// ------------------------------------------------------------- документ (NPC-2)

/** Кривая отклика документа NPC: форма общей модели, параметры — Q16.16 (NPC-3). */
export interface NpcCurveDef {
  readonly type: ScoringCurveType;
  readonly [param: string]: string | number;
}

export interface NpcConsiderationDef {
  readonly input: NpcInput;
  readonly curve: NpcCurveDef;
  readonly weight: Fixed;
}

export interface NpcActionDef {
  readonly executor: NpcExecutor;
  /** Тип публикуемого события — только у `cast` (NPC-7). */
  readonly event?: string;
  readonly considerations: readonly NpcConsiderationDef[];
}

export interface NpcConditionDef {
  readonly kind: NpcConditionKind;
  /** Порог Q16.16 — у условий о здоровье и дистанции. */
  readonly value?: Fixed;
  /** Срок в тиках — у `elapsed`. */
  readonly ticks?: number;
  /** Тип события шины — у `event`. */
  readonly event?: string;
  /**
   * Поле события, в котором лежит АДРЕСАТ, — у `event`. Имя поля принадлежит
   * сцене, а не механизму (NPC-2): одна сцена зовёт получателя `entity`, другая
   * `target`, и угадывать за них платформа не вправе — тем же порядком, каким
   * источник угрозы называет свои `victimField`/`sourceField`.
   *
   * Отсутствует — переход срабатывает на СОБЫТИИ ТИПА, кому бы оно ни было
   * адресовано: так выражается общий сигнал сцены («колонна разрушена»).
   */
  readonly entityField?: string;
}

export interface NpcTransitionDef {
  /** Имя состояния-адресата; в скомпилированном виде — индекс. */
  readonly to: string;
  readonly when: NpcConditionDef;
}

export interface NpcStateDef {
  readonly name: string;
  readonly actions: readonly NpcActionDef[];
  /**
   * Переходы в порядке документа. Порядок нормативен: срабатывает первый
   * выполнившийся — иначе исход зависел бы от порядка ключей объекта.
   */
  readonly transitions?: readonly NpcTransitionDef[];
}

/** Источник угрозы: событие шины, его поля и вес (NPC-5). */
export interface NpcThreatSourceDef {
  readonly event: string;
  /** Поле события с сущностью-получателем угрозы (сам агент). */
  readonly victimField: string;
  /** Поле события с сущностью-источником угрозы. */
  readonly sourceField: string;
  /**
   * Поле события с величиной. Величина — ЦЕЛЫЙ СЧЁТЧИК сцены (единицы урона,
   * лечения), а не доля Q16.16: угроза есть вес документа, помноженный на него.
   * Отсутствует — вес засчитывается как есть, то есть событие весит одинаково
   * независимо от своей величины (так выражается провокация).
   */
  readonly amountField?: string;
  readonly weight: Fixed;
}

export interface NpcThreatDef {
  /**
   * Насколько новая цель должна превзойти текущую, чтобы агент переключился
   * (NPC-5). Доля Q16.16 сверх текущей угрозы — то самое «110% угрозы лидера»
   * MMO-порядка, только числом документа, а не кодом.
   */
  readonly switchMargin: Fixed;
  /** Множитель забывания за тик, Q16.16; единица — не забывать. */
  readonly decayPerTick?: Fixed;
  readonly sources: readonly NpcThreatSourceDef[];
}

/** Дистанции поведения (NPC-6): все — Q16.16 мировые расстояния. */
export interface NpcRangesDef {
  /** Радиус, в котором агент вообще замечает цели; масштаб входа `targetDistance`. */
  readonly sense: Fixed;
  /** Радиус, ближе которого агент считается в контакте. */
  readonly attack: Fixed;
  /** Радиус достижения точки маршрута. */
  readonly arrive: Fixed;
  /** Радиус локального расхождения (NPC-6). */
  readonly separation: Fixed;
}

export interface NpcBehaviorDef {
  readonly schema: number;
  readonly name: string;
  readonly tier: NpcTier;
  /** Интервал пересмотра решений в тиках (NPC-4); у `elite` — единица. */
  readonly decision: { readonly intervalTicks: number };
  readonly ranges: NpcRangesDef;
  /** Желаемая скорость движения, Q16.16 единиц за тик умножается физикой. */
  readonly speed: Fixed;
  /** Сила расхождения относительно скорости, Q16.16 доля (NPC-6). */
  readonly separationWeight?: Fixed;
  /**
   * Тиков между пересчётами вектора локального расхождения (NPC-6). Между
   * пересчётами применяется последний пересчитанный вектор, поэтому число это —
   * свежесть исполнения, а не решение (NPC-4). Умолчание нормирует NPC-2;
   * документ, которому нужен потиковый пересчёт, называет единицу, а ноль —
   * находка валидации, а не «выключить расхождение».
   */
  readonly separationIntervalTicks?: number;
  /**
   * Масштабы входов, у которых своей шкалы в мире нет (NPC-3): «долго ли в
   * состоянии» и «насколько тесно». Их умолчания нормирует NPC-2.
   */
  readonly scales?: {
    /** Тиков, за которые `stateElapsed` доходит до единицы. */
    readonly elapsedTicks?: number;
    /** Соседей, при которых `crowding` доходит до единицы. */
    readonly crowd?: number;
  };
  readonly threat?: NpcThreatDef;
  /** Состояния HFSM; первое — начальное (NPC-2). */
  readonly states: readonly NpcStateDef[];
}

// ---------------------------------------------- скомпилированный вид (NPC-2)

export interface CompiledConsideration {
  readonly input: number;
  readonly curve: FixedCurve;
  readonly weight: Fixed;
}

export interface CompiledAction {
  readonly executor: number;
  /** Тип события у `cast`, иначе пустая строка. */
  readonly eventType: string;
  readonly considerations: readonly CompiledConsideration[];
}

export interface CompiledTransition {
  readonly to: number;
  readonly kind: number;
  readonly value: Fixed;
  readonly ticks: number;
  readonly eventType: string;
  /** Поле адресата события; пустая строка — событие адресата не называет. */
  readonly eventEntityField: string;
}

export interface CompiledState {
  readonly name: string;
  readonly actions: readonly CompiledAction[];
  readonly transitions: readonly CompiledTransition[];
}

export interface CompiledThreatSource {
  readonly eventType: string;
  readonly victimField: string;
  readonly sourceField: string;
  /** Пустая строка — величины у события нет, вес засчитывается как есть. */
  readonly amountField: string;
  readonly weight: Fixed;
}

export interface CompiledBehavior {
  readonly name: string;
  readonly tier: number;
  readonly intervalTicks: number;
  readonly sense: Fixed;
  readonly attack: Fixed;
  readonly arrive: Fixed;
  readonly separation: Fixed;
  readonly speed: Fixed;
  readonly separationWeight: Fixed;
  /** Тиков между пересчётами вектора расхождения (NPC-6); минимум единица. */
  readonly separationIntervalTicks: number;
  /** Тиков до единицы у входа `stateElapsed`. */
  readonly elapsedScale: number;
  /** Соседей до единицы у входа `crowding`. */
  readonly crowdScale: number;
  readonly switchMargin: Fixed;
  readonly decayPerTick: Fixed;
  readonly threatSources: readonly CompiledThreatSource[];
  readonly states: readonly CompiledState[];
}

/** Биндинги сцены (NPC-1): что в этой сцене значат позиция, скорость, здоровье и сторона. */
export interface NpcBindingsDef {
  readonly position?: string;
  readonly velocity?: string;
  readonly health?: readonly [string, string];
  readonly healthMax?: readonly [string, string];
  readonly team?: readonly [string, string];
  readonly deadMarker?: string;
}

export interface CompiledNpcBindings {
  readonly position: string;
  readonly velocity: string;
  readonly healthComponent: string;
  readonly healthField: string;
  readonly healthMaxComponent: string;
  readonly healthMaxField: string;
  readonly teamComponent: string;
  readonly teamField: string;
  readonly deadMarker: string;
  readonly hasHealth: boolean;
  readonly hasTeam: boolean;
}

/** Запись таблицы волн (NPC-8). */
export interface NpcWaveDef {
  readonly prefab: string;
  readonly count: number;
  /** Индекс документа поведения выпускаемых бойцов. */
  readonly behavior: number;
  /** Тиков от конца прошлой волны до первого бойца этой. */
  readonly delayTicks: number;
  /** Тиков между бойцами волны. */
  readonly spacingTicks: number;
  /** Маршрут волны (NPC-6); отсутствует — бойцы встают в точку `x`/`y`. */
  readonly route?: number;
  readonly x?: Fixed;
  readonly y?: Fixed;
}

export interface NpcWavesDef {
  /** Предел одновременно активных NPC — данные сцены (NPC-8). */
  readonly cap: number;
  readonly entries: readonly NpcWaveDef[];
}

/** Конфиг платформы поведения NPC в документе сцены (SER-7, NPC-2). */
export interface NpcPlatformDef {
  readonly behaviors: readonly NpcBehaviorDef[];
  readonly bindings?: NpcBindingsDef;
  /**
   * Предел дорогих пересмотров решений на тик (NPC-4). Не задан — предел равен
   * числу агентов, то есть каденс держится одним интервалом.
   */
  readonly decisionBudget?: number;
  readonly waves?: NpcWavesDef;
}

/** Скомпилированная таблица платформы: то, что живёт на `Simulation` рядом с террейном. */
export interface NpcCatalog {
  readonly behaviors: readonly CompiledBehavior[];
  readonly bindings: CompiledNpcBindings;
  readonly decisionBudget: number;
  readonly waves: NpcWavesDef | undefined;
}
