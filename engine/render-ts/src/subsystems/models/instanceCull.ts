/**
 * Отсечение инстансов пирамидой видимости и выбор уровня детализации (REND-21,
 * REND-22). Модуль пишет в запись РОВНО два поля — `visible` и `lodLevel` — и
 * передаёт итог носителю яруса: гасить нарисованное умеет он, а не отсечение.
 *
 * Аллокаций на кадр и на инстанс здесь нет: пирамида, матрица, сфера и метрика
 * экрана живут на объекте отсечения и переиспользуются (REND-26).
 */
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { RenderCostCounters } from '../../cost.js';
import { boundsOf, cullBoundsOf, type InstanceRecord, type LodFrame } from './instanceRecord.js';

/**
 * Половина радиуса габаритов сверх них самих: столько добавляет отсечению
 * консервативности запас по умолчанию (REND-21). Порядок величины взят от
 * размаха обычного клипа — выпад руки с оружием у нормализованной по высоте
 * модели, — а не от вкуса: меньше половины радиуса срезало бы такой клип.
 */
export const DEFAULT_CULL_MARGIN = 0.5;

/** Метрика экранного размера камеры — то, что от неё нужно выбору уровня. */
interface ScreenScale {
  /** Тангенс половины вертикального поля зрения; 0 — камера ортографическая. */
  tanHalfFov: number;
  /** Видимая высота кадра в мировых единицах у ортографической камеры. */
  orthoHeight: number;
}

/**
 * Метрика камеры — в поданную запись; null — камера ни перспективная, ни
 * ортографическая (уровень тогда не выбирается вовсе). Пишет в `out`, а не
 * заводит запись: отсечение с выбором уровня идёт каждый кадр, и своей записи
 * на кадр у него быть не должно — тем же соображением здесь живут пирамида,
 * матрица и сфера.
 */
function screenScaleOf(camera: THREE.Camera, out: ScreenScale): ScreenScale | null {
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    out.tanHalfFov = Math.tan(((perspective.fov / 2) * Math.PI) / 180);
    out.orthoHeight = 0;
    return out;
  }
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    const height = (ortho.top - ortho.bottom) / (ortho.zoom || 1);
    if (height <= 0) return null;
    out.tanHalfFov = 0;
    out.orthoHeight = height;
    return out;
  }
  return null;
}

/**
 * Экранный размер инстанса — доля высоты кадра, которую занимает его
 * консервативная сфера (REND-22). Именно доля, а не пиксели: пороги записи
 * (ASSET-13) не должны зависеть от разрешения вьюпорта.
 */
export function screenSize(radius: number, distance: number, screen: ScreenScale): number {
  if (screen.tanHalfFov > 0) {
    const visible = Math.max(distance, 1e-6) * screen.tanHalfFov;
    return radius / visible;
  }
  return (2 * radius) / screen.orthoHeight;
}

/**
 * Хозяйство отсечения одного кадра. Живёт на подсистеме, а не в кадре: см.
 * `beginFrame`.
 */
export class InstanceCuller {
  /**
   * Переиспользуемое хозяйство отсечения (REND-21): пирамида, матрица кадра и
   * сфера инстанса. Аллокаций на кадр и на инстанс у отсечения нет — иначе оно
   * платило бы за себя тем же, что экономит.
   */
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere();
  private readonly cullCenter = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  /** Метрика экранного размера камеры (REND-22) — снимается в неё каждый кадр. */
  private readonly screenScale: ScreenScale = { tanHalfFov: 0, orthoHeight: 0 };
  /** Запас консервативности сферы и множитель порогов — параметры кадра. */
  private margin = DEFAULT_CULL_MARGIN;
  private lodScale = 1;
  private screen: ScreenScale | null = null;
  /**
   * Пирамида теневой камеры кадра (REND-30); null — теней нет, и отсечение
   * идёт одной пирамидой камеры, как до её появления.
   */
  private shadowFrustum: THREE.Frustum | null = null;
  /**
   * Слагаемые выбора уровня — ОДНА переиспользуемая запись на кадр: носитель
   * читает её и считает экранный размер сам, если уровни у него есть (REND-22).
   */
  private readonly lod: LodFrame = {
    radius: 0,
    camera: this.cameraPosition,
    tanHalfFov: 0,
    orthoHeight: 0,
    scale: 1,
    cost: undefined,
  };

  /**
   * Кадр начался: пирамида, положение камеры и метрика экрана снимаются ОДИН
   * раз на кадр, а не на инстанс. Матрицы берутся те, с которыми кадр и будет
   * нарисован: позу на камеру сажает сборка до кадра подсистем (CAM-1).
   */
  beginFrame(
    camera: THREE.Camera,
    margin: number,
    lodScale: number,
    shadowFrustum: THREE.Frustum | null,
  ): void {
    camera.updateMatrixWorld();
    this.frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.margin = margin;
    this.lodScale = lodScale;
    this.shadowFrustum = shadowFrustum;
    this.screen = screenScaleOf(camera, this.screenScale);
  }

  /** Отсечение пула по пирамиде текущего кадра (REND-21). */
  cullPool(
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    cost: RenderCostCounters | undefined,
  ): void {
    for (const record of pool.values()) {
      this.cullRecord(record, cost);
    }
  }

  /** Отсечение одной записи: сфера её габаритов против пирамиды кадра (REND-22). */
  private cullRecord(record: InstanceRecord, cost: RenderCostCounters | undefined): void {
    const margin = this.margin;
    const bounds = cullBoundsOf(record) ?? boundsOf(record);
    // Рисовать нечего — и отсекать нечего: невизуальная сущность в кадре не
    // участвует вовсе, а не «участвует невидимой».
    if (bounds === null || !record.posed) return;
    const scale = record.scale;
    // Центр габаритов в осях инстанса → мировые оси тем же преобразованием,
    // которым инстанс нарисован; радиус — половина диагонали. Запас берётся
    // ВСЕГДА, а не только к границам bind-позы: консервативность запечённых
    // границ (ASSET-12) отвечает за позы клипов, но не за то, чего в границах
    // модели нет вовсе, — оверлеи (REND-16), контроль костей (REND-5) и
    // погрешность самой сферы у вытянутых моделей.
    this.cullCenter
      .set((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2)
      .multiplyScalar(scale)
      .applyQuaternion(record.quat)
      .add(record.pos);
    const radius =
      (Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2) *
      Math.abs(scale) *
      (1 + margin);
    this.cullSphere.center.copy(this.cullCenter);
    this.cullSphere.radius = radius;
    // Инстанс нарисован, если он в кадре ЛИБО отбрасывает тень в него (REND-21,
    // REND-30): гашение — это `visible = false` у держателя и пропуск слота в
    // компактации батча, а три пропускает невидимое и в теневом проходе. Отсеки
    // мы кастера за краем экрана — его тень исчезла бы ИЗНУТРИ экрана, а у
    // отсечения других наблюдаемых последствий быть не должно. Тест второй
    // пирамидой платится только за то, чего камера не видит: за видимым
    // инстансом он не идёт вовсе.
    record.visible =
      this.frustum.intersectsSphere(this.cullSphere) ||
      this.shadowFrustum?.intersectsSphere(this.cullSphere) === true;
    // Сток уже в локальной переменной: на инстансе остаётся сравнение и
    // целочисленное сложение, а не чтение стока (PERF-3).
    if (cost !== undefined) {
      cost.modelsCullTests++;
      if (!record.visible) cost.modelsCulled++;
    }
    // Итог отсечения — носителю (REND-20): гасить нарисованное умеет он.
    record.carrier.setVisible(record, record.visible);
    // Уровень детализации выбирает тоже он — и выбирает его ТОЛЬКО батчевый
    // (REND-22): детальный инстанс рисуется уровнем 0 на любой дистанции,
    // потому что цену его кадра держат пер-инстансный скелет и материалы
    // (REND-20), а не геометрия уровня. Это оговорка требования, а не пропуск.
    if (!record.visible || this.screen === null) return;
    this.lod.radius = radius;
    this.lod.tanHalfFov = this.screen.tanHalfFov;
    this.lod.orthoHeight = this.screen.orthoHeight;
    this.lod.scale = this.lodScale;
    this.lod.cost = cost;
    record.carrier.selectLod(record, this.lod);
  }

}
