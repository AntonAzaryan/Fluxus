/**
 * SoA-хранилища компонентов и плоская таблица их полей — основа handle-чтения
 * (`data-driven-systems` SYS-10).
 *
 * Handle — ЧИСЛОВОЙ адрес поля в таблицах ниже, полученный разрешением имён
 * один раз, а не захваченная ссылка на колонку: колонка не пережила бы ни
 * перемотку (`snapshot-rewind`), ни клон мира, а отданная наружу изменяемой она
 * была бы каналом мутаций мимо Command Buffer (TICK-3). Поэтому наружу уходит
 * индекс, и ничего кроме индекса.
 *
 * Таблица плоская намеренно: чтение по handle — три индексации массивов
 * (колонка, владелец, нейтральное значение) вместо двух поисков по строковым
 * словарям, а проверка владения (ECS-7) остаётся ровно та же, одно И по слову
 * маски. Строковый путь (`world.getField`) резолвит имя и зовёт ЭТУ ЖЕ функцию
 * `readByHandle`: разойтись семантикой два пути чтения не могут, потому что
 * путь после разрешения имён один.
 *
 * Здесь же живут контейнер поля и его нейтральное значение: и то и другое —
 * функция типа поля (ECS-3, ECS-6), то есть свойство колонки, а не мира.
 */
import { DEBUG, assert } from '../debug.js';
import {
  NO_ENTITY,
  type ComponentHandle,
  type ComponentSchema,
  type EntityId,
  type FieldArray,
  type FieldHandle,
  type FieldType,
} from '../types.js';
import { aliveIndexOf, type EntityIndex } from './entityIndex.js';
import { hasComponent as maskHas, type ComponentMasks } from './componentMask.js';

/**
 * Нейтральное значение поля, для которого не объявлен `default` (ECS-3): ноль у
 * `i32`/`fixed`, «ссылки нет» у `entity` (ECS-6). Экспорт — для `peekField`
 * буфера команд (CMD-5): чтение отложенного `addComponent` обязано дать то же
 * значение, что мутатор запишет на flush, а не вторую копию правила.
 */
export function neutralValue(type: FieldType): number {
  return type === 'entity' ? NO_ENTITY : 0;
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

export interface ComponentStorage {
  readonly schema: ComponentSchema;
  /** Числовой id компонента — позиция его бита в маске; он же `ComponentHandle`. */
  readonly id: number;
  /**
   * SoA: поле → TypedArray ёмкостью `capacity`, индексируемый raw-индексом
   * сущности (ECS-1). Тип массива выбирает тип поля (`fieldArray`): хранилище
   * неоднородно ровно из-за `entity`, которому нужны 48 бит (ECS-6, ID-1).
   */
  readonly fields: Readonly<Record<string, FieldArray>>;
  /** Поле → его handle в плоской таблице мира (SYS-10): резолвер имени поля. */
  readonly handles: Readonly<Record<string, FieldHandle>>;
}

/**
 * Плоская таблица всех полей мира, индексируемая handle. Разложена по массивам,
 * а не по объектам-записям: чтение трогает ровно те три величины, которые ему
 * нужны, и не тянет за собой запись целиком.
 */
export interface FieldTable {
  /** Колонка поля. */
  readonly arrays: readonly FieldArray[];
  /** Id компонента-владельца — то, что проверяет маска (ECS-1). */
  readonly owners: Int32Array;
  /** Значение при отсутствии владения (ECS-7). */
  readonly neutrals: Int32Array;
  /**
   * Тип поля (ECS-3) — им проверяется представимость значения у команды,
   * адресованной handle'ом (CMD-1): строковый путь берёт тот же тип из схемы
   * компонента, handle-путь читает его отсюда, и второго определения
   * представимости от этого не заводится.
   */
  readonly types: readonly FieldType[];
  /** Имя компонента и имя поля — только для текста находки ECS-7 в debug-сборке. */
  readonly components: readonly string[];
  readonly fields: readonly string[];
}

/** То, что чтению по handle нужно от мира; `WorldInternal` этому соответствует. */
export interface FieldReadSource {
  readonly entities: EntityIndex;
  readonly masks: ComponentMasks;
  readonly fields: FieldTable;
}

interface TableBuilder {
  readonly arrays: FieldArray[];
  readonly owners: number[];
  readonly neutrals: number[];
  readonly types: FieldType[];
  readonly components: string[];
  readonly fields: string[];
}

function newBuilder(): TableBuilder {
  return { arrays: [], owners: [], neutrals: [], types: [], components: [], fields: [] };
}

function finish(builder: TableBuilder): FieldTable {
  return {
    arrays: builder.arrays,
    owners: Int32Array.from(builder.owners),
    neutrals: Int32Array.from(builder.neutrals),
    types: builder.types,
    components: builder.components,
    fields: builder.fields,
  };
}

/**
 * Одно хранилище компонента вместе с его местом в плоской таблице. Поля
 * обходятся в порядке СХЕМЫ, и это делает handle функцией одних лишь схем
 * сцены: мир, поднятый второй раз из того же конфига (клон, `fromPlain`),
 * раздаёт те же числа.
 */
function storage(
  builder: TableBuilder,
  schema: ComponentSchema,
  id: number,
  fields: Readonly<Record<string, FieldArray>>,
): ComponentStorage {
  const handles: Record<string, FieldHandle> = {};
  for (const [field, type] of Object.entries(schema.fields)) {
    handles[field] = builder.arrays.length as FieldHandle;
    builder.arrays.push(fields[field]!);
    builder.owners.push(id);
    builder.neutrals.push(neutralValue(type));
    builder.types.push(type);
    builder.components.push(schema.name);
    builder.fields.push(field);
  }
  return { schema, id, fields, handles };
}

/** Хранилища мира по его схемам: битовые id раздаются порядком объявления (SER-7). */
export function createStores(
  schemas: ReadonlyMap<string, ComponentSchema>,
  capacity: number,
): { stores: Map<string, ComponentStorage>; table: FieldTable } {
  const builder = newBuilder();
  const stores = new Map<string, ComponentStorage>();
  let id = 0;
  for (const schema of schemas.values()) {
    const fields: Record<string, FieldArray> = {};
    for (const [field, type] of Object.entries(schema.fields)) {
      fields[field] = fieldArray(type, capacity);
    }
    stores.set(schema.name, storage(builder, schema, id, fields));
    id++;
  }
  return { stores, table: finish(builder) };
}

/**
 * Глубокая копия хранилищ для снапшота (SNAP-4). `slice` сохраняет и
 * содержимое, и вид массива — ширина поля клонируется вместе с ним.
 */
export function cloneStores(src: ReadonlyMap<string, ComponentStorage>): {
  stores: Map<string, ComponentStorage>;
  table: FieldTable;
} {
  const builder = newBuilder();
  const stores = new Map<string, ComponentStorage>();
  for (const [name, store] of src) {
    const fields: Record<string, FieldArray> = {};
    for (const [field, arr] of Object.entries(store.fields)) {
      fields[field] = arr.slice();
    }
    stores.set(name, storage(builder, store.schema, store.id, fields));
  }
  return { stores, table: finish(builder) };
}

/**
 * ЕДИНСТВЕННОЕ чтение поля в ядре (ECS-7, SYS-10): строковый путь приходит сюда
 * после разрешения имён, handle-путь — сразу. Тотальность, порядок проверок и
 * текст находки поэтому у обоих буквально одни и те же, а не «согласованы».
 *
 * Порядок проверок нормативен, и он тот же, что был у строкового чтения:
 * живость проверяется РАНЬШЕ маски, потому что мусорный идентификатор несёт
 * индекс за пределами `capacity`, а маску на таком индексе спрашивать нельзя —
 * она читала бы чужое слово и в debug добавляла бы к находке шум
 * `MASK_INDEX_OUT_OF_RANGE` о том же самом.
 *
 * Громкость уходит в отдельный канал (FP-4): мягкий assert debug-сборки, не
 * влияющий ни на результат, ни на состояние мира.
 */
export function readByHandle(
  world: FieldReadSource,
  entity: EntityId,
  handle: FieldHandle,
): number {
  const table = world.fields;
  // Распаковка id одна на чтение (`aliveIndexOf`): живость и индекс — один
  // проход, маска на мёртвом/мусорном id не спрашивается вовсе (порядок
  // проверок из шапки — тот же).
  const index = aliveIndexOf(world.entities, entity);
  if (index < 0 || !maskHas(world.masks, index, table.owners[handle]!)) {
    if (DEBUG) {
      assert(
        false,
        // Имя компонента и поля — из тех же параллельных массивов, что и
        // `owners`/`neutrals` выше: handle есть адрес в них (SYS-10).
        `getField: сущность ${entity} не владеет компонентом "${table.components[handle]!}" (ECS-7), поле "${table.fields[handle]!}"`,
        'COMPONENT_READ_WITHOUT_OWNERSHIP',
      );
    }
    return table.neutrals[handle]!;
  }
  return table.arrays[handle]![index]!;
}

/**
 * Чтение поля по RAW-ИНДЕКСУ слота (SYS-10) — та же колонка и то же значение,
 * что у `readByHandle`, но без доказательства того, что уже доказано отбором
 * запроса: индекс приходит из `queryInto`, чья спецификация перечислила
 * компонент этого поля в `all` (`ecs-foundation` QUERY-3), поэтому и живость
 * слота, и владение компонентом истинны по построению.
 *
 * Тотальности ECS-7 это не отменяет и второго правила чтения не заводит: пути
 * ЧТЕНИЯ по-прежнему два — по имени и по handle, — а здесь адресуется тот же
 * handle, только уже разрешённой сущностью. Ошибку использования ловит
 * debug-сборка мягким assert'ом (FP-4): он не бросает, значения не меняет и
 * потому не делает прогоны debug и release различимыми.
 *
 * Текст находки строится ТОЛЬКО на ветке отказа — как и у `readByHandle`:
 * шаблонная строка в аргументе `assert` вычислялась бы на каждом чтении, то
 * есть debug-сборка платила бы аллокацией за проверку, которая почти всегда
 * проходит.
 */
export function readByIndex(world: FieldReadSource, index: number, handle: FieldHandle): number {
  const table = world.fields;
  if (DEBUG && !maskHas(world.masks, index, table.owners[handle]!)) {
    assert(
      false,
      `getByIndex: слот ${index} не владеет компонентом "${table.components[handle]!}" (ECS-7), поле "${table.fields[handle]!}"`,
      'COMPONENT_READ_WITHOUT_OWNERSHIP',
    );
  }
  return table.arrays[handle]![index]!;
}

/** Владение компонентом по handle (SYS-10) — то же, что строковый `hasComponent` после резолва. */
export function ownsByHandle(
  world: FieldReadSource,
  entity: EntityId,
  handle: ComponentHandle,
): boolean {
  const index = aliveIndexOf(world.entities, entity);
  return index >= 0 && maskHas(world.masks, index, handle);
}
