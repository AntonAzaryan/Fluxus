/**
 * Геометрия разрешения движения (PHYS-1, PHYS-8, PHYS-9): огибающие AABB,
 * тесты пересечения, предикат блокировки, направленный гейт обрыва и нормаль
 * поверхности в событии столкновения. Всё чистые функции над Q16.16 — мира,
 * компонентов и Command Buffer этот слой не знает, поэтому `physics.ts`
 * остаётся системой, а не сборником формул.
 *
 * Диапазон тот же, что у остальной физики: расстояния, участвующие в
 * квадратичных тестах, не выходят за ~181 единицу (PHYS-6).
 */
import * as fixed from '../math/fixed.js';
import * as vec from '../math/vector.js';
import type { Fixed, Vec2 } from '../types.js';

/** Значения поля `shape` компонента коллайдера. */
export const SHAPE_CIRCLE = 0;
export const SHAPE_AABB = 1;

/**
 * Статический коллайдер: прямоугольник в мировых координатах. Обрыв —
 * вырожденный прямоугольник нулевой толщины: отрезок и прямоугольник тогда
 * проходят один narrow-phase, а не два.
 */
export interface StaticCollider {
  readonly minX: Fixed;
  readonly minY: Fixed;
  readonly maxX: Fixed;
  readonly maxY: Fixed;
  readonly tags: readonly string[];
  /** Слой «кто я» (PHYS-2): блокирует движущегося, чей `blockMask` его накрывает. */
  readonly layer: number;
  /**
   * Уровни сторон ребра обрыва (TERR-5) — только у статики, выведенной из
   * cliff-геометрии: по ним направленный гейт (PHYS-11) считает подъём.
   */
  readonly levelNeg?: number;
  readonly levelPos?: number;
}

export interface Bounds {
  minX: Fixed;
  minY: Fixed;
  maxX: Fixed;
  maxY: Fixed;
}

export interface Collider {
  readonly halfX: Fixed;
  readonly halfY: Fixed;
  readonly shape: number;
  readonly radius: Fixed;
}

/** Шаг одной оси: исходные данные и предиката блокировки, и нормали события. */
export interface Move {
  readonly current: Bounds;
  readonly next: Bounds;
  readonly swept: Bounds;
  readonly axis: 'x' | 'y';
  /** Шаг оси после TimeScale: гейту обрыва (PHYS-11) нужен знак — сторона захода. */
  readonly step: Fixed;
  /**
   * Центр движущегося на момент шага (позиция блокировки). От него считаются и
   * выбор ближайшего препятствия, и нормаль поверхности (PHYS-9).
   */
  readonly centerX: Fixed;
  readonly centerY: Fixed;
}

/** Препятствие, заблокировавшее шаг оси: исходные данные нормали (PHYS-9). */
export interface Blocker {
  /** `EntityId` либо `STATIC_COLLIDER`. */
  other: number;
  shape: number;
  /** Центр круглого препятствия; у прямоугольного не используется. */
  centerX: Fixed;
  centerY: Fixed;
  /** Ссылка на огибающую препятствия — читается, но не мутируется. */
  bounds: Readonly<Bounds>;
}

export function boundsAt(x: Fixed, y: Fixed, collider: Collider): Bounds {
  return {
    minX: fixed.sub(x, collider.halfX),
    minY: fixed.sub(y, collider.halfY),
    maxX: fixed.add(x, collider.halfX),
    maxY: fixed.add(y, collider.halfY),
  };
}

/** Касание не считается пересечением: сущность, вставшая вплотную к стене, не заблокирована. */
export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

export function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Блокирует ли препятствие этот ход по оси.
 *
 * Пока сущность снаружи — блокирует всё, что задевает заметаемый объём. Если
 * она уже внутри препятствия (заспавнили внахлёст, геймплейная система
 * записала `Position` в стену), блокируется только ход, который не уводит её
 * наружу: иначе любое движение считалось бы столкновением, и сущность
 * залипала бы навсегда.
 */
export function blocks(move: Move, obstacle: Bounds): boolean {
  if (!overlaps(move.current, obstacle)) return overlaps(move.swept, obstacle);
  return separation(move.next, obstacle, move.axis) <= separation(move.current, obstacle, move.axis);
}

/**
 * Удвоенное расстояние между центрами по оси. Удвоенное — чтобы не делить:
 * сравниваются только два таких значения между собой. Сумма границ выходит за
 * i32, поэтому складывается обычной арифметикой (в Rust-порте — i64), а не
 * через `fixed.add` с его проверкой диапазона.
 */
function separation(box: Bounds, obstacle: Bounds, axis: 'x' | 'y'): number {
  const a = axis === 'x' ? box.minX + box.maxX : box.minY + box.maxY;
  const b = axis === 'x' ? obstacle.minX + obstacle.maxX : obstacle.minY + obstacle.maxY;
  return Math.abs(a - b);
}

/**
 * Направленный гейт обрыва (PHYS-11): пропускает ли ребро этот ход. Применим
 * только к статике с уровнями сторон; при нулевом `cliffRise` обрыв блокирует
 * в обе стороны — поведение без гейта.
 *
 * Ось нормали ребра — вырожденная ось его нулевой толщины. Ход по другой оси
 * при активном допуске не блокируется вовсе: сущность в воздухе, скользящая
 * вдоль ребра, не должна за него цепляться. По оси нормали сторона захода
 * определяется знаком шага: шаг больше нуля пересекает ребро со стороны
 * меньшей координаты (`levelNeg`) к большей (`levelPos`), меньше нуля —
 * наоборот. Блокируется только подъём выше допуска; спуск свободен с любой
 * высоты.
 */
export function cliffGateOpen(move: Move, s: StaticCollider, cliffRise: number): boolean {
  if (s.levelNeg === undefined || s.levelPos === undefined) return false;
  if (cliffRise <= 0) return false;
  const normalAxis = s.minX === s.maxX ? 'x' : 'y';
  if (move.axis !== normalAxis) return true;
  const rise = move.step > 0 ? s.levelPos - s.levelNeg : s.levelNeg - s.levelPos;
  return rise <= cliffRise;
}

/**
 * Ближайшая к точке точка прямоугольника — контакт круга с прямоугольной
 * поверхностью: на грани это проекция по нормали, за краем — угол.
 */
export function closestPointOn(bounds: Readonly<Bounds>, x: Fixed, y: Fixed): Vec2 {
  return {
    x: fixed.clamp(x, bounds.minX, bounds.maxX),
    y: fixed.clamp(y, bounds.minY, bounds.maxY),
  };
}

/**
 * Квадрат расстояния от точки до огибающей препятствия — мера «ближе» при
 * выборе препятствия, чья поверхность и дала контакт (PHYS-9). Сравниваются
 * только такие величины между собой, поэтому считается в СЫРЫХ единицах
 * Q16.16 без обратного сдвига: `fixed.mul` на долях единицы округлял бы малые
 * расстояния в ноль и ломал бы сравнение.
 *
 * DET-2, условие 3: препятствие пересекает заметаемый объём, поэтому каждая
 * разность по модулю не больше суммы полуразмера и шага — предел PHYS-6 (~181
 * единица) даёт квадрат порядка 2^47, и сумма двух точна в double (в
 * Rust-порте — i64).
 */
export function closestDistanceSq(bounds: Readonly<Bounds>, x: Fixed, y: Fixed): number {
  const dx = x - fixed.clamp(x, bounds.minX, bounds.maxX);
  const dy = y - fixed.clamp(y, bounds.minY, bounds.maxY);
  return dx * dx + dy * dy;
}

/**
 * Осевая нормаль против движения: сторона удара по заблокированной оси. Для
 * пары прямоугольников она и есть нормаль поверхности (PHYS-9).
 */
function axisNormalOf(move: Move): Vec2 {
  const sign = move.step > 0 ? -1 : 1;
  return {
    x: move.axis === 'x' ? fixed.fromInt(sign) : 0,
    y: move.axis === 'y' ? fixed.fromInt(sign) : 0,
  };
}

/**
 * Нормаль поверхности препятствия в точке контакта, единичная в Q16.16
 * (PHYS-9). Круглое ПРЕПЯТСТВИЕ — по линии центров от него к движущемуся;
 * круглый ДВИЖУЩИЙСЯ о прямоугольник — от ближайшей к его центру точки
 * прямоугольника к центру (на грани это ровно осевая нормаль, на углу —
 * диагональная); пара прямоугольников — осевая.
 *
 * Препятствие сюда приходит ближайшее (`nearestBlocker`), а не первое по
 * порядку обхода: прямая стена в мире — цепочка соседних односкелеточных
 * отрезков статики (TERR-5), и у дальнего звена цепочки ближайшая точка
 * оказалась бы его внутренним стыком, дав ложную диагональ вместо нормали
 * грани.
 *
 * Вырождение (совпавшие центры, центр круга внутри прямоугольника) — фолбэк на
 * осевую: единичный вектор из нулевого не восстановить, а событие обязано
 * нести детерминированную нормаль.
 *
 * Момент контакта — позиция блокировки, а не точное касание: разрешение
 * движения работает по огибающим AABB (`ponytail` в `physics.ts`), и нормаль
 * наследует ту же аппроксимацию — направленно верную и достаточную для
 * рикошета.
 */
export function surfaceNormal(move: Move, moverShape: number, blocker: Blocker): Vec2 {
  const axisNormal = axisNormalOf(move);
  const center: Vec2 = { x: move.centerX, y: move.centerY };
  if (blocker.shape === SHAPE_CIRCLE) {
    const fromObstacle = vec.sub(center, { x: blocker.centerX, y: blocker.centerY });
    return orAxis(vec.normalize(fromObstacle), axisNormal);
  }
  if (moverShape === SHAPE_CIRCLE) {
    const closest = closestPointOn(blocker.bounds, center.x, center.y);
    return orAxis(vec.normalize(vec.sub(center, closest)), axisNormal);
  }
  return axisNormal;
}

function orAxis(normal: Vec2, axisNormal: Vec2): Vec2 {
  return normal.x === 0 && normal.y === 0 ? axisNormal : normal;
}
