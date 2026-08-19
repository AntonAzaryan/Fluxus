/**
 * Применение позы камеры к THREE-камере (CAM-1) — одна общая реализация на
 * всех потребителей конвейера: игровой клиент и вьюпорт редактора
 * (`editor` ED-13). Собственная копия у потребителя означала бы, что кадры
 * расходятся не из-за настроек, а из-за двух разных способов посадить одну
 * и ту же позу на камеру.
 */
import * as THREE from 'three';

import type { CameraPose } from './rig.js';

/** Переиспользуемые скретчи: применение позы идёт покадрово. */
const lookTarget = new THREE.Vector3();
const savedUp = new THREE.Vector3();

/**
 * Ниже этого квадрата длины `up × forward` взгляд считается параллельным верху
 * камеры: `lookAt` в этом случае вырожден.
 */
const EPS_PARALLEL = 1e-12;

/**
 * Ставит камеру в позу: позиция глаза, взгляд по yaw/pitch, крен и FOV.
 * Матрица проекции пересчитывается только при смене FOV.
 *
 * Взгляд ровно в надир (или в зенит) у камеры с мировым верхом — вырожденный
 * случай `lookAt`: векторного произведения нет, и THREE решает вырождение
 * сдвигом самой оси взгляда на 1e-4, то есть кадром, который поза не заказывала
 * и который не зависит от `yaw`. Поэтому на вырождении верх берётся ИЗ ПОЗЫ —
 * `(sin·pitch·cos·yaw, sin·pitch·sin·yaw, cos·pitch)`, тот же орт, которым
 * считает пирамиду весь конвейер камеры, — и предельный кадр непрерывно
 * продолжает соседние. Невырожденные позы этой ветки не касаются вовсе: их
 * числа обязаны остаться прежними до последнего бита (счётчики отсечения
 * `performance-budget` PERF-3 считаются по этой матрице).
 */
export function applyCameraPose(camera: THREE.PerspectiveCamera, pose: CameraPose): void {
  camera.position.set(pose.posX, pose.posY, pose.posZ);
  const cosPitch = Math.cos(pose.pitch);
  const sinPitch = Math.sin(pose.pitch);
  const forwardX = Math.cos(pose.yaw) * cosPitch;
  const forwardY = Math.sin(pose.yaw) * cosPitch;
  const forwardZ = -sinPitch;
  lookTarget.set(pose.posX + forwardX, pose.posY + forwardY, pose.posZ + forwardZ);
  const up = camera.up;
  const crossX = up.y * forwardZ - up.z * forwardY;
  const crossY = up.z * forwardX - up.x * forwardZ;
  const crossZ = up.x * forwardY - up.y * forwardX;
  const degenerate = crossX * crossX + crossY * crossY + crossZ * crossZ < EPS_PARALLEL;
  if (degenerate) {
    savedUp.copy(up);
    up.set(sinPitch * Math.cos(pose.yaw), sinPitch * Math.sin(pose.yaw), cosPitch);
  }
  camera.lookAt(lookTarget);
  if (degenerate) up.copy(savedUp);
  if (pose.roll !== 0) camera.rotateZ(pose.roll);
  if (camera.fov !== pose.fovDeg) {
    camera.fov = pose.fovDeg;
    camera.updateProjectionMatrix();
  }
}
