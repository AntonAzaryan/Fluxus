/**
 * Контрольный случай визуального языка — работающая страница, на которой
 * шкала плотности не декларируется, а видна и считается.
 *
 * ED-22 называет этот случай прямо: «инспектор с несколькими десятками строк —
 * обычный случай работы редактора, а не исключение». Поэтому здесь настоящий
 * инспектор на сорок с лишним строк полей, настоящее дерево навигатора с
 * выделенной записью и записью с нарушением, настоящие контролы каждого вида и
 * настоящий кадр вьюпорта со слоем наложений. Не картинка и не список
 * примеров: страница монтируется в приложении (`app/main.ts`), а тест строит
 * то же самое дерево узлов и меряет по нему плотность и происхождение строк.
 *
 * Страницу приложения с приходом каркаса областей (W2-2) монтирует каркас, а
 * не она: контрольный случай остался тем, чем и был, — мерилом плотности и
 * происхождения строк, по которому считают `test/density.test.ts` и
 * `test/strings.test.ts`. Колонки он берёт у скелета, а не объявляет свои.
 *
 * Данные страницы лежат в `sampleDocument.json` и это не деталь удобства.
 * Строки, приходящие в интерфейс из документа, обязаны приходить из документа
 * (ED-27 не локализует идентификаторы редактируемого), и тест `strings.test.ts`
 * проверяет ровно это: каждый текст на странице — либо ресурс с ключом, либо
 * строка, лежащая в этом файле данных. Литералу подписи взяться неоткуда.
 *
 * Каркас областей (ED-23, ED-24) эта страница по-прежнему не изображает: здесь
 * только словарь — токены, виджеты и их состояния.
 */
import { schemaPathOf, descriptionKey, type StringResources } from '@fluxus/editor-core';
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import { INSPECTOR_ZONE_CLASS, NAVIGATOR_ZONE_CLASS } from '../frame/styles.js';
import { jsonStrings } from '../i18n/corpus.js';
import { APP_CLASS } from '../tokens/stylesheet.js';
import { button } from '../widgets/button.js';
import { statusChip, type ChipTone } from '../widgets/chip.js';
import {
  fieldTable,
  type FieldGroupSpec,
  type FieldRowSpec,
  type FieldTableSpec,
} from '../widgets/fieldTable.js';
import { numberField, select, textField, toggle } from '../widgets/field.js';
import { denseList, tree, type TreeItem } from '../widgets/rows.js';
import { tooltip } from '../widgets/tooltip.js';
import type { ValidationSeverity, ValidationState } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import sample from './sampleDocument.json';

/** Данные страницы — открытый документ и его схема, как их видит редактор. */
export const SAMPLE_DOCUMENT = sample;

/** Описания полей проекта: бандл, который в жизни лежит в дереве контента. */
export const SAMPLE_DESCRIPTIONS = sample.descriptions;

/**
 * Изменяемое состояние страницы. Не модель документа — правки сюда не пишутся:
 * писать в документ можно только операциями авторинга (ED-29), а их приносит
 * `@fluxus/editor-core`. Здесь ровно то, что принадлежит интерфейсу:
 * выделение, раскрытие узлов и положение контролов.
 */
export interface GalleryState {
  selectedId: string;
  readonly collapsed: Set<string>;
  readonly toggles: Map<string, boolean>;
  readonly choices: Map<string, string>;
}

export function initialGalleryState(): GalleryState {
  return {
    selectedId: sample.tree.find((item) => item.selected)?.label ?? '',
    collapsed: new Set<string>(),
    toggles: new Map<string, boolean>(),
    choices: new Map<string, string>(),
  };
}

const SEVERITIES: readonly ValidationSeverity[] = ['error', 'warning', 'info'];

function severityOf(raw: string): ValidationSeverity | undefined {
  return SEVERITIES.find((severity) => severity === raw);
}

/**
 * Состояние валидации из данных. Причина обязательна по типу, поэтому строка
 * данных без ключа причины не даёт состояния вовсе — «покрасить и промолчать»
 * недостижимо и отсюда (ED-22).
 */
function validationOf(
  resources: StringResources,
  severity: string,
  reasonKey: string,
): ValidationState | undefined {
  const parsed = severityOf(severity);
  if (parsed === undefined || reasonKey === '') return undefined;
  return { severity: parsed, reason: resourceText(resources, reasonKey) };
}

type RawTreeItem = (typeof sample.tree)[number];
type RawField = (typeof sample.groups)[number]['fields'][number];

function treeItemOf(
  resources: StringResources,
  state: GalleryState,
  raw: RawTreeItem,
  items: readonly TreeItem[],
  refresh: () => void,
): TreeItem {
  const expanded = raw.expanded && !state.collapsed.has(raw.label);
  const validation = validationOf(resources, raw.severity, raw.reasonKey);
  return {
    id: raw.label,
    label: documentValue(raw.label),
    ...(raw.badge === '' ? {} : { badge: documentValue(raw.badge) }),
    expanded,
    selected: state.selectedId === raw.label,
    ...(items.length === 0 ? {} : { items }),
    ...(validation === undefined ? {} : { validation }),
    onSelect: (id: string) => {
      state.selectedId = id;
      refresh();
    },
    onToggle: (id: string) => {
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      refresh();
    },
  };
}

/**
 * Восстановление вложенности из плоского списка с глубиной. Данные плоские
 * намеренно: так каждая запись имеет один и тот же набор полей, и файл данных
 * читается как таблица, а не как дерево с дырами.
 */
function nest(
  resources: StringResources,
  state: GalleryState,
  rows: readonly RawTreeItem[],
  from: number,
  depth: number,
  refresh: () => void,
): { readonly items: readonly TreeItem[]; readonly next: number } {
  const items: TreeItem[] = [];
  let index = from;
  while (index < rows.length) {
    const raw = rows[index];
    if (raw === undefined || raw.depth < depth) break;
    const nested = nest(resources, state, rows, index + 1, depth + 1, refresh);
    items.push(treeItemOf(resources, state, raw, nested.items, refresh));
    index = nested.next;
  }
  return { items, next: index };
}

function controlOf(
  resources: StringResources,
  state: GalleryState,
  field: RawField,
  refresh: () => void,
): UiNode {
  const label = documentValue(field.label);
  const validation = validationOf(resources, field.severity, field.reasonKey);
  const extra = validation === undefined ? {} : { validation };

  switch (field.kind) {
    case 'toggle':
      return toggle({
        label,
        on: state.toggles.get(field.label) ?? field.on,
        onChange: (next) => {
          state.toggles.set(field.label, next);
          refresh();
        },
        ...extra,
      });
    case 'select': {
      const set = sample.optionSets.find((candidate) => candidate.id === field.optionSet);
      return select({
        label,
        value: state.choices.get(field.label) ?? field.value,
        options: (set?.options ?? []).map((option) => ({
          value: option.value,
          label: documentValue(option.label),
        })),
        onSelect: (next) => {
          state.choices.set(field.label, next);
          refresh();
        },
        ...extra,
      });
    }
    case 'number':
      return numberField({ label, value: documentValue(field.value), ...extra });
    default:
      return textField({ label, value: documentValue(field.value), ...extra });
  }
}

function fieldRowOf(
  resources: StringResources,
  state: GalleryState,
  group: string,
  field: RawField,
  refresh: () => void,
): FieldRowSpec {
  // Подсказка берётся по пути поля в схеме (ED-28) — единственным способом
  // вывода ключа, а не таблицей соответствий. Поля без описания показывают
  // сам ключ: пробел в ресурсах должен быть виден.
  const path = schemaPathOf('component', [group, field.name]);
  return {
    label: documentValue(field.label),
    control: controlOf(resources, state, field, refresh),
    ...(field.hint ? { hint: resourceText(resources, descriptionKey(path)) } : {}),
    ...(field.note === '' ? {} : { note: documentValue(field.note) }),
  };
}

/** Спецификация таблицы полей контрольного случая — то, что меряет тест плотности. */
export function controlCaseFields(
  resources: StringResources,
  state: GalleryState = initialGalleryState(),
  refresh: () => void = () => undefined,
): FieldTableSpec {
  const groups: FieldGroupSpec[] = sample.groups.map((group) => ({
    label: documentValue(group.label),
    rows: group.fields.map((field) => fieldRowOf(resources, state, group.label, field, refresh)),
  }));
  return { label: resourceText(resources, 'ui.inspector.fields'), groups };
}

function navigator(
  resources: StringResources,
  state: GalleryState,
  refresh: () => void,
): UiNode {
  return el('div', {
    // Колонки контрольного случая — те же зоны, что у скелета области: ширину
    // задаёт каркас (ED-24), и второго набора магических чисел здесь нет.
    classes: ['fx-panel', NAVIGATOR_ZONE_CLASS],
    children: [
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.navigator.title') }),
      tree({
        label: resourceText(resources, 'ui.navigator.title'),
        items: nest(resources, state, sample.tree, 0, 0, refresh).items,
      }),
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.navigator.assets') }),
      denseList({
        label: resourceText(resources, 'ui.navigator.assets'),
        items: sample.assets.map((asset) => ({
          id: asset.label,
          label: documentValue(asset.label),
          secondary: documentValue(asset.secondary),
          trailing: documentValue(asset.trailing),
        })),
      }),
    ],
  });
}

function topBar(resources: StringResources, refresh: () => void): UiNode {
  const localeButton = (locale: string, key: string): UiNode =>
    button({
      label: resourceText(resources, key),
      variant: 'ghost',
      onPress: () => {
        // Смена языка без перезапуска (ED-27): меняется локаль ресурсов,
        // страница перестраивается, документ не трогается вовсе.
        resources.setLocale(locale);
        refresh();
      },
    });

  return el('header', {
    classes: ['fx-bar'],
    children: [
      el('span', { classes: ['fx-bar__title'], text: resourceText(resources, 'ui.app.title') }),
      el('span', { classes: ['fx-row__secondary'], text: documentValue(sample.path) }),
      el('input', {
        classes: ['fx-input', 'fx-bar__search'],
        attrs: { type: 'search' },
        labels: {
          placeholder: resourceText(resources, 'ui.app.search'),
          ariaLabel: resourceText(resources, 'ui.app.search'),
        },
      }),
      localeButton('ru', 'ui.locale.ru'),
      localeButton('en', 'ui.locale.en'),
      button({ label: resourceText(resources, 'ui.action.showJson'), variant: 'ghost' }),
      button({ label: resourceText(resources, 'ui.action.save'), variant: 'secondary' }),
      button({
        label: resourceText(resources, 'ui.action.preview'),
        variant: 'primary',
        icon: 'play',
      }),
    ],
  });
}

function widgetShelf(resources: StringResources): UiNode {
  const tones: readonly (readonly [ChipTone, string])[] = [
    ['active', 'ui.chip.selected'],
    ['error', 'ui.chip.error'],
    ['warning', 'ui.chip.warning'],
    ['info', 'ui.chip.info'],
  ];
  // Оба поля берутся из данных, а не называются здесь: одно описано в бандле
  // проекта, второе — нет, и подсказка ко второму показывает сам ключ (ED-28).
  const hinted = sample.groups.flatMap((group) =>
    group.fields.filter((field) => field.hint).map((field) => ({ group, field })),
  );
  const described = hinted.find((entry) => entry.field.name === 'radius');
  const missing = hinted.find((entry) => entry.field.name === 'heightBonus');
  if (described === undefined || missing === undefined) {
    throw new Error('editor-ui: в данных контрольного случая нет полей с подсказкой');
  }
  const describedPath = schemaPathOf('component', [described.group.label, described.field.name]);
  const missingPath = schemaPathOf('component', [missing.group.label, missing.field.name]);

  return el('div', {
    classes: ['fx-surface', 'fx-stack'],
    children: [
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.gallery.title') }),
      el('div', {
        classes: ['fx-card', 'fx-cluster'],
        children: [
          button({
            label: resourceText(resources, 'ui.action.preview'),
            variant: 'primary',
            icon: 'play',
          }),
          button({ label: resourceText(resources, 'ui.action.save'), variant: 'secondary' }),
          button({ label: resourceText(resources, 'ui.action.addComponent'), variant: 'ghost' }),
          button({
            label: resourceText(resources, 'ui.action.remove'),
            variant: 'secondary',
            disabled: true,
          }),
        ],
      }),
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.gallery.states') }),
      el('div', {
        classes: ['fx-card', 'fx-cluster'],
        children: [
          statusChip({ label: documentValue(sample.selection.tag) }),
          ...tones.map(([tone, key]) => statusChip({ label: resourceText(resources, key), tone })),
        ],
      }),
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.gallery.hints') }),
      el('div', {
        classes: ['fx-cluster'],
        children: [
          tooltip({
            title: documentValue(described.field.label),
            body: resourceText(resources, descriptionKey(describedPath)),
            code: documentValue(descriptionKey(describedPath)),
          }),
          tooltip({
            body: resourceText(resources, descriptionKey(missingPath)),
            code: resourceText(resources, 'ui.tooltip.missingResource'),
          }),
        ],
      }),
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.gallery.frame') }),
      el('div', {
        classes: ['fx-frame-slot'],
        children: [
          viewportFrame({
            label: resourceText(resources, 'ui.viewport.label'),
            hostId: 'fx-gallery-viewport',
            overlays: [
              statusChip({
                label: resourceText(resources, 'ui.chip.editMode'),
                tone: 'active',
                icon: 'dot',
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/** Страница контрольного случая целиком. */
export function controlCasePage(
  resources: StringResources,
  state: GalleryState,
  refresh: () => void,
): UiNode {
  return el('div', {
    classes: [APP_CLASS],
    children: children(
      topBar(resources, refresh),
      el('div', {
        classes: ['fx-main'],
        children: [
          navigator(resources, state, refresh),
          widgetShelf(resources),
          el('div', {
            classes: ['fx-panel', INSPECTOR_ZONE_CLASS],
            children: [
              el('div', {
                classes: ['fx-section'],
                text: resourceText(resources, 'ui.inspector.title'),
              }),
              fieldTable(controlCaseFields(resources, state, refresh)),
            ],
          }),
        ],
      }),
    ),
  });
}

/**
 * Все строки файла данных — корпус, по которому тест ED-27 отличает значение
 * документа от литерала подписи. Собирается обходом, а не перечислением:
 * перечень разошёлся бы с данными на первой же правке.
 */
export function sampleDocumentStrings(): ReadonlySet<string> {
  const strings = jsonStrings(sample);
  // Ключи описаний — часть той же поверхности документа, что и имена полей:
  // ключ выводится из пути в схеме (ED-28), и подсказка показывает его, когда
  // ресурса нет. Значениями обхода они не являются, поэтому добавлены явно.
  for (const bundle of Object.values(sample.descriptions)) {
    for (const key of Object.keys(bundle)) strings.add(key);
  }
  return strings;
}
