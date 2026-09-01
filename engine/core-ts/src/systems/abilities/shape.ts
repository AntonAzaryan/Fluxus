/**
 * Фигура шага прицеливания в терминах СИМУЛЯЦИИ (ABIL-5): её заякоренная форма
 * и предикат принадлежности точки. Отдельным модулем — по образцу
 * `abilityPreviewShape.ts` рендера: всё, что платформа знает о самой фигуре,
 * живёт здесь, а `runtime.ts` остаётся про общий слой систем.
 *
 * Второго словаря фигур при этом не появляется (PHYS-2): формы читаются кодами
 * коллайдера, а размеры — выражениями определения, скомпилированными каталогом.
 */
import { distSqLe } from '../../math/fixed.js';
import { lengthOf } from '../../math/vector.js';
import { evaluate } from '../../dsl/expr.js';
import { SHAPE_CIRCLE } from '../physics.js';
import { fixedOf, type ExprVarsRecord } from './runtime.js';
import type { CompiledAbility, CompiledStep } from './model.js';
import type { Fixed, SystemContext } from '../../types.js';

/**
 * Фигура шага как ГЕЙТ выбора (ABIL-5): «фигура — источник правды и для отбора
 * шагом, и для превью в рендере» (REND-28), поэтому конус захвата живёт в
 * определении один раз, а не вторым экземпляром в предикате `filter`.
 *
 * Проверяемой из словаря фигур (PHYS-2) оказывается ровно направленная: круг с
 * объявленным полууглом — конус, заякоренный вершиной в НАЧАЛЕ шага и
 * развёрнутый на точку прицела тика. Ненаправленные фигуры — круг без полуугла
 * и прямоугольник — превью центрирует НА точке шага, то есть на самой выбранной
 * сущности, и проверка «сущность внутри фигуры вокруг себя» истинна тождественно:
 * такие фигуры описывают область, которую накроют эффекты, и сужать выбор им
 * нечем.
 *
 * Объект долгоживущий, один на систему: выражения фигуры вычисляются один раз на
 * накопление шага, а не на кандидата, и связывание перезаписывает поля на месте
 * (ABIL-10).
 */
export class StepShapeGate {
  /** Фигура направленная и заякорена: гейт работает. */
  private directed = false;
  /** Радиус конуса объявлен: круг без радиуса расстояния не ограничивает. */
  private bounded = false;
  /** Радиус конуса от начала шага; предел расстояния фигуры. */
  private radius: Fixed = 0;
  /** Косинус полуугла: сравнение идёт с ним, а не с самим углом. */
  private cosHalfAngle: Fixed = 0;
  private originX: Fixed = 0;
  private originY: Fixed = 0;
  /** Единичная ось конуса; нулевая — прицел совпал с началом шага. */
  private axisX: Fixed = 0;
  private axisY: Fixed = 0;

  /**
   * Связывание фигуры с тиком накопления: вычисляет размеры выражениями
   * определения и строит ось от начала шага к точке прицела.
   *
   * Прицел, совпавший с началом шага, оси не даёт: направления «сюда же» не
   * существует, и угловое сужение в этом случае не выполняется вовсе — предел
   * расстояния при этом остаётся. Выбор направления умолчания намеренный:
   * отвергнуть всех кандидатов означало бы, что каст срывается от того, что
   * игрок навёл курсор себе под ноги, — исход, о котором определение не
   * высказывалось.
   */
  bind(
    ctx: SystemContext,
    ability: CompiledAbility,
    step: CompiledStep,
    originX: Fixed,
    originY: Fixed,
    aimPointX: Fixed,
    aimPointY: Fixed,
    vars: ExprVarsRecord,
  ): void {
    this.directed = false;
    if (step.shapeKind !== SHAPE_CIRCLE || step.halfAngle === undefined) return;
    const where = `способность "${ability.id}": фигура шага`;
    // Круг без радиуса пределом расстояния не является — им остаётся `range`.
    const radius = step.shapeA;
    this.bounded = radius !== undefined;
    this.radius = radius === undefined ? 0 : fixedOf(evaluate(radius, ctx, vars), where);
    this.cosHalfAngle = ctx.math.cos(fixedOf(evaluate(step.halfAngle, ctx, vars), where));
    this.originX = originX;
    this.originY = originY;
    const dx = ctx.math.sub(aimPointX, originX);
    const dy = ctx.math.sub(aimPointY, originY);
    const length = lengthOf(dx, dy);
    this.axisX = length === 0 ? 0 : ctx.math.div(dx, length);
    this.axisY = length === 0 ? 0 : ctx.math.div(dy, length);
    this.directed = true;
  }

  /**
   * Лежит ли точка в фигуре. Ненаправленная фигура и фигура без размеров не
   * сужают ничего (см. шапку класса); у конуса проверяются оба предела —
   * расстояние от начала шага и отклонение от оси.
   *
   * Точка, совпавшая с началом шага, лежит в конусе: расстояние нулевое, а
   * направления у неё нет. Сравнение косинусов — по нормированному вектору,
   * теми же операциями Q16.16, которыми тот же конус писал бы предикат
   * контента; аллокаций тут нет (ABIL-10).
   */
  contains(ctx: SystemContext, x: Fixed, y: Fixed): boolean {
    if (!this.directed) return true;
    const dx = ctx.math.sub(x, this.originX);
    const dy = ctx.math.sub(y, this.originY);
    if (this.bounded && !distSqLe(dx, dy, this.radius)) return false;
    const length = lengthOf(dx, dy);
    if (length === 0 || (this.axisX === 0 && this.axisY === 0)) return true;
    const along = ctx.math.add(ctx.math.mul(dx, this.axisX), ctx.math.mul(dy, this.axisY));
    return ctx.math.div(along, length) >= this.cosHalfAngle;
  }
}
