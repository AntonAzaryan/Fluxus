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
  if (DEBUG) assert(raw === wrapped, `${what}: overflow (${raw} не помещается в i32)`, 'FIXED_OVERFLOW');
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
 *
 * Границы промежутков (DET-2, условие 5) — операнды `i32`, поэтому:
 * `ua, ub ≤ 2^31` ⇒ `aHi, bHi ≤ 2^15` и `aLo, bLo < 2^16`. Отсюда
 * `aLo·bLo < 2^32` (`Math.imul` даёт его точно, `>>> 0` лишь читает результат
 * как unsigned), каждое перекрёстное произведение `< 2^31` — то есть тоже
 * точное в `Math.imul`, — а их сумма `< 2^32`; `aHi·bHi ≤ 2^30`, поэтому
 * `high ≤ 2^46`. Собранная магнитуда не превышает `2^46 + 2^32 + 2^16 < 2^47`,
 * то есть каждое промежуточное значение строго меньше 2^53 и в двоичном
 * контейнере точно (DET-2, условия 2 и 3).
 *
 * Все три делимых (`ua`, `ub`, `lo`) неотрицательны и меньше 2^32, поэтому
 * условие 4 о конвенции округления здесь неприменимо: считаем на магнитудах, а
 * знак применяем после (FP-3).
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
 *
 * DET-2, условия 3 и 4: делимое `|a|·2^16 ≤ 2^47 < 2^53`, поэтому приведённое
 * частное совпадает с точным целым; делимое и делитель неотрицательны, знак
 * применяется после, — конвенция округления отрицательных здесь не возникает.
 */
export function div(a: Fixed, b: Fixed): Fixed {
  if (DEBUG) assert(b !== 0, 'div: деление на ноль', 'FIXED_DIV_BY_ZERO');
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
  if (DEBUG) assert(a >= 0, 'sqrt: отрицательный операнд', 'FIXED_SQRT_NEGATIVE');
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

// ------------------------------------------------------------- тригонометрия

/**
 * Нормативная таблица синуса первой четверти (FP-8): 257 узлов с шагом 64
 * единицы угла, `table[i] = round(sin(2π·i/1024)·65536)`. Литерал, а не
 * порождение в рантайме: libm-синусы расходятся в младшем бите между языками
 * и платформами, а таблица обязана совпадать с Rust-портом бит в бит (DET-2).
 * Каждый узел сверяется с формулой в test/fixed.test.ts.
 */
const SIN_TABLE = new Int32Array([
  0, 402, 804, 1206, 1608, 2010, 2412, 2814,
  3216, 3617, 4019, 4420, 4821, 5222, 5623, 6023,
  6424, 6824, 7224, 7623, 8022, 8421, 8820, 9218,
  9616, 10014, 10411, 10808, 11204, 11600, 11996, 12391,
  12785, 13180, 13573, 13966, 14359, 14751, 15143, 15534,
  15924, 16314, 16703, 17091, 17479, 17867, 18253, 18639,
  19024, 19409, 19792, 20175, 20557, 20939, 21320, 21699,
  22078, 22457, 22834, 23210, 23586, 23961, 24335, 24708,
  25080, 25451, 25821, 26190, 26558, 26925, 27291, 27656,
  28020, 28383, 28745, 29106, 29466, 29824, 30182, 30538,
  30893, 31248, 31600, 31952, 32303, 32652, 33000, 33347,
  33692, 34037, 34380, 34721, 35062, 35401, 35738, 36075,
  36410, 36744, 37076, 37407, 37736, 38064, 38391, 38716,
  39040, 39362, 39683, 40002, 40320, 40636, 40951, 41264,
  41576, 41886, 42194, 42501, 42806, 43110, 43412, 43713,
  44011, 44308, 44604, 44898, 45190, 45480, 45769, 46056,
  46341, 46624, 46906, 47186, 47464, 47741, 48015, 48288,
  48559, 48828, 49095, 49361, 49624, 49886, 50146, 50404,
  50660, 50914, 51166, 51417, 51665, 51911, 52156, 52398,
  52639, 52878, 53114, 53349, 53581, 53812, 54040, 54267,
  54491, 54714, 54934, 55152, 55368, 55582, 55794, 56004,
  56212, 56418, 56621, 56823, 57022, 57219, 57414, 57607,
  57798, 57986, 58172, 58356, 58538, 58718, 58896, 59071,
  59244, 59415, 59583, 59750, 59914, 60075, 60235, 60392,
  60547, 60700, 60851, 60999, 61145, 61288, 61429, 61568,
  61705, 61839, 61971, 62101, 62228, 62353, 62476, 62596,
  62714, 62830, 62943, 63054, 63162, 63268, 63372, 63473,
  63572, 63668, 63763, 63854, 63944, 64031, 64115, 64197,
  64277, 64354, 64429, 64501, 64571, 64639, 64704, 64766,
  64827, 64884, 64940, 64993, 65043, 65091, 65137, 65180,
  65220, 65259, 65294, 65328, 65358, 65387, 65413, 65436,
  65457, 65476, 65492, 65505, 65516, 65525, 65531, 65535,
  65536,
]);

const TURN_MASK = 0xffff;
const HALF_TURN = 0x8000;
const QUARTER_TURN = 0x4000;

/**
 * Синус в Q16.16 (FP-7). Угол — binary angle measure: полный оборот 2^16
 * единиц, поэтому сырое значение угла совпадает с Q16.16-долей оборота
 * (16384 = 0.25 оборота = 90°). Заворачивание — маска, для отрицательных
 * углов её даёт two's complement. Сведение к первой четверти — знак после
 * магнитуды, как в mul (FP-3): внутри четверти значения и приращения
 * таблицы неотрицательны, и `>> 6` интерполяции — усечение к нулю.
 */
export function sin(a: Fixed): Fixed {
  const turn = a & TURN_MASK;
  const negative = turn >= HALF_TURN;
  const half = turn & (HALF_TURN - 1);
  const q = half > QUARTER_TURN ? HALF_TURN - half : half;
  const idx = q >> 6;
  const frac = q & 63;
  const base = SIN_TABLE[idx]!;
  // frac = 0 — узел без поправки; заодно это делает недостижимым чтение
  // за сентинелом (idx + 1 = 257 бывает только при frac = 0).
  const magnitude = frac === 0 ? base : base + (((SIN_TABLE[idx + 1]! - base) * frac) >> 6);
  // `| 0` нормализует -0 на нулях полуволны (180°) — как wrap() у остальных операций.
  return (negative ? -magnitude : magnitude) | 0;
}

/** Косинус — сдвиг фазы на четверть оборота (FP-7): одна таблица на обе функции. */
export function cos(a: Fixed): Fixed {
  return sin(a + QUARTER_TURN);
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

/**
 * Точное |a|*|a| для i32 как беззнаковое 64-битное число (hi, lo — 32-битные
 * слова). Границы промежутков (DET-2, условие 5) выписаны по строкам ниже:
 * операнд `i32`, поэтому `v ≤ 2^31`, `hi16 ≤ 2^15`, `lo16 < 2^16`. Все три
 * делимых неотрицательны и строго меньше 2^33 — то есть 2^53 не достигают, и
 * приведённое частное точно (условия 2 и 3); отрицательных частных здесь не
 * бывает по построению (условие 4 неприменимо).
 */
function sq64(a: number): U64 {
  const v = Math.abs(a);
  const hi16 = Math.floor(v / TWO_16); // делимое ≤ 2^31, частное ≤ 2^15
  const lo16 = v % TWO_16;

  const loLo = lo16 * lo16; // < 2^32, точно
  const cross = hi16 * lo16 * 2; // ≤ 2^15 · 2^16 · 2 = 2^32, точно
  const hiHi = hi16 * hi16; // ≤ 2^30, точно

  const crossLo = cross % TWO_16;
  const crossHi = Math.floor(cross / TWO_16); // делимое ≤ 2^32, частное ≤ 2^16

  const loRaw = loLo + crossLo * TWO_16; // < 2^32 + 2^32 = 2^33, точно
  const carry = Math.floor(loRaw / TWO_32); // делимое < 2^33, частное 0 либо 1
  return [hiHi + crossHi + carry, loRaw % TWO_32];
}

/**
 * Сумма двух беззнаковых 64-битных. Младшие слова меньше 2^32 каждое, поэтому
 * `loRaw < 2^33` — делимое неотрицательно и меньше 2^53, частное 0 либо 1
 * (DET-2, условия 2, 3 и 5; условие 4 неприменимо — отрицательных нет).
 */
function add64(a: U64, b: U64): U64 {
  const loRaw = a[1] + b[1]; // < 2^33, точно
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
