/**
 * @contribution Рабочая область систем — вклад, а не часть каркаса.
 *
 * Доменные имена («система», «событие — условие — действие») здесь есть и
 * должны быть: сканер `test/frameDomain.test.ts` пропускает файл по пометке
 * `@contribution`, и ровно в этом смысл ED-25 — доменное знание живёт во
 * вкладе.
 *
 * Область намеренно не похожа на область сцены ни одной из трёх зон:
 * навигатор — плоский список документов, а не дерево; поверхность правки —
 * список правил «событие — условие — действие» (ED-4), а не кадр; инспектор —
 * переключатели, а не столбец значений. Это и есть проверка ED-24 на деле:
 * содержимое зон разное, места зон те же.
 *
 * И это же единственная сегодня область, которая действительно правит
 * документ, — и правит его зарегистрированной операцией (ED-29), потому что
 * другого способа у неё нет: сессия отдаёт замороженное значение и мутирующего
 * метода не имеет. На этой правке проверяется сценарий ED-23 «отмена правки,
 * сделанной в другой области».
 */
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import type { AreaContext, AreaSetup, AreaZones, WorkspaceArea } from '../frame/area.js';
import { SCROLL_CLASS } from '../frame/styles.js';
import { statusChip } from '../widgets/chip.js';
import { toggle } from '../widgets/field.js';
import { fieldTable, type FieldRowSpec } from '../widgets/fieldTable.js';
import { denseList } from '../widgets/rows.js';
import { MATERIAL } from './material.js';

const SYSTEMS = MATERIAL.systems;

/** Идентификатор области. */
export const SYSTEMS_AREA_ID = 'area.systems';

/** Вид редактируемого, который вносит эта область (ED-30). */
export const SYSTEM_DOCUMENT_KIND = 'system';

/** Путь до карты флагов в документе — адрес правки для операции (ED-29). */
const FLAGS_PATH = ['flags'] as const;

export interface SystemsAreaState {
  /** Документ, открытый областью в сессии: правки идут только в него. */
  readonly documentId: string;
  /** Правило, раскрытое на поверхности правки. */
  ruleId: string;
  /** Строка навигатора под клавиатурным фокусом. */
  focusId: string;
}

function flagsOf(context: AreaContext<SystemsAreaState>): Readonly<Record<string, boolean>> {
  const value = context.session.documentValue(context.state.documentId);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const flags = (value as Record<string, unknown>).flags;
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return {};
  return Object.fromEntries(
    Object.entries(flags).map(([name, raw]) => [name, raw === true]),
  );
}

function navigator(context: AreaContext<SystemsAreaState>): UiNode {
  const { resources, selection, state } = context;
  return el('div', {
    children: [
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.navigator.title') }),
      denseList({
        label: resourceText(resources, 'ui.navigator.title'),
        rovingId: 'systems-list',
        activeId: state.focusId,
        onActive: (id) => {
          state.focusId = id;
          context.refresh();
        },
        items: SYSTEMS.documents.map((document) => ({
          id: document.id,
          label: documentValue(document.label),
          secondary: documentValue(document.secondary),
          icon: 'graph' as const,
          selected: selection.has(document.id),
          onSelect: (id) => {
            state.focusId = id;
            selection.set([id]);
          },
        })),
      }),
    ],
  });
}

/** Одно правило: событие, условия, действия — тремя строками, а не одним JSON. */
function ruleCard(context: AreaContext<SystemsAreaState>, rule: (typeof SYSTEMS.document.rules)[number]): UiNode {
  const { resources, state } = context;
  const line = (key: string, value: string): UiNode =>
    el('div', {
      classes: ['fx-row'],
      children: [
        el('span', { classes: ['fx-row__secondary'], text: resourceText(resources, key) }),
        el('span', { classes: ['fx-row__label'], text: documentValue(value) }),
      ],
    });

  return el('div', {
    classes: ['fx-card', ...(state.ruleId === rule.id ? ['fx-is-selected'] : [])],
    attrs: { 'data-rule': rule.id },
    children: [
      el('div', {
        classes: ['fx-cluster'],
        children: [statusChip({ label: documentValue(rule.id) })],
      }),
      line('ui.area.systems.event', rule.event),
      line('ui.area.systems.condition', rule.condition),
      line('ui.area.systems.action', rule.action),
    ],
    on: {
      click: () => {
        state.ruleId = rule.id;
        context.refresh();
      },
    },
  });
}

function surface(context: AreaContext<SystemsAreaState>): UiNode {
  return el('div', {
    classes: [SCROLL_CLASS, 'fx-stack'],
    children: [
      el('div', {
        classes: ['fx-section'],
        text: resourceText(context.resources, 'ui.area.systems.rules'),
      }),
      ...SYSTEMS.document.rules.map((rule) => ruleCard(context, rule)),
    ],
  });
}

function inspector(context: AreaContext<SystemsAreaState>): UiNode {
  const { resources, session, state } = context;
  const rows: FieldRowSpec[] = Object.entries(flagsOf(context)).map(([name, on]) => ({
    label: documentValue(name),
    control: toggle({
      label: documentValue(name),
      on,
      onChange: (next) => {
        // Единственный путь правки — зарегистрированная операция (ED-29).
        // Прямой записи в документ у интерфейса нет: сессия отдаёт значение
        // замороженным, и обойти историю (ED-18) нечем. Перерисовки область не
        // просит: документ изменился, и каркас узнаёт об этом от сессии — так
        // же, как узнал бы о правке, пришедшей вообще не из интерфейса.
        session.applyOperation('document.setValue', {
          document: state.documentId,
          path: [...FLAGS_PATH, name],
          value: next,
        });
      },
    }),
  }));

  return el('div', {
    children: children(
      el('div', { classes: ['fx-section'], text: resourceText(resources, 'ui.inspector.title') }),
      fieldTable({
        label: resourceText(resources, 'ui.area.systems.flags'),
        groups: [{ label: documentValue(SYSTEMS.document.id), rows }],
      }),
    ),
  });
}

export const systemsArea: WorkspaceArea<SystemsAreaState> = {
  id: SYSTEMS_AREA_ID,
  descriptionKey: 'ui.area.systems.description',
  labelKey: 'ui.area.systems.label',
  hotkey: 'F2',
  icon: 'graph',
  editableTypes: [
    { id: SYSTEM_DOCUMENT_KIND, descriptionKey: 'ui.editable.system.description' },
  ],
  createState(setup: AreaSetup): SystemsAreaState {
    const documentId = SYSTEMS.documentId;
    // Документ открывается один раз на сессию — вместе с записью состояния.
    // Открывать его в отрисовке было бы правкой сессии из показа.
    if (!setup.session.isOpen(documentId)) {
      setup.session.openDocument({
        id: documentId,
        kind: SYSTEM_DOCUMENT_KIND,
        value: SYSTEMS.document,
      });
    }
    return {
      documentId,
      ruleId: SYSTEMS.document.rules[0]?.id ?? '',
      focusId: SYSTEMS.documents[0]?.id ?? '',
    };
  },
  render(context): AreaZones {
    return {
      navigator: navigator(context),
      surface: surface(context),
      inspector: inspector(context),
    };
  },
};
