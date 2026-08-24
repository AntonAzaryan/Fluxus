/**
 * @contribution Prefab как материал редактора (ED-7) — вклад, а не часть
 * каркаса.
 *
 * Prefab — запись перечня `prefabs` конфига сцены (SER-7, ECS-4): имя, набор
 * компонентов с начальными значениями полей и теги. ED-7 требует, чтобы состав
 * компонентов и начальные значения задавались визуально; ED-24 — чтобы типы и
 * допустимые значения приходили из реестра схем. Отсюда всё содержимое файла:
 * чтение записи и сборка субъекта инспектора по схемам компонентов той же
 * сцены.
 *
 * ## Своих операций здесь нет
 *
 * Ни одной, и это решение, а не пробел (ED-30: одно поведение — одно имя в
 * машинном каталоге):
 *
 * - добавить компонент prefab'у — `document.list.setValue` по пути
 *   `['components', <имя>]`; доменная обёртка над ним отличалась бы только
 *   именем. Проверять существование компонента она бы не стала: состав мира
 *   шире перечня документа (синтезируемые загрузчиком компоненты законны в
 *   prefab'е), а вердикт о ссылке выносит `loadScene` находкой ED-8, а не
 *   вторая реализация правила в редакторе (ED-1);
 * - снять компонент — `document.list.removeValue` по тому же пути;
 * - править значение поля и теги — строка инспектора, то есть тот же
 *   `document.list.setValue` (ED-24, ED-29).
 *
 * Пара «prefab + запись манифеста» — другое дело: её заводят, переименовывают и
 * снимают операции `objectsOperations.ts` (ED-19), потому что там знание о ДВУХ
 * документах, которого у базовой операции быть не может.
 */
import {
  getAtPath,
  isJsonArray,
  isJsonObject,
  type DocumentId,
  type JsonPath,
  type JsonValue,
  type SchemaPath,
} from '@fluxus/editor-core';
import { schemaFiles } from '@fluxus/core';
import { documentValue } from '../dom/node.js';
import type { FieldGroup, InspectorSubject, SchemaField } from '../inspector/index.js';
import { jsonSchemaFields } from './sceneSchema.js';
import { componentEntry, derivedComponentFields } from './objectsSchemas.js';

/** Где в конфиге сцены лежат prefab'ы (SER-7). */
export const PREFAB_LIST: JsonPath = Object.freeze(['prefabs']);

/** Ключ состава записи prefab'а (ECS-4). */
export const PREFAB_COMPONENTS_KEY = 'components';

/** Имя схемы формата prefab'а в наборе ядра (SER-5). */
const PREFAB_SCHEMA_FILE = 'prefab.schema.json';

/** Корень путей описаний полей формата — тот же, что у отчёта ресурсов (ED-28). */
const PREFAB_KIND = 'prefab';

/** Вид описания полей компонента: их объявляет контент, он же их и документирует. */
const COMPONENT_KIND = 'component';

/**
 * Операции, которыми правится состав prefab'а. Все базовые — см. шапку файла:
 * имена названы здесь, чтобы литерала идентификатора не было в интерфейсе.
 */
export const PREFAB_COMPOSITION_OPERATIONS = {
  setValue: 'document.list.setValue',
  removeValue: 'document.list.removeValue',
  /** `document.list.remove` снимает саму запись; парную половину — ED-19-операция. */
  remove: 'document.list.remove',
} as const;

/**
 * Один prefab так, как его видит область.
 *
 * Тегов (ECS-4) здесь нет, и это названный предел прохода, а не забывчивость:
 * ED-7 требует визуального набора компонентов и начальных значений, а тег —
 * элемент СПИСКА, и строке инспектора он не соответствует. Редактора поля под
 * список редактор пока не везёт, а держать в записи то, чего никто не
 * показывает и не правит, значило бы обещать интерфейсом больше, чем есть.
 * Появится редактор поля-списка (ED-25) — теги встанут строкой, как остальные.
 */
export interface PrefabRecord {
  /** Сессионный дескриптор записи — ключ выделения и адрес операций (ED-29). */
  readonly key: string;
  readonly name: string;
  /** Имена компонентов в порядке документа. */
  readonly components: readonly string[];
}

/**
 * Prefab'ы документа в порядке документа, с дескрипторами вместо индексов:
 * индекс ломается от удаления соседа, а дескриптор — нет (ED-29).
 */
export function prefabRecords(
  config: JsonValue | undefined,
  keys: readonly string[],
): readonly PrefabRecord[] {
  const list = getAtPath(config ?? null, PREFAB_LIST);
  if (!isJsonArray(list)) return [];
  const out: PrefabRecord[] = [];
  list.forEach((entry, index) => {
    const name = isJsonObject(entry) ? entry.name : undefined;
    const key = keys[index];
    if (typeof name !== 'string' || key === undefined) return;
    const components = isJsonObject(entry) ? entry[PREFAB_COMPONENTS_KEY] : undefined;
    out.push({
      key,
      name,
      components: isJsonObject(components) ? Object.keys(components) : [],
    });
  });
  return out;
}

/** Запись prefab'а как объект; `undefined` — записи с таким именем нет. */
export function prefabEntry(config: JsonValue | undefined, name: string): JsonValue | undefined {
  const list = getAtPath(config ?? null, PREFAB_LIST);
  if (!isJsonArray(list)) return undefined;
  for (const entry of list) {
    if (isJsonObject(entry) && entry.name === name) return entry;
  }
  return undefined;
}

/**
 * Состав компонента: объявленный контентом читается из документа, а
 * синтезируемый загрузчиком — у поднятого мира (дельта ED-6). Оба нужны в
 * инспекторе prefab'а: значение поля синтезированного компонента prefab вправе
 * переопределить, а показать его без схемы нечем.
 */
function fieldsOfComponent(
  config: JsonValue | undefined,
  name: string,
): readonly (readonly [string, string])[] {
  const declared = componentEntry(config, name);
  const fields = declared === undefined ? undefined : declared.fields;
  if (isJsonObject(fields)) {
    const out: (readonly [string, string])[] = [];
    for (const [field, type] of Object.entries(fields)) {
      if (typeof type === 'string') out.push([field, type]);
    }
    return out;
  }
  return derivedComponentFields(config, name);
}

export interface PrefabSubjectInput {
  /** Конфиг сцены (SER-7) — документ, в котором лежит запись. */
  readonly documentId: DocumentId;
  readonly config: JsonValue | undefined;
  readonly record: PrefabRecord;
}

/**
 * Инспектор одного prefab'а (ED-7, ED-24): сама запись по опубликованной схеме
 * формата (SER-5) и поля каждого её компонента по схеме этого компонента
 * (ECS-3). Списка имён здесь нет — есть обход схемы, поэтому поле, дописанное в
 * схему компонента, появляется строкой без правки кода редактора (ED-2, ED-6).
 */
export function prefabSubject(input: PrefabSubjectInput): InspectorSubject {
  const groups: FieldGroup[] = [
    { name: PREFAB_KIND, fields: jsonSchemaFields(PREFAB_KIND, schemaFiles[PREFAB_SCHEMA_FILE]) },
  ];
  for (const component of input.record.components) {
    const fields = fieldsOfComponent(input.config, component);
    if (fields.length === 0) continue;
    groups.push({
      name: component,
      fields: fields.map(([field, type]): SchemaField => ({
        name: field,
        type,
        // Начальное значение поля лежит внутри записи prefab'а (ECS-4): туда и
        // пишет операция, оттуда же читается значение.
        path: [PREFAB_COMPONENTS_KEY, component, field],
        description: [COMPONENT_KIND, component, field] as SchemaPath,
      })),
    });
  }
  return {
    address: { documentId: input.documentId, record: input.record.key },
    groups,
    title: documentValue(input.record.name),
  };
}
