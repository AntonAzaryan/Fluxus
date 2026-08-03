/**
 * EntityIndex: sparse-set с поколениями (ID-1..ID-5, DET-6). Собственная
 * реализация вместо bitecs — вся логика генерации ID под нашим контролем,
 * что и нужно для CORE-2: вторая (Rust) реализация обязана воспроизводить
 * ровно этот алгоритм, а не внутренности сторонней библиотеки.
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

export interface EntityIndex {
  readonly capacity: number;
  /** Поколение по raw-индексу (ID-3). */
  generations: Uint32Array;
  /** 1 — слот занят живой сущностью, 0 — свободен. */
  alive: Uint8Array;
  /** Стек освобождённых индексов, LIFO — переиспользование детерминировано. */
  freeList: number[];
  /** Монотонный счётчик новых raw-индексов (ID-2). */
  nextIndex: number;
  aliveCount: number;
}

/** ID-4: только TypedArray/число/массив чисел — тривиально клонируется и сериализуется. */
export function createEntityIndex(capacity: number): EntityIndex {
  assertInvariant(
    Number.isInteger(capacity) && capacity > 0 && capacity <= GENERATION_LIMIT,
    `EntityIndex: недопустимая capacity ${capacity}`,
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
  );
  assertInvariant(
    Number.isInteger(generation) && generation >= 0 && generation <= MAX_GENERATION,
    `EntityIndex: generation вне диапазона: ${generation}`,
  );
  return index + generation * GENERATION_LIMIT;
}

export function indexOf(id: EntityId): number {
  return id % GENERATION_LIMIT;
}

export function generationOf(id: EntityId): number {
  return Math.floor(id / GENERATION_LIMIT);
}

/** ID-2/DET-6: сперва LIFO из freeList, иначе — очередной nextIndex. Бросает при исчерпании capacity. */
export function allocate(idx: EntityIndex): EntityId {
  let index: number;
  const fromFree = idx.freeList.pop();
  if (fromFree !== undefined) {
    index = fromFree;
  } else {
    assertInvariant(idx.nextIndex < idx.capacity, `EntityIndex: превышена capacity (${idx.capacity})`);
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
  if (DEBUG) assert(current < MAX_GENERATION, `EntityIndex: переполнение generation на слоте ${index}`);
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
