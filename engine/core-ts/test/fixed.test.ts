import { describe, expect, it, vi } from 'vitest';
import { withDiagnostics } from '../src/debug.js';
import * as fixed from '../src/math/fixed.js';
import { FIXED_ONE, type DiagnosticRecord, type DiagnosticsSink } from '../src/types.js';

/**
 * Приёмник записей для теста. Область его действия задаётся `withDiagnostics`,
 * поэтому между тестами он не протекает и сбрасывать его не нужно (DIAG-1).
 */
function collector(): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace: 'off', record: (entry) => entries.push(entry) }, entries };
}

/**
 * Импортирует fixed.ts (и его debug.ts) заново под заданным NODE_ENV — отдельный
 * граф модулей со своим контекстом диагностики, независимым от instances выше по файлу.
 */
async function importUnder(
  nodeEnv: string,
): Promise<typeof fixed & { debug: typeof import('../src/debug.js') }> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  vi.resetModules();
  try {
    const debugMod = await import('../src/debug.js');
    const fixedMod = await import('../src/math/fixed.js');
    return { ...fixedMod, debug: debugMod };
  } finally {
    process.env.NODE_ENV = prev;
    vi.resetModules();
  }
}

const F = fixed.fromFloat;
const f = fixed.toFloat;

/** Эталон (a*b)>>16 на BigInt — легален только здесь, в тестах (FP-2). */
function bigintMulShift(a: number, b: number): number {
  const raw = (BigInt(a) * BigInt(b)) >> 16n;
  return Number(BigInt.asIntN(32, raw));
}

/**
 * Эталон truncate toward zero на BigInt: магнитуда сдвигается, знак применяется
 * после (FP-2, FP-3). Отличается от `bigintMulShift` ровно на отрицательных
 * произведениях с ненулевым остатком, где арифметический сдвиг даёт floor.
 */
function bigintMulTruncate(a: number, b: number): number {
  const product = BigInt(a) * BigInt(b);
  const magnitude = (product < 0n ? -product : product) >> 16n;
  return Number(BigInt.asIntN(32, product < 0n ? -magnitude : magnitude));
}

/**
 * Копия медленного (hi/lo) пути `mul` — эталон парности быстрого пути (FP-2).
 * Именно копия, а не экспорт из ядра: отдельный «медленный mul» в поверхности
 * ядра был бы публичным API ради теста (CLI-8), а копия краснеет ровно тогда,
 * когда реализация от эталона расходится. `| 0` в конце повторяет `wrap()`:
 * магнитуда сравнивается уже завёрнутой в i32, как её отдаёт ядро (FP-4).
 */
function hiLoMulShift(a: number, b: number): number {
  const negative = a < 0 !== b < 0;
  const ua = Math.abs(a);
  const ub = Math.abs(b);

  const aHi = Math.floor(ua / 0x10000);
  const aLo = ua % 0x10000;
  const bHi = Math.floor(ub / 0x10000);
  const bLo = ub % 0x10000;

  const lo = Math.imul(aLo, bLo) >>> 0;
  const cross = Math.imul(aHi, bLo) + Math.imul(aLo, bHi);
  const high = Math.imul(aHi, bHi) * 0x10000;

  const magnitude = high + cross + Math.floor(lo / 0x10000);
  return (negative ? -magnitude : magnitude) | 0;
}

/** Точное произведение по модулю — им проверяется, по какую сторону 2^53 лежит пара. */
function exactMagnitude(a: number, b: number): bigint {
  const product = BigInt(a) * BigInt(b);
  return product < 0n ? -product : product;
}

const TWO_POW_53 = 9007199254740992n;

describe('fromInt/toInt/fromFloat/toFloat', () => {
  it('round-trip целых', () => {
    expect(fixed.toInt(fixed.fromInt(42))).toBe(42);
    expect(fixed.toInt(fixed.fromInt(-42))).toBe(-42);
  });

  it('fromFloat/toFloat для констант', () => {
    expect(f(F(1.5))).toBeCloseTo(1.5, 4);
    expect(f(F(-1.5))).toBeCloseTo(-1.5, 4);
  });

  it('fromInt(1) == FIXED_ONE', () => {
    expect(fixed.fromInt(1)).toBe(FIXED_ONE);
  });
});

describe('add/sub — wrapping', () => {
  it('обычная сумма', () => {
    expect(fixed.add(F(1), F(2))).toBe(F(3));
    expect(fixed.sub(F(5), F(2))).toBe(F(3));
  });

  // Значения переполнения проверяются через release-инстанс (importUnder), чтобы
  // debug-assert (см. describe FP-4 ниже) не прерывал вычисление исключением.

  it('wrapping при выходе за i32 (FP-4)', async () => {
    const release = await importUnder('production');
    expect(release.add(2147483647, 1)).toBe(-2147483648);
  });

  it('wrapping sub за нижнюю границу', async () => {
    const release = await importUnder('production');
    expect(release.sub(-2147483648, 1)).toBe(2147483647);
  });
});

describe('mul — 64-битный промежуток без BigInt (FP-2)', () => {
  it('простое умножение', () => {
    expect(f(fixed.mul(F(2), F(3)))).toBeCloseTo(6, 4);
    expect(f(fixed.mul(F(1.5), F(2)))).toBeCloseTo(3, 4);
  });

  it('произведение операндов превышает 2^53 — сверка с BigInt-эталоном', async () => {
    const a = 2_000_000_000; // ~2e9, влезает в i32
    const b = 2_000_000_000; // a*b ≈ 4e18, далеко за 2^53, да ещё и результат >>16 переполняет i32
    const release = await importUnder('production'); // переполняющий результат — не место для debug-assert
    expect(release.mul(a, b)).toBe(bigintMulShift(a, b));
  });

  it('перебор случайных операндов (включая переполняющие) сверяется с BigInt-эталоном', async () => {
    const release = await importUnder('production');
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 200; i++) {
      const a = (rand() % 4294967296) - 2147483648;
      const b = (rand() % 4294967296) - 2147483648;
      expect(release.mul(a, b)).toBe(bigintMulShift(a, b));
    }
  });

  it('truncate toward zero для отрицательных операндов (не floor)', () => {
    // -1.5 * 1 = -1.5 -> truncate -> -1, floor дал бы -2
    expect(f(fixed.mul(F(-1.5), F(1)))).toBeCloseTo(-1.5, 4);
    const result = fixed.mul(F(-1.5), F(1));
    expect(fixed.toInt(result)).toBe(-1); // truncate(-1.5) == -1, floor(-1.5) == -2
  });
});

/**
 * Быстрый путь `mul` (FP-2, DET-2 «точная целочисленная арифметика в двоичном
 * контейнере»): при `|a|·|b| < 2^53` магнитуда берётся прямым произведением, за
 * порогом — hi/lo-разложением. Пути обязаны совпадать БИТ В БИТ, иначе одно и
 * то же геймплейное умножение считалось бы двумя способами и вторая реализация
 * ядра (CORE-2) разошлась бы с первой на границе — то есть десинк (DET-1).
 *
 * Эталон парности — `hiLoMulShift` выше: копия медленного пути внутри теста.
 * Эталонов два намеренно: hi/lo проверяет «оба пути ядра — одно и то же»,
 * BigInt (`bigintMulTruncate`) — «и это то самое, что требует FP-2/FP-3».
 */
describe('mul — быстрый путь для малых операндов (FP-2, DET-2)', () => {
  it('парность с hi/lo-путём на 2^16 псевдослучайных пар из геймплейного диапазона', () => {
    // Диапазон ±2^23 — это ±128 юнитов в Q16.16: произведение ≤ 2^46 (быстрый
    // путь), магнитуда ≤ 2^30 (в i32, то есть debug-assert переполнения молчит).
    let seed = 0x1234_5678;
    const nextOperand = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
      return (seed % 0x1000000) - 0x800000;
    };

    const mismatches: string[] = [];
    let maxMagnitude = 0n;
    for (let i = 0; i < 65_536; i++) {
      const a = nextOperand();
      const b = nextOperand();
      if (fixed.mul(a, b) !== hiLoMulShift(a, b)) mismatches.push(`${a} * ${b}`);
      const magnitude = exactMagnitude(a, b);
      if (magnitude > maxMagnitude) maxMagnitude = magnitude;
    }

    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches).toHaveLength(0);
    // Партия действительно про быстрый путь: ни одна пара порога не достигла.
    expect(maxMagnitude < TWO_POW_53).toBe(true);
  });

  it('граница 2^53: пары чуть ниже и чуть выше порога дают один результат обоими путями', async () => {
    // Магнитуда здесь заведомо за i32 — не место для debug-assert переполнения.
    const release = await importUnder('production');

    // (2^26 − 1)·(2^27 + k) = 2^53 − 2^27 + k·(2^26 − 1): порог переходится
    // между k = 2 (2^53 − 2, ещё быстрый путь) и k = 3 (уже медленный).
    const a = 0x3ffffff; // 2^26 − 1
    let below = 0;
    let above = 0;
    for (let k = -4; k <= 4; k++) {
      const b = 0x8000000 + k; // 2^27 + k
      for (const [sa, sb] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const x = sa * a;
        const y = sb * b;
        if (exactMagnitude(x, y) < TWO_POW_53) below++;
        else above++;
        expect(release.mul(x, y), `${x} * ${y}`).toBe(hiLoMulShift(x, y));
        expect(release.mul(x, y), `${x} * ${y}`).toBe(bigintMulTruncate(x, y));
      }
    }
    // Порог действительно пересечён в обе стороны — иначе тест проверял бы одну ветку.
    expect(below).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(0);
    expect(exactMagnitude(a, 0x8000002)).toBe(TWO_POW_53 - 2n);
    expect(exactMagnitude(a, 0x8000003) > TWO_POW_53).toBe(true);
  });

  it('сам порог: произведение ровно 2^53 − 1 ещё быстрый путь, ровно 2^53 — уже нет', async () => {
    const release = await importUnder('production');

    // 2^53 − 1 = 6361 · 69431 · 20394401; пара сомножителей помещается в i32,
    // и это последнее целое, точное в двоичном контейнере (Number.MAX_SAFE_INTEGER).
    const lastExact: readonly [number, number] = [20_394_401, 441_650_591];
    expect(exactMagnitude(...lastExact)).toBe(TWO_POW_53 - 1n);

    // 2^53 = 2^26 · 2^27 — первое целое, которое контейнер уже не различает от
    // соседа; проверка `|p| ≤ MAX_SAFE_INTEGER` его не пропускает.
    const firstInexact: readonly [number, number] = [0x4000000, 0x8000000];
    expect(exactMagnitude(...firstInexact)).toBe(TWO_POW_53);

    for (const [x, y] of [lastExact, firstInexact]) {
      for (const [sa, sb] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        expect(release.mul(sa * x, sb * y), `${sa * x} * ${sb * y}`).toBe(hiLoMulShift(sa * x, sb * y));
        expect(release.mul(sa * x, sb * y), `${sa * x} * ${sb * y}`).toBe(bigintMulTruncate(sa * x, sb * y));
      }
    }
  });

  it('углы i32: INT32_MIN и INT32_MAX во всех сочетаниях (FP-2, FP-4)', async () => {
    const release = await importUnder('production');
    const corners = [
      fixed.INT32_MIN,
      fixed.INT32_MIN + 1,
      -0x10000,
      -1,
      0,
      1,
      0x10000,
      fixed.INT32_MAX - 1,
      fixed.INT32_MAX,
    ];
    for (const x of corners) {
      for (const y of corners) {
        expect(release.mul(x, y), `${x} * ${y}`).toBe(hiLoMulShift(x, y));
        expect(release.mul(x, y), `${x} * ${y}`).toBe(bigintMulTruncate(x, y));
      }
    }
  });

  it('быстрый путь усекает к нулю, а не к минус бесконечности (FP-3)', () => {
    // Ненулевой остаток на отрицательном произведении — ровно то место, где floor
    // и truncate расходятся; быстрый путь считает магнитуду и применяет знак после.
    const pairs: readonly (readonly [number, number])[] = [
      [-3, 1],
      [-98_305, 65_537],
      [98_305, -65_537],
      [-65_535, 1],
      [-1, 0x10000 + 1],
    ];
    for (const [x, y] of pairs) {
      expect(exactMagnitude(x, y) < TWO_POW_53, `${x} * ${y} — быстрый путь`).toBe(true);
      expect(fixed.mul(x, y), `${x} * ${y}`).toBe(hiLoMulShift(x, y));
      expect(fixed.mul(x, y), `${x} * ${y}`).toBe(bigintMulTruncate(x, y));
      // И это НЕ floor: арифметический сдвиг знакового произведения дал бы на единицу меньше.
      expect(bigintMulTruncate(x, y), `${x} * ${y} — floor против truncate`).not.toBe(bigintMulShift(x, y));
    }
  });
});

describe('div — truncate toward zero (FP-3)', () => {
  it('простое деление', () => {
    expect(f(fixed.div(F(6), F(2)))).toBeCloseTo(3, 4);
  });

  it('-1.5 -> -1, а не -2 через toInt (truncate toward zero)', () => {
    const result = fixed.div(F(-3), F(2));
    expect(fixed.toInt(result)).toBe(-1);
    expect(f(result)).toBeCloseTo(-1.5, 3);
  });

  it('-1/3: сама операция div не округляет к floor (не только toInt)', () => {
    // -1/3 не делится нацело даже на уровне сырых Fixed-величин: floor и truncate
    // расходятся уже в самом div, а не только при конвертации в toInt.
    // Наивный `Math.floor((a<<16)/b)` на знаковых a/b дал бы -21846, верно — -21845.
    expect(fixed.div(F(-1), F(3))).toBe(-21845);
    expect(fixed.div(F(1), F(-3))).toBe(-21845);
  });

  it('деление положительного на отрицательное тоже truncate', () => {
    expect(fixed.toInt(fixed.div(F(3), F(-2)))).toBe(-1);
  });

  it('деление на ноль: насыщение по знаку числителя, одинаково в debug и release (FP-5)', async () => {
    const { sink, entries } = collector();

    // debug-сборка (текущий top-level импорт, DEBUG=true в vitest): не бросает,
    // диагностика уходит в sink, значение — насыщение.
    withDiagnostics(sink, 1, () => {
      expect(fixed.div(F(1), 0)).toBe(fixed.INT32_MAX);
      expect(fixed.div(F(-1), 0)).toBe(fixed.INT32_MIN);
      expect(fixed.div(0, 0)).toBe(0);
    });
    expect(entries.some((entry) => entry.code === 'FIXED_DIV_BY_ZERO')).toBe(true);

    // Значение обязано быть определено и в релизе: Rust на целочисленном делении
    // на ноль паникует, TS даёт Infinity — расхождение здесь означало бы десинк,
    // поэтому результат задан спекой и одинаков в обоих режимах сборки.
    const release = await importUnder('production');
    expect(release.div(F(1), 0)).toBe(fixed.INT32_MAX);
    expect(release.div(F(-1), 0)).toBe(fixed.INT32_MIN);
    expect(release.div(0, 0)).toBe(0);
  });
});

describe('переполнение: wrapping + мягкий assert (FP-4)', () => {
  it('debug: мягкий assert уходит в sink, не бросает; release: то же значение без диагностики (мул)', async () => {
    const a = fixed.fromInt(30000);
    const b = fixed.fromInt(30000);
    const expected = bigintMulShift(a, b);

    const debugMod = await importUnder('test');
    const releaseMod = await importUnder('production');

    const { sink, entries } = collector();

    const inDebug = debugMod.debug.withDiagnostics(sink, 1, () => debugMod.mul(a, b)); // не бросает — assert мягкий
    expect(inDebug).toBe(expected);
    expect(entries).toHaveLength(1); // диагностика всё же сработала
    expect(entries[0]?.code).toBe('FIXED_OVERFLOW');

    const released = releaseMod.mul(a, b); // в релизе assert не вызывается вовсе
    expect(released).toBe(expected); // значение — то же самое wrapping, что и в debug
  });

  it('add: тот же паттерн debug/release для переполнения i32 — значения совпадают, sink срабатывает только в debug', async () => {
    const debugMod = await importUnder('test');
    const releaseMod = await importUnder('production');

    const { sink, entries } = collector();

    expect(debugMod.debug.withDiagnostics(sink, 1, () => debugMod.add(2147483647, 100))).toBe(
      (2147483647 + 100) | 0,
    );
    expect(entries).toHaveLength(1);
    expect(releaseMod.add(2147483647, 100)).toBe((2147483647 + 100) | 0);
  });

  it('abs(i32::MIN) заворачивается в себя же (классический edge case 2\'s complement)', async () => {
    const releaseMod = await importUnder('production');
    expect(releaseMod.abs(-2147483648)).toBe(-2147483648);
  });
});

describe('abs/min/max/clamp', () => {
  it('abs', () => {
    expect(fixed.abs(F(-5))).toBe(F(5));
    expect(fixed.abs(F(5))).toBe(F(5));
  });

  it('min/max', () => {
    expect(fixed.min(F(1), F(2))).toBe(F(1));
    expect(fixed.max(F(1), F(2))).toBe(F(2));
  });

  it('clamp', () => {
    expect(fixed.clamp(F(5), F(0), F(3))).toBe(F(3));
    expect(fixed.clamp(F(-5), F(0), F(3))).toBe(F(0));
    expect(fixed.clamp(F(2), F(0), F(3))).toBe(F(2));
  });
});

describe('sqrt — целочисленный алгоритм без Math.sqrt', () => {
  it('точные квадраты', () => {
    expect(fixed.toInt(fixed.sqrt(F(4)))).toBe(2);
    expect(fixed.toInt(fixed.sqrt(F(9)))).toBe(3);
    expect(fixed.toInt(fixed.sqrt(F(0)))).toBe(0);
    expect(fixed.toInt(fixed.sqrt(F(1)))).toBe(1);
  });

  it('неточные значения — совпадают с математическим sqrt с точностью Q16.16', () => {
    expect(f(fixed.sqrt(F(2)))).toBeCloseTo(Math.sqrt(2), 3);
    expect(f(fixed.sqrt(F(1000)))).toBeCloseTo(Math.sqrt(1000), 2);
  });

  /**
   * DET-2 запрещает libm «ни при каких условиях», поэтому сид больше не
   * приходит из `Math.sqrt`, и точность держится на самом алгоритме. Проверяется
   * ОПРЕДЕЛЕНИЕ isqrt на эталоне BigInt (в тестах он легален, как и у mul,
   * FP-2): `s² ≤ a·2^16 < (s+1)²`. Такое s единственно, поэтому проверка
   * определением заодно и есть обещание «ответ тот же до бита, каким бы ни был
   * сид» — второй реализации ядра (CORE-2) сверяться тоже с ним.
   *
   * Перебор — по местам, где ломаются именно приближения: длина двоичной записи
   * меняется у степеней двойки, коррекции ±1 работают у точных квадратов,
   * стартовая догадка максимальна у границы i32.
   */
  it('точный isqrt на границах, степенях двойки и точных квадратах (FP-6, DET-2)', () => {
    const probes = new Set<number>();
    for (let a = 1; a <= 20000; a++) probes.add(a); // малые значения целиком
    for (let bit = 0; bit <= 30; bit++) {
      for (const delta of [-1, 0, 1]) {
        const a = (1 << bit) + delta;
        if (a >= 1) probes.add(a);
      }
    }
    // Точные квадраты по всему диапазону и их соседи: n = a·2^16 — полный
    // квадрат ровно тогда, когда полный квадрат сам операнд.
    for (let k = 1; k * k <= fixed.INT32_MAX; k += 137) {
      for (const delta of [-1, 0, 1]) {
        const a = k * k + delta;
        if (a >= 1 && a <= fixed.INT32_MAX) probes.add(a);
      }
    }
    for (const a of [fixed.INT32_MAX, fixed.INT32_MAX - 1, 46340 * 46340, 46341 * 46341 - 1]) {
      if (a >= 1 && a <= fixed.INT32_MAX) probes.add(a);
    }
    // Равномерный шаг по всему диапазону — на случай промаха перечисленных мест.
    for (let a = 1; a < fixed.INT32_MAX; a += 3_000_017) probes.add(a);

    const wrong: string[] = [];
    for (const a of probes) {
      const s = BigInt(fixed.sqrt(a));
      const n = BigInt(a) * BigInt(FIXED_ONE);
      if (!(s * s <= n && n < (s + 1n) * (s + 1n))) wrong.push(`${a} → ${s}`);
    }
    expect(wrong).toEqual([]);
  });

  it('отрицательный операнд (FP-6): возвращает 0 без исключения, одинаково в debug и release', async () => {
    const { sink, entries } = collector();

    withDiagnostics(sink, 1, () => {
      expect(fixed.sqrt(F(-1))).toBe(0); // debug-сборка (top-level импорт): не бросает
    });
    expect(entries.some((entry) => entry.code === 'FIXED_SQRT_NEGATIVE')).toBe(true); // диагностика ушла в sink

    const release = await importUnder('production');
    expect(release.sqrt(F(-1))).toBe(0); // release: то же значение, без assert вовсе
  });
});

describe('sin/cos — таблица первой четверти (FP-7, FP-8)', () => {
  const TURN = 0x10000;
  const QUARTER = 0x4000;

  it('точен на осях', () => {
    expect(fixed.sin(0)).toBe(0);
    expect(fixed.sin(QUARTER)).toBe(FIXED_ONE);
    expect(fixed.sin(2 * QUARTER)).toBe(0);
    expect(fixed.sin(3 * QUARTER)).toBe(-FIXED_ONE);
    expect(fixed.cos(0)).toBe(FIXED_ONE);
    expect(fixed.cos(QUARTER)).toBe(0);
    expect(fixed.cos(2 * QUARTER)).toBe(-FIXED_ONE);
    expect(fixed.cos(3 * QUARTER)).toBe(0);
  });

  it('заворачивает маской: полный оборот и отрицательные углы (FP-7)', () => {
    for (const a of [0, 1, 12345, QUARTER, 0xffff]) {
      expect(fixed.sin(a + TURN)).toBe(fixed.sin(a));
      expect(fixed.sin(a - 3 * TURN)).toBe(fixed.sin(a));
    }
    expect(fixed.sin(-QUARTER)).toBe(-FIXED_ONE); // −90° ≡ 270°
    // 180° с отрицательной полуволны — ровно 0, без следа знака (-0)
    expect(Object.is(fixed.sin(2 * QUARTER), 0)).toBe(true);
  });

  it('cos — сдвиг фазы на четверть оборота, побитово (FP-7)', () => {
    for (let a = -TURN; a <= TURN; a += 997) {
      expect(fixed.cos(a)).toBe(fixed.sin(a + QUARTER));
    }
  });

  it('узлы таблицы совпадают с нормативной формулой FP-8', () => {
    // Float легален в тестах (DET-2): двойная точность на порядки дальше от
    // границы округления, чем ошибка libm.
    for (let i = 0; i <= 256; i++) {
      expect(fixed.sin(i * 64)).toBe(Math.round(Math.sin((2 * Math.PI * i) / 1024) * FIXED_ONE));
    }
  });

  it('все 65536 углов в допуске ±2 кванта от float-эталона', () => {
    for (let a = 0; a < TURN; a++) {
      const ideal = Math.sin((2 * Math.PI * a) / TURN) * FIXED_ONE;
      expect(Math.abs(fixed.sin(a) - ideal)).toBeLessThanOrEqual(2);
    }
  });

  it('симметрии полуволн на всём обороте', () => {
    for (let a = 0; a <= 2 * QUARTER; a += 61) {
      expect(fixed.sin(2 * QUARTER - a)).toBe(fixed.sin(a)); // sin(π−x) = sin(x)
      expect(fixed.sin(2 * QUARTER + a)).toBe(-fixed.sin(a) | 0); // sin(π+x) = −sin(x); |0 гасит -0 эталона
    }
  });

  it('монотонен на первой четверти — интерполяция не даёт провалов', () => {
    let prev = fixed.sin(0);
    for (let a = 1; a <= QUARTER; a++) {
      const next = fixed.sin(a);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });
});

/**
 * Сравнение сумм квадратов (QUERY-1, ACT-5) — точное, а не приближённое: на нём
 * стоят и фильтр `withinRadius`, и упорядочивание выборки по расстоянию, и
 * приближение Q16.16 расходилось бы с ним ровно там, где расхождение и
 * наблюдаемо — за пределом квадратичной арифметики и на смещениях меньше кванта.
 */
describe('distSqCompare/distSqLe — точная 64-битная арифметика квадратов', () => {
  /** Эталон на BigInt — легален только в тестах (FP-2). */
  const exact = (ax: number, ay: number, bx: number, by: number): number => {
    const a = BigInt(ax) * BigInt(ax) + BigInt(ay) * BigInt(ay);
    const b = BigInt(bx) * BigInt(bx) + BigInt(by) * BigInt(by);
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const CASES: readonly (readonly [number, number, number, number])[] = [
    [0, 0, 0, 0],
    [1, 0, 2, 0],
    [2, 0, 1, 0],
    [1, 2, 2, 1],
    [-3, 4, 5, 0],
    [F(200), 0, F(1), 0],
    [F(-200), F(200), F(200), F(200)],
    [fixed.INT32_MAX, 0, fixed.INT32_MAX, 1],
    [fixed.INT32_MIN, fixed.INT32_MIN, fixed.INT32_MAX, fixed.INT32_MAX],
    [F(0.5), F(0.5), F(0.7071), 0],
  ];

  it('совпадает с точным эталоном на всех парах, включая края i32', () => {
    for (const [ax, ay, bx, by] of CASES) {
      expect(fixed.distSqCompare(ax, ay, bx, by), `${ax},${ay} ~ ${bx},${by}`).toBe(exact(ax, ay, bx, by));
    }
  });

  it('различает то, что приближение Q16.16 схлопнуло бы или перевернуло', () => {
    // Квадраты меньше кванта: `mul` дал бы обоим нуль.
    expect(fixed.mul(1, 1)).toBe(0);
    expect(fixed.mul(2, 2)).toBe(0);
    expect(fixed.distSqCompare(1, 0, 2, 0)).toBe(-1);
    // За пределом квадратичной арифметики (~181 единица) `mul` заворачивается в
    // отрицательное, то есть дальняя точка стала бы «ближней».
    expect(fixed.mul(F(200), F(200))).toBeLessThan(0);
    expect(fixed.distSqCompare(F(200), 0, F(1), 0)).toBe(1);
  });

  it('граница радиуса включающая, а сравнение симметрично (QUERY-1, ARENA-2)', () => {
    expect(fixed.distSqLe(F(3), F(4), F(5))).toBe(true);
    expect(fixed.distSqLe(F(3), F(4), F(4.9999))).toBe(false);
    expect(fixed.distSqLe(0, 0, 0)).toBe(true);
    // Знак смещения на результат не влияет: сравниваются квадраты.
    expect(fixed.distSqCompare(F(-3), F(-4), F(3), F(4))).toBe(0);
  });
});
