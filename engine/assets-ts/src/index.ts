/**
 * Публичная поверхность пакета `@game-mvp/assets` — рендер-агностичного
 * модуля presentation-ассетов (ASSET-1..6). Контракт согласован с `render-ts`:
 * имена и сигнатуры ниже — API, на который опирается рендер.
 */

// сервис и его контракты (ASSET-2, ASSET-3, ASSET-4)
export type { AssetKind, Handle, AssetState, AssetSource, AssetLoader } from './types.js';
export { AssetService } from './service.js';

// нормализованная модель (ASSET-5)
export type {
  NormalizedModel,
  NormalizedBone,
  NormalizedMesh,
  NormalizedSequence,
  BoneTrack,
  ChannelKeys,
  PartVisibilityTrack,
  TextureSlotRef,
} from './model.js';

// манифест визуалов (ASSET-6)
export type { VisualManifest, EntityVisual } from './manifest.js';
export { validateManifest } from './manifest.js';

// загрузчики реестра (ASSET-3); регистрируются потребителем через registerLoader
export { mdxLoader } from './loaders/mdx.js';
export { pngTextureLoader } from './loaders/png.js';
export type { TextureAsset } from './loaders/png.js';
export { manifestLoader } from './loaders/manifest.js';
