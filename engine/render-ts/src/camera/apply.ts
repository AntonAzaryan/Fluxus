/**
 * Применение позы камеры к THREE-камере (CAM-1) — одна общая реализация на
 * всех потребителей конвейера: игровой клиент и вьюпорт редактора
 * (`editor` ED-13). Собственная копия у потребителя означала бы, что кадры
 * расходятся не из-за настроек, а из-за двух разных способов посадить одну
 * и ту же позу на камеру.
 */
import * as THREE from 'three';

import type { CameraPose } from './rig.js';

/** Переиспользуемая цель взгляда: применение позы идёт покадрово. */
const lookTarget = new THREE.Vector3();

/**
 * Ставит камеру в позу: позиция глаза, взгляд по yaw/pitch, крен и FOV.
 * Матрица проекции пересчитывается только при смене FOV.
 */
export function applyCameraPose(camera: THREE.PerspectiveCamera, pose: CameraPose): void {
  camera.position.set(pose.posX, pose.posY, pose.posZ);
  const cosPitch = Math.cos(pose.pitch);
  lookTarget.set(
    pose.posX + Math.cos(pose.yaw) * cosPitch,
    pose.posY + Math.sin(pose.yaw) * cosPitch,
    pose.posZ - Math.sin(pose.pitch),
  );
  camera.lookAt(lookTarget);
  if (pose.roll !== 0) camera.rotateZ(pose.roll);
  if (camera.fov !== pose.fovDeg) {
    camera.fov = pose.fovDeg;
    camera.updateProjectionMatrix();
  }
}
