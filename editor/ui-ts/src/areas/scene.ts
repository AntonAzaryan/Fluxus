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
import type { VisualManifest } from '@game-mvp/assets';
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
import {
  children,
  documentValue,
  el,
  hotkeyText,
  issueText,
  resourceText,
  type UiNode,
  type UiText,
} from '../dom/node.js';
import type {
  AreaContext,
  AreaKey,
  AreaKeyInput,
  AreaSearch,
  AreaSetup,
  AreaZones,
  WorkspaceArea,
} from '../frame/area.js';
import { keyLabel } from '../frame/keys.js';
import type { PreviewSource } from '../frame/preview.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { inspectorPanel, issueState, type InspectorSubject } from '../inspector/index.js';
import { matchesQuery, type SearchHit } from '../palette/palette.js';
import { button } from '../widgets/button.js';
import type { IconName } from '../widgets/icon.js';
import { statusChip } from '../widgets/chip.js';
import { select, toggle } from '../widgets/field.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { placementSubject, sceneDocumentSubject } from './sceneSchema.js';
import { withValidation } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import type { SceneDecoration, ScenePlacement } from './sceneDocuments.js';
import { createAssetModule, type AssetModule } from './assetModule.js';
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
import { CAMERA_KEYS } from './sceneCamera.js';
import { prefabNames } from './scenePlacement.js';
import { decorationVisualNames } from './sceneDecorations.js';
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
  DECORATION_LIST,
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
  decorations: 'scene.decorations',
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

/**
 * Знаки инструментов (ED-31). Выбор знака делает область — она же инструмент и
 * регистрирует (ED-25): таблицы «инструмент → знак» в каркасе нет, а геометрия
 * знака лежит данными в `widgets/icon.ts`, где её и проверяют на различие форм.
 */
const TOOL_ICONS: Readonly<Record<SceneToolId, IconName>> = {
  pointer: 'cursor',
  terrain: 'paint',
  curvature: 'curve',
};

/** Клавиша, которой берётся инструмент. Часть той же раскладки, что камера. */
const TOOL_HOTKEYS: Readonly<Record<SceneToolId, string>> = {
  pointer: 'KeyV',
  terrain: 'KeyB',
  curvature: 'KeyC',
};

/**
 * Раскладка клавиш области как данные вклада (ED-32). Перечень один: по нему
 * область и разбирает нажатия, и собирает подсказки своих элементов (ED-31) —
 * второго перечня «для подсказок» не существует, поэтому смена раскладки меняет
 * и подсказку.
 */
export const SCENE_AREA_KEYS: readonly AreaKey[] = Object.freeze([
  { code: CAMERA_KEYS.panLeft, labelKey: 'ui.area.scene.keyPanLeft' },
  { code: CAMERA_KEYS.panRight, labelKey: 'ui.area.scene.keyPanRight' },
  { code: CAMERA_KEYS.panUp, labelKey: 'ui.area.scene.keyPanUp' },
  { code: CAMERA_KEYS.panDown, labelKey: 'ui.area.scene.keyPanDown' },
  { code: CAMERA_KEYS.flyToggle, labelKey: 'ui.area.scene.cameraFly' },
  { code: CAMERA_KEYS.flyLeft, labelKey: 'ui.area.scene.keyFlyLeft' },
  { code: CAMERA_KEYS.flyRight, labelKey: 'ui.area.scene.keyFlyRight' },
  { code: CAMERA_KEYS.flyForward, labelKey: 'ui.area.scene.keyFlyForward' },
  { code: CAMERA_KEYS.flyBack, labelKey: 'ui.area.scene.keyFlyBack' },
  { code: CAMERA_KEYS.flyUp, labelKey: 'ui.area.scene.keyFlyUp' },
  { code: CAMERA_KEYS.flyDown, labelKey: 'ui.area.scene.keyFlyDown' },
  ...SCENE_TOOLS.map((id) => ({ code: TOOL_HOTKEYS[id], labelKey: TOOL_LABELS[id] })),
]);

/** Клавиши, которые двигают камеру удержанием, — их набор и копит область. */
const CAMERA_HELD: ReadonlySet<string> = new Set<string>(
  Object.entries(CAMERA_KEYS)
    .filter(([role]) => role !== 'flyToggle')
    .map(([, code]) => code),
);

/** Обратная таблица «клавиша → инструмент»: раскладка одна, читается с двух сторон. */
const TOOL_BY_KEY: ReadonlyMap<string, SceneToolId> = new Map(
  SCENE_TOOLS.map((id) => [TOOL_HOTKEYS[id], id]),
);

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
  /**
   * Что зажато на клавиатуре сейчас. Спрашивает вьюпорт, отвечает область:
   * клавиши принадлежат ей, а не её холсту (ED-32), и набор живёт в записи её
   * состояния — иначе перерисовка, заменяющая узел кадра, роняла бы его.
   */
  readonly keys: () => ReadonlySet<string>;
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
  readonly assets?: AssetModule;
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
   * Зажатые клавиши раскладки области (ED-32). Живут в записи состояния, а не в
   * узле кадра: отрисовка тотальная, и набор, привязанный к холсту, сбрасывался
   * бы на каждой правке — стрелка «переставала бы работать» ровно так же, как
   * переставала от нажатия кнопки бара.
   */
  readonly held: Set<string>;
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
  /**
   * Прогнать правила заново, не дожидаясь правки документа.
   *
   * Отчёт валидации пересчитывается на событие сессии (ED-15): всё, от чего
   * зависят правила, — это документы, и правка документа и есть повод. Всё, да
   * не всё: правило-вклад вправе читать и то, чего в сессии нет вовсе, — файл
   * дерева рядом с документом. Его правка события сессии не порождает, а
   * прогон, не позванный заново, показывал бы находку о состоянии, которого
   * больше нет. Поэтому вход объявлен, а зовёт его тот, кто узнаёт о правках
   * дерева (ED-12), — сборка.
   */
  revalidate: () => void;
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
 * Клавиша области (ED-32). Порядок разбора держит каркас: сюда нажатие доходит,
 * только если сквозные сочетания его не забрали, фокус не в поле ввода и виджет
 * под фокусом его не потребил. Второго порядка — своего у этой области — здесь
 * поэтому нет, есть только раскладка (`SCENE_AREA_KEYS`) и то, что она значит.
 *
 * Указания на поверхность правки клавиши не требуют: набор зажатого живёт в
 * записи состояния, а не в холсте, и вьюпорт спрашивает его каждым кадром.
 */
function handleSceneKey(input: AreaKeyInput<SceneAreaState>): boolean {
  const state = input.state;
  if (input.phase === 'blur') {
    // Окно потеряло фокус — отпускания уже не придёт, и оставленная зажатой
    // клавиша панорамировала бы вечно.
    state.held.clear();
    return false;
  }
  if (input.phase === 'up') return state.held.delete(input.code);

  const tool = TOOL_BY_KEY.get(input.code);
  if (tool !== undefined) {
    // Недоступный инструмент нажатие всё равно забирает — по тому же
    // основанию, по которому его забирает недоступная команда палитры: отдать
    // клавишу дальше значило бы, что одна клавиша делает разное в зависимости
    // от состояния документов (ED-26).
    const off = input.mode === 'preview';
    const ready = !off && state.stage !== null && (tool === 'pointer' || state.brush.available(tool));
    if (ready && !input.repeat) activateTool(state, tool);
    return true;
  }
  if (input.code === CAMERA_KEYS.flyToggle) {
    // Фронт, а не удержание: автоповтор переключал бы облёт каждым повтором.
    // Камера работает и в превью — ED-13 разрешает панорамировать и зумить при
    // работающем прогоне, ввод камеры границы воркера не пересекает.
    if (!input.repeat) state.stage?.toggleFly();
    return true;
  }
  if (!CAMERA_HELD.has(input.code)) return false;
  state.held.add(input.code);
  return true;
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
  assets: AssetModule,
  visuals: VisualManifest,
  hooks: SceneStageHooks,
): SceneStageOptions {
  return {
    hostId: SCENE_VIEWPORT_ID,
    assets,
    visuals,
    onChange: hooks.announce,
    onPointer: hooks.pointer,
    keys: hooks.keys,
  };
}

/**
 * Вьюпорт по умолчанию: рендер движка там, где есть чем рисовать (ED-1).
 * Модуль ассетов приходит снаружи и общий на все кадры (ASSET-2); свой область
 * заводит только тогда, когда сборка общего не принесла, — как и свой реестр
 * правил.
 */
function defaultStage(
  assets: AssetModule,
  project: SceneProject,
  hooks: SceneStageHooks,
): SceneStage | null {
  // Подсистема моделей поднимается манифестом открытия (REND-8); дальше он
  // приезжает переподачей на каждую правку документа (REND-17, ED-15).
  return canRender()
    ? createSceneStage(sceneStageOptions(assets, project.initialVisuals, hooks))
    : null;
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
  assets: AssetModule | null,
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
    // Парный документ адресуется всегда: он открыт вместе со сценой, в том
    // числе пустым, и первая же поставленная декорация его наполняет (PRES-1,
    // ED-16). Файла в дереве при этом может ещё не быть — он появится
    // сохранением, а до него слой живёт документом сессии.
    presentationId: project.presentationId,
    decorationList: DECORATION_LIST,
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
    keys: () => state.held,
  });
  let config: unknown = undefined;
  let curvature: unknown = undefined;
  let presentation: unknown = undefined;
  // Начальное значение — то, которым поднята подсистема моделей: первый
  // пересчёт манифест не переподаёт, потому что переподавать ещё нечего.
  let visuals: unknown = setup.session.documentValue(project.visualsId);
  const recompute = (): void => {
    // Документ проекта может быть на миг закрыт: так — закрытием и открытием с
    // прочитанным значением — среда подхватывает правку, пришедшую в дерево
    // извне (ED-12, `app/documentRefresh.ts`). Между этими двумя событиями
    // рисовать нечем, и кадр ждёт второго: собранный по половине проекта, он
    // показал бы состояние, которого не было.
    if (!setup.session.isOpen(project.configId) || !setup.session.isOpen(project.visualsId)) {
      return;
    }
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
    // Манифест визуалов — третий редактируемый документ кадра (ED-14): запись,
    // назначенная в просмотрщике, обязана попасть в картинку не позже
    // следующего кадра (ED-15), а не ждать переоткрытия проекта.
    const nextVisuals = setup.session.documentValue(project.visualsId);
    // Парный документ — четвёртый редактируемый документ кадра (PRES-1): его
    // правка обязана попасть в картинку не позже следующего кадра (ED-15).
    const nextPresentation = !setup.session.isOpen(project.presentationId)
      ? null
      : setup.session.documentValue(project.presentationId);
    if (
      state.draft !== null &&
      nextConfig === config &&
      nextCurvature === curvature &&
      nextVisuals === visuals &&
      nextPresentation === presentation
    ) {
      return;
    }
    const edited = nextVisuals !== visuals;
    config = nextConfig;
    curvature = nextCurvature;
    visuals = nextVisuals;
    presentation = nextPresentation;
    state.draft = draftOf(setup.session, project);
    // Переподача манифеста целиком и декларативно (REND-17): что пересобрать, а
    // что обновить на живом инстансе, решает подсистема — второго такого
    // решения в редакторе нет. Сломанный манифест не переподаётся: прежний
    // лучше отсутствующего, а причина уже названа кадром (ED-8).
    if (edited && state.draft.visuals !== null) state.stage?.applyVisuals(state.draft.visuals);
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
  // Пере-прогон правил по внешнему поводу (см. `SceneAreaState.revalidate`).
  // Кэш прогона снимается целиком: он ключуется прочитанными ЗНАЧЕНИЯМИ
  // документов (ED-8), а изменилось не значение, и переиспользованная запись
  // пережила бы правку, о которой прогон и зовут.
  state.revalidate = () => {
    state.validator.invalidate();
    recompute();
    state.refresh();
  };
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

/**
 * Строка декорации в навигаторе. Подписана она ключом вида (PRES-2), а не
 * префабом: сим-стороны у декорации нет вовсе, и называть её нечем другим.
 * Находка правила стоит внутри записи (на её ссылке `visual`), а строка — на
 * самой записи, поэтому `under`, а не `at`.
 */
function decorationItem(
  context: AreaContext<SceneAreaState>,
  decoration: SceneDecoration,
): TreeItem {
  const { state, selection } = context;
  const documentId = state.project?.presentationId;
  const path =
    documentId === undefined
      ? undefined
      : context.session.resolveDescriptor(documentId, decoration.key)?.path;
  const issues =
    documentId === undefined || path === undefined
      ? []
      : (state.report?.under(documentId, path) ?? []);
  const validation = issueState(context.resources, issues);
  return {
    id: decoration.key,
    label: documentValue(decoration.visual),
    ...(validation === undefined ? {} : { validation }),
    selected: selection.has(decoration.key),
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
  const decorations = (state.draft?.decorations ?? []).map((decoration) =>
    decorationItem(context, decoration),
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
      // Группа заводится всегда — наравне с расстановкой: слой декораций
      // доступен на любой сцене, парный документ открыт вместе с ней, и пустой
      // узел «Декорации» означает пустой слой, а не отсутствие места (PRES-1).
      group(context, SCENE_NODES.decorations, 'ui.area.scene.decorations', decorations),
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

/** Чем отличается один элемент бара от другого: клавиша, состояние, доступность. */
interface BarButtonSpec {
  /** Код клавиши раскладки (ED-32); подсказка называет ту же, которая работает. */
  readonly hotkey?: string;
  /** Включённость переключателя; `undefined` — элемент не переключатель. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}

/**
 * Элемент бара, показывающий только знак (ED-31). Имя и подсказка обязательны
 * и приходят ресурсами (ED-27); горячая клавиша в подсказке берётся из той же
 * раскладки, по которой она и работает, — второго перечня клавиш нет (ED-32).
 */
function iconButton(
  context: AreaContext<SceneAreaState>,
  key: string,
  sign: IconName,
  spec: BarButtonSpec,
): UiNode {
  const { resources } = context;
  const name = resourceText(resources, key);
  const title: UiText =
    spec.hotkey === undefined ? name : hotkeyText(resources, key, keyLabel(spec.hotkey));
  return button({
    icon: sign,
    name,
    title,
    variant: 'ghost',
    ...(spec.pressed === undefined ? {} : { pressed: spec.pressed }),
    disabled: spec.disabled === true,
    onPress: spec.onPress,
  });
}

/**
 * Группа бара. Перенос по ширине (ED-22) рвёт бар между группами, а не посреди
 * пары «уровень кисти / размер кисти»: пустая группа при этом не рисуется —
 * узел-обёртка вокруг ничего оставил бы в баре зазор ни от чего.
 */
function barGroup(items: readonly UiNode[]): UiNode | undefined {
  return items.length === 0 ? undefined : el('div', { classes: ['fx-bar__group'], children: items });
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
/**
 * Есть ли что поворачивать при текущем выделении (ED-26). Ответ разный по
 * слоям: декорация поворачивается всегда, сим-объект — только если настройка
 * проекта назвала, где лежит поворот (ED-16).
 */
function canRotateSelection(state: SceneAreaState): boolean {
  const chosen = state.tool.selected();
  if (chosen.length === 0) return false;
  if (state.tool.canRotate) return true;
  const decorations = new Set((state.draft?.decorations ?? []).map((item) => item.key));
  return chosen.some((key) => decorations.has(key));
}

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

  const act = (key: string, sign: IconName, disabled: boolean, press: () => void): UiNode =>
    iconButton(context, key, sign, { disabled, onPress: press });

  // Слой постановки (ED-19): сим-объект или декорация. Переключатель, а не
  // второй инструмент — вьюпорт, выделение и подсветка у них одни и те же
  // (ED-17). Без парного документа он недоступен, а не спрятан (ED-26).
  const decorating = tool.layer === 'decoration';

  return [
    // Режим — состояние, и показан он состоянием: имя переключателя называет
    // режим и от нажатия не меняется, а включённость несёт `aria-pressed` с
    // акцентом (ED-31, ED-22). Прежняя подпись, подменявшаяся между «текущим» и
    // «результатом нажатия», по построению не сообщала, что она такое.
    iconButton(context, 'ui.area.scene.toolPlace', 'stamp', {
      pressed: placing,
      disabled: stage === null || !pointing,
      onPress: () => {
        tool.setMode(placing ? 'select' : 'place');
      },
    }),
    iconButton(context, 'ui.area.scene.layerDecoration', 'sprig', {
      pressed: decorating,
      disabled: stage === null || !pointing || !tool.canDecorate,
      onPress: () => {
        tool.setLayer(decorating ? 'sim' : 'decoration');
      },
    }),
    // Из чего ставить: префаб у сим-объекта, ключ вида у декорации. Список один
    // на два слоя не сводится — это разные множества и разные документы
    // (ED-19), — но виден в баре ровно один: тот, которым сейчас ставят.
    decorating
      ? select({
          label: resourceText(resources, 'ui.area.scene.visual'),
          value: tool.visual ?? '',
          // Ключ вида — идентификатор документа, локаль его не касается (ED-27).
          options: tool.visuals.map((name) => ({ value: name, label: documentValue(name) })),
          disabled: !placing || !pointing || tool.visuals.length === 0,
          onSelect: (value) => {
            tool.setVisual(value);
          },
        })
      : select({
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
    // Поворот доступен, если поворачивать есть что: у декорации курс лежит
    // полем записи (PRES-2) и привязки проекта не требует, у сим-объекта — без
    // привязки не выражается вовсе (ED-16, ED-26).
    act('ui.area.scene.rotateLeft', 'rotate-left', off || !canRotateSelection(state), () => {
      tool.rotate(-ROTATION_STEP);
    }),
    act('ui.area.scene.rotateRight', 'rotate-right', off || !canRotateSelection(state), () => {
      tool.rotate(ROTATION_STEP);
    }),
    // Перевод между слоями (ED-19, PRES-5): камню понадобился коллайдер —
    // объект переезжает в конфиг сцены; у prop'а убрали геймплейную роль — он
    // переезжает в парный документ. Недоступно, когда переводить нечего:
    // выделение пусто, смешано или парного документа у сцены нет (ED-26).
    act(
      tool.convertible === 'decoration'
        ? 'ui.area.scene.toProp'
        : 'ui.area.scene.toDecoration',
      'swap',
      off || tool.convertible === null || (tool.convertible === 'decoration' && tool.prefab === null),
      () => {
        tool.convert(tool.prefab);
      },
    ),
    act('ui.action.remove', 'trash', off || chosen.length === 0, () => {
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
  const { state } = context;
  const off = authoringOff(context);
  return SCENE_TOOLS.map((id) =>
    iconButton(context, TOOL_LABELS[id], TOOL_ICONS[id], {
      hotkey: TOOL_HOTKEYS[id],
      pressed: state.activeTool === id,
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

  const zoom = (steps: number, key: string, sign: IconName): UiNode =>
    iconButton(context, key, sign, {
      disabled: stage === null,
      onPress: () => {
        stage?.zoom(steps);
      },
    });

  // Камера: облёт, зум и обзорный кадр. В превью эти кнопки НЕ гаснут — ED-13
  // прямо разрешает панорамировать и зумить при работающем прогоне: ввод камеры
  // границы воркера не пересекает, и прогон от него не меняется.
  const cameraGroup = [
    // Облёт — режим конвейера камеры (CAM-2, ED-13), а не второй способ считать
    // позу; free-RTS — тот же конвейер без цели слежения (CAM-7). Имя
    // переключателя называет режим и от нажатия не меняется, включённость несёт
    // `aria-pressed` с акцентом (ED-31): по подписи, подменяемой между «Облёт» и
    // «Свободная камера», нельзя было понять, что она сообщает — текущий режим
    // или результат нажатия.
    iconButton(context, 'ui.area.scene.cameraFly', 'fly', {
      hotkey: CAMERA_KEYS.flyToggle,
      pressed: stage?.flying === true,
      disabled: stage === null,
      // Перерисовку просит сам вьюпорт, когда режим до конвейера дошёл:
      // спросить `flying` прямо здесь значило бы получить прежний ответ
      // и показывать один режим, пока камера в другом (ED-26).
      onPress: () => {
        stage?.toggleFly();
      },
    }),
    zoom(-ZOOM_STEP, 'ui.area.scene.zoomIn', 'zoom-in'),
    zoom(ZOOM_STEP, 'ui.area.scene.zoomOut', 'zoom-out'),
    // Обзорный кадр (ED-15) — то же кадрирование конвейера, что и стартовый
    // (CAM-8), а не запомненная поза: запомненная разошлась бы с ареной на
    // первой же правке её размеров. В облёте показан недоступным (ED-26):
    // кадрирование режима не меняет, и видимого ответа у него там нет.
    iconButton(context, 'ui.area.scene.overview', 'fit', {
      disabled: stage === null || !stage.canFrame || stage.flying,
      onPress: () => {
        stage?.frameArena();
      },
    }),
  ];

  return el('div', {
    classes: [FILL_CLASS, FILL_COLUMN_CLASS],
    children: children(
      el('div', {
        classes: ['fx-bar'],
        children: children(
          // Пометки режима здесь нет намеренно: он один на редактор и виден из
          // любой области (ED-26), поэтому живёт в верхнем баре каркаса. Вторая
          // пометка в области рано или поздно разошлась бы с первой.
          barGroup(cameraGroup),
          barGroup(toolBar(context)),
          barGroup(placementBar(context)),
          barGroup(brushBar(context)),
          barGroup(
            children(
              // Причина — не оттенок: иконку, положение и текст ставит один
              // вызов (ED-8, ED-22), а сам текст приходит от ядра, а не
              // сочиняется здесь.
              failure === null
                ? undefined
                : withValidation(
                    statusChip({
                      label: resourceText(resources, 'ui.area.scene.brokenDocument'),
                      tone: 'error',
                    }),
                    { severity: 'error', reason: documentValue(failure) },
                  ),
              // Несовпадение сеток — предупреждение, а не отказ (ASSET-7:
              // рантайм переживает его игнором карты), но видно оно обязано
              // быть сразу (ED-11). Важность и текст причины приходят от
              // находки: цвет тут ничего не решает, различают иконка, положение
              // и причина (ED-22).
              ...grids.map((issue) => gridChip(context, issue)),
            ),
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
    // Раскладка области — данные вклада (ED-32); её же читают подсказки (ED-31).
    keys: SCENE_AREA_KEYS,
    handleKey: handleSceneKey,
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
          // Визуальные типы — из манифеста ТЕКУЩЕГО кадра (ED-15), а не из
          // снимка открытия: запись, заведённую просмотрщиком минуту назад,
          // прогон обязан видеть так же, как её видит вьюпорт.
          kinds: () => Object.keys(state.draft?.visuals?.entities ?? {}),
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
        expanded: new Set([
          SCENE_NODES.placements,
          SCENE_NODES.decorations,
          SCENE_NODES.assets,
        ]),
        focusId: '',
        // Набор зажатого живёт столько же, сколько запись состояния: он обязан
        // пережить и перерисовку страницы, и уход в другую область (ED-23).
        held: new Set<string>(),
        reopen: () => {
          start(state, setup, options, assets);
        },
        refresh: () => undefined,
        // До открытия прогонять нечего: документов нет, и правила стоять не на
        // чем. Настоящий вход ставит открытие проекта.
        revalidate: () => undefined,
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
        // Вторая половина того же выделения (ED-17): инструмент один, а
        // документа два, и какая запись где — он обязан знать по построению.
        decorations: state.draft?.decorations ?? [],
        // Шаг привязки — размер клетки редактируемого террейна (ED-16, TERR-2).
        snapStep:
          state.draft?.grid === undefined || state.draft.grid === null
            ? 0
            : state.draft.grid.tileSize / FIXED_ONE,
        prefabs:
          state.project === null ? [] : prefabNames(context.session.documentValue(state.project.configId)),
        // Оба раздела манифеста в одном пространстве ключей (ASSET-9): камень,
        // который бывает и препятствием, и украшением, описан один раз.
        visuals: decorationVisualNames(state.draft?.visuals ?? null),
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
