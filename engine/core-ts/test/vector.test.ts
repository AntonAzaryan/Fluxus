import { describe, expect, it } from 'vitest';
import { fromFloat, toFloat } from '../src/math/fixed.js';
import type { Vec2 } from '../src/types.js';
import * as vec from '../src/math/vector.js';

function v(x: number, y: number): Vec2 {
  return { x: fromFloat(x), y: fromFloat(y) };
}

function toFloats(a: Vec2): { x: number; y: number } {
  return { x: toFloat(a.x), y: toFloat(a.y) };
}

describe('Vec2', () => {
  it('add/sub', () => {
    expect(toFloats(vec.add(v(1, 2), v(3, 4)))).toEqual({ x: 4, y: 6 });
    expect(toFloats(vec.sub(v(3, 4), v(1, 2)))).toEqual({ x: 2, y: 2 });
  });

  it('scale', () => {
    const scaled = toFloats(vec.scale(v(1, 2), fromFloat(2)));
    expect(scaled.x).toBeCloseTo(2, 4);
    expect(scaled.y).toBeCloseTo(4, 4);
  });

  it('dot', () => {
    expect(toFloat(vec.dot(v(1, 2), v(3, 4)))).toBeCloseTo(1 * 3 + 2 * 4, 3);
  });

  it('lengthSq', () => {
    expect(toFloat(vec.lengthSq(v(3, 4)))).toBeCloseTo(25, 3);
  });

  it('length — классический треугольник 3-4-5', () => {
    expect(toFloat(vec.length(v(3, 4)))).toBeCloseTo(5, 2);
  });

  it('normalize — единичный вектор в том же направлении', () => {
    const n = toFloats(vec.normalize(v(3, 4)));
    expect(n.x).toBeCloseTo(3 / 5, 2);
    expect(n.y).toBeCloseTo(4 / 5, 2);
  });
});
