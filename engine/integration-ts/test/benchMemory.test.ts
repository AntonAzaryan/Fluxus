/**
 * Помощник сторожей памяти (`engine/tests/bench/memory.ts`, `performance-budget`
 * PERF-10, PERF-11) — проверка самого прибора, а не движка.
 *
 * Прибор обязан работать там, где идут тесты, и мерить то, что обещает: после
 * принудительной сборки отпущенный массив не числится в куче, а окно тиков без
 * сборки отдаёт байты, а не ноль «потому что не смотрели».
 *
 * Живёт в интеграционной сюите потому же, почему в ней живут сторожа PERF-10 и
 * PERF-11: у каталога `engine/tests/` своего проекта тестов нет, а прибор общий
 * для нескольких пакетов.
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  allocationWindow,
  forceGc,
  growthOf,
  mib,
  observeGc,
  sampleMemory,
  type GcCounts,
} from '../../tests/bench/memory.js';

/** Байтов в отпускаемом массиве: заметно больше дрожания кучи между пробами. */
const BIG_ARRAY_BYTES = 64 * 1024 * 1024;

describe('PERF-10: проба занятой памяти после принудительной сборки', () => {
  it('отпущенный большой массив в куче не числится', () => {
    const before = sampleMemory();
    let held: number[] | null = Array.from({ length: BIG_ARRAY_BYTES / 8 }, (_, i) => i);
    const during = sampleMemory();
    // Массив жив — куча выросла на его порядок: без этого утверждения проверка
    // ниже прошла бы и на приборе, который ничего не меряет.
    expect(during.heapUsed - before.heapUsed).toBeGreaterThan(BIG_ARRAY_BYTES / 2);

    held = null;
    const after = sampleMemory();

    // Отпущенное собрано: рост относительно начала окна — доли процента, а не
    // порядок. Точного равенства здесь быть не может и требовать его нельзя:
    // куча живёт своей жизнью (PERF-10, ассерт только о РОСТЕ).
    const growth = growthOf(before, after);
    expect(growth.heapUsed).toBeLessThan(BIG_ARRAY_BYTES / 4);
    expect(held).toBeNull();
  });

  it('рост отнесён к началу окна и считает и кучу, и байты буферов', () => {
    const before = { heapUsed: 200, arrayBuffers: 10 };
    const after = { heapUsed: 250, arrayBuffers: 30 };
    const growth = growthOf(before, after);
    expect(growth.heapUsed).toBe(50);
    expect(growth.arrayBuffers).toBe(20);
    // (50 + 20) / (200 + 10): занятая память — обе величины, которые называет
    // PERF-10. Утечка типизированного массива живёт в буферах, и по одной куче
    // её было бы не видно.
    expect(growth.ratio).toBeCloseTo(70 / 210, 10);
  });

  it('печать величин — мегабайтами, читать их и есть смысл сторожа', () => {
    expect(mib(1024 * 1024)).toBe('1.00 МиБ');
  });

  /**
   * Флаг включается на лету (`v8.setFlagsFromString`), а не командной строкой —
   * ровно затем, чтобы прибор работал в любом пуле раннера. Гейт идёт форками,
   * попакетные прогоны — тоже, но worker thread проверяется отдельно: механизм
   * обязан пережить и его, иначе смена пула молча оставила бы сторожей без
   * сборки.
   */
  it('механизм принудительной сборки работает и в worker thread', async () => {
    const source = `
      const { setFlagsFromString } = require('node:v8');
      const { runInNewContext } = require('node:vm');
      const { parentPort } = require('node:worker_threads');
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc');
      setFlagsFromString('--no-expose-gc');
      gc();
      parentPort.postMessage(typeof gc);
    `;
    const kind = await new Promise<string>((resolve, reject) => {
      const worker = new Worker(source, { eval: true });
      worker.once('message', (value: string) => {
        resolve(value);
      });
      worker.once('error', reject);
    });
    expect(kind).toBe('function');
    // И в текущем окружении прогона тоже: без этого проверка выше говорила бы
    // только о чужом изоляте.
    expect(() => {
      forceGc();
    }).not.toThrow();
  });
});

/**
 * Расписание сборщика — НЕ предмет этих проверок и предметом быть не может.
 *
 * Момент сборки решает V8, и решает он его по состоянию своей кучи: в общем
 * пуле гейта тот же файл идёт в воркере, чья куча уже выросла вместе с молодым
 * поколением, и цикл, гарантированно вызывавший scavenge в одиночном прогоне,
 * в пуле его не вызывает. Ассерт «сборка обязана случиться» сделал бы вердикт
 * гейта функцией расписания сборщика, а не дерева (CLI-13), и сторожа PERF-5
 * прямо запрещают гейтить жёстче порядка величины.
 *
 * Поэтому здесь проверяется КОНТРАКТ помощника: результат хорошо оформлен,
 * «окна без сборки нет» — законный исход, а измеренное печатается. Наблюдение
 * сборок ищется ограниченной серией попыток с растущим мусором и, не найдясь,
 * печатается как «не измерено», а не роняет прогон.
 */
describe('PERF-11: наблюдатель сборщика и окно без сборки', () => {
  /** Попыток нарастить мусор, пока наблюдатель не увидит сборку. */
  const GARBAGE_ATTEMPTS = 5;

  it('наблюдатель видит сборки на растущем мусоре — либо честно говорит, что не увидел', async () => {
    let observed = zeroCounts();
    let objects = 0;
    for (let attempt = 0; attempt < GARBAGE_ATTEMPTS; attempt++) {
      objects = 200_000 * 2 ** attempt;
      const watch = observeGc();
      let sink = 0;
      for (let i = 0; i < objects; i++) {
        const garbage = { a: i, b: `${i}`, c: [i, i + 1] };
        sink += garbage.c.length;
      }
      expect(sink).toBeGreaterThan(0);
      observed = await watch.take();
      watch.stop();
      if (observed.total > 0) break;
    }
    console.log(
      observed.total > 0
        ? `[bench] наблюдатель сборщика: ${observed.minor} малых и ${observed.major} полных сборок ` +
            `на ${objects.toLocaleString('ru-RU')} объектов`
        : `[bench] наблюдатель сборщика: сборок не наблюдалось за ${GARBAGE_ATTEMPTS} попыток ` +
            `(до ${objects.toLocaleString('ru-RU')} объектов) — не измерено, среда решила не собирать`,
    );
    // Контракт: счёт по видам — целые неотрицательные, и сумма их не меньше
    // любого из них. Число сборок здесь не ассертится ни в какую сторону.
    for (const value of Object.values(observed)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(observed.total).toBeGreaterThanOrEqual(observed.minor);
  });

  it('окно без аллокаций: найдено — байты малы, не найдено — ноль вместо выдумки', async () => {
    let sink = 0;
    const window = await allocationWindow((ticks) => {
      // Работа без аллокаций: целочисленная арифметика в локальной переменной.
      for (let i = 0; i < ticks; i++) sink = (sink + i) | 0;
    }, 16);
    expect(sink).toBeGreaterThanOrEqual(0);
    // Форма результата — контракт, и он держится при любом решении сборщика.
    expect(window.attempts).toBeGreaterThanOrEqual(1);
    expect(window.ticks).toBeGreaterThanOrEqual(1);
    if (window.found) {
      expect(window.collections).toBe(0);
      // Цикл не аллоцирует — окно обязано это показать, а не выдать шум за
      // аллокации. Запас на служебную запись самого замера.
      expect(window.bytes).toBeLessThan(64 * 1024);
    } else {
      // «Окна без сборки нет» — законный исход (PERF-11), и байтов у него нет:
      // ноль здесь означает «не измерено», а не «ноль аллокаций».
      expect(window.bytes).toBe(0);
      expect(window.collections).toBeGreaterThan(0);
      console.log('[bench] окно без сборки не нашлось на нулевой нагрузке — не измерено');
    }
  });

  it('окно с тяжёлыми аллокациями: либо сузилось, либо честно не нашлось', async () => {
    // Каждый «тик» аллоцирует мегабайт: окно обязано либо сузиться, либо
    // сказать «не нашлось» — привраться разностью, из которой сборщик уже
    // что-то стёр, помощник не вправе ни в каком случае.
    const window = await allocationWindow((ticks) => {
      for (let i = 0; i < ticks; i++) {
        const chunk = new Array<number>(128 * 1024).fill(i);
        if (chunk.length === 0) throw new Error('недостижимо');
      }
    }, 512, 3);
    if (window.found) {
      expect(window.collections).toBe(0);
      // Окно, найденное с первой попытки, — это окно исходной ширины; сузилось
      // — значит попытки были. И то и другое законно: решает сборщик.
      if (window.attempts > 1) expect(window.ticks).toBeLessThan(512);
    } else {
      expect(window.bytes).toBe(0);
      expect(window.attempts).toBe(3);
    }
    console.log(
      window.found
        ? `[bench] окно без сборки: ${window.ticks} тиков, ${window.bytes.toLocaleString('ru-RU')} байт ` +
            `(попыток ${window.attempts})`
        : `[bench] окна без сборки нет за ${window.attempts} попыток — не измерено`,
    );
  });
});

/** Счётчики сборок нулями — стартовое значение серии попыток выше. */
function zeroCounts(): GcCounts {
  return { minor: 0, major: 0, incremental: 0, weakCallback: 0, total: 0 };
}
