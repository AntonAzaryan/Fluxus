/**
 * Скины инстанса (REND-6): именованный набор подмен «слот текстуры → путь»
 * из манифеста визуалов (ASSET-6), применяемый к материалам ИНСТАНСА.
 * Разделяемые данные модели и материалы других инстансов не затрагиваются;
 * смена скина — повторное применение без перезагрузки модели.
 *
 * Текстуры идут через AssetService (`TextureAsset.bytes` → Blob →
 * createImageBitmap → THREE.Texture); в headless-среде (Node-тесты) ветка
 * декодирования не дёргается — материал остаётся цветным.
 */
import * as THREE from 'three';
import type {
  AssetService,
  AssetState,
  EntityVisual,
  NormalizedModel,
  TextureAsset,
} from '@game-mvp/assets';

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

/** Можно ли декодировать изображения в этой среде; в Node-тестах — нет. */
export function canDecodeTextures(): boolean {
  return typeof createImageBitmap === 'function' && typeof Blob === 'function';
}

/** THREE-текстура из декодированных байтов ассета. Только браузерная ветка. */
export async function textureFromAsset(asset: TextureAsset): Promise<THREE.Texture> {
  const bitmap = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }));
  const texture = new THREE.Texture(bitmap);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Живое применение скина: держит подписки на текстуры до `dispose`. */
export interface SkinApplication {
  dispose(): void;
}

/**
 * Применяет набор «слот → путь» к материалам инстанса. Каждая текстура
 * запрашивается через AssetService и ставится в материал по факту `ready`
 * (ASSET-4: рендер обязан жить с `loading` неограниченной длительности).
 */
export function applySkin(
  materialsBySlot: ReadonlyMap<number, THREE.MeshStandardMaterial>,
  paths: ReadonlyMap<number, string>,
  assets: AssetService,
): SkinApplication {
  const unsubscribes: (() => void)[] = [];
  let disposed = false;

  for (const [slot, path] of paths) {
    const material = materialsBySlot.get(slot);
    if (material === undefined) continue; // слот без мешей — нечего красить

    const handle = assets.request<TextureAsset>('texture', path);
    const applyState = (state: AssetState<TextureAsset>): void => {
      if (disposed || state.status !== 'ready') return;
      if (!canDecodeTextures()) return; // headless: материал остаётся цветным
      void textureFromAsset(state.data).then((texture) => {
        if (disposed) {
          texture.dispose();
          return;
        }
        material.map?.dispose();
        material.map = texture;
        material.needsUpdate = true;
      });
    };
    applyState(assets.state(handle));
    unsubscribes.push(assets.subscribe(handle, applyState));
  }

  return {
    dispose(): void {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
