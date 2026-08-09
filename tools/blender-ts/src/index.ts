/**
 * Публичная поверхность пакета `@game-mvp/blender-ts` — импортёра конвейера
 * «Blender → движок» (capability `blender-pipeline`).
 *
 * Пакет — инструмент времени авторинга (BLND-7): рантайм движка, клиента и
 * сервера его MUST NOT звать, а Blender не является его зависимостью — ни
 * рантаймной, ни тестовой. Тесты идут от закоммиченных фикстур экспорта.
 *
 * Здесь разбор экспорта, генерация целевого пространственного слоя, операция
 * импорта и правило синхронизации. Своей записи документов у пакета нет и не
 * будет: пишет зарегистрированная операция авторинга поверхностью сессии
 * editor-core, а на диск её результат уходит каноническим сохранением (BLND-5,
 * ED-29, ED-21) — второй реализации сериализации, валидации и правил порядка у
 * импортёра не появляется.
 *
 * Зависимость направлена в одну сторону: этот пакет знает про editor-core, а
 * editor-core и пакеты движка про него — нет (BLND-7). Операция и правило —
 * вклады (ED-25): их регистрирует тот, кто собирает инструмент или редактор, —
 * командная строка (`cli.ts`) и сборка редактора (`editor/ui-ts/app/assembly.ts`).
 * Второй импорт цикла не заводит и Blender зависимостью редактора не делает:
 * пакет на TypeScript и Blender не вызывает, а BLND-5 и BLND-2 прямо требуют,
 * чтобы работающий редактор исполнял ту же операцию и подсвечивал расхождение
 * тем же правилом.
 *
 * Конвенции экспорта, осей и custom properties — `CONVENTIONS.md` рядом.
 */
export {
  GltfParseError,
  isGlb,
  meshPositions,
  nodesOf,
  parseGlb,
  parseGltf,
  parseGltfJson,
  readAccessor,
  readMeshGeometry,
  rootNodesOf,
} from './gltf.js';
export type {
  GltfAccessor,
  GltfBuffer,
  GltfBufferView,
  GltfDocument,
  GltfJson,
  GltfJsonValue,
  GltfMesh,
  GltfNode,
  GltfPrimitive,
  GltfScene,
  MeshGeometry,
} from './gltf.js';

export {
  SEMANTIC_KEYS,
  SKIN_KEY,
  coerceExtra,
  decompose,
  localMatrixOf,
  multiplyMatrices,
  normalizeDocument,
  worldPoint,
} from './normalize.js';
export type { SemanticKind, SourceObject, WorldPoint } from './normalize.js';

export {
  DEFAULT_POSITION_BINDING,
  compareObjectNames,
  generateSpatialLayer,
  hasErrors,
  quantizedFixed,
} from './layer.js';
export type {
  CellLayerContext,
  CurvatureMap,
  Finding,
  FindingSeverity,
  PositionBinding,
  RotationBinding,
  SpatialLayer,
  SpatialLayerContext,
  TargetTerrain,
  TerrainMaps,
} from './layer.js';

export {
  HEIGHT_EPSILON,
  NOFLOOR_CHANNEL,
  RAMP_CHANNEL,
  readCellGrid,
} from './cells.js';
export type { CellGrid, CellGridRead, CellGridSpec } from './cells.js';

export {
  LEVEL_UNIT,
  MAX_CURVATURE_OFFSET,
  MIN_CURVATURE_OFFSET,
  generateCellLayer,
  withCellLayer,
} from './maps.js';
export type { CellLayer } from './maps.js';

export {
  SCENE_SUFFIX,
  SOURCE_EXTENSION,
  SOURCE_EXTENSIONS,
  baseNameOf,
  isSourcePath,
  scenePathOf,
  sourcePathOf,
} from './pairing.js';

export {
  DEFAULT_DECORATIONS_PATH,
  DEFAULT_INITIAL_PATH,
  DEFAULT_TERRAIN_PATH,
  IMPORT_SPATIAL_LAYER,
  importParams,
  importSpatialLayerOperation,
  registerBlenderOperations,
  spatialLayerParam,
} from './operation.js';
export type { SlotChange } from './operation.js';

export {
  DEFAULT_IMPORT_KINDS,
  DEFAULT_MANIFEST_PATH,
  contextOf,
  contextOfValues,
  openImportTarget,
  terrainOfValue,
  visualsOf,
} from './project.js';
export type { ImportKinds, ImportSlots, ImportTarget, OpenImportTargetInput } from './project.js';

export { createImportSession, runImport } from './importer.js';
export type { ImportRequest, ImportResult } from './importer.js';

export {
  DEFAULT_SYNC_KINDS,
  SPATIAL_LAYER_SYNC_RULE,
  createSourceCache,
  spatialLayerSyncRule,
} from './rule.js';
export type {
  SourceCacheOptions,
  SourceState,
  SpatialLayerSourceCache,
  SpatialLayerSources,
  SpatialLayerSyncOptions,
  SyncKinds,
} from './rule.js';

export { BLENDER_BUNDLES } from './i18n.js';

/*
 * Хоста среды Node (`nodeHost.ts`) и командной строки (`cli.ts`) в этой
 * поверхности нет намеренно: они тянут `node:fs` и `node:path`, а операция и
 * правило обязаны подниматься и в браузерном редакторе. Их потребитель —
 * `bin/import.mjs` и тесты, и оба берут их прямым путём.
 */
