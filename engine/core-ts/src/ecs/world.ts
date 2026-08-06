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
import type { ComponentSchema, EntityId, FieldOverrides, WorldState } from '../types.js';
import {
  allocate,
  cloneEntityIndex,
  createEntityIndex,
  free,
  indexOf as rawIndexOf,
  isAlive as indexIsAlive,
  aliveEntities as indexAliveEntities,
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
  /** SoA: поле → Int32Array ёмкостью `capacity`, индексируемый raw-индексом сущности (ECS-1). */
  readonly fields: Readonly<Record<string, Int32Array>>;
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

function validateSchemas(schemas: readonly ComponentSchema[]): Map<string, ComponentSchema> {
  const map = new Map<string, ComponentSchema>();
  for (const schema of schemas) {
    if (map.has(schema.name)) {
      throw new Error(`ECS-5: компонент "${schema.name}" объявлен дважды`);
    }
    for (const [field, type] of Object.entries(schema.fields)) {
      if (type !== 'i32' && type !== 'fixed') {
        throw new Error(
          // `String(type)`: после двух сравнений тип сузился до `never`, но
          // значение пришло из JSON и в рантайме там что угодно.
          `ECS-5: компонент "${schema.name}", поле "${field}": недопустимый тип "${String(type)}" (только i32/fixed, DET-2)`,
        );
      }
    }
    if (schema.defaults) {
      for (const field of Object.keys(schema.defaults)) {
        if (!(field in schema.fields)) {
          throw new Error(
            `ECS-5: компонент "${schema.name}": default ссылается на несуществующее поле "${field}"`,
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
      for (const field of Object.keys(values)) {
        if (!(field in schema.fields)) {
          throw new Error(
            `ECS-5: prefab "${prefab.name}", компонент "${component}" ссылается на несуществующее поле "${field}"`,
          );
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
    const fields: Record<string, Int32Array> = {};
    for (const field of Object.keys(schema.fields)) {
      fields[field] = new Int32Array(capacity);
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
 * внутреннее устройство, а не «читаемый дамп по живым сущностям»: восстановить
 * из читаемого дампа `freeList` и поколения нельзя, а без них следующий `spawn`
 * выдаст другой ID — молчаливая рассинхронизация реплея.
 *
 * Массивы обрезаны по `nextIndex`: слоты за ним нулевые по построению.
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
    const fields: Record<string, Int32Array> = {};
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

/**
 * Спавнит сущность из prefab'а (ECS-4). ID выдаётся детерминированно порядком
 * вызовов (ID-2, DET-6). `overrides` меняет значения полей поверх prefab'а
 * (CMD-6), но не состав компонентов — состав задаёт только prefab.
 */
export function spawn(state: WorldState, prefabName: string, overrides?: FieldOverrides): EntityId {
  const internal = toInternal(state);
  const prefab = internal.prefabs.get(prefabName);
  if (!prefab) throw new Error(`spawn: prefab "${prefabName}" не найден`);
  // Проверяем до allocate: иначе ошибка оставила бы полусозданную сущность.
  if (overrides !== undefined) validateOverrides(internal, prefabName, prefab, overrides);

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
      const value = override?.[field] ?? values[field] ?? store.schema.defaults?.[field] ?? 0;
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
      if (schema?.fields[field] === undefined) {
        throw new Error(`spawn: у компонента "${component}" нет поля "${field}"`);
      }
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

export function getField(state: WorldState, entity: EntityId, component: string, field: string): number {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  if (!store) throw new Error(`getField: компонент "${component}" не зарегистрирован`);
  const arr = store.fields[field];
  if (!arr) throw new Error(`getField: у компонента "${component}" нет поля "${field}"`);
  return arr[rawIndexOf(entity)] ?? 0;
}

export function setField(
  state: WorldState,
  entity: EntityId,
  component: string,
  field: string,
  value: number,
): void {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  if (!store) throw new Error(`setField: компонент "${component}" не зарегистрирован`);
  const arr = store.fields[field];
  if (!arr) throw new Error(`setField: у компонента "${component}" нет поля "${field}"`);
  arr[rawIndexOf(entity)] = value;
  markDirty(internal, component, entity);
}

/** Добавляет компонент существующей сущности; отсутствующие поля берут default либо 0. */
export function addComponent(
  state: WorldState,
  entity: EntityId,
  component: string,
  values?: Readonly<Record<string, number>>,
): void {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  if (!store) throw new Error(`addComponent: компонент "${component}" не зарегистрирован`);
  const index = rawIndexOf(entity);
  setComponent(internal.masks, index, store.id);
  for (const field of Object.keys(store.schema.fields)) {
    const value = values?.[field] ?? store.schema.defaults?.[field] ?? 0;
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
