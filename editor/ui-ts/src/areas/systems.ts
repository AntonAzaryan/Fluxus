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
import { documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import type {
  AreaContext,
  AreaSearch,
  AreaSetup,
  AreaZones,
  WorkspaceArea,
} from '../frame/area.js';
import { SCROLL_CLASS } from '../frame/styles.js';
import { inspectorPanel, type InspectorSubject, type SchemaField } from '../inspector/index.js';
import { matchesQuery, type SearchHit } from '../palette/palette.js';
import { statusChip } from '../widgets/chip.js';
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

/**
 * Схема флагов документа — заглушка на месте настоящего реестра схем систем
 * (ED-4, ED-5 — следующий проход). Лежит в материале рядом с самим документом,
 * а не списком в этом файле: инспектор строится из схемы (ED-24), и подсунуть
 * ему список имён значило бы проверять его на том, чего он не делает.
 */
function flagSchema(): readonly SchemaField[] {
  return Object.entries(MATERIAL.systems.schema.flags).map(
    ([name, type]): SchemaField => ({
      name,
      type,
      path: [...FLAGS_PATH, name],
      // Ключ описания вычисляется из пути (ED-28). Ресурса на него нет ни в
      // одной локали, и подсказка показывает сам ключ — видимый признак того,
      // что поле не документировано.
      description: [SYSTEM_DOCUMENT_KIND, name],
    }),
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

/**
 * Инспектор — тот же, что у остальных областей (ED-24), и правит он тем же
 * слоем операций (ED-29): область не заводит ни своих контролов по типу поля,
 * ни своего пути записи в документ. Отсюда же и «редактор поля подхватывается
 * во всех областях сразу» (ED-25): реестр приходит от каркаса.
 */
function subjectOf(context: AreaContext<SystemsAreaState>): InspectorSubject {
  return {
    address: { documentId: context.state.documentId },
    groups: [{ name: SYSTEMS.document.id, fields: flagSchema() }],
    title: documentValue(SYSTEMS.document.id),
  };
}

function inspector(context: AreaContext<SystemsAreaState>): UiNode {
  return inspectorPanel({
    resources: context.resources,
    session: context.session,
    fieldEditors: context.fieldEditors,
    subject: subjectOf(context),
    disabled: context.mode === 'preview',
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
  /**
   * Поиск по проекту (ED-24): документы области по их имени. Сценарий требования
   * — «автор ищет систему по имени в проекте с сотней документов» — закрывается
   * ровно этим: находка выделяет документ, не проходя дерево.
   */
  search(input: AreaSearch<SystemsAreaState>): readonly SearchHit[] {
    const { query, state, selection } = input;
    return SYSTEMS.documents
      .filter((document) => matchesQuery(query, document.id, document.label))
      .map((document) => ({
        id: document.id,
        label: documentValue(document.label),
        detail: documentValue(document.id),
        icon: 'graph' as const,
        reveal: () => {
          state.focusId = document.id;
          selection.set([document.id]);
        },
      }));
  },
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
