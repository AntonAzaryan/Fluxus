/**
 * Таблица полей — контрольный случай плотности из ED-22: «инспектор с
 * несколькими десятками строк — обычный случай работы редактора».
 *
 * Три колонки на всю таблицу, а не на строку: подпись, контрол, признак типа.
 * Общая сетка нужна ровно затем, чтобы в столбце из сорока строк контролы
 * стояли на одной вертикали — иначе инспектор читается лестницей, и плотность
 * перестаёт быть выигрышем.
 *
 * Высота строки — из токена `--fx-row-field` и только из него. Ни один виджет
 * здесь не задаёт высоту сам, поэтому арифметика «сколько строк помещается в
 * колонку» считается по набору токенов и проверяется тестом, а не глазом.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon } from './icon.js';
import { sectionTitle } from './rows.js';

export interface FieldRowSpec {
  /** Имя поля — идентификатор документа, он не локализуется (ED-27). */
  readonly label: UiText;
  /** Контрол строки: любой виджет поля, в том числе принесённый вкладом (ED-25). */
  readonly control: UiNode;
  /** Подсказка к полю (ED-28); показывается по наведению на знак вопроса. */
  readonly hint?: UiText;
  /** Признак типа или схемы — справа, мелким моноширным (`i32`, `q16.16`). */
  readonly note?: UiText;
}

/**
 * Строка таблицы полей. `display: contents` у строки — то, что позволяет иметь
 * и строку как сущность разметки, и общую сетку колонок на всю таблицу.
 */
export function fieldRow(spec: FieldRowSpec): UiNode {
  return el('div', {
    classes: ['fx-field-row'],
    attrs: { role: 'row' },
    children: children(
      el('div', {
        classes: ['fx-field-row__label'],
        children: children(
          el('span', { text: spec.label }),
          spec.hint === undefined
            ? undefined
            : el('button', {
                classes: ['fx-hint'],
                attrs: { type: 'button' },
                labels: { title: spec.hint, ariaLabel: spec.hint },
                children: [icon({ name: 'hint' })],
              }),
        ),
      }),
      el('div', { classes: ['fx-field-row__control'], children: [spec.control] }),
      el('div', {
        classes: ['fx-field-row__note'],
        children: children(spec.note === undefined ? undefined : el('span', { text: spec.note })),
      }),
    ),
  });
}

export interface FieldGroupSpec {
  /** Заголовок группы — имя компонента или раздела схемы, идентификатор документа. */
  readonly label: UiText;
  readonly rows: readonly FieldRowSpec[];
}

export interface FieldTableSpec {
  readonly label: UiText;
  readonly groups: readonly FieldGroupSpec[];
}

/** Таблица полей целиком: заголовки групп и строки в одной сетке колонок. */
export function fieldTable(spec: FieldTableSpec): UiNode {
  const cells: UiNode[] = [];
  for (const group of spec.groups) {
    cells.push(sectionTitle(group.label));
    for (const row of group.rows) cells.push(fieldRow(row));
  }
  return el('div', {
    classes: ['fx-fields'],
    attrs: { role: 'table' },
    labels: { ariaLabel: spec.label },
    children: cells,
  });
}

/**
 * Высота таблицы полей по набору токенов, в пикселях. Живёт рядом с виджетом,
 * а не в тесте, потому что это утверждение о самой таблице: её высота есть
 * функция числа строк и токенов плотности, и ничего больше.
 */
export function fieldTableHeight(
  spec: FieldTableSpec,
  metrics: { readonly rowField: number; readonly rowDense: number },
): number {
  const rows = spec.groups.reduce((total, group) => total + group.rows.length, 0);
  return rows * metrics.rowField + spec.groups.length * metrics.rowDense;
}
