/**
 * @contribution Схемы редактируемого области сцены — вклад, а не каркас.
 *
 * Здесь редактор читает реестр схем и превращает прочитанное в набор полей для
 * инспектора (ED-24: «набор полей, их типы и допустимые значения берутся из
 * реестра схем, а не из захардкоженного в редакторе списка»). Реестров этих
 * два, и оба принадлежат ядру, а не редактору:
 *
 * - **схемы компонентов** объявлены самим документом сцены (`components`,
 *   SER-7, ECS-3): имя компонента, имена полей и их типы — закрытый набор ядра
 *   (`FIELD_TYPES`: `i32`, `fixed`, `entity`). Поле, дописанное в схему
 *   компонента, появляется в инспекторе строкой со своим типом, и правка
 *   редактора для этого не нужна (ED-2, ED-6) — включая тип, у которого своего
 *   редактора поля ещё нет (`entity`, см. `inspector/editors.ts`);
 * - **JSON-схемы форматов** порождены ядром из тех же наборов, по которым
 *   валидирует загрузчик (`schemaFiles`, SER-5). Из них берутся поля самого
 *   документа сцены и поля записи расстановки (SER-8).
 *
 * Ни одного имени поля в этом файле нет: есть обход схемы. Список имён был бы
 * ровно тем, что ED-24 запрещает, и разошёлся бы с ядром на первом же
 * изменении формата — молча.
 *
 * ## Что показывает строка переопределения
 *
 * Значение, лежащее в документе по адресу правки, а не значение prefab'а под
 * ним. Запись расстановки — это `prefab` и переопределения полей (SER-8), и
 * пустая строка здесь означает «поле не переопределено», что правда. Показать в
 * ней значение prefab'а значило бы, что автор видит одно, а правит другое: его
 * правка создаёт переопределение, а не меняет prefab.
 *
 * ## Чего этот обход не делает
 *
 * Вложенные объекты схемы в строки не разворачиваются: полю нужен адрес правки
 * и редактор поля, а у объекта нет ни того ни другого (правка целого поддерева
 * — операция `json`, а не строка инспектора). Вложенные разделы — работа
 * редактора схем (ED-6), которого этим проходом ещё нет.
 */
import { schemaFiles } from '@fluxus/core';
import type { EditorSession } from '@fluxus/editor-core';
import { documentValue } from '../dom/node.js';
import type { FieldGroup, InspectorSubject, SchemaField } from '../inspector/index.js';
import { COMPONENT_KIND, jsonSchemaFields, objectAt } from './schemaJson.js';

/** JSON-схема сцены (SER-5) — из неё же выведены и общие типы её `$defs`. */
const SCENE_SCHEMA = schemaFiles['scene.schema.json'];

/** Имя общего типа записи расстановки в схеме сцены (SER-8). */
const SPAWN_ENTRY = 'spawnEntry';

/** Корень путей описаний полей формата: тот же, что у отчёта ресурсов (ED-28). */
const SCENE_ROOT = 'scene';

interface ComponentShape {
  readonly name?: unknown;
  readonly fields?: unknown;
}

interface PrefabShape {
  readonly name?: unknown;
  readonly components?: unknown;
}

interface SceneShape {
  readonly components?: unknown;
  readonly prefabs?: unknown;
}

function componentSchemas(config: unknown): readonly ComponentShape[] {
  const shape = config as SceneShape | null;
  return Array.isArray(shape?.components) ? (shape.components as ComponentShape[]) : [];
}

function prefabsOf(config: unknown): readonly PrefabShape[] {
  const shape = config as SceneShape | null;
  return Array.isArray(shape?.prefabs) ? (shape.prefabs as PrefabShape[]) : [];
}

/**
 * Поля одного компонента (ECS-3): имя поля и его тип, как они объявлены схемой.
 * Порядок — тот же, что в документе: он нормативен для битовых id (SER-7), и
 * пересортировывать его в показе значило бы показывать не то, что записано.
 */
function componentGroup(
  schema: ComponentShape,
  componentName: string,
): FieldGroup | undefined {
  const fields = schema.fields;
  if (typeof fields !== 'object' || fields === null) return undefined;
  const rows: SchemaField[] = [];
  for (const [name, type] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof type !== 'string') continue;
    rows.push({
      name,
      type,
      // Переопределение поля компонента — адрес правки записи расстановки
      // (SER-8): туда и пишет операция, оттуда же читается значение.
      path: ['overrides', componentName, name],
      description: [COMPONENT_KIND, componentName, name],
    });
  }
  return rows.length === 0 ? undefined : { name: componentName, fields: rows };
}

export interface PlacementSubjectInput {
  readonly session: EditorSession;
  /** Документ конфига сцены (SER-7). */
  readonly documentId: string;
  /** Дескриптор записи расстановки — им же ключуется инстанс во вьюпорте (REND-11). */
  readonly record: string;
  /** Имя prefab'а записи — по нему находятся компоненты, чьи поля она переопределяет. */
  readonly prefab: string;
  /** Имена prefab'ов сцены: допустимые значения ссылки записи (SER-8, ED-19). */
  readonly prefabs: readonly string[];
}

/**
 * Инспектор одной записи расстановки: сама запись по схеме формата (SER-8) и
 * поля компонентов её prefab'а по схемам компонентов (ECS-3).
 */
export function placementSubject(input: PlacementSubjectInput): InspectorSubject {
  const config = input.session.documentValue(input.documentId);
  const defs = objectAt(SCENE_SCHEMA, '$defs');
  const entryFields = jsonSchemaFields(SPAWN_ENTRY, objectAt(defs, SPAWN_ENTRY)).map(
    (field): SchemaField =>
      // Ссылка на prefab выбирается из существующих: их набор — тот же, что
      // правило валидации называет известным (ED-19), и набирать его руками
      // означало бы дать автору записать заведомо отвергаемое ядром (SER-8).
      field.name === 'prefab' ? { ...field, values: [...input.prefabs] } : field,
  );

  const prefab = prefabsOf(config).find((candidate) => candidate.name === input.prefab);
  const components =
    typeof prefab?.components === 'object' && prefab.components !== null
      ? Object.keys(prefab.components)
      : [];
  const schemas = componentSchemas(config);
  const groups: FieldGroup[] = [{ name: SPAWN_ENTRY, fields: entryFields }];
  for (const name of components) {
    const schema = schemas.find((candidate) => candidate.name === name);
    const group = schema === undefined ? undefined : componentGroup(schema, name);
    if (group !== undefined) groups.push(group);
  }

  return {
    address: { documentId: input.documentId, record: input.record },
    groups,
    title: documentValue(input.prefab),
  };
}

/**
 * Инспектор самого документа сцены: скалярные поля его формата (SER-7). Их
 * состав, типы и допустимые значения приходят из JSON-схемы ядра, и второго их
 * перечня редактор не заводит (ED-1, ED-24).
 */
export function sceneDocumentSubject(documentId: string): InspectorSubject {
  return {
    address: { documentId },
    groups: [{ name: SCENE_ROOT, fields: jsonSchemaFields(SCENE_ROOT, SCENE_SCHEMA) }],
    title: documentValue(documentId),
  };
}
