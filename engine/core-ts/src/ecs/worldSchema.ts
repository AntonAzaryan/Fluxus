/**
 * Проверки объявлений мира на загрузке (ECS-5) и правило представимости
 * значения поля (ECS-3, ECS-6).
 *
 * Отдельным модулем от `world.ts` — по границе фазы, а не по размеру файла:
 * здесь ничего не знают о состоянии мира, а `WorldInternal` не участвует ни в
 * одной проверке. Всё, что тут падает, падает ДО `createWorld`, то есть до
 * первого тика: опечатка контента не должна доживать до матча.
 *
 * Правило представимости отсюда же читают мутаторы (`world.ts`): условие
 * записи одно на загрузку и на рантайм, и разойтись им негде.
 */
import { FIELD_TYPES, NO_ENTITY, type ComponentSchema, type FieldType } from '../types.js';
import { MAX_ENTITY_ID } from './entityIndex.js';

/** JSON prefab/archetype (ECS-4): набор компонентов + начальные значения полей, опционально теги. */
export interface PrefabDef {
  readonly name: string;
  readonly components: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly tags?: readonly string[];
}

/**
 * Диапазон контейнера поля: `i32`/`fixed` живут в Int32Array, `entity` — в
 * Float64Array с 48-битным id (ID-1).
 */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Набор типов полей закрыт (ECS-3); имена — из одного места с самим типом. */
const FIELD_TYPE_NAMES: readonly string[] = FIELD_TYPES;

function isKnownFieldType(name: string): boolean {
  return FIELD_TYPE_NAMES.includes(name);
}

/**
 * Представимо ли значение в типе поля (ECS-3). Проверка целости и два сравнения
 * — без аллокаций и без зависимости от числа полей: точка вызова горячая (запись
 * поля на каждую команду). Переполнение fixed-арифметики она не задевает:
 * значение приходит завёрнутым по FP-4 и в 32 бита уже помещается.
 */
export function representable(type: FieldType, value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (type === 'entity') return value === NO_ENTITY || (value >= 0 && value <= MAX_ENTITY_ID);
  return value >= INT32_MIN && value <= INT32_MAX;
}

/** Сообщение об отказе записи — одно на все точки записи поля (ECS-3). */
export function valueError(
  action: string,
  component: string,
  field: string,
  type: FieldType,
  value: number,
): Error {
  return new Error(
    `${action}: компонент "${component}", поле "${field}" типа ${type} — значение ${value} непредставимо (ECS-3)`,
  );
}

export function validateSchemas(schemas: readonly ComponentSchema[]): Map<string, ComponentSchema> {
  const map = new Map<string, ComponentSchema>();
  for (const schema of schemas) {
    if (map.has(schema.name)) {
      throw new Error(`ECS-5: компонент "${schema.name}" объявлен дважды`);
    }
    checkFieldTypes(schema);
    checkDefaults(schema);
    map.set(schema.name, schema);
  }
  return map;
}

/** Типы полей компонента: набор закрыт (ECS-3), а имя типа приходит из JSON. */
function checkFieldTypes(schema: ComponentSchema): void {
  for (const [field, type] of Object.entries(schema.fields)) {
    if (!isKnownFieldType(type)) {
      // Тип поля объявлен `FieldType`, но значение пришло из JSON — именно
      // поэтому набор проверяется в рантайме, а не только компилятором.
      throw new Error(
        `ECS-5: компонент "${schema.name}", поле "${field}": неизвестный тип поля "${type}" — набор закрыт (ECS-3): ${FIELD_TYPE_NAMES.join(', ')}`,
      );
    }
  }
}

/** Значения по умолчанию: адрес поля и представимость значения (ECS-5, ECS-3). */
function checkDefaults(schema: ComponentSchema): void {
  if (!schema.defaults) return;
  for (const [field, value] of Object.entries(schema.defaults)) {
    const type = schema.fields[field];
    if (type === undefined) {
      throw new Error(
        `ECS-5: компонент "${schema.name}": default ссылается на несуществующее поле "${field}"`,
      );
    }
    // Непредставимый default — та же ошибка, что и запись (ECS-3), но
    // поймана на загрузке: до первого тика она дешевле в разы.
    if (!representable(type, value)) {
      throw new Error(
        `ECS-5: компонент "${schema.name}", поле "${field}" типа ${type}: default ${value} непредставим (ECS-3)`,
      );
    }
  }
}

export function validatePrefabs(
  prefabs: readonly PrefabDef[],
  schemas: ReadonlyMap<string, ComponentSchema>,
): Map<string, PrefabDef> {
  const map = new Map<string, PrefabDef>();
  for (const prefab of prefabs) {
    if (map.has(prefab.name)) {
      throw new Error(`ECS-5: prefab "${prefab.name}" объявлен дважды`);
    }
    for (const [component, values] of Object.entries(prefab.components)) {
      checkPrefabComponent(prefab.name, component, values, schemas);
    }
    map.set(prefab.name, prefab);
  }
  return map;
}

/** Один компонент prefab'а: адрес компонента, адреса полей и их значения (ECS-5). */
function checkPrefabComponent(
  prefab: string,
  component: string,
  values: Readonly<Record<string, number>>,
  schemas: ReadonlyMap<string, ComponentSchema>,
): void {
  const schema = schemas.get(component);
  if (!schema) {
    throw new Error(`ECS-5: prefab "${prefab}" ссылается на неизвестный компонент "${component}"`);
  }
  for (const [field, value] of Object.entries(values)) {
    const type = schema.fields[field];
    if (type === undefined) {
      throw new Error(
        `ECS-5: prefab "${prefab}", компонент "${component}" ссылается на несуществующее поле "${field}"`,
      );
    }
    // Как и с defaults: непредставимое значение prefab'а — ошибка загрузки,
    // а не отказ первого спавна (ECS-3).
    if (!representable(type, value)) {
      throw valueError(`ECS-5: prefab "${prefab}"`, component, field, type, value);
    }
  }
}
