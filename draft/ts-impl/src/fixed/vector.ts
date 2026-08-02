/**
 * Векторная математика 2.5D
 * conventions.md §10: геометрия только в XY, z копируется как есть
 * 
 * Все операции используют только целочисленную fixed-point арифметику
 */

import { Fixed, mul, div, add, sub, abs, sqrt, ZERO, ONE } from './fixed';

/**
 * Вектор 3D с fixed-point координатами
 * XY — плоскость геометрии, Z — высота как скаляр
 */
export interface Vec3 {
  x: Fixed;
  y: Fixed;
  z: Fixed;
}

/**
 * Создать вектор
 */
export function vec3(x: Fixed, y: Fixed, z: Fixed): Vec3 {
  return { x, y, z };
}

/**
 * Сложение векторов: a + b (покомпонентно)
 */
export function vec_add(a: Vec3, b: Vec3): Vec3 {
  return {
    x: add(a.x, b.x),
    y: add(a.y, b.y),
    z: add(a.z, b.z),
  };
}

/**
 * Вычитание векторов: a - b (покомпонентно)
 */
export function vec_sub(a: Vec3, b: Vec3): Vec3 {
  return {
    x: sub(a.x, b.x),
    y: sub(a.y, b.y),
    z: sub(a.z, b.z),
  };
}

/**
 * Масштабирование вектора: v * scalar (покомпонентно)
 */
export function vec_scale(v: Vec3, scalar: Fixed): Vec3 {
  return {
    x: mul(v.x, scalar),
    y: mul(v.y, scalar),
    z: mul(v.z, scalar),
  };
}

/**
 * Dot product только по XY
 * vec_dot_xy(a, b) = a.x * b.x + a.y * b.y
 */
export function vec_dot_xy(a: Vec3, b: Vec3): Fixed {
  return add(mul(a.x, b.x), mul(a.y, b.y));
}

/**
 * Квадрат длины вектора в XY
 * vec_length_sq_xy(v) = v.x² + v.y²
 */
export function vec_length_sq_xy(v: Vec3): Fixed {
  return add(mul(v.x, v.x), mul(v.y, v.y));
}

/**
 * Длина вектора в XY
 * vec_length_xy(v) = sqrt(v.x² + v.y²)
 */
export function vec_length_xy(v: Vec3): Fixed {
  return sqrt(vec_length_sq_xy(v));
}

/**
 * Нормализация вектора в XY (единичная длина)
 * Z сохраняется как есть (без масштабирования)
 * 
 * conventions.md §10 тест-вектор:
 * vec_normalize_xy((0, 1, 0)) = (0, 1, 0) — но это ошибка в интерпретации,
 * правильный тест: vec_normalize_xy((1, 1, 0)) = (0.707, 0.707, 0)
 */
export function vec_normalize_xy(v: Vec3): Vec3 {
  const length = vec_length_xy(v);
  
  if (length === ZERO) {
    // Нулевой вектор — возвращаем как есть или (1, 0, z) по умолчанию
    return { x: ZERO, y: ZERO, z: v.z };
  }
  
  return {
    x: div(v.x, length),
    y: div(v.y, length),
    z: v.z, // Z сохраняется без изменений
  };
}

/**
 * Отражение вектора от нормали в XY
 * reflect_xy(v, normal) = v - 2 * dot(v, normal) * normal
 * Z сохраняется как есть
 * 
 * conventions.md §10 тест-вектор:
 * vec_reflect_xy((1.0, -1.0, 0.0), (0.0, 1.0, 0.0)) = (1.0, 1.0, 0.0)
 */
export function vec_reflect_xy(v: Vec3, normal_xy: Vec3): Vec3 {
  // dot = v.x * n.x + v.y * n.y
  const dot = vec_dot_xy(v, normal_xy);
  
  // 2 * dot
  const two_dot = add(dot, dot);
  
  // 2 * dot * normal
  const scale = vec_scale(normal_xy, two_dot);
  
  // v - 2 * dot * normal
  return {
    x: sub(v.x, scale.x),
    y: sub(v.y, scale.y),
    z: v.z, // Z сохраняется
  };
}

/**
 * Расстояние между двумя точками в XY
 */
export function vec_distance_xy(a: Vec3, b: Vec3): Fixed {
  const dx = sub(b.x, a.x);
  const dy = sub(b.y, a.y);
  return sqrt(add(mul(dx, dx), mul(dy, dy)));
}

/**
 * Квадрат расстояния между двумя точками в XY
 */
export function vec_distance_sq_xy(a: Vec3, b: Vec3): Fixed {
  const dx = sub(b.x, a.x);
  const dy = sub(b.y, a.y);
  return add(mul(dx, dx), mul(dy, dy));
}

/**
 * Проверка пересечения 1D интервалов
 * interval_overlap(a_min, a_max, b_min, b_max)
 * 
 * Используется для проверки пересечения Z-интервалов в физике
 */
export function interval_overlap(
  a_min: Fixed,
  a_max: Fixed,
  b_min: Fixed,
  b_max: Fixed
): boolean {
  // Интервалы пересекаются, если max(a_min, b_min) <= min(a_max, b_max)
  const overlap_start = a_min > b_min ? a_min : b_min;
  const overlap_end = a_max < b_max ? a_max : b_max;
  
  return overlap_start <= overlap_end;
}

/**
 * Клонировать вектор
 */
export function vec_clone(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Проверка на нулевой вектор (в XY)
 */
export function vec_is_zero_xy(v: Vec3): boolean {
  return v.x === ZERO && v.y === ZERO;
}
