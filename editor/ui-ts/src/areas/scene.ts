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
 * - **инспектор** — поля выбранного по его схеме (ED-24): набор строк приносит
 *   `sceneSchema.ts`, читая реестры схем ядра, а правит их общий инспектор
 *   каркаса зарегистрированной операцией (ED-29). Списка полей в этой области
 *   нет — поле, дописанное в схему компонента, появляется само (ED-2, ED-6).
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
import type { AssetService, VisualManifest } from '@game-mvp/assets';
import {
  ContributionRegistry,
  CURVATURE_GRID_RULE,
  createValidator,
  registerValidationRules,
  type ContributionReader,
  type EnvironmentHost,
  type JsonPath,
  type ValidationIssue,
  type ValidationReport,
  type ValidationRule,
  type Validator,
} from '@game-mvp/editor-core';
import { children, documentValue, el, issueText, resourceText, type UiNode } from '../dom/node.js';
import type {
  AreaContext,
  AreaSearch,
  AreaSetup,
  AreaZones,
  WorkspaceArea,
} from '../frame/area.js';
import type { PreviewSource } from '../frame/preview.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { inspectorPanel, issueState, type InspectorSubject } from '../inspector/index.js';
import { matchesQuery, type SearchHit } from '../palette/palette.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { select, toggle } from '../widgets/field.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { placementSubject, sceneDocumentSubject } from './sceneSchema.js';
import { withValidation } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import type { ScenePlacement } from './sceneDocuments.js';
import { createAssetModule } from './assetModule.js';
import {
  canRender,
  createSceneStage,
  type SceneStage,
  type SceneStageOptions,
} from './sceneStage.js';
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

/**
 * Проект, которого нет. Запись состояния заводится раньше, чем открытие
 * закончится (а иногда открывать нечего вовсе), и инструментам нужен адрес уже
 * тогда. Пустой адрес и есть честный ответ: писать в него нечем, а видимого
 * пути к записи нет — без кадра вся панель расстановки показана недоступной
 * (ED-26). Настоящий адрес инструмент получает вместе с открытым проектом.
 */
const NO_PROJECT: SceneProjectIds = { config: '', visuals: '' };

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
  /** Документы известного проекта. Нет ни их, ни `open` — открывать нечего. */
  readonly ids?: SceneProjectIds;
  /**
   * Чем проект ОТКРЫВАЕТСЯ, когда его состав заранее не известен (ED-12):
   * корень спрашивается у среды, документы ищутся в дереве
   * (`sceneDiscovery.ts`). `null` — открывать нечего; отказ — причина, которую
   * область покажет (ED-8). Зовётся и повторно: тем же путём идёт команда
   * открытия проекта из палитры (ED-24).
   */
  readonly open?: () => Promise<SceneProjectIds | null>;
  /**
   * Модуль ассетов редактора (ASSET-2) — один на все кадры; нет — область
   * заводит свой. Обоснование общего кэша — в шапке `assetModule.ts`.
   */
  readonly assets?: AssetService;
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
  /**
   * Инструмент вьюпорта: выделение, расстановка, перемещение (ED-16, ED-17).
   * Пересоздаётся вместе с открытым проектом: адрес документа, в который он
   * пишет операциями (ED-29), — свойство проекта, а не области.
   */
  tool: PlacementTool;
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
  /**
   * Открыть проект заново (ED-12): спросить у среды корень и найти в дереве
   * документы. Тем же вызовом это делает команда палитры (ED-24) — второго пути
   * открытия не заводится.
   */
  reopen: () => void;
  /** Отписка от правок открытого проекта; `undefined` — проект не открыт. */
  unwatch?: () => void;
  /** Просьба перерисовать после асинхронного открытия; ставится отрисовкой. */
  refresh: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Бросить начатое обоими инструментами. Незакрытая транзакция запрещает сессии
 * и следующую операцию, и undo (ED-18), поэтому её закрывает каждый путь, на
 * котором взаимодействие обрывается: потеря фокуса и снос области
 * (`sceneStage`), смена инструмента и вход в превью (ED-9).
 *
 * На пути превью транзакцию сессии закрывает уже приостановка авторинга, и
 * здесь остаётся своё состояние инструментов — признак перетаскивания и начатый
 * мазок: сессия о них не знает, а оставленные включёнными они пережили бы
 * прогон и продолжили бы его следующим нажатием.
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

/**
 * Чем собирается вьюпорт сцены. Отдельно от самой сборки — по той же причине,
 * по которой отдельно объявлены настройки кадра просмотрщика
 * (`assetStageOptions`): без WebGL проверяемо ровно это — что оба кадра берут
 * ОДИН модуль ассетов (ASSET-2) и встают в РАЗНЫЕ узлы страницы, то есть держат
 * каждый свой контекст рендера (обоснование — в шапке `assetModule.ts`).
 */
export function sceneStageOptions(
  assets: AssetService,
  visuals: VisualManifest,
  hooks: SceneStageHooks,
): SceneStageOptions {
  return {
    hostId: SCENE_VIEWPORT_ID,
    assets,
    visuals,
    onChange: hooks.announce,
    onPointer: hooks.pointer,
  };
}

/**
 * Вьюпорт по умолчанию: рендер движка там, где есть чем рисовать (ED-1).
 * Модуль ассетов приходит снаружи и общий на все кадры (ASSET-2); свой область
 * заводит только тогда, когда сборка общего не принесла, — как и свой реестр
 * правил.
 */
function defaultStage(
  assets: AssetService,
  project: SceneProject,
  hooks: SceneStageHooks,
): SceneStage | null {
  return canRender() ? createSceneStage(sceneStageOptions(assets, project.visuals, hooks)) : null;
}

/**
 * Чем открывается проект. Известный состав и поиск в дереве — один и тот же
 * шаг для области: она получает документы и не знает, откуда их взяли.
 */
function opener(options: SceneAreaOptions): (() => Promise<SceneProjectIds | null>) | null {
  if (options.open !== undefined) return options.open;
  const ids = options.ids;
  return ids === undefined ? null : () => Promise.resolve(ids);
}

/**
 * Открытие проекта и слежение за документами. Пересчёт кадра подписан на
 * сессию, а не на отрисовку страницы: ED-15 обещает отклик на правку, а не на
 * то, что кто-то перерисовал интерфейс.
 *
 * Зовётся и повторно — командой открытия проекта (ED-24). Повтор на тех же
 * документах не пересобирает ничего: пересборка вьюпорта потеряла бы позу
 * камеры, которую ED-23 обязывает пережить даже переключение области, а
 * «открыть то же самое» состоянием области не является.
 */
function start(
  state: SceneAreaState,
  setup: AreaSetup,
  options: SceneAreaOptions,
  assets: AssetService | null,
): void {
  const host = options.host;
  const open = opener(options);
  if (host === undefined || open === null) return;
  const build =
    options.stage ??
    ((project: SceneProject, _host: EnvironmentHost, hooks: SceneStageHooks) =>
      assets === null ? null : defaultStage(assets, project, hooks));

  open()
    .then(async (ids) => {
      if (ids === null) {
        // Открывать нечего — это ответ, а не отказ: навигатор скажет, что
        // проект не открыт, и причины у этого нет.
        state.failure = null;
        return;
      }
      const current = state.project;
      if (current !== null && current.configId === ids.config && current.visualsId === ids.visuals) {
        state.failure = null;
        return;
      }
      const project = await openSceneProject(setup.session, host.content, ids);
      install(state, setup, project, ids, build, host);
    })
    .catch((error: unknown) => {
      state.failure = message(error);
      state.refresh();
    });
}

/** Открытый проект на месте: вьюпорт, инструменты, подписка на правки. */
function install(
  state: SceneAreaState,
  setup: AreaSetup,
  project: SceneProject,
  ids: SceneProjectIds,
  build: SceneStageFactory,
  host: EnvironmentHost,
): void {
  state.failure = null;
  state.project = project;
  // Инструмент адресует документ открытого проекта (ED-29), поэтому он и
  // заводится вместе с ним. Выделение при этом не теряется: оно сквозное и
  // живёт моделью каркаса (ED-23), а не инструментом.
  state.tool = createPlacementTool({
    session: setup.session,
    documentId: project.configId,
    list: PLACEMENT_LIST,
    ...(ids.position === undefined ? {} : { binding: ids.position }),
    refresh: () => {
      state.refresh();
    },
  });
  state.expanded.add(project.configId);
  state.expanded.add(SCENE_NODES.placements);
  state.expanded.add(SCENE_NODES.assets);
  if (state.focusId === '') state.focusId = project.configId;
  // Прежний вьюпорт сносится: открытие ДРУГОГО проекта — единственный путь
  // сюда во второй раз, и оставленный кадр рисовал бы прежние документы в тот
  // же узел страницы.
  state.stage?.dispose();
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
  //
  // Подписка прежнего проекта снимается: она держит его документы и его кадр,
  // и оставленная жить пересчитывала бы уже не открытое.
  state.unwatch?.();
  state.unwatch = setup.session.subscribe(recompute);
  recompute();
}

// ------------------------------------------------------------------ зоны

/**
 * Путь записи расстановки в документе на текущий момент: дескриптор переживает
 * правку соседей, а путь — нет, поэтому он и спрашивается у сессии на каждую
 * сборку строки (ED-29).
 */
function placementPath(
  context: AreaContext<SceneAreaState>,
  configId: string,
  key: string,
): JsonPath | undefined {
  return context.session.resolveDescriptor(configId, key)?.path;
}

function placementItem(context: AreaContext<SceneAreaState>, placement: ScenePlacement): TreeItem {
  const { state, selection } = context;
  const configId = state.project?.configId;
  const path = configId === undefined ? undefined : placementPath(context, configId, placement.key);
  // Находка правила стоит на месте внутри записи (например, на её ссылке на
  // prefab), а строка навигатора — на самой записи: поэтому `under`, а не `at`.
  // Оба индекса отчёта заведены ровно для этих двух вопросов (ED-8, ED-30).
  const issues =
    configId === undefined || path === undefined
      ? []
      : (state.report?.under(configId, path) ?? []);
  const validation = issueState(context.resources, issues);
  return {
    id: placement.key,
    label: documentValue(placement.prefab),
    ...(placement.kind === null ? {} : { badge: documentValue(placement.kind) }),
    ...(validation === undefined ? {} : { validation }),
    selected: selection.has(placement.key),
    onSelect: (id) => {
      state.focusId = id;
      selection.set([id]);
    },
  };
}

function documentItem(context: AreaContext<SceneAreaState>, id: string): TreeItem {
  const { state, selection } = context;
  const validation = issueState(context.resources, state.report?.forDocument(id) ?? []);
  return {
    id,
    label: documentValue(id),
    ...(validation === undefined ? {} : { validation }),
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

  const rootValidation = issueState(resources, state.report?.forDocument(project.configId) ?? []);
  const root: TreeItem = {
    id: project.configId,
    label: documentValue(project.configId),
    expanded: state.expanded.has(project.configId),
    selected: context.selection.has(project.configId),
    ...(rootValidation === undefined ? {} : { validation: rootValidation }),
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

/**
 * Что показывает инспектор при текущем выделении. Схему приносит `sceneSchema.ts`
 * — реестр схем ядра, а не список в этом файле (ED-24). Выбранному, у которого
 * схемы нет (карта кривизны, манифест), инспектор показывает пустоту, а не
 * выдуманные строки: их формат нормируют другие capability.
 */
function subjectOf(context: AreaContext<SceneAreaState>): InspectorSubject | null {
  const { state, session } = context;
  const project = state.project;
  const selected = context.selection.current()[0];
  if (project === null || selected === undefined) return null;

  const placement = (state.draft?.placements ?? []).find((item) => item.key === selected);
  if (placement !== undefined) {
    return placementSubject({
      session,
      documentId: project.configId,
      record: placement.key,
      prefab: placement.prefab,
      prefabs: prefabNames(session.documentValue(project.configId)),
    });
  }
  return selected === project.configId ? sceneDocumentSubject(project.configId) : null;
}

function inspector(context: AreaContext<SceneAreaState>): UiNode {
  const { state } = context;
  return inspectorPanel({
    resources: context.resources,
    session: context.session,
    // Реестр редакторов поля — от каркаса: вклад, зарегистрированный один раз,
    // подхватывается инспектором всех областей сразу (ED-25).
    fieldEditors: context.fieldEditors,
    subject: subjectOf(context),
    // Структурный отчёт (ED-30): по нему поле и находит свою находку.
    report: state.report,
    // В превью операции авторинга недоступны, и поля показаны недоступными, а
    // не молча не принимающими ввод (ED-9, ED-26).
    disabled: authoringOff(context),
    onFailure: (reason) => {
      state.failure = reason;
      context.refresh();
    },
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
    /**
     * Поиск по проекту (ED-24): документы сцены по их пути в дереве контента и
     * записи расстановки по имени prefab'а. «Открыть напрямую» здесь — выделить
     * найденное и раскрыть узлы над ним: то же состояние, в котором автор
     * оказался бы, пройдя дерево, только без прохода.
     */
    search(input: AreaSearch<SceneAreaState>): readonly SearchHit[] {
      const { query, state, selection } = input;
      const project = state.project;
      if (project === null) return [];
      const found: SearchHit[] = [];
      const reveal = (id: string, ...open: readonly string[]): (() => void) => {
        return () => {
          for (const node of open) state.expanded.add(node);
          state.focusId = id;
          selection.set([id]);
        };
      };
      const documents = [
        project.configId,
        project.visualsId,
        ...(project.curvatureId === null ? [] : [project.curvatureId]),
      ];
      for (const id of documents) {
        if (!matchesQuery(query, id)) continue;
        found.push({
          id,
          label: documentValue(id),
          icon: 'layers',
          reveal: reveal(id, project.configId, SCENE_NODES.assets),
        });
      }
      for (const placement of state.draft?.placements ?? []) {
        if (!matchesQuery(query, placement.prefab)) continue;
        found.push({
          id: placement.key,
          label: documentValue(placement.prefab),
          detail: documentValue(project.configId),
          reveal: reveal(placement.key, project.configId, SCENE_NODES.placements),
        });
      }
      return found;
    },
    createState(setup): SceneAreaState {
      // Модуль ассетов заводится один раз на запись состояния, а не на каждое
      // открытие: повторное открытие завело бы второй кэш на те же ID
      // (ASSET-2) — ровно то, чего общий модуль и не допускает.
      const assets =
        options.assets ?? (options.host === undefined ? null : createAssetModule(options.host));
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
        expanded: new Set([SCENE_NODES.placements, SCENE_NODES.assets]),
        focusId: '',
        reopen: () => {
          start(state, setup, options, assets);
        },
        refresh: () => undefined,
        // Инструмент заводится вместе с записью состояния и живёт столько же
        // (ED-23): указатель приходит в него из вьюпорта, а не из отрисовки.
        // До открытия он адресован в пустоту — писать в него нечем и неоткуда
        // (см. `NO_PROJECT`), а открытый проект приносит настоящий адрес.
        tool: createPlacementTool({
          session: setup.session,
          documentId: NO_PROJECT.config,
          list: PLACEMENT_LIST,
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
      start(state, setup, options, assets);
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
