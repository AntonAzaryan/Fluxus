/**
 * @contribution Рабочая область сцены — вклад, а не часть каркаса.
 *
 * Доменные имена («сцена», «террейн», «расстановка») в этом файле есть и должны
 * быть: ED-25 отправляет доменное знание во вклад ровно затем, чтобы его не
 * было в каркасе. Сканер `test/frameDomain.test.ts` пропускает файл по пометке
 * `@contribution` в шапке.
 *
 * Скелет области — тот же, что у всех (ED-24): навигатор редактируемого
 * (документы сцены и её расстановка), поверхность правки (кадр вьюпорта) и
 * инспектор выбранного. Что в этих зонах:
 *
 * - **навигатор** — открытые документы сцены и записи её начальной расстановки
 *   (SER-7, SER-8), а не выдуманное дерево: строка есть ровно у того, что
 *   существует в документе;
 * - **поверхность** — кадр вьюпорта (ED-15) и переключатели режима камеры
 *   (ED-13, CAM-2). Рисует его рендер движка, а не эта область: содержимое
 *   кадра приносит `sceneStage.ts`, здесь только узел, в который он встаёт;
 * - **инспектор** — поля выбранной записи. Пока схемы (ED-24) приносит W2-3,
 *   поля показаны, но не правятся, и «не правятся» здесь видно (ED-26).
 *
 * Состояние области — запись, которую хранит каркас (ED-23): в ней живёт и
 * вьюпорт со своим конвейером камеры, поэтому уход в другую область и возврат
 * не теряют ни позы, ни зума, ни раскрытых узлов.
 */
import { createHostAssetSource, type EnvironmentHost } from '@game-mvp/editor-core';
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import type { AreaContext, AreaSetup, AreaZones, WorkspaceArea } from '../frame/area.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { textField } from '../widgets/field.js';
import { fieldTable, type FieldRowSpec } from '../widgets/fieldTable.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { withValidation } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import type { ScenePlacement } from './sceneDocuments.js';
import { canRender, createSceneStage, type SceneStage } from './sceneStage.js';
import {
  draftOf,
  openSceneProject,
  type SceneProject,
  type SceneProjectIds,
} from './sceneProject.js';
import type { SceneDraft } from './sceneDocuments.js';

/** Идентификатор области. Один и тот же в реестре, рельсе и записи состояния. */
export const SCENE_AREA_ID = 'area.scene';

/** Узел кадра, в который встаёт холст рендера (`sceneStage.ts`). */
export const SCENE_VIEWPORT_ID = 'fx-scene-viewport';

/** Группы навигатора: не документы и не записи, а места, куда они складываются. */
export const SCENE_NODES = {
  placements: 'scene.placements',
  assets: 'scene.assets',
} as const;

/** Сцена репозитория: то, что редактор открывает, пока открытия проекта нет (W4-1). */
export const DEFAULT_SCENE_IDS: SceneProjectIds = {
  config: 'scenes/duel.scene.json',
  visuals: 'visuals/manifest.json',
};

/** Шаг колеса на нажатие кнопки бара: тот же вход зума, что у самого колеса (CAM-4). */
const ZOOM_STEP = 1;

/**
 * Чем собирается вьюпорт. `announce` — обратный канал: вьюпорт зовёт его,
 * когда у него изменилось видимое в интерфейсе (режим камеры CAM-2, причина
 * сорвавшегося кадра ED-8). Спрашивать это сразу после нажатия нельзя: режим
 * доходит до конвейера вводом и применяется его ближайшим кадром.
 */
export type SceneStageFactory = (
  project: SceneProject,
  host: EnvironmentHost,
  announce: () => void,
) => SceneStage | null;

export interface SceneAreaOptions {
  /** Хост среды (ED-12): откуда читаются документы сцены. Нет — проект не открыт. */
  readonly host?: EnvironmentHost;
  readonly ids?: SceneProjectIds;
  /**
   * Чем собирается вьюпорт. Подменяется тестом на структурный дубль: WebGL в
   * headless-прогоне нет, а проверять подачу документов рендеру надо.
   */
  readonly stage?: SceneStageFactory;
}

export interface SceneAreaState {
  /** Открытые документы сцены; `null` — проект ещё не открыт или не открылся. */
  project: SceneProject | null;
  /** Вьюпорт со своим конвейером камеры; `null` — в этой среде рисовать нечем. */
  stage: SceneStage | null;
  /** Текущий кадр как функция документов (ED-15). */
  draft: SceneDraft | null;
  /** Почему проект не открылся; показывается на поверхности правки. */
  failure: string | null;
  /** Раскрытые узлы навигатора. */
  readonly expanded: Set<string>;
  /** Строка навигатора под клавиатурным фокусом. */
  focusId: string;
  /** Просьба перерисовать после асинхронного открытия; ставится отрисовкой. */
  refresh: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Вьюпорт по умолчанию: рендер движка там, где есть чем рисовать (ED-1). */
function defaultStage(
  project: SceneProject,
  host: EnvironmentHost,
  announce: () => void,
): SceneStage | null {
  if (!canRender()) return null;
  return createSceneStage({
    hostId: SCENE_VIEWPORT_ID,
    // Тот же шов к дереву, через который читаются документы (ASSET-2, ED-12).
    assets: createHostAssetSource(host.content),
    visuals: project.visuals,
    onChange: announce,
  });
}

/**
 * Открытие проекта и слежение за документами. Пересчёт кадра подписан на
 * сессию, а не на отрисовку страницы: ED-15 обещает отклик на правку, а не на
 * то, что кто-то перерисовал интерфейс.
 */
function start(state: SceneAreaState, setup: AreaSetup, options: SceneAreaOptions): void {
  const host = options.host;
  if (host === undefined) return;
  const ids = options.ids ?? DEFAULT_SCENE_IDS;
  const build = options.stage ?? defaultStage;

  openSceneProject(setup.session, host.content, ids)
    .then((project) => {
      state.project = project;
      state.stage = build(project, host, () => {
        state.refresh();
      });
      let config: unknown = undefined;
      let curvature: unknown = undefined;
      const recompute = (): void => {
        // Значения сессии заморожены и подменяются целиком, поэтому сравнение
        // по ссылке отвечает на вопрос «изменилось ли» точно и даром: выделение
        // и открытие соседнего документа кадра не трогают.
        const nextConfig = setup.session.documentValue(project.configId);
        const nextCurvature =
          project.curvatureId === null || !setup.session.isOpen(project.curvatureId)
            ? null
            : setup.session.documentValue(project.curvatureId);
        if (state.draft !== null && nextConfig === config && nextCurvature === curvature) return;
        config = nextConfig;
        curvature = nextCurvature;
        state.draft = draftOf(setup.session, project);
        state.stage?.submit(state.draft);
        state.refresh();
      };
      setup.session.subscribe(recompute);
      recompute();
    })
    .catch((error: unknown) => {
      state.failure = message(error);
      state.refresh();
    });
}

// ------------------------------------------------------------------ зоны

function placementItem(context: AreaContext<SceneAreaState>, placement: ScenePlacement): TreeItem {
  const { state, selection } = context;
  return {
    id: placement.key,
    label: documentValue(placement.prefab),
    ...(placement.kind === null ? {} : { badge: documentValue(placement.kind) }),
    selected: selection.has(placement.key),
    onSelect: (id) => {
      state.focusId = id;
      selection.set([id]);
    },
  };
}

function documentItem(context: AreaContext<SceneAreaState>, id: string): TreeItem {
  const { state, selection } = context;
  return {
    id,
    label: documentValue(id),
    selected: selection.has(id),
    onSelect: (selected) => {
      state.focusId = selected;
      selection.set([selected]);
    },
  };
}

function group(
  context: AreaContext<SceneAreaState>,
  id: string,
  labelKey: string,
  items: readonly TreeItem[],
): TreeItem {
  const { state } = context;
  return {
    id,
    label: resourceText(context.resources, labelKey),
    expanded: state.expanded.has(id),
    ...(items.length === 0 ? {} : { items }),
    onSelect: (selected) => {
      state.focusId = selected;
      context.selection.set([selected]);
    },
    onToggle: (selected) => {
      if (state.expanded.has(selected)) state.expanded.delete(selected);
      else state.expanded.add(selected);
      context.refresh();
    },
  };
}

function navigator(context: AreaContext<SceneAreaState>): UiNode {
  const { state, resources } = context;
  const title = el('div', {
    classes: ['fx-section'],
    text: resourceText(resources, 'ui.navigator.title'),
  });
  const project = state.project;
  if (project === null) {
    return el('div', {
      children: [
        title,
        el('div', {
          classes: ['fx-row'],
          text: resourceText(resources, 'ui.area.scene.noProject'),
        }),
      ],
    });
  }

  const assets: TreeItem[] = [documentItem(context, project.visualsId)];
  if (project.curvatureId !== null) assets.push(documentItem(context, project.curvatureId));
  const placements = (state.draft?.placements ?? []).map((placement) =>
    placementItem(context, placement),
  );

  const root: TreeItem = {
    id: project.configId,
    label: documentValue(project.configId),
    expanded: state.expanded.has(project.configId),
    selected: context.selection.has(project.configId),
    items: [
      group(context, SCENE_NODES.placements, 'ui.area.scene.placements', placements),
      group(context, SCENE_NODES.assets, 'ui.navigator.assets', assets),
    ],
    onSelect: (id) => {
      state.focusId = id;
      context.selection.set([id]);
    },
    onToggle: (id) => {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      context.refresh();
    },
  };

  return el('div', {
    children: [
      title,
      tree({
        label: resourceText(resources, 'ui.navigator.title'),
        items: [root],
        rovingId: 'scene-tree',
        activeId: state.focusId,
        onActive: (id) => {
          state.focusId = id;
          context.refresh();
        },
      }),
    ],
  });
}

function surface(context: AreaContext<SceneAreaState>): UiNode {
  const { state, resources } = context;
  const stage = state.stage;
  // Три источника одной причины, а не три способа её показать: не открылся
  // проект, не сошлись документы, не прошёл кадр (ED-8, ED-30).
  const failure = state.failure ?? state.draft?.failure ?? stage?.failure ?? null;

  const zoom = (steps: number, key: string): UiNode =>
    button({
      label: resourceText(resources, key),
      variant: 'ghost',
      disabled: stage === null,
      onPress: () => {
        stage?.zoom(steps);
      },
    });

  return el('div', {
    classes: [FILL_CLASS, FILL_COLUMN_CLASS],
    children: children(
      el('div', {
        classes: ['fx-bar'],
        children: children(
          statusChip({
            label: resourceText(resources, 'ui.chip.editMode'),
            tone: 'active',
            icon: 'dot',
          }),
          // Облёт — режим конвейера камеры (CAM-2, ED-13), а не второй способ
          // считать позу; free-RTS — тот же конвейер без цели слежения (CAM-7).
          button({
            label: resourceText(
              resources,
              stage?.flying === true ? 'ui.area.scene.cameraFly' : 'ui.area.scene.cameraFree',
            ),
            variant: 'ghost',
            icon: 'layers',
            disabled: stage === null,
            // Перерисовку просит сам вьюпорт, когда режим до конвейера дошёл:
            // спросить `flying` прямо здесь значило бы получить прежний ответ
            // и показывать один режим, пока камера в другом (ED-26).
            onPress: () => {
              stage?.toggleFly();
            },
          }),
          zoom(-ZOOM_STEP, 'ui.area.scene.zoomIn'),
          zoom(ZOOM_STEP, 'ui.area.scene.zoomOut'),
          // Причина — не оттенок: иконку, положение и текст ставит один вызов
          // (ED-8, ED-22), а сам текст приходит от ядра, а не сочиняется здесь.
          failure === null
            ? undefined
            : withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.scene.brokenDocument'),
                  tone: 'error',
                }),
                { severity: 'error', reason: documentValue(failure) },
              ),
        ),
      }),
      el('div', {
        classes: [FILL_CLASS],
        children: [
          viewportFrame({
            label: resourceText(resources, 'ui.viewport.label'),
            hostId: SCENE_VIEWPORT_ID,
          }),
        ],
      }),
    ),
  });
}

function inspector(context: AreaContext<SceneAreaState>): UiNode {
  const { state, resources } = context;
  const selected = context.selection.current()[0];
  const placement = (state.draft?.placements ?? []).find((item) => item.key === selected);

  const rows: FieldRowSpec[] =
    placement === undefined
      ? []
      : [
          {
            label: resourceText(resources, 'ui.area.scene.field.prefab'),
            control: textField({
              label: resourceText(resources, 'ui.area.scene.field.prefab'),
              value: documentValue(placement.prefab),
              readOnly: true,
            }),
          },
          // Позиция и уровень — производные worldInit: их выводит ядро (TERR-4),
          // и правит их W3-3, ставя объект во вьюпорте.
          ...(
            [
              ['ui.area.scene.field.x', placement.x.toFixed(3)],
              ['ui.area.scene.field.y', placement.y.toFixed(3)],
              ['ui.area.scene.field.level', String(placement.level ?? 0)],
            ] as const
          ).map(([key, value]) => ({
            label: resourceText(resources, key),
            control: textField({
              label: resourceText(resources, key),
              value: documentValue(value),
              readOnly: true,
            }),
            note: resourceText(resources, 'ui.validation.derived'),
          })),
        ];

  return el('div', {
    children: children(
      el('div', {
        classes: ['fx-section'],
        children: children(
          el('span', { text: resourceText(resources, 'ui.inspector.title') }),
          placement === undefined
            ? undefined
            : el('span', {
                classes: ['fx-row__trailing'],
                children: [statusChip({ label: documentValue(placement.prefab) })],
              }),
        ),
      }),
      rows.length === 0
        ? el('div', {
            classes: ['fx-row'],
            text: resourceText(resources, 'ui.inspector.empty'),
          })
        : fieldTable({
            label: resourceText(resources, 'ui.inspector.fields'),
            groups: [{ label: resourceText(resources, 'ui.inspector.fields'), rows }],
          }),
    ),
  });
}

export function createSceneArea(options: SceneAreaOptions = {}): WorkspaceArea<SceneAreaState> {
  return {
    id: SCENE_AREA_ID,
    descriptionKey: 'ui.area.scene.description',
    labelKey: 'ui.area.scene.label',
    hotkey: 'F1',
    icon: 'layers',
    editableTypes: [{ id: 'scene', descriptionKey: 'ui.editable.scene.description' }],
    createState(setup): SceneAreaState {
      const ids = options.ids ?? DEFAULT_SCENE_IDS;
      const state: SceneAreaState = {
        project: null,
        stage: null,
        draft: null,
        failure: null,
        expanded: new Set([ids.config, SCENE_NODES.placements, SCENE_NODES.assets]),
        focusId: ids.config,
        refresh: () => undefined,
      };
      start(state, setup, options);
      return state;
    },
    render(context): AreaZones {
      // Просьба перерисовать нужна асинхронному открытию проекта: оно
      // заканчивается после того, как страница уже собрана.
      context.state.refresh = () => {
        context.refresh();
      };
      return {
        navigator: navigator(context),
        surface: surface(context),
        inspector: inspector(context),
      };
    },
  };
}

/** Область без открытого проекта: проект приносит оболочка (ED-12, W4-1). */
export const sceneArea: WorkspaceArea<SceneAreaState> = createSceneArea();
