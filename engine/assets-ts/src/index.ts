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
} from './model.js';

// декодированное изображение — вид текстурного ассета (ASSET-5)
export type { DecodedImage } from './image.js';

// манифест визуалов (ASSET-6)
export type { VisualManifest, EntityVisual } from './manifest.js';
export { validateManifest } from './manifest.js';

// загрузчики реестра (ASSET-3); регистрируются потребителем через registerLoader
export { mdxLoader } from './loaders/mdx.js';
export { pngTextureLoader, decodePng } from './loaders/png.js';
export { manifestLoader } from './loaders/manifest.js';
