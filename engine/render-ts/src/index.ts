// Контракты пакета: подсистемы, presentation-состояние, конфиг хоста.
export { DEFAULT_CURVATURE_TESSELLATION } from './types.js';
export type {
  EntityView,
  RenderConfig,
  RenderContext,
  RenderEvent,
  RenderHostConfig,
  RenderSubsystem,
  TickView,
} from './types.js';

// Хост — TickObserver ядра (REND-1, REND-2) и продюсер presentation-состояния.
export { RenderHost, kindByTags } from './host.js';
export { FloorMirror } from './floorMirror.js';

// Сцена подсистем (REND-8) — общая часть продюсеров presentation-состояния, и
// документный источник инстансов как второй продюсер (REND-11).
export { PresentationStage } from './stage.js';
export type { PresentationProducer } from './stage.js';
export { DocumentSource } from './documentSource.js';
export type { DocumentInstance, DocumentSourceOptions } from './documentSource.js';

// Половины хоста по границе потоков (client-shell SHELL-2): Extractor —
// воркер-сторона (единственный читатель мира), ViewBuffer — main-сторона.
export { Extractor, ENTITY_MOVING, ENTITY_LEVEL_OVERRIDE } from './extractor.js';
export type { ExtractedTick, ExtractorConfig } from './extractor.js';
export { ViewBuffer } from './viewBuffer.js';
export type { FrameTiming, ViewBufferConfig } from './viewBuffer.js';

// Камера (camera CAM-1..8): rig режимов и вход кадрирования, слой эффектов,
// диспетчер по манифесту, общее применение позы к THREE-камере.
export {
  CameraRig,
  DEFAULT_CAMERA_CONFIG,
  createCameraInput,
  resetCameraInput,
  edgePanAxes,
  terrainGroundApi,
} from './camera/rig.js';
export type {
  CameraBounds,
  CameraConfig,
  CameraFraming,
  CameraInput,
  CameraMode,
  CameraPose,
  CameraRigOptions,
  CameraSources,
  FollowTarget,
  TerrainCameraSource,
} from './camera/rig.js';
export {
  EffectStack,
  SwayEffect,
  TraumaShake,
  valueNoise,
  DEFAULT_SHAKE,
  DEFAULT_SWAY,
} from './camera/effects.js';
export type { CameraEffect, PoseOffset, ShakeParams, SwayParams } from './camera/effects.js';
export { CameraEffectsDirector } from './camera/director.js';
export type { CameraEffectsDirectorOptions } from './camera/director.js';
export { applyCameraPose } from './camera/apply.js';

// Визуальная поверхность террейна (REND-9, REND-10): хелпер, общий для
// подсистем террейна и моделей, и его источник с загрузкой карты кривизны.
export { cornerLevels, createVisualSurface } from './visualSurface.js';
export type { MutableVisualSurface, SurfaceNormal, VisualSurface } from './visualSurface.js';
export { VisualSurfaceSource } from './surfaceSource.js';
export type { SurfaceChangeListener, VisualSurfaceSourceOptions } from './surfaceSource.js';
export { tiltTarget, smoothTilt } from './model/surfaceAlign.js';
export type { TiltVector } from './model/surfaceAlign.js';

// Вертикальное смещение инстанса: дуга прыжка и снижение при провале (REND-12).
export { jumpArc, jumpBase, maneuverEnds, advanceFall } from './model/verticalOffset.js';
export type { ManeuverEnds } from './model/verticalOffset.js';

// Подсистема террейна (REND-7, REND-9) и её чистые генераторы геометрии.
export {
  TerrainSubsystem,
  buildFloorGeometry,
  buildWallGeometry,
  toBufferGeometry,
} from './subsystems/terrain.js';
export type { CellRect, TerrainGeometryData, TerrainOptions } from './subsystems/terrain.js';

// Подсистема моделей (REND-3..6) и переподача манифеста визуалов (REND-17).
export { ModelsSubsystem } from './subsystems/models.js';
export type { ModelsOptions } from './subsystems/models.js';

// Сервисы вьюпорта редактора: picking по видимому изображению (REND-15) и
// служебные наложения подсистемой рендера (REND-16). Игровой клиент ни того, ни
// другого не собирает — наложений в его кадре нет по конструкции.
export { ViewportPicking, createPickProxy, createPickRay } from './picking.js';
export type {
  InstanceProxySource,
  PickHit,
  PickKind,
  PickProxy,
  PickProxySource,
  PickProxyVisitor,
  PickRay,
  ViewportPickingOptions,
  ViewportPoint,
} from './picking.js';
export { OverlaySubsystem } from './subsystems/overlays.js';
export type {
  OverlayAxis,
  OverlayCells,
  OverlayColors,
  OverlayGizmo,
  OverlayGrid,
  OverlayHandle,
  OverlayHandleForm,
  OverlayHighlight,
  OverlayItem,
  OverlayOptions,
} from './subsystems/overlays.js';

// Построение инстансов из нормализованных данных ассета (THREE-половина mdxModel).
export {
  buildBones,
  buildClips,
  buildSharedModel,
  createModelInstance,
  modelBounds,
} from './model/build.js';
export type {
  InstanceOptions,
  ModelBounds,
  ModelInstance,
  SharedMeshData,
  SharedModelData,
  SkeletonBuild,
} from './model/build.js';

// Анимационный контроллер (REND-4).
export { AnimationController, resolveClip } from './model/animation.js';
export type {
  AnimationControllerOptions,
  AnimationMapping,
  ClipResolution,
} from './model/animation.js';

// Bone-контроль (REND-5).
export {
  BoneControlState,
  clampYaw,
  smoothYaw,
  stepYaw,
  wrapAngle,
} from './model/boneControl.js';
export type { BoneControlDef, BoneLookup } from './model/boneControl.js';

// Скины (REND-6).
export { applySkin, skinTextureSources, textureFromImage } from './model/skins.js';
export type { SkinApplication, SkinTextureSource } from './model/skins.js';

// Типы контракта ассетов, которыми оперирует публичный API рендера.
export type {
  AssetKind,
  AssetLoader,
  AssetService,
  AssetSource,
  AssetState,
  BoneTrack,
  ChannelKeys,
  DecodedImage,
  EntityVisual,
  Handle,
  Interpolation,
  NormalizedBone,
  NormalizedMaterial,
  NormalizedMesh,
  NormalizedModel,
  NormalizedSequence,
  PartVisibilityTrack,
  TextureSlotRef,
  VisualManifest,
} from '@game-mvp/assets';
