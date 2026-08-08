/**
 * @contribution Рабочая область сцены — вклад, а не часть каркаса.
 *
 * Доменные имена («сцена», «террейн», «расстановка») в этом файле есть и
 * должны быть: ED-25 отправляет доменное знание во вклад ровно затем, чтобы его
 * не было в каркасе. Сканер `test/frameDomain.test.ts` пропускает файл по
 * пометке `@contribution` в шапке.
 *
 * Область тонкая намеренно: она занимает место, которое W3-1..W3-3 наполнят
 * настоящим вьюпортом, кистями и расстановкой. Тонкая — но не поддельная: три
 * зоны она заполняет по-своему (дерево — кадр — плотный инспектор), своё
 * состояние заводит настоящее (поза камеры, раскрытые узлы, строка под
 * фокусом), и именно на нём проверяется ED-23: уход в другую область и возврат
 * ничего из этого не теряют.
 */
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import type { AreaContext, AreaZones, WorkspaceArea } from '../frame/area.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { textField } from '../widgets/field.js';
import { fieldTable, type FieldGroupSpec } from '../widgets/fieldTable.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { viewportFrame } from '../viewport.js';
import { MATERIAL } from './material.js';

const SCENE = MATERIAL.scene;
type RawNode = (typeof SCENE.tree)[number];

/** Идентификатор области. Один и тот же в реестре, рельсе и записи состояния. */
export const SCENE_AREA_ID = 'area.scene';

/** Дальность камеры в шагах: границы нужны, чтобы кнопка на краю была видимо недоступна. */
const DISTANCE_MIN = 4;
const DISTANCE_MAX = 64;
const DISTANCE_STEP = 4;

/**
 * Состояние области. Заводит его область, хранит каркас (`frame/state.ts`) —
 * поэтому здесь обычные изменяемые поля, а не хитрость: запись живёт столько
 * же, сколько сессия, и переживает переключение сама собой.
 */
export interface SceneAreaState {
  /** Поза камеры. В W3-1 её получит конвейер `camera` (ED-13); пока — дальность. */
  camera: { distance: number };
  /** Раскрытые узлы навигатора. */
  readonly expanded: Set<string>;
  /** Строка навигатора под клавиатурным фокусом. */
  focusId: string;
}

/**
 * Восстановление вложенности из плоской таблицы: у каждой записи данных один и
 * тот же набор полей, и файл материала читается таблицей, а не деревом с дырами.
 */
function treeItems(
  context: AreaContext<SceneAreaState>,
  rows: readonly RawNode[],
  from: number,
  depth: number,
): { readonly items: readonly TreeItem[]; readonly next: number } {
  const items: TreeItem[] = [];
  let index = from;
  while (index < rows.length) {
    const raw = rows[index];
    if (raw === undefined || raw.depth < depth) break;
    const nested = treeItems(context, rows, index + 1, depth + 1);
    items.push(itemOf(context, raw, nested.items));
    index = nested.next;
  }
  return { items, next: index };
}

function itemOf(
  context: AreaContext<SceneAreaState>,
  raw: RawNode,
  nested: readonly TreeItem[],
): TreeItem {
  const { state, selection } = context;
  return {
    id: raw.id,
    label: documentValue(raw.label),
    ...(raw.badge === '' ? {} : { badge: documentValue(raw.badge) }),
    expanded: state.expanded.has(raw.id),
    selected: selection.has(raw.id),
    ...(nested.length === 0 ? {} : { items: nested }),
    onSelect: (id) => {
      state.focusId = id;
      selection.set([id]);
    },
    onToggle: (id) => {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      context.refresh();
    },
  };
}

function navigator(context: AreaContext<SceneAreaState>): UiNode {
  // Прокрутку зоны заводит каркас (ED-24), а не область: своя прокрутка внутри
  // прокручиваемой зоны дала бы две полосы на одну колонку.
  return el('div', {
    children: [
      el('div', {
        classes: ['fx-section'],
        text: resourceText(context.resources, 'ui.navigator.title'),
      }),
      tree({
        label: resourceText(context.resources, 'ui.navigator.title'),
        items: treeItems(context, SCENE.tree, 0, 0).items,
        rovingId: 'scene-tree',
        activeId: context.state.focusId,
        onActive: (id) => {
          context.state.focusId = id;
          context.refresh();
        },
      }),
    ],
  });
}

function surface(context: AreaContext<SceneAreaState>): UiNode {
  const { state, resources } = context;
  const zoom = (delta: number, key: string, disabled: boolean): UiNode =>
    button({
      label: resourceText(resources, key),
      variant: 'ghost',
      disabled,
      onPress: () => {
        state.camera = { distance: state.camera.distance + delta };
        context.refresh();
      },
    });

  return el('div', {
    classes: [FILL_CLASS, FILL_COLUMN_CLASS],
    children: [
      el('div', {
        classes: ['fx-bar'],
        children: [
          statusChip({
            label: resourceText(resources, 'ui.chip.editMode'),
            tone: 'active',
            icon: 'dot',
          }),
          zoom(-DISTANCE_STEP, 'ui.area.scene.zoomIn', state.camera.distance <= DISTANCE_MIN),
          zoom(DISTANCE_STEP, 'ui.area.scene.zoomOut', state.camera.distance >= DISTANCE_MAX),
        ],
      }),
      el('div', {
        classes: [FILL_CLASS],
        children: [
          viewportFrame({
            label: resourceText(resources, 'ui.viewport.label'),
            hostId: 'fx-scene-viewport',
            overlays: [
              statusChip({ label: documentValue(SCENE.documentId), icon: 'dot' }),
            ],
          }),
        ],
      }),
    ],
  });
}

function inspector(context: AreaContext<SceneAreaState>): UiNode {
  const selected = context.selection.current()[0];
  const groups: FieldGroupSpec[] = SCENE.groups.map((group) => ({
    label: documentValue(group.label),
    rows: group.fields.map((field) => ({
      label: documentValue(field.name),
      // Правка полей — задача W2-3: инспектор строится из схемы редактируемого
      // (ED-24), а реестр схем приносит W1-4. До тех пор поля показаны, но не
      // правятся, и «не правятся» здесь видно, а не молча не срабатывает (ED-26).
      control: textField({
        label: documentValue(field.name),
        value: documentValue(field.value),
        readOnly: true,
      }),
      note: documentValue(field.note),
    })),
  }));

  return el('div', {
    children: children(
      el('div', {
        classes: ['fx-section'],
        children: children(
          el('span', { text: resourceText(context.resources, 'ui.inspector.title') }),
          selected === undefined
            ? undefined
            : el('span', {
                classes: ['fx-row__trailing'],
                children: [statusChip({ label: documentValue(selected) })],
              }),
        ),
      }),
      fieldTable({
        label: resourceText(context.resources, 'ui.inspector.fields'),
        groups,
      }),
    ),
  });
}

export const sceneArea: WorkspaceArea<SceneAreaState> = {
  id: SCENE_AREA_ID,
  descriptionKey: 'ui.area.scene.description',
  labelKey: 'ui.area.scene.label',
  hotkey: 'F1',
  icon: 'layers',
  editableTypes: [{ id: 'scene', descriptionKey: 'ui.editable.scene.description' }],
  createState(): SceneAreaState {
    const root = SCENE.tree[0]?.id ?? '';
    return {
      camera: { distance: 24 },
      expanded: new Set(SCENE.tree.filter((node) => node.depth < 2).map((node) => node.id)),
      focusId: root,
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
