/**
 * Narrow-Phase коллизии
 * 
 * - circle-circle
 * - circle-AABB
 * - AABB-AABB
 * - interval_overlap для Z
 */

import { Fixed, add, sub, mul, div, abs, min, max, ZERO, ONE, HALF } from '../fixed/fixed';
import { Vec3, vec_sub as vecSub, vec_length_xy, vec_normalize_xy, interval_overlap } from '../fixed/vector';

/**
 * Проверка пересечения двух кругов
 * @returns { collision: boolean, penetration: Fixed, normal: Vec3, contactPoint: Vec3 }
 */
export function circleCircle(
  posA: Vec3,
  radiusA: Fixed,
  heightA: Fixed,
  posB: Vec3,
  radiusB: Fixed,
  heightB: Fixed
): { collision: boolean; penetration: Fixed; normal: Vec3; contactPoint: Vec3 } | null {
  // Проверка Z-интервалов
  const zOverlap = interval_overlap(
    posA.z, add(posA.z, heightA),
    posB.z, add(posB.z, heightB)
  );
  if (!zOverlap) return null;

  // Вектор от A к B
  const delta = vecSub(posB, posA);
  const distance = vec_length_xy(delta);

  // Сумма радиусов
  const sumRadii = add(radiusA, radiusB);

  if (distance >= sumRadii || distance === ZERO) {
    return null; // Нет коллизии или центры совпадают
  }

  // Проникновение
  const penetration = sub(sumRadii, distance);

  // Нормаль (от A к B)
  const normal = vec_normalize_xy(delta);

  // Точка контакта (середина проникновения).
  // ВНИМАНИЕ: половина берётся через mul(_, HALF), а НЕ div(_, 2n): div —
  // это fixed-point деление, а 2n — сырой integer (в Q16.16 это 2/65536),
  // из-за чего div(pen, 2n) умножало бы penetration на ~32768.
  const halfPenetration = mul(penetration, HALF);
  const contactPoint = {
    x: add(posA.x, mul(normal.x, add(radiusA, halfPenetration))),
    y: add(posA.y, mul(normal.y, add(radiusA, halfPenetration))),
    z: max(posA.z, posB.z),
  };

  return { collision: true, penetration, normal, contactPoint };
}

/**
 * Проверка пересечения круга и AABB
 */
export function circleAabb(
  circlePos: Vec3,
  circleRadius: Fixed,
  circleHeight: Fixed,
  aabbPos: Vec3,
  aabbHalfWidth: Fixed,
  aabbHalfHeight: Fixed,
  aabbHeight: Fixed
): { collision: boolean; penetration: Fixed; normal: Vec3; contactPoint: Vec3 } | null {
  // Проверка Z-интервалов
  const zOverlap = interval_overlap(
    circlePos.z, add(circlePos.z, circleHeight),
    aabbPos.z, add(aabbPos.z, aabbHeight)
  );
  if (!zOverlap) return null;

  // Границы AABB
  const minX = sub(aabbPos.x, aabbHalfWidth);
  const maxX = add(aabbPos.x, aabbHalfWidth);
  const minY = sub(aabbPos.y, aabbHalfHeight);
  const maxY = add(aabbPos.y, aabbHalfHeight);

  // Найти ближайшую точку на AABB к центру круга
  const closestX = max(minX, min(circlePos.x, maxX));
  const closestY = max(minY, min(circlePos.y, maxY));

  const closest: Vec3 = { x: closestX, y: closestY, z: circlePos.z };

  // Вектор от ближайшей точки к центру круга
  const delta = vecSub(circlePos, closest);
  const distance = vec_length_xy(delta);

  // Центр круга внутри AABB (closest == центр, distance == 0) — раньше это
  // возвращало null, и тело «проваливалось» в стену без детекции. Теперь
  // выталкиваем через ближайшую грань: нормаль наружу, penetration = радиус +
  // расстояние до этой грани. Нормаль указывает «от AABB к кругу» (наружу),
  // как и в ветке снаружи — checkCollision сам приводит её к конвенции a→b.
  if (distance === ZERO) {
    const dLeft = sub(circlePos.x, minX);
    const dRight = sub(maxX, circlePos.x);
    const dBottom = sub(circlePos.y, minY);
    const dTop = sub(maxY, circlePos.y);

    let m = dLeft;
    let normal: Vec3 = { x: neg(ONE), y: ZERO, z: ZERO };
    if (dRight < m) { m = dRight; normal = { x: ONE, y: ZERO, z: ZERO }; }
    if (dBottom < m) { m = dBottom; normal = { x: ZERO, y: neg(ONE), z: ZERO }; }
    if (dTop < m) { m = dTop; normal = { x: ZERO, y: ONE, z: ZERO }; }

    const penetration = add(m, circleRadius);
    const contactPoint: Vec3 = { x: circlePos.x, y: circlePos.y, z: max(circlePos.z, aabbPos.z) };
    return { collision: true, penetration, normal, contactPoint };
  }

  if (distance >= circleRadius) {
    return null;
  }

  // Проникновение
  const penetration = sub(circleRadius, distance);

  // Нормаль (наружу от AABB к центру круга)
  const normal = vec_normalize_xy(delta);

  // Точка контакта
  const contactPoint = {
    x: add(closest.x, mul(normal.x, penetration)),
    y: add(closest.y, mul(normal.y, penetration)),
    z: max(circlePos.z, aabbPos.z),
  };

  return { collision: true, penetration, normal, contactPoint };
}

/**
 * Проверка пересечения двух AABB
 */
export function aabbAabb(
  posA: Vec3,
  halfWidthA: Fixed,
  halfHeightA: Fixed,
  heightA: Fixed,
  posB: Vec3,
  halfWidthB: Fixed,
  halfHeightB: Fixed,
  heightB: Fixed
): { collision: boolean; penetration: Fixed; normal: Vec3; contactPoint: Vec3 } | null {
  // Проверка Z-интервалов
  const zOverlap = interval_overlap(
    posA.z, add(posA.z, heightA),
    posB.z, add(posB.z, heightB)
  );
  if (!zOverlap) return null;

  // Проверка пересечения по X и Y
  const overlapX = sub(min(add(posA.x, halfWidthA), add(posB.x, halfWidthB)),
                       max(sub(posA.x, halfWidthA), sub(posB.x, halfWidthB)));
  const overlapY = sub(min(add(posA.y, halfHeightA), add(posB.y, halfHeightB)),
                       max(sub(posA.y, halfHeightA), sub(posB.y, halfHeightB)));

  if (overlapX <= ZERO || overlapY <= ZERO) {
    return null;
  }

  // Меньшее проникновение определяет нормаль
  let penetration: Fixed;
  let normal: Vec3;
  let contactPoint: Vec3;

  // Нормаль по конвенции контракта physics_v1.md §5 — направлена от a к b:
  // если A левее B, то a→b это +x (ONE).
  if (overlapX < overlapY) {
    penetration = overlapX;
    normal = { x: posA.x < posB.x ? ONE : neg(ONE), y: ZERO, z: ZERO };
    contactPoint = {
      x: posA.x < posB.x ? add(posA.x, halfWidthA) : sub(posA.x, halfWidthA),
      y: add(posA.y, posB.y) / BigInt(2),
      z: max(posA.z, posB.z),
    };
  } else {
    penetration = overlapY;
    normal = { x: ZERO, y: posA.y < posB.y ? ONE : neg(ONE), z: ZERO };
    contactPoint = {
      x: add(posA.x, posB.x) / BigInt(2),
      y: posA.y < posB.y ? add(posA.y, halfHeightA) : sub(posA.y, halfHeightA),
      z: max(posA.z, posB.z),
    };
  }

  return { collision: true, penetration, normal, contactPoint };
}

/**
 * Отрицание fixed
 */
function neg(a: Fixed): Fixed {
  return -a;
}
