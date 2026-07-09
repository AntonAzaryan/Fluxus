/**
 * PCG32 (pcg-xsh-rr, 64→32) генератор псевдослучайных чисел
 * conventions.md §3
 * 
 * Reference: M. O'Neill, 2014
 * Все операции над u64/u32 — wrapping (в отличие от fixed-point!)
 */

import { Fixed, mul, div, ZERO, ONE } from '../fixed/fixed';

/**
 * Состояние PCG32 RNG
 */
export interface RngState {
  state: bigint; // u64
  inc: bigint;   // u64
}

// Константы для u64 wrapping
const U64_MASK = BigInt('0xFFFFFFFFFFFFFFFF');
const U32_MASK = BigInt('0xFFFFFFFF');

/**
 * Wrapping умножение u64
 */
function mulU64(a: bigint, b: bigint): bigint {
  return (a * b) & U64_MASK;
}

/**
 * Wrapping сложение u64
 */
function addU64(a: bigint, b: bigint): bigint {
  return (a + b) & U64_MASK;
}

/**
 * Инициализация PCG32: pcg32_srandom(seed, seq)
 * 
 * Алгоритм:
 * inc = (seq << 1) | 1
 * state = 0
 * state = next_step(state, inc)  // холостой шаг
 * state = state + seed
 * state = next_step(state, inc)  // второй холостой шаг
 */
export function pcg32_srandom(seed: bigint, seq: bigint): RngState {
  let inc = ((seq << BigInt(1)) | BigInt(1)) & U64_MASK;
  let state = BigInt(0);
  
  // Первый холостой шаг
  state = nextStep(state, inc);
  state = addU64(state, seed);
  // Второй холостой шаг
  state = nextStep(state, inc);
  
  return { state, inc };
}

/**
 * Шаг генератора: new_state = state * 6364136223846793005 + inc
 */
function nextStep(state: bigint, inc: bigint): bigint {
  const multiplier = BigInt('6364136223846793005');
  return addU64(mulU64(state, multiplier), inc);
}

/**
 * next_u32(): базовый шаг генератора
 * 
 * Алгоритм:
 * old_state = rng.state
 * rng.state = next_step(old_state, rng.inc)
 * xorshifted = ((old_state >> 18) ^ old_state) >> 27
 * rot = old_state >> 59
 * return (xorshifted >> rot) | (xorshifted << ((-rot) & 31))
 */
export function nextU32(rng: RngState): bigint {
  const oldState = rng.state;
  rng.state = nextStep(oldState, rng.inc);
  
  // XSH-RR output function
  const xorshifted = (((oldState >> BigInt(18)) ^ oldState) >> BigInt(27)) & U32_MASK;
  const rot = (oldState >> BigInt(59)) & BigInt(31);
  
  // Rotate right
  const result = ((xorshifted >> rot) | (xorshifted << ((-rot) & BigInt(31)))) & U32_MASK;
  
  return result;
}

/**
 * next_bool(): случайный булев
 * next_u32() & 1 == 1
 */
export function nextBool(rng: RngState): boolean {
  return (nextU32(rng) & BigInt(1)) === BigInt(1);
}

/**
 * range_u32(lo, hi): равномерно в [lo, hi)
 * Метод Lemire без rejection: ((next_u32() as u64) * ((hi - lo) as u64)) >> 32 + lo
 * 
 * conventions.md §3: метод Lemire даёт лёгкое смещение при неделящихся диапазонах,
 * но это осознанный компромисс ради детерминированного числа шагов.
 */
export function rangeU32(rng: RngState, lo: bigint, hi: bigint): bigint {
  if (lo >= hi) {
    throw new Error(`Invalid range: lo=${lo}, hi=${hi}`);
  }
  
  const range = (hi - lo) & U32_MASK;
  const random = nextU32(rng);
  const product = (random * range) >> BigInt(32);
  
  return (lo + product) & U32_MASK;
}

/**
 * range_i32(lo, hi): равномерно в [lo, hi) для signed i32
 */
export function rangeI32(rng: RngState, lo: number, hi: number): number {
  if (lo >= hi) {
    throw new Error(`Invalid range: lo=${lo}, hi=${hi}`);
  }
  
  const range = hi - lo;
  const randomU32 = Number(nextU32(rng));
  
  // Используем деление с плавающей точкой для равномерного распределения
  const scaled = Math.floor((randomU32 / 0x100000000) * range);
  
  return lo + scaled;
}

/**
 * range_fixed(lo, hi): равномерно в [lo, hi) для fixed-point
 * lo + mul((next_u32() / 2^32), hi - lo)
 */
export function rangeFixed(rng: RngState, lo: Fixed, hi: Fixed): Fixed {
  if (lo >= hi) {
    throw new Error(`Invalid range: lo=${lo}, hi=${hi}`);
  }
  
  const randomU32 = nextU32(rng);
  // Нормализуем к [0, 1): random / 2^32
  const t = div(randomU32, BigInt(0x100000000));
  const range = hi - lo;
  
  return lo + mul(t, range);
}

/**
 * Константы для тест-векторов
 */
export const RNG_STATE_EMPTY: RngState = { state: BigInt(0), inc: BigInt(0) };
