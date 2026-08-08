/**
 * @contribution
 *
 * Слоты блока действия — конвенция имён аргументов Action DSL (SYS-3), и
 * ничего кроме неё.
 *
 * Источник ровно один: `switch` в `checkAction` (`core-ts/src/dsl/
 * evaluatedSystem.ts`). Он перечисляет, КАК ядро обходит аргумент с таким
 * именем — как список действий, как карту «поле → выражение», как выражение,
 * как запрос, как переопределения или как строковый литерал. Конвенция
 * нормативна (SYS-3), а не деталь реализации, поэтому знать её редактору
 * можно; знать что-то сверх неё — нельзя.
 *
 * Чего здесь нет и не заводится: таблицы «действие → его аргументы». Персонального
 * набора аргументов у ядра нет — оно его не хранит и не проверяет («Аргумент вне
 * конвенции содержимым не проверяется — предел, зафиксированный в SYS-3»), —
 * а таблица в редакторе была бы второй реализацией семантики DSL, которую ED-1
 * запрещает прямым текстом. Она разъехалась бы с оригиналом при первом же новом
 * аргументе у существующего действия, и тест на покрытие имён этого не поймал бы:
 * имена-то на месте.
 *
 * Следствие принимается честно: автору может быть предложен слот, который
 * выбранное действие игнорирует (`cond` у `spawnEntity`). Стоит он ноль —
 * незаполненный слот в документ не пишется (`build.ts`), — а что осмысленно у
 * этого действия, объясняет его описание (ресурс `action.*`, ED-28).
 *
 * Аргумент, которого в конвенции нет (`def` и `duration` у `addTween`, `at` у
 * `carveFloor`), моделью не запрещён: ядро его не структурирует, но исполняет,
 * и запретить его значило бы решить за ядро. Он просто не имеет вида — блок
 * несёт его как выражение по имени, которое дал автор.
 */

/** Как ядро обходит аргумент этого имени (`checkAction`, SYS-3). */
export type SlotKind =
  /** Список действий: `checkActions` во внутренней области видимости. */
  | 'actions'
  /** Карта «имя поля → выражение»: `checkFields`. */
  | 'fields'
  /** Выражение: `checkExpression` во внешней области видимости. */
  | 'expression'
  /** Спецификация запроса: `checkQuery`. */
  | 'query'
  /** Карта «компонент → карта полей» поверх prefab'а: `checkOverrides` (CMD-6). */
  | 'overrides'
  /** Строковый литерал, который не вычисляется. */
  | 'literal';

/**
 * Откуда берутся ИМЕНА в слоте: сам литерал у `literal`, ключи карты у `fields`
 * и `overrides`. Множество кандидатов производно от того, что принимает ядро
 * (решение 5 design'а: аффорданс может быть производным, вердикт всегда за
 * ядром) — читает его `world.ts`, а называет этот перечень.
 */
export type NameSource =
  /** Имена компонентов поднятого мира: их принимает `componentSchema`. */
  | 'component'
  /** Имена prefab'ов поднятого мира: их принимает `prefabOf`. */
  | 'prefab'
  /**
   * Поля компонента, названного слотом `component` этого же действия: ровно то,
   * с чем `checkFields` сверяет ключи карты. Действие, компонента не
   * называющее (`let`, `emitEvent`), схемы не имеет — и ядро ключи такой карты
   * ни с чем не сверяет, поэтому кандидатов у неё нет.
   */
  | 'componentField'
  /** Компоненты названного prefab'а: с ними сверяет ключи `checkOverrides` (CMD-6). */
  | 'prefabComponent'
  /** Ядро содержимого не сверяет ни с чем: кандидатов нет, есть свободный ввод. */
  | 'free';

export interface ConventionSlot {
  readonly name: string;
  readonly kind: SlotKind;
  /** Есть у тех слотов, в которых встречаются имена; у остальных отсутствует. */
  readonly names?: NameSource;
}

/**
 * Порядок — порядок ветвей `checkAction`. Он же порядок ключей в собранном узле
 * (`build.ts`): два автора, заполнившие одни и те же слоты в разном порядке,
 * обязаны получить один и тот же JSON, иначе дифф покажет перестановку там, где
 * правки не было (ED-21).
 */
export const CONVENTION_SLOTS: readonly ConventionSlot[] = Object.freeze([
  Object.freeze({ name: 'do', kind: 'actions' } as const),
  Object.freeze({ name: 'then', kind: 'actions' } as const),
  Object.freeze({ name: 'else', kind: 'actions' } as const),
  Object.freeze({ name: 'values', kind: 'fields', names: 'componentField' } as const),
  Object.freeze({ name: 'data', kind: 'fields', names: 'componentField' } as const),
  Object.freeze({ name: 'bindings', kind: 'fields', names: 'componentField' } as const),
  Object.freeze({ name: 'entity', kind: 'expression' } as const),
  Object.freeze({ name: 'cond', kind: 'expression' } as const),
  Object.freeze({ name: 'bound', kind: 'expression' } as const),
  Object.freeze({ name: 'query', kind: 'query' } as const),
  Object.freeze({ name: 'overrides', kind: 'overrides', names: 'prefabComponent' } as const),
  Object.freeze({ name: 'component', kind: 'literal', names: 'component' } as const),
  Object.freeze({ name: 'field', kind: 'literal', names: 'componentField' } as const),
  Object.freeze({ name: 'prefab', kind: 'literal', names: 'prefab' } as const),
  Object.freeze({ name: 'type', kind: 'literal', names: 'free' } as const),
  Object.freeze({ name: 'as', kind: 'literal', names: 'free' } as const),
  Object.freeze({ name: 'subStream', kind: 'literal', names: 'free' } as const),
]);

const BY_NAME: ReadonlyMap<string, ConventionSlot> = new Map(
  CONVENTION_SLOTS.map((slot) => [slot.name, slot]),
);

/** Слот конвенции по имени аргумента; `undefined` — имя вне конвенции. */
export function conventionSlot(name: string): ConventionSlot | undefined {
  return BY_NAME.get(name);
}

/**
 * Имена, вводящие переменные в тело действия (`as` и ключи `bindings`), — та же
 * ветвь `checkAction`, из которой область видимости строит `scope.ts`. Названы
 * здесь, чтобы имя аргумента жило в одном месте на весь пакет.
 */
export const BINDING_SLOT = 'as';
export const BINDINGS_SLOT = 'bindings';

/** Тела действия — слоты, внутрь которых введённые им имена видны. */
export const BODY_SLOTS: readonly string[] = Object.freeze(
  CONVENTION_SLOTS.filter((slot) => slot.kind === 'actions').map((slot) => slot.name),
);

/**
 * Имя переменной итерации системы по умолчанию (`DEFAULT_AS` ядра): система с
 * `query` разворачивается в `forEach`, и без явного `as` тело видит `entity`.
 */
export const DEFAULT_ITERATION_NAME = 'entity';

// ------------------------------------------------------------------- запрос

/** Как `checkQuery` обходит поле спецификации запроса. */
export type QuerySlotKind =
  /** Список имён компонентов: каждое принимает `componentSchema`. */
  | 'componentNames'
  /** Строковый литерал (тег): содержимым не проверяется. */
  | 'literal'
  /** Объект с полями-выражениями, имена которых ядро знает. */
  | 'expressions';

export interface QuerySlot {
  readonly name: string;
  readonly kind: QuerySlotKind;
  /** Для `expressions` — имена вложенных полей, которые обходит `checkQuery`. */
  readonly fields?: readonly string[];
}

/** Поля запроса — вторая половина той же конвенции (`checkQuery`, QUERY-1). */
export const QUERY_SLOTS: readonly QuerySlot[] = Object.freeze([
  Object.freeze({ name: 'all', kind: 'componentNames' } as const),
  Object.freeze({ name: 'any', kind: 'componentNames' } as const),
  Object.freeze({ name: 'not', kind: 'componentNames' } as const),
  Object.freeze({ name: 'withTag', kind: 'literal' } as const),
  Object.freeze({
    name: 'withinRadius',
    kind: 'expressions',
    fields: Object.freeze(['center', 'radius']),
  } as const),
]);
