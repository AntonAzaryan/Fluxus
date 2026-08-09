/**
 * @contribution Рабочая область систем (ED-4, ED-5, ED-23) — вклад, а не часть
 * каркаса.
 *
 * ED-23 требует, чтобы объекты и системы были РАЗНЫМИ рабочими областями; ED-24
 * — чтобы скелет у всех областей был один. Отсюда устройство: тот же навигатор
 * — поверхность правки — инспектор, что у соседей, а своё в них только
 * содержимое.
 *
 * - **навигатор** — перечень JSON-систем конфига сцены (`systems`, SER-7,
 *   SYS-1): имя и место в тике. Строка есть ровно у того, что существует в
 *   документе;
 * - **поверхность правки** — раскрытый триггер тремя блоками ED-4: событие
 *   (`query` либо `forEachEvent`), условие (`cond` ветвления) и действия
 *   (список `do`). Ручного JSON на пути автора нет: блоки собираются из
 *   закрытых наборов ядра (`systemsBlocks.ts`), а вердикт по собранному выносит
 *   `validateSystem` находкой на записи системы (ED-8, правило `core.system`);
 * - **инспектор** — поля записи системы по опубликованной схеме формата (SER-5,
 *   `systemsDocuments.ts`), правит их общий инспектор каркаса зарегистрированной
 *   операцией (ED-29).
 *
 * ## Документ здесь тот же, что у области сцены
 *
 * Систем-документов в дереве нет: `systems` — поле конфига сцены. Сессия
 * открывает документ однажды (`isOpen` идемпотентен), история одна на сессию
 * (ED-18, ED-23), и правка системы отменяется из любой области.
 *
 * Записи перечня адресуются дескрипторами сессии (ED-29), поэтому конфиг обязан
 * быть открыт с отслеживаемым списком `['systems']`. Открыл его первым кто-то
 * другой и без списка — область говорит об этом причиной, а не показывает
 * пустой перечень: «список не отслеживают» и «систем нет» — разные утверждения.
 * Дописать список вторым открытием нельзя, поэтому сборка обязана открывать
 * конфиг сразу со всеми списками проекта.
 *
 * ## Чего область не делает
 *
 * Не прогоняет: превью (ED-9, ED-26) остаётся за областью сцены, и каркас сам
 * обходит области в поиске источника прогона (`frame.ts`, `previewSource`).
 * Не переставляет системы: место в тике задаёт поле `order` (SYS-2), а не
 * позиция в списке, — операции перестановки в наборе нет вовсе.
 */
import {
  isJsonObject,
  loadDslWorld,
  openDocumentFromHost,
  type ContentPath,
  type DocumentId,
  type DocumentKind,
  type DslWorldView,
  type EditorSession,
  type EnvironmentHost,
  type JsonPath,
  type JsonValue,
  type OperationParams,
} from '@game-mvp/editor-core';
import { children, documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import type {
  AreaContext,
  AreaKey,
  AreaKeyInput,
  AreaSearch,
  AreaSetup,
  AreaZones,
  WorkspaceArea,
} from '../frame/area.js';
import { FILL_CLASS, FILL_COLUMN_CLASS, SCROLL_CLASS } from '../frame/styles.js';
import { inspectorPanel, type InspectorSubject } from '../inspector/index.js';
import { matchesQuery, type SearchHit } from '../palette/palette.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { select, textField } from '../widgets/field.js';
import { denseList } from '../widgets/rows.js';
import { withValidation } from '../widgets/validation.js';
import {
  BRANCH_ACTION,
  COND_SLOT,
  DEFAULT_CONFIG_KIND,
  SYSTEM_LIST,
  THEN_SLOT,
  systemRecords,
  systemSubject,
  triggerOf,
  valueAt,
  type SystemRecord,
  type TriggerSource,
} from './systemsDocuments.js';
import { SYSTEM_OPERATIONS } from './systemsOperations.js';
import {
  BLOCK_ROW,
  actionListBlock,
  expressionBlock,
  queryBlock,
  type BlockEnvironment,
} from './systemsBlocks.js';

/** Идентификатор области. Один и тот же в реестре, рельсе и записи состояния. */
export const SYSTEMS_AREA_ID = 'area.systems';

/**
 * Вид редактируемого, который вносит эта область (ED-30). Он переживает то, что
 * систем-документов у этого проекта нет: правило `core.system` адресует по нему
 * систему, а проект вправе разложить системы отдельными документами.
 */
export const SYSTEM_DOCUMENT_KIND: DocumentKind = 'system';

/**
 * Отслеживаемый список конфига сцены, без которого область не работает: записи
 * перечня адресуются дескрипторами (ED-29). Экспортирован затем, чтобы сборка
 * открывала документ с ним ОДИН раз — вторым открытием сессия списка не
 * дописывает.
 */
export const SYSTEM_LISTS: readonly JsonPath[] = Object.freeze([SYSTEM_LIST]);

/** Три блока триггера ED-4: между ними и переключается раскладка области. */
export type TriggerBlock = 'event' | 'condition' | 'actions';

/**
 * Раскладка клавиш области (ED-32) — данные вклада. Перечень один: по нему
 * область и разбирает нажатия, и собирает подсказки своих элементов (ED-31).
 */
export const SYSTEMS_AREA_KEYS: readonly AreaKey[] = Object.freeze([
  { code: 'KeyE', labelKey: 'ui.area.systems.keyEvent' },
  { code: 'KeyD', labelKey: 'ui.area.systems.keyCondition' },
  { code: 'KeyA', labelKey: 'ui.area.systems.keyActions' },
]);

const BLOCK_BY_KEY: ReadonlyMap<string, TriggerBlock> = new Map([
  ['KeyE', 'event'],
  ['KeyD', 'condition'],
  ['KeyA', 'actions'],
]);

/** Источники срабатывания и подписи их выбора (ED-27): текста в коде нет. */
const SOURCE_LABELS: readonly (readonly [TriggerSource, string])[] = Object.freeze([
  ['tick', 'ui.area.systems.sourceTick'],
  ['query', 'ui.area.systems.sourceQuery'],
  ['event', 'ui.area.systems.sourceEvent'],
]);

/** Литералы узла события (`forEachEvent`): тип события и имя переменной (SYS-3). */
const EVENT_TYPE_SLOT = 'type';
const EVENT_AS_SLOT = 'as';

export interface SystemsAreaOptions {
  /** Хост среды (ED-12): чем читаются документы. Нет — проект не открыт. */
  readonly host?: EnvironmentHost;
  /** Конфиг сцены, если он известен заранее. */
  readonly config?: ContentPath;
  /**
   * Чем состав проекта СПРАШИВАЕТСЯ, когда он заранее не известен: его приносит
   * открытие (ED-12), и после переоткрытия он другой. `null` — открывать нечего.
   */
  readonly open?: () => Promise<ContentPath | null>;
  readonly configKind?: DocumentKind;
}

export interface SystemsAreaState {
  /** Конфиг сцены; `null` — проект не открыт (ED-12). */
  configId: DocumentId | null;
  /** Отслеживается ли перечень систем: без него записи не адресуются (ED-29). */
  tracked: boolean;
  /** Раскрытый блок триггера (ED-4) — им же ключуется полоса действий. */
  block: TriggerBlock;
  /** Строка навигатора под клавиатурным фокусом. */
  focusId: string;
  /** Имя новой системы: то, что автор набрал, но ещё не записал. */
  name: string;
  /** Черновики палитр блоков: место → выбранное, но ещё не поставленное имя. */
  readonly drafts: Record<string, string>;
  /** Почему сорвалось открытие или последнее действие автора (ED-8). */
  failure: string | null;
  reopen: () => void;
  refresh: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Мир для пикеров, посчитанный один раз на значение документа. Значения сессии
 * иммутабельны и меняются заменой ссылки, поэтому ключ по ссылке точен: правка
 * документа даёт другой объект и другой ответ. Без кэша мир поднимался бы на
 * каждую отрисовку блока.
 */
const worldCache = new WeakMap<object, DslWorldView | null>();

function worldOf(config: JsonValue | undefined): DslWorldView | null {
  if (!isJsonObject(config)) return null;
  const cached = worldCache.get(config);
  if (cached !== undefined) return cached;
  const found = loadDslWorld(config) ?? null;
  worldCache.set(config, found);
  return found;
}

function configValue(state: SystemsAreaState, session: EditorSession): JsonValue | undefined {
  const id = state.configId;
  return id === null || !session.isOpen(id) ? undefined : session.documentValue(id);
}

function systemsOf(state: SystemsAreaState, session: EditorSession): readonly SystemRecord[] {
  const id = state.configId;
  if (id === null || !session.isOpen(id)) return [];
  return systemRecords(session.documentValue(id), session.descriptors(id, SYSTEM_LIST));
}

/**
 * Открытие конфига сцены. Идемпотентно: тот же документ открывают области сцены
 * и объектов, и сессия открывает его однажды (ED-23). Отслеживаемый список при
 * этом дописать уже нельзя — поэтому и проверяется, отследил ли его тот, кто
 * открыл документ первым.
 */
function start(state: SystemsAreaState, setup: AreaSetup, options: SystemsAreaOptions): void {
  const host = options.host;
  if (host === undefined) return;
  const session = setup.session;
  const open =
    options.open ?? (options.config === undefined ? null : () => Promise.resolve(options.config ?? null));
  if (open === null) return;

  state.failure = null;
  void (async () => {
    try {
      const config = await open();
      if (config === null) return;
      if (!session.isOpen(config)) {
        await openDocumentFromHost(session, host.content, {
          id: config,
          kind: options.configKind ?? DEFAULT_CONFIG_KIND,
          lists: [...SYSTEM_LISTS],
        });
      }
      state.configId = config;
      state.tracked = session
        .document(config)
        .lists.some((list) => list.length === SYSTEM_LIST.length && list[0] === SYSTEM_LIST[0]);
    } catch (error) {
      state.failure = message(error);
    } finally {
      state.refresh();
    }
  })();
}

/**
 * Правка идёт операцией и только ей (ED-29); отказ — структурный (ED-30), и его
 * причина показывается, а не теряется в обработчике нажатия.
 */
function run(
  context: AreaContext<SystemsAreaState>,
  operationId: string,
  params: OperationParams,
): JsonValue | undefined {
  const { state, session } = context;
  try {
    const outcome = session.applyOperation(operationId, params);
    state.failure = null;
    return outcome.result;
  } catch (error) {
    state.failure = message(error);
    return undefined;
  } finally {
    context.refresh();
  }
}

/** Выбранная система; `null` — выбрано что-то другое либо ничего. */
function selectedSystem(context: AreaContext<SystemsAreaState>): SystemRecord | null {
  const chosen = context.selection.current()[0];
  if (chosen === undefined) return null;
  return systemsOf(context.state, context.session).find((record) => record.key === chosen) ?? null;
}

// ------------------------------------------------------------------ зоны

function navigator(context: AreaContext<SystemsAreaState>): UiNode {
  const { state, resources, selection, session } = context;
  return el('div', {
    children: children(
      el('div', {
        classes: ['fx-section'],
        text: resourceText(resources, 'ui.navigator.title'),
      }),
      // Проект не открыт — так и сказано (ED-12, решение 9). Пустой перечень на
      // этом месте означал бы «систем нет», то есть неправду.
      state.configId === null
        ? el('div', {
            classes: ['fx-row'],
            children: [
              withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.systems.noProject'),
                  tone: 'warning',
                }),
                state.failure === null
                  ? {
                      severity: 'warning',
                      reason: resourceText(resources, 'ui.area.systems.noProject'),
                    }
                  : { severity: 'error', reason: documentValue(state.failure) },
              ),
            ],
          })
        : undefined,
      state.configId !== null && !state.tracked
        ? el('div', {
            classes: ['fx-row'],
            children: [
              withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.systems.noList'),
                  tone: 'error',
                }),
                { severity: 'error', reason: resourceText(resources, 'ui.area.systems.noList') },
              ),
            ],
          })
        : undefined,
      state.configId === null
        ? undefined
        : denseList({
            label: resourceText(resources, 'ui.area.systems.label'),
            rovingId: 'systems-list',
            activeId: state.focusId,
            onActive: (id) => {
              state.focusId = id;
              context.refresh();
            },
            items: systemsOf(state, session).map((record) => ({
              id: record.key,
              label: documentValue(record.name),
              // Место в тике (SYS-2) — тоже содержимое документа, а не подпись.
              secondary: documentValue(record.order === null ? '' : String(record.order)),
              icon: 'graph' as const,
              selected: selection.has(record.key),
              onSelect: (id: string) => {
                state.focusId = id;
                selection.set([id]);
              },
            })),
          }),
    ),
  });
}

/** Полоса действий: завести систему, снять её и переключить источник (ED-4). */
function bar(context: AreaContext<SystemsAreaState>, record: SystemRecord | null): readonly UiNode[] {
  const { state, resources } = context;
  const off = context.mode === 'preview' || state.configId === null || !state.tracked;
  const trigger = triggerOf(record?.value);
  return [
    textField({
      label: resourceText(resources, 'ui.area.systems.systemName'),
      value: documentValue(state.name),
      readOnly: off,
      onCommit: (raw) => {
        state.name = raw;
        context.refresh();
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.systems.createSystem'),
      variant: 'ghost',
      disabled: off || state.name.trim() === '',
      onPress: () => {
        const created = run(context, SYSTEM_OPERATIONS.create, {
          document: state.configId ?? '',
          list: [...SYSTEM_LIST],
          name: state.name,
        });
        // Дескриптор дописанной записи — им она и выделяется (ED-17).
        if (typeof created === 'string') {
          context.selection.set([created]);
          state.focusId = created;
        }
        state.name = '';
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.systems.deleteSystem'),
      variant: 'ghost',
      disabled: off || record === null,
      onPress: () => {
        run(context, SYSTEM_OPERATIONS.remove, {
          document: state.configId ?? '',
          record: record?.key ?? '',
        });
        context.selection.set([]);
      },
    }),
    select({
      label: resourceText(resources, 'ui.area.systems.source'),
      value: trigger.source,
      options: SOURCE_LABELS.map(([id, key]) => ({
        value: id,
        label: resourceText(resources, key),
      })),
      disabled: off || record === null,
      onSelect: (next) => {
        if (next === trigger.source) return;
        run(context, SYSTEM_OPERATIONS.source, {
          document: state.configId ?? '',
          record: record?.key ?? '',
          source: next,
        });
      },
    }),
  ];
}

/** Среда блочного редактора: три способа правки, и все — операциями (ED-29). */
function blockEnvironment(
  context: AreaContext<SystemsAreaState>,
  record: SystemRecord,
): BlockEnvironment {
  const { state, session } = context;
  const document = state.configId ?? '';
  return {
    resources: context.resources,
    world: worldOf(configValue(state, session)),
    system: record.value,
    disabled: context.mode === 'preview' || state.configId === null || !state.tracked,
    drafts: state.drafts,
    set: (path, value) => {
      run(context, SYSTEM_OPERATIONS.setValue, {
        document,
        record: record.key,
        path: [...path],
        value,
      });
    },
    remove: (path) => {
      run(context, SYSTEM_OPERATIONS.removeValue, {
        document,
        record: record.key,
        path: [...path],
      });
    },
    append: (path, node) => {
      run(context, SYSTEM_OPERATIONS.append, {
        document,
        record: record.key,
        path: [...path],
        node,
      });
    },
    refresh: () => {
      context.refresh();
    },
  };
}

/** Блок «событие» (ED-4): запрос, тип события либо ничего у тика. */
function eventBlock(
  context: AreaContext<SystemsAreaState>,
  env: BlockEnvironment,
  record: SystemRecord,
): UiNode {
  const trigger = triggerOf(record.value);
  const { resources } = context;
  if (trigger.eventPath === null) {
    return el('div', {
      classes: ['fx-row'],
      text: resourceText(resources, 'ui.area.systems.sourceTick'),
    });
  }
  if (trigger.source === 'query') {
    return queryBlock(env, trigger.eventPath, valueAt(record.value, trigger.eventPath) ?? {});
  }
  const args = valueAt(record.value, trigger.eventPath);
  const literals = isJsonObject(args) ? args : {};
  return el('div', {
    classes: ['fx-stack'],
    children: [EVENT_TYPE_SLOT, EVENT_AS_SLOT].map((slot) =>
      el('div', {
        classes: ['fx-row', BLOCK_ROW],
        attrs: { 'data-slot': slot },
        children: [
          textField({
            label: documentValue(slot),
            value: documentValue(typeof literals[slot] === 'string' ? String(literals[slot]) : ''),
            readOnly: env.disabled,
            onCommit: (raw) => {
              env.set([...(trigger.eventPath ?? []), slot], raw);
            },
          }),
        ],
      }),
    ),
  });
}

/** Блок «условие» (ED-4): `cond` первого ветвления тела либо предложение завести его. */
function conditionBlock(
  context: AreaContext<SystemsAreaState>,
  env: BlockEnvironment,
  record: SystemRecord,
): UiNode {
  const trigger = triggerOf(record.value);
  if (trigger.conditionPath !== null) {
    return expressionBlock(env, trigger.conditionPath, valueAt(record.value, trigger.conditionPath) ?? null);
  }
  return el('div', {
    classes: ['fx-row', BLOCK_ROW],
    children: [
      button({
        label: resourceText(context.resources, 'ui.area.systems.addCondition'),
        variant: 'ghost',
        disabled: env.disabled,
        onPress: () => {
          // Ветвление — такое же действие тела (ACT-1): оно дописывается в
          // конец, а не подменяет собой тело. Что положить под условие, решает
          // автор — переносить туда уже собранное за него редактор не вправе.
          env.append(trigger.bodyPath, {
            [BRANCH_ACTION]: { [COND_SLOT]: 0, [THEN_SLOT]: [] },
          });
        },
      }),
    ],
  });
}

/** Блок «действия» (ED-4): тело триггера списком блоков и палитра под ним. */
function actionsBlock(env: BlockEnvironment, record: SystemRecord): UiNode {
  const trigger = triggerOf(record.value);
  return actionListBlock(env, trigger.actionsPath, valueAt(record.value, trigger.actionsPath) ?? []);
}

function section(context: AreaContext<SystemsAreaState>, block: TriggerBlock, labelKey: string, body: UiNode): UiNode {
  return el('div', {
    classes: ['fx-stack', ...(context.state.block === block ? ['fx-is-selected'] : [])],
    attrs: { 'data-block': block },
    children: [
      el('div', { classes: ['fx-section'], text: resourceText(context.resources, labelKey) }),
      body,
    ],
  });
}

function surface(context: AreaContext<SystemsAreaState>): UiNode {
  const { state, resources } = context;
  const record = selectedSystem(context);
  return el('div', {
    classes: [FILL_CLASS, FILL_COLUMN_CLASS],
    attrs: { 'data-block': state.block },
    children: children(
      el('div', {
        classes: ['fx-bar'],
        children: children(
          ...bar(context, record),
          state.failure === null
            ? undefined
            : withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.systems.broken'),
                  tone: 'error',
                }),
                { severity: 'error', reason: documentValue(state.failure) },
              ),
        ),
      }),
      el('div', {
        classes: [SCROLL_CLASS, 'fx-stack'],
        children:
          record === null
            ? [el('div', { classes: ['fx-row'], text: resourceText(resources, 'ui.inspector.empty') })]
            : (() => {
                const env = blockEnvironment(context, record);
                return [
                  section(context, 'event', 'ui.area.systems.event', eventBlock(context, env, record)),
                  section(
                    context,
                    'condition',
                    'ui.area.systems.condition',
                    conditionBlock(context, env, record),
                  ),
                  section(context, 'actions', 'ui.area.systems.actions', actionsBlock(env, record)),
                ];
              })(),
      }),
    ),
  });
}

/** Что показывает инспектор при текущем выделении (ED-24). */
function subjectOf(context: AreaContext<SystemsAreaState>): InspectorSubject | null {
  const documentId = context.state.configId;
  const record = selectedSystem(context);
  return documentId === null || record === null ? null : systemSubject(documentId, record);
}

function inspector(context: AreaContext<SystemsAreaState>): UiNode {
  const { state } = context;
  return inspectorPanel({
    resources: context.resources,
    session: context.session,
    fieldEditors: context.fieldEditors,
    subject: subjectOf(context),
    disabled: context.mode === 'preview',
    onFailure: (reason) => {
      state.failure = reason;
      context.refresh();
    },
  });
}

/**
 * Клавиша области (ED-32). Порядок разбора держит каркас: сюда нажатие доходит,
 * только если сквозные сочетания его не забрали, фокус не в поле ввода и виджет
 * под фокусом его не потребил. Своего порядка область не заводит — только
 * раскладку (`SYSTEMS_AREA_KEYS`) и то, что она значит.
 */
function handleSystemsKey(input: AreaKeyInput<SystemsAreaState>): boolean {
  if (input.phase !== 'down' || input.repeat) return false;
  const block = BLOCK_BY_KEY.get(input.code);
  if (block === undefined) return false;
  input.state.block = block;
  input.state.refresh();
  return true;
}

export function createSystemsArea(options: SystemsAreaOptions = {}): WorkspaceArea<SystemsAreaState> {
  return {
    id: SYSTEMS_AREA_ID,
    descriptionKey: 'ui.area.systems.description',
    labelKey: 'ui.area.systems.label',
    hotkey: 'F2',
    icon: 'graph',
    keys: SYSTEMS_AREA_KEYS,
    handleKey: handleSystemsKey,
    // Вид редактируемого, который вносит область (ED-30). Он один: конфиг сцены
    // несёт системы своим полем, а отдельного документа-системы у проекта нет.
    editableTypes: [{ id: SYSTEM_DOCUMENT_KIND, descriptionKey: 'ui.editable.system.description' }],
    /**
     * Поиск по проекту (ED-24): системы по имени. Находка выделяет найденное —
     * то же состояние, в котором автор оказался бы, пройдя навигатор.
     */
    search(input: AreaSearch<SystemsAreaState>): readonly SearchHit[] {
      const { query, state, session, selection } = input;
      if (state.configId === null) return [];
      const found: SearchHit[] = [];
      for (const record of systemsOf(state, session)) {
        if (!matchesQuery(query, record.name)) continue;
        found.push({
          id: record.key,
          label: documentValue(record.name),
          detail: documentValue(state.configId),
          icon: 'graph',
          reveal: () => {
            state.focusId = record.key;
            selection.set([record.key]);
          },
        });
      }
      return found;
    },
    createState(setup): SystemsAreaState {
      const state: SystemsAreaState = {
        configId: null,
        tracked: false,
        block: 'actions',
        focusId: '',
        name: '',
        drafts: {},
        failure: null,
        reopen: () => {
          start(state, setup, options);
        },
        refresh: () => undefined,
      };
      start(state, setup, options);
      return state;
    },
    render(context): AreaZones {
      const { state } = context;
      // Просьба перерисовать нужна асинхронному: открытие документа кончается
      // после того, как страница уже собрана (ED-12).
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

/** Область без открытого проекта: проект приносит сборка (ED-12, решение 9). */
export const systemsArea: WorkspaceArea<SystemsAreaState> = createSystemsArea();
