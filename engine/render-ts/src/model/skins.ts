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
} from '@game-mvp/assets';
import type { TextureTarget } from './build.js';

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
  const texture = new THREE.DataTexture(pixels, image.width, image.height, THREE.RGBAFormat);
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

/** Живое применение скина: держит подписки на текстуры до `dispose`. */
export interface SkinApplication {
  dispose(): void;
}

/** Постановка текстуры в нужную карту материала. */
function assignTexture(target: TextureTarget, texture: THREE.Texture): void {
  const { material, map } = target;
  if (map === 'normal') {
    material.normalMap?.dispose();
    material.normalMap = texture;
  } else if (map === 'emissive') {
    material.emissiveMap?.dispose();
    material.emissiveMap = texture;
  } else {
    material.map?.dispose();
    material.map = texture;
  }
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
): SkinApplication {
  const unsubscribes: (() => void)[] = [];
  let disposed = false;

  for (const [slot, source] of sources) {
    const targets = textureTargets.get(slot);
    if (targets === undefined || targets.length === 0) continue; // слот никем не используется

    // Своя THREE-текстура на каждое употребление слота: разделяемое здесь —
    // пиксели ассета, а GPU-объект пер-инстансный (REND-3).
    if (source.kind === 'image') {
      for (const target of targets) {
        assignTexture(target, textureFromImage(source.image, target.map));
      }
      continue;
    }

    const handle = assets.request<DecodedImage>('texture', source.path);
    const applyState = (state: AssetState<DecodedImage>): void => {
      if (disposed || state.status !== 'ready') return;
      for (const target of targets) assignTexture(target, textureFromImage(state.data, target.map));
    };
    // subscribe сам зовёт колбэк с текущим состоянием — отдельный вызов
    // applyState здесь означал бы повторную загрузку уже готовой текстуры.
    unsubscribes.push(assets.subscribe(handle, applyState));
  }

  return {
    dispose(): void {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
