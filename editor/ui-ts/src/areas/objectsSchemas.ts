/**
 * @contribution Схемы компонентов как материал редактора (ED-6) — вклад, а не
 * часть каркаса.
 *
 * Материал здесь один и назван дельтой ED-6: перечень `components` конфига
 * сцены (`serialization` SER-7) — то, что объявил контент и по чему `loadScene`
 * поднимает мир. Опубликованные JSON Schema (SER-5) редактор ЧИТАЕТ — из них
 * берётся закрытый набор типов поля и подписи формата, — и не записывает: они
 * порождены ядром из тех же наборов, по которым валидирует загрузчик, и вторым
 * источником правды о формате быть не могут (ED-1).
 *
 * ## Объявленное контентом и синтезируемое загрузчиком
 *
 * `loadScene` дописывает в мир схемы, которых в документе нет: карту пола
 * террейна (TERR-6), компоненты арены (ARENA-1), шкалу времени и твины
 * (TIME-2, TIME-7, TWEEN-1), компоненты тумана войны (FOW-1..FOW-3). ED-6
 * требует показать их производными и не давать править: объявление такого
 * компонента контентом ядро отвергает как повторное (ECS-5).
 *
 * Отличаются они вычитанием, а не списком имён в редакторе: имена поднятого
 * мира даёт ядро (`world.componentNames`), имена документа — сам документ, и
 * разница между ними и есть «синтезированное». Список здесь разошёлся бы с
 * загрузчиком на первом же новом синтезируемом компоненте — молча.
 *
 * ## Порядок перечня
 *
 * Порядок нормативен (SER-7: битовые id → маски снапшота → хеш `worldInit`,
 * DET-1), поэтому операции перестановки в наборе нет вовсе, а новое дописывается
 * строго в конец — тем же `appendRecord`, что и запись расстановки (ED-16).
 * Отсутствие операции и есть способ сделать «перестановка MUST NOT быть
 * побочным эффектом» проверяемым: переставить нечем.
 */
import { loadScene, schemaFiles, world, type SceneDef, type WorldState } from '@game-mvp/core';
import {
  OperationError,
  getAtPath,
  isJsonArray,
  isJsonObject,
  type AuthoringOperation,
  type DocumentId,
  type JsonObject,
  type JsonPath,
  type JsonValue,
  type OperationParams,
  type OperationParamSpec,
  type OperationRegistry,
  type SchemaPath,
} from '@game-mvp/editor-core';
import { documentValue } from '../dom/node.js';
import type { FieldGroup, InspectorSubject, SchemaField } from '../inspector/index.js';
import { jsonSchemaFields } from './sceneSchema.js';

/** Где в конфиге сцены объявлены схемы компонентов (SER-7). */
export const COMPONENT_LIST: JsonPath = Object.freeze(['components']);

/** Ключи записи схемы (ECS-3): состав полей и значения по умолчанию. */
export const FIELDS_KEY = 'fields';
export const DEFAULTS_KEY = 'defaults';

/** Корень путей описаний полей формата — тот же, что у отчёта ресурсов (ED-28). */
const SCHEMA_KIND = 'schema';

/** Вид описания полей компонента: их объявляет контент, он же их и документирует. */
const COMPONENT_KIND = 'component';

/** Имя схемы формата компонента в наборе ядра (SER-5). */
const COMPONENT_SCHEMA_FILE = 'component.schema.json';

function objectAt(node: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const value = (node as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Закрытый набор типов поля — из опубликованной схемы формата (SER-5), а не
 * литералом здесь. Набор нормирует `ecs-foundation` ECS-3 и вправе расшириться
 * правкой самого ECS-3; перечень, набранный в редакторе, разошёлся бы с ядром
 * ровно на этом расширении (ED-2, дельта ED-6).
 */
export function fieldTypeNames(): readonly string[] {
  const fields = objectAt(objectAt(schemaFiles[COMPONENT_SCHEMA_FILE], 'properties'), FIELDS_KEY);
  const values = objectAt(fields, 'additionalProperties')?.['enum'];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

/** Одна схема компонента так, как её видит область: имя, состав и адрес правки. */
export interface ComponentRecord {
  /** Сессионный дескриптор записи — ключ выделения и адрес операций (ED-29). */
  readonly key: string;
  readonly name: string;
  /** Поля в порядке документа: он же порядок показа (SER-7). */
  readonly fields: readonly (readonly [string, string])[];
}

function fieldsOf(entry: JsonValue | undefined): readonly (readonly [string, string])[] {
  const fields = isJsonObject(entry) ? entry[FIELDS_KEY] : undefined;
  if (!isJsonObject(fields)) return [];
  const out: (readonly [string, string])[] = [];
  for (const [name, type] of Object.entries(fields)) {
    if (typeof type === 'string') out.push([name, type]);
  }
  return out;
}

/**
 * Схемы, объявленные документом, в порядке документа. Ключами служат
 * дескрипторы сессии: они переживают правку соседей (ED-29), а индекс записи —
 * нет, и выделение уехало бы от удаления соседней схемы.
 */
export function componentRecords(
  config: JsonValue | undefined,
  keys: readonly string[],
): readonly ComponentRecord[] {
  const list = getAtPath(config ?? null, COMPONENT_LIST);
  if (!isJsonArray(list)) return [];
  const out: ComponentRecord[] = [];
  list.forEach((entry, index) => {
    const name = isJsonObject(entry) ? entry['name'] : undefined;
    const key = keys[index];
    if (typeof name !== 'string' || key === undefined) return;
    out.push({ key, name, fields: fieldsOf(entry) });
  });
  return out;
}

/** Имена схем, объявленных документом, — в порядке документа. */
export function declaredComponentNames(config: JsonValue | undefined): readonly string[] {
  const list = getAtPath(config ?? null, COMPONENT_LIST);
  if (!isJsonArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    const name = isJsonObject(entry) ? entry['name'] : undefined;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

/** Что дал поднятый мир: производные схемы и причина, если поднять не удалось. */
export interface DerivedComponents {
  /** Имена, которых в документе нет, а в мире есть, — синтезированные загрузчиком. */
  readonly names: readonly string[];
  /** Почему мир не поднялся (ED-8); `null` — поднялся. */
  readonly failure: string | null;
}

const EMPTY_DERIVED: DerivedComponents = Object.freeze({ names: Object.freeze([]), failure: null });

/** Мир конфига либо причина, по которой его нет. */
interface LoadedConfig {
  /** Мир поднятой сцены; `null` — сцена не поднялась. */
  readonly world: WorldState | null;
  /** Почему не поднялась (ED-8); `null` — поднялась. */
  readonly failure: string | null;
}

const EMPTY_LOADED: LoadedConfig = Object.freeze({ world: null, failure: null });

/**
 * Кэш по ссылке на значение документа. Значения сессии иммутабельны и меняются
 * заменой ссылки, поэтому ключ по ссылке точен: правка схемы даёт другой объект
 * и другой ответ. Без кэша мир поднимался бы на каждую отрисовку (design,
 * «Risks»: правка перечня перестраивает мир на каждую валидацию), причём не
 * по разу: состав prefab'а спрашивает схему у КАЖДОГО своего компонента, и
 * подъём на вопрос означал бы `loadScene` на компонент.
 *
 * Кэшируется сам мир, а не производное от него: мир тут только читают
 * (`componentNames`, `componentSchema`), а править его нечем — мутаторы наружу
 * не экспортируются вовсе (TICK-3).
 */
const loadedCache = new WeakMap<object, LoadedConfig>();
const derivedCache = new WeakMap<object, DerivedComponents>();

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function loadedConfig(config: JsonValue | undefined): LoadedConfig {
  if (!isJsonObject(config)) return EMPTY_LOADED;
  const cached = loadedCache.get(config);
  if (cached !== undefined) return cached;
  let found: LoadedConfig;
  try {
    // Приведение без проверки намеренно: разбирать конфиг умеет ядро, и оно же
    // отвергает негодный (SER-7). Вторая проверка здесь была бы второй
    // реализацией правила (ED-1); причина отказа показывается как есть.
    found = { world: loadScene(config as unknown as SceneDef).world, failure: null };
  } catch (error) {
    found = { world: null, failure: message(error) };
  }
  loadedCache.set(config, found);
  return found;
}

/**
 * Синтезируемые загрузчиком схемы (дельта ED-6). Считаются вычитанием: мир
 * поднимает ядро, имена его компонентов отдаёт ядро же (`world.componentNames`),
 * а объявленное вычитается по документу. Своего перечня «что синтезирует
 * загрузчик» у редактора нет и быть не должно.
 */
export function derivedComponents(config: JsonValue | undefined): DerivedComponents {
  if (!isJsonObject(config)) return EMPTY_DERIVED;
  const cached = derivedCache.get(config);
  if (cached !== undefined) return cached;
  const loaded = loadedConfig(config);
  const declared = new Set(declaredComponentNames(config));
  const found: DerivedComponents =
    loaded.world === null
      ? { names: Object.freeze([]), failure: loaded.failure }
      : {
          names: Object.freeze(
            world.componentNames(loaded.world).filter((name) => !declared.has(name)),
          ),
          failure: null,
        };
  derivedCache.set(config, found);
  return found;
}

// -------------------------------------------------------------- инспектор

/**
 * Поля записи схемы для инспектора (ED-24). Три группы, и каждая берёт типы
 * оттуда, где они нормированы:
 *
 * - сама запись — по опубликованной схеме формата (SER-5): скалярные свойства
 *   `component.schema.json`, то есть имя;
 * - состав — строка на поле, тип строки строковый, а допустимые значения — тот
 *   же закрытый набор из схемы формата. Смена типа поля идёт через эту строку
 *   базовой операцией: отдельной доменной операции «сменить тип» не заводится,
 *   иначе в каталоге (ED-30) их стало бы две на одно поведение;
 * - умолчания — строка на поле, тип берётся из состава: значение поля `fixed`
 *   лежит в Q16.16 (FP-1), и показывает его редактор поля этого типа.
 */
export function componentSubject(documentId: DocumentId, record: ComponentRecord): InspectorSubject {
  const format = jsonSchemaFields(COMPONENT_KIND, schemaFiles[COMPONENT_SCHEMA_FILE]);
  const types = [...fieldTypeNames()];
  const groups: FieldGroup[] = [{ name: COMPONENT_KIND, fields: format }];

  const composition: SchemaField[] = record.fields.map(([name]): SchemaField => ({
    name,
    // Строка состава показывает ТИП поля, а не его значение: сама она строковая,
    // а перечисленные значения — закрытый набор типов из схемы формата (SER-5).
    type: 'string',
    path: [FIELDS_KEY, name],
    // Ключ описания — путь поля компонента: имя объявил контент, он же его и
    // документирует (ED-28). Ресурса может не быть — тогда автор видит ключ.
    description: [COMPONENT_KIND, record.name, name] as SchemaPath,
    values: types,
  }));
  if (composition.length > 0) groups.push({ name: FIELDS_KEY, fields: composition });

  const defaults: SchemaField[] = record.fields.map(([name, type]): SchemaField => ({
    name,
    type,
    path: [DEFAULTS_KEY, name],
    description: [SCHEMA_KIND, COMPONENT_KIND, DEFAULTS_KEY] as SchemaPath,
  }));
  if (defaults.length > 0) groups.push({ name: DEFAULTS_KEY, fields: defaults });

  return { address: { documentId, record: record.key }, groups, title: documentValue(record.name) };
}

/**
 * Инспектор синтезированной схемы (дельта ED-6): состав виден, адреса правки у
 * него нет. Поля помечены `readOnly` — «показывается недоступным, а не молча не
 * принимающим ввод» (ED-26), — а корнем субъекта служит сам документ: писать
 * туда нечего, и операции инспектор не предложит ни одной.
 */
export function derivedComponentSubject(
  documentId: DocumentId,
  name: string,
  fields: readonly (readonly [string, string])[],
): InspectorSubject {
  return {
    address: { documentId, root: [] },
    groups: [
      {
        name,
        fields: fields.map(([field, type]): SchemaField => ({
          name: field,
          type,
          // Адрес заведомо несуществующего места: значение читается как пустое,
          // а правка запрещена признаком ниже. Выдумывать производной схеме
          // место в документе нельзя — его там нет (ECS-5).
          path: [DEFAULTS_KEY, name, field],
          description: [COMPONENT_KIND, name, field] as SchemaPath,
          readOnly: true,
        })),
      },
    ],
    title: documentValue(name),
  };
}

/**
 * Состав синтезированной схемы: спрашивается у поднятого мира, а не у
 * документа. Мир берётся кэшированный (`loadedConfig`): состав prefab'а
 * спрашивает схему у каждого своего компонента, и подъём на вопрос стоил бы
 * `loadScene` на строку инспектора.
 *
 * Мир не поднялся — пустой состав без причины: о ней уже отчитался
 * `derivedComponents`, и второго сообщения об одном отказе область не
 * показывает.
 */
export function derivedComponentFields(
  config: JsonValue | undefined,
  name: string,
): readonly (readonly [string, string])[] {
  const state = loadedConfig(config).world;
  if (state === null) return [];
  const schema = world.componentSchema(state, name);
  return schema === undefined
    ? []
    : Object.entries(schema.fields).map(([field, type]) => [field, type] as const);
}

// -------------------------------------------------------------- операции

/**
 * Идентификаторы операций над схемами. Снятие схемы своей операции не получает
 * — `document.list.remove` делает ровно это и адресуется тем же дескриптором;
 * доменная обёртка над ним была бы вторым именем одного поведения в машинном
 * каталоге (ED-30). Смена типа поля и значение по умолчанию идут строкой
 * инспектора базовой операцией по той же причине.
 */
export const SCHEMA_OPERATIONS = {
  create: 'objects.component.create',
  addField: 'objects.component.addField',
  removeField: 'objects.component.removeField',
  /** `document.list.remove`: снять схему умеет базовый набор. */
  remove: 'document.list.remove',
} as const;

const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};
const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'ui.operation.param.list' };
const RECORD: OperationParamSpec = {
  type: 'descriptor',
  descriptionKey: 'ui.operation.param.record',
};
const COMPONENT: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.component',
};
const FIELD: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.field' };
const FIELD_TYPE: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.fieldType',
};

/*
 * Читатели — приведение типа, а не вторая проверка: схему параметров уже сверил
 * слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams): DocumentId => params['document'] as DocumentId;
const asList = (params: OperationParams): JsonPath => (params['list'] ?? []) as JsonPath;
const asRecord = (params: OperationParams): string => params['record'] as string;
const asString = (params: OperationParams, name: string): string => params[name] as string;

function requireText(operationId: string, param: string, value: string): string {
  if (value.trim() === '') {
    throw new OperationError(operationId, `параметр "${param}": имя пусто`, { param, received: value });
  }
  return value;
}

/**
 * Новая схема компонента (ED-6). Дописывается строго в конец: порядок задаёт
 * битовые id (SER-7), и вставка в середину сдвинула бы маски снапшота и хеш
 * `worldInit` там, где автор завёл один компонент.
 *
 * Состав пуст: чем компонент будет, автор говорит следующим действием. Пустой
 * состав ядро на загрузке отвергнет, и это видимое состояние — находка ED-8, а
 * не выдуманное редактором поле, которого автор не заводил.
 */
export const createComponentOperation: AuthoringOperation = {
  id: SCHEMA_OPERATIONS.create,
  descriptionKey: 'ui.operation.objects.component.create',
  params: { document: DOCUMENT, list: LIST, name: COMPONENT },
  apply(ctx, params) {
    const name = requireText(SCHEMA_OPERATIONS.create, 'name', asString(params, 'name'));
    return ctx.appendRecord(asDocument(params), asList(params), { name, [FIELDS_KEY]: {} });
  },
};

/**
 * Новое поле в составе схемы (ED-6). Дописывается в конец состава — ключи
 * документов редактора не сортируются (`project/canonical.ts`), и порядок в
 * файле есть порядок объявления.
 *
 * Тип сверяется с опубликованной схемой формата (SER-5), а не с перечнем в
 * редакторе: набор закрыт, нормирован ECS-3 и вправе расшириться его правкой.
 * Занятое имя — отказ: «добавить» и «сменить тип» это два разных действия, и
 * второе делает строка инспектора базовой операцией.
 */
export const addFieldOperation: AuthoringOperation = {
  id: SCHEMA_OPERATIONS.addField,
  descriptionKey: 'ui.operation.objects.component.addField',
  params: { document: DOCUMENT, record: RECORD, field: FIELD, type: FIELD_TYPE },
  apply(ctx, params) {
    const id = SCHEMA_OPERATIONS.addField;
    const document = asDocument(params);
    const record = asRecord(params);
    const field = requireText(id, 'field', asString(params, 'field'));
    const type = asString(params, 'type');
    const known = fieldTypeNames();
    if (!known.includes(type)) {
      throw new OperationError(
        id,
        `параметр "type": типа "${type}" опубликованная схема формата не объявляет (допустимы: ${known.join(', ')})`,
        { param: 'type', received: type },
      );
    }
    const where = ctx.locate(document, record);
    const fields = ctx.readAt(document, [...where.path, FIELDS_KEY]);
    if (isJsonObject(fields) && Object.hasOwn(fields, field)) {
      throw new OperationError(id, `поле "${field}" в составе уже есть`, {
        param: 'field',
        received: field,
      });
    }
    ctx.setRecordValue(document, record, [FIELDS_KEY, field], type);
    return undefined;
  },
};

/**
 * Снятие поля (ED-6). Одной операцией, а не двумя базовыми: у поля два места —
 * состав и умолчание, — и оставленное умолчание поля, которого больше нет,
 * ядро отвергает на загрузке. «Снять поле» — одно действие автора, значит одна
 * запись истории (ED-18).
 */
export const removeFieldOperation: AuthoringOperation = {
  id: SCHEMA_OPERATIONS.removeField,
  descriptionKey: 'ui.operation.objects.component.removeField',
  params: { document: DOCUMENT, record: RECORD, field: FIELD },
  apply(ctx, params) {
    const id = SCHEMA_OPERATIONS.removeField;
    const document = asDocument(params);
    const record = asRecord(params);
    const field = asString(params, 'field');
    const where = ctx.locate(document, record);
    const fields = ctx.readAt(document, [...where.path, FIELDS_KEY]);
    if (!isJsonObject(fields) || !Object.hasOwn(fields, field)) {
      throw new OperationError(id, `поля "${field}" в составе нет`, {
        param: 'field',
        received: field,
      });
    }
    ctx.removeRecordValue(document, record, [FIELDS_KEY, field]);
    const defaults = ctx.readAt(document, [...where.path, DEFAULTS_KEY]);
    if (isJsonObject(defaults) && Object.hasOwn(defaults, field)) {
      ctx.removeRecordValue(document, record, [DEFAULTS_KEY, field]);
    }
    return undefined;
  },
};

export const SCHEMA_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  createComponentOperation,
  addFieldOperation,
  removeFieldOperation,
]);

/** Запись схемы как объект — то, из чего собираются строки состава. */
export function componentEntry(
  config: JsonValue | undefined,
  name: string,
): JsonObject | undefined {
  const list = getAtPath(config ?? null, COMPONENT_LIST);
  if (!isJsonArray(list)) return undefined;
  for (const entry of list) {
    if (isJsonObject(entry) && entry['name'] === name) return entry;
  }
  return undefined;
}

/** Регистрация вкладом (ED-25): набор приносит тот, кто собирает редактор. */
export function registerSchemaOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of SCHEMA_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}
