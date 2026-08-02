/**
 * Тригонометрические функции через LUT
 * conventions.md §10: LUT + линейная интерполяция, только целочисленная арифметика
 * 
 * Используем 4096 точек на квадрант (0..π/2)
 * Для остальных квадрантов — симметрия
 */

import { SIN_LUT, COS_LUT, ATAN_LUT, TABLE_SIZE } from './trigLut';
import { Fixed, mul, div, abs, sign, clamp, ZERO, ONE } from './fixed';

// Константы в fixed-point
const PI = BigInt(205887); // π ≈ 3.14159265358979 * 65536 ≈ 205887
const PI_OVER_2 = BigInt(102944); // π/2 ≈ 1.5707963267949 * 65536 ≈ 102944
const PI_OVER_4 = BigInt(51472); // π/4 ≈ 0.78539816339745 * 65536 ≈ 51472
const TWO_PI = BigInt(411774); // 2π ≈ 6.28318530717959 * 65536 ≈ 411774

/**
 * sin(x) через LUT + линейную интерполяцию
 * @param x Угол в fixed-point радианах
 * @returns sin(x) в fixed-point
 * 
 * Алгоритм:
 * 1. Нормализуем угол к диапазону [0, 2π)
 * 2. Определяем квадрант
 * 3. Берём базовый угол в первом квадранте
 * 4. Линейная интерполяция между соседними точками LUT
 * 5. Применяем знак по квадранту
 */
export function sin(x: Fixed): Fixed {
  // Нормализация к [0, 2π)
  let angle = x % TWO_PI;
  if (angle < ZERO) angle = angle + TWO_PI;

  // Определение квадранта
  if (angle < PI_OVER_2) {
    // Квадрант 1: sin положительный
    return lookupSin(angle);
  } else if (angle < PI) {
    // Квадрант 2: sin(π - x) = sin(x)
    return lookupSin(PI - angle);
  } else if (angle < PI_OVER_2 * BigInt(3)) {
    // Квадрант 3: sin(x - π) = -sin(x - π) = -sin(x - π)
    return -lookupSin(angle - PI);
  } else {
    // Квадрант 4: sin(2π - x) = -sin(x)
    return -lookupSin(TWO_PI - angle);
  }
}

/**
 * cos(x) через LUT + линейную интерполяцию
 * @param x Угол в fixed-point радианах
 * @returns cos(x) в fixed-point
 */
export function cos(x: Fixed): Fixed {
  // Нормализация к [0, 2π)
  let angle = x % TWO_PI;
  if (angle < ZERO) angle = angle + TWO_PI;

  // cos(x) = sin(π/2 - x) или через отдельную таблицу
  if (angle < PI_OVER_2) {
    // Квадрант 1: cos положительный
    return lookupCos(angle);
  } else if (angle < PI) {
    // Квадрант 2: cos отрицательный
    return -lookupCos(PI - angle);
  } else if (angle < PI_OVER_2 * BigInt(3)) {
    // Квадрант 3: cos отрицательный
    return -lookupCos(angle - PI);
  } else {
    // Квадрант 4: cos положительный
    return lookupCos(TWO_PI - angle);
  }
}

/**
 * atan2(y, x) через LUT + линейную интерполяцию
 * @param y Y-компонента в fixed-point
 * @param x X-компонента в fixed-point
 * @returns Угол в fixed-point радианах в диапазоне (-π, π]
 */
export function atan2(y: Fixed, x: Fixed): Fixed {
  // Обработка особых случаев
  if (x === ZERO) {
    if (y > ZERO) return PI_OVER_2;
    if (y < ZERO) return -PI_OVER_2;
    return ZERO; // atan2(0, 0) = 0 по определению
  }

  if (y === ZERO) {
    if (x > ZERO) return ZERO;
    return PI; // или -PI, но используем PI для диапазона (-π, π]
  }

  const absX = abs(x);
  const absY = abs(y);

  // Вычисляем базовый угол через LUT
  // Используем соотношение: atan(y/x)
  // Для эффективности: если |y| > |x|, используем atan(x/y) и вычитаем из π/2
  let angle: Fixed;

  if (absY <= absX) {
    // |y| <= |x|: используем отношение y/x (в диапазоне [0, 1])
    // ratio = |y| / |x|
    const ratio = (absY * ONE) / absX;
    angle = lookupAtanRatio(ratio);
  } else {
    // |y| > |x|: используем отношение x/y и дополняем до π/2
    // ratio = |x| / |y|
    const ratio = (absX * ONE) / absY;
    angle = PI_OVER_2 - lookupAtanRatio(ratio);
  }

  // Применяем знак по квадранту
  if (x > ZERO && y >= ZERO) {
    // Квадрант 1
    return angle;
  } else if (x < ZERO && y >= ZERO) {
    // Квадрант 2: π - angle
    return PI - angle;
  } else if (x < ZERO && y < ZERO) {
    // Квадрант 3: -π + angle
    return -PI + angle;
  } else {
    // Квадрант 4: -angle
    return -angle;
  }
}

/**
 * Lookup sin с линейной интерполяцией
 * @param angle Угол в диапазоне [0, π/2]
 */
function lookupSin(angle: Fixed): Fixed {
  // Индекс в таблице: angle / (π/2) * TABLE_SIZE
  // index = (angle * TABLE_SIZE) / (π/2)
  const index = (angle * BigInt(TABLE_SIZE)) / PI_OVER_2;

  // Граничный случай: π/2
  if (index >= BigInt(TABLE_SIZE)) {
    return SIN_LUT[TABLE_SIZE]; // sin(π/2) = 1.0
  }

  const i = Number(index);
  
  // Остаток для интерполяции
  const remainder = (angle * BigInt(TABLE_SIZE)) % PI_OVER_2;
  
  // Линейная интерполяция: y0 + (y1 - y0) * t
  // t = remainder / TABLE_SIZE (в диапазоне [0, 1))
  const y0 = SIN_LUT[i];
  const y1 = SIN_LUT[i + 1];
  
  // Интерполяция: y0 + (y1 - y0) * (remainder / TABLE_SIZE)
  // = y0 + (y1 - y0) * remainder / TABLE_SIZE
  const interpolated = y0 + ((y1 - y0) * remainder) / BigInt(TABLE_SIZE);
  
  return interpolated;
}

/**
 * Lookup cos с линейной интерполяцией
 * @param angle Угол в диапазоне [0, π/2]
 */
function lookupCos(angle: Fixed): Fixed {
  const index = (angle * BigInt(TABLE_SIZE)) / PI_OVER_2;

  // Граничный случай: π/2
  if (index >= BigInt(TABLE_SIZE)) {
    return COS_LUT[TABLE_SIZE]; // cos(π/2) = 0
  }

  const i = Number(index);
  const remainder = (angle * BigInt(TABLE_SIZE)) % PI_OVER_2;

  const y0 = COS_LUT[i];
  const y1 = COS_LUT[i + 1];
  
  // Интерполяция: y0 + (y1 - y0) * (remainder / TABLE_SIZE)
  const interpolated = y0 + ((y1 - y0) * remainder) / BigInt(TABLE_SIZE);
  
  return interpolated;
}

/**
 * Lookup atan с линейной интерполяцией
 * @param ratio Отношение y/x (или x/y для комплементарного угла)
 * @returns atan(ratio) в fixed-point радианах
 */
function lookupAtanRatio(ratio: Fixed): Fixed {
  // ratio в диапазоне [0, 1]
  // Индекс в таблице: ratio * TABLE_SIZE
  const index = (ratio * BigInt(TABLE_SIZE)) / ONE;

  if (index >= BigInt(TABLE_SIZE)) {
    return ATAN_LUT[TABLE_SIZE]; // atan(1) = π/4
  }

  const i = Number(index);
  const remainder = (ratio * BigInt(TABLE_SIZE)) % ONE;

  const y0 = ATAN_LUT[i];
  const y1 = ATAN_LUT[i + 1];
  
  // Интерполяция: y0 + (y1 - y0) * (remainder / TABLE_SIZE)
  const interpolated = y0 + ((y1 - y0) * remainder) / BigInt(TABLE_SIZE);
  
  return interpolated;
}

/**
 * Проверка: sin(0) = 0, cos(0) = 1.0
 */
export function verifyTrigConstants(): boolean {
  return sin(ZERO) === ZERO && cos(ZERO) === ONE;
}
