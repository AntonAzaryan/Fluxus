/**
 * Fixed-point арифметика Q32.16 (32 бита целая часть, 16 бит дробная)
 * См. conventions.md §2
 * 
 * Тип Fixed = bigint, SCALE = 65536 (2^16)
 * Диапазон: ~-1.4×10^14 ... +1.4×10^14
 * Все операции — truncate toward zero (поведение BigInt по умолчанию)
 * Overflow → паника (бросает ошибку)
 */

export const SCALE = BigInt(65536); // 2^16
const SCALE_I128 = BigInt.asIntN(128, SCALE);

// Границы i64
const I64_MIN = BigInt('-9223372036854775808');
const I64_MAX = BigInt('9223372036854775807');

/**
 * Проверка на overflow i64
 */
function checkOverflow(value: bigint): bigint {
  if (value < I64_MIN || value > I64_MAX) {
    throw new Error(`Fixed-point overflow: ${value} outside i64 range`);
  }
  return value;
}

/**
 * Конвертация number → Fixed
 * @param value Число с плавающей точкой
 * @returns Fixed-point представление
 */
export function toFixed(value: number): Fixed {
  const result = BigInt(Math.round(value * Number(SCALE)));
  return checkOverflow(result);
}

/**
 * Конвертация Fixed → number
 * @param value Fixed-point значение
 * @returns Число с плавающей точкой
 */
export function fromFixed(value: Fixed): number {
  return Number(value) / Number(SCALE);
}

/**
 * Fixed-point тип (signed 64-bit integer)
 */
export type Fixed = bigint;

/**
 * Сложение: a + b
 * panic при overflow i64
 */
export function add(a: Fixed, b: Fixed): Fixed {
  return checkOverflow(a + b);
}

/**
 * Вычитание: a - b
 * panic при overflow i64
 */
export function sub(a: Fixed, b: Fixed): Fixed {
  return checkOverflow(a - b);
}

/**
 * Умножение: a * b с масштабированием
 * Формула: ((a * b) >> 16)
 * Используем i128 для промежуточного вычисления
 * truncate toward zero (поведение BigInt по умолчанию)
 */
export function mul(a: Fixed, b: Fixed): Fixed {
  // Конвертируем в i128 для промежуточного вычисления
  const a128 = BigInt.asIntN(128, a);
  const b128 = BigInt.asIntN(128, b);
  const product = a128 * b128;
  // Сдвиг вправо на 16 бит (деление на SCALE)
  const shifted = product >> BigInt(16);
  return checkOverflow(shifted);
}

/**
 * Деление: a / b с масштабированием
 * Формула: ((a << 16) / b)
 * truncate toward zero (поведение BigInt по умолчанию)
 * panic при b == 0 или overflow
 */
export function div(a: Fixed, b: Fixed): Fixed {
  if (b === BigInt(0)) {
    throw new Error('Division by zero');
  }
  const a128 = BigInt.asIntN(128, a);
  const b128 = BigInt.asIntN(128, b);
  const shifted = a128 << BigInt(16);
  const quotient = shifted / b128;
  return checkOverflow(quotient);
}

/**
 * Отрицание: -a
 * panic при a == i64::MIN
 */
export function neg(a: Fixed): Fixed {
  if (a === I64_MIN) {
    throw new Error('Fixed-point negation overflow: i64::MIN');
  }
  return checkOverflow(-a);
}

/**
 * Абсолютное значение: |a|
 * panic при a == i64::MIN
 */
export function abs(a: Fixed): Fixed {
  if (a === I64_MIN) {
    throw new Error('Fixed-point abs overflow: i64::MIN');
  }
  return checkOverflow(a < BigInt(0) ? -a : a);
}

/**
 * Округление вниз (floor): арифметический сдвиг вправо затем влево
 * Формула: (a >> 16) << 16
 */
export function floor(a: Fixed): Fixed {
  const shifted = a >> BigInt(16);
  return checkOverflow(shifted << BigInt(16));
}

/**
 * Округление вверх (ceil)
 * Для положительных: floor(a + SCALE - 1)
 * Для отрицательных: просто floor(a) если нет дробной части, иначе floor(a) + 1
 */
export function ceil(a: Fixed): Fixed {
  const floored = floor(a);
  if (floored === a) {
    return floored;
  }
  // Для отрицательных: ceil(-3.2) = -3.0, что больше чем floor(-3.2) = -4.0
  return checkOverflow(floored + SCALE);
}

/**
 * Округление до ближайшего целого (half-to-even / banker's rounding)
 * 0.5 → 0, 1.5 → 2, 2.5 → 2, -0.5 → 0
 */
export function round(a: Fixed): Fixed {
  const half = SCALE / BigInt(2);
  if (a >= BigInt(0)) {
    const remainder = a % SCALE;
    const truncated = a - remainder;
    if (remainder > half) {
      return checkOverflow(truncated + SCALE);
    } else if (remainder === half) {
      // Banker's rounding: round to even
      const quotient = truncated / SCALE;
      if (quotient % BigInt(2) === BigInt(0)) {
        return checkOverflow(truncated);
      } else {
        return checkOverflow(truncated + SCALE);
      }
    } else {
      return checkOverflow(truncated);
    }
  } else {
    const remainder = (-a) % SCALE;
    const truncated = a + remainder;
    if (remainder > half) {
      return checkOverflow(truncated - SCALE);
    } else if (remainder === half) {
      const quotient = truncated / SCALE;
      if (quotient % BigInt(2) === BigInt(0)) {
        return checkOverflow(truncated);
      } else {
        return checkOverflow(truncated - SCALE);
      }
    } else {
      return checkOverflow(truncated);
    }
  }
}

/**
 * Минимум из двух значений
 */
export function min(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b;
}

/**
 * Максимум из двух значений
 */
export function max(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b;
}

/**
 * Ограничение значения диапазоном [lo, hi]
 */
export function clamp(value: Fixed, lo: Fixed, hi: Fixed): Fixed {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Знак числа: -1, 0, или 1
 */
export function sign(a: Fixed): Fixed {
  if (a > BigInt(0)) return BigInt(1);
  if (a < BigInt(0)) return BigInt(-1);
  return BigInt(0);
}

/**
 * Целочисленный квадратный корень (метод Ньютона)
 * Вычисляет sqrt(x) * SCALE без floating point
 * @param x Радиканд (должен быть >= 0)
 * @returns sqrt(x) в fixed-point формате
 */
export function sqrt(x: Fixed): Fixed {
  if (x < BigInt(0)) {
    throw new Error('Square root of negative number');
  }
  if (x === BigInt(0)) return BigInt(0);

  // Метод Ньютона: x_{n+1} = (x_n + S/x_n) / 2
  // Начинаем с приближения x * SCALE
  const scaled = x * SCALE;
  let guess = scaled;
  
  // Итерации Ньютона
  for (let i = 0; i < 50; i++) {
    const nextGuess = (guess + scaled / guess) / BigInt(2);
    if (nextGuess >= guess) break;
    guess = nextGuess;
  }
  
  return checkOverflow(guess);
}

/**
 * Константа 0.0 в fixed-point
 */
export const ZERO: Fixed = BigInt(0);

/**
 * Константа 1.0 в fixed-point
 */
export const ONE: Fixed = SCALE;

/**
 * Константа 2.0 в fixed-point
 */
export const TWO: Fixed = SCALE * BigInt(2);

/**
 * Константа 0.5 в fixed-point
 */
export const HALF: Fixed = SCALE / BigInt(2);
