// Контракты пакета: подсистемы, presentation-состояние, конфиг хоста.
export { DEFAULT_CURVATURE_TESSELLATION } from './types.js';
export type {
  // носители контактных пятен режима `blob` (REND-30): порт подсистемы
  // освещения, которым владелец инстансов объявляет динамику
  BlobCaster,
  BlobCasterPose,
  BlobCasterSink,
  EntityView,
  // носители локального света инстансов (REND-33): порт подсистемы освещения и
  // пара портов, которой владелец инстансов её видит
  LightCarrier,
  LightCarrierPose,
  LightCarrierSink,
  LightingSink,
  LocalAimPoint,
  LocalInputSample,
  // пост-обработка кадра (REND-34): рендерер глазами полноэкранного прохода и
  // порт, которым её выход видит маскирующий проход тумана (FOW-7)
  PostRendererLike,
  RenderConfig,
  RenderContext,
  RenderEvent,
  RenderHostConfig,
  RenderSubsystem,
  ScenePostFrame,
  ScenePostSource,
  ShadowCasterSink,
  ShadowCasterTier,
  ShadowPhase,
  TickView,
} from './types.js';

// Пресеты качества (`render-quality` QUAL-1..3): контракт объявления ручек
// подсистемой (расширение REND-8), реестр, собираемый из деклараций, и
// контроллер, раздающий значения документа пресета. Имён пресетов пакет не
// знает — их приносит приложение игры.
export { QualityController, validateQualityPreset } from './quality.js';
export type {
  QualityDeclaration,
  QualityKnob,
  QualityKnobSemantics,
  QualityPreset,
  QualityValue,
  QualityValues,
} from './types.js';

// Отладочный режим рендера (`render-debug` RDBG-1..8): реестр источников рядом
// со списком подсистем (REND-27), закрытый словарь примитивов рисования и
// машинно-читаемый дамп кадра. Выключен по умолчанию и выключенным не стоит
// ничего; в счётчики стоимости не входит вовсе (RDBG-8).
export { RenderDebugLayer } from './debug/layer.js';
export type { DebugSourceInfo, RenderDebugLayerOptions } from './debug/layer.js';
export { DEBUG_DUMP_VERSION } from './debug/dump.js';
export type { DebugDump } from './debug/dump.js';
export { DebugRows } from './debug/contract.js';
export type {
  DebugColor,
  DebugDraw,
  DebugFrameState,
  DebugList,
  DebugPose,
  DebugProbe,
  DebugRaster,
  DebugSource,
  DebugWorldMode,
} from './debug/contract.js';
// Источники движка, которыми не владеет подсистема: их регистрирует сборка.
export {
  costCountersDebugSource,
  deliveryDebugSource,
  programsDebugSource,
} from './debug/sources.js';
export type {
  DebugCostProbe,
  DebugDeliveryProbe,
  DebugDeliveryRow,
  DebugProgramsProbe,
  DebugSnapReason,
  DeliverySourceOptions,
  ProgramCountRenderer,
} from './debug/sources.js';
export type { DebugFogProbe } from './debug/fogSource.js';
export type { DebugCellRow, DebugTerrainProbe } from './debug/terrainSource.js';
export type { DebugInstanceRow, DebugModelsProbe } from './debug/modelsSource.js';
export type { DebugAbilityPreviewProbe, DebugPreviewState } from './debug/abilityPreviewSource.js';
export type { DebugLightingProbe, DebugLightingState } from './debug/lightingSource.js';

// Счётчики стоимости рендера (`performance-budget` PERF-3): инжектируемый сток
// объёма работы, тегированный стадией конвейера (PERF-2). Без подключённого
// стока учёт не исполняется — обычный матч за бенчмарк не платит.
export {
  COST_COUNTER_STAGES,
  attachCostSink,
  costSink,
  createCostCounters,
  releaseCostSink,
  withCostSink,
} from './cost.js';
export type { CostStage, RenderCostCounters } from './cost.js';

// Хост — TickObserver ядра (REND-1, REND-2) и продюсер presentation-состояния.
export { RenderHost, kindByTags } from './host.js';
export { FloorMirror } from './floorMirror.js';

// Сцена подсистем (REND-8) — общая часть продюсеров presentation-состояния, и
// документный источник инстансов как второй продюсер (REND-11).
export { PresentationStage } from './stage.js';
export type { PresentationProducer } from './stage.js';
export { DocumentSource } from './documentSource.js';
export type { DocumentInstance, DocumentSourceOptions } from './documentSource.js';

// Набор decoration-инстансов (REND-18) — третий набор рядом с продюсерами:
// сосуществует с любым из них и сменой режима не гасится.
export { DecorationSet, decorationInstanceOf } from './decorations.js';
export type { DecorationInstance } from './decorations.js';

// Половины хоста по границе потоков (client-shell SHELL-2): Extractor —
// воркер-сторона (единственный читатель мира), ViewBuffer — main-сторона.
export { Extractor, CHANNEL_COLUMNS, ENTITY_MOVING, ENTITY_LEVEL_OVERRIDE } from './extractor.js';
export type { ExtractedTick, ExtractorConfig } from './extractor.js';
// Перевод нагрузки события на входной границе (REND-1). Наружу уходит потому,
// что производителей событий у рендера два, и второй — сетевая оболочка
// (SHELL-4): факты с провода входят в рендер мимо `Extractor`, и перевод у них
// обязан быть тем же самым, а не вторым таким же.
export { renderEventData } from './eventData.js';
// Объявляемые сборкой источники величин: фаза полёта (REND-12) и статы (HUD-8).
export { MAX_STATS } from './statSources.js';
export type { FlightPhaseSource, StatSource } from './statSources.js';
export { ViewBuffer } from './viewBuffer.js';
export type { FrameTiming, ViewBufferConfig } from './viewBuffer.js';

// Камера (camera CAM-1..8): rig режимов и вход кадрирования, слой эффектов,
// диспетчер по манифесту, общее применение позы к THREE-камере.
export { CameraRig, DEFAULT_CAMERA_CONFIG } from './camera/rig.js';
export type {
  CameraBounds,
  CameraConfig,
  CameraFraming,
  CameraMode,
  CameraPose,
  CameraRigOptions,
  CameraSources,
  FollowTarget,
} from './camera/rig.js';
// Сэмпл ввода камеры и edge-pan — вход рига, заполняемый обвязкой окна (CAM-1).
export { createCameraInput, resetCameraInput, edgePanAxes } from './camera/input.js';
export type { CameraInput } from './camera/input.js';
// Источник поверхности и границ камеры над сеткой террейна (CAM-2, CAM-7).
export { terrainGroundApi } from './camera/terrainSource.js';
export type { TerrainCameraSource } from './camera/terrainSource.js';
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
} from './camera/effects.js';
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
} from './camera/effects.js';
// Машинное описание типов эффектов (CAM-9) — единственный перечень типов:
// по нему строит эффекты слой, проверяет секцию валидация манифеста (ASSET-8)
// и рисует таблицы редактор (ED-14).
export { CAMERA_EFFECTS_DESCRIPTION, CAMERA_EFFECT_TYPES } from './camera/effectTypes.js';
// Машинный адрес конфига камеры (CAM-1): перечень параметров для валидации
// секции манифеста (ASSET-10) и сборка частичного конфига из неё.
export {
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_CONFIG_PARAMS,
  cameraConfigFromManifest,
} from './camera/config.js';
export type { CameraConfigFromManifestOptions } from './camera/config.js';
export type { CameraEffectsCatalog } from './camera/effectTypes.js';
export { CameraEffectsDirector } from './camera/director.js';
export type { CameraEffectsDirectorOptions } from './camera/director.js';
export { applyCameraPose } from './camera/apply.js';

// Визуальная поверхность террейна (REND-9, REND-10): хелпер, общий для
// подсистем террейна и моделей, и его источник с загрузкой карты кривизны.
export { cornerLevels, createVisualSurface } from './visualSurface.js';
export type { MutableVisualSurface, SurfaceNormal, VisualSurface } from './visualSurface.js';
export { VisualSurfaceSource } from './surfaceSource.js';
export type { SurfaceChangeListener, VisualSurfaceSourceOptions } from './surfaceSource.js';
export { tiltTarget, smoothTilt, orientFromTiltYaw } from './model/surfaceAlign.js';
export type { TiltVector } from './model/surfaceAlign.js';
// Walkable-вклад поля высот (REND-9): реестр walkable-инстансов у источника
// поверхности; кормит его подсистема моделей данными записи (REND-18).
export { WalkableSurfaceRegistry } from './walkableSurface.js';
export type { TerrainFormSampler, WalkableField, WalkablePlacement } from './walkableSurface.js';

// Вертикальное смещение инстанса: дуга прыжка и снижение при провале (REND-12).
export { jumpArc, jumpBase, maneuverEnds, advanceFall } from './model/verticalOffset.js';
export type { ManeuverEnds } from './model/verticalOffset.js';

// Подсистема террейна (REND-7, REND-9) и её чистые генераторы геометрии.
export { TerrainSubsystem } from './subsystems/terrain.js';
export type { TerrainOptions } from './subsystems/terrain.js';
export {
  buildFloorGeometry,
  buildWallGeometry,
  toBufferGeometry,
} from './subsystems/terrainGeometry.js';
export { buildSkirtGeometry, SKIRT_BOTTOMLESS_Z } from './subsystems/terrainSkirt.js';
export type { CellRect, TerrainGeometryData } from './subsystems/terrainGeometry.js';

// Подсистема моделей (REND-3..6) и переподача манифеста визуалов (REND-17).
// Наружу инстанс виден преобразованием и границами, а не узлом сцены (REND-3).
export { ANIMATION_STATES, ModelsSubsystem } from './subsystems/models.js';
export type {
  InstancePose,
  ModelInstanceView,
  ModelsOptions,
  ModelsPrewarm,
} from './subsystems/models.js';

// Подсистема тумана войны (FOW-7, FOW-9, FOW-10): маска видимости команды
// игрока, конфигурация картинки данными и полноэкранный пост-проход затемнения.
export { FogSubsystem } from './subsystems/fog.js';
export { DEFAULT_FOG_CONFIG, resolveFogConfig } from './fog/config.js';
export type { FogRenderConfig } from './fog/config.js';
export type { FogRendererLike, FogStatNames, FogSubsystemOptions } from './fog/contract.js';
export type { FogLayerCanvas, FogLayerContext, FogMinimapLayer } from './fog/layer.js';
export { VisibilityMask, edgeGradient, fogRectOf, fogSegmentsOf } from './fog/mask.js';
export type { FogObserver, FogSmoothPass, FogWorldRect } from './fog/mask.js';
// Полярный depth-буфер теней укрытий (design D3): наружу отданы только отрезок
// укрытия и его тест по высоте — то, из чего маску строит вызывающий. Бины,
// растеризация дуг и свёртка остаются внутренностями пакета.
export { segmentCasts } from './fog/shadowDepth.js';
export type { FogSegment } from './fog/shadowDepth.js';
// Грязное окно рассеивания (design D5): наружу отдан только сам набор блоков —
// он входит в контракт `VisibilityMask.commit`. Сторона блока и проход
// схождения остаются внутренностями пакета.
export { FogDirtyBlocks } from './fog/dirty.js';

// Подсистема пост-обработки кадра (REND-34): bloom и tone mapping собственными
// полноэкранными проходами, конфигурация — секцией `postprocess` парного
// документа (PRES-2). При умолчаниях кадр байт-в-байт прежний: ни целей, ни
// проходов. Порт `ScenePostSource` отдаёт её выход маскирующему проходу тумана
// (FOW-7) — сборка передаёт его подсистеме тумана опцией `post`.
export {
  PostprocessSubsystem,
  POSTPROCESS_BLOOM,
  POSTPROCESS_BLOOM_RESOLUTION,
  POSTPROCESS_LUT,
} from './subsystems/postprocess.js';
export type { PostprocessOptions } from './subsystems/postprocess.js';
export { DEFAULT_POSTPROCESS_CONFIG, resolvePostprocessConfig } from './postprocess/config.js';
export type { PostprocessRenderConfig, ToneMappingOperator } from './postprocess/config.js';
export { BLOOM_LEVELS } from './postprocess/passes.js';

// Подсистема воды (REND-35, REND-36): тела воды из секции `water` парного
// документа (PRES-2), глубина — производная единого поля высот (REND-9), рябь —
// чистая производная presentation-состояния. Сцена без секции не платит ничем.
export {
  WaterSubsystem,
  WATER_DEPTH_TEXELS_PER_CELL,
  WATER_DETAIL_LAYERS,
  WATER_RIPPLE_SOURCES,
} from './subsystems/water.js';
export type { WaterOptions } from './subsystems/water.js';
export {
  DEFAULT_WATER_BODY,
  DEFAULT_WATER_DEPTH_TEXELS_PER_CELL,
  DEFAULT_WATER_DETAIL,
  DEFAULT_WATER_RIPPLES,
  linearColorOf,
  resolveWaterConfig,
} from './water/config.js';
export type {
  LinearColor,
  WaterBodyConfig,
  WaterDetailConfig,
  WaterRenderConfig,
  WaterRipplesConfig,
} from './water/config.js';
export { WATER_RENDER_ORDER, WaterBodyView } from './water/body.js';
export type { WaterBodyLimits, WaterBodyOptions } from './water/body.js';
export { greedyRects, waterGeometryOf, waterRegionsOf } from './water/region.js';
export type { WaterGeometryData, WaterRect, WaterRegion } from './water/region.js';
export { depthTexelRect, fillWaterDepth, levelFieldSampler, waterDepthLayout } from './water/depth.js';
export type { WaterDepthLayout, WaterFieldSampler } from './water/depth.js';
export { WaterRippleField } from './water/ripples.js';
export type { WaterRippleOptions, WaterRippleSource } from './water/ripples.js';
export { createWaterMaterial, waterFragmentShader } from './water/material.js';
export type { WaterMaterialInput } from './water/material.js';

// Подсистема освещения сцены (REND-8): источники света арены и теневые карты
// из секции `lighting` парного документа (PRES-2). Свет всех потребителей
// рендера — отсюда: своего они больше не заводят (`editor` ED-22).
export { LightingSubsystem } from './subsystems/lighting.js';
export type { LightingOptions } from './subsystems/lighting.js';
// Локальные источники инстансов (REND-33): пул подсистемы освещения, его ручка
// качества и её умолчание — вход тестов и документов пресетов (QUAL-1).
export {
  DEFAULT_MAX_LOCAL_LIGHTS,
  LIGHTING_MAX_LOCAL_LIGHTS,
  MAX_LOCAL_LIGHTS_LIMIT,
  LocalLightPool,
} from './lighting/localLights.js';
export {
  DEFAULT_CYCLE_TRANSITION_SECONDS,
  DEFAULT_HEMISPHERE,
  DEFAULT_LIGHTING_CONFIG,
  DEFAULT_RIM,
  minShadowMode,
  resolveLightingConfig,
  resolveLightingCycle,
  shadowModeRank,
} from './lighting/config.js';
export type {
  HemisphereConfig,
  LightingCycleConfig,
  LightingPhaseConfig,
  LightingRenderConfig,
  RimConfig,
  ShadowMode,
} from './lighting/config.js';

// Подсистема транзиентных эффектов (REND-23): процедурные примитивы по записям
// манифеста — оболочки от доставленного состояния и вспышки от событий.
export { EffectsSubsystem } from './subsystems/effects.js';
export type { EffectsOptions } from './subsystems/effects.js';

// Подсистема превью каста (REND-28): что заденет способность, если подтвердить
// её сейчас. Два входа и только два — скомпилированный каталог определений при
// инициализации и локальный сэмпл ввода своего игрока (REND-1); подтверждённые
// шаги приходят обычным доставленным состоянием.
export { AbilityPreviewSubsystem } from './subsystems/abilityPreview.js';
export type {
  AbilityPreviewColors,
  AbilityPreviewOptions,
} from './subsystems/abilityPreview.js';
// Имена статов слотов способностей — ВХОД подсистемы, объявляемый сборкой
// (HUD-8, ABIL-1), а не её устройство.
export type { AbilitySlotStatNames, AbilityStepStatNames } from './subsystems/abilitySlots.js';

// Подсистема частиц (REND-24): эмиттеры по записям манифеста поверх эмиттерных
// ассетов (ASSET-14) — оболочки от доставленного состояния, one-shot'ы от
// событий и decoration-эмиттеры, все в одном батч-рендерере сцены.
export { ParticlesSubsystem } from './subsystems/particles.js';
export type { ParticlesOptions, SocketSource } from './subsystems/particles.js';

// Сервисы вьюпорта редактора: picking по видимому изображению (REND-15) и
// служебные наложения подсистемой рендера (REND-16). Игровой клиент ни того, ни
// другого не собирает — наложений в его кадре нет по конструкции.
export { ViewportPicking, createPickProxy } from './picking.js';
export type {
  InstanceProxySource,
  PickProxy,
  PickProxySource,
  PickProxyVisitor,
  ViewportPickingOptions,
} from './picking.js';
// Контракты наведения: их разделяют сервис и марш по полю высот (REND-15).
export { createPickRay } from './pickContracts.js';
export type { PickHit, PickKind, PickRay, ViewportPoint } from './pickContracts.js';
export { OverlaySubsystem } from './subsystems/overlays.js';
// Словарь наложений — вход подсистемы, составляемый инструментом редактора.
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
} from './subsystems/overlayItems.js';

// Построение инстансов из нормализованных данных ассета (THREE-половина mdxModel).
export {
  buildBones,
  buildClips,
  buildSharedModel,
  createModelInstance,
  geometryFromMesh,
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

// Анимационный контроллер (REND-4): одна машина состояний, два носителя
// воспроизведения — микшер детального яруса и скаляры батчевого (REND-20).
export { AnimationController, MixerAnimationBackend, resolveClip } from './model/animation.js';
export type {
  AnimationBackend,
  AnimationControllerOptions,
  AnimationMapping,
  ClipResolution,
  NamedClip,
} from './model/animation.js';
export { VatAnimationBackend } from './model/vatAnimation.js';

// Батчевый ярус (REND-20): батч инстансов, VAT-материал и набор вариантов скина.
export { ModelBatch, batchLevels } from './model/batch.js';
export type { BatchPartSource, ModelBatchOptions } from './model/batch.js';
export {
  VAT_MAP_KINDS,
  createSkinPlaceholder,
  createVatMaterial,
  createVatTexture,
  materialMapKinds,
} from './model/vatMaterial.js';
export type { VatMapKind, VatMaterial, VatMaterialUniforms } from './model/vatMaterial.js';
export {
  BASE_SKIN_VARIANT,
  BatchSkinLoader,
  skinArrayTexture,
  skinVariantNames,
  variantSources,
} from './model/batchSkins.js';

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
} from '@fluxus/assets';
