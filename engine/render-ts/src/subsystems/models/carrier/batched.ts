/**
 * БАТЧЕВЫЙ носитель инстанса (REND-20): запись в разделяемом `InstancedMesh`
 * своей записи манифеста. Ни скелета, ни микшера, ни своих материалов —
 * скиннинг идёт на GPU по VAT-текстуре модели, а состояние анимации живёт
 * парой скаляров (`model/vatAnimation.ts`). Ярус по умолчанию: число draw
 * calls растёт с числом ЗАПИСЕЙ манифеста, а не инстансов.
 */
import * as THREE from 'three';
import type { BakedDerivatives } from '@fluxus/assets';
import { VatAnimationBackend } from '../../../model/vatAnimation.js';
import type { ModelBounds } from '../../../model/build.js';
import { screenSize } from '../instanceCull.js';
import { drawnFade } from '../instanceFade.js';
import {
  applyAnimation,
  type BatchEntry,
  type CarrierDeps,
  type InstanceCarrier,
  type InstanceRecord,
  type LodFrame,
} from '../instanceRecord.js';
import { disposePlaceholder } from './placeholder.js';
import { makeController, releaseHolder, type ControllerOptions } from './support.js';

/**
 * Ширина зоны нечувствительности выбора уровня (REND-22): порог срабатывает на
 * `±10%` от своего значения, и колебание экранного размера у порога не
 * переключает уровень кадр к кадру. Гистерезис — механизм, а сами пороги —
 * данные записи (ASSET-13); поэтому число здесь одно и относительное.
 */
const LOD_HYSTERESIS = 0.1;

/** Матрица и масштаб кадра — переиспользуемые: аллокаций на инстанс нет (REND-26). */
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_SCALE = new THREE.Vector3();

/** Батчевый ярус: запись в разделяемом инстанс-меше (REND-20). */
export function attachBatched(
  record: InstanceRecord,
  deps: CarrierDeps,
  entry: BatchEntry,
  derivatives: BakedDerivatives,
  options: ControllerOptions,
): void {
  record.batch = entry;
  record.slot = entry.batch.acquire();
  // Пустой батч из сцены снят: набор без записей не должен оставлять в кадре
  // ничего (REND-11, REND-18) — даже узла, который ничего не рисует.
  if (entry.batch.group.parent === null) deps.scene.add(entry.batch.group);
  record.lodLevel = 0;
  record.skinIndex = entry.skins.indexOf(record.skin);
  entry.batch.setSkin(record.slot, record.skinIndex);
  entry.batch.setLevel(record.slot, 0);
  const vat = new VatAnimationBackend(derivatives.clips, derivatives.fps, derivatives.restFrame);
  record.vat = vat;
  record.carrier = BATCHED_CARRIER;
  record.controller = makeController(record, vat, options, deps.warn);
  // Контроля костей у батчевой записи нет по построению: запись с ним
  // получает детальный ярус (REND-5 → REND-20).
  record.boneControl = null;
  disposePlaceholder(record);
  releaseHolder(record, deps);
  applyAnimation(record);
}

/** Поведение батчевой записи в кадре и на снятии. */
const BATCHED_CARRIER: InstanceCarrier = {
  tier: 'batched',
  applyPose: (record, drawScale) => {
    const entry = record.batch;
    if (entry === null) return;
    // Масштаб записи и нормализация по высоте у батча живут в ИНСТАНС-МАТРИЦЕ:
    // у детального яруса их несёт обёртка `body` внутри поддерева, здесь
    // поддерева нет — и множитель тот же самый. Fade едет отдельно (FOW-8).
    SCRATCH_SCALE.setScalar(drawScale * entry.normalized);
    SCRATCH_MATRIX.compose(record.pos, record.quat, SCRATCH_SCALE);
    entry.batch.setMatrix(record.slot, SCRATCH_MATRIX);
    entry.batch.setFade(record.slot, drawnFade(record));
    // Тинт (REND-40) — тем же пер-инстансным путём, что и доля проявленности:
    // маска команд-цвета скомпилирована в материалы батча (ASSET-18), и запись
    // отдаёт ему только цвет и силу. Запись без блока тинта канала не имеет —
    // её материалы его не читают, и писать в атрибут четыре числа на инстанс на
    // кадр было бы платой ни за что.
    const mask = record.tintMask;
    if (mask === null || mask.length > 0) {
      const tint = record.tint;
      entry.batch.setTint(record.slot, tint.r, tint.g, tint.b, tint.strength);
    }
    const vat = record.vat;
    if (vat !== null) {
      entry.batch.setPose(record.slot, vat.rowA, vat.rowB, vat.blend, record.skinIndex);
      entry.batch.setFrame(record.slot, vat.visibilityFrame);
    }
  },
  setVisible: (record, visible) => {
    record.batch?.batch.setVisible(record.slot, visible);
  },
  selectLod: (record, lod) => { selectLod(record, lod); },
  bounds: (record): ModelBounds | null => record.batch?.bounds ?? null,
  cullBounds: (record): ModelBounds | null => record.batch?.cullBounds ?? null,
  applySkin: (record) => {
    const entry = record.batch;
    if (entry === null) return;
    // Смена скина батчевой записи — запись ОДНОГО ЧИСЛА: соседние записи
    // батча и разделяемый набор вариантов не затронуты (REND-6).
    record.skinIndex = entry.skins.indexOf(record.skin);
    entry.batch.setSkin(record.slot, record.skinIndex);
  },
  detach: (record, deps) => {
    record.controller = null;
    record.vat = null;
    disposePlaceholder(record);
    const entry = record.batch;
    if (entry === null) return;
    const batch = entry.batch;
    batch.release(record.slot);
    // Опустевший батч уходит из сцены, но остаётся в кэше: разделяемое им
    // строится один раз на запись (REND-3), а рисовать ему уже нечего.
    if (batch.count === 0) {
      deps.dropCaster(batch.group);
      batch.group.removeFromParent();
    }
    record.batch = null;
    record.slot = -1;
    record.lodLevel = 0;
  },
};

/**
 * Уровень детализации записи по её экранному размеру (REND-22). Пороги —
 * данные записи (ASSET-13), гистерезис — механизм: у порога уровень не
 * дёргается кадр к кадру. Состояние записи переключение не трогает вовсе —
 * меняется только то, в какой набор инстанс-мешей она компактируется.
 */
function selectLod(record: InstanceRecord, lod: LodFrame): void {
  const entry = record.batch;
  if (entry === null) return;
  const maxLevel = entry.batch.levelCount - 1;
  if (maxLevel <= 0) return; // модель без цепочки — единственный уровень
  // Счёт и экранный размер — ПОСЛЕ отказов выше: у записи без цепочки уровней
  // работы нет, и ни считать её, ни платить за неё корнем дистанции кадр не
  // должен (PERF-3).
  if (lod.cost !== undefined) lod.cost.modelsLodSelections++;
  const size = screenSize(lod.radius, lod.camera.distanceTo(record.pos), lod);
  const scale = lod.scale;
  const thresholds = entry.thresholds;
  // Множитель пресета (QUAL-1) сдвигает ПОРОГИ, а не экранный размер: пороги
  // остаются данными записи (ASSET-13), а пресет говорит, насколько раньше
  // или позже их читать. Гистерезис при этом свой — он про дрожание у порога,
  // а не про качество.
  let level = Math.min(record.lodLevel, maxLevel);
  while (level < maxLevel && size < (thresholds[level] ?? 0) * scale * (1 - LOD_HYSTERESIS)) level += 1;
  while (
    level > 0 &&
    size > (thresholds[level - 1] ?? Number.POSITIVE_INFINITY) * scale * (1 + LOD_HYSTERESIS)
  ) {
    level -= 1;
  }
  record.lodLevel = level;
  entry.batch.setLevel(record.slot, level);
}
