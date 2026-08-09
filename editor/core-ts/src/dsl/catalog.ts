/**
 * @contribution
 *
 * Каталог блоков: что автору вообще можно поставить в тело системы (ED-4) и в
 * выражение (ED-5).
 *
 * Наборов имён два, и оба закрыты ядром — `actions.actionNames` (ACT-1) и
 * `expr.operators` (EXPR-6). Редактор их не перечисляет и не фильтрует: он
 * берёт их через `dslDescriptionPaths()` — тот же источник, по которому
 * считается отчёт ED-28. Один источник на две стороны означает, что новое имя
 * ядра появляется в палитре блоков и в отчёте о недокументированном
 * одновременно, а не в одном из двух.
 *
 * Ключ описания блока выводится из пути (ED-28), таблицы «имя → ключ» здесь
 * нет по той же причине, по какой её нет в `i18n/keys.ts`: она разошлась бы со
 * схемой молча.
 *
 * Что каталог говорит о ФОРМЕ блока:
 *
 * - Действие — слоты конвенции SYS-3, одни и те же у всех действий (`slots.ts`).
 *   Персонального набора аргументов ядро не публикует, и выдумывать его здесь
 *   значило бы завести вторую реализацию семантики DSL (ED-1).
 * - Оператор — n-арный список выражений, КРОМЕ четырёх, чью структуру разбирает
 *   сам `checkExpression`: `var`, `getComponent`, `hasComponent`, `eventField`.
 *   Это единственное, что ядро об аргументах операторов знает, и ровно это
 *   каталог и повторяет.
 *
 * Арности остальных операторов в каталоге нет намеренно: `arity()` живёт в
 * вычислителе, а не в валидаторе, и SYS-3 прямо выносит арность и типы значений
 * в ошибку времени вычисления. Ответ на это — не второй проверяльщик, а превью
 * (ED-9).
 */
import { descriptionKey } from '../i18n/keys.js';
import { dslDescriptionPaths } from '../i18n/paths.js';
import { CONVENTION_SLOTS, type ConventionSlot } from './slots.js';

/** Вид описываемого — первый сегмент пути (ED-28). */
const ACTION_KIND = 'action';
const OPERATOR_KIND = 'operator';

/** Аргумент оператора, чью форму знает `checkExpression`. */
export type OperatorArg =
  /** Вложенное выражение. */
  | 'expression'
  /** Имя связанной переменной: `var` сверяет его с областью видимости (`scope.ts`). */
  | 'variable'
  /** Имя компонента: `componentSchema` обязан его знать. */
  | 'component'
  /** Имя поля названного компонента: сверяется с его схемой. */
  | 'field'
  /**
   * Имя поля события. Кандидатов у него нет: реестра типов событий и их полей в
   * ядре нет вовсе — состав данных задаёт эмитент, в том числе нативный
   * (EXPR-2), — и подсказывать здесь нечем.
   */
  | 'eventField';

export interface ActionBlock {
  readonly name: string;
  readonly descriptionKey: string;
  /** Слоты конвенции — та же ссылка у всех действий: персонального набора нет. */
  readonly slots: readonly ConventionSlot[];
}

export interface OperatorBlock {
  readonly name: string;
  readonly descriptionKey: string;
  /**
   * Аргументы известной формы. Пустой список означает не «аргументов нет», а
   * «ядро их не структурирует»: оператор n-арный, автор добавляет и убирает
   * выражения сам.
   */
  readonly args: readonly OperatorArg[];
  /** `true`, если форма аргументов ядру неизвестна и список свободный. */
  readonly variadic: boolean;
}

export interface DslCatalog {
  readonly actions: readonly ActionBlock[];
  readonly operators: readonly OperatorBlock[];
}

/**
 * Четыре формы, которые разбирает `checkExpression`. Это не таблица сигнатур
 * рядом с таблицей операторов, а перечень исключений из общего обхода: у всех
 * прочих операторов аргументы — плоский список выражений, и обход у них один.
 */
const STRUCTURED_ARGS: Readonly<Record<string, readonly OperatorArg[]>> = Object.freeze({
  var: Object.freeze<OperatorArg[]>(['variable']),
  getComponent: Object.freeze<OperatorArg[]>(['expression', 'component', 'field']),
  hasComponent: Object.freeze<OperatorArg[]>(['expression', 'component']),
  eventField: Object.freeze<OperatorArg[]>(['expression', 'eventField']),
});

const NO_ARGS: readonly OperatorArg[] = Object.freeze([]);

function actionBlockOf(name: string): ActionBlock {
  return Object.freeze({
    name,
    descriptionKey: descriptionKey([ACTION_KIND, name]),
    slots: CONVENTION_SLOTS,
  });
}

function operatorBlockOf(name: string): OperatorBlock {
  const args = Object.hasOwn(STRUCTURED_ARGS, name) ? STRUCTURED_ARGS[name]! : NO_ARGS;
  return Object.freeze({
    name,
    descriptionKey: descriptionKey([OPERATOR_KIND, name]),
    args,
    variadic: args.length === 0,
  });
}

/**
 * Каталог считается один раз: закрытые наборы ядра статичны, а блоки — плоские
 * замороженные записи. Пересчитывать их на каждую отрисовку палитры нечего.
 */
const CATALOG: DslCatalog = (() => {
  const actionBlocks: ActionBlock[] = [];
  const operatorBlocks: OperatorBlock[] = [];
  for (const [kind, name] of dslDescriptionPaths()) {
    if (kind === ACTION_KIND) actionBlocks.push(actionBlockOf(name));
    else if (kind === OPERATOR_KIND) operatorBlocks.push(operatorBlockOf(name));
  }
  return Object.freeze({
    actions: Object.freeze(actionBlocks),
    operators: Object.freeze(operatorBlocks),
  });
})();

/** Всё, что автор вправе поставить блоком, — действия и операторы разом. */
export function dslCatalog(): DslCatalog {
  return CATALOG;
}

export function actionCatalog(): readonly ActionBlock[] {
  return CATALOG.actions;
}

export function operatorCatalog(): readonly OperatorBlock[] {
  return CATALOG.operators;
}

const ACTIONS_BY_NAME: ReadonlyMap<string, ActionBlock> = new Map(
  CATALOG.actions.map((block) => [block.name, block]),
);
const OPERATORS_BY_NAME: ReadonlyMap<string, OperatorBlock> = new Map(
  CATALOG.operators.map((block) => [block.name, block]),
);

/**
 * Блок по имени; `undefined` — имени в закрытом наборе ядра нет. Проверкой имени
 * это не является: отвергает неизвестное действие `checkAction`, а здесь просто
 * нечего показать (ED-1).
 */
export function actionBlock(name: string): ActionBlock | undefined {
  return ACTIONS_BY_NAME.get(name);
}

export function operatorBlock(name: string): OperatorBlock | undefined {
  return OPERATORS_BY_NAME.get(name);
}
