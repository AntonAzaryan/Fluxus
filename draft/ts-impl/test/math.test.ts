import { describe, it, expect } from 'vitest';
import { toFixed, sqrt, ZERO, ONE, TWO, fromFixed } from '../src/fixed/fixed';
import {
  vec3,
  vec_add,
  vec_sub,
  vec_scale,
  vec_dot_xy,
  vec_length_xy,
  vec_length_sq_xy,
  vec_normalize_xy,
  vec_reflect_xy,
  vec_distance_xy,
  vec_distance_sq_xy,
  interval_overlap,
} from '../src/fixed/vector';
import { sin, cos, atan2 } from '../src/fixed/trig';

describe('Math library (conventions.md §10)', () => {
  describe('sqrt', () => {
    it('should compute sqrt(4.0) = 2.0', () => {
      // Тест-вектор: sqrt(4.0) = 131072 (= 2.0)
      expect(sqrt(toFixed(4.0))).toBe(toFixed(2.0));
    });

    it('should compute sqrt(2.0)', () => {
      // Тест-вектор: sqrt(2.0) = 92681 (≈ 1.41419983)
      expect(sqrt(toFixed(2.0))).toBe(BigInt(92681));
    });
  });

  describe('vec_length_xy', () => {
    it('should compute length of (3.0, 4.0, 0.0) = 5.0', () => {
      // Тест-вектор: vec_length_xy((3.0, 4.0, 0.0)) = 327680 (= 5.0)
      const v = vec3(toFixed(3.0), toFixed(4.0), ZERO);
      expect(vec_length_xy(v)).toBe(toFixed(5.0));
    });
  });

  describe('vec_reflect_xy', () => {
    it('should reflect (1.0, -1.0, 0.0) from (0.0, 1.0, 0.0) to (1.0, 1.0, 0.0)', () => {
      // Тест-вектор: vec_reflect_xy((1.0, -1.0, 0.0), (0.0, 1.0, 0.0)) = (1.0, 1.0, 0.0)
      const v = vec3(toFixed(1.0), toFixed(-1.0), ZERO);
      const normal = vec3(ZERO, ONE, ZERO);
      const result = vec_reflect_xy(v, normal);
      
      expect(result.x).toBe(toFixed(1.0));
      expect(result.y).toBe(toFixed(1.0));
      expect(result.z).toBe(ZERO);
    });
  });

  describe('vec_normalize_xy', () => {
    it('should normalize (1.0, 1.0, 0.0) to unit length', () => {
      const v = vec3(ONE, ONE, ZERO);
      const result = vec_normalize_xy(v);
      
      // Длина должна быть 1.0
      const length = vec_length_xy(result);
      // sqrt(2) ≈ 1.414, после нормализации должно быть ~1.0
      expect(fromFixed(length)).toBeCloseTo(1.0, 4);
      // Компоненты должны быть ≈ 0.707
      expect(fromFixed(result.x)).toBeCloseTo(0.707, 2);
      expect(fromFixed(result.y)).toBeCloseTo(0.707, 2);
      expect(result.z).toBe(ZERO);
    });

    it('should handle zero vector', () => {
      const v = vec3(ZERO, ZERO, ZERO);
      const result = vec_normalize_xy(v);
      expect(result.x).toBe(ZERO);
      expect(result.y).toBe(ZERO);
    });
  });

  describe('vec_dot_xy', () => {
    it('should compute dot product in XY', () => {
      const a = vec3(ONE, ZERO, ZERO);
      const b = vec3(ZERO, ONE, ZERO);
      expect(vec_dot_xy(a, b)).toBe(ZERO); // Перпендикулярны
    });

    it('should compute dot product of parallel vectors', () => {
      const a = vec3(ONE, ZERO, ZERO);
      const b = vec3(toFixed(2.0), ZERO, ZERO);
      expect(vec_dot_xy(a, b)).toBe(toFixed(2.0)); // 1 * 2 = 2
    });
  });

  describe('vec_add/sub/scale', () => {
    it('should add vectors', () => {
      const a = vec3(ONE, ZERO, ZERO);
      const b = vec3(ZERO, ONE, ZERO);
      const result = vec_add(a, b);
      expect(result.x).toBe(ONE);
      expect(result.y).toBe(ONE);
    });

    it('should subtract vectors', () => {
      const a = vec3(toFixed(2.0), toFixed(2.0), ZERO);
      const b = vec3(ONE, ONE, ZERO);
      const result = vec_sub(a, b);
      expect(result.x).toBe(ONE);
      expect(result.y).toBe(ONE);
    });

    it('should scale vector', () => {
      const v = vec3(ONE, ONE, ONE);
      const result = vec_scale(v, toFixed(2.0));
      expect(result.x).toBe(toFixed(2.0));
      expect(result.y).toBe(toFixed(2.0));
      expect(result.z).toBe(toFixed(2.0));
    });
  });

  describe('interval_overlap', () => {
    it('should detect overlapping intervals', () => {
      expect(interval_overlap(ZERO, toFixed(5.0), toFixed(3.0), toFixed(8.0))).toBe(true);
    });

    it('should detect non-overlapping intervals', () => {
      expect(interval_overlap(ZERO, toFixed(2.0), toFixed(3.0), toFixed(5.0))).toBe(false);
    });

    it('should detect touching intervals', () => {
      expect(interval_overlap(ZERO, toFixed(3.0), toFixed(3.0), toFixed(5.0))).toBe(true);
    });
  });

  describe('sin/cos', () => {
    it('should compute sin(0) = 0', () => {
      expect(sin(ZERO)).toBe(ZERO);
    });

    it('should compute cos(0) = 1.0', () => {
      expect(cos(ZERO)).toBe(ONE);
    });

    it('should compute sin(π/2) ≈ 1.0', () => {
      // π/2 в fixed-point
      const piOver2 = BigInt(102944);
      const result = sin(piOver2);
      // Ожидаем ~1.0 с небольшой погрешностью LUT
      // 1.0 = 65536 в fixed-point
      const expected = ONE;
      const tolerance = toFixed(0.01); // 1% погрешность
      expect(result).toBeGreaterThanOrEqual(expected - tolerance);
      expect(result).toBeLessThanOrEqual(expected + tolerance);
    });

    it('should compute cos(π/2) ≈ 0', () => {
      const piOver2 = BigInt(102944);
      const result = cos(piOver2);
      // Ожидаем ~0 с небольшой погрешностью LUT
      const tolerance = toFixed(0.01);
      expect(result).toBeGreaterThanOrEqual(-tolerance);
      expect(result).toBeLessThanOrEqual(tolerance);
    });
  });

  describe('atan2', () => {
    it('should compute atan2(0, 1.0) = 0', () => {
      expect(atan2(ZERO, ONE)).toBe(ZERO);
    });

    it('should compute atan2(1.0, 1.0) = π/4', () => {
      // atan2(1, 1) = π/4 ≈ 0.78539816339745
      // π/4 в fixed-point = 51472
      const result = atan2(ONE, ONE);
      const expected = BigInt(51472);
      const tolerance = BigInt(100); // ~0.0015 радиан
      expect(result).toBeGreaterThanOrEqual(expected - tolerance);
      expect(result).toBeLessThanOrEqual(expected + tolerance);
    });

    it('should compute atan2(1.0, 0) = π/2', () => {
      // atan2(1, 0) = π/2 ≈ 1.5707963267949
      // π/2 в fixed-point = 102944
      const result = atan2(ONE, ZERO);
      const expected = BigInt(102944);
      const tolerance = BigInt(100);
      expect(result).toBeGreaterThanOrEqual(expected - tolerance);
      expect(result).toBeLessThanOrEqual(expected + tolerance);
    });
  });

  describe('vec_distance_xy', () => {
    it('should compute distance between (0,0) and (3,4) = 5', () => {
      const a = vec3(ZERO, ZERO, ZERO);
      const b = vec3(toFixed(3.0), toFixed(4.0), ZERO);
      expect(vec_distance_xy(a, b)).toBe(toFixed(5.0));
    });
  });
});
