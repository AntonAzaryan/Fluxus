/* eslint-disable max-lines --
 * Модуль — сам мир: состояние (`WorldInternal`), его мутаторы, проверки
 * мутаторов, handle-доступ, плоская форма и клонирование. Всё, что отсюда ещё
 * можно вынести, работает НАД `WorldInternal`, и вынос потребовал бы
 * экспортировать сам внутренний вид мира: обход `WorldState` стал бы доступен
 * любому модулю ядра, а это ровно тот побочный канал, ради закрытия которого
 * общие мутаторы не выходят из `src/index.ts` (TICK-3). Проверки объявлений на
 * загрузке (ECS-5) вынесены отдельно (`worldSchema.ts`) — они единственные, кто
 * состояния мира не касается.
 */
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
 *
 * Сами колонки и плоская таблица их адресов живут в `fieldTable.ts` — там же,
 * где ЕДИНСТВЕННОЕ чтение поля (`readByHandle`). Строковый путь `getField`
 * здесь — это разрешение имени плюс тот же вызов (SYS-10): два пути чтения не
 * могут разойтись семантикой, потому что после разрешения имён путь один.
 */
import type {
  ComponentHandle,
  ComponentSchema,
  EntityId,
  FieldHandle,
  FieldOverrides,
  FieldType,
  WorldState,
} from '../types.js';
import {
  representable,
  validatePrefabs,
  validateSchemas,
  valueError,
  type PrefabDef,
} from './worldSchema.js';
import {
  cloneStores,
  createStores,
  neutralValue,
  ownsByHandle,
  readByHandle,
  type ComponentStorage,
  type FieldTable,
} from './fieldTable.js';
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

/**
 * Хранилища и таблица полей живут в `fieldTable.ts` — там же, где чтение по
 * handle (SYS-10). Реэкспорт: `peekField` буфера команд обязан брать
 * нейтральное значение из того же правила, что мутаторы (CMD-5, ECS-3).
 */
export { neutralValue };

/**
 * Объявление prefab'а живёт с проверками объявлений (`worldSchema.ts`), а
 * адресуют его через мир: адрес ECS снаружи один.
 */
export type { PrefabDef } from './worldSchema.js';

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
   * Per-component dirty (OBS-6, NET-8): сущности, изменённые с последнего
   * `clearDirty`, индекс — числовой id компонента (`store.id`). Гранулярность —
   * per-component, а не per-entity-per-component: `changedEntities(component)`
   * и сетевой дельте нужен ровно этот срез (открытый вопрос 3 в
   * architecture.md).
   *
   * Массив по id, а не карта по имени (снятая часть ponytail, профиль
   * npc-stress): пометка стоит на КАЖДОЙ записи мира, и строковый поиск на ней
   * был заметен сам по себе. Set'ы создаются вместе с миром и переиспользуются
   * между тиками (clearDirty чистит на месте, не пересоздаёт) — наружу они
   * уходят живым видом (OBS-3), и это ровно прежняя семантика. Остаток
   * ponytail — сам Set против битовой маски по слотам — стоит на месте: замена
   * на маску меняет форму `changedEntities` и ждёт замера обхода, а не пометки.
   */
  dirty: Set<EntityId>[];
  /** Плоская таблица полей — адресное пространство handle (SYS-10). */
  fields: FieldTable;
}

const DEFAULT_CAPACITY = 1024;

function toInternal(state: WorldState): WorldInternal {
  return state as unknown as WorldInternal;
}

function toState(internal: WorldInternal): WorldState {
  return internal as unknown as WorldState;
}

/** Создаёт мир: валидирует схемы/prefabs (ECS-5) и аллоцирует SoA-хранилища ёмкостью `capacity`. */
export function createWorld(
  schemas: readonly ComponentSchema[],
  prefabs: readonly PrefabDef[] = [],
  capacity: number = DEFAULT_CAPACITY,
): WorldState {
  const schemaMap = validateSchemas(schemas);
  const prefabMap = validatePrefabs(prefabs, schemaMap);

  const { stores, table } = createStores(schemaMap, capacity);

  const internal: WorldInternal = {
    entities: createEntityIndex(capacity),
    masks: createMasks(capacity, Math.max(stores.size, 1)),
    capacity,
    schemas: schemaMap,
    prefabs: prefabMap,
    stores,
    tags: new Map(),
    dirty: createDirty(stores.size),
    fields: table,
  };
  return toState(internal);
}

// ------------------------------------------------------ dirty (OBS-6, NET-8)

/** Срез по числу компонентов: Set на каждый store.id, созданный вместе с миром. */
function createDirty(componentCount: number): Set<EntityId>[] {
  return Array.from({ length: componentCount }, () => new Set<EntityId>());
}

/** Пометка по числовому id компонента (store.id): вызывающий его уже держит. */
function markDirty(internal: WorldInternal, componentId: number, entity: EntityId): void {
  internal.dirty[componentId]!.add(entity);
}

/** Все компоненты сущности разом — структурное изменение задевает каждый из них. */
function markAllDirty(internal: WorldInternal, entity: EntityId): void {
  const index = rawIndexOf(entity);
  for (const store of internal.stores.values()) {
    if (maskHas(internal.masks, index, store.id)) markDirty(internal, store.id, entity);
  }
}

/**
 * Начало тика: прошлый срез изменений отдан наблюдателям и больше не нужен
 * (OBS-3). Set'ы чистятся на месте, а не пересоздаются: пустые они остаются в
 * срезе и переиспользуются markDirty вместо аллокации новых на каждом тике.
 */
export function clearDirty(state: WorldState): void {
  for (const set of toInternal(state).dirty) set.clear();
}

const NO_ENTITIES: ReadonlySet<EntityId> = new Set();

export function dirtyEntities(state: WorldState, component: string): ReadonlySet<EntityId> {
  const internal = toInternal(state);
  const id = internal.stores.get(component)?.id;
  return id === undefined ? NO_ENTITIES : internal.dirty[id]!;
}

export function dirtyIsEmpty(state: WorldState): boolean {
  for (const set of toInternal(state).dirty) {
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
  // Пары, а не ключи с повторным поиском: порядок задаёт тот же числовой
  // компаратор (SER-6), а множество приходит вместе со своим индексом.
  for (const [index, set] of [...internal.tags].sort((a, b) => a[0] - b[0])) {
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
  const { stores, table } = cloneStores(src.stores);

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
    dirty: createDirty(stores.size),
    fields: table,
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

  // Колонки перезаписываются НА МЕСТЕ, а не подменяются ссылками из снапшота, —
  // и это же делает handle, разрешённый до отката, валидным после него (SYS-10):
  // плоская таблица мира адресует те же массивы, что и до восстановления.
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

/**
 * Затирает ячейки всех полей в слоте сущности нейтральными значениями их типов
 * (ноль у `i32`/`fixed`, «ссылки нет» у `entity`, ECS-6). `destroy` гасит только
 * живость, маску и теги (ID-3), а SoA-ячейки хранят прошлое сущности (см.
 * `getField`), и `toPlain` сериализует массивы полей до `nextIndex` независимо
 * от живости. Каноническому миру это законно — guarded-чтение мимо ячейки не
 * ходит, — но персональному снапшоту мало: данных о скрытой сущности у клиента
 * не должно быть ФИЗИЧЕСКИ (NET-12), иначе позиция и статы читались бы прямо из
 * кадра на проводе (wallhack). Зовёт её фильтр проекции (`sim/filter.ts`) по
 * КОПИИ мира, после `destroy`.
 */
export function scrubFields(state: WorldState, entity: EntityId): void {
  const internal = toInternal(state);
  const index = rawIndexOf(entity);
  for (const store of internal.stores.values()) {
    for (const [field, arr] of Object.entries(store.fields)) {
      arr[index] = neutralValue(store.schema.fields[field]!);
    }
  }
}

/** ID-1/ID-3: живая проверка ссылки — учитывает и index, и generation. */
export function isAlive(state: WorldState, entity: EntityId): boolean {
  return indexIsAlive(toInternal(state).entities, entity);
}

export function hasComponent(state: WorldState, entity: EntityId, component: string): boolean {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  // Незарегистрированное имя здесь — «не владеет», а не бросок: `has` и есть
  // тот вопрос, которым контент проверяет наличие. Разрешение имени в handle
  // отвечает на него иначе — ошибкой (SYS-10), и это не расхождение: резолв
  // случается один раз до тика, где опечатке место, а не на каждой сущности.
  if (!store) return false;
  return ownsByHandle(internal, entity, store.id as ComponentHandle);
}

/**
 * Разрешение имени компонента в handle (SYS-10). Зовётся при конструировании
 * системы либо на первом её входе, а не на каждой сущности обхода: смысл
 * handle в том, что строковый поиск оплачен заранее и ровно один раз.
 *
 * Неизвестное имя — ошибка НЕМЕДЛЕННО, с именем в тексте: тем же правилом, по
 * которому система падает на отсутствующей зависимости (SYS-5). Ноль на каждом
 * чтении посреди матча вместо этого превратил бы опечатку в поведение.
 */
export function resolveComponentHandle(state: WorldState, component: string): ComponentHandle {
  const store = toInternal(state).stores.get(component);
  if (!store) {
    throw new Error(`resolveComponent: компонент "${component}" не зарегистрирован (SYS-10)`);
  }
  return store.id as ComponentHandle;
}

/** Разрешение имени поля в handle (SYS-10); условия и мотив — как у `resolveComponentHandle`. */
export function resolveFieldHandle(
  state: WorldState,
  component: string,
  field: string,
): FieldHandle {
  const store = toInternal(state).stores.get(component);
  if (!store) {
    throw new Error(`resolveField: компонент "${component}" не зарегистрирован (SYS-10)`);
  }
  const handle = store.handles[field];
  if (handle === undefined) {
    throw new Error(`resolveField: у компонента "${component}" нет поля "${field}" (SYS-10)`);
  }
  return handle;
}

/**
 * Чтение поля по handle (SYS-10) — то же тотальное чтение ECS-7, что и
 * строковое, без строкового поиска. Тело общее с `getField`: см. `readByHandle`.
 */
export function getFieldByHandle(state: WorldState, entity: EntityId, handle: FieldHandle): number {
  return readByHandle(toInternal(state), entity, handle);
}

/** Владение компонентом по handle (SYS-10) — то же, что `hasComponent` после резолва. */
export function hasComponentByHandle(
  state: WorldState,
  entity: EntityId,
  handle: ComponentHandle,
): boolean {
  return ownsByHandle(toInternal(state), entity, handle);
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
 * Аллокаций на пути владеющего чтения нет ни в release, ни в debug: тексты
 * находок — и здесь, и в `checkBounds` маски — строятся только на ветке
 * отказа (FP-4). Распаковка id — одна на чтение (`aliveIndexOf`), поколение
 * сверяется переупаковкой без деления; прежний обмен «второй `rawIndexOf` и
 * деление в `generationOf`» из Risks дизайна change'а этим снят.
 *
 * Само чтение — `readByHandle` (SYS-10): строковый путь есть РАЗРЕШЕНИЕ ИМЕНИ
 * плюс handle-путь, и другого тела у него нет. Тотальность, порядок проверок и
 * текст находки поэтому одни и те же у обоих путей по построению, а не потому,
 * что их держат согласованными.
 */
export function getField(state: WorldState, entity: EntityId, component: string, field: string): number {
  const internal = toInternal(state);
  const store = storeOf(internal, 'getField', component);
  const handle = store.handles[field];
  if (handle === undefined) throw missingField('getField', component, field);
  return readByHandle(internal, entity, handle);
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
  markDirty(internal, store.id, entity);
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
  markDirty(internal, store.id, entity);
}

export function removeComponent(state: WorldState, entity: EntityId, component: string): void {
  const internal = toInternal(state);
  const store = internal.stores.get(component);
  if (!store) return;
  clearComponent(internal.masks, rawIndexOf(entity), store.id);
  markDirty(internal, store.id, entity);
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
