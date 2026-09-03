/**
 * Публичная поверхность пакета `@fluxus/assets` — рендер-агностичного
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
  // эмиттерный decoration-вид и объединение родов записи вида (ASSET-14)
  EmitterVisual,
  DecorationVisual,
  SurfaceAlign,
  // секция транзиентных эффектов (`rendering` REND-23)
  EffectBlink,
  EffectColorAt,
  EffectStatWindow,
  VisualEffect,
  VisualEffectsSection,
  // секция эмиттеров частиц (ASSET-14, `rendering` REND-24)
  VisualEmitter,
  VisualParticlesSection,
  // параметры яруса и LOD записи (ASSET-13)
  VisualTier,
} from './manifest.js';
// секции камеры манифеста (ASSET-8, ASSET-10). Форма машинного описания типов
// эффектов (`camera` CAM-9) и состава конфига (CAM-1) живёт здесь, рядом с
// форматом секции, а их содержимое — в коде камеры.
export type {
  CameraConfigDescription,
  CameraConfigSection,
  CameraPathChannelSpec,
  CameraPathDef,
  CameraPathDescription,
  CameraPathKeyDef,
  CameraPathsSection,
  CameraEffectDef,
  CameraEffectKind,
  CameraEffectParamSpec,
  CameraEffectTypeSpec,
  CameraEffectsDescription,
  CameraEffectsSection,
} from './cameraEffects.js';
export {
  POSITIVE_MIN,
  cameraEffectParamInRange,
  cameraEffectParams,
  cameraEffectRangeText,
  cameraEffectType,
  clampCameraEffectParam,
} from './cameraEffects.js';
// валидация документа манифеста (ASSET-6, ASSET-8)
export type { ManifestValidation, ValidateManifestOptions } from './manifestValidate.js';
export { validateManifest } from './manifestValidate.js';
// блок света записи (ASSET-16) — локальный источник инстансов записи
// (`rendering` REND-33): состав, единицы и разбор в величины рендера
export type {
  ResolvedVisualLight,
  VisualLight,
  VisualLightAxes,
  VisualLightType,
} from './visualLight.js';
export {
  DEFAULT_LIGHT_DECAY,
  MAX_LIGHT_ANGLE_TURNS,
  VISUAL_LIGHT_TYPES,
  resolveLightBlock,
  validateVisualLight,
} from './visualLight.js';
export {
  resolveSurfaceAlign,
  resolveVisual,
  resolveVisualLight,
  resolveVisualTier,
  resolveVisualEmitter,
  resolveVisualClaim,
  isEmitterVisual,
  resolveEffectByKind,
  resolveEffectByState,
  resolveEffectByEvent,
  resolveParticlesByKind,
  resolveParticlesByState,
  resolveParticlesByEvent,
  resolveLodThresholds,
  DEFAULT_LOD_THRESHOLDS,
  visualKeys,
  manifestAssetRefs,
  DEFAULT_SURFACE_ALIGN,
} from './manifest.js';
export type { VisualAssetRef, VisualClaim } from './manifest.js';

// эмиттерный ассет — документ эффекта частиц (ASSET-14)
export type { ParticleEffectDocument, ParticleEffectNode } from './particleEffect.js';
export { validateParticleEffect } from './particleEffect.js';

// карта кривизны террейна (ASSET-7)
export type { TerrainCurvatureMap } from './curvature.js';
export { validateCurvatureMap, CURVATURE_SCALE } from './curvature.js';
export type { TerrainPaintMap } from './terrainPaint.js';
export { validateTerrainPaint, TERRAIN_PAINT_MAX_SLOT } from './terrainPaint.js';
export type {
  TerrainTileset,
  TerrainTilesetSlot,
  TerrainVisualSection,
} from './visualSections.js';

// таблица цветокоррекции кадра (`rendering` REND-34) — вид ассета `lut`
export type { ColorLut } from './colorLut.js';
export { MAX_LUT_SIZE, MIN_LUT_SIZE, parseCubeLut } from './colorLut.js';

// парный presentation-документ сцены (`presentation-scene` PRES-1..3)
export type {
  DecorationRecord,
  PresentationFog,
  PresentationStealth,
  PresentationScene,
  PresentationSceneContext,
} from './presentation.js';
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
// секция `lighting` документа (`rendering` REND-29, REND-32)
export type {
  PresentationAmbientLight,
  PresentationDirectionalLight,
  PresentationEnvironment,
  PresentationEnvironmentBackground,
  PresentationHemisphereLight,
  PresentationLightDirection,
  PresentationLighting,
  PresentationLightingCycle,
  PresentationLightingPhase,
  PresentationRimLight,
  PresentationShadowMode,
  PresentationShadows,
} from './presentationLighting.js';
export { PRESENTATION_SHADOW_MODES } from './presentationLighting.js';
// секция `postprocess` документа (`rendering` REND-34)
export type {
  PresentationBloom,
  PresentationLut,
  PresentationPostprocess,
  PresentationToneMapping,
  PresentationToneMappingOperator,
} from './presentationPostprocess.js';
export { PRESENTATION_TONE_MAPPING_OPERATORS } from './presentationPostprocess.js';
// секция `water` документа (`rendering` REND-35, REND-36)
export type {
  PresentationWater,
  PresentationWaterBody,
  PresentationWaterDetail,
  PresentationWaterDetailSource,
  PresentationWaterFoam,
  PresentationWaterRipples,
  WaterGridExtent,
} from './presentationWater.js';
export {
  PRESENTATION_WATER_DETAIL_SOURCES,
  WATER_EMPTY_CELL,
  WATER_MAX_RIPPLE_SOURCES,
  validateWater,
} from './presentationWater.js';

// загрузчики реестра (ASSET-3); регистрируются потребителем через registerLoader
export { mdxLoader } from './loaders/mdx.js';
export { gltfLoader } from './loaders/gltf.js';
export { pngTextureLoader, decodePng } from './loaders/png.js';
export { manifestLoader, createManifestLoader } from './loaders/manifest.js';
export type { ManifestLoaderOptions } from './loaders/manifest.js';
export { curvatureLoader } from './loaders/curvature.js';
export { terrainPaintLoader } from './loaders/terrainPaint.js';
export { LUT_ASSET_KIND, cubeLutLoader } from './loaders/cube.js';
export { particleEffectLoader } from './loaders/particleEffect.js';
export { presentationLoader } from './loaders/presentation.js';
