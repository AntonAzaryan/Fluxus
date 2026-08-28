/**
 * Модель блоков DSL — материал, из которого строятся редактор триггеров (ED-4)
 * и блочный конструктор выражений (ED-5).
 *
 * Слой headless и целиком производный: слоты берутся из конвенции SYS-3,
 * каталог — из закрытых наборов имён ядра, кандидаты пикеров — из поднятого
 * мира, область видимости — из правила связывания. Своих правил DSL в нём нет
 * ни одного (ED-1): вердикт по собранному выносит `validateSystem`, а этот слой
 * отвечает только на вопрос «что автору предложить».
 */
export {
  BINDING_SLOT,
  BINDINGS_SLOT,
  BODY_SLOTS,
  CONVENTION_SLOTS,
  DEFAULT_ITERATION_NAME,
  QUERY_SLOTS,
  conventionSlot,
} from './slots.js';
export type { ConventionSlot, NameSource, QuerySlot, QuerySlotKind, SlotKind } from './slots.js';
export { actionBlock, actionCatalog, dslCatalog, operatorBlock, operatorCatalog } from './catalog.js';
export type { ActionBlock, DslCatalog, OperatorArg, OperatorBlock } from './catalog.js';
export { dslWorldView, loadDslWorld } from './world.js';
export type { DslWorldView } from './world.js';
export { boundNamesAt } from './scope.js';
export {
  buildAction,
  buildExpression,
  orderedSlotNames,
  readActionNode,
  readExpressionNode,
} from './build.js';
export type { ActionDraft, SlotValues } from './build.js';
