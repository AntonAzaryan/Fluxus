/**
 * Наклон инстанса по нормали визуальной поверхности (REND-10).
 *
 * Наклон хранится вектором «ось × угол», спроецированным на горизонтальную
 * плоскость: `(tx, ty)` — компоненты оси наклона, длина вектора — угол в
 * радианах. Ноль — вертикально. Такое представление сглаживается покомпонентно
 * (в отличие от кватерниона) и не имеет сингулярности у вертикали.
 *
 * Масштабирование угла долей `factor` эквивалентно slerp(вертикаль, нормаль,
 * factor): поворот от вертикали к нормали — один поворот вокруг фиксированной
 * оси, и slerp по нему — это доля угла.
 */
import * as THREE from 'three';
import type { SurfaceNormal } from '../visualSurface.js';

export interface TiltVector {
  x: number;
  y: number;
}

/**
 * Целевой наклон из нормали поверхности: угол от вертикали × factor,
 * ограниченный `maxAngleRad` (null — без лимита). Пишет в out.
 */
export function tiltTarget(
  normal: SurfaceNormal,
  factor: number,
  maxAngleRad: number | null,
  out: TiltVector,
): TiltVector {
  const sin = Math.hypot(normal.x, normal.y);
  let angle = Math.atan2(sin, normal.z) * factor;
  if (maxAngleRad !== null && angle > maxAngleRad) angle = maxAngleRad;
  if (sin < 1e-9 || angle <= 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  // Ось наклона = cross(вертикаль, нормаль), нормированная: (-ny, nx) / sin.
  out.x = (-normal.y / sin) * angle;
  out.y = (normal.x / sin) * angle;
  return out;
}

// Переиспользуемые объекты композиции ориентации — аллокаций на кадр нет.
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const SCRATCH_AXIS = new THREE.Vector3();
const SCRATCH_Q_TILT = new THREE.Quaternion();
const SCRATCH_Q_YAW = new THREE.Quaternion();

/**
 * Ориентация инстанса из наклона и курса: сперва курс вокруг вертикали, поверх
 * — наклон в мировых осях. Общая для подсистемы моделей и walkable-реестра поля
 * высот (REND-9): трансформ walkable-поверхности обязан быть ровно тем, каким
 * инстанс нарисован, и композиция поворотов у них поэтому одна, а не две
 * похожие. Пишет в out и возвращает его.
 */
export function orientFromTiltYaw(
  tilt: TiltVector,
  yaw: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  SCRATCH_Q_YAW.setFromAxisAngle(WORLD_UP, yaw);
  const angle = Math.hypot(tilt.x, tilt.y);
  if (angle < 1e-6) return out.copy(SCRATCH_Q_YAW);
  SCRATCH_AXIS.set(tilt.x / angle, tilt.y / angle, 0);
  SCRATCH_Q_TILT.setFromAxisAngle(SCRATCH_AXIS, angle);
  return out.multiplyQuaternions(SCRATCH_Q_TILT, SCRATCH_Q_YAW);
}

/** Экспоненциальное сглаживание к цели (по образцу smoothYaw REND-5). */
export function smoothTilt(
  current: TiltVector,
  target: TiltVector,
  rate: number,
  dt: number,
): void {
  const blend = 1 - Math.exp(-rate * dt);
  current.x += (target.x - current.x) * blend;
  current.y += (target.y - current.y) * blend;
}
