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
 * не теряют ни позы, ни зума, ни раскрытых узлов. Там же живёт и прогон
 * превью (`scenePreview.ts`, ED-9): документы, которые он прогоняет, и кадр, в
 * который он публикуется, — содержимое этой же записи, а запуск и выход даёт
 * каркас, потому что доступны они из любой области (ED-26).
 *
 * Индикации режима на поверхности правки нет намеренно: режим один на редактор
 * и виден в верхнем баре каркаса; вторая пометка в области разошлась бы с
 * первой на первом же несовпадении.
 */
import { FIXED_ONE, type SceneDef } from '@game-mvp/core';
import {
  ContributionRegistry,
  CURVATURE_GRID_RULE,
  createHostAssetSource,
  createValidator,
  registerValidationRules,
  type ContributionReader,
  type EnvironmentHost,
  type ValidationIssue,
  type ValidationReport,
  type ValidationRule,
  type Validator,
} from '@game-mvp/editor-core';
import { children, documentValue, el, issueText, resourceText, type UiNode } from '../dom/node.js';
import type { AreaContext, AreaSetup, AreaZones, WorkspaceArea } from '../frame/area.js';
import type { PreviewSource } from '../frame/preview.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { select, textField, toggle } from '../widgets/field.js';
import { fieldTable, type FieldRowSpec } from '../widgets/fieldTable.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { withValidation } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import type { ScenePlacement } from './sceneDocuments.js';
import { canRender, createSceneStage, type SceneStage } from './sceneStage.js';
import {
  createPlacementTool,
  type PlacementTool,
  type StagePointer,
} from './sceneInteraction.js';
import { prefabNames } from './scenePlacement.js';
import {
  BRUSH_LEVELS,
  BRUSH_SIZES,
  TERRAIN_BRUSH_MODES,
  createBrushTool,
  type BrushSurface,
  type BrushTool,
  type TerrainBrushMode,
} from './sceneBrush.js';
import { CURVATURE_OFFSETS } from './sceneTerrain.js';
import { createScenePreview, type PreviewBackendFactory } from './scenePreview.js';
import {
  PLACEMENT_LIST,
  TERRAIN_ASSET,
  draftOf,
  openSceneProject,
  sceneValidationRules,
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

/**
 * Инструменты вьюпорта области (ED-25). Их три, и вьюпорт у них один: указатель
 * — выделение и расстановка (ED-16, ED-17), две кисти — уровни и кривизна
 * (ED-10, ED-11). Активный получает указатель целиком, а наложения области
 * складываются из наборов всех: подсветка выделения не гаснет оттого, что автор
 * взял кисть.
 */
export const SCENE_TOOLS = ['pointer', 'terrain', 'curvature'] as const;
export type SceneToolId = (typeof SCENE_TOOLS)[number];

/** Подписи инструментов и режимов кисти — ключи ресурсов (ED-27). */
const TOOL_LABELS: Readonly<Record<SceneToolId, string>> = {
  pointer: 'ui.area.scene.toolPointer',
  terrain: 'ui.area.scene.toolTerrain',
  curvature: 'ui.area.scene.toolCurvature',
};

const BRUSH_MODE_LABELS: Readonly<Record<TerrainBrushMode, string>> = {
  level: 'ui.area.scene.brushLevel',
  ramp: 'ui.area.scene.brushRamp',
  removeFloor: 'ui.area.scene.brushRemoveFloor',
  restoreFloor: 'ui.area.scene.brushRestoreFloor',
};

/** Шаг колеса на нажатие кнопки бара: тот же вход зума, что у самого колеса (CAM-4). */
const ZOOM_STEP = 1;

/**
 * Шаг поворота с бара — восьмая оборота. Доля оборота, а не радианы: угол ядра
 * измеряется оборотами (`fixed.sin`), и второй единицы редактор не вводит.
 */
const ROTATION_STEP = 1 / 8;

/**
 * Обратные каналы вьюпорта. `announce` — вьюпорт зовёт его, когда у него
 * изменилось видимое в интерфейсе (режим камеры CAM-2, причина сорвавшегося
 * кадра ED-8): спрашивать это сразу после нажатия нельзя, режим доходит до
 * конвейера вводом и применяется его ближайшим кадром. `pointer` — указатель
 * левой кнопкой: что попадание значит, решает инструмент (ED-16, ED-17), а не
 * вьюпорт.
 */
export interface SceneStageHooks {
  readonly announce: () => void;
  readonly pointer: (event: StagePointer) => void;
}

/** Чем собирается вьюпорт. */
export type SceneStageFactory = (
  project: SceneProject,
  host: EnvironmentHost,
  hooks: SceneStageHooks,
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
  /**
   * Чем поднимается вторая сторона канала превью (ED-9, SHELL-3); по умолчанию
   * — воркер веба. Подменяется тестом по той же причине, что и вьюпорт:
   * настоящего воркера в headless-прогоне нет, а проверять надо ЧТО пересекает
   * границу.
   */
  readonly previewBackend?: PreviewBackendFactory;
  /**
   * Реестр правил валидации (ED-25). Нет — область заводит свой из
   * `sceneValidationRules()`: сам список правил один и лежит там, а реестр
   * бывает общим с остальным редактором, когда его приносит сборка.
   */
  readonly validationRules?: ContributionReader<ValidationRule>;
}

/** Свой реестр правил, когда общего сборка не принесла. */
function ownRules(): ContributionReader<ValidationRule> {
  const rules = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(rules, sceneValidationRules());
  return rules;
}

export interface SceneAreaState {
  /** Открытые документы сцены; `null` — проект ещё не открыт или не открылся. */
  project: SceneProject | null;
  /** Инструмент вьюпорта: выделение, расстановка, перемещение (ED-16, ED-17). */
  readonly tool: PlacementTool;
  /** Кисти уровня, вида клетки и кривизны (ED-10, ED-11). */
  readonly brush: BrushTool;
  /** Кто из инструментов получает указатель; остальные его не видят вовсе. */
  activeTool: SceneToolId;
  /** Вьюпорт со своим конвейером камеры; `null` — в этой среде рисовать нечем. */
  stage: SceneStage | null;
  /** Текущий кадр как функция документов (ED-15). */
  draft: SceneDraft | null;
  /** Прогон правил по открытым документам (ED-8): им и находится нарушение. */
  readonly validator: Validator;
  /**
   * Последний отчёт валидации; `null` — прогонов ещё не было (проект не открыт).
   * Структурный результат, а не строка (ED-30): интерфейс показывает из него то,
   * для чего у него есть место, а внешний потребитель читает его целиком.
   */
  report: ValidationReport | null;
  /** Прогон текущих документов (ED-9): его каркас и спрашивает у области. */
  readonly preview: PreviewSource;
  /**
   * Идёт ли прогон. Флаг области, а не пересказ режима каркаса: пересчёт кадра
   * подписан на сессию и случается между отрисовками, а подавать документы в
   * чужой продюсер посреди прогона нельзя (REND-11).
   */
  previewing: boolean;
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

/**
 * Бросить начатое обоими инструментами. Незакрытая транзакция запрещает сессии
 * и следующую операцию, и undo (ED-18), поэтому её закрывает каждый путь, на
 * котором взаимодействие обрывается: потеря фокуса и снос области (`sceneStage`),
 * смена инструмента и вход в превью (ED-9).
 */
function cancelInteraction(state: SceneAreaState): void {
  state.tool.pointer({ phase: 'cancel', x: 0, y: 0, additive: false });
  state.brush.cancel();
}

/**
 * Переключение инструмента вьюпорта. Оба незакрытых взаимодействия закрываются
 * здесь, а не «не могут случиться»: смена инструмента — один из путей бросить
 * начатое, и оставленная открытой транзакция переживает его дефектом.
 */
function activateTool(state: SceneAreaState, next: SceneToolId): void {
  if (state.activeTool === next) return;
  cancelInteraction(state);
  state.activeTool = next;
  if (next !== 'pointer') state.brush.setLayer(next);
  state.refresh();
}

/**
 * Закрыт ли авторинг сейчас. Закрыт он ровно в превью: «в превью операции
 * авторинга недоступны» (ED-9), и элемент, который нельзя применить, показан
 * недоступным, а не молча не срабатывает (ED-26). Режим приходит от каркаса —
 * он же виден автору постоянно, и второго ответа на вопрос «правка или прогон»
 * в области не заводится.
 */
function authoringOff(context: AreaContext<SceneAreaState>): boolean {
  return context.mode === 'preview';
}

/** Слой кисти как вход инструмента: где лежит ассет и какого размера его сетка. */
function brushSurface(
  document: string,
  path: readonly (string | number)[],
  grid: { readonly width: number; readonly height: number } | null | undefined,
): BrushSurface | null {
  return grid === null || grid === undefined ? null : { target: { document, path }, grid };
}

/** Вьюпорт по умолчанию: рендер движка там, где есть чем рисовать (ED-1). */
function defaultStage(
  project: SceneProject,
  host: EnvironmentHost,
  hooks: SceneStageHooks,
): SceneStage | null {
  if (!canRender()) return null;
  return createSceneStage({
    hostId: SCENE_VIEWPORT_ID,
    // Тот же шов к дереву, через который читаются документы (ASSET-2, ED-12).
    assets: createHostAssetSource(host.content),
    visuals: project.visuals,
    onChange: hooks.announce,
    onPointer: hooks.pointer,
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
      state.stage = build(project, host, {
        announce: () => {
          state.refresh();
        },
        // Инструменты живут в записи состояния области и переживают уход в
        // другую область (ED-23) — вместе с выделением, которое ставит один из
        // них. Указатель получает ровно активный: что попадание значит, знает
        // инструмент, а какой из них сейчас в руках — область (ED-25).
        pointer: (event) => {
          // В превью указатель до инструментов не доходит вовсе (ED-9): панель
          // показывает их недоступными, и клик по кадру обязан значить то же,
          // что показывает панель, — иначе «недоступно» было бы только надписью.
          if (state.previewing) return;
          if (state.activeTool === 'pointer') state.tool.pointer(event);
          else state.brush.pointer(event);
        },
      });
      let config: unknown = undefined;
      let curvature: unknown = undefined;
      const recompute = (): void => {
        // Отчёт пересчитывается раньше сверки ссылок и без неё: правила видят
        // больше документов, чем кадр (пара «конфиг — манифест», ED-19), и
        // «кадр не изменился» их состояния не описывает. Дорогим это не
        // становится — прогон сам решает, какие правила исполнять заново (ED-8).
        state.report = state.validator.run(setup.session);
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
        // Пока идёт прогон, кадр наполняет он (REND-11): подать сюда документы
        // значило бы отобрать у него presentation-состояние посреди прогона.
        // Дождавшийся набор уедет во вьюпорт выходом из превью — переподачей.
        if (!state.previewing) state.stage?.submit(state.draft);
        state.refresh();
      };
      // Подписка ловит правку, пришедшую откуда угодно, в том числе без
      // интерфейса (ED-29), и правку внутри ещё не закрытого взаимодействия:
      // о применении внутри открытой транзакции сессия объявляет событием
      // наравне с записанным в историю, поэтому объект едет во вьюпорте по ходу
      // перетаскивания, а не в момент отпускания (ED-15).
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

/**
 * Панель инструмента расстановки (ED-16, ED-17). Всё, что она делает, — зовёт
 * инструмент: сама она в документы не пишет, потому что писать в них можно
 * только операцией (ED-29).
 *
 * Недоступное показано недоступным, а не молча не срабатывает (ED-26): без
 * выделения нечего поворачивать и удалять, без привязки поворота в настройке
 * проекта поворот не выражается вовсе (ED-16), а без кадра не во что и попадать.
 * В превью недоступно всё: операции авторинга там запрещены (ED-9).
 */
function placementBar(context: AreaContext<SceneAreaState>): readonly UiNode[] {
  const { state, resources } = context;
  const tool = state.tool;
  const stage = state.stage;
  const chosen = tool.selected();
  // Список — тот же, что подан инструменту отрисовкой: второго перечня, который
  // разошёлся бы с выбранным, не заводится.
  const prefabs = tool.prefabs;
  const placing = tool.mode === 'place';
  // Настройки указателя недоступны, пока указатель не в руках (ED-26): кисть
  // получает нажатия целиком, и «расстановка» при ней ничего бы не делала.
  const off = authoringOff(context);
  const pointing = state.activeTool === 'pointer' && !off;

  const act = (key: string, disabled: boolean, press: () => void): UiNode =>
    button({
      label: resourceText(resources, key),
      variant: 'ghost',
      disabled,
      onPress: press,
    });

  return [
    // Режим — состояние инструмента, и подпись показывает текущий, а не тот, в
    // который нажатие переведёт: иначе автор читает кнопку как индикатор.
    act(
      placing ? 'ui.area.scene.toolPlace' : 'ui.area.scene.toolSelect',
      stage === null || !pointing,
      () => {
        tool.setMode(placing ? 'select' : 'place');
      },
    ),
    select({
      label: resourceText(resources, 'ui.area.scene.prefab'),
      value: tool.prefab ?? '',
      // Имя префаба — идентификатор документа, и локаль его не касается (ED-27).
      options: prefabs.map((name) => ({ value: name, label: documentValue(name) })),
      disabled: !placing || !pointing || prefabs.length === 0,
      onSelect: (value) => {
        tool.setPrefab(value);
      },
    }),
    toggle({
      label: resourceText(resources, 'ui.area.scene.snap'),
      on: tool.snapping,
      disabled: stage === null || !pointing,
      onChange: (on) => {
        tool.setSnapping(on);
      },
    }),
    act('ui.area.scene.rotateLeft', off || !tool.canRotate || chosen.length === 0, () => {
      tool.rotate(-ROTATION_STEP);
    }),
    act('ui.area.scene.rotateRight', off || !tool.canRotate || chosen.length === 0, () => {
      tool.rotate(ROTATION_STEP);
    }),
    act('ui.action.remove', off || chosen.length === 0, () => {
      tool.remove();
    }),
  ];
}

/**
 * Выбор инструмента вьюпорта (ED-25): инструменты области делят один кадр, и
 * какой из них получает указатель, автор видит и меняет здесь. Активный помечен
 * акцентом — тем самым «включённым переключателем», за которым ED-22 акцент и
 * закрепил; кисть без карты видимо недоступна, а не молча не срабатывает
 * (ED-26).
 */
function toolBar(context: AreaContext<SceneAreaState>): readonly UiNode[] {
  const { state, resources } = context;
  const off = authoringOff(context);
  return SCENE_TOOLS.map((id) =>
    button({
      label: resourceText(resources, TOOL_LABELS[id]),
      variant: state.activeTool === id ? 'primary' : 'ghost',
      disabled: off || state.stage === null || (id !== 'pointer' && !state.brush.available(id)),
      onPress: () => {
        activateTool(state, id);
      },
    }),
  );
}

/**
 * Настройки кисти (ED-10, ED-11). Появляются только вместе с самой кистью:
 * уровень и смещение — величины, которые кисть кладёт в клетку, и держать их на
 * виду постоянно значило бы показывать автору числа там, где ED-11 требует
 * показывать рельеф.
 *
 * Величины — значения документа, а не подписи интерфейса: уровень уезжает в
 * карту как есть, и локаль его не касается (ED-27).
 *
 * В превью настройки остаются на виду и показаны недоступными: ED-26 требует
 * именно этого — «автор смотрит на панель инструментов при работающем превью, и
 * инструменты показаны недоступными», а не исчезнувшими.
 */
function brushBar(context: AreaContext<SceneAreaState>): readonly UiNode[] {
  const { state, resources } = context;
  const brush = state.brush;
  if (state.activeTool === 'pointer' || !brush.available()) return [];
  const off = authoringOff(context);

  const numbers = (
    key: string,
    value: number,
    values: readonly number[],
    pick: (next: number) => void,
  ): UiNode =>
    select({
      label: resourceText(resources, key),
      value: String(value),
      options: values.map((entry) => ({ value: String(entry), label: documentValue(String(entry)) })),
      disabled: off,
      onSelect: (raw) => {
        pick(Number(raw));
      },
    });

  const painting = brush.layer === 'terrain';
  return children(
    painting
      ? select({
          label: resourceText(resources, 'ui.area.scene.brushMode'),
          value: brush.mode,
          options: TERRAIN_BRUSH_MODES.map((mode) => ({
            value: mode,
            label: resourceText(resources, BRUSH_MODE_LABELS[mode]),
          })),
          disabled: off,
          onSelect: (raw) => {
            const next = TERRAIN_BRUSH_MODES.find((mode) => mode === raw);
            if (next !== undefined) brush.setMode(next);
          },
        })
      : undefined,
    painting && brush.mode !== 'level'
      ? undefined
      : painting
        ? numbers('ui.area.scene.brushLevel', brush.level, BRUSH_LEVELS, (next) => {
            brush.setLevel(next);
          })
        : numbers('ui.area.scene.brushOffset', brush.offset, CURVATURE_OFFSETS, (next) => {
            brush.setOffset(next);
          }),
    numbers('ui.area.scene.brushSize', brush.size, BRUSH_SIZES, (next) => {
      brush.setSize(next);
    }),
    toggle({
      label: resourceText(resources, 'ui.area.scene.grid'),
      on: brush.showGrid,
      disabled: off,
      onChange: (on) => {
        brush.setShowGrid(on);
      },
    }),
  );
}

/**
 * Находка правила сеток (ED-11) в баре поверхности правки. Подпись — ресурс
 * области, причина — ресурс самой находки с подставленными величинами
 * (`issueText`): текст нарушения принадлежит правилу, а не месту показа, и
 * второй его формулировки в области не заводится (ED-27, ED-30).
 */
function gridChip(context: AreaContext<SceneAreaState>, issue: ValidationIssue): UiNode {
  const { resources } = context;
  return withValidation(
    statusChip({
      label: resourceText(resources, 'ui.area.scene.curvatureGrid'),
      tone: issue.severity,
    }),
    { severity: issue.severity, reason: issueText(resources, issue) },
  );
}

function surface(context: AreaContext<SceneAreaState>): UiNode {
  const { state, resources } = context;
  const stage = state.stage;
  // Три источника одной причины, а не три способа её показать: не открылся
  // проект, не сошлись документы, не прошёл кадр (ED-8, ED-30).
  const failure = state.failure ?? state.draft?.failure ?? stage?.failure ?? null;
  // Несовпадение сеток кривизны и террейна — находка правила `editor.curvatureGrid`
  // (ED-11), а не второе сравнение двух чисел здесь. Из отчёта берётся только
  // оно: остальным находкам места в интерфейсе пока нет, и показывать их
  // единственным чипом бара значило бы свалить в него весь отчёт.
  const grids = (state.report?.issues ?? []).filter(
    (issue) => issue.ruleId === CURVATURE_GRID_RULE,
  );

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
          // Пометки режима здесь нет намеренно: он один на редактор и виден из
          // любой области (ED-26), поэтому живёт в верхнем баре каркаса. Вторая
          // пометка в области рано или поздно разошлась бы с первой.
          //
          // Кнопки камеры в превью НЕ гаснут: ED-13 прямо разрешает панорамировать
          // и зумить при работающем прогоне — ввод камеры границы воркера не
          // пересекает, и прогон от него не меняется.
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
          ...toolBar(context),
          ...placementBar(context),
          ...brushBar(context),
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
          // Несовпадение сеток — предупреждение, а не отказ (ASSET-7: рантайм
          // переживает его игнором карты), но видно оно обязано быть сразу
          // (ED-11). Важность и текст причины приходят от находки: цвет тут
          // ничего не решает, различают иконка, положение и причина (ED-22).
          ...grids.map((issue) => gridChip(context, issue)),
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
          // Позиция, поворот и уровень — производные worldInit: их выводит ядро
          // (TERR-4), а правит их вьюпорт — постановкой, перетаскиванием и
          // поворотом выделенного (ED-16), то есть операцией, а не этим полем.
          ...(
            [
              ['ui.area.scene.field.x', placement.x.toFixed(3)],
              ['ui.area.scene.field.y', placement.y.toFixed(3)],
              // Поворот показан в единице ядра — доле оборота: делить радианы
              // рендера обратно значило бы показывать величину, которой в
              // документе нет (FP-1).
              ...(placement.yaw === undefined
                ? []
                : ([['ui.area.scene.field.turns', placement.turns.toFixed(3)]] as const)),
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
    preview: (state) => state.preview,
    createState(setup): SceneAreaState {
      const ids = options.ids ?? DEFAULT_SCENE_IDS;
      const state: SceneAreaState = {
        project: null,
        stage: null,
        draft: null,
        // Правила — вклад (ED-25), и прогон живёт столько же, сколько запись
        // состояния: его кэш опирается на значения открытых документов сессии.
        validator: createValidator({ rules: options.validationRules ?? ownRules() }),
        report: null,
        previewing: false,
        failure: null,
        activeTool: 'pointer',
        // Прогон заводится вместе с записью и живёт столько же: документы,
        // кадр и незакрытые взаимодействия — всё это её содержимое (ED-9).
        preview: createScenePreview({
          // Значение открытого документа и есть текущее состояние сцены —
          // вместе с несохранёнными правками (ED-9, ED-26).
          // Приведение без проверки здесь намеренно: разбирать конфиг умеет
          // ядро, и оно же отвергает негодный на загрузке (SER-7). Вторая
          // проверка в редакторе была бы второй реализацией правила (ED-1), а
          // причина отказа доедет до автора тем же путём, что у сломанного
          // документа, — исключением запуска (ED-8).
          scene: () =>
            state.project === null
              ? null
              : (setup.session.documentValue(state.project.configId) as unknown as SceneDef),
          kinds: () =>
            state.project === null ? [] : Object.keys(state.project.visuals.entities),
          stage: () => state.stage,
          enter: () => {
            state.previewing = true;
            cancelInteraction(state);
          },
          leave: () => {
            state.previewing = false;
            // Переподача, а не обычная подача: документы за прогон не менялись,
            // и по совпадению значений не доехало бы ничего — включая пол,
            // выбитый тиками прогона (REND-14).
            if (state.draft !== null) state.stage?.submit(state.draft, true);
            state.refresh();
          },
          ...(options.previewBackend === undefined ? {} : { backend: options.previewBackend }),
        }),
        expanded: new Set([ids.config, SCENE_NODES.placements, SCENE_NODES.assets]),
        focusId: ids.config,
        refresh: () => undefined,
        // Инструмент заводится вместе с записью состояния и живёт столько же
        // (ED-23): указатель приходит в него из вьюпорта, а не из отрисовки.
        tool: createPlacementTool({
          session: setup.session,
          documentId: ids.config,
          list: PLACEMENT_LIST,
          ...(ids.position === undefined ? {} : { binding: ids.position }),
          refresh: () => {
            state.refresh();
          },
        }),
        // Кисти правят документы теми же операциями и той же сессией, что и
        // расстановка (ED-29): второго пути правки в области нет.
        brush: createBrushTool({
          session: setup.session,
          refresh: () => {
            state.refresh();
          },
        }),
      };
      start(state, setup, options);
      return state;
    },
    render(context): AreaZones {
      const { state } = context;
      // Просьба перерисовать нужна асинхронному открытию проекта: оно
      // заканчивается после того, как страница уже собрана.
      state.refresh = () => {
        context.refresh();
      };
      // Инструмент видит выделение сессии (ED-23), кадр и текущий набор — то
      // есть ровно то, что показывает эта же сборка страницы. Подаётся здесь, а
      // не при заведении записи: выделение сквозное и приходит на отрисовку.
      state.tool.attach({
        selection: context.selection,
        picker: state.stage,
        placements: state.draft?.placements ?? [],
        // Шаг привязки — размер клетки редактируемого террейна (ED-16, TERR-2).
        snapStep:
          state.draft?.grid === undefined || state.draft.grid === null
            ? 0
            : state.draft.grid.tileSize / FIXED_ONE,
        prefabs:
          state.project === null ? [] : prefabNames(context.session.documentValue(state.project.configId)),
      });
      // Кисть видит тот же кадр и те же документы: сетка — уже производная,
      // выведенная ядром (TERR-5, REND-14), а не пересчитанная областью.
      const project = state.project;
      state.brush.attach({
        picker: state.stage,
        terrain:
          project === null
            ? null
            : brushSurface(project.configId, TERRAIN_ASSET, state.draft?.grid),
        curvature:
          project === null || project.curvatureId === null
            ? null
            : brushSurface(project.curvatureId, [], state.draft?.curvature),
      });
      // Набор наложений — функция состояния, а не история вызовов (REND-16): он
      // отдаётся ЦЕЛИКОМ на каждую сборку, а сводит его подсистема.
      //
      // Складывает его область, а не инструменты: `setOverlays` принимает полный
      // набор, и инструмент, зовущий его сам, погасил бы наложения соседа. Свои
      // наложения инструмент только называет — отсюда и `overlays()` без
      // побочных действий. Кисть — слагаемое, а не второй вызов; её набор
      // входит в сумму, только пока она в руках (ED-9: в чужом режиме кисть
      // ничего не показывает).
      //
      // В превью набор пуст: наложения — служебная разметка авторинга поверх
      // документов (подсветка выделенного, клетки под кистью), а в кадре прогона
      // документных инстансов нет вовсе (REND-11).
      state.stage?.setOverlays(
        authoringOff(context)
          ? []
          : [
              ...state.tool.overlays(),
              ...(state.activeTool === 'pointer' ? [] : state.brush.overlays()),
            ],
      );
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
