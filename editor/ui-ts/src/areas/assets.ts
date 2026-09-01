/* eslint-disable max-lines -- рабочая область — один вклад (ED-25). Дерево,
   просмотрщик, модуль ассетов, записи манифеста и эффекты камеры уже вынесены
   в assetTree/assetPreview/assetModule/assetVisuals/assetCameraEffects;
   остаток — три зоны области над одной записью состояния (ED-24). */
/**
 * @contribution Рабочая область просмотрщика presentation-ассетов (ED-20) —
 * вклад, а не часть каркаса.
 *
 * Доменные имена («манифест», «текстура», «скин») здесь есть и должны быть:
 * сканер `test/frameDomain.test.ts` пропускает файл по пометке `@contribution`,
 * и ровно в этом смысл ED-25 — доменное знание живёт во вкладе. Каркас об этой
 * области знает столько же, сколько об остальных: её id, её знак в рельсе и три
 * узла, которые она кладёт в зоны скелета (ED-24).
 *
 * Скелет тот же, что у всех (ED-24), а содержимое зон своё:
 *
 * - **навигатор** — дерево контента (`assetTree.ts`): не выдуманное, а то, что
 *   отдаёт хост среды (ED-12). Ассет, не прошедший загрузку, стоит в нём строкой
 *   с иконкой и причиной (ED-20, ASSET-4) — рядом с остальными, которые
 *   продолжают открываться;
 * - **поверхность** — кадр превью (ED-1: «превью моделей — тем же рендером, что
 *   вьюпорт») и полоса выбора: запись манифеста, анимация, скин, слот текстуры и
 *   три назначения ED-20;
 * - **инспектор** — что за ассет выбран, в каком он состоянии и что сейчас
 *   стоит в записи манифеста.
 *
 * ## Почему кадр здесь тот же самый
 *
 * `createSceneStage` собирает рендер один раз на весь редактор (ED-1), и
 * просмотрщик берёт его же с одной опцией `terrain: false`: набор из одного
 * инстанса без сцены и террейна — это ВЫРОЖДЕННЫЙ СЛУЧАЙ документного источника
 * (REND-11), а не третий продюсер и не вторая сборка. Что именно подаётся в
 * набор и в манифест, считает `assetPreview.ts`; здесь только выбор автора.
 *
 * ## Почему выбор пишется операцией
 *
 * ED-20 требует, чтобы модель, текстура и скин выбирались из просмотрщика и
 * ручной ввод пути не был обязательным; ED-29 — чтобы всякая правка документа
 * шла зарегистрированной операцией. Поэтому кнопки назначения зовут реестр
 * (`assetVisuals.ts`) и ничего не пишут сами: undo этих правок работает по тем
 * же основаниям, что undo мазка кисти (ED-18), — история одна на сессию.
 *
 * ## Что здесь не снимок
 *
 * Две вещи области выглядят состоянием, а на деле являются ответом на вопрос,
 * у которого ответ меняется, и снятые однажды они устаревают молча:
 *
 * - **манифест открытого проекта.** Он приходит открытием (ED-12) и после
 *   переоткрытия ДРУГОЙ; просмотрщик, оставшийся на прежнем, правил бы
 *   документ, которого нет ни в открытом проекте, ни в его группе записи
 *   (ED-19, ED-21). Поэтому путь спрашивается функцией (`open`), а не берётся
 *   значением, и переоткрытие (`reopen`) перечитывает заодно дерево: файл,
 *   появившийся извне, иначе не показался бы вовсе.
 * - **состояние ассета.** Отказ — это состояние загрузки, а не свойство файла
 *   (ASSET-4): автор, починивший файл, обязан иметь способ спросить заново,
 *   иначе причина висит до перезапуска редактора (ED-20). Просьбу принимает
 *   `AssetProbe.retry`, а кэш, устаревший от правки дерева, выбрасывает
 *   держатель модуля (шапка `assetModule.ts`) — и открытое открывается заново.
 */
import {
  contentPathParent,
  openDocumentFromHost,
  type ContentPath,
  type DocumentId,
  type DocumentKind,
  type EditorSession,
  type EnvironmentHost,
  type JsonValue,
  type OperationParams,
} from '@fluxus/editor-core';
import type { CameraEffectsDescription, EntityVisual } from '@fluxus/assets';
import { ANIMATION_STATES, CAMERA_EFFECTS_DESCRIPTION } from '@fluxus/render';
import {
  children,
  documentValue,
  el,
  resourceText,
  type UiNode,
  type UiText,
} from '../dom/node.js';
import type {
  AreaContext,
  AreaSearch,
  AreaSetup,
  WorkspaceArea,
} from '../frame/area.js';
import { matchesQuery, type SearchHit } from '../palette/palette.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { numberField, select, textField } from '../widgets/field.js';
import { fieldTable, type FieldGroupSpec, type FieldRowSpec } from '../widgets/fieldTable.js';
import { sectionTitle, tree, type TreeItem } from '../widgets/rows.js';
import { withValidation } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import {
  EMPTY_ASSET_TREE,
  findAssetNode,
  loadAssetTree,
  walkAssetNodes,
  type AssetNode,
  type AssetTree,
} from './assetTree.js';
import {
  createAssetProbe,
  modelClips,
  modelOf,
  modelSlots,
  previewDraft,
  previewEntry,
  previewManifest,
  type AssetProbe,
  type AssetStates,
  type OpenedAsset,
} from './assetPreview.js';
import {
  VISUALS_OPERATIONS,
  entryNames,
  manifestOf,
  skinNames,
  type AnimationTable,
} from './assetVisuals.js';
import {
  CAMERA_EFFECTS_OPERATIONS,
  EFFECT_KEY,
  EVENTS_TABLE,
  REMOVE_BINDING_OPERATION,
  STATES_TABLE,
  bindingNames,
  bindingOf,
  bindingPath,
  emittedEventTypes,
  paramsForBinding,
  typesForTable,
} from './assetCameraEffects.js';
import { effectParamKey } from '../i18n/cameraEffectBundles.js';
import { createAssetModule, type AssetModule } from './assetModule.js';
import {
  canRender,
  createSceneStage,
  type SceneStage,
  type SceneStageOptions,
} from './sceneStage.js';
import { reasonOf } from '../reason.js';
import { areaFrame, runOperation } from '../frame/areaChrome.js';

/** Идентификатор области. Один и тот же в реестре, рельсе и записи состояния. */
export const ASSETS_AREA_ID = 'area.assets';

/** Узел кадра, в который встаёт холст превью. */
export const ASSETS_VIEWPORT_ID = 'fx-assets-viewport';

/**
 * Вид документа манифеста визуалов. Вид принадлежит документу, а не области:
 * тот же манифест открывает область сцены, и одно и то же значение здесь и там
 * — не совпадение, а условие того, что документ у них один (сессия открывает
 * его однажды).
 */
const DEFAULT_VISUALS_KIND: DocumentKind = 'visuals';

/**
 * Вид документов сцены. Просмотрщик их не правит и не открывает — он лишь
 * собирает из них подсказки имён событий тика (ED-14), и вид приходит той же
 * настройкой, что вид манифеста.
 */
const DEFAULT_SCENE_KIND: DocumentKind = 'scene';

/** Обратные каналы кадра: он объявляет то, что видно в интерфейсе (ED-8, CAM-2). */
export interface AssetStageHooks {
  readonly announce: () => void;
}

export type AssetStageFactory = (
  host: EnvironmentHost,
  hooks: AssetStageHooks,
) => SceneStage | null;

export interface AssetAreaOptions {
  /** Хост среды (ED-12): чем читается дерево контента. Нет — проект не открыт. */
  readonly host?: EnvironmentHost;
  /** Документ манифеста визуалов (ASSET-6), в записи которого пишет выбор. */
  readonly visuals?: ContentPath;
  /**
   * Чем манифест открытого проекта СПРАШИВАЕТСЯ, когда он заранее не известен:
   * состав проекта приносит открытие (ED-12), и после переоткрытия он другой.
   * `null` — открывать нечего. Зовётся и повторно — командой открытия проекта
   * (ED-24): просмотрщик, оставшийся на прежнем манифесте, правил бы документ,
   * которого нет ни в открытом проекте, ни в его группе записи (ED-21).
   */
  readonly open?: () => Promise<ContentPath | null>;
  readonly visualsKind?: DocumentKind;
  /**
   * Вид документов сцены — из них собираются подсказки имён событий (ED-14):
   * литералы `emitEvent.type` открытых сцен. Проверкой они не становятся —
   * машинного перечня событий тика нет.
   */
  readonly sceneKind?: DocumentKind;
  /**
   * Машинное описание типов эффектов камеры (`camera` CAM-9). Умолчание —
   * описание сборки камеры; параметром оно ради того же, ради чего у диспетчера:
   * новый тип обязан появляться в таблицах САМ, и проверяется это подставленным
   * описанием, а не правкой этого файла (ED-14).
   */
  readonly cameraEffects?: CameraEffectsDescription;
  /** Корень обхода дерева; по умолчанию — весь корень (ED-20: навигация по дереву). */
  readonly root?: ContentPath;
  /**
   * Чем собирается кадр превью. Подменяется тестом на структурный дубль: WebGL в
   * headless-прогоне нет, а проверять, ЧТО просмотрщик отдаёт рендеру, надо.
   */
  readonly stage?: AssetStageFactory;
  /**
   * Чем спрашивается состояние ассета (ASSET-4); по умолчанию — модуль самого
   * кадра. Второго сервиса не заводится: кэш один на ID (ASSET-2), и сборка
   * подаёт общий модуль через `stage` (`assetStageFactory`), а не вторым полем.
   */
  readonly assets?: AssetStates;
}

export interface AssetAreaState {
  /** Дерево контента и причина, по которой его нет (ED-12, ED-20). */
  tree: AssetTree;
  readonly expanded: Set<string>;
  focusId: string;
  /** Файл, выбранный в дереве; `null` — ничего не выбрано. */
  selected: ContentPath | null;
  /** Запись манифеста, для которой идёт выбор (ED-14); `''` — не выбрана. */
  entry: string;
  /** Клип и скин превью — выбор автора, а не правка документа (REND-11). */
  clip: string;
  skin: string;
  /** Номер слота текстуры, который подменит выбранная текстура (REND-6). */
  slot: string;
  /** Таблица секции эффектов, с которой работает автор (ASSET-8): события или состояния. */
  effectTable: string;
  /** Выбранная привязка — субъект полей ниже; `''` — не выбрана. */
  effectBinding: string;
  /** Имя заводимой привязки и тип, который ей назначат: черновик, а не документ. */
  effectName: string;
  effectType: string;
  /**
   * Имя события, которому автор заводит клип (ED-14, REND-4): черновик, а не
   * документ. Состояния перечисляет код рендера, а события — контент, и второй
   * стороне таблицы нужно место, где имя набирается до записи.
   */
  animationEvent: string;
  /** Описание типов эффектов (CAM-9) — им и только им строятся обе таблицы. */
  readonly effects: CameraEffectsDescription;
  /** Вид документов сцены: из них собираются подсказки имён событий. */
  readonly sceneKind: DocumentKind;
  /** Кадр превью; `null` — в этой среде рисовать нечем. */
  stage: SceneStage | null;
  /** Состояния открытых ассетов (ASSET-4) — из них и берётся причина отказа. */
  readonly probe: AssetProbe;
  /** ID документа манифеста; `null` — он ещё не открыт. */
  visualsId: DocumentId | null;
  /** Почему сорвалось открытие или последнее действие автора (ED-8). */
  failure: string | null;
  /** Почему нечего показать в кадре: манифест не разбирается (ED-8). */
  previewFailure: string | null;
  /**
   * Открыть проект заново (ED-12, ED-24): спросить манифест открытого проекта и
   * перечитать дерево контента. Тем же вызовом это делает команда палитры —
   * второго пути открытия не заводится.
   */
  reopen: () => void;
  refresh: () => void;
}

/**
 * Чем собирается кадр превью. Отдельно от самой сборки, потому что проверяемо
 * без WebGL ровно это: «набор из одного инстанса без сцены и террейна» (REND-11)
 * начинается с того, что кадр поднимается без террейна.
 */
export function assetStageOptions(
  assets: AssetModule,
  hooks: AssetStageHooks,
): SceneStageOptions {
  return {
    hostId: ASSETS_VIEWPORT_ID,
    // Тот же модуль ассетов, которым рисует вьюпорт сцены: кэш один на ID
    // (ASSET-2), и состояние ассета у просмотрщика и у кадра одно.
    assets,
    // Записей ещё нет: первую принесёт переподача манифеста (REND-17).
    visuals: previewManifest(null),
    // Вырожденный случай REND-11: ни сцены, ни террейна не будет никогда.
    terrain: false,
    onChange: hooks.announce,
  };
}

/** Кадр превью по умолчанию: тот же рендер, что вьюпорт (ED-1), без террейна. */
function defaultStage(assets: AssetModule, hooks: AssetStageHooks): SceneStage | null {
  return canRender() ? createSceneStage(assetStageOptions(assets, hooks)) : null;
}

/**
 * Кадр превью на ОБЩЕМ модуле ассетов — это и подаёт сборка (ED-25): один
 * модуль на редактор (ASSET-2), а контекст рендера у каждого кадра свой
 * (см. шапку `assetModule.ts`). Без неё область заводит свой модуль — так она
 * собирается там, где сборки нет вовсе (тест, галерея).
 */
export function assetStageFactory(assets: AssetModule): AssetStageFactory {
  return (_host, hooks) => defaultStage(assets, hooks);
}

/** Запись манифеста, выбранная автором; `null` — не выбрана либо её нет. */
function recordOf(state: AssetAreaState, session: EditorSession): EntityVisual | null {
  const id = state.visualsId;
  if (id === null || state.entry === '' || !session.isOpen(id)) return null;
  return manifestOf(session.documentValue(id)).entities[state.entry] ?? null;
}

/** ID выбранной модели — только модели: текстурой запись не рисуется. */
function selectedModel(state: AssetAreaState): string | null {
  const path = state.selected;
  if (path === null) return null;
  const node = findAssetNode(state.tree, path);
  return node?.asset === 'model' ? path : null;
}

/**
 * Подача кадра: манифест из одной записи (REND-17) и вырожденный набор
 * (REND-11). Зовётся на всякое изменение выбора и на всякую правку документа —
 * ED-15 требует показать результат не позже следующего кадра, и просмотрщику
 * это правило принадлежит наравне с вьюпортом сцены.
 */
function show(state: AssetAreaState, session: EditorSession): void {
  const stage = state.stage;
  if (stage === null) return;
  let entry: EntityVisual | null = null;
  try {
    entry = previewEntry(recordOf(state, session), selectedModel(state));
    state.previewFailure = null;
  } catch (error) {
    // Сломанный манифест не гасит область: причина показывается, кадр остаётся
    // пустым, дерево и остальные ассеты работают (ED-8, ED-20).
    state.previewFailure = reasonOf(error);
  }
  stage.applyVisuals(previewManifest(entry));
  stage.submit(previewDraft(entry, { clip: state.clip, skin: state.skin }));
}

/** Каталоги над путём — их раскрывает находка поиска, чтобы найденное было видно. */
function ancestorsOf(path: ContentPath): readonly ContentPath[] {
  const parents: ContentPath[] = [];
  let current = contentPathParent(path);
  while (current !== '') {
    parents.push(current);
    current = contentPathParent(current);
  }
  return parents;
}

/** Выбор строки дерева: открыть ассет (ASSET-2) и показать его (ED-20). */
function pick(state: AssetAreaState, session: EditorSession, node: AssetNode): void {
  state.focusId = node.path;
  if (node.kind === 'directory') {
    if (state.expanded.has(node.path)) state.expanded.delete(node.path);
    else state.expanded.add(node.path);
    return;
  }
  state.selected = node.path;
  // Клип принадлежит модели, а не автору: у другой модели клипов с прежним
  // именем может не быть вовсе, и оставленный выбор рисовал бы не то.
  state.clip = '';
  if (node.asset !== null) state.probe.open(node.asset, node.path);
  show(state, session);
}

/**
 * Назначение выбранного в запись манифеста (ED-20). Пишет операция и только она
 * (ED-29); отказ операции — структурный (ED-30), и его причина показывается, а
 * не теряется в обработчике нажатия.
 */
function assign(
  context: AreaContext<AssetAreaState>,
  operationId: string,
  params: OperationParams,
): void {
  const { state } = context;
  const id = state.visualsId;
  if (id === null) return;
  // Дальше — общий каркасный ход операции: он снимает прежнюю причину, называет
  // новую и один раз просит перерисовать. Своего try/catch и своей просьбы у
  // области нет: вторые разошлись бы с каркасом по одной штуке за раз.
  runOperation(context, operationId, { document: id, entry: state.entry, ...params });
}

/**
 * Чем спрашивается манифест открытого проекта. Известный заранее и приносимый
 * открытием — один и тот же шаг для области: она получает путь и не знает,
 * откуда его взяли.
 */
function opener(options: AssetAreaOptions): (() => Promise<ContentPath | null>) | null {
  if (options.open !== undefined) return options.open;
  const id = options.visuals;
  return id === undefined ? null : () => Promise.resolve(id);
}

/**
 * Открытие манифеста и дерева. Оба асинхронны и оба падают по-своему: манифеста
 * может не быть в проекте, перечисления — в среде (ED-12). Ни то, ни другое не
 * должно уносить область: каждая половина ловит своё и называет причину.
 *
 * Зовётся и повторно — переоткрытием проекта (ED-24). Дерево при этом читается
 * заново всегда: файл, появившийся извне, иначе не показался бы вовсе (ED-12).
 * Манифест переоткрывается только когда он ДРУГОЙ: тот же документ пересобирать
 * незачем, а сброс выбранной записи на ровном месте отобрал бы у автора то, чем
 * он в этот момент занят (ED-23).
 */
function start(state: AssetAreaState, setup: AreaSetup, options: AssetAreaOptions): void {
  const host = options.host;
  if (host === undefined) return;
  const session = setup.session;
  const open = opener(options);

  const openVisuals = async (): Promise<void> => {
    if (open === null) return;
    const id = await open();
    // Открывать нечего — это ответ, а не отказ: в дереве может не быть ни
    // одного проекта, и причины у этого нет.
    if (id === null || id === state.visualsId) return;
    // Идемпотентно: тот же манифест открывает область сцены, документ у них
    // один, и сессия открывает его однажды (ED-23).
    if (!session.isOpen(id)) {
      await openDocumentFromHost(session, host.content, {
        id,
        kind: options.visualsKind ?? DEFAULT_VISUALS_KIND,
      });
    }
    state.visualsId = id;
    // Первая запись — она же выбранная: пустой выбор запер бы все три
    // назначения, а выбирать автору пока не из чего. Запись прежнего проекта
    // при этом не переносится: имена записей принадлежат манифесту, и совпасть
    // они могут только случайно.
    state.entry = entryNames(session.documentValue(id))[0] ?? '';
    // Скин описан записью (ASSET-6), а запись теперь другая.
    state.skin = '';
  };

  const readTree = async (): Promise<void> => {
    state.tree = await loadAssetTree(
      host.content,
      options.root === undefined ? {} : { root: options.root },
    );
  };

  const guard = async (work: Promise<void>): Promise<void> => {
    try {
      await work;
    } catch (error) {
      state.failure = reasonOf(error);
    }
  };

  state.failure = null;
  void Promise.all([guard(openVisuals()), guard(readTree())]).then(() => {
    show(state, session);
    state.refresh();
  });
}

// ------------------------------------------------------------------ зоны

/**
 * Причина отказа ассета одним текстом (ASSET-4, ED-27): её называет модуль
 * ассетов — тогда это значение, — а если его в этой среде нет, то и назвать её
 * может только сам интерфейс, то есть ресурс.
 */
function assetReason(context: AreaContext<AssetAreaState>, asset: OpenedAsset): UiText {
  return asset.reason === null
    ? resourceText(context.resources, 'ui.area.assets.noAssets')
    : documentValue(asset.reason);
}

function nodeItem(context: AreaContext<AssetAreaState>, node: AssetNode): TreeItem {
  const { state } = context;
  const opened = node.kind === 'file' ? state.probe.stateOf(node.path) : undefined;
  return {
    id: node.path,
    label: documentValue(node.name),
    // Вид ассета — данные, а не состояние: пометка идёт значением (ED-27).
    ...(node.asset === null ? {} : { badge: documentValue(node.asset) }),
    ...(node.children.length === 0
      ? {}
      : {
          expanded: state.expanded.has(node.path),
          items: node.children.map((child) => nodeItem(context, child)),
        }),
    selected: state.selected === node.path,
    // Ассет с отказом — иконка, положение и причина, а не оттенок (ED-22).
    // Причину называет модуль ассетов (ASSET-4), а не эта строка.
    ...(opened?.status === 'failed'
      ? { validation: { severity: 'error' as const, reason: assetReason(context, opened) } }
      : {}),
    onSelect: () => {
      pick(state, context.session, node);
      context.refresh();
    },
    onToggle: () => {
      pick(state, context.session, node);
      context.refresh();
    },
  };
}

function navigator(context: AreaContext<AssetAreaState>): UiNode {
  const { state, resources } = context;
  return el('div', {
    children: children(
      sectionTitle(resourceText(resources, 'ui.navigator.title')),
      // Перечисления в этой среде нет — так и сказано (ED-12). Пустое дерево на
      // этом месте означало бы «ассетов нет», то есть неправду.
      state.tree.failure === null
        ? undefined
        : el('div', {
            classes: ['fx-row'],
            children: [
              withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.assets.noListing'),
                  tone: 'error',
                }),
                { severity: 'error', reason: documentValue(state.tree.failure) },
              ),
            ],
          }),
      // «Дерево пусто» — утверждение об ассетах, и говорить его вместе с
      // «перечислить их нечем» значило бы сказать неправду вторым сообщением.
      state.tree.nodes.length === 0
        ? state.tree.failure !== null
          ? undefined
          : el('div', {
              classes: ['fx-row'],
              text: resourceText(resources, 'ui.area.assets.emptyTree'),
            })
        : tree({
            label: resourceText(resources, 'ui.navigator.assets'),
            items: state.tree.nodes.map((node) => nodeItem(context, node)),
            rovingId: 'assets-tree',
            activeId: state.focusId,
            onActive: (id) => {
              state.focusId = id;
              context.refresh();
            },
          }),
    ),
  });
}

/** Выпадающий список из идентификаторов документа: локаль их не касается (ED-27). */
function choice(
  context: AreaContext<AssetAreaState>,
  labelKey: string,
  value: string,
  values: readonly string[],
  onPick: (next: string) => void,
): UiNode {
  return select({
    label: resourceText(context.resources, labelKey),
    value,
    options: [
      { value: '', label: resourceText(context.resources, 'ui.area.assets.none') },
      ...values.map((name) => ({ value: name, label: documentValue(name) })),
    ],
    disabled: values.length === 0,
    onSelect: onPick,
  });
}

/**
 * Полоса выбора и назначений. Недоступное показано недоступным, а не молча не
 * срабатывает (ED-26): без записи назначать некуда, без модели нечего, без
 * скина и слота текстуре негде встать, а в превью авторинг закрыт целиком
 * (ED-9).
 */
function bar(context: AreaContext<AssetAreaState>): readonly UiNode[] {
  const { state, resources, session } = context;
  const off = context.mode === 'preview';
  const record = state.visualsId === null ? null : safeRecord(state, session);
  const model = modelOf(state.selected === null ? undefined : state.probe.stateOf(state.selected));
  const entries = state.visualsId === null ? [] : entryNames(session.documentValue(state.visualsId));
  const chosenModel = selectedModel(state);
  const chosenTexture =
    state.selected !== null && findAssetNode(state.tree, state.selected)?.asset === 'texture'
      ? state.selected
      : null;

  const act = (key: string, disabled: boolean, press: () => void): UiNode =>
    button({
      label: resourceText(resources, key),
      variant: 'ghost',
      disabled,
      onPress: press,
    });

  // Ассет, который автор починил в дереве, обязан иметь способ загрузиться
  // заново (ASSET-4 это разрешает, ED-20 делает нужным): иначе причина отказа
  // висит до перезапуска редактора. Повторять нечего, пока ничего не отказало,
  // — и тогда кнопка показана недоступной, а не молчит (ED-26). В превью она
  // доступна: загрузка ассета — не операция авторинга (ED-9).
  const failedAsset =
    state.selected !== null && state.probe.stateOf(state.selected)?.status === 'failed';

  return [
    act('ui.area.assets.retry', !failedAsset, () => {
      if (state.selected !== null) state.probe.retry(state.selected);
    }),
    choice(context, 'ui.area.assets.entry', state.entry, entries, (next) => {
      state.entry = next;
      state.skin = '';
      show(state, session);
      context.refresh();
    }),
    choice(context, 'ui.area.assets.clip', state.clip, modelClips(model), (next) => {
      state.clip = next;
      show(state, session);
      context.refresh();
    }),
    choice(context, 'ui.area.assets.skin', state.skin, skinNames(record), (next) => {
      state.skin = next;
      show(state, session);
      context.refresh();
    }),
    choice(
      context,
      'ui.area.assets.slot',
      state.slot,
      modelSlots(model).map((slot) => String(slot)),
      (next) => {
        state.slot = next;
        context.refresh();
      },
    ),
    act(
      'ui.area.assets.assignModel',
      off || state.visualsId === null || state.entry === '' || chosenModel === null,
      () => {
        assign(context, VISUALS_OPERATIONS.setModel, { asset: chosenModel ?? '' });
      },
    ),
    act(
      'ui.area.assets.assignTexture',
      off ||
        state.visualsId === null ||
        state.entry === '' ||
        state.skin === '' ||
        state.slot === '' ||
        chosenTexture === null,
      () => {
        assign(context, VISUALS_OPERATIONS.setSkinTexture, {
          skin: state.skin,
          slot: state.slot,
          asset: chosenTexture ?? '',
        });
      },
    ),
    act(
      'ui.area.assets.assignSkin',
      off || state.visualsId === null || state.entry === '' || state.skin === '',
      () => {
        assign(context, VISUALS_OPERATIONS.setDefaultSkin, { skin: state.skin });
      },
    ),
  ];
}

/** Запись без броска: сломанный манифест уже назван причиной в `previewFailure`. */
function safeRecord(state: AssetAreaState, session: EditorSession): EntityVisual | null {
  try {
    return recordOf(state, session);
  } catch {
    return null;
  }
}

function surface(context: AreaContext<AssetAreaState>): UiNode {
  const { state, resources } = context;
  const opened = state.selected === null ? undefined : state.probe.stateOf(state.selected);
  // Четыре источника одной причины, а не четыре способа её показать: не
  // открылся документ или отказала операция, не разобрался манифест, не прошёл
  // кадр, не загрузился ассет (ED-8, ED-30).
  const failure = state.failure ?? state.previewFailure ?? state.stage?.failure ?? null;

  return el('div', {
    classes: [FILL_CLASS, FILL_COLUMN_CLASS],
    children: children(
      el('div', {
        classes: ['fx-bar'],
        children: children(
          ...bar(context),
          failure === null
            ? undefined
            : withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.assets.broken'),
                  tone: 'error',
                }),
                { severity: 'error', reason: documentValue(failure) },
              ),
          // Отказ самого ассета — рядом с ним же и с его причиной (ED-20,
          // ASSET-4). Остальные ассеты этим не затронуты: состояние у каждого
          // своё, и отказавший не мешает открыть соседний.
          opened?.status === 'failed'
            ? withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.assets.brokenAsset'),
                  tone: 'error',
                }),
                { severity: 'error', reason: assetReason(context, opened) },
              )
            : undefined,
        ),
      }),
      el('div', {
        classes: [FILL_CLASS],
        children: [
          viewportFrame({
            label: resourceText(resources, 'ui.area.assets.viewport'),
            hostId: ASSETS_VIEWPORT_ID,
          }),
        ],
      }),
    ),
  });
}

// ------------------------------------------------- секция эффектов камеры

/**
 * Две таблицы секции эффектов камеры (ED-14): «событие тика → импульсный
 * эффект» и «состояние сущности → длящийся эффект». Строятся они ИЗ ОПИСАНИЯ
 * (CAM-9) целиком: перечень типов, поля записи и их подсказки — всё оттуда, и
 * своего списка типов у редактора нет ни в каком виде.
 *
 * Живут они в области ассетов, а не в своей: у секции нет своего документа, а
 * ED-23 требует, чтобы состояние области переживало переключение, а не
 * размножалось. Перерастёт зону инспектора — станет своей областью вкладом
 * (ED-25), и ни операции, ни описание при этом не поменяются.
 */
function effectRows(context: AreaContext<AssetAreaState>, table: string): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const id = state.visualsId;
  if (id === null || !session.isOpen(id)) return [];
  const value = session.documentValue(id);
  const description = context.state.effects;
  const names = bindingNames(value, table);
  const selected = state.effectTable === table ? state.effectBinding : '';
  const off = context.mode === 'preview';

  const rows: FieldRowSpec[] = names.map((name) => {
    const record = bindingOf(value, table, name);
    const effect = typeof record?.[EFFECT_KEY] === 'string' ? record[EFFECT_KEY] : '';
    return {
      label: documentValue(name),
      // Тип записи — выбор из описания, отфильтрованного по виду таблицы: он же
      // и перетипизация, и делает её та же операция, что заводит привязку.
      control: select({
        label: documentValue(name),
        value: effect,
        options: [
          { value: '', label: resourceText(resources, 'ui.area.assets.none') },
          ...typesForTable(description, table).map((type) => ({
            value: type.id,
            label: documentValue(type.id),
          })),
        ],
        disabled: off,
        onSelect: (next) => {
          state.effectTable = table;
          state.effectBinding = name;
          if (next !== '' && next !== effect) {
            effectOperation(context, CAMERA_EFFECTS_OPERATIONS.bind, {
              table,
              name,
              effect: next,
            });
          } else {
            context.refresh();
          }
        },
      }),
      ...(selected === name ? { note: resourceText(resources, 'ui.area.assets.effectSelected') } : {}),
    };
  });

  if (selected !== '') {
    rows.push(...effectParamRows(context, table, selected));
    rows.push(removeBindingRow(context, table, selected));
  }
  return rows;
}

/**
 * Снятие выбранной привязки (ED-14). Своей операции у него нет и не нужно —
 * это ровно `document.removeValue` (`assetCameraEffects.ts`), — но дотянуться
 * до него из таблицы автор обязан: иначе ошибочную привязку пришлось бы стирать
 * руками в JSON, а ED-14 требует, чтобы ручная правка манифеста не была
 * обязательной. Пустой пункт списка типов — не действие, а показ «типа нет»,
 * и удалением он быть не может.
 */
function removeBindingRow(
  context: AreaContext<AssetAreaState>,
  table: string,
  name: string,
): FieldRowSpec {
  const { state, resources } = context;
  return {
    label: resourceText(resources, 'ui.area.assets.effectRemove'),
    control: button({
      label: resourceText(resources, 'ui.area.assets.effectRemove'),
      variant: 'ghost',
      disabled: context.mode === 'preview',
      onPress: () => {
        effectOperation(context, REMOVE_BINDING_OPERATION, { path: bindingPath(table, name) });
        state.effectBinding = '';
      },
    }),
  };
}

/** Поля выбранной привязки: параметры типа плюс параметры привязки его вида. */
function effectParamRows(
  context: AreaContext<AssetAreaState>,
  table: string,
  name: string,
): readonly FieldRowSpec[] {
  const { state, session, resources } = context;
  const id = state.visualsId;
  if (id === null || !session.isOpen(id)) return [];
  const record = bindingOf(session.documentValue(id), table, name);
  const effect = typeof record?.[EFFECT_KEY] === 'string' ? record[EFFECT_KEY] : '';
  const off = context.mode === 'preview';
  return paramsForBinding(context.state.effects, effect).map((param) => {
    const current = record?.[param.name];
    return {
      label: documentValue(param.name),
      // Подсказка — по ключу ED-28 из пути описания: ресурса может не быть, и
      // тогда автор увидит сам ключ — видимый признак недокументированного.
      hint: resourceText(resources, effectParamKey(effect, param.name)),
      control: numberField({
        label: documentValue(param.name),
        value: documentValue(typeof current === 'number' ? String(current) : ''),
        readOnly: off,
        onCommit: (raw) => {
          const parsed = Number(raw);
          if (raw.trim() === '' || Number.isNaN(parsed)) return;
          effectOperation(context, CAMERA_EFFECTS_OPERATIONS.setParam, {
            table,
            name,
            param: param.name,
            value: parsed,
          });
        },
      }),
    };
  });
}

/** Заведение привязки: имя, тип и кнопка. Имя события подсказывается, а не проверяется. */
function effectDraftRows(context: AreaContext<AssetAreaState>): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const off = context.mode === 'preview';
  const table = state.effectTable;
  const suggestions = state.effectTable === EVENTS_TABLE ? eventSuggestions(context) : [];
  return [
    {
      label: resourceText(resources, 'ui.area.assets.effectTable'),
      control: select({
        label: resourceText(resources, 'ui.area.assets.effectTable'),
        value: table,
        options: [
          { value: EVENTS_TABLE, label: resourceText(resources, 'ui.area.assets.effectEvents') },
          { value: STATES_TABLE, label: resourceText(resources, 'ui.area.assets.effectStates') },
        ],
        onSelect: (next) => {
          state.effectTable = next;
          state.effectBinding = '';
          state.effectType = '';
          context.refresh();
        },
      }),
    },
    {
      label: resourceText(resources, 'ui.area.assets.effectName'),
      control: textField({
        label: resourceText(resources, 'ui.area.assets.effectName'),
        value: documentValue(state.effectName),
        readOnly: off,
        onCommit: (raw) => {
          state.effectName = raw;
          context.refresh();
        },
      }),
    },
    // Подсказка имён событий (ED-14): литералы `emitEvent.type` открытых сцен.
    // Выбор подставляет имя в поле — назвать событие, которого в сценах ещё
    // нет, автор по-прежнему вправе: машинного перечня событий тика нет.
    ...(state.effectTable === EVENTS_TABLE
      ? [
          {
            label: resourceText(resources, 'ui.area.assets.effectSuggested'),
            control: select({
              label: resourceText(resources, 'ui.area.assets.effectSuggested'),
              value: suggestions.includes(state.effectName) ? state.effectName : '',
              options: [
                { value: '', label: resourceText(resources, 'ui.area.assets.none') },
                ...suggestions.map((name) => ({ value: name, label: documentValue(name) })),
              ],
              disabled: off || suggestions.length === 0,
              onSelect: (next) => {
                state.effectName = next;
                context.refresh();
              },
            }),
          } satisfies FieldRowSpec,
        ]
      : []),
    {
      label: resourceText(resources, 'ui.area.assets.effectType'),
      control: select({
        label: resourceText(resources, 'ui.area.assets.effectType'),
        value: state.effectType,
        options: [
          { value: '', label: resourceText(resources, 'ui.area.assets.none') },
          ...typesForTable(context.state.effects, table).map((type) => ({
            value: type.id,
            label: documentValue(type.id),
          })),
        ],
        disabled: off,
        onSelect: (next) => {
          state.effectType = next;
          context.refresh();
        },
      }),
    },
    {
      label: resourceText(resources, 'ui.area.assets.effectBind'),
      control: button({
        label: resourceText(resources, 'ui.area.assets.effectBind'),
        variant: 'ghost',
        disabled:
          off ||
          state.visualsId === null ||
          !session.isOpen(state.visualsId) ||
          state.effectName === '' ||
          state.effectType === '',
        onPress: () => {
          effectOperation(context, CAMERA_EFFECTS_OPERATIONS.bind, {
            table,
            name: state.effectName,
            effect: state.effectType,
          });
          state.effectBinding = state.effectName;
        },
      }),
    },
  ];
}

/**
 * Имена событий тика из открытых сцен (ED-14) — подсказка, а не проверка:
 * нативные системы ядра называют свои события литералами в коде, и машинного
 * перечня событий сегодня нет вовсе.
 */
function eventSuggestions(context: AreaContext<AssetAreaState>): readonly string[] {
  const { session, state } = context;
  const found = new Set<string>();
  for (const id of session.documentIds()) {
    if (session.document(id).kind !== state.sceneKind) continue;
    for (const type of emittedEventTypes(session.documentValue(id))) found.add(type);
  }
  return [...found].sort();
}

/** Правка секции идёт операцией и только ей (ED-29); отказ показывается причиной (ED-30). */
function effectOperation(
  context: AreaContext<AssetAreaState>,
  operationId: string,
  params: OperationParams,
): void {
  const id = context.state.visualsId;
  if (id === null) return;
  runOperation(context, operationId, { document: id, ...params });
}

/**
 * Правка записи манифеста, названная ED-14 поимённо и до сих пор недоступная:
 * маппинг анимаций (`rendering` REND-4), параметры наклона по поверхности
 * (REND-10) и ссылка манифеста на ассет арены — карту кривизны (ASSET-7).
 *
 * «Ручная правка манифеста MUST NOT быть обязательной» (ED-14) читается
 * буквально: чтобы сказать «клип бега у этого юнита называется Run», задать
 * долю наклона или подключить сцене карту кривизны, автор до этой работы
 * открывал `manifest.json` в текстовом редакторе.
 *
 * Перечень состояний рендера приходит ИЗ КОДА РЕНДЕРА (`ANIMATION_STATES`), а
 * не набирается здесь: тот же довод, по которому типы эффектов камеры приходят
 * описанием (ED-2, ED-14). Имена событий, наоборот, — контент: их подсказывает
 * тот же сбор эмитируемых типов, что у таблицы эффектов, и закрытым списком он
 * не является.
 *
 * Показываются при этом ОБЕ таблицы одинаково: имена перечня плюс имена, уже
 * лежащие в документе. Манифест ключей этих таблиц не нормирует
 * (`validateManifest` принимает любые), и ключ вне словаря там оказывается по
 * двум честным поводам — опечатка автора и состояние, выведенное из REND-4
 * позже. Показывай мы один словарь, такая запись стала бы невидимой и
 * несносимой из редактора, то есть чинилась бы только правкой JSON руками —
 * ровно тем, что ED-14 запрещает считать обязательным.
 */
function animationRows(
  context: AreaContext<AssetAreaState>,
  table: AnimationTable,
): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const record = safeRecord(state, session);
  if (record === null) return [];
  const off = context.mode === 'preview';
  const mapping = record.animations?.[table] ?? {};
  // Порядок: сначала словарь (у состояний он смысловой — от покоя к падению,
  // и алфавит его сломал бы), затем всё, что лежит в документе сверх него.
  const known = table === 'states' ? ANIMATION_STATES : [...eventSuggestions(context)].sort();
  const extra = Object.keys(mapping)
    .filter((name) => !known.includes(name))
    .sort();
  const names = [...known, ...extra];
  const row = (name: string): FieldRowSpec => ({
    label: documentValue(name),
    control: textField({
      label: documentValue(name),
      value: documentValue(mapping[name] ?? ''),
      readOnly: off,
      onCommit: (raw) => {
        const clip = raw.trim();
        if (clip === (mapping[name] ?? '')) return;
        assign(context, VISUALS_OPERATIONS.setAnimation, { table, name, clip });
      },
    }),
  });
  const rows = names.map(row);
  // Событие, которого нет ни в записи, ни среди эмитируемых сценой: имя
  // набирается автором. Своего ряда у таблицы состояний нет — её имена
  // перечисляет код рендера, и придумать шестое состояние автор не вправе.
  if (table === 'events') {
    rows.push({
      label: resourceText(resources, 'ui.area.assets.animationEventName'),
      control: textField({
        label: resourceText(resources, 'ui.area.assets.animationEventName'),
        value: documentValue(state.animationEvent),
        readOnly: off,
        onCommit: (raw) => {
          state.animationEvent = raw.trim();
          context.refresh();
        },
      }),
    });
    if (state.animationEvent !== '' && !names.includes(state.animationEvent)) {
      rows.push(row(state.animationEvent));
    }
  }
  return rows;
}

/**
 * Параметры наклона записи по нормали визуальной поверхности (ED-14, REND-10).
 * Пишутся одной операцией и блоком целиком: `factor` в блоке обязателен, и
 * правка одного лимита угла оставила бы в документе невалидный блок.
 *
 * Показывается ЗНАЧЕНИЕ ЗАПИСИ, а не разрешённое (`resolveSurfaceAlign`): автор
 * правит запись, и подставленное умолчание манифеста он принял бы за своё —
 * а сняв его, увидел бы, что число вернулось.
 */
function surfaceAlignRows(context: AreaContext<AssetAreaState>): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const record = safeRecord(state, session);
  if (record === null) return [];
  const off = context.mode === 'preview';
  const align = record.surfaceAlign;
  const write = (factor: number, maxAngleDeg: number | undefined): void => {
    assign(context, VISUALS_OPERATIONS.setSurfaceAlign, {
      factor,
      ...(maxAngleDeg === undefined ? {} : { maxAngleDeg }),
    });
  };
  const number = (raw: string): number | undefined => {
    const parsed = Number(raw.trim());
    return raw.trim() === '' || Number.isNaN(parsed) ? undefined : parsed;
  };
  return [
    {
      label: resourceText(resources, 'ui.area.assets.alignFactor'),
      control: numberField({
        label: resourceText(resources, 'ui.area.assets.alignFactor'),
        value: documentValue(align === undefined ? '' : String(align.factor)),
        readOnly: off,
        onCommit: (raw) => {
          const factor = number(raw);
          if (factor !== undefined) write(factor, align?.maxAngleDeg);
        },
      }),
    },
    {
      label: resourceText(resources, 'ui.area.assets.alignMaxAngle'),
      control: numberField({
        label: resourceText(resources, 'ui.area.assets.alignMaxAngle'),
        value: documentValue(align?.maxAngleDeg === undefined ? '' : String(align.maxAngleDeg)),
        readOnly: off,
        // Пустое поле — снятие лимита, а не ноль: ноль означает вертикаль.
        onCommit: (raw) => {
          if (align !== undefined) write(align.factor, number(raw));
        },
      }),
    },
  ];
}

/**
 * Ссылка манифеста на ассет арены (ED-14) — карта кривизны (ASSET-7). Строка
 * принадлежит документу, а не выбранной записи: карта у арены одна.
 */
function terrainRows(context: AreaContext<AssetAreaState>): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const id = state.visualsId;
  if (id === null || !session.isOpen(id)) return [];
  const current = manifestTerrainMap(session.documentValue(id));
  const chosen = state.selected;
  return [
    {
      label: resourceText(resources, 'ui.area.assets.curvatureMap'),
      control: textField({
        label: resourceText(resources, 'ui.area.assets.curvatureMap'),
        value: documentValue(current),
        readOnly: context.mode === 'preview',
        onCommit: (raw) => {
          const asset = raw.trim();
          if (asset === current) return;
          runOperation(context, VISUALS_OPERATIONS.setCurvatureMap, { document: id, asset });
        },
      }),
    },
    {
      label: resourceText(resources, 'ui.area.assets.curvatureAssign'),
      control: button({
        label: resourceText(resources, 'ui.area.assets.curvatureAssign'),
        variant: 'ghost',
        // Выбранного в дереве нет — назначать нечего, и это показывается
        // недоступной кнопкой, а не молчанием (ED-26).
        disabled: context.mode === 'preview' || chosen === null || chosen === current,
        onPress: () => {
          if (chosen !== null) {
            runOperation(context, VISUALS_OPERATIONS.setCurvatureMap, { document: id, asset: chosen });
          }
        },
      }),
    },
  ];
}

/** Ссылка манифеста на карту кривизны без броска: сломанный документ уже назван. */
function manifestTerrainMap(value: JsonValue | undefined): string {
  try {
    return manifestOf(value).terrain?.curvatureMap ?? '';
  } catch {
    return '';
  }
}

/** Состояние ассета подписью: статус — ресурс, причина — текст модуля ассетов. */
const STATUS_KEYS: Readonly<Record<OpenedAsset['status'], string>> = {
  loading: 'ui.area.assets.statusLoading',
  ready: 'ui.area.assets.statusReady',
  failed: 'ui.area.assets.statusFailed',
};

/** Поля выбранного в дереве ассета и записи манифеста — то, что показано как есть. */
function assetFieldRows(context: AreaContext<AssetAreaState>): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const readOnly = (labelKey: string, value: UiText): FieldRowSpec => ({
    label: resourceText(resources, labelKey),
    control: textField({ label: resourceText(resources, labelKey), value, readOnly: true }),
  });

  const rows: FieldRowSpec[] = [];
  if (state.selected !== null) {
    rows.push(readOnly('ui.area.assets.field.path', documentValue(state.selected)));
    const opened = state.probe.stateOf(state.selected);
    if (opened !== undefined) {
      rows.push({
        label: resourceText(resources, 'ui.area.assets.field.status'),
        control: textField({
          label: resourceText(resources, 'ui.area.assets.field.status'),
          value: resourceText(resources, STATUS_KEYS[opened.status]),
          readOnly: true,
          // Отказ — состояние загрузки, а не свойство файла (ASSET-4): причина
          // показывается строкой состояния, а не отдельным сообщением.
          ...(opened.status === 'failed'
            ? { validation: { severity: 'error' as const, reason: assetReason(context, opened) } }
            : {}),
        }),
      });
    }
  }
  const record = safeRecord(state, session);
  if (record !== null) {
    rows.push(readOnly('ui.area.assets.field.model', documentValue(record.model)));
    if (record.defaultSkin !== undefined) {
      rows.push(readOnly('ui.area.assets.field.defaultSkin', documentValue(record.defaultSkin)));
    }
  }
  return rows;
}

/**
 * Группы зоны инспектора (ED-24): поля выбранного ассета, правка записи
 * манифеста (ED-14 — клипы REND-4 и наклон REND-10), ссылки на ассеты арены и
 * две таблицы секции эффектов камеры. Последние показываются, пока открыт
 * манифест: секция принадлежит документу, а не выбранному в дереве файлу.
 */
function inspectorGroups(context: AreaContext<AssetAreaState>): readonly FieldGroupSpec[] {
  const { state, resources, session } = context;
  const groups: FieldGroupSpec[] = [];
  const rows = assetFieldRows(context);
  if (rows.length > 0) {
    groups.push({ label: resourceText(resources, 'ui.inspector.fields'), rows });
  }
  if (safeRecord(state, session) !== null) {
    groups.push(
      { label: resourceText(resources, 'ui.area.assets.animationStates'), rows: animationRows(context, 'states') },
      { label: resourceText(resources, 'ui.area.assets.animationEvents'), rows: animationRows(context, 'events') },
      { label: resourceText(resources, 'ui.area.assets.surfaceAlign'), rows: surfaceAlignRows(context) },
    );
  }
  if (state.visualsId !== null && session.isOpen(state.visualsId)) {
    groups.push(
      { label: resourceText(resources, 'ui.area.assets.terrain'), rows: terrainRows(context) },
      { label: resourceText(resources, 'ui.area.assets.effectEvents'), rows: effectRows(context, EVENTS_TABLE) },
      { label: resourceText(resources, 'ui.area.assets.effectStates'), rows: effectRows(context, STATES_TABLE) },
      { label: resourceText(resources, 'ui.area.assets.effectNew'), rows: effectDraftRows(context) },
    );
  }
  return groups;
}

function inspector(context: AreaContext<AssetAreaState>): UiNode {
  const { state, resources } = context;
  const groups = inspectorGroups(context);
  return el('div', {
    children: children(
      el('div', {
        classes: ['fx-section'],
        children: children(
          el('span', { text: resourceText(resources, 'ui.inspector.title') }),
          state.entry === ''
            ? undefined
            : el('span', {
                classes: ['fx-row__trailing'],
                children: [statusChip({ label: documentValue(state.entry) })],
              }),
        ),
      }),
      groups.length === 0
        ? el('div', {
            classes: ['fx-row'],
            text: resourceText(resources, 'ui.inspector.empty'),
          })
        : fieldTable({ label: resourceText(resources, 'ui.inspector.fields'), groups: [...groups] }),
    ),
  });
}

export function createAssetArea(options: AssetAreaOptions = {}): WorkspaceArea<AssetAreaState> {
  return {
    id: ASSETS_AREA_ID,
    descriptionKey: 'ui.area.assets.description',
    labelKey: 'ui.area.assets.label',
    hotkey: 'F3',
    icon: 'search',
    editableTypes: [{ id: 'visuals', descriptionKey: 'ui.editable.visuals.description' }],
    /**
     * Поиск по проекту (ED-24) в части ассетов: файл дерева контента по его
     * пути. Находка открывает ассет ровно тем же путём, что клик по строке
     * дерева, — вторым способом «выбрать ассет» она не является (ED-20).
     *
     * Каталоги в находки не попадают: добраться ED-24 требует до ассета, а
     * каталог — это место, а не то, что показывают в кадре.
     */
    search(input: AreaSearch<AssetAreaState>): readonly SearchHit[] {
      const { query, state, session, selection } = input;
      const found: SearchHit[] = [];
      for (const node of walkAssetNodes(state.tree.nodes)) {
        if (node.kind === 'directory' || !matchesQuery(query, node.path)) continue;
        found.push({
          id: node.path,
          label: documentValue(node.name),
          detail: documentValue(node.path),
          icon: 'search',
          reveal: () => {
            // Раскрытие узлов над находкой: иначе выбранное лежит в свёрнутом
            // каталоге, и «открыть напрямую» кончается пустым деревом.
            for (const parent of ancestorsOf(node.path)) state.expanded.add(parent);
            pick(state, session, node);
            selection.set([node.path]);
          },
        });
      }
      return found;
    },
    createState(setup): AssetAreaState {
      // Кадр собирается первым: его модуль ассетов и есть тот, у которого
      // просмотрщик спрашивает состояния (ASSET-2 — кэш один на ID). Модуль
      // приносит сборка (`assetStageFactory`) — она же подаёт его полем
      // `assets`, и только через него до просмотрщика доходит инвалидация
      // кэша; своим область обходится там, где сборки нет.
      const host = options.host;
      const build =
        options.stage ??
        ((environment: EnvironmentHost, hooks: AssetStageHooks) =>
          defaultStage(createAssetModule(environment), hooks));
      const stage =
        host === undefined
          ? null
          : build(host, {
              announce: () => {
                state.refresh();
              },
            });
      const state: AssetAreaState = {
        tree: EMPTY_ASSET_TREE,
        expanded: new Set<string>(),
        focusId: '',
        selected: null,
        entry: '',
        clip: '',
        skin: '',
        slot: '',
        effectTable: EVENTS_TABLE,
        effectBinding: '',
        effectName: '',
        effectType: '',
        animationEvent: '',
        effects: options.cameraEffects ?? CAMERA_EFFECTS_DESCRIPTION,
        sceneKind: options.sceneKind ?? DEFAULT_SCENE_KIND,
        stage,
        probe: createAssetProbe({
          assets: options.assets ?? stage?.context.assets ?? null,
          onChange: () => {
            state.refresh();
          },
        }),
        visualsId: null,
        failure: null,
        previewFailure: null,
        reopen: () => {
          start(state, setup, options);
        },
        refresh: () => undefined,
      };
      // Правка манифеста — откуда угодно, в том числе без интерфейса (ED-29):
      // кадр обязан показать её не позже следующего кадра (ED-15, REND-17).
      // Подписка одна на запись состояния, а не на открытие: переоткрытие
      // проекта меняет ДОКУМЕНТ, а не то, что за ним надо следить.
      setup.session.subscribe(() => {
        show(state, setup.session);
      });
      start(state, setup, options);
      return state;
    },
    render: (context) => areaFrame(context, { navigator, surface, inspector }),
  };
}

/** Область без открытого проекта: проект приносит оболочка (ED-12, W4-1). */
export const assetArea: WorkspaceArea<AssetAreaState> = createAssetArea();
