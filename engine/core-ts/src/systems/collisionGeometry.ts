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
import { FIXED_ONE } from '../types.js';
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

/** Буфер коллайдера: заполняется на месте при обходе кандидатов (`colliderInto`). */
export interface MutableCollider {
  halfX: Fixed;
  halfY: Fixed;
  shape: number;
  radius: Fixed;
}

export type Collider = Readonly<MutableCollider>;

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
  /** Собственная огибающая препятствия: копия, а не ссылка на чужой буфер. */
  readonly bounds: Bounds;
}

export function boundsAt(x: Fixed, y: Fixed, collider: Collider): Bounds {
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  boundsInto(bounds, x, y, collider);
  return bounds;
}

/** Огибающая в готовый буфер: обход кандидатов не аллоцирует по одной на каждого. */
export function boundsInto(target: Bounds, x: Fixed, y: Fixed, collider: Collider): void {
  target.minX = fixed.sub(x, collider.halfX);
  target.minY = fixed.sub(y, collider.halfY);
  target.maxX = fixed.add(x, collider.halfX);
  target.maxY = fixed.add(y, collider.halfY);
}

export function copyBounds(target: Bounds, source: Readonly<Bounds>): void {
  target.minX = source.minX;
  target.minY = source.minY;
  target.maxX = source.maxX;
  target.maxY = source.maxY;
}

/** Касание не считается пересечением: сущность, вставшая вплотную к стене, не заблокирована. */
export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Объединение в готовый буфер — по той же причине, что `boundsInto`: шаг оси
 * зовёт его на каждого движущегося, и объект на вызов был бы аллокацией,
 * пропорциональной числу движущихся за тик. */
export function unionInto(target: Bounds, a: Readonly<Bounds>, b: Readonly<Bounds>): void {
  target.minX = Math.min(a.minX, b.minX);
  target.minY = Math.min(a.minY, b.minY);
  target.maxX = Math.max(a.maxX, b.maxX);
  target.maxY = Math.max(a.maxY, b.maxY);
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
 * в обе стороны — поведение без гейта. Гейт выключает РОВНО ноль, а не всё
 * неположительное: отрицательный `cliffRise` — это допуск подъёма меньше
 * единицы, то есть активный гейт с нулевым допуском (любой подъём блокирован
 * формулой ниже, любой спуск свободен). Значения меньше `−1` приводятся к `−1`
 * ЯВНО, отдельным шагом: голая формула `rise <= cliffRise` при `cliffRise = −4`
 * заблокировала бы и спуск на единицу (`−1 > −4`), а PHYS-11 требует свободного
 * спуска с ЛЮБОЙ высоты при активном допуске.
 *
 * Нормировка делает ровно это и ничего сверх: любой отрицательный допуск
 * означает «только вниз», а не свой класс величины. Ребро с НУЛЕВЫМ подъёмом
 * (`levelNeg == levelPos`) она проходимым не делает — при любом отрицательном
 * допуске такое ребро блокирует в ОБЕ стороны (`0 <= −1` ложно, как и
 * `0 <= −4`), и это прямое следствие общего правила гейта из PHYS-11, а не
 * побочный эффект нормировки: спуска здесь нет, значит и права пройти нет.
 * Наблюдать этот случай негде — террейн таких рёбер не порождает вовсе
 * (перепад нуля `passable`, коллайдера обрыва там не возникает, `terrain.ts`),
 * — но у другого источника статики поведение именно такое.
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
  if (cliffRise === 0) return false;
  // Ход нулевой длины ребра не пересекает, поэтому стороны захода у него нет:
  // её задаёт ЗНАК шага, а у нуля знака нет, и голая формула ниже молча взяла
  // бы ветку `levelNeg`, сделав `edge(0, 5)` проходимым, а зеркальное
  // `edge(5, 0)` — блокирующим. Гейт открыт по той же причине, что и на ходе
  // вдоль ребра: пересечения нет — блокировать нечего. `PhysicsSystem` такой
  // шаг сюда не доводит (нулевая ось пропускается до narrow-phase), защита
  // нужна функции как экспортированной.
  if (move.step === 0) return true;
  const normalAxis = s.minX === s.maxX ? 'x' : 'y';
  if (move.axis !== normalAxis) return true;
  const rise = move.step > 0 ? s.levelPos - s.levelNeg : s.levelNeg - s.levelPos;
  // Всё, что ниже −1, — тот же нулевой допуск: сама формула этого не даёт
  // (при `cliffRise = −4` спуск на единицу был бы блокирован), а PHYS-11
  // требует свободного спуска с ЛЮБОЙ высоты при активном допуске.
  const tolerance = cliffRise < -1 ? -1 : cliffRise;
  return rise <= tolerance;
}

/**
 * Ближайшая к точке точка прямоугольника — контакт круга с прямоугольной
 * поверхностью: на грани это проекция по нормали, за краем — угол.
 */
function closestPointOn(bounds: Readonly<Bounds>, x: Fixed, y: Fixed): Vec2 {
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
 * Единичность — с точностью Q16.16, а не точная: `fixed.sqrt` округляет вниз,
 * поэтому длина бывает и чуть больше единицы (наблюдалось `-65538` при
 * `FIXED_ONE = 65536`), а на разносе центров в сотые доли юнита ошибка
 * доходит до процента. Величина детерминирована (одни и те же входы дают тот
 * же результат во всех реализациях), но потребителю нормаль нужна
 * НАПРАВЛЕННО: отражение через скалярное произведение, сравнение знаков.
 * Сравнивать нормаль на точное равенство с ±1 или с другой нормалью —
 * ошибка потребителя.
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

/**
 * Луч против прямоугольника — метод слэбов в расстояниях вдоль луча, а не в
 * параметре `t`: параметр потребовал бы деления на длину и второго диапазона.
 */
export function rayVsBox(from: Vec2, dir: Vec2, rayLength: Fixed, box: Bounds): number | undefined {
  let near = 0;
  let far = rayLength;

  for (const axis of ['x', 'y'] as const) {
    const origin = from[axis];
    const direction = dir[axis];
    const lo = axis === 'x' ? box.minX : box.minY;
    const hi = axis === 'x' ? box.maxX : box.maxY;
    if (direction === 0) {
      if (origin <= lo || origin >= hi) return undefined;
      continue;
    }
    const t0 = ratio(fixed.sub(lo, origin), direction, rayLength);
    const t1 = ratio(fixed.sub(hi, origin), direction, rayLength);
    // Знак направления решает, какая из границ слэба ближняя: отрезок луча
    // клипуется пересечением с полосой. `Math.min`/`Math.max` на целых Q16.16
    // точны и порядок не меняют — округления здесь не возникает (DET-2).
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    if (near > far) return undefined;
  }
  return near;
}

/**
 * Деление с насыщением: частное вне отрезка луча нас не интересует, а
 * `fixed.div` на почти нулевом знаменателе вылетело бы за i32. Промежуточное
 * произведение не превышает 2^47 и в double точно, как и в i64 у Rust-порта.
 *
 * DET-2, условия 3 и 5: делимое `numerator · 2^16` по модулю не больше 2^47 —
 * строго меньше 2^53, поэтому приведённое частное совпадает с точным целым.
 *
 * Условие 4: **`floor` здесь — норма площадки, а не деталь реализации.** Это
 * единственное деление ядра, где конвенция округления наблюдаема в геймплее:
 * делимое и делитель бывают отрицательными по отдельности, и частное в
 * интервале `(-1, 0)` сырых единиц Q16.16 даёт `-1` при округлении к минус
 * бесконечности и `0` при усечении к нулю. Такое частное попадает в дальнюю
 * границу слэба, а сравнение `near > far` превращает `0 > -1` в промах и
 * `0 > 0` — в попадание: порт, выбравший усечение, отдал бы другой набор
 * попаданий (PHYS-7). Вторая реализация ядра ОБЯЗАНА округлять к минус
 * бесконечности (в Rust — `div_euclid` либо `(a / b).floor()`, но не `a / b`
 * целочисленным). Различающий тест — в `physics.test.ts`.
 */
function ratio(numerator: Fixed, denominator: Fixed, limit: Fixed): number {
  const quotient = Math.floor((numerator * FIXED_ONE) / denominator);
  const bound = limit + FIXED_ONE;
  return quotient < -bound ? -bound : quotient > bound ? bound : quotient;
}

/**
 * Луч против круга — через проекцию на нормированное направление, без
 * дискриминанта: у квадратичной формы промежуточные произведения выходят за
 * Q16.16 уже на десятке единиц, здесь же все множители порядка расстояния.
 */
export function rayVsCircle(
  from: Vec2,
  dir: Vec2,
  rayLength: Fixed,
  center: Vec2,
  radius: Fixed,
): number | undefined {
  const toCenter = vec.sub(center, from);
  const projection = vec.dot(toCenter, dir);
  const perpendicularSq = fixed.sub(vec.lengthSq(toCenter), fixed.mul(projection, projection));
  const radiusSq = fixed.mul(radius, radius);
  if (perpendicularSq > radiusSq) return undefined;

  const halfChord = fixed.sqrt(fixed.sub(radiusSq, perpendicularSq));
  const entry = fixed.sub(projection, halfChord);
  // Источник внутри круга: попадание в нулевой дистанции — дефект вызова
  // (PHYS-6 требует исключать источник), а не хит.
  if (entry < 0) return undefined;
  return entry > rayLength ? undefined : entry;
}
