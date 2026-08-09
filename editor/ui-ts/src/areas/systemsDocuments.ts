/**
 * @contribution JSON-системы как материал редактора (ED-4) — вклад, а не часть
 * каркаса.
 *
 * Систем-документов в дереве проекта нет: `systems` — поле конфига сцены
 * (SER-7), и `loadScene` читает их оттуда. Поэтому область систем открывает тот
 * же документ, что и область сцены, но с ОТСЛЕЖИВАЕМЫМ списком `['systems']` —
 * тем же механизмом, каким область сцены отслеживает `['initial']`. Дескриптор
 * записи переживает правку соседей (ED-29) и служит ключом выделения, находки
 * поиска и адресом операции; индекс не переживает удаления соседа, и выделение
 * уехало бы на чужую систему.
 *
 * ## Триггер — это система, один к одному
 *
 * У ядра нет сущности «триггер»: есть JSON-система (SYS-1) с полями `name`,
 * `order`, `query`/`as` и `do`. Три блока ED-4 — «событие — условие —
 * действие» — читаются в ней так:
 *
 * | Блок ED-4 | Что это в SYS-1 |
 * |---|---|
 * | Событие | `query` (сахар над `forEach`) либо действие `forEachEvent` в теле (ACT-1, EVT-2) |
 * | Условие | `cond` действия `if` |
 * | Действия | список `do` (тела события либо самой системы) |
 *
 * `triggerOf` — ЧТЕНИЕ этой раскладки, а не второе описание семантики DSL
 * (ED-1): оно возвращает адреса мест внутри записи и ничего о них не судит.
 * Имена `forEachEvent` и `if` здесь — адреса формы, названные таблицей ED-4
 * выше, тем же приёмом, каким `spawnEntity` назван адресом ссылки на prefab в
 * операциях пары (ED-19). Вердикт о собранном по-прежнему выносит
 * `validateSystem` (SYS-3), а не этот файл.
 *
 * Разложить триггеры внутрь одного `do` было бы соблазнительно — тогда в одном
 * документе жило бы несколько триггеров, — но `order` (место в тике, SYS-2) и
 * `name` (ключ подмены SYS-7, имя RNG-стрима RNG-4) принадлежат системе, и у
 * «правила внутри `do`» ни того, ни другого нет.
 */
import { schemaFiles } from '@game-mvp/core';
import {
  getAtPath,
  isJsonArray,
  isJsonObject,
  readActionNode,
  type DocumentId,
  type DocumentKind,
  type JsonPath,
  type JsonValue,
  type SystemSite,
} from '@game-mvp/editor-core';
import { documentValue } from '../dom/node.js';
import type { InspectorSubject } from '../inspector/index.js';
import { jsonSchemaFields } from './sceneSchema.js';

/** Где в конфиге сцены лежат JSON-системы (SER-7, SYS-1). */
export const SYSTEM_LIST: JsonPath = Object.freeze(['systems']);

/** Вид конфига сцены (SER-7). Вид принадлежит документу, а не области. */
export const DEFAULT_CONFIG_KIND: DocumentKind = 'scene';

/** Ключи записи системы (SYS-1). */
export const NAME_KEY = 'name';
export const ORDER_KEY = 'order';
export const BODY_KEY = 'do';
export const QUERY_KEY = 'query';

/**
 * Действие, несущее событие (ACT-1, EVT-2), и действие-ветвление (ACT-1). Оба
 * имени — из закрытого набора ядра и названы здесь как АДРЕСА блоков ED-4, а не
 * как правила: что с ними делать, решает ядро.
 */
export const EVENT_ACTION = 'forEachEvent';
export const BRANCH_ACTION = 'if';

/** Слоты ветвления, в которых лежат условие и его тело (конвенция SYS-3). */
export const COND_SLOT = 'cond';
export const THEN_SLOT = 'then';

/** Имя схемы формата системы в наборе ядра (SER-5). */
const SYSTEM_SCHEMA_FILE = 'system.schema.json';

/** Корень путей описаний полей формата — тот же, что у отчёта ресурсов (ED-28). */
const SYSTEM_KIND = 'system';

/**
 * Адреса систем этого проекта для правила `core.system` (WP4): системы лежат
 * списком внутри конфига сцены, а не отдельными документами. Раскладку знает
 * тот, кто собирает редактор (ED-25), — эта функция и есть то, что область
 * отдаёт сборке, чтобы находка адресовала ЗАПИСЬ системы, а не документ целиком.
 */
export function systemSites(kind: DocumentKind = DEFAULT_CONFIG_KIND): readonly SystemSite[] {
  return Object.freeze([Object.freeze({ kind, path: SYSTEM_LIST })]);
}

/** Одна система так, как её видит область. */
export interface SystemRecord {
  /** Сессионный дескриптор записи — ключ выделения и адрес операций (ED-29). */
  readonly key: string;
  readonly name: string;
  /** Место в тике (SYS-2); `null` — записи `order` нет или она не целая. */
  readonly order: number | null;
  /** Индекс в списке: им адресуется находка валидации (`['systems', index]`). */
  readonly index: number;
  /** Сама запись — из неё читаются блоки триггера. */
  readonly value: JsonValue;
}

/**
 * Системы документа в порядке документа, с дескрипторами вместо индексов.
 * Порядок показа — порядок документа, а не `order`: пересортировка показа
 * означала бы, что автор видит не то, что записано (ED-21), а место в тике
 * видно колонкой рядом с именем.
 */
export function systemRecords(
  config: JsonValue | undefined,
  keys: readonly string[],
): readonly SystemRecord[] {
  const list = getAtPath(config ?? null, SYSTEM_LIST);
  if (!isJsonArray(list)) return [];
  const out: SystemRecord[] = [];
  list.forEach((entry, index) => {
    const key = keys[index];
    if (key === undefined) return;
    const name = isJsonObject(entry) ? entry[NAME_KEY] : undefined;
    const order = isJsonObject(entry) ? entry[ORDER_KEY] : undefined;
    out.push({
      key,
      name: typeof name === 'string' ? name : '',
      order: typeof order === 'number' && Number.isInteger(order) ? order : null,
      index,
      value: entry,
    });
  });
  return out;
}

/** Откуда триггер берёт свои срабатывания (ED-4). */
export type TriggerSource =
  /** Каждый тик по сущностям запроса: `query` — сахар над `forEach` (SYS-1). */
  | 'query'
  /** На каждое событие такого типа: действие `forEachEvent` в теле (EVT-2). */
  | 'event'
  /** Каждый тик один раз: ни запроса, ни события — тело системы как есть. */
  | 'tick';

/** Адреса трёх блоков ED-4 внутри записи системы. Пути — относительно записи. */
export interface TriggerView {
  readonly source: TriggerSource;
  /**
   * Узел-носитель события: `['query']` у запроса, аргументы `forEachEvent` у
   * события; `null` — у тика источника нет.
   */
  readonly eventPath: JsonPath | null;
  /** Список действий тела триггера — тела события либо самой системы. */
  readonly bodyPath: JsonPath;
  /** Выражение условия (`cond` первого ветвления тела); `null` — условия нет. */
  readonly conditionPath: JsonPath | null;
  /**
   * Список действий триггера — он же тело. Блок «условие» ED-4 адресует место
   * ВНУТРИ него (`cond` ветвления), а не рядом с ним: ветвление — такое же
   * действие тела, как остальные (ACT-1), и прятать его из списка значило бы
   * показывать автору не то, что записано.
   */
  readonly actionsPath: JsonPath;
  /** Индекс узла-ветвления в теле; `null` — ветвления нет. */
  readonly branchIndex: number | null;
  /** Индекс узла-события в `do`; `null` — источник не событие. */
  readonly eventIndex: number | null;
}

/** Индекс первого узла тела, чьё единственное имя — названное действие. */
function indexOfAction(body: JsonValue | undefined, action: string): number | null {
  if (!isJsonArray(body)) return null;
  for (const [index, node] of body.entries()) {
    if (readActionNode(node)?.name === action) return index;
  }
  return null;
}

/**
 * Раскладка триггера по записи системы. Чтение и только чтение: ни одного
 * вердикта о том, законна ли найденная форма, — их выносит `validateSystem`.
 */
export function triggerOf(system: JsonValue | undefined): TriggerView {
  const record = isJsonObject(system) ? system : {};
  const eventIndex = indexOfAction(record[BODY_KEY], EVENT_ACTION);
  const source: TriggerSource =
    eventIndex !== null ? 'event' : record[QUERY_KEY] !== undefined ? 'query' : 'tick';
  const eventPath: JsonPath | null =
    eventIndex !== null
      ? [BODY_KEY, eventIndex, EVENT_ACTION]
      : source === 'query'
        ? [QUERY_KEY]
        : null;
  const bodyPath: JsonPath =
    eventIndex === null ? [BODY_KEY] : [BODY_KEY, eventIndex, EVENT_ACTION, BODY_KEY];

  const body = getAtPath(record, bodyPath);
  const branchIndex = indexOfAction(body, BRANCH_ACTION);
  return {
    source,
    eventPath,
    bodyPath,
    conditionPath: branchIndex === null ? null : [...bodyPath, branchIndex, BRANCH_ACTION, COND_SLOT],
    actionsPath: bodyPath,
    branchIndex,
    eventIndex,
  };
}

/** Значение по пути внутри записи; `undefined` — места нет. */
export function valueAt(system: JsonValue | undefined, path: JsonPath): JsonValue | undefined {
  return system === undefined ? undefined : getAtPath(system, path);
}

/**
 * Инспектор записи системы (ED-24): скалярные поля её формата по опубликованной
 * JSON-схеме (SER-5) — тем же обходом, каким инспектор строит поля записи
 * расстановки. Списка имён здесь нет: поле, дописанное в формат системы,
 * появляется строкой без правки редактора (ED-2).
 */
export function systemSubject(documentId: DocumentId, record: SystemRecord): InspectorSubject {
  return {
    address: { documentId, record: record.key },
    groups: [
      { name: SYSTEM_KIND, fields: jsonSchemaFields(SYSTEM_KIND, schemaFiles[SYSTEM_SCHEMA_FILE]) },
    ],
    title: documentValue(record.name),
  };
}
