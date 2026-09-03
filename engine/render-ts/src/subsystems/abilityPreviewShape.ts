/**
 * Фигура шага прицеливания в терминах кадра (REND-28): её РАЗБОР из определения
 * и её ГЕОМЕТРИЯ. Всё, что подсистема превью знает о самой фигуре, живёт здесь,
 * а сама подсистема остаётся про кадр — два своих входа, цепочку шагов и пулы.
 *
 * Разбор делается один раз, в точке приёма каталога (REND-1): литеральное число
 * определения превращается во float здесь, вычисляемое остаётся невычисленным,
 * и такая фигура не рисуется вовсе — превью, показавшее выдуманный радиус,
 * врало бы игроку. Второго описания способности при этом не появляется
 * (`ability-system` ABIL-5): фигуры принадлежат определению, и читается ЕГО
 * словарь.
 *
 * Геометрия у каждой фигуры двойная: полупрозрачная заливка и контур поверх
 * неё. Заливка отвечает на вопрос «что накроет», контур — на «где ровно
 * граница», и строятся обе по одним и тем же точкам: разойдись они, граница
 * фигуры двоилась бы.
 */
import {
  FIXED_ONE,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  STEP_VECTOR,
  type AbilityCatalog,
  type Expression,
} from '@fluxus/core';
import * as THREE from 'three';
import { own } from '../footprint.js';

/** Разбиение единичной окружности: круглая на глаз и дешёвая — фигур в кадре единицы. */
const CIRCLE_SEGMENTS = 64;
/**
 * Шаг дуги сектора, радианы. Дуга — вписанная ломаная, то есть НЕМНОГО у́же
 * настоящего круга; знак ошибки выбран «внутрь»: превью, обещающее меньше
 * настоящей зоны, игроку не врёт. Заливка сшивается по тем же точкам и ту же
 * ошибку наследует — второй фигуры под контуром не появляется.
 */
const SECTOR_ARC_STEP = Math.PI / 90;
/** Фигуры у шага нет — рисовать нечем (`CompiledStep.shapeKind`). */
const NO_SHAPE = -1;

/**
 * Фигура шага во float — разобранная ОДИН раз, в точке приёма каталога
 * (REND-1). `NaN` в размере означает «вычислить нечем»: выражение определения
 * не литерал, а мира у рендера нет.
 */
export interface PreviewShape {
  /** Код формы из словаря коллайдеров (PHYS-2) либо `NO_SHAPE`. */
  readonly kind: number;
  /**
   * Радиус круга либо полуось X прямоугольника, мировые единицы. У круга это
   * уже УЧТЁННЫЙ предел расстояния шага (`CompiledStep.range`), см.
   * `circleRadius`: превью не вправе обещать больше, чем возьмёт симуляция.
   */
  readonly a: number;
  /** Полуось Y прямоугольника. */
  readonly b: number;
  /** Полуугол сектора в радианах; `NaN` — не литерал. */
  readonly halfAngle: number;
  /** Полуугол объявлен: круг с ним — это конус (design Decision 10). */
  readonly sector: boolean;
  /** У фигуры есть направление: сектор либо прямоугольник шага-вектора. */
  readonly directed: boolean;
}

/**
 * Две половины одной фигуры: заливка и контур. Пара, а не два независимых поля,
 * именно потому, что расходиться им нечем — обе строятся по одним точкам и
 * ставятся в одну позу.
 */
export interface ShapeGeometry {
  readonly fill: THREE.BufferGeometry;
  readonly outline: THREE.BufferGeometry;
}

/** Литерал длины определения (Q16.16) во float; не литерал — `NaN`. */
function literalWorld(expr: Expression | undefined): number {
  return typeof expr === 'number' ? expr / FIXED_ONE : Number.NaN;
}

/**
 * Литерал угла определения во float-радианы. Угол ядра — доля оборота в Q16.16
 * (FP-7), поэтому оборот здесь один и тот же множитель, а не второе соглашение.
 */
function literalRadians(expr: Expression | undefined): number {
  return typeof expr === 'number' ? (expr / FIXED_ONE) * Math.PI * 2 : Number.NaN;
}

/**
 * Радиус круга шага с учётом ПРЕДЕЛА РАССТОЯНИЯ (REND-28, `ability-system`
 * ABIL-5).
 *
 * Ядро ограничивает кандидатов шага радиусом `range` от начала шага, а конус
 * без собственного радиуса считает неограниченным — `range` остаётся его
 * единственным пределом (`abilities/shape.ts`, `abilities/runtime.ts`).
 * Превью, читающее одну лишь фигуру, при `range < radius` обещало бы игроку
 * лишнее, а конус без радиуса не рисовало бы вовсе.
 *
 * Для конуса пересечение «сектор радиуса `a`» с «круг радиуса `range` вокруг
 * той же точки» — ровно сектор радиуса `min(a, range)`; для круга, центрованного
 * НА точке шага, `min` — приближение (настоящее пересечение — линза), и знак
 * ошибки выбран «внутрь»: превью обещает меньше настоящей зоны, а не больше, —
 * то же правило, по которому дуга сектора рисуется вписанной ломаной.
 *
 * Круг БЕЗ радиуса пределом не становится: `range` считается от начала шага, а
 * круг центрован на точке, и рисовать его радиусом предела значило бы выдумать
 * фигуру, которой определение не объявляло.
 */
function circleRadius(a: number, range: number, sector: boolean): number {
  if (!Number.isFinite(a)) return sector ? range : Number.NaN;
  return Number.isFinite(range) && range < a ? range : a;
}

/**
 * Фигуры шагов каталога во float, индекс в индекс с `catalog.steps`. Это и есть
 * точка приёма (REND-1): глубже неё fixed-point значений у превью нет.
 *
 * Полуось прямоугольника шага-вектора пределом расстояния НЕ режется: этой
 * фигуры ядро не читает вовсе (ни `shape.ts`, ни `runtime.ts`), и резать здесь
 * было бы нечего — вопрос открыт и решается правилом валидации редактора, а не
 * догадкой кадра.
 */
export function previewShapes(catalog: AbilityCatalog): readonly PreviewShape[] {
  return catalog.steps.map((step) => {
    const sector = step.halfAngle !== undefined;
    const a = literalWorld(step.shapeA);
    return {
      kind: step.shapeKind,
      a: step.shapeKind === SHAPE_CIRCLE ? circleRadius(a, literalWorld(step.range), sector) : a,
      b: literalWorld(step.shapeB),
      halfAngle: literalRadians(step.halfAngle),
      sector,
      directed: sector || step.kind === STEP_VECTOR,
    };
  });
}

/**
 * Фигура шага рисуема: форма из словаря объявлена, а её размеры — литералы
 * определения (REND-28). Предикат ОДИН на кадр и на пробу отладки: разойдись
 * они, дамп отвечал бы «рисуется» о том, чего в кадре нет (RDBG-2). Заливка
 * подчиняется ему наравне с контуром: нет фигуры — нет ни одной её половины.
 */
export function drawableShape(shape: PreviewShape | undefined): shape is PreviewShape {
  if (shape === undefined || shape.kind === NO_SHAPE) return false;
  if (shape.kind === SHAPE_CIRCLE) {
    return Number.isFinite(shape.a) && (!shape.sector || Number.isFinite(shape.halfAngle));
  }
  if (shape.kind !== SHAPE_AABB) return false;
  return Number.isFinite(shape.a) && Number.isFinite(shape.b);
}

/** Геометрия из плоских позиций; индекс задан — это треугольники заливки. */
function geometryOf(positions: readonly number[], index?: readonly number[]): THREE.BufferGeometry {
  const geometry = own('geometry', 'abilityPreview', new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (index !== undefined) geometry.setIndex([...index]);
  return geometry;
}

/**
 * Единичный круг: замкнутый контур радиуса 1 в плоскости XY и заливка веером
 * треугольников от центра к тем же точкам контура.
 */
export function circleGeometry(): ShapeGeometry {
  const ring: number[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    ring.push(Math.cos(angle), Math.sin(angle), 0);
  }
  const index: number[] = [];
  // Последний треугольник замыкается на первую точку кольца — как и контур.
  for (let i = 1; i <= CIRCLE_SEGMENTS; i++) index.push(0, i, i === CIRCLE_SEGMENTS ? 1 : i + 1);
  return { outline: geometryOf(ring), fill: geometryOf([0, 0, 0, ...ring], index) };
}

/** Единичный прямоугольник: контур с полуосями 1 и заливка двумя треугольниками. */
export function squareGeometry(): ShapeGeometry {
  const corners = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  return { outline: geometryOf(corners), fill: geometryOf(corners, [0, 1, 2, 0, 2, 3]) };
}

/**
 * Сектор единичного радиуса: вершина в начале координат, раствор `2 · halfAngle`
 * вокруг оси +X. Это и есть «круг с полууглом» словаря определения — конус
 * (ABIL-5, design Decision 10), а не отдельная форма коллайдера. Заливка —
 * веер треугольников от вершины: клин даёт две прямые кромки, дуга — границу
 * между ними, и это ровно то пересечение, которое проверит симуляция.
 */
export function sectorGeometry(halfAngle: number): ShapeGeometry {
  const segments = Math.max(4, Math.ceil((2 * halfAngle) / SECTOR_ARC_STEP));
  const positions: number[] = [0, 0, 0];
  for (let i = 0; i <= segments; i++) {
    const angle = -halfAngle + (2 * halfAngle * i) / segments;
    positions.push(Math.cos(angle), Math.sin(angle), 0);
  }
  const index: number[] = [];
  for (let i = 1; i <= segments; i++) index.push(0, i, i + 1);
  return { outline: geometryOf(positions), fill: geometryOf(positions, index) };
}
