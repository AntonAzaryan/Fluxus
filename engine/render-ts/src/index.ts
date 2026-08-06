// Контракты пакета: подсистемы, presentation-состояние, конфиг хоста.
export type {
  EntityView,
  RenderConfig,
  RenderContext,
  RenderEvent,
  RenderHostConfig,
  RenderSubsystem,
  TickView,
} from './types.js';

// Хост — TickObserver ядра (REND-1, REND-2) и реестр подсистем (REND-8).
export { RenderHost, kindByTags } from './host.js';
export { FloorMirror } from './floorMirror.js';

// Половины хоста по границе потоков (client-shell SHELL-2): Extractor —
// воркер-сторона (единственный читатель мира), ViewBuffer — main-сторона.
export { Extractor, ENTITY_MOVING, ENTITY_LEVEL_OVERRIDE } from './extractor.js';
export type { ExtractedTick, ExtractorConfig } from './extractor.js';
export { ViewBuffer } from './viewBuffer.js';
export type { FrameTiming, ViewBufferConfig } from './viewBuffer.js';

// Камера (camera CAM-1..7): rig режимов, слой эффектов, диспетчер по манифесту,
// общее применение позы к THREE-камере.
export {
  CameraRig,
  DEFAULT_CAMERA_CONFIG,
  createCameraInput,
  resetCameraInput,
  edgePanAxes,
  heroMoveFromKeys,
  terrainGroundApi,
} from './camera/rig.js';
export type {
  CameraBounds,
  CameraConfig,
  CameraInput,
  CameraMode,
  CameraPose,
  CameraRigOptions,
  FollowTarget,
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
export type { SurfaceNormal, VisualSurface } from './visualSurface.js';
export { VisualSurfaceSource } from './surfaceSource.js';
export type { VisualSurfaceSourceOptions } from './surfaceSource.js';
export { tiltTarget, smoothTilt } from './model/surfaceAlign.js';
export type { TiltVector } from './model/surfaceAlign.js';

// Подсистема террейна (REND-7, REND-9) и её чистые генераторы геометрии.
export {
  TerrainSubsystem,
  buildFloorGeometry,
  buildWallGeometry,
  toBufferGeometry,
} from './subsystems/terrain.js';
export type { TerrainGeometryData, TerrainOptions } from './subsystems/terrain.js';

// Подсистема моделей (REND-3..6).
export { ModelsSubsystem } from './subsystems/models.js';
export type { ModelsOptions } from './subsystems/models.js';

// Построение инстансов из нормализованных данных ассета (THREE-половина mdxModel).
export {
  buildBones,
  buildClips,
  buildSharedModel,
  createModelInstance,
} from './model/build.js';
export type {
  InstanceOptions,
  ModelInstance,
  SharedMeshData,
  SharedModelData,
  SkeletonBuild,
} from './model/build.js';

// Анимационный контроллер (REND-4).
export { AnimationController, resolveClip } from './model/animation.js';
export type { AnimationControllerOptions, AnimationMapping } from './model/animation.js';

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
export { applySkin, skinTexturePaths, textureFromImage } from './model/skins.js';
export type { SkinApplication } from './model/skins.js';

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
