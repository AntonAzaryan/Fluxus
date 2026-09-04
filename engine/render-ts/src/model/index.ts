/**
 * Публичная поверхность построения инстансов (REND-3..REND-6, REND-20) — свой
 * барьер рядом с её модулями, как у камеры (`camera/index.ts`) и у миникарты в
 * `hud-ts`: корневой барьер пакета называет её одной строкой, а состав живёт
 * там же, где код.
 *
 * Это THREE-половина нормализованных данных ассета: из чего строится инстанс,
 * чем он анимируется, каким ярусом рисуется и как одевается скином. Подсистема
 * моделей сюда не входит — она за контрактом REND-8 и названа корневым барьером
 * вместе с остальными подсистемами.
 */

// Визуальная поверхность под инстансом (REND-9, REND-10): наклон и доворот.
export { tiltTarget, smoothTilt, orientFromTiltYaw } from './surfaceAlign.js';
export type { TiltVector } from './surfaceAlign.js';

// Вертикальное смещение инстанса: дуга прыжка и снижение при провале (REND-12).
export { jumpArc, jumpBase, maneuverEnds, advanceFall } from './verticalOffset.js';
export type { ManeuverEnds } from './verticalOffset.js';

// Построение инстансов из нормализованных данных ассета (THREE-половина mdxModel).
export {
  buildBones,
  buildClips,
  buildSharedModel,
  createModelInstance,
  geometryFromMesh,
  modelBounds,
} from './build.js';
export type {
  InstanceOptions,
  ModelBounds,
  ModelInstance,
  SharedMeshData,
  SharedModelData,
  SkeletonBuild,
} from './build.js';

// Анимационный контроллер (REND-4): одна машина состояний, два носителя
// воспроизведения — микшер детального яруса и скаляры батчевого (REND-20).
export { AnimationController, MixerAnimationBackend, resolveClip } from './animation.js';
export type {
  AnimationBackend,
  AnimationControllerOptions,
  AnimationMapping,
  ClipResolution,
  NamedClip,
} from './animation.js';
export { VatAnimationBackend } from './vatAnimation.js';

// Батчевый ярус (REND-20): батч инстансов, VAT-материал и набор вариантов скина.
export { ModelBatch, batchLevels } from './batch.js';
export type { BatchPartSource, ModelBatchOptions } from './batch.js';
export {
  VAT_MAP_KINDS,
  createSkinPlaceholder,
  createVatMaterial,
  createVatTexture,
  materialMapKinds,
} from './vatMaterial.js';
export type { VatMapKind, VatMaterial, VatMaterialUniforms } from './vatMaterial.js';
export {
  BASE_SKIN_VARIANT,
  BatchSkinLoader,
  skinArrayTexture,
  skinVariantNames,
  variantSources,
} from './batchSkins.js';

// Bone-контроль (REND-5).
export { BoneControlState, clampYaw, smoothYaw, stepYaw, wrapAngle } from './boneControl.js';
export type { BoneControlDef, BoneLookup } from './boneControl.js';

// Скины (REND-6).
export { applySkin, createSkinTextureCache, skinTextureSources, textureFromImage } from './skins.js';
export type { SkinApplication, SkinTextureCache, SkinTextureSource } from './skins.js';
