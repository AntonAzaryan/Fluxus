import { describe, expect, it, vi } from 'vitest';
import {
  createRngRegistry,
  fixDegenerateState,
  fnv1a32,
  seedStateFromName,
  splitmix32,
  XorShift128Stream,
} from '../src/math/rng.js';

/** Импортирует rng.ts заново под заданным NODE_ENV, чтобы проверить release-сборку (RNG-8). */
async function importRngUnder(nodeEnv: string): Promise<typeof import('../src/math/rng.js')> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  try {
    return await import('../src/math/rng.js');
  } finally {
    process.env.NODE_ENV = prev;
    vi.resetModules();
  }
}

describe('воспроизводимость и независимость стримов', () => {
  it('одинаковые worldSeed + имя -> идентичная последовательность', () => {
    const a = new XorShift128Stream(seedStateFromName(42, 'DamageSystem'));
    const b = new XorShift128Stream(seedStateFromName(42, 'DamageSystem'));
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('RNG-2: лишний next() в одном стриме не сдвигает другой', () => {
    const registry = createRngRegistry(7);
    const a1 = registry.forSystem('A').stream();
    const b1 = registry.forSystem('B').stream();

    const expectedB = Array.from({ length: 5 }, () => b1.next());

    // независимый прогон: A тратит несколько next() между обращениями к B
    const registry2 = createRngRegistry(7);
    const a2 = registry2.forSystem('A').stream();
    const b2 = registry2.forSystem('B').stream();
    const actualB: number[] = [];
    for (let i = 0; i < 5; i++) {
      a2.next(); // лишние вызовы в system A
      a2.next();
      actualB.push(b2.next());
    }
    expect(actualB).toEqual(expectedB);
    void a1;
  });

  it('RNG-3: разный worldSeed -> разные последовательности при том же имени', () => {
    const a = new XorShift128Stream(seedStateFromName(1, 'DamageSystem'));
    const b = new XorShift128Stream(seedStateFromName(2, 'DamageSystem'));
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('RNG-7: формат имени суб-стрима и развёртка seed', () => {
  it('stream("crits") в системе DamageSystem хеширует "DamageSystem/crits"', () => {
    const registry = createRngRegistry(99);
    const sub = registry.forSystem('DamageSystem').stream('crits');
    const direct = new XorShift128Stream(seedStateFromName(99, 'DamageSystem/crits'));
    expect(sub.next()).toBe(direct.next());
    expect(sub.next()).toBe(direct.next());
  });

  it('повторный stream() по тому же имени продолжает последовательность, а не пересидивает', () => {
    const registry = createRngRegistry(5);
    const s1 = registry.forSystem('X').stream();
    const first = s1.next();
    const s2 = registry.forSystem('X').stream(); // тот же реестр, то же имя
    const second = s2.next();

    const reference = new XorShift128Stream(seedStateFromName(5, 'X'));
    expect(first).toBe(reference.next());
    expect(second).toBe(reference.next());
  });

  it('порядок байт: worldSeed подаётся в hash little-endian', () => {
    const worldSeed = 0x01020304;
    const streamName = 'X';

    // Независимая от rng.ts сборка LE-байт через DataView (стандартная библиотека,
    // не наша ручная битовая арифметика) — проверяет именно порядок байт RNG-7.
    const buf = new ArrayBuffer(4 + streamName.length);
    const view = new DataView(buf);
    view.setUint32(0, worldSeed, true); // true = little-endian
    new Uint8Array(buf).set(new TextEncoder().encode(streamName), 4);
    const expectedHash = fnv1a32(new Uint8Array(buf));

    let z = expectedHash;
    const expectedState = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      const step = splitmix32(z);
      z = step.z;
      expectedState[i] = step.r;
    }

    expect(seedStateFromName(worldSeed, streamName)).toEqual(fixDegenerateState(expectedState));

    // Сверка от противного: big-endian сборка тех же байт дала бы другой seed.
    const beBuf = new ArrayBuffer(4 + streamName.length);
    new DataView(beBuf).setUint32(0, worldSeed, false); // false = big-endian
    new Uint8Array(beBuf).set(new TextEncoder().encode(streamName), 4);
    const beHash = fnv1a32(new Uint8Array(beBuf));
    expect(beHash).not.toBe(expectedHash);
  });
});

describe('RNG-1: вырожденное нулевое состояние', () => {
  it('(0,0,0,0) заменяется на каноническое ненулевое, генератор не залипает', () => {
    const fixed = fixDegenerateState(new Uint32Array([0, 0, 0, 0]));
    expect(fixed).toEqual(new Uint32Array([0, 0, 0, 1]));

    const stream = new XorShift128Stream(fixed);
    const values = Array.from({ length: 10 }, () => stream.next());
    expect(values.some((v) => v !== 0)).toBe(true);
  });

  it('ненулевое состояние fixDegenerateState не трогает', () => {
    const state = new Uint32Array([1, 2, 3, 4]);
    expect(fixDegenerateState(state)).toEqual(new Uint32Array([1, 2, 3, 4]));
  });
});

describe('RNG-5: getState/setState — снапшот', () => {
  it('сохранил, сделал N шагов, восстановил, повторил — те же значения', () => {
    const stream = new XorShift128Stream(seedStateFromName(123, 'SnapshotSystem'));
    stream.next();
    stream.next();
    const snapshot = stream.getState();

    const runA = Array.from({ length: 5 }, () => stream.next());

    stream.setState(snapshot);
    const runB = Array.from({ length: 5 }, () => stream.next());

    expect(runB).toEqual(runA);
  });

  it('реестр: snapshot()/restore() воспроизводят состояние всех стримов', () => {
    const registry = createRngRegistry(321);
    const a = registry.forSystem('A').stream();
    const b = registry.forSystem('B').stream();
    a.next();
    a.next();
    b.next();

    const snap = registry.snapshot();
    const afterSnapA = Array.from({ length: 3 }, () => a.next());
    const afterSnapB = Array.from({ length: 3 }, () => b.next());

    registry.restore(snap);
    const restoredA = registry.forSystem('A').stream();
    const restoredB = registry.forSystem('B').stream();
    expect(Array.from({ length: 3 }, () => restoredA.next())).toEqual(afterSnapA);
    expect(Array.from({ length: 3 }, () => restoredB.next())).toEqual(afterSnapB);
  });
});

describe('nextBelow', () => {
  it('значения всегда в [0, bound)', () => {
    const stream = new XorShift128Stream(seedStateFromName(555, 'BoundsSystem'));
    for (let i = 0; i < 500; i++) {
      const v = stream.nextBelow(37);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(37);
    }
  });

  it('bound=1 всегда даёт 0', () => {
    const stream = new XorShift128Stream(seedStateFromName(555, 'BoundsSystem'));
    for (let i = 0; i < 50; i++) {
      expect(stream.nextBelow(1)).toBe(0);
    }
  });
});

describe('nextFixed', () => {
  it('результат в [0, 1) как Q16.16 (старшие 16 бит next())', () => {
    const stream = new XorShift128Stream(seedStateFromName(8, 'FixedSystem'));
    const reference = new XorShift128Stream(seedStateFromName(8, 'FixedSystem'));
    for (let i = 0; i < 20; i++) {
      const viaFixed = stream.nextFixed();
      const viaNext = reference.next() >>> 16;
      expect(viaFixed).toBe(viaNext);
      expect(viaFixed).toBeGreaterThanOrEqual(0);
      expect(viaFixed).toBeLessThan(65536);
    }
  });
});

describe('RNG-8: нормативная формула nextFixed/nextBelow (worldSeed=12345, "DamageSystem")', () => {
  // Опирается на золотые значения next() из блока GOLDEN ниже: [0x8349c8f0, 0x3fc0d43e, ...].

  it('nextFixed = старшие 16 бит next(), конкретное значение', () => {
    const stream = new XorShift128Stream(seedStateFromName(12345, 'DamageSystem'));
    expect(stream.nextFixed()).toBe(0x8349); // 0x8349c8f0 >>> 16 == 33609 == 0x8349
  });

  it('nextBelow: конкретный bound без отбраковки — один вызов next(), результат по формуле Lemire', () => {
    const stream = new XorShift128Stream(seedStateFromName(12345, 'DamageSystem'));
    const reference = new XorShift128Stream(seedStateFromName(12345, 'DamageSystem'));

    const result = stream.nextBelow(100);
    const x = BigInt(reference.next() >>> 0); // ровно один шаг — первый golden-value не отбраковывается при bound=100
    const hi = (x * 100n) / (2n ** 32n);
    expect(result).toBe(Number(hi));
    expect(result).toBe(51);
    expect(stream.getState()).toEqual(reference.getState()); // ровно один шаг генератора
  });

  it('nextBelow: конкретный bound с отбраковкой — первый draw отбракован, второй принят, hi=11390', () => {
    // bound=45739: threshold=(2^32-45739)%45739=29457; lo(golden[0])=6224 < threshold -> reject;
    // lo(golden[1])=2841698666 >= threshold -> accept, hi=11390. Сверено BigInt-эталоном при написании теста.
    const stream = new XorShift128Stream(seedStateFromName(12345, 'DamageSystem'));
    const reference = new XorShift128Stream(seedStateFromName(12345, 'DamageSystem'));

    const result = stream.nextBelow(45739);
    reference.next(); // отбракованный вызов
    reference.next(); // принятый вызов

    expect(result).toBe(11390);
    expect(stream.getState()).toEqual(reference.getState()); // ровно два шага генератора — отбраковка видна в состоянии
  });

  it('bound < 1: жёсткая граница (assertInvariant) — бросает и в debug, и в release', async () => {
    const stream = new XorShift128Stream(seedStateFromName(1, 'X'));
    expect(() => stream.nextBelow(0)).toThrow();
    expect(() => stream.nextBelow(-1)).toThrow();
    expect(() => stream.nextBelow(1.5)).toThrow();

    const release = await importRngUnder('production');
    const releaseStream = new release.XorShift128Stream(release.seedStateFromName(1, 'X'));
    expect(() => releaseStream.nextBelow(0)).toThrow();
  });

  // Верхняя граница диапазона RNG-8: алгоритм описан над `s = bound (как u32)`,
  // и `bound = 2^32` дал бы `s = 0` — цикл вышел бы с первого раза, а функция
  // ВСЕГДА возвращала бы 0, сдвинув генератор на шаг. Отказ обязан быть таким
  // же жёстким, как у нижней границы: в обоих режимах сборки.
  it('bound > 2^32−1: жёсткая граница в обоих режимах сборки (RNG-8)', async () => {
    const stream = new XorShift128Stream(seedStateFromName(1, 'X'));
    expect(() => stream.nextBelow(2 ** 32)).toThrow(/1…2\^32−1/);
    expect(() => stream.nextBelow(2 ** 32 + 1)).toThrow(/1…2\^32−1/);

    const release = await importRngUnder('production');
    const releaseStream = new release.XorShift128Stream(release.seedStateFromName(1, 'X'));
    expect(() => releaseStream.nextBelow(2 ** 32)).toThrow();
  });

  it('bound = 2^32−1 — законная граница диапазона и работает (RNG-8)', () => {
    const stream = new XorShift128Stream(seedStateFromName(1, 'X'));
    const reference = new XorShift128Stream(seedStateFromName(1, 'X'));

    const bound = 2 ** 32 - 1;
    const result = stream.nextBelow(bound);
    // Порог отбраковки при таком `bound` равен единице, поэтому число шагов
    // генератора здесь не константа теста — сверяется значение по формуле
    // Lemire от того же состояния.
    let hi = 0;
    let lo = 0;
    do {
      const x = BigInt(reference.next() >>> 0);
      const product = x * BigInt(bound);
      hi = Number(product / 2n ** 32n);
      lo = Number(product % 2n ** 32n);
    } while (lo < ((2 ** 32 - bound) % bound));
    expect(result).toBe(hi);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(bound);
    expect(stream.getState()).toEqual(reference.getState());
  });
});

describe('GOLDEN: worldSeed=12345, "DamageSystem" — точка сверки с Rust', () => {
  it('первые 8 значений next() совпадают с зафиксированными константами', () => {
    const stream = new XorShift128Stream(seedStateFromName(12345, 'DamageSystem'));
    const values = Array.from({ length: 8 }, () => stream.next());
    // Числа сверены с независимым BigInt-эталоном RNG-7 перед фиксацией (не взяты "как есть" из первого прогона).
    expect(values).toEqual([
      0x8349c8f0, 0x3fc0d43e, 0x50a97c22, 0xcb819584, 0x0642ca4c, 0x3f1a8f9e, 0x2449ac33, 0xe3a3308b,
    ]);
  });
});
