/**
 * Скины инстанса (REND-6): именованный набор подмен «слот текстуры → путь»
 * из манифеста визуалов (ASSET-6), применяемый к материалам ИНСТАНСА.
 * Разделяемые данные модели и материалы других инстансов не затрагиваются;
 * смена скина — повторное применение без перезагрузки модели.
 *
 * Текстура приезжает из AssetService уже декодированной (ASSET-5), поэтому
 * здесь остаётся только загрузка пикселей в GPU-текстуру. Раньше на этом месте
 * стояла ветка `createImageBitmap`, которой в Node нет, — и весь путь скинов
 * в headless-тестах просто не исполнялся.
 *
 * Слот модели несёт источник одного из двух видов (ASSET-5, `TextureSlotRef`):
 * путь к файлу дерева контента — тогда пиксели запрашиваются ассетом, — либо
 * встроенное декодированное изображение, приехавшее внутри файла модели: его
 * запрашивать не у кого, декодировано оно уже загрузчиком, и GPU-текстура
 * строится прямо из него. Скин манифеста остаётся ПУТЁВЫМ (ASSET-6) и
 * подменяет источник слота ЦЕЛИКОМ, одинаково поверх обоих видов: он не
 * «дописывает путь» к существующему источнику, а заменяет его.
 */
import * as THREE from 'three';
import type {
  AssetService,
  AssetState,
  DecodedImage,
  EntityVisual,
  NormalizedModel,
} from '@fluxus/assets';
import type { TextureTarget } from './build.js';
import { own } from '../footprint.js';

/**
 * Откуда инстанс берёт пиксели слота: файл дерева контента (запрашивается через
 * AssetService) либо готовое изображение, приехавшее внутри файла модели.
 * Размеченное объединение, а не «путь плюс необязательные пиксели», по той же
 * причине, что и в `TextureSlotRef`: состояния «заданы оба» не бывает.
 */
export type SkinTextureSource =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'image'; readonly image: DecodedImage };

/**
 * Итоговая карта «слот → источник текстуры»: базовые источники модели, поверх —
 * подмены выбранного скина. Ключ подмены в манифесте — номер слота строкой,
 * значение — путь: скин по контракту путевой (ASSET-6), поэтому он всегда даёт
 * источник вида `path`, чем бы слот ни был занят до него.
 *
 * Слот без источника (`source: 'none'` — replaceable-слот WC3, недекодируемое
 * встроенное изображение) в карту не попадает: запрашивать нечего, карта
 * материала остаётся пустой. Номер за ним всё равно закреплён, и скин может
 * его занять.
 */
export function skinTextureSources(
  model: NormalizedModel,
  visual: EntityVisual | undefined,
  skin: string | undefined,
): Map<number, SkinTextureSource> {
  const sources = new Map<number, SkinTextureSource>();
  for (const ref of model.textureSlots) {
    if (ref.source === 'file') sources.set(ref.slot, { kind: 'path', path: ref.path });
    else if (ref.source === 'embedded') sources.set(ref.slot, { kind: 'image', image: ref.image });
  }
  const overrides = skin === undefined ? undefined : visual?.skins?.[skin];
  if (overrides !== undefined) {
    for (const [slot, path] of Object.entries(overrides)) {
      const index = Number(slot);
      if (Number.isInteger(index)) sources.set(index, { kind: 'path', path });
    }
  }
  return sources;
}

/** THREE-текстура из декодированных пикселей ассета. Работает и в Node. */
export function textureFromImage(image: DecodedImage, map: TextureTarget['map']): THREE.Texture {
  // Пиксели ассета отдаются как есть: DataTexture их не копирует, а типовое
  // сужение до Uint8Array<ArrayBuffer> — формальность (SharedArrayBuffer здесь
  // взяться неоткуда, буфер приходит из декодера).
  const pixels = image.pixels as Uint8Array<ArrayBuffer>;
  const texture = own(
    'texture',
    'model',
    new THREE.DataTexture(pixels, image.width, image.height, THREE.RGBAFormat),
  );
  // Цветовые карты хранятся в sRGB, карты нормалей — линейные данные, а не цвет.
  texture.colorSpace = map === 'normal' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  // Пиксели идут сверху вниз, v=0 — верх изображения. Это совпадает с UV и MDX,
  // и glTF (обе системы с началом в левом верхнем углу), поэтому переворот не
  // нужен — так же поступает и GLTFLoader в THREE. Для DataTexture это ещё и
  // единственный вариант: UNPACK_FLIP_Y_WEBGL не действует на сырые массивы,
  // переворот пришлось бы делать копией буфера, теряя часть смысла разделения.
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/** Живое применение скина: держит подписки и взятые им текстуры до `dispose`. */
export interface SkinApplication {
  dispose(): void;
}

/**
 * Кэш GPU-текстур скинов ОДНОГО ассета (REND-3, REND-6) с учётом ссылок.
 *
 * Пиксели приезжают из модуля ассетов уже разделяемыми (ASSET-2, ASSET-5): у
 * десяти инстансов одного вида это ОДИН объект `DecodedImage`. GPU-текстура же
 * до сих пор строилась на каждое употребление слота каждого инстанса — те же
 * пиксели заливались в видеопамять по разу на инстанс, и десять юнитов в кадре
 * стоили десяти копий одной картинки. Кэш ключуется парой «пиксели ×
 * цветовое пространство»: пространство в ключе потому, что карта нормалей
 * линейна, а базовый цвет и эмиссия — sRGB (`textureFromImage`), и одну
 * текстуру им делить нельзя.
 *
 * Учёт ссылок, а не «живёт вечно»: скин инстанса сменяется (REND-6), запись
 * манифеста переподаётся (REND-17), и текстура, которую больше не держит ни
 * одно применение, обязана уйти — иначе кэш стал бы утечкой на длинной сессии
 * правки. Кэш принадлежит разделяемой записи ассета и отдаётся вместе с ней.
 */
export interface SkinTextureCache {
  /** Текстура пикселей под нужное цветовое пространство; ссылка занята. */
  acquire(image: DecodedImage, map: TextureTarget['map']): THREE.Texture;
  /** Ссылка отпущена; последняя освобождает текстуру. Чужая текстура — no-op. */
  release(texture: THREE.Texture): void;
  /** Отдать всё, что кэш ещё держит (REND-31): зовётся со сносом ассета. */
  dispose(): void;
}

/** Одна кэшированная текстура и число живых ссылок на неё. */
interface CachedSkinTexture {
  readonly texture: THREE.Texture;
  readonly image: DecodedImage;
  readonly linear: boolean;
  refs: number;
}

/** Обе текстуры одних пикселей: у цветовой и линейной свои (см. `SkinTextureCache`). */
interface CachedSkinPair {
  srgb: CachedSkinTexture | null;
  linear: CachedSkinTexture | null;
}

export function createSkinTextureCache(): SkinTextureCache {
  const byImage = new Map<DecodedImage, CachedSkinPair>();
  // Обратная адресация для `release`: применение знает текстуру, а не пиксели,
  // из которых она построена.
  const byTexture = new Map<THREE.Texture, CachedSkinTexture>();

  const forget = (entry: CachedSkinTexture): void => {
    byTexture.delete(entry.texture);
    const pair = byImage.get(entry.image);
    if (pair === undefined) return;
    if (entry.linear) pair.linear = null;
    else pair.srgb = null;
    if (pair.srgb === null && pair.linear === null) byImage.delete(entry.image);
  };

  return {
    acquire(image, map) {
      const linear = map === 'normal';
      let pair = byImage.get(image);
      if (pair === undefined) {
        pair = { srgb: null, linear: null };
        byImage.set(image, pair);
      }
      let entry = linear ? pair.linear : pair.srgb;
      if (entry === null) {
        entry = { texture: textureFromImage(image, map), image, linear, refs: 0 };
        byTexture.set(entry.texture, entry);
        if (linear) pair.linear = entry;
        else pair.srgb = entry;
      }
      entry.refs += 1;
      return entry.texture;
    },
    release(texture) {
      const entry = byTexture.get(texture);
      if (entry === undefined) return;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      forget(entry);
      entry.texture.dispose();
    },
    dispose() {
      for (const texture of byTexture.keys()) texture.dispose();
      byTexture.clear();
      byImage.clear();
    },
  };
}

/**
 * Постановка текстуры в нужную карту материала. Прежнюю текстуру НЕ освобождает:
 * материалы разделяются инстансами до подмены скина (REND-3, REND-6), и карта,
 * поставленная не этим применением, принадлежит не ему — освободить её значило
 * бы погасить текстуру у соседей. Владение односторонее: применение освобождает
 * то, что создало само (см. `applySkin`).
 */
function assignTexture(target: TextureTarget, texture: THREE.Texture): void {
  const { material, map } = target;
  if (map === 'normal') material.normalMap = texture;
  else if (map === 'emissive') material.emissiveMap = texture;
  else material.map = texture;
  material.needsUpdate = true;
}

/**
 * Применяет набор «слот → источник» к материалам инстанса.
 *
 * Источник-путь запрашивается через AssetService и ставится по факту `ready`
 * (ASSET-4: рендер обязан жить с `loading` неограниченной длительности).
 * Источник-изображение ставится сразу: пиксели уже декодированы загрузчиком
 * модели, ассета за ними нет и ждать нечего — путь через AssetService означал
 * бы второй кэш поверх уже разделяемых данных модели.
 */
export function applySkin(
  textureTargets: ReadonlyMap<number, readonly TextureTarget[]>,
  sources: ReadonlyMap<number, SkinTextureSource>,
  assets: AssetService,
  cache?: SkinTextureCache,
): SkinApplication {
  const unsubscribes: (() => void)[] = [];
  // Текстуры, ВЗЯТЫЕ этим применением: только их оно и отпускает. Ключ — место
  // употребления, поэтому повторная постановка (ассет доехал вторым состоянием)
  // отпускает свою же прежнюю, а не чужую. Без кэша ассета взятие — это
  // создание, а возврат — освобождение: применение владеет текстурой в одиночку.
  const created = new Map<TextureTarget, THREE.Texture>();
  const acquire = (image: DecodedImage, map: TextureTarget['map']): THREE.Texture =>
    cache === undefined ? textureFromImage(image, map) : cache.acquire(image, map);
  const release = (texture: THREE.Texture): void => {
    if (cache === undefined) texture.dispose();
    else cache.release(texture);
  };
  let disposed = false;

  const put = (target: TextureTarget, texture: THREE.Texture): void => {
    const previous = created.get(target);
    // Сперва учёт новой ссылки, потом возврат прежней: под кэшем это может быть
    // ОДНА И ТА ЖЕ текстура (ассет доехал повторно теми же пикселями), и
    // обратный порядок отпустил бы её до нуля ссылок и освободил под собой.
    created.set(target, texture);
    if (previous !== undefined) release(previous);
    assignTexture(target, texture);
  };

  for (const [slot, source] of sources) {
    const targets = textureTargets.get(slot);
    if (targets === undefined || targets.length === 0) continue; // слот никем не используется

    // Пиксели ассета разделяются (ASSET-2), GPU-текстура — тоже, пока кэш
    // ассета их держит (REND-3): своя копия на каждое употребление слота
    // заливала бы одну картинку в видеопамять по разу на инстанс (REND-31).
    if (source.kind === 'image') {
      for (const target of targets) put(target, acquire(source.image, target.map));
      continue;
    }

    const handle = assets.request<DecodedImage>('texture', source.path);
    const applyState = (state: AssetState<DecodedImage>): void => {
      if (disposed || state.status !== 'ready') return;
      for (const target of targets) put(target, acquire(state.data, target.map));
    };
    // subscribe сам зовёт колбэк с текущим состоянием — отдельный вызов
    // applyState здесь означал бы повторную загрузку уже готовой текстуры.
    unsubscribes.push(assets.subscribe(handle, applyState));
  }

  return {
    dispose(): void {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const texture of created.values()) release(texture);
      created.clear();
    },
  };
}
