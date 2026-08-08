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
 *
 * Клавиатурный обход — roving-фокусом: одна остановка Tab на весь список,
 * дальше стрелками. Иначе дерево на сотню записей стоит сотней остановок между
 * навигатором и поверхностью правки, и обход скелета (ED-24) перестаёт быть
 * обходом трёх зон. Правило обхода общее (`dom/roving.ts`), а знание о том,
 * какая строка следующая, — здесь: раскрытые узлы разворачивает это дерево, и
 * второго места, где известен порядок видимых строк, нет.
 */
import { children, el, type UiHandler, type UiNode, type UiText } from '../dom/node.js';
import { rovingContainer, rovingItem, rovingTarget } from '../dom/roving.js';
import { icon, type IconName } from './icon.js';
import { statusChip } from './chip.js';
import { withValidation, type ValidationState } from './validation.js';

/**
 * Клавиатурная часть строкового виджета. Без `rovingId` виджет остаётся тем же,
 * чем был, — списком без собственного обхода: контрольный случай визуального
 * языка клавиатуру не изображает, а платить за это лишними остановками Tab
 * незачем.
 */
export interface RovingSpec {
  /** Идентификатор контейнера; по нему каркас возвращает фокус после перерисовки. */
  readonly rovingId?: string;
  /** Строка, держащая фокус. По умолчанию — выделенная, иначе первая. */
  readonly activeId?: string;
  /** Переход фокуса на другую строку. */
  readonly onActive?: (id: string) => void;
}

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

function treeRow(item: TreeItem, depth: number, focused: boolean | undefined): UiNode {
  const selected = item.selected === true;
  const row = el('div', {
    classes: ['fx-row', ...(selected ? ['fx-is-selected'] : [])],
    attrs: {
      role: 'treeitem',
      'aria-selected': String(selected),
      'data-id': item.id,
      ...(item.items === undefined ? {} : { 'aria-expanded': String(item.expanded === true) }),
      ...(focused === undefined ? {} : rovingItem(focused)),
    },
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

/** Видимая строка: сам узел и его глубина — из них считается и разметка, и обход. */
interface VisibleRow {
  readonly item: TreeItem;
  readonly depth: number;
}

function flatten(items: readonly TreeItem[], depth: number, out: VisibleRow[]): void {
  for (const item of items) {
    out.push({ item, depth });
    if (item.expanded === true && item.items !== undefined) flatten(item.items, depth + 1, out);
  }
}

export interface TreeSpec extends RovingSpec {
  readonly label: UiText;
  readonly items: readonly TreeItem[];
}

/** Родитель видимой строки — ближайшая выше строка меньшей глубины. */
function parentOf(rows: readonly VisibleRow[], index: number): number | undefined {
  const depth = rows[index]?.depth ?? 0;
  for (let step = index - 1; step >= 0; step--) {
    if ((rows[step]?.depth ?? 0) < depth) return step;
  }
  return undefined;
}

/**
 * Клавиатура дерева. Стрелки вбок работают с раскрытием, а не с фокусом: это
 * единственный способ свернуть узел, не целясь в треугольник шириной в
 * четырнадцать пикселей.
 */
function treeKeydown(rows: readonly VisibleRow[], spec: TreeSpec, active: string): UiHandler {
  return (event: Event) => {
    if (!('key' in event) || typeof event.key !== 'string') return;
    const index = rows.findIndex((row) => row.item.id === active);
    const current = rows[index];
    if (current === undefined) return;

    const moveTo = (target: number | undefined): void => {
      const row = target === undefined ? undefined : rows[target];
      if (row === undefined) return;
      event.preventDefault();
      spec.onActive?.(row.item.id);
    };

    const expandable = current.item.items !== undefined && current.item.items.length > 0;
    switch (event.key) {
      case 'ArrowRight':
        if (expandable && current.item.expanded !== true) {
          event.preventDefault();
          current.item.onToggle?.(current.item.id);
        } else if (expandable) moveTo(index + 1);
        return;
      case 'ArrowLeft':
        if (expandable && current.item.expanded === true) {
          event.preventDefault();
          current.item.onToggle?.(current.item.id);
        } else moveTo(parentOf(rows, index));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        current.item.onSelect?.(current.item.id);
        return;
      default:
        moveTo(rovingTarget(event.key, index, rows.length));
    }
  };
}

/**
 * Дерево — плоский список строк с отступом через `--fx-depth`, а не вложенные
 * контейнеры: при сотнях записей вложенные контейнеры дают глубокое дерево
 * элементов там, где нужен ровный столбец одинаковых строк.
 */
export function tree(spec: TreeSpec): UiNode {
  const rows: VisibleRow[] = [];
  flatten(spec.items, 0, rows);
  const roving = spec.rovingId !== undefined;
  // Держащая фокус строка могла уехать из видимых — свернули узел над ней. Без
  // отката на первую видимую в списке не осталось бы ни одной остановки Tab, и
  // клавиатура потеряла бы навигатор целиком.
  const requested = rows.some((row) => row.item.id === spec.activeId) ? spec.activeId : undefined;
  const active =
    requested ??
    rows.find((row) => row.item.selected === true)?.item.id ??
    rows[0]?.item.id ??
    '';
  return el('div', {
    classes: ['fx-tree'],
    attrs: {
      role: 'tree',
      ...(spec.rovingId === undefined ? {} : rovingContainer(spec.rovingId)),
    },
    labels: { ariaLabel: spec.label },
    children: rows.map((row) =>
      treeRow(row.item, row.depth, roving ? row.item.id === active : undefined),
    ),
    ...(roving ? { on: { keydown: treeKeydown(rows, spec, active) } } : {}),
  });
}

export interface ListItem {
  readonly id: string;
  readonly label: UiText;
  readonly secondary?: UiText;
  readonly trailing?: UiText;
  readonly icon?: IconName;
  readonly selected?: boolean;
  /**
   * Строка, которую сейчас нечем применить (ED-26): она показана и приглушена,
   * а не спрятана — исчезнувший элемент оставляет автора гадать, был ли он.
   * Признак несёт `aria-disabled`, а не отсутствие обработчика: обработчика
   * может не быть и у обычной строки списка.
   */
  readonly disabled?: boolean;
  readonly validation?: ValidationState;
  readonly onSelect?: (id: string) => void;
}

export interface ListSpec extends RovingSpec {
  readonly label: UiText;
  readonly items: readonly ListItem[];
}

function listKeydown(spec: ListSpec, active: string): UiHandler {
  return (event: Event) => {
    if (!('key' in event) || typeof event.key !== 'string') return;
    const index = spec.items.findIndex((item) => item.id === active);
    if (index < 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      spec.items[index]?.onSelect?.(active);
      return;
    }
    const target = rovingTarget(event.key, index, spec.items.length);
    const item = target === undefined ? undefined : spec.items[target];
    if (item === undefined) return;
    event.preventDefault();
    spec.onActive?.(item.id);
  };
}

/** Плотный список — результаты поиска, ассеты, размещения. */
export function denseList(spec: ListSpec): UiNode {
  const roving = spec.rovingId !== undefined;
  // Тот же откат, что и в дереве: список записей меняется, а остановка Tab в
  // нём обязана остаться ровно одна.
  const requested = spec.items.some((item) => item.id === spec.activeId)
    ? spec.activeId
    : undefined;
  const active =
    requested ??
    spec.items.find((item) => item.selected === true)?.id ??
    spec.items[0]?.id ??
    '';
  return el('div', {
    classes: ['fx-list'],
    attrs: {
      role: 'listbox',
      ...(spec.rovingId === undefined ? {} : rovingContainer(spec.rovingId)),
    },
    labels: { ariaLabel: spec.label },
    ...(roving ? { on: { keydown: listKeydown(spec, active) } } : {}),
    children: spec.items.map((item) => {
      const selected = item.selected === true;
      const row = el('div', {
        classes: ['fx-row', ...(selected ? ['fx-is-selected'] : [])],
        attrs: {
          role: 'option',
          'aria-selected': String(selected),
          'data-id': item.id,
          ...(item.disabled === true ? { 'aria-disabled': 'true' } : {}),
          ...(roving ? rovingItem(item.id === active) : {}),
        },
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
          item.onSelect === undefined || item.disabled === true
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
