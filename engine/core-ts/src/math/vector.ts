/** Vec2 в Q16.16 поверх fixed.ts (DI-2). */
import * as fixed from './fixed.js';
import type { Fixed, Vec2 } from '../types.js';

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: fixed.add(a.x, b.x), y: fixed.add(a.y, b.y) };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: fixed.sub(a.x, b.x), y: fixed.sub(a.y, b.y) };
}

export function scale(a: Vec2, s: Fixed): Vec2 {
  return { x: fixed.mul(a.x, s), y: fixed.mul(a.y, s) };
}

export function dot(a: Vec2, b: Vec2): Fixed {
  return fixed.add(fixed.mul(a.x, b.x), fixed.mul(a.y, b.y));
}

export function lengthSq(a: Vec2): Fixed {
  return dot(a, a);
}

export function length(a: Vec2): Fixed {
  return fixed.sqrt(lengthSq(a));
}

/**
 * Нулевой вектор нормализуется в {0,0}. Проверка явная, а не через `div`:
 * там деление на ноль — ошибка расчёта и в debug бросает assert (FP-5),
 * а здесь это штатный случай (сущность стоит на месте).
 */
export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0 };
  return { x: fixed.div(a.x, len), y: fixed.div(a.y, len) };
}
