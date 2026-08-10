/**
 * EntityIndex: sparse-set с поколениями (ID-1..ID-6, DET-6). Собственная
 * реализация вместо bitecs — вся логика генерации ID под нашим контролем,
 * что и нужно для CORE-2: вторая (Rust) реализация обязана воспроизводить
 * ровно этот алгоритм, а не внутренности сторонней библиотеки.
 *
 * Политика выделения слота — не свойство этой реализации, а норма ID-6:
 * свободные слоты держатся стеком, освобождение кладёт слот в конец, аллокация
 * берёт с конца, при пустом стеке берётся очередной новый слот по счётчику
 * (ID-2). Номер слота наблюдаем геймплеем через порядок обхода запроса
 * (QUERY-2), поэтому порт обязан воспроизводить именно это правило.
 *
 * Упаковка EntityId: `id = index + generation * 2^24`, index и generation —
 * по 24 бита, итого 48 бит. Это БОЛЬШЕ 32 бит, на которые рассчитаны битовые
 * операторы JS (`<<`, `|`, `>>>` приводят операнды через ToInt32/ToUint32 —
 * усечение до 32 бит с потерей знака/данных). Поэтому упаковка и распаковка
 * идут арифметикой (`+`, `*`, `%`, `Math.floor`): целые числа до 2^53 в double
 * точны, а 2^48 гарантированно влезает. В Rust та же величина — u64, и то же
 * арифметическое правило (без сдвигов) тривиально воспроизводится побитово.
 */
import { DEBUG, assert, assertInvariant } from '../debug.js';
import type { EntityId } from '../types.js';

/** index и generation — по 24 бита каждый (см. упаковку в комментарии выше). */
const INDEX_BITS = 24;
/** Модуль упаковки: одновременно и предел index, и предел generation. */
const GENERATION_LIMIT = 2 ** INDEX_BITS; // 16 777 216
const MAX_INDEX = GENERATION_LIMIT - 1;
const MAX_GENERATION = GENERATION_LIMIT - 1;

/**
 * Предел упаковки: `makeEntityId(MAX_INDEX, MAX_GENERATION)`, то есть 2^48 - 1.
 * Нужен проверке представимости значения в поле типа `entity` (ECS-3, ECS-6):
 * граница диапазона там та же, что у самой упаковки, и второй её записи рядом
 * быть не должно.
 */
export const MAX_ENTITY_ID = GENERATION_LIMIT * GENERATION_LIMIT - 1;

export interface EntityIndex {
  readonly capacity: number;
  /** Поколение по raw-индексу (ID-3). */
  generations: Uint32Array;
  /** 1 — слот занят живой сущностью, 0 — свободен. */
  alive: Uint8Array;
  /** Стек освобождённых индексов, LIFO по ID-6; часть состояния схемы ID (ID-4). */
  freeList: number[];
  /** Счётчик слотов: верхняя граница когда-либо занятых, монотонен (ID-2). */
  nextIndex: number;
  aliveCount: number;
}

/** ID-4: только TypedArray/число/массив чисел — тривиально клонируется и сериализуется. */
export function createEntityIndex(capacity: number): EntityIndex {
  assertInvariant(
    Number.isInteger(capacity) && capacity > 0 && capacity <= GENERATION_LIMIT,
    `EntityIndex: недопустимая capacity ${capacity}`,
    'ENTITY_CAPACITY_EXCEEDED',
  );
  return {
    capacity,
    generations: new Uint32Array(capacity),
    alive: new Uint8Array(capacity),
    freeList: [],
    nextIndex: 0,
    aliveCount: 0,
  };
}

/** Упаковка index+generation в один EntityId — арифметикой, см. комментарий в шапке файла. */
export function makeEntityId(index: number, generation: number): EntityId {
  assertInvariant(
    Number.isInteger(index) && index >= 0 && index <= MAX_INDEX,
    `EntityIndex: index вне диапазона: ${index}`,
    'ENTITY_ID_OUT_OF_RANGE',
  );
  assertInvariant(
    Number.isInteger(generation) && generation >= 0 && generation <= MAX_GENERATION,
    `EntityIndex: generation вне диапазона: ${generation}`,
    'ENTITY_ID_OUT_OF_RANGE',
  );
  return index + generation * GENERATION_LIMIT;
}

export function indexOf(id: EntityId): number {
  return id % GENERATION_LIMIT;
}

/**
 * DET-2, условия 3 и 4. Делимое — идентификатор, собранный упаковкой: по модулю
 * меньше 2^48 < 2^53, поэтому приведённое частное точно.
 *
 * Делимое БЫВАЕТ отрицательным, и это не мусор на входе, а штатное значение
 * ядра: `-1` — кодировка «ссылки нет» поля типа `entity` (ECS-6), и она
 * попадает сюда каждым чтением такого поля. `floor` и усечение к нулю на нём
 * расходятся (`-1` против `0`), но расхождение ненаблюдаемо, и вот почему:
 * распаковка индекса идёт остатком, а `indexOf(-1) = -1` при обеих конвенциях —
 * слота с таким номером в массивах нет. `isAlive` поэтому отвечает `false`, не
 * дойдя до сравнения поколений (`alive[-1]` — `undefined`), а `free` до
 * сравнения доходит, но `generations[-1]` там тоже `undefined`, и несовпадение
 * даёт no-op при любой конвенции. Ни одна ветка от выбора округления не
 * зависит, поэтому переписывать площадку не на что.
 */
export function generationOf(id: EntityId): number {
  return Math.floor(id / GENERATION_LIMIT);
}

/**
 * Сколько ещё сущностей примет индекс: освобождённые слоты плюс неиспользованные
 * индексы (ID-2). Нужно тому, кто обязан узнать об исчерпании ёмкости ДО
 * аллокации, — двухпроходному flush'у буфера команд (SYS-9).
 */
export function room(idx: EntityIndex): number {
  return idx.freeList.length + (idx.capacity - idx.nextIndex);
}

/**
 * Отказ по ёмкости — одной формулировкой и одним кодом для обоих вызывающих:
 * самой аллокации и проверки перед ней. Второй текст рядом разошёлся бы с этим.
 */
export function assertRoom(idx: EntityIndex, available: number): void {
  assertInvariant(
    available > 0,
    `EntityIndex: превышена capacity (${idx.capacity})`,
    'ENTITY_CAPACITY_EXCEEDED',
  );
}

/**
 * ID-6: слот берётся с конца `freeList` (последний освобождённый — первый
 * переиспользованный), при пустом списке — очередной `nextIndex` с инкрементом
 * счётчика (ID-2). Оба конца стека нормированы: «LIFO» без указания, куда
 * кладёт `free`, последовательности не задавало бы. Исчерпание `capacity` при
 * пустом списке — жёсткая граница ID-1, бросает.
 */
export function allocate(idx: EntityIndex): EntityId {
  let index: number;
  const fromFree = idx.freeList.pop();
  if (fromFree !== undefined) {
    index = fromFree;
  } else {
    assertRoom(idx, idx.capacity - idx.nextIndex);
    index = idx.nextIndex;
    idx.nextIndex++;
  }
  idx.alive[index] = 1;
  idx.aliveCount++;
  return makeEntityId(index, idx.generations[index] ?? 0);
}

/**
 * ID-3: инкремент generation делает старые ссылки на слот невалидными.
 * Повторное освобождение и освобождение по устаревшей ссылке — no-op, а не
 * ошибка и не порча чужой (новой) сущности в том же слоте.
 *
 * ID-6: слот уходит в КОНЕЦ `freeList` — тот же конец, с которого его снимет
 * `allocate`. Счётчик при этом не трогается (ID-2): уменьшение открыло бы
 * повторной аллокации слот, который может быть занят. Момент попадания в
 * список — применение команды `destroy` на flush (CMD-3), а не её постановка,
 * иначе отложенность мутаций (CMD-1) стала бы наблюдаемой через идентификатор
 * следующего спавна.
 */
export function free(idx: EntityIndex, id: EntityId): void {
  const index = indexOf(id);
  if (index >= idx.capacity) return; // индекс вне диапазона — точно не наша сущность
  if (idx.alive[index] === 0) return; // уже свободен
  if (idx.generations[index] !== generationOf(id)) return; // устаревшая ссылка на переиспользованный слот

  idx.alive[index] = 0;
  idx.aliveCount--;

  // Переполнение generation (redo 2^24 раз один слот): в debug — assert, это
  // сигнал, что стоит разобраться, откуда столько переиспользований; в
  // release — тихий wrap к 0 через модуль. Поведение одинаковое в TS и Rust
  // (Rust-generation — u32/u64 со своим wrapping_add), поэтому wrap явный
  // через `%`, а не побочный эффект переполнения типа.
  const current = idx.generations[index] ?? 0;
  if (DEBUG) {
    assert(
      current < MAX_GENERATION,
      `EntityIndex: переполнение generation на слоте ${index}`,
      'ENTITY_GENERATION_OVERFLOW',
    );
  }
  idx.generations[index] = (current + 1) % GENERATION_LIMIT;

  idx.freeList.push(index);
}

/** ID-1/ID-3: живая проверка ссылки — совпадение и index, и generation. */
export function isAlive(idx: EntityIndex, id: EntityId): boolean {
  const index = indexOf(id);
  if (index >= idx.capacity) return false;
  return idx.alive[index] === 1 && idx.generations[index] === generationOf(id);
}

/**
 * Снапшот живых EntityId строго по возрастанию raw-индекса (QUERY-2 опирается
 * на этот порядок выше по стеку). Обход слотов 0..nextIndex даёт возрастание
 * по построению — сортировка не нужна и не делается.
 *
 * Контейнер — Float64Array, а не Uint32Array (ID-1): EntityId 48-битный, и
 * запись в 32-битный массив молча усекала бы его начиная с generation = 256 —
 * то есть уже в пределах одного матча для часто переиспользуемого слота.
 * Целые до 2^53 в double точны, поэтому Float64Array хранит id без потерь.
 */
export function aliveEntities(idx: EntityIndex): Float64Array {
  const result = new Float64Array(idx.aliveCount);
  let cursor = 0;
  for (let i = 0; i < idx.nextIndex; i++) {
    if (idx.alive[i] === 1) {
      result[cursor] = makeEntityId(i, idx.generations[i] ?? 0);
      cursor++;
    }
  }
  return result;
}

/** ID-4: глубокая копия, независимая от оригинала — нужно для снапшотов/rewind. */
export function cloneEntityIndex(idx: EntityIndex): EntityIndex {
  return {
    capacity: idx.capacity,
    generations: idx.generations.slice(),
    alive: idx.alive.slice(),
    freeList: [...idx.freeList],
    nextIndex: idx.nextIndex,
    aliveCount: idx.aliveCount,
  };
}
