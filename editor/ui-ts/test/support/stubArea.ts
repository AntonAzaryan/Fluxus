/**
 * Фикстурная рабочая область набора тестов — «вторая непохожая область».
 *
 * ED-24 и ED-23 проверяются не на одной области: скелет один, а содержимое зон
 * разное, состояние переживает переключение, история сквозная. Значит, каркасу
 * нужна вторая область, ни в чём не похожая на область сцены. Раньше ею
 * работала заглушка систем (`src/areas/systems.ts` на `src/areas/material.json`),
 * то есть production-модуль, который никто не открывал; настоящей области
 * систем нужен открытый проект, и в этой роли она не годится — тесты каркаса не
 * должны зависеть от того, нашлась ли сцена. Поэтому область переехала сюда
 * фикстурой набора, по образцу `outsiderArea` из `frameExtension.test.ts`.
 *
 * Что в ней важно и должно сохраняться при любой правке:
 *
 * - три зоны непохожи на область сцены: навигатор — плоский список документов,
 *   а не дерево; поверхность правки — карточки «событие — условие — действие»,
 *   а не кадр; инспектор — переключатели, а не столбец значений;
 * - она действительно правит документ и правит его ЗАРЕГИСТРИРОВАННОЙ операцией
 *   (ED-29): на этой правке стоят сценарии ED-23 «отмена правки, сделанной в
 *   другой области» и ED-18 «история одна на сессию»;
 * - подписи она берёт из уже существующих ресурсов пакета: файлы локалей
 *   фикстура не правит, а материал (значения документа) лежит рядом в
 *   `material.json`.
 */
import { documentValue, el, resourceText, type UiNode } from '../../src/dom/node.js';
import type {
  AreaContext,
  AreaSearch,
  AreaSetup,
  AreaZones,
  WorkspaceArea,
} from '../../src/frame/area.js';
import { SCROLL_CLASS } from '../../src/frame/styles.js';
import { inspectorPanel, type InspectorSubject, type SchemaField } from '../../src/inspector/index.js';
import { matchesQuery, type SearchHit } from '../../src/palette/palette.js';
import { statusChip } from '../../src/widgets/chip.js';
import { denseList } from '../../src/widgets/rows.js';
import { MATERIAL } from './material.js';

const STUB = MATERIAL.systems;

/** Идентификатор фикстурной области: своё имя, не занятое ни одним вкладом пакета. */
const STUB_AREA_ID = 'area.stub';

/**
 * Своя горячая клавиша: `F1` у области сцены, `F3` у просмотрщика ассетов,
 * `F7`–`F9` разбирают сами тесты под свои области. `F6` свободна, и проверка
 * «чужое сочетание каркас не забирает» по-прежнему берёт незанятую клавишу.
 */
const STUB_HOTKEY = 'F6';

/**
 * Вид редактируемого, который вносит фикстура (ED-30). Тот же, что был у
 * заглушки: правила валидации проекта адресуют документы по виду, и смена вида
 * поменяла бы не фикстуру, а то, что на ней проверяется.
 */
const STUB_DOCUMENT_KIND = 'system';

/** Путь до карты флагов в документе — адрес правки для операции (ED-29). */
const FLAGS_PATH = ['flags'] as const;

export interface StubAreaState {
  /** Документ, открытый областью в сессии: правки идут только в него. */
  readonly documentId: string;
  /** Правило, раскрытое на поверхности правки. */
  ruleId: string;
  /** Строка навигатора под клавиатурным фокусом. */
  focusId: string;
}

/**
 * Схема флагов документа. Лежит в материале рядом с самим документом, а не
 * списком в этом файле: инспектор строится из схемы (ED-24), и подсунуть ему
 * список имён значило бы проверять его на том, чего он не делает.
 */
function flagSchema(): readonly SchemaField[] {
  return Object.entries(STUB.schema.flags).map(
    ([name, type]): SchemaField => ({
      name,
      type,
      path: [...FLAGS_PATH, name],
      // Ключ описания вычисляется из пути (ED-28). Ресурса на него нет ни в
      // одной локали, и подсказка показывает сам ключ — видимый признак того,
      // что поле не документировано.
      description: [STUB_DOCUMENT_KIND, name],
    }),
  );
}

function navigator(context: AreaContext<StubAreaState>): UiNode {
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
        items: STUB.documents.map((document) => ({
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
function ruleCard(context: AreaContext<StubAreaState>, rule: (typeof STUB.document.rules)[number]): UiNode {
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

function surface(context: AreaContext<StubAreaState>): UiNode {
  return el('div', {
    classes: [SCROLL_CLASS, 'fx-stack'],
    children: [
      el('div', {
        classes: ['fx-section'],
        text: resourceText(context.resources, 'ui.area.systems.rules'),
      }),
      ...STUB.document.rules.map((rule) => ruleCard(context, rule)),
    ],
  });
}

/**
 * Инспектор — тот же, что у остальных областей (ED-24), и правит он тем же
 * слоем операций (ED-29): область не заводит ни своих контролов по типу поля,
 * ни своего пути записи в документ. Отсюда же и «редактор поля подхватывается
 * во всех областях сразу» (ED-25): реестр приходит от каркаса.
 */
function subjectOf(context: AreaContext<StubAreaState>): InspectorSubject {
  return {
    address: { documentId: context.state.documentId },
    groups: [{ name: STUB.document.id, fields: flagSchema() }],
    title: documentValue(STUB.document.id),
  };
}

function inspector(context: AreaContext<StubAreaState>): UiNode {
  return inspectorPanel({
    resources: context.resources,
    session: context.session,
    fieldEditors: context.fieldEditors,
    subject: subjectOf(context),
    disabled: context.mode === 'preview',
  });
}

export const stubArea: WorkspaceArea<StubAreaState> = {
  id: STUB_AREA_ID,
  descriptionKey: 'ui.area.systems.description',
  labelKey: 'ui.area.systems.label',
  hotkey: STUB_HOTKEY,
  icon: 'graph',
  editableTypes: [
    { id: STUB_DOCUMENT_KIND, descriptionKey: 'ui.editable.system.description' },
  ],
  /**
   * Поиск по проекту (ED-24): документы области по их имени. Находка выделяет
   * документ, не проходя дерево, — на этом стоит проверка «находка соседней
   * области открывается вместе с переходом в неё».
   */
  search(input: AreaSearch<StubAreaState>): readonly SearchHit[] {
    const { query, state, selection } = input;
    return STUB.documents
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
  createState(setup: AreaSetup): StubAreaState {
    const documentId = STUB.documentId;
    // Документ открывается один раз на сессию — вместе с записью состояния.
    // Открывать его в отрисовке было бы правкой сессии из показа.
    if (!setup.session.isOpen(documentId)) {
      setup.session.openDocument({
        id: documentId,
        kind: STUB_DOCUMENT_KIND,
        value: STUB.document,
      });
    }
    return {
      documentId,
      ruleId: STUB.document.rules[0]?.id ?? '',
      focusId: STUB.documents[0]?.id ?? '',
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
