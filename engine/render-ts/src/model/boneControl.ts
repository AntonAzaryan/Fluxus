/**
 * Процедурный контроль костей поверх клипа (REND-5).
 *
 * Override применяется ПОСЛЕ `mixer.update` и до отрисовки кадра: микшер
 * каждый кадр переписывает кватернион кости значением из клипа, поэтому
 * доворот не накапливается, а домножается заново (см. applyTorsoAim
 * прототипа). Лимит угла и скорость доворота — параметры манифеста на кость,
 * не константы кода.
 */
import * as THREE from 'three';

/** MDX Z-up: вертикаль модели; premultiply вокруг неё — доворот в пространстве родителя кости. */
const UP_Z = new THREE.Vector3(0, 0, 1);

/** Приводит угол к (-π, π] — кратчайшая дуга без перескока через ±π. */
export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Кламп относительного доворота лимитом манифеста. */
export function clampYaw(yaw: number, maxRad: number): number {
  return Math.max(-maxRad, Math.min(maxRad, yaw));
}

/**
 * Экспоненциальное сглаживание доворота: не зависит от FPS, `rate` — скорость
 * (1/с) из манифеста; rate <= 0 — мгновенный доворот.
 */
export function smoothYaw(current: number, desired: number, rate: number, dt: number): number {
  const t = rate <= 0 ? 1 : 1 - Math.exp(-rate * dt);
  return current + wrapAngle(desired - current) * t;
}

/** Шаг доворота роли за кадр: цель заворачивается, клампится лимитом, сглаживается. */
export function stepYaw(
  current: number,
  targetRelative: number,
  maxRad: number,
  rate: number,
  dt: number,
): number {
  return smoothYaw(current, clampYaw(wrapAngle(targetRelative), maxRad), rate, dt);
}

/** Параметры контроля одной кости из манифеста (ASSET-6). */
export interface BoneControlDef {
  readonly bone: string;
  readonly maxYawDeg: number;
  readonly smoothing: number;
}

interface RoleState {
  yaw: number;
  warned: boolean;
  /** Что мы записали в кость в прошлом кадре и что там было до override. */
  lastWritten: THREE.Quaternion | null;
  preOverride: THREE.Quaternion;
}

/** Доступ к костям инстанса по исходным именам нод модели. */
export interface BoneLookup {
  readonly bonesByName: ReadonlyMap<string, THREE.Bone>;
}

/**
 * Состояние bone-контроля одного инстанса: сглаженный угол на роль,
 * однократные предупреждения об отсутствующих костях (REND-5).
 */
export class BoneControlState {
  private readonly roles = new Map<string, RoleState>();
  private readonly quat = new THREE.Quaternion();
  private readonly controls: Readonly<Record<string, BoneControlDef>>;

  constructor(controls: Readonly<Record<string, BoneControlDef>>) {
    this.controls = controls;
  }

  /**
   * Применяет override всех ролей. `targetYaw` — мировое направление цели
   * (атака/каст) либо null — вернуть кость в нейтраль; `rootYaw` — фактический
   * курс инстанса, относительно которого считается доворот.
   */
  apply(
    instance: BoneLookup,
    targetYaw: number | null,
    rootYaw: number,
    dt: number,
    warn: (message: string) => void = (message) => console.warn(message),
  ): void {
    for (const [role, def] of Object.entries(this.controls)) {
      let state = this.roles.get(role);
      if (state === undefined) {
        state = { yaw: 0, warned: false, lastWritten: null, preOverride: new THREE.Quaternion() };
        this.roles.set(role, state);
      }

      const bone = instance.bonesByName.get(def.bone);
      if (bone === undefined) {
        // Кости нет в скелете — предупреждение один раз на инстанс и пропуск,
        // не ошибка (REND-5): манифест один на тип, модели могут отличаться.
        if (!state.warned) {
          state.warned = true;
          warn(`render: кость "${def.bone}" (роль "${role}") не найдена в скелете — override пропущен (REND-5)`);
        }
        continue;
      }

      const relative = targetYaw === null ? 0 : wrapAngle(targetYaw - rootYaw);
      state.yaw = stepYaw(state.yaw, relative, (def.maxYawDeg * Math.PI) / 180, def.smoothing, dt);

      // Если микшер не тронул кость в этом кадре (у клипа нет трека на неё),
      // в кватернионе всё ещё сидит наш прошлый override — откатываем его,
      // иначе довороты накапливались бы кадр за кадром.
      if (state.lastWritten !== null && bone.quaternion.equals(state.lastWritten)) {
        bone.quaternion.copy(state.preOverride);
      }
      state.preOverride.copy(bone.quaternion);
      bone.quaternion.premultiply(this.quat.setFromAxisAngle(UP_Z, state.yaw));
      if (state.lastWritten === null) state.lastWritten = new THREE.Quaternion();
      state.lastWritten.copy(bone.quaternion);
    }
  }
}
