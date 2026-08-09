/**
 * Публичная поверхность пакета `@game-mvp/blender-ts` — импортёра конвейера
 * «Blender → движок» (capability `blender-pipeline`).
 *
 * Пакет — инструмент времени авторинга (BLND-7): рантайм движка, клиента и
 * сервера его MUST NOT звать, а Blender не является его зависимостью — ни
 * рантаймной, ни тестовой. Тесты идут от закоммиченных фикстур экспорта.
 *
 * Сегодня здесь разбор экспорта и генерация целевого пространственного слоя в
 * память. Записи документов у пакета нет и не будет: её делает зарегистрированная
 * операция авторинга editor-core с каноническим сохранением (BLND-5, ED-29,
 * ED-21) — второй реализации сериализации, валидации и правил порядка у
 * импортёра не появляется.
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
} from './gltf.js';

export { SEMANTIC_KEYS, SKIN_KEY, coerceExtra, decompose, localMatrixOf, multiplyMatrices, normalizeDocument } from './normalize.js';
export type { SemanticKind, SourceObject } from './normalize.js';

export {
  DEFAULT_POSITION_BINDING,
  compareObjectNames,
  generateSpatialLayer,
  hasErrors,
  quantizedFixed,
} from './layer.js';
export type {
  Finding,
  FindingSeverity,
  PositionBinding,
  RotationBinding,
  SpatialLayer,
  SpatialLayerContext,
} from './layer.js';
