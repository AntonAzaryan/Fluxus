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
 * Итоговая карта «слот → путь текстуры»: базовые пути модели, поверх —
 * подмены выбранного скина. Ключ подмены в манифесте — номер слота строкой.
 */
export function skinTexturePaths(
  model: NormalizedModel,
  visual: EntityVisual | undefined,
  skin: string | undefined,
): Map<number, string> {
  const paths = new Map<number, string>();
  for (const ref of model.textureSlots) {
    if (ref.path !== null) paths.set(ref.slot, ref.path);
  }
  const overrides = skin === undefined ? undefined : visual?.skins?.[skin];
  if (overrides !== undefined) {
    for (const [slot, path] of Object.entries(overrides)) {
      const index = Number(slot);
      if (Number.isInteger(index)) paths.set(index, path);
    }
  }
  return paths;
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
 * Применяет набор «слот → путь» к материалам инстанса. Каждая текстура
 * запрашивается через AssetService и ставится по факту `ready` (ASSET-4: рендер
 * обязан жить с `loading` неограниченной длительности).
 */
export function applySkin(
  textureTargets: ReadonlyMap<number, readonly TextureTarget[]>,
  paths: ReadonlyMap<number, string>,
  assets: AssetService,
): SkinApplication {
  const unsubscribes: (() => void)[] = [];
  let disposed = false;

  for (const [slot, path] of paths) {
    const targets = textureTargets.get(slot);
    if (targets === undefined || targets.length === 0) continue; // слот никем не используется

    const handle = assets.request<DecodedImage>('texture', path);
    const applyState = (state: AssetState<DecodedImage>): void => {
      if (disposed || state.status !== 'ready') return;
      // Своя THREE-текстура на каждое употребление слота: разделяемое здесь —
      // пиксели ассета, а GPU-объект пер-инстансный (REND-3).
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
