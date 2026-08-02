import { describe, it, expect } from 'vitest';
import {
  toFixed,
  fromFixed,
  add,
  sub,
  mul,
  div,
  neg,
  abs,
  floor,
  ceil,
  round,
  min,
  max,
  clamp,
  sign,
  sqrt,
  SCALE,
  ONE,
  TWO,
  HALF,
  ZERO,
} from '../src/fixed/fixed';

describe('Fixed-point arithmetic (conventions.md §2)', () => {
  describe('to/from Fixed', () => {
    it('should convert 1.5 correctly', () => {
      // Тест-вектор: to_fixed(1.5) = 98304
      expect(toFixed(1.5)).toBe(BigInt(98304));
    });

    it('should convert 2.0 correctly', () => {
      expect(toFixed(2.0)).toBe(BigInt(131072));
    });

    it('should round-trip correctly', () => {
      const value = 3.14159;
      const fixed = toFixed(value);
      const back = fromFixed(fixed);
      expect(back).toBeCloseTo(value, 4);
    });
  });

  describe('add', () => {
    it('should add positive numbers', () => {
      expect(add(toFixed(1.5), toFixed(2.0))).toBe(toFixed(3.5));
    });

    it('should add negative numbers', () => {
      expect(add(toFixed(-1.5), toFixed(-2.0))).toBe(toFixed(-3.5));
    });
  });

  describe('sub', () => {
    it('should subtract correctly', () => {
      expect(sub(toFixed(5.0), toFixed(2.0))).toBe(toFixed(3.0));
    });
  });

  describe('mul', () => {
    it('should multiply 1.5 * 2.0 = 3.0', () => {
      // Тест-вектор: mul(1.5, 2.0) = 196608 (= 3.0)
      expect(mul(toFixed(1.5), toFixed(2.0))).toBe(toFixed(3.0));
    });

    it('should multiply 0.1 * 0.1 with truncation', () => {
      // Тест-вектор: mul(0.1, 0.1) = 655 (≈ 0.00999)
      const result = mul(toFixed(0.1), toFixed(0.1));
      expect(result).toBe(BigInt(655));
    });

    it('should handle negative multiplication', () => {
      expect(mul(toFixed(-2.0), toFixed(3.0))).toBe(toFixed(-6.0));
    });
  });

  describe('div', () => {
    it('should divide 1.0 / 3.0', () => {
      // Тест-вектор: div(1.0, 3.0) = 21845 (≈ 0.33332825)
      expect(div(toFixed(1.0), toFixed(3.0))).toBe(BigInt(21845));
    });

    it('should divide -1.0 / 3.0 with truncate toward zero', () => {
      // Тест-вектор: div(-1.0, 3.0) = -21845
      expect(div(toFixed(-1.0), toFixed(3.0))).toBe(BigInt(-21845));
    });

    it('should throw on division by zero', () => {
      expect(() => div(toFixed(1.0), ZERO)).toThrow('Division by zero');
    });
  });

  describe('neg', () => {
    it('should negate positive number', () => {
      expect(neg(toFixed(5.0))).toBe(toFixed(-5.0));
    });

    it('should negate negative number', () => {
      expect(neg(toFixed(-5.0))).toBe(toFixed(5.0));
    });
  });

  describe('abs', () => {
    it('should return absolute value', () => {
      expect(abs(toFixed(-5.0))).toBe(toFixed(5.0));
      expect(abs(toFixed(5.0))).toBe(toFixed(5.0));
      expect(abs(ZERO)).toBe(ZERO);
    });
  });

  describe('sqrt', () => {
    it('should compute sqrt(2.0)', () => {
      // Тест-вектор: sqrt(2.0) = 92681 (≈ 1.41419983)
      expect(sqrt(toFixed(2.0))).toBe(BigInt(92681));
    });

    it('should compute sqrt(4.0) = 2.0', () => {
      // Тест-вектор: sqrt(4.0) = 131072 (= 2.0)
      expect(sqrt(toFixed(4.0))).toBe(toFixed(2.0));
    });

    it('should compute sqrt(0) = 0', () => {
      // Тест-вектор: sqrt(0) = 0
      expect(sqrt(ZERO)).toBe(ZERO);
    });

    it('should throw on negative sqrt', () => {
      expect(() => sqrt(toFixed(-1.0))).toThrow('Square root of negative number');
    });
  });

  describe('floor', () => {
    it('should floor positive number', () => {
      expect(floor(toFixed(3.7))).toBe(toFixed(3.0));
    });

    it('should floor negative number', () => {
      expect(floor(toFixed(-3.7))).toBe(toFixed(-4.0));
    });
  });

  describe('ceil', () => {
    it('should ceil positive number', () => {
      expect(ceil(toFixed(3.2))).toBe(toFixed(4.0));
    });

    it('should ceil negative number', () => {
      // ceil(-3.2) = -3.0 (ближайшее целое вверх)
      expect(ceil(toFixed(-3.2))).toBe(toFixed(-3.0));
    });
  });

  describe('round (banker\'s rounding)', () => {
    it('should round 0.5 to 0 (half-to-even)', () => {
      expect(round(toFixed(0.5))).toBe(ZERO);
    });

    it('should round 1.5 to 2 (half-to-even)', () => {
      expect(round(toFixed(1.5))).toBe(TWO);
    });

    it('should round 2.5 to 2 (half-to-even)', () => {
      expect(round(toFixed(2.5))).toBe(TWO);
    });
  });

  describe('min/max/clamp', () => {
    it('should return min', () => {
      expect(min(toFixed(1.0), toFixed(2.0))).toBe(toFixed(1.0));
    });

    it('should return max', () => {
      expect(max(toFixed(1.0), toFixed(2.0))).toBe(toFixed(2.0));
    });

    it('should clamp value', () => {
      expect(clamp(toFixed(5.0), toFixed(0.0), toFixed(3.0))).toBe(toFixed(3.0));
      expect(clamp(toFixed(-1.0), toFixed(0.0), toFixed(3.0))).toBe(toFixed(0.0));
      expect(clamp(toFixed(1.5), toFixed(0.0), toFixed(3.0))).toBe(toFixed(1.5));
    });
  });

  describe('sign', () => {
    it('should return 1 for positive', () => {
      expect(sign(toFixed(5.0))).toBe(BigInt(1));
    });

    it('should return -1 for negative', () => {
      expect(sign(toFixed(-5.0))).toBe(BigInt(-1));
    });

    it('should return 0 for zero', () => {
      expect(sign(ZERO)).toBe(ZERO);
    });
  });

  describe('constants', () => {
    it('should have correct SCALE', () => {
      expect(SCALE).toBe(BigInt(65536));
    });

    it('should have correct ONE', () => {
      expect(ONE).toBe(SCALE);
    });

    it('should have correct TWO', () => {
      expect(TWO).toBe(SCALE * BigInt(2));
    });

    it('should have correct HALF', () => {
      expect(HALF).toBe(SCALE / BigInt(2));
    });
  });
});
