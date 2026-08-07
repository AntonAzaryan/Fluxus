/**
 * Строковые виджеты: дерево навигатора и плотный список.
 *
 * Оба стоят на одной строке `.fx-row` высотой `--fx-row-dense` — это и есть
 * шкала плотности ED-22 в работе: высота строки приходит из токена, а не из
 * виджета, поэтому переехать на материаловские 48 dp можно только правкой
 * набора токенов, и правка эта немедленно ломает тест плотности.
 *
 * Дерево закрывает сценарий ED-22 «ошибка и выделение в одном списке»:
 * выделенная строка несёт признак активного состояния (акцентная полоса и
 * поверхность выделения), строка с нарушением — иконку и причину в хвосте.
 * Признаки разной природы, поэтому вопрос «это выделено или сломано» не
 * сводится к различению двух близких оттенков.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon, type IconName } from './icon.js';
import { statusChip } from './chip.js';
import { withValidation, type ValidationState } from './validation.js';

export interface TreeItem {
  readonly id: string;
  readonly label: UiText;
  /**
   * Пометка вида записи — данные документа, не состояние (ED-22). Тона у неё
   * поэтому и нет: строгость приходит `validation`, вместе с причиной.
   */
  readonly badge?: UiText;
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly validation?: ValidationState;
  readonly items?: readonly TreeItem[];
  readonly onSelect?: (id: string) => void;
  readonly onToggle?: (id: string) => void;
}

function twisty(item: TreeItem): UiNode {
  const expandable = item.items !== undefined && item.items.length > 0;
  if (!expandable) return el('span', { classes: ['fx-row__twisty'] });
  const name: IconName = item.expanded === true ? 'chevron-down' : 'chevron-right';
  return el('button', {
    classes: ['fx-row__twisty'],
    attrs: { type: 'button', 'aria-expanded': String(item.expanded === true) },
    labels: { ariaLabel: item.label },
    children: [icon({ name })],
    on:
      item.onToggle === undefined
        ? undefined
        : {
            click: (event: Event) => {
              event.stopPropagation();
              item.onToggle?.(item.id);
            },
          },
  });
}

function treeRow(item: TreeItem, depth: number): UiNode {
  const selected = item.selected === true;
  const row = el('div', {
    classes: ['fx-row', ...(selected ? ['fx-is-selected'] : [])],
    attrs: { role: 'treeitem', 'aria-selected': String(selected), 'data-id': item.id },
    // Глубина — параметр правила отступа, а не стиль строки: само правило
    // (`padding-left: calc(...)`) живёт в таблице стилей и там же меняется.
    vars: { '--fx-depth': String(depth) },
    children: children(
      twisty(item),
      el('span', { classes: ['fx-row__label'], text: item.label }),
      item.badge === undefined
        ? undefined
        : el('span', {
            classes: ['fx-row__trailing'],
            children: [statusChip({ label: item.badge })],
          }),
    ),
    on:
      item.onSelect === undefined
        ? undefined
        : {
            click: () => {
              item.onSelect?.(item.id);
            },
          },
  });
  return withValidation(row, item.validation);
}

function flatten(items: readonly TreeItem[], depth: number, out: UiNode[]): void {
  for (const item of items) {
    out.push(treeRow(item, depth));
    if (item.expanded === true && item.items !== undefined) flatten(item.items, depth + 1, out);
  }
}

export interface TreeSpec {
  readonly label: UiText;
  readonly items: readonly TreeItem[];
}

/**
 * Дерево — плоский список строк с отступом через `--fx-depth`, а не вложенные
 * контейнеры: при сотнях записей вложенные контейнеры дают глубокое дерево
 * элементов там, где нужен ровный столбец одинаковых строк.
 */
export function tree(spec: TreeSpec): UiNode {
  const rows: UiNode[] = [];
  flatten(spec.items, 0, rows);
  return el('div', {
    classes: ['fx-tree'],
    attrs: { role: 'tree' },
    labels: { ariaLabel: spec.label },
    children: rows,
  });
}

export interface ListItem {
  readonly id: string;
  readonly label: UiText;
  readonly secondary?: UiText;
  readonly trailing?: UiText;
  readonly icon?: IconName;
  readonly selected?: boolean;
  readonly validation?: ValidationState;
  readonly onSelect?: (id: string) => void;
}

export interface ListSpec {
  readonly label: UiText;
  readonly items: readonly ListItem[];
}

/** Плотный список — результаты поиска, ассеты, размещения. */
export function denseList(spec: ListSpec): UiNode {
  return el('div', {
    classes: ['fx-list'],
    attrs: { role: 'listbox' },
    labels: { ariaLabel: spec.label },
    children: spec.items.map((item) => {
      const selected = item.selected === true;
      const row = el('div', {
        classes: ['fx-row', ...(selected ? ['fx-is-selected'] : [])],
        attrs: { role: 'option', 'aria-selected': String(selected), 'data-id': item.id },
        children: children(
          item.icon === undefined ? undefined : icon({ name: item.icon }),
          el('span', { classes: ['fx-row__label'], text: item.label }),
          item.secondary === undefined
            ? undefined
            : el('span', { classes: ['fx-row__secondary'], text: item.secondary }),
          item.trailing === undefined
            ? undefined
            : el('span', { classes: ['fx-row__trailing'], text: item.trailing }),
        ),
        on:
          item.onSelect === undefined
            ? undefined
            : {
                click: () => {
                  item.onSelect?.(item.id);
                },
              },
      });
      return withValidation(row, item.validation);
    }),
  });
}
