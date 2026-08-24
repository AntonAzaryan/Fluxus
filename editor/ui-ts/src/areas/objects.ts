/* eslint-disable max-lines -- baseline */
/**
 * @contribution Рабочая область объектов (ED-7, ED-6, ED-19, ED-23) — вклад, а
 * не часть каркаса.
 *
 * ED-23 требует, чтобы объекты и системы были РАЗНЫМИ рабочими областями;
 * ED-24 — чтобы скелет у всех областей был один. Отсюда устройство: тот же
 * навигатор — поверхность правки — инспектор, что у соседей, а своё в них
 * только содержимое.
 *
 * - **навигатор** — два раздела одного документа: схемы компонентов (`components`,
 *   SER-7) и prefab'ы (`prefabs`, ECS-4). Строка есть ровно у того, что
 *   существует в документе, плюс отдельной ветвью — схемы, которые синтезирует
 *   загрузчик (дельта ED-6): они показаны производными и не правятся;
 * - **поверхность правки** — состав выбранного: поля схемы либо компоненты
 *   prefab'а, — и полоса действий над ним. Кадра здесь нет: объект описывается,
 *   а не размещается, и его размещение — область сцены (ED-19: описание вида и
 *   его размещение — разные сущности документа);
 * - **инспектор** — значения выбранного по схемам (ED-24): состав приносят
 *   `objectsSchemas.ts` и `objectsPrefabs.ts`, читая опубликованные схемы
 *   формата (SER-5) и схемы компонентов сцены (ECS-3), а правит их общий
 *   инспектор каркаса зарегистрированной операцией (ED-29).
 *
 * ## Почему схемы живут здесь, а не в третьей области
 *
 * ED-23 называет разными областями объекты и системы; про схемы он не говорит
 * ничего. Схемы — тот же документ и тот же материал: prefab есть набор
 * компонентов с начальными значениями, и чтобы показать значение поля его
 * типом, нужна схема компонента. Третья область разложила бы один документ по
 * двум областям и заставила бы автора прыгать между ними, чтобы задать
 * начальное значение поля, которое он только что завёл.
 *
 * ## Документ здесь тот же, что у области сцены
 *
 * Конфиг сцены один, и сессия открывает его однажды (`isOpen` идемпотентен):
 * правка prefab'а видна во вьюпорте соседней области не позже следующего кадра
 * (ED-15), а undo снимает её из любой области — история одна на сессию (ED-18,
 * ED-23).
 *
 * Записи обоих перечней адресуются дескрипторами сессии (ED-29): индекс ломается
 * от удаления соседа, и выделение уехало бы на чужую строку. Отсюда требование к
 * открытию: конфиг открывается с отслеживаемыми списками `['components']` и
 * `['prefabs']`. Открыл его первым кто-то другой и без них — область говорит об
 * этом причиной, а не показывает пустые разделы: «списков не отслеживают» и
 * «объектов нет» — разные утверждения.
 */
import {
  openDocumentFromHost,
  type ContentPath,
  type DocumentId,
  type DocumentKind,
  type EditorSession,
  type EnvironmentHost,
  type JsonPath,
  type JsonValue,
  type OperationParams,
} from '@fluxus/editor-core';
import {
  children,
  documentValue,
  el,
  resourceText,
  type UiNode,
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
import { FILL_CLASS, FILL_COLUMN_CLASS, SCROLL_CLASS } from '../frame/styles.js';
import { inspectorPanel, type InspectorSubject } from '../inspector/index.js';
import { matchesQuery, type SearchHit } from '../palette/palette.js';
import { button } from '../widgets/button.js';
import { statusChip } from '../widgets/chip.js';
import { select, textField } from '../widgets/field.js';
import { tree, type TreeItem } from '../widgets/rows.js';
import { withValidation } from '../widgets/validation.js';
import {
  COMPONENT_LIST,
  SCHEMA_OPERATIONS,
  componentRecords,
  componentSubject,
  declaredComponentNames,
  derivedComponentFields,
  derivedComponentSubject,
  derivedComponents,
  fieldTypeNames,
  type ComponentRecord,
} from './objectsSchemas.js';
import {
  PREFAB_COMPOSITION_OPERATIONS,
  PREFAB_COMPONENTS_KEY,
  PREFAB_LIST,
  prefabRecords,
  prefabSubject,
  type PrefabRecord,
} from './objectsPrefabs.js';
import {
  PAIR_OPERATIONS,
  prefabReferences,
  type PrefabReferenceSite,
} from './objectsOperations.js';

/** Идентификатор области. Один и тот же в реестре, рельсе и записи состояния. */
export const OBJECTS_AREA_ID = 'area.objects';

/**
 * Отслеживаемые списки конфига сцены, без которых область не работает: записи
 * обоих перечней адресуются дескрипторами (ED-29). Экспортированы затем, чтобы
 * сборка открывала документ с ними ОДИН раз — вторым открытием сессия не
 * позволит их дописать, и второй список путей у неё не заведётся.
 */
export const OBJECT_LISTS: readonly JsonPath[] = Object.freeze([COMPONENT_LIST, PREFAB_LIST]);

/** Вид конфига сцены (SER-7). Вид принадлежит документу, а не области. */
export const DEFAULT_CONFIG_KIND: DocumentKind = 'scene';

/** Вид манифеста визуалов (ASSET-6) — вторая половина пары ED-19. */
export const DEFAULT_VISUALS_KIND: DocumentKind = 'visuals';

/** Действие DSL, чей аргумент называет prefab (ACT-1) — адрес ссылки, не правило. */
export const SPAWN_ACTION = 'spawnEntity';

/** Ключ ссылки на prefab: и у записи расстановки (SER-8), и у действия (ACT-1). */
const PREFAB_REFERENCE_KEY = 'prefab';

/** Раздел навигатора: у области их два, и переключение между ними — её клавиши. */
export type ObjectsSection = 'components' | 'prefabs';

/** Узлы навигатора, которые область раскрывает и сворачивает. */
export const OBJECT_NODES: Readonly<Record<ObjectsSection | 'derived', string>> = Object.freeze({
  components: 'objects:components',
  prefabs: 'objects:prefabs',
  derived: 'objects:derived',
});

/**
 * Раскладка клавиш области (ED-32) — данные вклада. Перечень один: по нему
 * область и разбирает нажатия, и собирает подсказки своих элементов (ED-31).
 */
export const OBJECTS_AREA_KEYS: readonly AreaKey[] = Object.freeze([
  { code: 'KeyC', labelKey: 'ui.area.objects.keyComponents' },
  { code: 'KeyP', labelKey: 'ui.area.objects.keyPrefabs' },
]);

const SECTION_BY_KEY: ReadonlyMap<string, ObjectsSection> = new Map([
  ['KeyC', 'components'],
  ['KeyP', 'prefabs'],
]);

/** Какие документы область правит: конфиг сцены и манифест его визуалов. */
export interface ObjectsProjectIds {
  readonly config: ContentPath;
  readonly visuals: ContentPath;
}

export interface ObjectsAreaOptions {
  /** Хост среды (ED-12): чем читаются документы. Нет — проект не открыт. */
  readonly host?: EnvironmentHost;
  /** Документы проекта, если они известны заранее. */
  readonly ids?: ObjectsProjectIds;
  /**
   * Чем состав проекта СПРАШИВАЕТСЯ, когда он заранее не известен: его приносит
   * открытие (ED-12), и после переоткрытия он другой. `null` — открывать нечего.
   */
  readonly open?: () => Promise<ObjectsProjectIds | null>;
  readonly configKind?: DocumentKind;
  readonly visualsKind?: DocumentKind;
  /**
   * Где лежат ссылки на имя prefab'а (решение 7а). Раскладку проекта знает тот,
   * кто собирает редактор (ED-25); умолчание — раскладка конфига сцены, у
   * которого и расстановка (SER-8), и системы (SYS-1) лежат его же полями.
   */
  readonly references?: (ids: ObjectsProjectIds) => readonly PrefabReferenceSite[];
}

/** Умолчание адресов ссылок: оба места лежат полями конфига сцены. */
export function defaultPrefabReferences(ids: ObjectsProjectIds): readonly PrefabReferenceSite[] {
  return Object.freeze([
    { document: ids.config, list: ['initial'], field: PREFAB_REFERENCE_KEY },
    {
      document: ids.config,
      list: ['systems'],
      field: PREFAB_REFERENCE_KEY,
      action: SPAWN_ACTION,
    },
  ]);
}

/** Черновики форм: то, что автор набрал, но ещё не записал в документ. */
interface ObjectsDrafts {
  component: string;
  field: string;
  fieldType: string;
  prefab: string;
  model: string;
  rename: string;
  prefabComponent: string;
}

export interface ObjectsAreaState {
  /** Конфиг сцены; `null` — проект не открыт (ED-12). */
  configId: DocumentId | null;
  /** Манифест визуалов — вторая половина пары ED-19; `null` — не открыт. */
  visualsId: DocumentId | null;
  /** Отслеживаются ли оба перечня: без них записи не адресуются (ED-29). */
  tracked: boolean;
  section: ObjectsSection;
  readonly expanded: Set<string>;
  focusId: string;
  readonly drafts: ObjectsDrafts;
  /** Адреса ссылок на имя prefab'а — их приносит сборка (решение 7а). */
  references: readonly PrefabReferenceSite[];
  /** Почему сорвалось открытие или последнее действие автора (ED-8). */
  failure: string | null;
  reopen: () => void;
  refresh: () => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Ключ выделения производной схемы: записи в документе у неё нет (ECS-5). */
export function derivedKey(name: string): string {
  return `${OBJECT_NODES.derived}:${name}`;
}

function derivedNameOf(key: string): string | null {
  const prefix = `${OBJECT_NODES.derived}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

function configValue(state: ObjectsAreaState, session: EditorSession): JsonValue | undefined {
  const id = state.configId;
  return id === null || !session.isOpen(id) ? undefined : session.documentValue(id);
}

function componentsOf(state: ObjectsAreaState, session: EditorSession): readonly ComponentRecord[] {
  const id = state.configId;
  if (id === null || !session.isOpen(id)) return [];
  return componentRecords(session.documentValue(id), session.descriptors(id, COMPONENT_LIST));
}

function prefabsOf(state: ObjectsAreaState, session: EditorSession): readonly PrefabRecord[] {
  const id = state.configId;
  if (id === null || !session.isOpen(id)) return [];
  return prefabRecords(session.documentValue(id), session.descriptors(id, PREFAB_LIST));
}

/**
 * Открытие документов проекта. Оба открываются идемпотентно: тот же конфиг
 * открывает область сцены, документ у них один, и сессия открывает его однажды
 * (ED-23). Отслеживаемые списки при этом дописать уже нельзя — поэтому и
 * проверяется, отследил ли их тот, кто открыл документ первым.
 */
function start(state: ObjectsAreaState, setup: AreaSetup, options: ObjectsAreaOptions): void {
  const host = options.host;
  if (host === undefined) return;
  const session = setup.session;
  const open =
    options.open ??
    (options.ids === undefined ? null : () => Promise.resolve(options.ids ?? null));
  if (open === null) return;

  state.failure = null;
  void (async () => {
    try {
      const ids = await open();
      if (ids === null) return;
      if (!session.isOpen(ids.config)) {
        await openDocumentFromHost(session, host.content, {
          id: ids.config,
          kind: options.configKind ?? DEFAULT_CONFIG_KIND,
          lists: [...OBJECT_LISTS],
        });
      }
      if (!session.isOpen(ids.visuals)) {
        await openDocumentFromHost(session, host.content, {
          id: ids.visuals,
          kind: options.visualsKind ?? DEFAULT_VISUALS_KIND,
        });
      }
      state.configId = ids.config;
      state.visualsId = ids.visuals;
      state.references = (options.references ?? defaultPrefabReferences)(ids);
      const opened = session.document(ids.config).lists;
      state.tracked = OBJECT_LISTS.every((list) =>
        opened.some((tracked) => tracked.length === list.length && tracked[0] === list[0]),
      );
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
function run(context: AreaContext<ObjectsAreaState>, operationId: string, params: OperationParams): JsonValue | undefined {
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

// ------------------------------------------------------------------ зоны

function componentItems(context: AreaContext<ObjectsAreaState>): readonly TreeItem[] {
  const { state, selection, session } = context;
  return componentsOf(state, session).map((record) => ({
    id: record.key,
    label: documentValue(record.name),
    selected: selection.has(record.key),
    onSelect: () => {
      state.section = 'components';
      state.focusId = record.key;
      selection.set([record.key]);
    },
  }));
}

function derivedItems(context: AreaContext<ObjectsAreaState>): readonly TreeItem[] {
  const { state, selection, session } = context;
  const found = derivedComponents(configValue(state, session));
  return found.names.map((name) => {
    const key = derivedKey(name);
    return {
      id: key,
      label: documentValue(name),
      selected: selection.has(key),
      onSelect: () => {
        state.section = 'components';
        state.focusId = key;
        selection.set([key]);
      },
    };
  });
}

function prefabItems(context: AreaContext<ObjectsAreaState>): readonly TreeItem[] {
  const { state, selection, session } = context;
  return prefabsOf(state, session).map((record) => ({
    id: record.key,
    label: documentValue(record.name),
    selected: selection.has(record.key),
    onSelect: () => {
      state.section = 'prefabs';
      state.focusId = record.key;
      selection.set([record.key]);
    },
  }));
}

function sectionItem(
  context: AreaContext<ObjectsAreaState>,
  id: string,
  labelKey: string,
  items: readonly TreeItem[],
  section: ObjectsSection,
): TreeItem {
  const { state } = context;
  return {
    id,
    label: resourceText(context.resources, labelKey),
    expanded: state.expanded.has(id),
    items,
    onToggle: () => {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      state.section = section;
      context.refresh();
    },
    onSelect: () => {
      state.section = section;
      state.focusId = id;
      context.refresh();
    },
  };
}

function navigator(context: AreaContext<ObjectsAreaState>): UiNode {
  const { state, resources } = context;
  const derived = derivedItems(context);
  return el('div', {
    children: children(
      el('div', {
        classes: ['fx-section'],
        text: resourceText(resources, 'ui.navigator.title'),
      }),
      // Проект не открыт — так и сказано (ED-12, решение 9). Пустые разделы на
      // этом месте означали бы «объектов нет», то есть неправду.
      state.configId === null
        ? el('div', {
            classes: ['fx-row'],
            children: [
              withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.objects.noProject'),
                  tone: 'warning',
                }),
                state.failure === null
                  ? { severity: 'warning', reason: resourceText(resources, 'ui.area.objects.noProject') }
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
                  label: resourceText(resources, 'ui.area.objects.noLists'),
                  tone: 'error',
                }),
                { severity: 'error', reason: resourceText(resources, 'ui.area.objects.noLists') },
              ),
            ],
          })
        : undefined,
      state.configId === null
        ? undefined
        : tree({
            label: resourceText(resources, 'ui.area.objects.label'),
            rovingId: 'objects-tree',
            activeId: state.focusId,
            onActive: (id) => {
              state.focusId = id;
              context.refresh();
            },
            items: [
              {
                ...sectionItem(
                  context,
                  OBJECT_NODES.components,
                  'ui.area.objects.components',
                  componentItems(context),
                  'components',
                ),
                // Производные схемы — отдельной ветвью того же раздела: они
                // часть состава мира, но не часть документа (дельта ED-6).
                ...(derived.length === 0
                  ? {}
                  : {
                      items: [
                        ...componentItems(context),
                        {
                          id: OBJECT_NODES.derived,
                          label: resourceText(resources, 'ui.area.objects.derived'),
                          expanded: state.expanded.has(OBJECT_NODES.derived),
                          items: derived,
                          onToggle: () => {
                            if (state.expanded.has(OBJECT_NODES.derived)) {
                              state.expanded.delete(OBJECT_NODES.derived);
                            } else state.expanded.add(OBJECT_NODES.derived);
                            context.refresh();
                          },
                        },
                      ],
                    }),
              },
              sectionItem(
                context,
                OBJECT_NODES.prefabs,
                'ui.area.objects.prefabs',
                prefabItems(context),
                'prefabs',
              ),
            ],
          }),
    ),
  });
}

/** Выбранная запись схемы; `null` — выбрано что-то другое либо ничего. */
function selectedComponent(context: AreaContext<ObjectsAreaState>): ComponentRecord | null {
  const chosen = context.selection.current()[0];
  if (chosen === undefined) return null;
  return componentsOf(context.state, context.session).find((record) => record.key === chosen) ?? null;
}

function selectedPrefab(context: AreaContext<ObjectsAreaState>): PrefabRecord | null {
  const chosen = context.selection.current()[0];
  if (chosen === undefined) return null;
  return prefabsOf(context.state, context.session).find((record) => record.key === chosen) ?? null;
}

function selectedDerived(context: AreaContext<ObjectsAreaState>): string | null {
  const chosen = context.selection.current()[0];
  return chosen === undefined ? null : derivedNameOf(chosen);
}

/** Одна строка состава: имя, пометка и кнопка снятия. */
function compositionRow(
  context: AreaContext<ObjectsAreaState>,
  id: string,
  name: string,
  note: string,
  remove: (() => void) | null,
): UiNode {
  const { resources } = context;
  return el('div', {
    classes: ['fx-row'],
    attrs: { 'data-part': id },
    children: children(
      el('span', { classes: ['fx-row__label'], text: documentValue(name) }),
      el('span', { classes: ['fx-row__secondary'], text: documentValue(note) }),
      remove === null
        ? undefined
        : button({
            label: resourceText(resources, 'ui.action.remove'),
            variant: 'ghost',
            disabled: context.mode === 'preview',
            onPress: remove,
          }),
    ),
  });
}

/** Полоса действий раздела схем: завести компонент и дописать поле в состав. */
function schemaBar(context: AreaContext<ObjectsAreaState>): readonly UiNode[] {
  const { state, resources } = context;
  const off = context.mode === 'preview' || state.configId === null || !state.tracked;
  const record = selectedComponent(context);
  const types = fieldTypeNames();
  return [
    textField({
      label: resourceText(resources, 'ui.area.objects.componentName'),
      value: documentValue(state.drafts.component),
      readOnly: off,
      onCommit: (raw) => {
        state.drafts.component = raw;
        context.refresh();
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.objects.createComponent'),
      variant: 'ghost',
      disabled: off || state.drafts.component.trim() === '',
      onPress: () => {
        run(context, SCHEMA_OPERATIONS.create, {
          document: state.configId ?? '',
          list: [...COMPONENT_LIST],
          name: state.drafts.component,
        });
        state.drafts.component = '';
      },
    }),
    textField({
      label: resourceText(resources, 'ui.area.objects.fieldName'),
      value: documentValue(state.drafts.field),
      readOnly: off || record === null,
      onCommit: (raw) => {
        state.drafts.field = raw;
        context.refresh();
      },
    }),
    select({
      label: resourceText(resources, 'ui.area.objects.fieldType'),
      value: state.drafts.fieldType,
      options: types.map((type) => ({ value: type, label: documentValue(type) })),
      disabled: off || record === null,
      onSelect: (next) => {
        state.drafts.fieldType = next;
        context.refresh();
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.objects.addField'),
      variant: 'ghost',
      disabled: off || record === null || state.drafts.field.trim() === '',
      onPress: () => {
        run(context, SCHEMA_OPERATIONS.addField, {
          document: state.configId ?? '',
          record: record?.key ?? '',
          field: state.drafts.field,
          type: state.drafts.fieldType,
        });
        state.drafts.field = '';
      },
    }),
    button({
      // Снятие схемы — базовая операция над записью списка (ED-30): порядок
      // оставшихся схем при этом не переставляется, а битовые id за снятой
      // сдвигаются потому, что автор её снял, — это правка, а не побочный
      // эффект чужой правки (дельта ED-6). Повисшие на ней prefab'ы и системы
      // покажет валидация (ED-8), а не отказ операции.
      label: resourceText(resources, 'ui.area.objects.deleteComponent'),
      variant: 'ghost',
      disabled: off || record === null,
      onPress: () => {
        run(context, SCHEMA_OPERATIONS.remove, {
          document: state.configId ?? '',
          record: record?.key ?? '',
        });
        context.selection.set([]);
      },
    }),
  ];
}

/**
 * Полоса действий раздела prefab'ов: пара ED-19 целиком — завести, переименовать
 * и удалить, — плюс добавление компонента выбранному.
 */
function prefabBar(context: AreaContext<ObjectsAreaState>): readonly UiNode[] {
  const { state, resources, session } = context;
  const off = context.mode === 'preview' || state.configId === null || !state.tracked;
  const record = selectedPrefab(context);
  const config = configValue(state, session);
  // Компоненты, которые можно поставить prefab'у: объявленные документом и
  // синтезируемые загрузчиком — оба множества законны в prefab'е, и оба даёт
  // ядро либо документ, а не список в этом файле (ED-24).
  const available = [
    ...declaredComponentNames(config),
    ...derivedComponents(config).names,
  ].filter((name) => !(record?.components ?? []).includes(name));
  const pair = (): OperationParams => ({
    document: state.configId ?? '',
    ...(state.visualsId === null ? {} : { visuals: state.visualsId }),
  });
  return [
    textField({
      label: resourceText(resources, 'ui.area.objects.prefabName'),
      value: documentValue(state.drafts.prefab),
      readOnly: off,
      onCommit: (raw) => {
        state.drafts.prefab = raw;
        context.refresh();
      },
    }),
    textField({
      label: resourceText(resources, 'ui.area.objects.model'),
      value: documentValue(state.drafts.model),
      readOnly: off,
      onCommit: (raw) => {
        state.drafts.model = raw;
        context.refresh();
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.objects.createPrefab'),
      variant: 'ghost',
      disabled: off || state.drafts.prefab.trim() === '' || state.drafts.model.trim() === '',
      onPress: () => {
        const created = run(context, PAIR_OPERATIONS.create, {
          ...pair(),
          list: [...PREFAB_LIST],
          name: state.drafts.prefab,
          model: state.drafts.model,
        });
        // Дескриптор дописанной записи — им она и выделяется (ED-17).
        if (typeof created === 'string') {
          context.selection.set([created]);
          state.focusId = created;
          state.section = 'prefabs';
        }
        state.drafts.prefab = '';
      },
    }),
    textField({
      label: resourceText(resources, 'ui.area.objects.renameTo'),
      value: documentValue(state.drafts.rename),
      readOnly: off || record === null,
      onCommit: (raw) => {
        state.drafts.rename = raw;
        context.refresh();
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.objects.renamePrefab'),
      variant: 'ghost',
      disabled: off || record === null || state.drafts.rename.trim() === '',
      onPress: () => {
        run(context, PAIR_OPERATIONS.rename, {
          ...pair(),
          record: record?.key ?? '',
          to: state.drafts.rename,
          ...prefabReferences(state.references),
        });
        state.drafts.rename = '';
      },
    }),
    button({
      label: resourceText(resources, 'ui.area.objects.deletePrefab'),
      variant: 'ghost',
      disabled: off || record === null,
      onPress: () => {
        run(context, PAIR_OPERATIONS.delete, { ...pair(), record: record?.key ?? '' });
        context.selection.set([]);
      },
    }),
    select({
      label: resourceText(resources, 'ui.area.objects.prefabComponent'),
      value: state.drafts.prefabComponent,
      options: [
        { value: '', label: resourceText(resources, 'ui.area.objects.none') },
        ...available.map((name) => ({ value: name, label: documentValue(name) })),
      ],
      disabled: off || record === null || available.length === 0,
      onSelect: (next) => {
        state.drafts.prefabComponent = next;
        context.refresh();
      },
    }),
    button({
      label: resourceText(resources, 'ui.action.addComponent'),
      variant: 'ghost',
      disabled: off || record === null || state.drafts.prefabComponent === '',
      onPress: () => {
        run(context, PREFAB_COMPOSITION_OPERATIONS.setValue, {
          document: state.configId ?? '',
          record: record?.key ?? '',
          path: [PREFAB_COMPONENTS_KEY, state.drafts.prefabComponent],
          value: {},
        });
        state.drafts.prefabComponent = '';
      },
    }),
  ];
}

/** Состав выбранного: поля схемы, компоненты prefab'а либо производная схема. */
function composition(context: AreaContext<ObjectsAreaState>): readonly UiNode[] {
  const { state, resources, session } = context;
  const component = selectedComponent(context);
  if (component !== null) {
    return component.fields.map(([name, type]) =>
      compositionRow(context, name, name, type, () => {
        run(context, SCHEMA_OPERATIONS.removeField, {
          document: state.configId ?? '',
          record: component.key,
          field: name,
        });
      }),
    );
  }
  const derivedName = selectedDerived(context);
  if (derivedName !== null) {
    // Производная схема правке не подлежит (дельта ED-6): состав виден, кнопки
    // снятия у строк нет вовсе — «недоступно» здесь означает «этого места в
    // документе не существует», а не «сейчас нельзя».
    return derivedComponentFields(configValue(state, session), derivedName).map(([name, type]) =>
      compositionRow(context, name, name, type, null),
    );
  }
  const prefab = selectedPrefab(context);
  if (prefab !== null) {
    return prefab.components.map((name) =>
      compositionRow(context, name, name, name, () => {
        run(context, PREFAB_COMPOSITION_OPERATIONS.removeValue, {
          document: state.configId ?? '',
          record: prefab.key,
          path: [PREFAB_COMPONENTS_KEY, name],
        });
      }),
    );
  }
  return [el('div', { classes: ['fx-row'], text: resourceText(resources, 'ui.inspector.empty') })];
}

function surface(context: AreaContext<ObjectsAreaState>): UiNode {
  const { state, resources, session } = context;
  // Причина сорвавшегося действия и причина не поднявшегося мира — одна строка
  // на две вещи: обе рассказывают автору, почему он видит не то (ED-8).
  const failure = state.failure ?? derivedComponents(configValue(state, session)).failure;
  return el('div', {
    classes: [FILL_CLASS, FILL_COLUMN_CLASS],
    attrs: { 'data-section': state.section },
    children: children(
      el('div', {
        classes: ['fx-bar'],
        children: children(
          ...(state.section === 'components' ? schemaBar(context) : prefabBar(context)),
          failure === null
            ? undefined
            : withValidation(
                statusChip({
                  label: resourceText(resources, 'ui.area.objects.broken'),
                  tone: 'error',
                }),
                { severity: 'error', reason: documentValue(failure) },
              ),
        ),
      }),
      el('div', {
        classes: [SCROLL_CLASS, 'fx-stack'],
        children: [
          el('div', {
            classes: ['fx-section'],
            text: resourceText(resources, 'ui.area.objects.composition'),
          }),
          ...composition(context),
        ],
      }),
    ),
  });
}

/** Что показывает инспектор при текущем выделении (ED-24). */
function subjectOf(context: AreaContext<ObjectsAreaState>): InspectorSubject | null {
  const { state, session } = context;
  const documentId = state.configId;
  if (documentId === null) return null;
  const component = selectedComponent(context);
  if (component !== null) return componentSubject(documentId, component);
  const derivedName = selectedDerived(context);
  if (derivedName !== null) {
    return derivedComponentSubject(
      documentId,
      derivedName,
      derivedComponentFields(configValue(state, session), derivedName),
    );
  }
  const prefab = selectedPrefab(context);
  return prefab === null
    ? null
    : prefabSubject({ documentId, config: configValue(state, session), record: prefab });
}

function inspector(context: AreaContext<ObjectsAreaState>): UiNode {
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
 * раскладку (`OBJECTS_AREA_KEYS`) и то, что она значит.
 */
function handleObjectsKey(input: AreaKeyInput<ObjectsAreaState>): boolean {
  if (input.phase !== 'down' || input.repeat) return false;
  const section = SECTION_BY_KEY.get(input.code);
  if (section === undefined) return false;
  input.state.section = section;
  input.state.expanded.add(OBJECT_NODES[section]);
  input.state.refresh();
  return true;
}

export function createObjectsArea(options: ObjectsAreaOptions = {}): WorkspaceArea<ObjectsAreaState> {
  return {
    id: OBJECTS_AREA_ID,
    descriptionKey: 'ui.area.objects.description',
    labelKey: 'ui.area.objects.label',
    hotkey: 'F4',
    icon: 'stamp',
    keys: OBJECTS_AREA_KEYS,
    handleKey: handleObjectsKey,
    // Виды редактируемого, которые вносит область (ED-30). Их два: конфиг
    // сцены несёт схемы и prefab'ы, манифест — вторую половину пары ED-19.
    editableTypes: [
      { id: DEFAULT_CONFIG_KIND, descriptionKey: 'ui.editable.scene.description' },
      { id: DEFAULT_VISUALS_KIND, descriptionKey: 'ui.editable.visuals.description' },
    ],
    /**
     * Поиск по проекту (ED-24): схемы компонентов и prefab'ы по имени. Находка
     * выделяет найденное и раскрывает раздел над ним — то же состояние, в
     * котором автор оказался бы, пройдя навигатор, только без прохода.
     */
    search(input: AreaSearch<ObjectsAreaState>): readonly SearchHit[] {
      const { query, state, session, selection } = input;
      if (state.configId === null) return [];
      const found: SearchHit[] = [];
      const reveal = (id: string, node: string, section: ObjectsSection) => () => {
        state.expanded.add(node);
        state.section = section;
        state.focusId = id;
        selection.set([id]);
      };
      for (const record of componentsOf(state, session)) {
        if (!matchesQuery(query, record.name)) continue;
        found.push({
          id: record.key,
          label: documentValue(record.name),
          detail: documentValue(state.configId),
          icon: 'stamp',
          reveal: reveal(record.key, OBJECT_NODES.components, 'components'),
        });
      }
      for (const record of prefabsOf(state, session)) {
        if (!matchesQuery(query, record.name)) continue;
        found.push({
          id: record.key,
          label: documentValue(record.name),
          detail: documentValue(state.configId),
          icon: 'stamp',
          reveal: reveal(record.key, OBJECT_NODES.prefabs, 'prefabs'),
        });
      }
      return found;
    },
    createState(setup): ObjectsAreaState {
      const state: ObjectsAreaState = {
        configId: null,
        visualsId: null,
        tracked: false,
        section: 'components',
        expanded: new Set([OBJECT_NODES.components, OBJECT_NODES.prefabs]),
        focusId: '',
        drafts: {
          component: '',
          field: '',
          fieldType: fieldTypeNames()[0] ?? '',
          prefab: '',
          model: '',
          rename: '',
          prefabComponent: '',
        },
        references: [],
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
      // Просьба перерисовать нужна асинхронному: открытие документов кончается
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
export const objectsArea: WorkspaceArea<ObjectsAreaState> = createObjectsArea();
