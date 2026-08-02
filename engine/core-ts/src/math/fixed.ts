/**
 * Скалярные операции Q16.16 (FP-1..FP-4). Без BigInt и без float в hot-path
 * (FP-2): произведение двух i32 вылетает за 53-битный safe integer, поэтому
 * mul раскладывает операнды на 16-битные половины и собирает через Math.imul.
 */
import { assert, DEBUG } from '../debug.js';
import { type Fixed, FIXED_ONE, FIXED_SHIFT } from '../types.js';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Заворачивает произвольную (но точно целую) величину в i32 и в debug-сборке ловит переполнение. */
function wrap(raw: number, what: string): Fixed {
  const wrapped = raw | 0;
  if (DEBUG) assert(raw === wrapped, `${what}: overflow (${raw} не помещается в i32)`);
  return wrapped;
}

export function fromInt(n: number): Fixed {
  return wrap(n * FIXED_ONE, 'fromInt');
}

export function toInt(a: Fixed): number {
  // truncate toward zero (FP-3): `>> FIXED_SHIFT` даёт floor для отрицательных — не то, что нужно.
  return a < 0 ? -((-a) >>> FIXED_SHIFT) : a >>> FIXED_SHIFT;
}

/** Только для констант и тестов — float в симуляции запрещён (DET-2). */
export function fromFloat(n: number): Fixed {
  return wrap(Math.trunc(n * FIXED_ONE), 'fromFloat');
}

/** Только для констант и тестов (DET-2). */
export function toFloat(a: Fixed): number {
  return a / FIXED_ONE;
}

export function add(a: Fixed, b: Fixed): Fixed {
  return wrap(a + b, 'add');
}

export function sub(a: Fixed, b: Fixed): Fixed {
  return wrap(a - b, 'sub');
}

/**
 * (i64(a) * i64(b)) >> 16 (FP-2) без BigInt: раскладываем |a|,|b| на 16-битные
 * половины, произведение половин собираем через Math.imul, знак — отдельно
 * (FP-3): в unsigned-домене `>> 16` — обычный floor, поэтому применение знака
 * после округления и даёт truncate toward zero.
 */
export function mul(a: Fixed, b: Fixed): Fixed {
  const negative = a < 0 !== b < 0;
  const ua = Math.abs(a);
  const ub = Math.abs(b);

  const aHi = Math.floor(ua / 0x10000);
  const aLo = ua % 0x10000;
  const bHi = Math.floor(ub / 0x10000);
  const bLo = ub % 0x10000;

  // aLo*bLo может превышать i32 (макс 0xfffe0001 как знаковый) — переинтерпретируем как unsigned.
  const lo = Math.imul(aLo, bLo) >>> 0;
  const cross = Math.imul(aHi, bLo) + Math.imul(aLo, bHi);
  const high = Math.imul(aHi, bHi) * 0x10000;

  const magnitude = high + cross + Math.floor(lo / 0x10000);
  return wrap(negative ? -magnitude : magnitude, 'mul');
}

/**
 * (i64(a) << 16) / b (FP-2). `a << 16` по модулю не превышает 2^47 — влезает
 * в double точно, поэтому целочисленное деление магнитуд плейн-числами не
 * теряет точность и не требует BigInt. Знак — отдельно, как и в mul (FP-3).
 */
export function div(a: Fixed, b: Fixed): Fixed {
  if (DEBUG) assert(b !== 0, 'div: деление на ноль');
  // FP-5: насыщение по знаку числителя. Нативное поведение расходится (Rust
  // паникует, TS даёт Infinity), поэтому результат задан спекой явно.
  if (b === 0) return a > 0 ? INT32_MAX : a < 0 ? INT32_MIN : 0;

  const negative = a < 0 !== b < 0;
  const numerator = Math.abs(a) * FIXED_ONE;
  const denominator = Math.abs(b);
  const magnitude = Math.floor(numerator / denominator);
  return wrap(negative ? -magnitude : magnitude, 'div');
}

export function abs(a: Fixed): Fixed {
  return wrap(Math.abs(a), 'abs');
}

export function min(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b;
}

export function max(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b;
}

export function clamp(a: Fixed, lo: Fixed, hi: Fixed): Fixed {
  return min(max(a, lo), hi);
}

/**
 * Целочисленный sqrt в Q16.16 (без Math.sqrt): sqrt(x/2^16) = sqrt(x*2^16)/2^16,
 * поэтому ищем isqrt(a << 16) двоичным поиском. `a << 16` ограничено ~2^47 —
 * влезает в double точно, как и все промежуточные квадраты в поиске.
 */
export function sqrt(a: Fixed): Fixed {
  if (DEBUG) assert(a >= 0, 'sqrt: отрицательный операнд');
  if (a <= 0) return 0;

  const n = a * FIXED_ONE;
  let lo = 0;
  let hi = 1 << 24; // sqrt(2^47) < 2^24
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (mid * mid <= n) lo = mid;
    else hi = mid - 1;
  }
  return wrap(lo, 'sqrt');
}

export { INT32_MIN, INT32_MAX };

// ---------------------------------------- сравнение расстояний без sqrt

/*
 * Сравнение сумм квадратов в fixed-point без sqrt: граница включающая
 * (QUERY-1, ARENA-2), а округление sqrt меняло бы состав результата у самой
 * границы. dx*dx+dy*dy на i32-координатах вылетает за 2^53 (safe integer),
 * поэтому считаем точно как беззнаковые 64 бита — пара 32-битных слов,
 * собранная из 16-битных половин.
 */

type U64 = readonly [hi: number, lo: number];

const TWO_16 = 0x10000;
const TWO_32 = 0x100000000;

/** Точное |a|*|a| для i32 как беззнаковое 64-битное число (hi, lo — 32-битные слова). */
function sq64(a: number): U64 {
  const v = Math.abs(a);
  const hi16 = Math.floor(v / TWO_16);
  const lo16 = v % TWO_16;

  const loLo = lo16 * lo16; // < 2^32, точно
  const cross = hi16 * lo16 * 2; // < 2^32, точно
  const hiHi = hi16 * hi16; // < 2^32, точно

  const crossLo = cross % TWO_16;
  const crossHi = Math.floor(cross / TWO_16);

  const loRaw = loLo + crossLo * TWO_16; // < 2^33, точно
  const carry = Math.floor(loRaw / TWO_32);
  return [hiHi + crossHi + carry, loRaw % TWO_32];
}

function add64(a: U64, b: U64): U64 {
  const loRaw = a[1] + b[1];
  const carry = Math.floor(loRaw / TWO_32);
  return [a[0] + b[0] + carry, loRaw % TWO_32];
}

function le64(a: U64, b: U64): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
}

/** dx² + dy² <= radius² — включая границу. Общий компаратор для `withinRadius` и арены. */
export function distSqLe(dx: Fixed, dy: Fixed, radius: Fixed): boolean {
  return le64(add64(sq64(dx), sq64(dy)), sq64(radius));
}
