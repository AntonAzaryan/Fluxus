import { describe, expect, it, vi } from 'vitest';
import { withDiagnostics } from '../src/debug.js';
import type { DiagnosticRecord, DiagnosticsSink } from '../src/types.js';
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

  it('ID-6: спавн после смерти занимает последний освобождённый слот, а не новый', () => {
    const idx = createEntityIndex(16);
    const ids = Array.from({ length: 8 }, () => allocate(idx)); // индексы 0..7
    free(idx, ids[7] as number);

    const reused = allocate(idx);

    expect(indexOf(reused)).toBe(7);
    // Счётчик не сдвинулся: слот пришёл из списка, а не «очередной новый» (ID-2).
    expect(idx.nextIndex).toBe(8);
    expect(idx.freeList).toEqual([]);
  });

  it('ID-6: две смерти подряд — спавн берёт слот, освобождённый вторым, а не наименьший', () => {
    // Сценарий ID-6 «Две смерти и один спавн»: слоты 2 и 5 освобождаются именно
    // в этом порядке, поэтому стек отдаёт 5. «Наименьший свободный» отдал бы 2.
    const idx = createEntityIndex(8);
    const ids = Array.from({ length: 6 }, () => allocate(idx)); // индексы 0..5

    free(idx, ids[2] as number);
    free(idx, ids[5] as number);

    expect(indexOf(allocate(idx))).toBe(5);
    expect(indexOf(allocate(idx))).toBe(2);
  });

  it('ID-6: при пустом списке берётся очередной новый слот по счётчику', () => {
    const idx = createEntityIndex(8);
    const first = allocate(idx);
    free(idx, first);
    allocate(idx); // выбирает список досуха

    expect(idx.freeList).toEqual([]);
    const fresh = allocate(idx);

    expect(indexOf(fresh)).toBe(1); // слот 0 занят, список пуст — очередной новый
    expect(idx.nextIndex).toBe(2);
  });

  it('ID-6/ID-1: аллокация при непустом списке и nextIndex == capacity законна', () => {
    // Жёсткая граница ID-1 названа только для пустого списка: слоты за счётчиком
    // кончились, но освобождённый слот выдаётся, а не считается исчерпанием.
    const idx = createEntityIndex(2);
    const first = allocate(idx);
    allocate(idx);
    expect(idx.nextIndex).toBe(idx.capacity);

    free(idx, first);
    expect(() => allocate(idx)).not.toThrow();
    expect(idx.nextIndex).toBe(2);
    // Список снова пуст — следующая аллокация упирается в границу ID-1.
    expect(() => allocate(idx)).toThrow(/capacity/i);
  });

  it('ID-2: три спавна при пустом списке — последовательные индексы, счётчик вырастает на три', () => {
    const idx = createEntityIndex(8);
    const before = idx.nextIndex;
    const ids = [allocate(idx), allocate(idx), allocate(idx)];

    expect(ids.map(indexOf)).toEqual([0, 1, 2]);
    expect(idx.nextIndex).toBe(before + 3);
  });

  it('ID-2: три спавна при непустом списке берут слоты из списка, счётчик не двигается', () => {
    const idx = createEntityIndex(8);
    const ids = Array.from({ length: 5 }, () => allocate(idx)); // индексы 0..4
    for (const slot of [1, 3, 0]) free(idx, ids[slot] as number);
    const counterBefore = idx.nextIndex;

    const reused = [allocate(idx), allocate(idx), allocate(idx)].map(indexOf);

    expect(reused).toEqual([0, 3, 1]); // LIFO от порядка освобождения
    expect(reused).not.toEqual([...reused].sort((a, b) => a - b)); // не последовательные
    expect(idx.nextIndex).toBe(counterBefore);
  });

  it('ID-2: удаление не уменьшает счётчик', () => {
    const idx = createEntityIndex(8);
    const ids = Array.from({ length: 4 }, () => allocate(idx));
    expect(idx.nextIndex).toBe(4);

    for (const id of ids) free(idx, id);

    expect(idx.nextIndex).toBe(4); // верхняя граница когда-либо занятых слотов
    expect(idx.aliveCount).toBe(0);
    expect(idx.freeList).toEqual([0, 1, 2, 3]);
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

    const entries: DiagnosticRecord[] = [];
    const sink: DiagnosticsSink = { trace: 'off', record: (entry) => entries.push(entry) };

    // free() не бросает: диагностика уходит в sink, а generation молча заворачивается к 0
    // через `% GENERATION_LIMIT` — то же самое значение, что было бы и в release-сборке.
    expect(() => withDiagnostics(sink, 1, () => free(idx, staleId))).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.code).toBe('ENTITY_GENERATION_OVERFLOW');
    expect(idx.generations[0]).toBe(0);
  });
});
