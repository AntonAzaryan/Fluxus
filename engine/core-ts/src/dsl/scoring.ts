/**
 * Общая модель utility-скоринга (`npc-behavior` NPC-3, `bot-player` BOT-9):
 * действие оценивается списком considerations, каждый называет вход, КРИВУЮ
 * ОТКЛИКА из закрытого набора форм и вес; оценка оси лежит в [0, 1], полезность
 * действия — их композиция, сохраняющая диапазон.
 *
 * Здесь живёт ровно то, что у двух потребителей общее: набор форм кривых, их
 * параметры, вычисление оценки оси и правило композиции. Словари ВХОДОВ у
 * каждого свои (NPC-3): у бота они производны от его отфильтрованного
 * наблюдения (BOT-3), у NPC — от прямого чтения мира (NPC-1). Новая форма
 * кривой — правка этого файла, и она сразу доступна обоим документам.
 *
 * ## Почему считалок ДВЕ
 *
 * Потребители живут по разные стороны границы детерминизма. Поведение NPC
 * исполняется внутри `tick()`, где арифметика обязана быть Q16.16 (DET-2), а
 * мозг бота — вне симуляции, на обычных числах (BOT-5, BOT-11), и его решения
 * сравниваются тестами с точностью, недостижимой для Q16.16. Поэтому у каждой
 * операции модели два тела над ОДНИМ набором форм: `…Fixed` — для симуляции,
 * обычное — для потребителя вне её. Общим остаётся то, что нормирует NPC-3:
 * набор форм, состав их параметров и правило композиции; арифметику он не
 * нормирует вовсе.
 *
 * Функции без суффикса `Fixed` внутри тика не вызываются: они считают на
 * плавающей точке, и место им — у потребителя вне симуляции. Запрет этот —
 * норма NPC-3, а не правило этого файла.
 *
 * ## Логистика — таблица, а не libm
 *
 * Трансцендентные функции хост-языка модель не зовёт ни в одном из тел (DET-2,
 * NPC-3), и не только из-за симуляции: libm-экспонента расходится в младшем
 * бите между платформами и языками, а порт ядра на Rust обязан совпадать бит в
 * бит. Поэтому логистическая кривая считается по нормативной таблице узлов —
 * ровно тем же приёмом, что синус (FP-8), — и обе считалки читают ОДНУ таблицу.
 */
import { add, clamp, mul, sub } from '../math/fixed.js';
import { FIXED_ONE, type Fixed } from '../types.js';

/**
 * Формы кривой отклика — ЗАКРЫТЫЙ набор (NPC-3, BOT-9). Порядок нормативен:
 * по нему форма кодируется числом в скомпилированном представлении симуляции.
 */
export const SCORING_CURVES = ['linear', 'quadratic', 'logistic', 'constant'] as const;

export type ScoringCurveType = (typeof SCORING_CURVES)[number];

/** Код формы для скомпилированного представления: индекс в `SCORING_CURVES`. */
export const CURVE_LINEAR = 0;
export const CURVE_QUADRATIC = 1;
export const CURVE_LOGISTIC = 2;
export const CURVE_CONSTANT = 3;

/**
 * Параметр формы: имя поля документа и признак «это доля в [0, 1]».
 *
 * Диапазона здесь нет намеренно: у бота параметры кривой — обычные числа, у
 * NPC — Q16.16 целые полей контента, и один диапазон на двоих был бы неверен
 * ровно для одного из них. Общее — СОСТАВ и ПОРЯДОК полей, и именно он держит
 * обещание «новая форма — одна правка модели»: разборы обоих документов ходят
 * по этой таблице, а не по своему `switch` на имя формы.
 */
export interface ScoringCurveField {
  readonly key: string;
  /** Доля в [0, 1]; иначе — коэффициент формы, диапазон которого шире. */
  readonly unit: boolean;
}

/**
 * Поля каждой формы в порядке разбора. Порядок нормативен вдвойне: он задаёт
 * и очередь находок валидации, и позиционное соответствие полям `a`/`b`/`c`
 * скомпилированной кривой.
 */
export const SCORING_CURVE_FIELDS: Readonly<Record<ScoringCurveType, readonly ScoringCurveField[]>> =
  Object.freeze({
    linear: Object.freeze([
      { key: 'slope', unit: false },
      { key: 'intercept', unit: false },
    ]),
    quadratic: Object.freeze([
      { key: 'slope', unit: false },
      { key: 'intercept', unit: false },
      { key: 'shift', unit: false },
    ]),
    logistic: Object.freeze([
      { key: 'slope', unit: false },
      { key: 'midpoint', unit: false },
    ]),
    constant: Object.freeze([{ key: 'value', unit: true }]),
  });

/**
 * Кривая отклика документа потребителя ВНЕ симуляции: вход в [0, 1] → оценка,
 * которая клампится в [0, 1]. Формул в документе нет и не будет: «вход →
 * кривая → вес» — та граница, за которой начинается генеральный DSL выражений.
 */
export type ScoringCurve =
  /** `slope * x + intercept` — прямая; убывающая задаётся отрицательным наклоном. */
  | { readonly type: 'linear'; readonly slope: number; readonly intercept: number }
  /** `slope * (x - shift)² + intercept` — мягкое начало и резкий конец (или наоборот). */
  | {
      readonly type: 'quadratic';
      readonly slope: number;
      readonly intercept: number;
      readonly shift: number;
    }
  /** `1 / (1 + e^(-slope * (x - midpoint)))` — порог с плавными краями. */
  | { readonly type: 'logistic'; readonly slope: number; readonly midpoint: number }
  /** Постоянная: вход не читается вовсе — «это действие всегда столько стоит». */
  | { readonly type: 'constant'; readonly value: number };

/**
 * Кривая в Q16.16 — форма для симуляции. Параметры плоские и позиционные:
 * `a`/`b`/`c` соответствуют полям формы в порядке `SCORING_CURVE_FIELDS`.
 * Плоские потому, что в горячем цикле кривая лежит в параллельных типизированных
 * массивах, а не объектом на ось (аллокационная дисциплина ядра).
 */
export interface FixedCurve {
  /** Код формы: `CURVE_LINEAR`…`CURVE_CONSTANT`. */
  readonly type: number;
  readonly a: Fixed;
  readonly b: Fixed;
  readonly c: Fixed;
}

// ------------------------------------------------- нормативная таблица логистики

/**
 * Узлов таблицы на единицу аргумента: шаг узла 1/16. В Q16.16 шаг — 4096, то
 * есть сдвиг на 12 бит, поэтому индекс и дробная часть берутся без деления.
 */
const LOGISTIC_SHIFT = 12;
const LOGISTIC_STEP = 1 << LOGISTIC_SHIFT;
const LOGISTIC_NODES_PER_UNIT = FIXED_ONE / LOGISTIC_STEP;
/** Последний узел: за ним логистика отличается от таблицы меньше, чем на её шаг. */
const LOGISTIC_LAST = 128;
const LOGISTIC_SPAN_FIXED = LOGISTIC_LAST * LOGISTIC_STEP;

/**
 * Нормативная таблица логистики на `z ∈ [0, 8]` (129 узлов шагом 1/16):
 * `table[i] = round(65536 / (1 + e^(-i/16)))`. Литерал, а не порождение в
 * рантайме, по той же причине, что таблица синуса (FP-8): libm-экспоненты
 * расходятся в младшем бите между языками и платформами. Каждый узел сверяется
 * с формулой в `test/scoring.test.ts`.
 */
const LOGISTIC_TABLE = new Int32Array([
  32768, 33792, 34813, 35831, 36843, 37847, 38841, 39824,
  40793, 41748, 42687, 43608, 44511, 45393, 46254, 47094,
  47911, 48704, 49474, 50220, 50941, 51638, 52310, 52957,
  53581, 54179, 54754, 55306, 55834, 56339, 56822, 57284,
  57724, 58144, 58544, 58925, 59287, 59632, 59959, 60270,
  60565, 60844, 61109, 61360, 61598, 61823, 62036, 62238,
  62428, 62608, 62778, 62938, 63090, 63233, 63368, 63495,
  63615, 63728, 63835, 63935, 64030, 64119, 64203, 64283,
  64357, 64427, 64494, 64556, 64614, 64669, 64721, 64770,
  64816, 64859, 64900, 64938, 64974, 65008, 65039, 65069,
  65097, 65124, 65149, 65172, 65194, 65215, 65234, 65252,
  65269, 65285, 65300, 65315, 65328, 65341, 65352, 65364,
  65374, 65384, 65393, 65402, 65410, 65417, 65425, 65431,
  65438, 65444, 65449, 65454, 65459, 65464, 65468, 65472,
  65476, 65480, 65483, 65486, 65489, 65492, 65495, 65497,
  65500, 65502, 65504, 65506, 65508, 65509, 65511, 65513,
  65514,
]);

/**
 * Логистика в Q16.16 по нормативной таблице. Симметрия `σ(-z) = 1 - σ(z)`
 * сводит аргумент к магнитуде — ровно как сведение синуса к первой четверти
 * (FP-7); за последним узлом значение фиксируется, там кривая уже плоская.
 */
export function logisticFixed(z: Fixed): Fixed {
  const negative = z < 0;
  const magnitude = negative ? -z : z;
  let value: Fixed;
  if (magnitude >= LOGISTIC_SPAN_FIXED) {
    value = LOGISTIC_TABLE[LOGISTIC_LAST]!;
  } else {
    const index = magnitude >>> LOGISTIC_SHIFT;
    const frac = magnitude & (LOGISTIC_STEP - 1);
    const base = LOGISTIC_TABLE[index]!;
    value = frac === 0 ? base : base + (((LOGISTIC_TABLE[index + 1]! - base) * frac) >> LOGISTIC_SHIFT);
  }
  return negative ? FIXED_ONE - value : value;
}

/** То же по той же таблице, но для потребителя вне симуляции (BOT-5). */
function logistic(z: number): number {
  const negative = z < 0;
  const nodes = (negative ? -z : z) * LOGISTIC_NODES_PER_UNIT;
  let value: number;
  if (nodes >= LOGISTIC_LAST) {
    value = LOGISTIC_TABLE[LOGISTIC_LAST]! / FIXED_ONE;
  } else {
    const index = Math.floor(nodes);
    const base = LOGISTIC_TABLE[index]!;
    value = (base + (LOGISTIC_TABLE[index + 1]! - base) * (nodes - index)) / FIXED_ONE;
  }
  return negative ? 1 - value : value;
}

// --------------------------------------------------- считалка вне симуляции

/**
 * Зажим в [0, 1] — диапазон и оценки оси, и полезности действия (BOT-9).
 * Не-число читается как ноль: у потребителя вне симуляции вход считается на
 * плавающей точке, и `NaN`, просочившийся из вырожденного масштаба, обязан
 * выключить действие, а не отравить сравнение полезностей.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Кривая отклика: значение входа → оценка, зажатая в [0, 1] (BOT-9, NPC-3). */
export function curveValue(curve: ScoringCurve, x: number): number {
  switch (curve.type) {
    case 'linear':
      return clamp01(curve.slope * x + curve.intercept);
    case 'quadratic': {
      const shifted = x - curve.shift;
      return clamp01(curve.slope * shifted * shifted + curve.intercept);
    }
    case 'logistic':
      return clamp01(logistic(curve.slope * (x - curve.midpoint)));
    case 'constant':
      return clamp01(curve.value);
  }
}

/** Оценка оси: кривая от входа, взвешенная документом; лежит в [0, 1] (BOT-9). */
export function considerationScore(curve: ScoringCurve, weight: number, input: number): number {
  return curveValue(curve, input) * weight;
}

// ------------------------------------------------------ считалка симуляции

/** Зажим в [0, 1] для Q16.16 — тот же диапазон, что у считалки вне симуляции. */
export function clamp01Fixed(value: Fixed): Fixed {
  return clamp(value, 0, FIXED_ONE);
}

/** Кривая отклика в Q16.16 (NPC-3): вход и параметры — доли и коэффициенты Q16.16. */
export function curveValueFixed(curve: FixedCurve, x: Fixed): Fixed {
  switch (curve.type) {
    case CURVE_QUADRATIC: {
      const shifted = sub(x, curve.c);
      return clamp01Fixed(add(mul(curve.a, mul(shifted, shifted)), curve.b));
    }
    case CURVE_LOGISTIC:
      return clamp01Fixed(logisticFixed(mul(curve.a, sub(x, curve.b))));
    case CURVE_CONSTANT:
      return clamp01Fixed(curve.a);
    default:
      // `linear` и всякий не-код формы: разбор документа кода мимо словаря не
      // пропускает (NPC-2), и ветка остаётся прямой — как у разбора кривой бота.
      return clamp01Fixed(add(mul(curve.a, x), curve.b));
  }
}

/** Оценка оси в Q16.16 (NPC-3): кривая от входа, взвешенная документом. */
export function considerationScoreFixed(curve: FixedCurve, weight: Fixed, input: Fixed): Fixed {
  return mul(curveValueFixed(curve, input), weight);
}

// -------------------------------------------------------------- композиция
//
// Полезность действия — ПРОИЗВЕДЕНИЕ оценок его осей (BOT-9, NPC-3).
// Произведение, а не сумма: ось с нулём выключает действие целиком («врага не
// видно — давить не на кого»). Диапазон сохраняется по построению: каждый
// сомножитель лежит в [0, 1] (вес там же), поэтому и произведение там же;
// финальный зажим держит границу от накопленной погрешности.
//
// Три примитива, а не готовый цикл: у потребителей разная арифметика И разная
// раскладка осей (объекты документа у бота, параллельные массивы у NPC), а
// цикл с колбэком стоил бы замыкания на каждое действие каждого агента —
// аллокации, пропорциональной числу сущностей.

/** Нейтральный элемент композиции — полезность действия без единой оси. */
export const UTILITY_IDENTITY = 1;

export function combineUtility(accumulated: number, score: number): number {
  return accumulated * score;
}

export function finishUtility(accumulated: number): number {
  return clamp01(accumulated);
}

export const UTILITY_IDENTITY_FIXED: Fixed = FIXED_ONE;

export function combineUtilityFixed(accumulated: Fixed, score: Fixed): Fixed {
  return mul(accumulated, score);
}

export function finishUtilityFixed(accumulated: Fixed): Fixed {
  return clamp01Fixed(accumulated);
}
