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
