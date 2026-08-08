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
 */
import {
  createHostAssetSource,
  openDocumentFromHost,
  type ContentPath,
  type DocumentId,
  type DocumentKind,
  type EditorSession,
  type EnvironmentHost,
} from '@game-mvp/editor-core';
import type { EntityVisual } from '@game-mvp/assets';
import {
  children,
  documentValue,
  el,
  resourceText,
  type UiNode,
  type UiText,
} from '../dom/node.js';
import type { AreaContext, AreaSetup, AreaZones, WorkspaceArea } from '../frame/area.js';
import { FILL_CLASS, FILL_COLUMN_CLASS } from '../frame/styles.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { select, textField } from '../widgets/field.js';
import { fieldTable, type FieldRowSpec } from '../widgets/fieldTable.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { withValidation } from '../widgets/validation.js';
import { viewportFrame } from '../viewport.js';
import {
  EMPTY_ASSET_TREE,
  findAssetNode,
  loadAssetTree,
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
} from './assetVisuals.js';
import {
  canRender,
  createSceneStage,
  type SceneStage,
  type SceneStageOptions,
} from './sceneStage.js';

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
export const DEFAULT_VISUALS_KIND: DocumentKind = 'visuals';

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
  readonly visualsKind?: DocumentKind;
  /** Корень обхода дерева; по умолчанию — весь корень (ED-20: навигация по дереву). */
  readonly root?: ContentPath;
  /**
   * Чем собирается кадр превью. Подменяется тестом на структурный дубль: WebGL в
   * headless-прогоне нет, а проверять, ЧТО просмотрщик отдаёт рендеру, надо.
   */
  readonly stage?: AssetStageFactory;
  /**
   * Чем спрашивается состояние ассета (ASSET-4); по умолчанию — сервис самого
   * кадра. Второго сервиса не заводится: кэш один на ID (ASSET-2).
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
  refresh: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Чем собирается кадр превью. Отдельно от самой сборки, потому что проверяемо
 * без WebGL ровно это: «набор из одного инстанса без сцены и террейна» (REND-11)
 * начинается с того, что кадр поднимается без террейна.
 */
export function assetStageOptions(
  host: EnvironmentHost,
  hooks: AssetStageHooks,
): SceneStageOptions {
  return {
    hostId: ASSETS_VIEWPORT_ID,
    // Тот же шов к дереву, через который читаются документы (ASSET-2, ED-12).
    assets: createHostAssetSource(host.content),
    // Записей ещё нет: первую принесёт переподача манифеста (REND-17).
    visuals: previewManifest(null),
    // Вырожденный случай REND-11: ни сцены, ни террейна не будет никогда.
    terrain: false,
    onChange: hooks.announce,
  };
}

/** Кадр превью по умолчанию: тот же рендер, что вьюпорт (ED-1), без террейна. */
function defaultStage(host: EnvironmentHost, hooks: AssetStageHooks): SceneStage | null {
  return canRender() ? createSceneStage(assetStageOptions(host, hooks)) : null;
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
    state.previewFailure = message(error);
  }
  stage.applyVisuals(previewManifest(entry));
  stage.submit(previewDraft(entry, { clip: state.clip, skin: state.skin }));
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
  params: Readonly<Record<string, string>>,
): void {
  const { state, session } = context;
  const id = state.visualsId;
  if (id === null) return;
  try {
    session.applyOperation(operationId, { document: id, entry: state.entry, ...params });
    state.failure = null;
  } catch (error) {
    state.failure = message(error);
  }
  state.refresh();
}

/**
 * Открытие манифеста и дерева. Оба асинхронны и оба падают по-своему: манифеста
 * может не быть в проекте, перечисления — в среде (ED-12). Ни то, ни другое не
 * должно уносить область: каждая половина ловит своё и называет причину.
 */
function start(state: AssetAreaState, setup: AreaSetup, options: AssetAreaOptions): void {
  const host = options.host;
  if (host === undefined) return;
  const session = setup.session;

  const openVisuals = async (): Promise<void> => {
    const id = options.visuals;
    if (id === undefined) return;
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
    // назначения, а выбирать автору пока не из чего.
    state.entry = entryNames(session.documentValue(id))[0] ?? '';
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
      state.failure = message(error);
    }
  };

  void Promise.all([guard(openVisuals()), guard(readTree())]).then(() => {
    show(state, session);
    state.refresh();
  });

  // Правка манифеста — откуда угодно, в том числе без интерфейса (ED-29):
  // кадр обязан показать её не позже следующего кадра (ED-15, REND-17).
  session.subscribe(() => {
    show(state, session);
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
      el('div', {
        classes: ['fx-section'],
        text: resourceText(resources, 'ui.navigator.title'),
      }),
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

  return [
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

/** Состояние ассета подписью: статус — ресурс, причина — текст модуля ассетов. */
const STATUS_KEYS: Readonly<Record<OpenedAsset['status'], string>> = {
  loading: 'ui.area.assets.statusLoading',
  ready: 'ui.area.assets.statusReady',
  failed: 'ui.area.assets.statusFailed',
};

function inspector(context: AreaContext<AssetAreaState>): UiNode {
  const { state, resources, session } = context;
  const opened = state.selected === null ? undefined : state.probe.stateOf(state.selected);
  const record = safeRecord(state, session);

  const readOnly = (labelKey: string, value: string): FieldRowSpec => ({
    label: resourceText(resources, labelKey),
    control: textField({
      label: resourceText(resources, labelKey),
      value: documentValue(value),
      readOnly: true,
    }),
  });

  const rows: FieldRowSpec[] = [];
  if (state.selected !== null) {
    rows.push(readOnly('ui.area.assets.field.path', state.selected));
    if (opened !== undefined) {
      rows.push({
        label: resourceText(resources, 'ui.area.assets.field.status'),
        control: textField({
          label: resourceText(resources, 'ui.area.assets.field.status'),
          value: resourceText(resources, STATUS_KEYS[opened.status]),
          readOnly: true,
          ...(opened.status === 'failed'
            ? {
                validation: {
                  severity: 'error' as const,
                  reason: assetReason(context, opened),
                },
              }
            : {}),
        }),
      });
    }
  }
  if (record !== null) {
    rows.push(readOnly('ui.area.assets.field.model', record.model));
    if (record.defaultSkin !== undefined) {
      rows.push(readOnly('ui.area.assets.field.defaultSkin', record.defaultSkin));
    }
  }

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

export function createAssetArea(options: AssetAreaOptions = {}): WorkspaceArea<AssetAreaState> {
  return {
    id: ASSETS_AREA_ID,
    descriptionKey: 'ui.area.assets.description',
    labelKey: 'ui.area.assets.label',
    hotkey: 'F3',
    icon: 'search',
    editableTypes: [{ id: 'visuals', descriptionKey: 'ui.editable.visuals.description' }],
    createState(setup): AssetAreaState {
      // Кадр собирается первым: его сервис ассетов и есть тот, у которого
      // просмотрщик спрашивает состояния (ASSET-2 — кэш один на ID).
      const stage =
        options.host === undefined
          ? null
          : (options.stage ?? defaultStage)(options.host, {
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
        refresh: () => undefined,
      };
      start(state, setup, options);
      return state;
    },
    render(context): AreaZones {
      const { state } = context;
      // Просьба перерисовать нужна асинхронному: обход дерева и загрузка ассета
      // заканчиваются после того, как страница уже собрана (ASSET-4).
      state.refresh = () => {
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
export const assetArea: WorkspaceArea<AssetAreaState> = createAssetArea();
