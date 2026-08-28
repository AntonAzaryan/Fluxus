/**
 * @contribution Чтение опубликованных JSON-схем формата (SER-5) — вклад, а не
 * каркас: схемы описывают редактируемое (сцену, компонент, prefab, систему), и
 * каркасу этих имён знать нельзя (ED-25).
 *
 * Здесь только обход схемы и ни одного имени поля: список имён был бы ровно
 * тем, что ED-24 запрещает, и разошёлся бы с ядром на первом же изменении
 * формата — молча.
 *
 * Модуль общий на все области, потому что схема у них одна: набор полей записи
 * расстановки, схемы компонента, prefab'а и системы читаются одним и тем же
 * обходом, и второй его экземпляр разошёлся бы с первым в том, что считает
 * полем со значением.
 */
import type { JsonValue, SchemaPath } from '@fluxus/editor-core';
import type { SchemaField } from '../inspector/index.js';

/** Корень путей описаний полей формата — тот же, что у отчёта ресурсов (ED-28). */
export const SCHEMA_KIND = 'schema';

/** Вид описания полей компонента: их объявляет контент, он же их и документирует. */
export const COMPONENT_KIND = 'component';

/**
 * Типы JSON-схемы, у которых есть значение и, значит, может быть редактор поля.
 * Объект и массив сюда не входят: полю нужен адрес правки и редактор поля, а у
 * поддерева нет ни того ни другого.
 */
const SCALAR_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean']);

/** Вложенный объект узла схемы; `undefined` — по этому ключу объекта нет. */
export function objectAt(node: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const value = (node as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Строковое поле узла схемы; `undefined` — по этому ключу строки нет. */
function stringAt(node: unknown, key: string): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const value = (node as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Поля из `properties` JSON-схемы: имя, тип и перечисленные значения. Путь
 * описания собирается из корня схемы и имени поля — ровно так же, как его
 * собирает отчёт ресурсов (ED-28), поэтому ключ подсказки совпадает с ключом
 * бандла без всякой таблицы соответствий.
 */
export function jsonSchemaFields(root: string, schema: unknown): readonly SchemaField[] {
  const properties = objectAt(schema, 'properties');
  if (properties === undefined) return [];
  const fields: SchemaField[] = [];
  for (const name of Object.keys(properties)) {
    const property = properties[name];
    const type = stringAt(property, 'type');
    if (type === undefined || !SCALAR_TYPES.has(type)) continue;
    const values =
      typeof property === 'object' && property !== null && Array.isArray((property as Record<string, unknown>).enum)
        ? ((property as Record<string, unknown>).enum as readonly JsonValue[])
        : undefined;
    fields.push({
      name,
      type,
      path: [name],
      description: [SCHEMA_KIND, root, name] as SchemaPath,
      ...(values === undefined ? {} : { values }),
    });
  }
  return fields;
}
