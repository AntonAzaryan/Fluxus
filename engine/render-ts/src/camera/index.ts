/**
 * Публичная поверхность камеры (capability `camera`) — свой барьер рядом с её
 * модулями, как у миникарты в `hud-ts`: корневой барьер пакета называет её
 * одной строкой, а состав живёт там же, где код.
 */
export { CameraRig, DEFAULT_CAMERA_CONFIG } from './rig.js';
export type {
  CameraBounds,
  CameraConfig,
  CameraFraming,
  CameraMode,
  CameraPose,
  CameraRigOptions,
  CameraSources,
  FollowTarget,
} from './rig.js';
// Сэмпл ввода камеры и edge-pan — вход рига, заполняемый обвязкой окна (CAM-1).
export {
  createCameraInput,
  createEdgePanAxes,
  edgePanAxes,
  resetCameraInput,
} from './input.js';
export type { CameraInput, EdgePanAxes } from './input.js';
// Источник поверхности и границ камеры над сеткой террейна (CAM-2, CAM-7).
export { terrainGroundApi } from './terrainSource.js';
export type { TerrainCameraSource } from './terrainSource.js';
export {
  EffectStack,
  SwayEffect,
  TraumaShake,
  defaults,
  valueNoise,
  DEFAULT_SHAKE,
  DEFAULT_SWAY,
  SHAKE_TYPE,
  SWAY_TYPE,
} from './effects.js';
export type {
  CameraEffect,
  CameraEffectType,
  ImpulseEffect,
  ImpulseEffectType,
  LastingEffect,
  LastingEffectType,
  PoseOffset,
  ShakeParams,
  SwayParams,
} from './effects.js';
// Машинное описание типов эффектов (CAM-9) — единственный перечень типов:
// по нему строит эффекты слой, проверяет секцию валидация манифеста (ASSET-8)
// и рисует таблицы редактор (ED-14).
export { CAMERA_EFFECTS_DESCRIPTION, CAMERA_EFFECT_TYPES } from './effectTypes.js';
// Наблюдение за сущностью и кинематографический путь (CAM-10): субъект — вход
// конвейера, путь — его режим; описание ключа и сглаживаний читают валидация
// манифеста (ASSET-17) и редактор.
export { SpectatorSubjects } from './spectate.js';
export type {
  SpectatorEntityView,
  SpectatorSubject,
  SpectatorSubjectsOptions,
} from './spectate.js';
export {
  CAMERA_PATH_DESCRIPTION,
  CAMERA_PATH_EASINGS,
  DEFAULT_CAMERA_PATH_EASING,
  easeParameter,
} from './pathTypes.js';
export { CAMERA_PATH_CHANNELS, CameraPath, CameraPathPlayer } from './path.js';
export type { CameraPathDefaults, CameraPathPose } from './path.js';
// Машинный адрес конфига камеры (CAM-1): перечень параметров для валидации
// секции манифеста (ASSET-10) и сборка частичного конфига из неё.
export {
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_CONFIG_PARAMS,
  cameraConfigFromManifest,
} from './config.js';
export type { CameraConfigFromManifestOptions } from './config.js';
export type { CameraEffectsCatalog } from './effectTypes.js';
export { CameraEffectsDirector } from './director.js';
export type { CameraEffectsDirectorOptions } from './director.js';
export { applyCameraPose } from './apply.js';
