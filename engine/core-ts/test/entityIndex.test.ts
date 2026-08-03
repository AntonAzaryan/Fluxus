import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAssertSink } from '../src/debug.js';
import {
  allocate,
  aliveEntities,
  cloneEntityIndex,
  createEntityIndex,
  free,
  generationOf,
  indexOf,
  isAlive,
  makeEntityId,
} from '../src/ecs/entityIndex.js';

const MAX_INDEX = 2 ** 24 - 1;
const MAX_GENERATION = 2 ** 24 - 1;

/** Импортирует entityIndex.ts заново под заданным NODE_ENV, чтобы проверить release-сборку. */
async function importEntityIndexUnder(nodeEnv: string): Promise<typeof import('../src/ecs/entityIndex.js')> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  try {
    return await import('../src/ecs/entityIndex.js');
  } finally {
    process.env.NODE_ENV = prev;
    vi.resetModules();
  }
}

afterEach(() => {
  setAssertSink(() => {});
});

describe('entityIndex', () => {
  it('ID-2/DET-6: последовательные allocate дают предсказуемые индексы; повтор с нуля даёт те же id', () => {
    function run() {
      const idx = createEntityIndex(8);
      return [allocate(idx), allocate(idx), allocate(idx)];
    }
    const first = run();
    const second = run();
    expect(first.map(indexOf)).toEqual([0, 1, 2]);
    expect(first).toEqual(second);
  });

  it('ID-3: освобождение и повторная аллокация переиспользуют слот с инкрементом generation', () => {
    const idx = createEntityIndex(4);
    const first = allocate(idx);
    free(idx, first);
    const second = allocate(idx);

    expect(indexOf(second)).toBe(indexOf(first));
    expect(generationOf(second)).toBe(generationOf(first) + 1);
    expect(isAlive(idx, first)).toBe(false);
    expect(isAlive(idx, second)).toBe(true);
  });

  it('освобождение по устаревшей ссылке не убивает новую сущность в том же слоте', () => {
    const idx = createEntityIndex(4);
    const oldId = allocate(idx);
    free(idx, oldId);
    const newId = allocate(idx); // тот же raw-индекс, generation+1

    free(idx, oldId); // устаревшая ссылка — no-op, не должна тронуть newId

    expect(isAlive(idx, newId)).toBe(true);
    expect(idx.aliveCount).toBe(1);
  });

  it('повторное освобождение — не ошибка, а no-op', () => {
    const idx = createEntityIndex(4);
    const id = allocate(idx);
    free(idx, id);

    expect(() => free(idx, id)).not.toThrow();
    expect(idx.aliveCount).toBe(0);
  });

  it('LIFO: порядок переиспользования освобождённых слотов детерминирован', () => {
    const idx = createEntityIndex(8);
    const ids = [
      allocate(idx),
      allocate(idx),
      allocate(idx),
      allocate(idx),
      allocate(idx),
      allocate(idx),
    ]; // raw-индексы 0..5

    free(idx, ids[5] as number); // индекс 5
    free(idx, ids[2] as number); // индекс 2, освобождён последним

    const next1 = allocate(idx);
    expect(indexOf(next1)).toBe(2); // LIFO: последний освобождённый — первый переиспользованный

    const next2 = allocate(idx);
    expect(indexOf(next2)).toBe(5);
  });

  it('упаковка/распаковка на граничных значениях остаётся точным целым числом', () => {
    const id = makeEntityId(MAX_INDEX, MAX_GENERATION);

    expect(Number.isSafeInteger(id)).toBe(true);
    expect(indexOf(id)).toBe(MAX_INDEX);
    expect(generationOf(id)).toBe(MAX_GENERATION);
  });

  it('aliveEntities: строго возрастающий порядок raw-индексов, включая после free/allocate вперемешку', () => {
    const idx = createEntityIndex(8);
    const ids = Array.from({ length: 6 }, () => allocate(idx)); // индексы 0..5

    free(idx, ids[3] as number);
    free(idx, ids[1] as number);
    allocate(idx); // переиспользует индекс 1 (последний освобождённый, LIFO)
    free(idx, ids[5] as number);

    const indices = Array.from(aliveEntities(idx), indexOf);

    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices).toEqual([0, 1, 2, 4]); // живы: 0,1(новое поколение),2,4; 3 и 5 свободны
  });

  it('cloneEntityIndex: мутация клона не задевает оригинал и наоборот', () => {
    const idx = createEntityIndex(4);
    allocate(idx);
    const clone = cloneEntityIndex(idx);

    clone.generations[0] = 42;
    clone.alive[0] = 0;
    clone.freeList.push(99);
    clone.nextIndex = 100;
    clone.aliveCount = 100;

    expect(idx.generations[0]).toBe(0);
    expect(idx.alive[0]).toBe(1);
    expect(idx.freeList).toEqual([]);
    expect(idx.nextIndex).toBe(1);
    expect(idx.aliveCount).toBe(1);
  });

  it('ID-1: исчерпание capacity — жёсткая граница рождения EntityId, бросает в обоих режимах сборки', async () => {
    const idx = createEntityIndex(2);
    allocate(idx);
    allocate(idx);
    expect(() => allocate(idx)).toThrow(/capacity/i);

    const release = await importEntityIndexUnder('production');
    const relIdx = release.createEntityIndex(2);
    release.allocate(relIdx);
    release.allocate(relIdx);
    expect(() => release.allocate(relIdx)).toThrow(/capacity/i);
  });

  it('ID-1: createEntityIndex с недопустимой capacity — assertInvariant, бросает в обоих режимах', async () => {
    expect(() => createEntityIndex(0)).toThrow();
    expect(() => createEntityIndex(-1)).toThrow();
    expect(() => createEntityIndex(1.5)).toThrow();

    const release = await importEntityIndexUnder('production');
    expect(() => release.createEntityIndex(0)).toThrow();
  });

  it('ID-1: makeEntityId с index/generation вне 24 бит — assertInvariant, бросает в обоих режимах', async () => {
    expect(() => makeEntityId(MAX_INDEX + 1, 0)).toThrow();
    expect(() => makeEntityId(0, MAX_GENERATION + 1)).toThrow();
    expect(() => makeEntityId(-1, 0)).toThrow();

    const release = await importEntityIndexUnder('production');
    expect(() => release.makeEntityId(MAX_INDEX + 1, 0)).toThrow();
  });

  it('id часто переиспользуемого слота не усекается в контейнере результата (ID-1)', () => {
    // Регрессия на реальный баг: пока aliveEntities возвращал Uint32Array,
    // при generation >= 256 старшие биты 48-битного id молча терялись, и
    // вызывающий получал идентификатор несуществующей сущности.
    const idx = createEntityIndex(4);
    for (let i = 0; i < 300; i++) {
      free(idx, allocate(idx)); // 300 переиспользований слота 0
    }
    const id = allocate(idx);
    expect(generationOf(id)).toBe(300);
    expect(id).toBeGreaterThan(0xffffffff); // не помещается в 32 бита

    const listed = aliveEntities(idx);
    expect(listed[0]).toBe(id);
    expect(isAlive(idx, listed[0]!)).toBe(true);
  });

  it('переполнение generation: мягкий assert (sink, не throw) — значение заворачивается одинаково в debug и release', () => {
    const idx = createEntityIndex(1);
    allocate(idx);
    idx.generations[0] = MAX_GENERATION; // симулируем слот, переиспользованный 2^24-1 раз
    const staleId = makeEntityId(0, MAX_GENERATION);

    const sink = vi.fn();
    setAssertSink(sink);

    // free() не бросает: диагностика уходит в sink, а generation молча заворачивается к 0
    // через `% GENERATION_LIMIT` — то же самое значение, что было бы и в release-сборке.
    expect(() => free(idx, staleId)).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatch(/generation/i);
    expect(idx.generations[0]).toBe(0);
  });
});
