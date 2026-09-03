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

/** Z-up канонических осей ассета (ASSET-5): вертикаль МОДЕЛИ, вокруг которой идёт доворот. */
const UP_Z = new THREE.Vector3(0, 0, 1);

/** Переиспользуемое хозяйство разбора позы привязки — оси считаются раз на роль. */
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_QUAT = new THREE.Quaternion();

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
  /** Кость, к которой роль привязана сейчас: переподача манифеста её меняет (REND-17). */
  bone: string;
  /**
   * Ось доворота в пространстве РОДИТЕЛЯ кости; null — кость ещё не найдена.
   * Считается один раз: поза привязки — свойство рига, а не кадра (см.
   * `upAxisInParent`). Роль, переехавшая на другую кость, начинается заново
   * вместе со своим состоянием — и ось пересчитывается по новой кости.
   */
  axis: THREE.Vector3 | null;
  yaw: number;
  warned: boolean;
  /** Что мы записали в кость в прошлом кадре и что там было до override. */
  lastWritten: THREE.Quaternion | null;
  preOverride: THREE.Quaternion;
}

/** Доступ к костям инстанса по исходным именам нод модели. */
export interface BoneLookup {
  readonly bonesByName: ReadonlyMap<string, THREE.Bone>;
  /**
   * Скелет инстанса — источник позы ПРИВЯЗКИ (`build.ts`, `buildSkeleton`): по
   * ней берётся ориентация родителя кости для оси доворота (`upAxisInParent`).
   * Необязателен: без него ось считается по накопленным локальным поворотам
   * предков — на иерархии, которую ещё не двигал клип, это то же самое.
   */
  readonly skeleton?: THREE.Skeleton;
}

/**
 * Ось доворота роли: вертикаль МОДЕЛИ, выраженная в пространстве родителя кости
 * (REND-5). `bone.quaternion.premultiply(q)` крутит кость в осях её родителя,
 * поэтому вокруг model-up она повернётся только если ось взята как
 * `q_родителя⁻¹ · Z`. У MDX повороты в позе покоя единичны (`build.ts`), и обе
 * оси совпадают; у ригов glTF (BLND-11) с повёрнутыми Hips/Spine разница
 * наблюдаема сразу — торс разворачивается вокруг наклонённой оси.
 *
 * Ориентация родителя берётся из позы ПРИВЯЗКИ, а не из текущего кадра: ось —
 * свойство рига, и пересчитывать её каждый кадр значило бы возить её вместе с
 * клипом. Пишет в `out` и его же возвращает.
 */
function upAxisInParent(bone: THREE.Bone, lookup: BoneLookup, out: THREE.Vector3): THREE.Vector3 {
  const parent = bone.parent;
  if (parent === null) return out.copy(UP_Z);
  return out.copy(UP_Z).applyQuaternion(bindQuaternion(parent, lookup).invert()).normalize();
}

/** Узел иерархии — кость: выше корня скелета накапливать уже нечего. */
function isBone(node: THREE.Object3D | null): node is THREE.Bone {
  return node !== null && (node as Partial<THREE.Bone>).isBone === true;
}

/**
 * Ориентация узла в позе привязки, модельные оси. Матрицы обратной привязки
 * скелета — прямой ответ (их и считает `buildSkeleton` по позе покоя либо
 * берёт у формата); без скелета остаются локальные повороты предков, накопленные
 * до корня скелета. Возвращает ОБЩИЙ scratch-кватернион — вызывающий обязан
 * употребить его сразу.
 */
function bindQuaternion(node: THREE.Object3D, lookup: BoneLookup): THREE.Quaternion {
  const bones = lookup.skeleton?.bones;
  const index = bones === undefined ? -1 : bones.indexOf(node as THREE.Bone);
  const inverse = index < 0 ? undefined : lookup.skeleton?.boneInverses[index];
  if (inverse !== undefined) {
    SCRATCH_MATRIX.copy(inverse).invert().decompose(SCRATCH_POSITION, SCRATCH_QUAT, SCRATCH_SCALE);
    return SCRATCH_QUAT;
  }
  SCRATCH_QUAT.identity();
  for (let current: THREE.Object3D | null = node; isBone(current); current = current.parent) {
    SCRATCH_QUAT.premultiply(current.quaternion);
  }
  return SCRATCH_QUAT;
}

/**
 * Состояние bone-контроля одного инстанса: сглаженный угол на роль,
 * однократные предупреждения об отсутствующих костях (REND-5).
 */
export class BoneControlState {
  private readonly roles = new Map<string, RoleState>();
  private readonly quat = new THREE.Quaternion();
  /**
   * Параметры ролей парами «роль → описание»; переподаваемы вместе с манифестом
   * (REND-17). Таблица раскладывается в пары ОДИН РАЗ на её приём, а не в
   * кадре: `apply` зовётся каждый кадр и на каждый инстанс с контролем костей,
   * и `Object.entries` в нём заводил бы массив пар пропорционально числу таких
   * инстансов — в установившемся кадре путь не аллоцирует.
   */
  private controls: readonly (readonly [string, BoneControlDef])[];
  /**
   * Роли, оставившие свой override на кости, которой больше не управляют, —
   * снятая роль и роль, переехавшая на другую кость. Откат делается в `apply`,
   * где есть доступ к скелету инстанса, а не здесь.
   */
  private readonly abandoned: RoleState[] = [];

  constructor(controls: Readonly<Record<string, BoneControlDef>>) {
    this.controls = Object.entries(controls);
  }

  /**
   * Параметры ролей правленого манифеста (REND-17). Роль, оставшаяся на своей
   * кости, сохраняет накопленный сглаженный доворот: лимит и скорость читаются
   * покадрово, и менять из-за них состояние не за что. Роль, переехавшая на
   * другую кость, начинается заново вместе со своим однократным предупреждением
   * (REND-5) — это другая кость, и молчать о её отсутствии нельзя.
   */
  setControls(controls: Readonly<Record<string, BoneControlDef>>): void {
    for (const [role, state] of this.roles) {
      // Роль осталась на той же кости — состояние её доворота живёт дальше.
      if (controls[role]?.bone === state.bone) continue;
      this.roles.delete(role);
      this.abandoned.push(state);
    }
    this.controls = Object.entries(controls);
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
    warn: (message: string) => void = (message) => { console.warn(message); },
  ): void {
    this.releaseAbandoned(instance);

    for (const [role, def] of this.controls) {
      let state = this.roles.get(role);
      if (state === undefined) {
        state = {
          bone: def.bone,
          axis: null,
          yaw: 0,
          warned: false,
          lastWritten: null,
          preOverride: new THREE.Quaternion(),
        };
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

      // Ось доворота — раз на роль (REND-5): поза привязки от кадра не зависит,
      // а кость роли меняется только переподачей манифеста, и она заводит
      // состояние роли заново.
      state.axis ??= upAxisInParent(bone, instance, new THREE.Vector3());

      const relative = targetYaw === null ? 0 : wrapAngle(targetYaw - rootYaw);
      state.yaw = stepYaw(state.yaw, relative, (def.maxYawDeg * Math.PI) / 180, def.smoothing, dt);

      // Если микшер не тронул кость в этом кадре (у клипа нет трека на неё),
      // в кватернионе всё ещё сидит наш прошлый override — откатываем его,
      // иначе довороты накапливались бы кадр за кадром.
      if (state.lastWritten !== null && bone.quaternion.equals(state.lastWritten)) {
        bone.quaternion.copy(state.preOverride);
      }
      state.preOverride.copy(bone.quaternion);
      bone.quaternion.premultiply(this.quat.setFromAxisAngle(state.axis, state.yaw));
      state.lastWritten ??= new THREE.Quaternion();
      state.lastWritten.copy(bone.quaternion);
    }
  }

  /**
   * Возврат костей, которыми роль больше не управляет, к значению до override.
   * Без этого доворот, записанный до переподачи, остался бы в кости навсегда —
   * клип перепишет её только если у него есть на неё трек.
   */
  private releaseAbandoned(instance: BoneLookup): void {
    if (this.abandoned.length === 0) return;
    for (const state of this.abandoned) {
      const bone = instance.bonesByName.get(state.bone);
      if (bone !== undefined && state.lastWritten !== null && bone.quaternion.equals(state.lastWritten)) {
        bone.quaternion.copy(state.preOverride);
      }
    }
    this.abandoned.length = 0;
  }
}
