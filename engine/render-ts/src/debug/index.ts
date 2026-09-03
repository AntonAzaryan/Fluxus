/**
 * Публичная поверхность отладочного режима рендера (`render-debug` RDBG-1..8) —
 * свой барьер рядом с её модулями, как у камеры (`camera/index.ts`): корневой
 * барьер пакета называет её одной строкой, а состав живёт там же, где код.
 *
 * Реестр источников стоит рядом со списком подсистем (REND-27), словарь
 * примитивов рисования закрыт, дамп кадра машинно-читаем. Выключен по умолчанию
 * и выключенным не стоит ничего; в счётчики стоимости не входит вовсе (RDBG-8).
 */
export { RenderDebugLayer } from './layer.js';
export type { DebugSourceInfo, RenderDebugLayerOptions } from './layer.js';
export { DEBUG_DUMP_VERSION } from './dump.js';
export type { DebugDump } from './dump.js';
export { DebugRows } from './contract.js';
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
} from './contract.js';
// Источники движка, которыми не владеет подсистема: их регистрирует сборка.
export {
  costCountersDebugSource,
  deliveryDebugSource,
  memoryDebugSource,
  programsDebugSource,
} from './sources.js';
export type { DebugCostProbe, DebugDeliveryProbe, DebugDeliveryRow, DebugMemoryProbe } from './sources.js';
export type { DebugProgramsProbe, DebugSnapReason, DeliverySourceOptions } from './sources.js';
export type { MemoryInfoRenderer, ProgramCountRenderer } from './sources.js';
// Пробники подсистем: их объявляет владелец источника, а типы читает сборка.
export type { DebugFogProbe } from './fogSource.js';
export type { DebugCellRow, DebugTerrainProbe } from './terrainSource.js';
export type { DebugInstanceRow, DebugModelsProbe } from './modelsSource.js';
export type { DebugAbilityPreviewProbe, DebugPreviewState } from './abilityPreviewSource.js';
export type { DebugLightingProbe, DebugLightingState } from './lightingSource.js';
