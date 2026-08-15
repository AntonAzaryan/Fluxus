/**
 * Публичная поверхность пакета `@game-mvp/editor-ui` — DOM-стороны редактора:
 * визуальный язык (ED-22), каркас рабочих областей (ED-23, ED-24) и вьюпорт
 * над рендером движка (ED-1, ED-15) живут здесь.
 *
 * Правки документов этот пакет делает только операциями из
 * `@game-mvp/editor-core` (ED-29) — собственного пути записи у интерфейса нет.
 *
 * Сегодня здесь визуальный язык (набор токенов, таблица стилей, слой описания
 * узлов и базовые виджеты) и каркас рабочих областей поверх него. Сами области
 * — вклады (ED-25) и в поверхность пакета не входят: их приносит тот, кто
 * собирает редактор, а не тот, кто даёт ему каркас.
 */
export { EDITOR_ROOT_ID, mountEditorRoot } from './root.js';

export { TOKENS, tokenPx, tokenValue, tokensOf } from './tokens/tokens.js';
export type { Token, TokenGroup } from './tokens/tokens.js';

export {
  APP_CLASS,
  STYLESHEET_ELEMENT_ID,
  STYLE_RULES,
  TOKEN_SCOPE_CLASS,
  VIEWPORT_CLASS,
  VIEWPORT_OVERLAY_CLASS,
  editorStylesheet,
  installStylesheet,
} from './tokens/stylesheet.js';
export type { CssRule, RuleRole } from './tokens/stylesheet.js';

/**
 * Каркас рабочих областей (ED-23, ED-24) и всё, из чего он собран. Барель
 * подпакета и есть его поверхность — отдельного перечня имён здесь нет
 * намеренно: второй перечень расходится с первым.
 */
export * from './frame/index.js';

/**
 * Инспектор из схемы (ED-24) и палитра команд с поиском по проекту (ED-24) —
 * части каркаса, а не вклады: место инспектора и способ добраться до чего
 * угодно мимо дерева одинаковы во всех областях. Вкладами приходит то, что они
 * показывают: редакторы поля, команды и находки поиска (ED-25).
 */
export * from './inspector/index.js';
export * from './palette/index.js';

export {
  ROVING_ATTR,
  rovingContainer,
  rovingItem,
  rovingTarget,
} from './dom/roving.js';

export {
  collectTexts,
  children,
  documentValue,
  el,
  findAll,
  hasClass,
  hotkeyText,
  issueText,
  resourceText,
  walk,
} from './dom/node.js';
export type {
  UiHandler,
  UiLabels,
  UiNode,
  UiNodeSpec,
  UiText,
  UiTextOrigin,
} from './dom/node.js';
export { renderInto, renderNode } from './dom/render.js';

export { UI_BUNDLES, UI_KEY_PREFIX, uiResources } from './i18n/uiBundles.js';

export { button } from './widgets/button.js';
export type {
  ButtonSpec,
  ButtonVariant,
  IconButtonSpec,
  LabelledButtonSpec,
} from './widgets/button.js';
export { statusChip } from './widgets/chip.js';
export type { ChipSpec, ChipTone } from './widgets/chip.js';
export { numberField, select, textField, toggle } from './widgets/field.js';
export type { FieldSpec, SelectOption, SelectSpec, ToggleSpec } from './widgets/field.js';
export { fieldRow, fieldTable, fieldTableHeight } from './widgets/fieldTable.js';
export type { FieldGroupSpec, FieldRowSpec, FieldTableSpec } from './widgets/fieldTable.js';
export { ICONS, icon } from './widgets/icon.js';
export type { IconGeometry, IconName, IconSpec } from './widgets/icon.js';
export { denseList, tree } from './widgets/rows.js';
export type { ListItem, ListSpec, TreeItem, TreeSpec } from './widgets/rows.js';
export { tooltip } from './widgets/tooltip.js';
export type { TooltipSpec } from './widgets/tooltip.js';
/**
 * Из состояний валидации наружу выходит один `withValidation`. Ни блок
 * «иконка + причина», ни имена классов строгости публичными не делаются
 * намеренно: имея их, состояние можно показать одним цветом, а ED-22 требует
 * иконку, положение и причину — и ставит их все один вызов.
 */
export { withValidation } from './widgets/validation.js';
export type { ValidationSeverity, ValidationState } from './widgets/validation.js';

export { viewportFrame } from './viewport.js';
export type { ViewportSpec } from './viewport.js';

/**
 * Реализации хоста среды (ED-12) — веб и десктоп. Они в поверхности пакета, а
 * рабочие области — нет, и это не непоследовательность: область есть вклад,
 * который приносит собирающий редактор, а хост среды — сама среда, в которой
 * он собирается.
 *
 * Десктопная реализация — адаптер поверх моста контейнера (`desktop-shell`
 * DSK-2): предметные интерфейсы редактора живут на стороне редактора, а
 * контейнер их не знает. Выбор реализации — по наличию моста в странице
 * (`app/main.ts`), а не по флагу сборки и не по user-agent.
 */
export { createWebHost } from './host/web.js';
export type {
  BeforeUnloadEventLike,
  BrowserWindowLike,
  DocumentTitleSink,
  HttpFetch,
  HttpRequest,
  HttpResponse,
  WebHostOptions,
} from './host/web.js';

export { createDesktopHost } from './host/desktop.js';
export type { DesktopHostOptions } from './host/desktop.js';
