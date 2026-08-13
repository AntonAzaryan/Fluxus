/**
 * Публичная поверхность пакета `@game-mvp/assets` — рендер-агностичного
 * модуля presentation-ассетов (ASSET-1..6). Контракт согласован с `render-ts`:
 * имена и сигнатуры ниже — API, на который опирается рендер.
 */

// сервис и его контракты (ASSET-2, ASSET-3, ASSET-4)
export type {
  AssetKind,
  KnownAssetKind,
  Handle,
  AssetState,
  AssetSource,
  AssetLoader,
  LoaderContext,
} from './types.js';
export { AssetService, resolveDependencyPath } from './service.js';

// нормализованная модель (ASSET-5)
export type {
  NormalizedModel,
  NormalizedBone,
  NormalizedMaterial,
  NormalizedMesh,
  NormalizedSequence,
  BoneTrack,
  ChannelKeys,
  Interpolation,
  PartVisibilityTrack,
  TextureSlotRef,
  TextureSlotFile,
  TextureSlotEmbedded,
  TextureSlotNone,
} from './model.js';

// декодированное изображение — вид текстурного ассета (ASSET-5)
export type { DecodedImage } from './image.js';

// выборка поверхности канонической модели (ASSET-11) — для walkable-вклада
// поля высот и picking'а рендера (REND-9, REND-15)
export type { ModelSurfaceHit, ModelSurfaceBounds, ModelSurfaceIndex } from './surface.js';
export { modelSurfaceIndex } from './surface.js';

// запечённые производные модели (ASSET-12) — bone-VAT, таблица клипов,
// консервативные границы по клипам и маска видимости частей; и набор вариантов
// скинов записи манифеста (ASSET-12 же, но производная ЗАПИСИ, а не модели)
export type {
  BakeParams,
  BakedClip,
  BakedDerivatives,
  BakedLodLevel,
  BakedPartVisibility,
  BoneVat,
  ModelDerivatives,
} from './derivatives.js';
export {
  DEFAULT_BAKE_FPS,
  DEFAULT_MAX_VAT_SIZE,
  VAT_TEXELS_PER_BONE,
  bakeDerivatives,
  modelDerivatives,
} from './derivatives.js';
export type { BakeSkinParams, BakedSkinSet, BakedSkinSlot, SkinVariantSource } from './skinVariants.js';
export { DEFAULT_SKIN_MAX_SIZE, bakeSkinVariants, skinVariantIndex } from './skinVariants.js';

// манифест визуалов (ASSET-6)
export type {
  VerticalOffset,
  VisualManifest,
  EntityVisual,
  SurfaceAlign,
  CameraEffectsSection,
  CameraEffectDef,
  // Форма машинного описания типов эффектов (`camera` CAM-9): контракт живёт
  // здесь, рядом с форматом секции, а его содержимое — в коде камеры.
  CameraEffectKind,
  CameraEffectParamSpec,
  CameraEffectTypeSpec,
  CameraEffectsDescription,
  // Секция конфига камеры (ASSET-10) — тем же порядком: формат здесь, состав
  // параметров и умолчания в коде камеры (`camera` CAM-1).
  CameraConfigSection,
  CameraConfigDescription,
  ManifestValidation,
  ValidateManifestOptions,
  // параметры яруса и LOD записи (ASSET-13)
  VisualTier,
} from './manifest.js';
export {
  validateManifest,
  resolveSurfaceAlign,
  resolveVisual,
  resolveVisualTier,
  resolveLodThresholds,
  DEFAULT_LOD_THRESHOLDS,
  visualKeys,
  cameraEffectParams,
  cameraEffectParamInRange,
  cameraEffectRangeText,
  cameraEffectType,
  clampCameraEffectParam,
  POSITIVE_MIN,
  DEFAULT_SURFACE_ALIGN,
} from './manifest.js';

// карта кривизны террейна (ASSET-7)
export type { TerrainCurvatureMap } from './curvature.js';
export { validateCurvatureMap, CURVATURE_SCALE } from './curvature.js';

// парный presentation-документ сцены (`presentation-scene` PRES-1..3)
export type { DecorationRecord, PresentationScene } from './presentation.js';
export {
  DECORATION_POSITION_STEP,
  DECORATION_YAW_STEP,
  PRESENTATION_SUFFIX,
  isPresentationPath,
  presentationPathOf,
  quantizeDecorationLength,
  quantizeDecorationYaw,
  validatePresentationScene,
} from './presentation.js';

// загрузчики реестра (ASSET-3); регистрируются потребителем через registerLoader
export { mdxLoader } from './loaders/mdx.js';
export { gltfLoader } from './loaders/gltf.js';
export { pngTextureLoader, decodePng } from './loaders/png.js';
export { manifestLoader, createManifestLoader } from './loaders/manifest.js';
export type { ManifestLoaderOptions } from './loaders/manifest.js';
export { curvatureLoader } from './loaders/curvature.js';
export { presentationLoader } from './loaders/presentation.js';
