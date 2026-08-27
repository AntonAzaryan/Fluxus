/**
 * Общая модель utility-скоринга (`npc-behavior` NPC-3, `bot-player` BOT-9):
 * закрытый набор форм кривых, состав их параметров, оценка оси и композиция.
 *
 * Проверяется ровно то, что модель обещает обоим потребителям: диапазон [0, 1],
 * форма каждой кривой, совпадение двух считалок в пределах точности Q16.16 и
 * нормативность таблицы логистики — её узлы сверяются с формулой, как узлы
 * таблицы синуса (FP-8).
 */
import { describe, expect, it } from 'vitest';
import {
  clamp01,
  clamp01Fixed,
  combineUtility,
  combineUtilityFixed,
  considerationScore,
  considerationScoreFixed,
  curveValue,
  curveValueFixed,
  finishUtility,
  finishUtilityFixed,
  logisticFixed,
  CURVE_CONSTANT,
  CURVE_LINEAR,
  CURVE_LOGISTIC,
  CURVE_QUADRATIC,
  SCORING_CURVES,
  SCORING_CURVE_FIELDS,
  UTILITY_IDENTITY,
  UTILITY_IDENTITY_FIXED,
  type FixedCurve,
  type ScoringCurve,
} from '../src/index.js';
import { CURVE_CODES } from '../src/systems/npc/tables.js';
import { fromFloat, toFloat } from '../src/math/fixed.js';
import { FIXED_ONE } from '../src/types.js';

/** Кривая Q16.16 из позиционных параметров — та же раскладка, что у компилятора документа. */
function fixedCurve(type: number, a: number, b = 0, c = 0): FixedCurve {
  return { type, a: fromFloat(a), b: fromFloat(b), c: fromFloat(c) };
}

describe('NPC-3: набор форм кривых закрыт и общий', () => {
  it('у каждой формы объявлены поля, и порядок полей нормативен', () => {
    expect([...SCORING_CURVES]).toEqual(['linear', 'quadratic', 'logistic', 'constant']);
    expect(SCORING_CURVE_FIELDS.linear.map((f) => f.key)).toEqual(['slope', 'intercept']);
    expect(SCORING_CURVE_FIELDS.quadratic.map((f) => f.key)).toEqual(['slope', 'intercept', 'shift']);
    expect(SCORING_CURVE_FIELDS.logistic.map((f) => f.key)).toEqual(['slope', 'midpoint']);
    expect(SCORING_CURVE_FIELDS.constant.map((f) => f.key)).toEqual(['value']);
  });

  it('доля объявлена одна — постоянная кривая; остальные поля коэффициенты', () => {
    const unit = SCORING_CURVES.flatMap((type) =>
      SCORING_CURVE_FIELDS[type].filter((f) => f.unit).map((f) => `${type}.${f.key}`),
    );
    expect(unit).toEqual(['constant.value']);
  });

  it('словарь форм документа NPC выведен из модели, а не переписан рядом', () => {
    // Тот самый сценарий NPC-3 «Новая форма кривой»: коды разбора документа NPC
    // обязаны быть ФУНКЦИЕЙ набора модели, иначе форма, добавленная в модель,
    // молча отвергалась бы у одного потребителя и принималась у другого.
    expect(Object.keys(CURVE_CODES).sort()).toEqual([...SCORING_CURVES].sort());
    for (const [name, code] of Object.entries(CURVE_CODES)) {
      expect(SCORING_CURVES[code], name).toBe(name);
    }
  });

  it('код формы совпадает с местом в словаре: позиция нормативна', () => {
    expect(SCORING_CURVES[CURVE_LINEAR]).toBe('linear');
    expect(SCORING_CURVES[CURVE_QUADRATIC]).toBe('quadratic');
    expect(SCORING_CURVES[CURVE_LOGISTIC]).toBe('logistic');
    expect(SCORING_CURVES[CURVE_CONSTANT]).toBe('constant');
  });
});

describe('NPC-3: считалка вне симуляции', () => {
  it('linear: убывающая задаётся отрицательным наклоном, результат зажат', () => {
    const curve: ScoringCurve = { type: 'linear', slope: -2, intercept: 1 };
    expect(curveValue(curve, 0)).toBeCloseTo(1, 12);
    expect(curveValue(curve, 0.25)).toBeCloseTo(0.5, 12);
    expect(curveValue(curve, 1)).toBe(0);
    expect(curveValue({ type: 'linear', slope: 5, intercept: 0 }, 1)).toBe(1);
  });

  it('quadratic: сдвиг вершины — поле кривой', () => {
    const curve: ScoringCurve = { type: 'quadratic', slope: 1, intercept: 0, shift: 1 };
    expect(curveValue(curve, 1)).toBe(0);
    expect(curveValue(curve, 0)).toBeCloseTo(1, 12);
    expect(curveValue(curve, 0.5)).toBeCloseTo(0.25, 12);
  });

  it('logistic: порог с плавными краями, середина — поле кривой', () => {
    const curve: ScoringCurve = { type: 'logistic', slope: 10, midpoint: 0.5 };
    expect(curveValue(curve, 0.5)).toBe(0.5);
    expect(curveValue(curve, 0)).toBeLessThan(0.02);
    expect(curveValue(curve, 1)).toBeGreaterThan(0.98);
  });

  it('constant: вход не читается вовсе', () => {
    expect(curveValue({ type: 'constant', value: 0.25 }, 0)).toBe(0.25);
    expect(curveValue({ type: 'constant', value: 0.25 }, 1)).toBe(0.25);
  });

  it('оценка оси — кривая, взвешенная документом; композиция — произведение', () => {
    const curve: ScoringCurve = { type: 'linear', slope: 1, intercept: 0 };
    expect(considerationScore(curve, 0.5, 0.6)).toBeCloseTo(0.3, 12);
    const utility = finishUtility(combineUtility(combineUtility(UTILITY_IDENTITY, 0.5), 0.5));
    expect(utility).toBeCloseTo(0.25, 12);
    // Ось с нулём выключает действие целиком.
    expect(finishUtility(combineUtility(UTILITY_IDENTITY, 0))).toBe(0);
  });

  it('не-число читается как ноль: вырожденный масштаб не отравляет сравнение', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});

describe('NPC-3: считалка симуляции считает то же в Q16.16 (DET-2)', () => {
  it('таблица логистики нормативна: каждый узел равен формуле', () => {
    for (let i = 0; i <= 128; i++) {
      const z = i / 16;
      const expected = Math.round(FIXED_ONE / (1 + Math.exp(-z)));
      expect(logisticFixed(fromFloat(z)), `узел ${i}`).toBe(expected);
    }
  });

  it('логистика симметрична и плоская за таблицей', () => {
    expect(logisticFixed(0)).toBe(FIXED_ONE / 2);
    for (const z of [0.5, 1.25, 3, 7.5]) {
      expect(logisticFixed(fromFloat(-z)) + logisticFixed(fromFloat(z))).toBe(FIXED_ONE);
    }
    expect(logisticFixed(fromFloat(20))).toBe(logisticFixed(fromFloat(8)));
  });

  it('обе считалки сходятся в пределах точности Q16.16', () => {
    const cases: readonly [ScoringCurve, FixedCurve][] = [
      [{ type: 'linear', slope: -2, intercept: 1 }, fixedCurve(CURVE_LINEAR, -2, 1)],
      [{ type: 'quadratic', slope: 1, intercept: 0, shift: 1 }, fixedCurve(CURVE_QUADRATIC, 1, 0, 1)],
      [{ type: 'logistic', slope: 10, midpoint: 0.5 }, fixedCurve(CURVE_LOGISTIC, 10, 0.5)],
      [{ type: 'constant', value: 0.25 }, fixedCurve(CURVE_CONSTANT, 0.25)],
    ];
    for (const [curve, compiled] of cases) {
      for (const x of [0, 0.125, 0.25, 0.5, 0.75, 1]) {
        expect(toFloat(curveValueFixed(compiled, fromFloat(x))), `${curve.type} @ ${x}`).toBeCloseTo(
          curveValue(curve, x),
          3,
        );
      }
    }
  });

  it('диапазон [0, 1] сохраняется: зажим, оценка оси и композиция', () => {
    expect(clamp01Fixed(-FIXED_ONE)).toBe(0);
    expect(clamp01Fixed(2 * FIXED_ONE)).toBe(FIXED_ONE);
    // Крутая прямая за единицу не выходит.
    expect(curveValueFixed(fixedCurve(CURVE_LINEAR, 5, 0), FIXED_ONE)).toBe(FIXED_ONE);
    const half = FIXED_ONE / 2;
    expect(considerationScoreFixed(fixedCurve(CURVE_CONSTANT, 1), half, 0)).toBe(half);
    const utility = finishUtilityFixed(
      combineUtilityFixed(combineUtilityFixed(UTILITY_IDENTITY_FIXED, half), half),
    );
    expect(utility).toBe(FIXED_ONE / 4);
    expect(finishUtilityFixed(combineUtilityFixed(UTILITY_IDENTITY_FIXED, 0))).toBe(0);
  });
});
