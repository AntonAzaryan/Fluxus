/* eslint-disable max-lines -- baseline */
/**
 * Мир: собственное SoA-хранилище компонентов по JSON-схемам (ECS-1, ECS-3),
 * prefabs (ECS-4), теги и generational ID (ID-1..5) поверх `entityIndex.ts`.
 *
 * Сторонней ECS-библиотеки нет намеренно (ECS-1): порядок обхода, схема ID и
 * снятие полного состояния мира заданы спекой, а не поведением библиотеки.
 *
 * Принадлежность компонентов — битовая маска на сущность (`componentMask.ts`),
 * а не проверка по имени: фильтр запроса сводится к одному И по словам вместо
 * строкового поиска на каждую сущность.
 */
import type {
  ComponentSchema,
  EntityId,
  FieldArray,
  FieldOverrides,
  FieldType,
  WorldState,
} from '../types.js';
import { FIELD_TYPES, NO_ENTITY } from '../types.js';
import { DEBUG, assert } from '../debug.js';
import {
  allocate,
  assertRoom,
  cloneEntityIndex,
  createEntityIndex,
  free,
  indexOf as rawIndexOf,
  isAlive as indexIsAlive,
  aliveEntities as indexAliveEntities,
  room as indexRoom,
  MAX_ENTITY_ID,
  type EntityIndex,
} from './entityIndex.js';
import {
  clearComponent,
  clearEntity,
  cloneMasks,
  createMasks,
  hasComponent as maskHas,
  setComponent,
  type ComponentMasks,
} from './componentMask.js';

/** JSON prefab/archetype (ECS-4): набор компонентов + начальные значения полей, опционально теги. */
export interface PrefabDef {
  readonly name: string;
  readonly components: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly tags?: readonly string[];
}

interface ComponentStorage {
  readonly schema: ComponentSchema;
  /** Числовой id компонента — позиция его бита в маске. */
  readonly id: number;
  /**
   * SoA: поле → TypedArray ёмкостью `capacity`, индексируемый raw-индексом
   * сущности (ECS-1). Тип массива выбирает тип поля (`fieldArray`): хранилище
   * неоднородно ровно из-за `entity`, которому нужны 48 бит (ECS-6, ID-1).
   */
  readonly fields: Readonly<Record<string, FieldArray>>;
}

interface WorldInternal {
  entities: EntityIndex;
  masks: ComponentMasks;
  readonly capacity: number;
  /** Схемы и prefabs неизменяемы после createWorld — клон может их шарить, не копируя. */
  readonly schemas: ReadonlyMap<string, ComponentSchema>;
  readonly prefabs: ReadonlyMap<string, PrefabDef>;
  readonly stores: Map<string, ComponentStorage>;
  tags: Map<number, Set<string>>;
  /**
   * Per-component dirty (OBS-6, NET-8): компонент → сущности, изменённые с
   * последнего `clearDirty`. Гранулярность — per-component, а не
   * per-entity-per-component: `changedEntities(component)` и сетевой дельте
   * нужен ровно этот срез (открытый вопрос 3 в architecture.md).
   *
   * ponytail: Set на компонент, а не битовая маска по слотам. Set'ы
   * переиспользуются между тиками (clearDirty чистит на месте, не пересоздаёт);
   * замена на маску — когда замеры покажут, что заметен и сам обход Set'ов.
   */
  dirty: Map<string, Set<EntityId>>;
}

const DEFAULT_CAPACITY = 1024;

function toInternal(state: WorldState): WorldInternal {
  return state as unknown as WorldInternal;
}

function toState(internal: WorldInternal): WorldState {
  return internal as unknown as WorldState;
}

// ------------------------------------------------- типы полей (ECS-3, ECS-6)

/** Границы 32-битного поля (`i32`, `fixed`). */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Набор строкой: имя типа приходит из JSON, и в рантайме там что угодно. */
const FIELD_TYPE_NAMES: readonly string[] = FIELD_TYPES;

function isKnownFieldType(name: string): boolean {
  return FIELD_TYPE_NAMES.includes(name);
}

/**
 * Контейнер поля по его типу. `entity` — 48 бит без потерь (ECS-6, ID-1):
 * `Int32Array` усёк бы идентификатор молча, уже при `generation ≥ 256`.
 * Заполняется «ссылки нет», а не нулём: ноль — валидный `EntityId`, и
 * компонент, добавленный без значения, ссылался бы на сущность нулевого слота.
 */
function fieldArray(type: FieldType, capacity: number): FieldArray {
  if (type !== 'entity') return new Int32Array(capacity);
  return new Float64Array(capacity).fill(NO_ENTITY);
}

/**
 * Нейтральное значение поля, для которого не объявлен `default` (ECS-3): ноль у
 * `i32`/`fixed`, «ссылки нет» у `entity` (ECS-6).
 */
function neutralValue(type: FieldType): number {
  return type === 'entity' ? NO_ENTITY : 0;
}

/**
 * Представимо ли значение в типе поля (ECS-3). Проверка целости и два сравнения
 * — без аллокаций и без зависимости от числа полей: точка вызова горячая (запись
 * поля на каждую команду). Переполнение fixed-арифметики она не задевает:
 * значение приходит завёрнутым по FP-4 и в 32 бита уже помещается.
 */
function representable(type: FieldType, value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (type === 'entity') return value === NO_ENTITY || (value >= 0 && value <= MAX_ENTITY_ID);
  return value >= INT32_MIN && value <= INT32_MAX;
}

/** Сообщение об отказе записи — одно на все точки записи поля (ECS-3). */
function valueError(
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

function validateSchemas(schemas: readonly ComponentSchema[]): Map<string, ComponentSchema> {
  const map = new Map<string, ComponentSchema>();
  for (const schema of schemas) {
    if (map.has(schema.name)) {
      throw new Error(`ECS-5: компонент "${schema.name}" объявлен дважды`);
    }
    for (const [field, type] of Object.entries(schema.fields)) {
      if (!isKnownFieldType(type)) {
        // Тип поля объявлен `FieldType`, но значение пришло из JSON — именно
        // поэтому набор проверяется в рантайме, а не только компилятором.
        throw new Error(
          `ECS-5: компонент "${schema.name}", поле "${field}": неизвестный тип поля "${type}" — набор закрыт (ECS-3): ${FIELD_TYPE_NAMES.join(', ')}`,
        );
      }
    }
    if (schema.defaults) {
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
    map.set(schema.name, schema);
  }
  return map;
}

function validatePrefabs(
  prefabs: readonly PrefabDef[],
  schemas: ReadonlyMap<string, ComponentSchema>,
): Map<string, PrefabDef> {
  const map = new Map<string, PrefabDef>();
  for (const prefab of prefabs) {
    if (map.has(prefab.name)) {
      throw new Error(`ECS-5: prefab "${prefab.name}" объявлен дважды`);
    }
    for (const [component, values] of Object.entries(prefab.components)) {
      const schema = schemas.get(component);
      if (!schema) {
        throw new Error(`ECS-5: prefab "${prefab.name}" ссылается на неизвестный компонент "${component}"`);
      }
      for (const [field, value] of Object.entries(values)) {
        const type = schema.fields[field];
        if (type === undefined) {
          throw new Error(
            `ECS-5: prefab "${prefab.name}", компонент "${component}" ссылается на несуществующее поле "${field}"`,
          );
        }
        // Как и с defaults: непредставимое значение prefab'а — ошибка загрузки,
        // а не отказ первого спавна (ECS-3).
        if (!representable(type, value)) {
          throw valueError(`ECS-5: prefab "${prefab.name}"`, component, field, type, value);
        }
      }
    }
    map.set(prefab.name, prefab);
  }
  return map;
}

/** Создаёт мир: валидирует схемы/prefabs (ECS-5) и аллоцирует SoA-хранилища ёмкостью `capacity`. */
export function createWorld(
  schemas: readonly ComponentSchema[],
  prefabs: readonly PrefabDef[] = [],
  capacity: number = DEFAULT_CAPACITY,
): WorldState {
  const schemaMap = validateSchemas(schemas);
  const prefabMap = validatePrefabs(prefabs, schemaMap);

  const stores = new Map<string, ComponentStorage>();
  let nextComponentId = 0;
  for (const schema of schemaMap.values()) {
    const fields: Record<string, FieldArray> = {};
    for (const [field, type] of Object.entries(schema.fields)) {
      fields[field] = fieldArray(type, capacity);
    }
    stores.set(schema.name, { schema, id: nextComponentId, fields });
    nextComponentId++;
  }

  const internal: WorldInternal = {
    entities: createEntityIndex(capacity),
    masks: createMasks(capacity, Math.max(nextComponentId, 1)),
    capacity,
    schemas: schemaMap,
    prefabs: prefabMap,
    stores,
    tags: new Map(),
    dirty: new Map(),
  };
  return toState(internal);
}

// ------------------------------------------------------ dirty (OBS-6, NET-8)

function markDirty(internal: WorldInternal, component: string, entity: EntityId): void {
  const set = internal.dirty.get(component);
  if (set === undefined) internal.dirty.set(component, new Set([entity]));
  else set.add(entity);
}

/** Все компоненты сущности разом — структурное изменение задевает каждый из них. */
function markAllDirty(internal: WorldInternal, entity: EntityId): void {
  const index = rawIndexOf(entity);
  for (const [name, store] of internal.stores) {
    if (maskHas(internal.masks, index, store.id)) markDirty(internal, name, entity);
  }
}

/**
 * Начало тика: прошлый срез изменений отдан наблюдателям и больше не нужен
 * (OBS-3). Set'ы чистятся на месте, а не `map.clear()`: пустые они остаются в
 * карте и переиспользуются markDirty вместо аллокации новых на каждом тике.
 */
export function clearDirty(state: WorldState): void {
  for (const set of toInternal(state).dirty.values()) set.clear();
}

const NO_ENTITIES: ReadonlySet<EntityId> = new Set();

export function dirtyEntities(state: WorldState, component: string): ReadonlySet<EntityId> {
  return toInternal(state).dirty.get(component) ?? NO_ENTITIES;
}

export function dirtyIsEmpty(state: WorldState): boolean {
  for (const set of toInternal(state).dirty.values()) {
    if (set.size > 0) return false;
  }
  return true;
}

/**
 * Plain-форма мира (SER-1): только числа, массивы чисел и строки. Повторяет
 * внутреннее устройство, а не «читаемый дамп по живым сущностям»: состояние
 * схемы идентификаторов входит в снапшот всеми тремя частями — счётчик слотов,
 * поколения и список свободных слотов (ID-4), — а перечень живых не даёт ни
 * поколений освободившихся слотов, ни порядка их освобождения, и восстановление
 * из него разошлось бы по ID на первом же `spawn` после отката.
 *
 * Эта же форма целиком, без отбора полей, входит в каноническое представление
 * `worldInit` и в его хеш (DET-1 п. 3): «сокращённая форма для хеша» была бы
 * второй раскладкой мира, обязанной совпасть между реализациями побитово, при
 * живой первой. Пустой `freeList` поэтому пишется пустым списком, а не
 * опускается: опущенный ключ дал бы другой поток байт на тех же данных.
 *
 * Массивы обрезаны по `nextIndex`: счётчик монотонен (ID-2), поэтому слоты за
 * ним не занимались ни разу — в них лежит начальное значение своего контейнера
 * (ноль у `i32`/`fixed`, «ссылки нет» у `entity`, ECS-6), а не данные сущности.
 * Обрезка поэтому не «отбрасывает нули», а отбрасывает никогда не занятое:
 * граница задана счётчиком, а не содержимым слота.
 */
export interface PlainWorld {
  readonly capacity: number;
  readonly nextIndex: number;
  readonly aliveCount: number;
  readonly generations: readonly number[];
  readonly alive: readonly number[];
  readonly freeList: readonly number[];
  readonly maskWords: readonly number[];
  /** Компонент → поле → значения по raw-индексу. Ключи отсортированы (SER-6). */
  readonly components: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>;
  /** `[raw-индекс, отсортированные теги]`, по возрастанию индекса (SER-6). */
  readonly tags: readonly (readonly [number, readonly string[]])[];
}

export function toPlain(state: WorldState): PlainWorld {
  const internal = toInternal(state);
  const used = internal.entities.nextIndex;

  const components: Record<string, Record<string, readonly number[]>> = {};
  for (const name of [...internal.stores.keys()].sort()) {
    const store = internal.stores.get(name)!;
    const fields: Record<string, readonly number[]> = {};
    for (const field of Object.keys(store.fields).sort()) {
      fields[field] = Array.from(store.fields[field]!.subarray(0, used));
    }
    components[name] = fields;
  }

  const tags: [number, string[]][] = [];
  for (const index of [...internal.tags.keys()].sort((a, b) => a - b)) {
    const set = internal.tags.get(index)!;
    if (set.size > 0) tags.push([index, [...set].sort()]);
  }

  return {
    capacity: internal.capacity,
    nextIndex: used,
    aliveCount: internal.entities.aliveCount,
    generations: Array.from(internal.entities.generations.subarray(0, used)),
    alive: Array.from(internal.entities.alive.subarray(0, used)),
    freeList: [...internal.entities.freeList],
    maskWords: Array.from(internal.masks.words.subarray(0, used * internal.masks.wordsPerEntity)),
    components,
    tags,
  };
}

/**
 * Восстанавливает мир из plain-формы. Схемы и prefabs — из того же конфига
 * сцены, с которым мир был снят: порядок компонентов задаёт их битовые id, а
 * значит, и смысл `maskWords` (SER-7).
 */
export function fromPlain(
  plain: PlainWorld,
  schemas: readonly ComponentSchema[],
  prefabs: readonly PrefabDef[] = [],
): WorldState {
  const state = createWorld(schemas, prefabs, plain.capacity);
  const internal = toInternal(state);

  internal.entities.generations.set(plain.generations);
  internal.entities.alive.set(plain.alive);
  internal.entities.freeList = [...plain.freeList];
  internal.entities.nextIndex = plain.nextIndex;
  internal.entities.aliveCount = plain.aliveCount;
  internal.masks.words.set(plain.maskWords);

  for (const [name, fields] of Object.entries(plain.components)) {
    const store = internal.stores.get(name);
    if (!store) throw new Error(`fromPlain: компонент "${name}" не объявлен в схемах сцены`);
    for (const [field, values] of Object.entries(fields)) {
      const target = store.fields[field];
      if (!target) throw new Error(`fromPlain: у компонента "${name}" нет поля "${field}"`);
      target.set(values);
    }
  }

  internal.tags = new Map(plain.tags.map(([index, names]) => [index, new Set(names)]));
  return state;
}

/**
 * Полная глубокая копия мира. Мир мутабелен (TICK-1), поэтому копия нужна не
 * каждый тик, а только при снятии снапшота в историю (SNAP-4) — с интервалом,
 * который задаёт `HistoryProvider`.
 */
export function cloneWorld(state: WorldState): WorldState {
  const src = toInternal(state);

  const stores = new Map<string, ComponentStorage>();
  for (const [name, store] of src.stores) {
    // `slice` сохраняет и содержимое, и вид массива — ширина поля клонируется
    // вместе с ним, отдельного разбора по типу поля здесь не нужно.
    const fields: Record<string, FieldArray> = {};
    for (const [field, arr] of Object.entries(store.fields)) {
      fields[field] = arr.slice();
    }
    stores.set(name, { schema: store.schema, id: store.id, fields });
  }

  const tags = new Map<number, Set<string>>();
  for (const [index, set] of src.tags) tags.set(index, new Set(set));

  return toState({
    entities: cloneEntityIndex(src.entities),
    masks: cloneMasks(src.masks),
    capacity: src.capacity,
    schemas: src.schemas,
    prefabs: src.prefabs,
    stores,
    tags,
    // Снапшот — значение, а не живой мир: срез изменений в него не переносится.
    dirty: new Map(),
  });
}

/**
 * Восстанавливает содержимое `dst` из `src` НЕ подменяя объект (REW-2).
 * Подмена ссылки была бы короче, но `TerrainApi` и `PhysicsApi` замкнуты на
 * конкретный `WorldState` при сборке сцены: после свопа они читали бы мир,
 * которого больше нет в симуляции.
 */
export function copyWorldInto(dst: WorldState, src: WorldState): void {
  const to = toInternal(dst);
  const from = toInternal(src);
  if (to.capacity !== from.capacity) {
    throw new Error(`copyWorldInto: ёмкости не совпадают (${to.capacity} против ${from.capacity})`);
  }

  to.entities.generations.set(from.entities.generations);
  to.entities.alive.set(from.entities.alive);
  to.entities.freeList = [...from.entities.freeList];
  to.entities.nextIndex = from.entities.nextIndex;
  to.entities.aliveCount = from.entities.aliveCount;
  to.masks.words.set(from.masks.words);

  for (const [name, store] of to.stores) {
    const source = from.stores.get(name);
    if (!source) throw new Error(`copyWorldInto: в источнике нет компонента "${name}"`);
    for (const [field, arr] of Object.entries(store.fields)) {
      arr.set(source.fields[field]!);
    }
  }

  to.tags = new Map();
  for (const [index, set] of from.tags) to.tags.set(index, new Set(set));
  // Восстановление — изменение всего мира: срез дельты за него не отвечает.
  clearDirty(dst);
}

/** Числовой id компонента — нужен Query для построения маски-фильтра. */
export function componentId(state: WorldState, component: string): number | undefined {
  return toInternal(state).stores.get(component)?.id;
}

/** Схема компонента по имени — опора валидации JSON-систем (SYS-3). */
export function componentSchema(state: WorldState, component: string): ComponentSchema | undefined {
  return toInternal(state).stores.get(component)?.schema;
}

export function prefabOf(state: WorldState, prefab: string): PrefabDef | undefined {
  return toInternal(state).prefabs.get(prefab);
}

/**
 * Имена компонентов мира в порядке объявления — том же, что задаёт битовые id
 * (`componentId`) и потому нормативен (SER-7). Перечень нужен тому, кто
 * `componentSchema` спрашивает по имени, а самих имён не знает: редактор
 * строит по нему пикеры компонентов и показывает синтезированные загрузчиком
 * схемы наравне с объявленными контентом (ED-6, ED-7).
 *
 * Чтение, а не мутация (TICK-3): наружу уходит свежий массив строк, живого
 * состояния мира — ни байта. Вызывается вне тика, поэтому аллокация массива
 * дисциплины горячего пути не задевает; звать это из системы незачем — внутри
 * тика состав компонентов сущности даёт маска, а не перебор имён.
 */
export function componentNames(state: WorldState): readonly string[] {
  return [...toInternal(state).stores.keys()];
}

/** Имена зарегистрированных prefab'ов (ECS-4) в порядке объявления; та же природа, что у `componentNames`. */
export function prefabNames(state: WorldState): readonly string[] {
  return [...toInternal(state).prefabs.keys()];
}

export function componentMasks(state: WorldState): ComponentMasks {
  return toInternal(state).masks;
}

/**
 * Живой EntityIndex мира — только для чтения в Query: прямой обход слотов не
 * материализует промежуточный массив живых сущностей на каждый запрос. Как и
 * `componentMasks`, из `index.ts` не публикуется (TICK-3).
 */
export function entityIndexOf(state: WorldState): EntityIndex {
  return toInternal(state).entities;
}

// ------------------------------------- проверки мутаторов (CMD-2, SYS-9)
//
// Условия, на которых мутатор бросает, вынесены в отдельные функции и оттуда же
// экспортированы: буфер команд обязан узнать об отказе ДО первой мутации мира,
// иначе команды упавшей системы применились бы частично (SYS-9). Второй список
// тех же условий рядом с буфером разошёлся бы с этим при первой же правке.

function storeOf(internal: WorldInternal, action: string, component: string): ComponentStorage {
  const store = internal.stores.get(component);
  if (!store) throw new Error(`${action}: компонент "${component}" не зарегистрирован`);
  return store;
}

/** Отсутствующее поле — один текст на чтение, запись и проверку. */
function missingField(action: string, component: string, field: string): Error {
  return new Error(`${action}: у компонента "${component}" нет поля "${field}"`);
}

/**
 * Тип поля, отказывающий теми же словами, что мутатор: проверка представимости
 * и сама запись берут и тип, и отказ из одной функции. Отдельного «достань
 * массив поля» рядом нет намеренно: массив без своего типа теперь бесполезен —
 * по типу выбирается и нейтральное значение, и граница диапазона.
 */
function fieldTypeOf(store: ComponentStorage, action: string, component: string, field: string): FieldType {
  const type = store.schema.fields[field];
  if (type === undefined) throw missingField(action, component, field);
  return type;
}

/**
 * Компонент зарегистрирован, а переданные значения представимы в типах своих
 * полей (ECS-3) — иначе тот же отказ, что у мутатора с именем `action`.
 */
export function checkComponent(
  state: WorldState,
  action: string,
  component: string,
  values?: Readonly<Record<string, number>>,
): void {
  const store = storeOf(toInternal(state), action, component);
  if (values === undefined) return;
  // `for…in` с `hasOwn`, а не `Object.keys`/`entries`: проход валидации буфера
  // команд не аллоцирует (см. `validate` в `commands.ts`), а `hasOwn` не даёт
  // унаследованному свойству попасть в проверку — то же правило, что у чтения
  // имён операторов (EXPR-6).
  for (const field in values) {
    if (!Object.hasOwn(values, field)) continue;
    // Значение поля, которого у компонента нет, мутатор молча игнорирует —
    // проверять его представимость незачем.
    const type = store.schema.fields[field];
    const value = values[field]!;
    if (type !== undefined && !representable(type, value)) {
      throw valueError(action, component, field, type, value);
    }
  }
}

/**
 * Компонент и его поле существуют, а значение — если оно передано — представимо
 * в типе поля (ECS-3): иначе тот же отказ, что у мутатора с именем `action`.
 */
export function checkField(
  state: WorldState,
  action: string,
  component: string,
  field: string,
  value?: number,
): void {
  const internal = toInternal(state);
  const store = storeOf(internal, action, component);
  const type = fieldTypeOf(store, action, component, field);
  if (value !== undefined && !representable(type, value)) {
    throw valueError(action, component, field, type, value);
  }
}

/**
 * Условия, на которых бросает `spawn`: prefab зарегистрирован, а `overrides`
 * адресуют только то, что prefab уже содержит (CMD-6). Мира не касается.
 */
export function checkSpawn(state: WorldState, prefabName: string, overrides?: FieldOverrides): PrefabDef {
  const internal = toInternal(state);
  const prefab = internal.prefabs.get(prefabName);
  if (!prefab) throw new Error(`spawn: prefab "${prefabName}" не найден`);
  if (overrides !== undefined) validateOverrides(internal, prefabName, prefab, overrides);
  return prefab;
}

/** Сколько ещё сущностей примет мир (ID-2); счёт ведёт `EntityIndex`. */
export function spawnRoom(state: WorldState): number {
  return indexRoom(toInternal(state).entities);
}

/** Отказ по ёмкости теми же словами, что у аллокации (ID-1), но до неё. */
export function checkSpawnRoom(state: WorldState, available: number): void {
  assertRoom(toInternal(state).entities, available);
}

/**
 * Спавнит сущность из prefab'а (ECS-4). ID выдаётся детерминированно порядком
 * вызовов (ID-2, DET-6). `overrides` меняет значения полей поверх prefab'а
 * (CMD-6), но не состав компонентов — состав задаёт только prefab.
 */
export function spawn(state: WorldState, prefabName: string, overrides?: FieldOverrides): EntityId {
  const internal = toInternal(state);
  // Проверяем до allocate: иначе ошибка оставила бы полусозданную сущность.
  const prefab = checkSpawn(state, prefabName, overrides);

  const entity = allocate(internal.entities);
  const index = rawIndexOf(entity);
  // Слот мог остаться «грязным» от прежней сущности: маску и теги чистим явно,
  // поля компонентов перезапишутся ниже значениями prefab'а.
  clearEntity(internal.masks, index);
  internal.tags.delete(index);

  for (const [component, values] of Object.entries(prefab.components)) {
    const store = internal.stores.get(component);
    if (!store) throw new Error(`spawn: компонент "${component}" не зарегистрирован`);
    setComponent(internal.masks, index, store.id);
    const override = overrides?.[component];
    for (const field of Object.keys(store.schema.fields)) {
      const type = store.schema.fields[field]!;
      // Поле, которого не задали ни override, ни prefab, ни defaults, получает
      // нейтральное значение своего типа: «ссылки нет» у `entity` (ECS-3, ECS-6).
      const value = override?.[field] ?? values[field] ?? store.schema.defaults?.[field] ?? neutralValue(type);
      if (!representable(type, value)) throw valueError('spawn', component, field, type, value);
      store.fields[field]![index] = value;
    }
  }
  if (prefab.tags && prefab.tags.length > 0) {
    internal.tags.set(index, new Set(prefab.tags));
  }
  markAllDirty(internal, entity);
  return entity;
}

/**
 * CMD-6: переопределять можно только то, что prefab уже содержит. Молча
 * проигнорированное поле означало бы способность, которая ничего не делает,
 * и разбираться в этом пришлось бы по эффекту, а не по ошибке.
 */
function validateOverrides(
  internal: WorldInternal,
  prefabName: string,
  prefab: PrefabDef,
  overrides: FieldOverrides,
): void {
  for (const [component, fields] of Object.entries(overrides)) {
    if (!Object.hasOwn(prefab.components, component)) {
      throw new Error(`spawn: prefab "${prefabName}" не содержит компонент "${component}"`);
    }
    const schema = internal.stores.get(component)?.schema;
    for (const field of Object.keys(fields)) {
      const type = schema?.fields[field];
      if (type === undefined) {
        throw new Error(`spawn: у компонента "${component}" нет поля "${field}"`);
      }
      const value = fields[field]!;
      if (!representable(type, value)) throw valueError('spawn', component, field, type, value);
    }
  }
}

/** Удаляет сущность: generation инкрементируется (ID-3), старые ссылки становятся невалидны. */
export function destroy(state: WorldState, entity: EntityId): void {
  const internal = toInternal(state);
  if (!indexIsAlive(internal.entities, entity)) return; // повторное удаление — не ошибка
  const index = rawIndexOf(entity);
  markAllDirty(internal, entity);
  clearEntity(internal.masks, index);
  internal.tags.delete(index);
  free(internal.entities, entity);
}

/** ID-1/ID-3: живая проверка ссылки — учитывает и index, и generation. */
export function isAlive(state: WorldState, entity: EntityId): boolean {
  return indexIsAlive(toInternal(state).entities, entity);
}

export function hasComponent(state: WorldState, entity: EntityId, component: string): boolean {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  if (!store) return false;
  if (!indexIsAlive(internal.entities, entity)) return false;
  return maskHas(internal.masks, rawIndexOf(entity), store.id);
}

/**
 * Чтение поля — тотальное (ECS-7): результат есть у любой пары «сущность,
 * поле», и ошибкой вычисления оно не бывает. Отсутствие владения (бит
 * компонента в маске не выставлен, ECS-1) и не-живая сущность (ID-1) дают
 * нейтральное значение ТИПА поля, а не содержимое ячейки: `removeComponent`
 * гасит только бит (CMD-4), слоты переиспользуются стеком (ID-6), поэтому в
 * ячейке лежит либо собственное прошлое сущности, либо значение прежнего
 * владельца слота — величина детерминированная, но ничего не означающая.
 * Ноль для `entity` был бы ещё и валидным `EntityId` первого слота мира, то
 * есть той самой подменой ссылки, от которой ECS-6 защищает кодировкой
 * «ссылки нет».
 *
 * Порядок проверок нормативен. Имена компонента и поля — факт текста системы,
 * проверяемый до тика, и остаются броском (ECS-5): подмена опечатки нейтральным
 * нулём сделала бы её поведением. Живость проверяется РАНЬШЕ маски: мусорный
 * идентификатор несёт индекс за пределами `capacity`, а маску на таком индексе
 * спрашивать нельзя — `hasComponent` маски читала бы чужое слово и в debug
 * добавляла бы к находке шум `MASK_INDEX_OUT_OF_RANGE` о том же самом.
 *
 * Громкость уходит в отдельный канал (FP-4): мягкий assert debug-сборки, не
 * влияющий ни на результат, ни на состояние мира, — прогоны debug и release на
 * одном сценарии совпадают побитово. Guard `hasComponent` остаётся обязанностью
 * контента: ECS-7 делает дефект воспроизводимым, а не корректным.
 *
 * Аллокаций на пути владеющего чтения нет — в release. В debug-сборке текст
 * сообщения строится на ветке отказа (и `checkBounds` в маске строит свои
 * сообщения безусловно — это уже действующий приём FP-4). Ценой владеющего
 * чтения остаются второй `rawIndexOf` и деление в `generationOf` внутри
 * `isAlive`; это осознанный обмен, записанный в Risks дизайна change'а.
 */
export function getField(state: WorldState, entity: EntityId, component: string, field: string): number {
  const internal = toInternal(state);
  const store = storeOf(internal, 'getField', component);
  const arr = store.fields[field];
  if (arr === undefined) throw missingField('getField', component, field);
  const index = rawIndexOf(entity);
  if (!indexIsAlive(internal.entities, entity) || !maskHas(internal.masks, index, store.id)) {
    if (DEBUG) {
      assert(
        false,
        `getField: сущность ${entity} не владеет компонентом "${component}" (ECS-7), поле "${field}"`,
        'COMPONENT_READ_WITHOUT_OWNERSHIP',
      );
    }
    return neutralValue(store.schema.fields[field]!);
  }
  return arr[index]!;
}

/**
 * Запись поля. Значение, не представимое в типе поля, — жёсткая ошибка, а не
 * усечение (ECS-3): именно здесь идентификатор, положенный в поле `i32`,
 * перестаёт молча портиться на `generation ≥ 256`.
 */
export function setField(
  state: WorldState,
  entity: EntityId,
  component: string,
  field: string,
  value: number,
): void {
  const internal = toInternal(state);
  const store = storeOf(internal, 'setField', component);
  const type = fieldTypeOf(store, 'setField', component, field);
  if (!representable(type, value)) throw valueError('setField', component, field, type, value);
  store.fields[field]![rawIndexOf(entity)] = value;
  markDirty(internal, component, entity);
}

/**
 * Добавляет компонент существующей сущности; отсутствующие поля берут `default`,
 * а при его отсутствии — нейтральное значение своего типа (ECS-3): ноль у
 * `i32`/`fixed` и «ссылки нет» у `entity` (ECS-6).
 */
export function addComponent(
  state: WorldState,
  entity: EntityId,
  component: string,
  values?: Readonly<Record<string, number>>,
): void {
  const internal = toInternal(state);
  const store = storeOf(internal, 'addComponent', component);
  const index = rawIndexOf(entity);
  setComponent(internal.masks, index, store.id);
  for (const field of Object.keys(store.schema.fields)) {
    const type = store.schema.fields[field]!;
    const value = values?.[field] ?? store.schema.defaults?.[field] ?? neutralValue(type);
    if (!representable(type, value)) throw valueError('addComponent', component, field, type, value);
    store.fields[field]![index] = value;
  }
  markDirty(internal, component, entity);
}

export function removeComponent(state: WorldState, entity: EntityId, component: string): void {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  if (!store) return;
  clearComponent(internal.masks, rawIndexOf(entity), store.id);
  markDirty(internal, component, entity);
}

export function addTag(state: WorldState, entity: EntityId, tag: string): void {
  const internal = toInternal(state);
  const index = rawIndexOf(entity);
  const set = internal.tags.get(index);
  if (set) set.add(tag);
  else internal.tags.set(index, new Set([tag]));
}

export function hasTag(state: WorldState, entity: EntityId, tag: string): boolean {
  const internal = toInternal(state);
  if (!indexIsAlive(internal.entities, entity)) return false;
  return internal.tags.get(rawIndexOf(entity))?.has(tag) ?? false;
}

/** Живые EntityId по возрастанию raw-индекса (QUERY-2). */
export function listAlive(state: WorldState): Float64Array {
  return indexAliveEntities(toInternal(state).entities);
}

/** Раскрывает raw-индекс сущности — только для диагностики/тестов ID-3 (переиспользование слота). */
export function indexOf(state: WorldState, entity: EntityId): number {
  void state;
  return rawIndexOf(entity);
}
