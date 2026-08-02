import { describe, it, expect } from 'vitest';
import { pcg32_srandom, nextU32, nextBool, rangeU32, rangeFixed } from '../src/rng/pcg32';
import { toFixed } from '../src/fixed/fixed';

describe('PCG32 RNG (conventions.md §3)', () => {
  describe('pcg32_srandom', () => {
    it('should initialize with seed=42, seq=54', () => {
      const rng = pcg32_srandom(BigInt(42), BigInt(54));
      
      // После инициализации state и inc должны быть установлены
      expect(rng.state).toBeGreaterThan(BigInt(0));
      expect(rng.inc).toBeGreaterThan(BigInt(0));
      expect(rng.inc & BigInt(1)).toBe(BigInt(1)); // inc всегда нечётный
    });
  });

  describe('next_u32 test vectors', () => {
    it('should produce canonical values after seed=42, seq=54', () => {
      const rng = pcg32_srandom(BigInt(42), BigInt(54));
      
      // Тест-векторы из conventions.md §3
      const expectedValues = [
        BigInt('0xA15C02B7'), // Шаг 1
        BigInt('0x7B47F409'), // Шаг 2
        BigInt('0xBA1D3330'), // Шаг 3
        BigInt('0x83D2F293'), // Шаг 4
        BigInt('0xBFA4784B'), // Шаг 5
        BigInt('0xCBED606E'), // Шаг 6
      ];
      
      for (const expected of expectedValues) {
        const result = nextU32(rng);
        expect(result).toBe(expected);
      }
    });
  });

  describe('next_bool', () => {
    it('should return boolean values', () => {
      const rng = pcg32_srandom(BigInt(123), BigInt(456));
      
      const results: boolean[] = [];
      for (let i = 0; i < 100; i++) {
        results.push(nextBool(rng));
      }
      
      // Должны быть и true, и false
      expect(results.some(r => r)).toBe(true);
      expect(results.some(r => !r)).toBe(true);
    });
  });

  describe('range_u32', () => {
    it('should return values in range [lo, hi)', () => {
      const rng = pcg32_srandom(BigInt(789), BigInt(101));
      
      for (let i = 0; i < 100; i++) {
        const value = rangeU32(rng, BigInt(10), BigInt(20));
        expect(value).toBeGreaterThanOrEqual(BigInt(10));
        expect(value).toBeLessThan(BigInt(20));
      }
    });

    it('should throw on invalid range', () => {
      const rng = pcg32_srandom(BigInt(1), BigInt(1));
      expect(() => rangeU32(rng, BigInt(20), BigInt(10))).toThrow('Invalid range');
    });
  });

  describe('range_fixed', () => {
    it('should return values in fixed-point range', () => {
      const rng = pcg32_srandom(BigInt(321), BigInt(654));
      
      const lo = toFixed(0.0);
      const hi = toFixed(1.0);
      
      for (let i = 0; i < 100; i++) {
        const value = rangeFixed(rng, lo, hi);
        expect(value).toBeGreaterThanOrEqual(lo);
        expect(value).toBeLessThan(hi);
      }
    });
  });

  describe('determinism', () => {
    it('should produce same sequence with same seed', () => {
      const rng1 = pcg32_srandom(BigInt(999), BigInt(888));
      const rng2 = pcg32_srandom(BigInt(999), BigInt(888));
      
      for (let i = 0; i < 50; i++) {
        expect(nextU32(rng1)).toBe(nextU32(rng2));
      }
    });

    it('should produce different sequence with different seed', () => {
      const rng1 = pcg32_srandom(BigInt(111), BigInt(222));
      const rng2 = pcg32_srandom(BigInt(333), BigInt(444));
      
      const values1: bigint[] = [];
      const values2: bigint[] = [];
      
      for (let i = 0; i < 10; i++) {
        values1.push(nextU32(rng1));
        values2.push(nextU32(rng2));
      }
      
      expect(values1).not.toEqual(values2);
    });
  });
});
