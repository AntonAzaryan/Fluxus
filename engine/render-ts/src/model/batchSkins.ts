/**
 * Набор вариантов скина батча (REND-6, `assets` ASSET-12, design D8).
 *
 * У детального яруса скин — подмена карт в СВОИХ материалах инстанса
 * (`skins.ts`). У батчевого материал один на всю запись, поэтому вариант
 * выбирается СЛОЕМ массива текстур: пер-инстансно хранится одно число, и смена
 * скина одного не трогает ни соседей, ни разделяемые данные ассета.
 *
 * Раскладку (нормализацию размеров, сквозные индексы вариантов) делает
 * `bakeSkinVariants` модуля ассетов — рендер-агностично и headless. Здесь
 * остаётся то, чего модуль ассетов делать не должен: собрать источники по
 * записи манифеста, дождаться пикселей через `AssetService` (ASSET-4) и
 * положить готовые слои в GPU-объекты.
 */
import * as THREE from 'three';
import {
  bakeSkinVariants,
  type AssetService,
  type AssetState,
  type BakedSkinSet,
  type DecodedImage,
  type EntityVisual,
  type NormalizedModel,
} from '@fluxus/assets';
import { skinTextureSources, type SkinTextureSource } from './skins.js';
import type { VatMapKind } from './vatMaterial.js';
import { own } from '../footprint.js';

/** Имя базового варианта — модель как она есть, без подмен записи (ASSET-6). */
export const BASE_SKIN_VARIANT = '';

/**
 * Имена вариантов записи в порядке индексов. Базовый первый — он же
 * подставляется там, где вариант о слоте молчит (`bakeSkinVariants`), — и
 * дальше имена скинов записи ПО ВОЗРАСТАНИЮ: индекс варианта переживает
 * переподачу манифеста (REND-17) только если не зависит от порядка ключей.
 */
export function skinVariantNames(visual: EntityVisual | undefined): readonly string[] {
  return [BASE_SKIN_VARIANT, ...Object.keys(visual?.skins ?? {}).sort()];
}

/** Готовый набор слоёв: слот → пиксели всех вариантов подряд. */
export type SkinLayersListener = (set: BakedSkinSet) => void;

/**
 * Живая загрузка вариантов записи. Пиксели приезжают асинхронно (ASSET-4), и до
 * их готовности батч рисуется цветом материала — как детальный инстанс до
 * прихода своих текстур.
 */
export class BatchSkinLoader {
  private readonly variants: readonly string[];
  private readonly images: Map<number, DecodedImage>[];
  private readonly unsubscribes: (() => void)[] = [];
  private pending = 0;
  private started = false;
  private disposed = false;
  private baked: BakedSkinSet | null = null;
  private readonly listener: SkinLayersListener;

  constructor(
    model: NormalizedModel,
    visual: EntityVisual | undefined,
    assets: AssetService,
    listener: SkinLayersListener,
  ) {
    this.listener = listener;
    this.variants = skinVariantNames(visual);
    this.images = this.variants.map(() => new Map<number, DecodedImage>());

    // Сперва СОБИРАЕМ все источники и только потом подписываемся: `subscribe`
    // зовёт колбэк с текущим состоянием немедленно, и готовый ассет опустошил
    // бы счётчик до того, как в нём учтён последний вариант.
    const requests: { variant: number; slot: number; path: string }[] = [];
    this.variants.forEach((name, variant) => {
      const sources = skinTextureSources(
        model,
        visual,
        name === BASE_SKIN_VARIANT ? undefined : name,
      );
      for (const [slot, source] of sources) {
        if (source.kind === 'image') this.images[variant]!.set(slot, source.image);
        else requests.push({ variant, slot, path: source.path });
      }
    });
    this.pending = requests.length;

    for (const request of requests) {
      const handle = assets.request<DecodedImage>('texture', request.path);
      let counted = false;
      const onState = (state: AssetState<DecodedImage>): void => {
        if (this.disposed || counted) return;
        if (state.status === 'loading') return;
        counted = true;
        if (state.status === 'ready') this.images[request.variant]!.set(request.slot, state.data);
        this.pending -= 1;
        this.settle();
      };
      this.unsubscribes.push(assets.subscribe(handle, onState));
    }
    this.started = true;
    this.settle();
  }

  /** Индекс варианта по имени скина; неизвестный скин — базовый вариант. */
  indexOf(skin: string | undefined): number {
    const index = this.variants.indexOf(skin ?? BASE_SKIN_VARIANT);
    return index < 0 ? 0 : index;
  }

  get set(): BakedSkinSet | null {
    return this.baked;
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  /** Все источники разрешились — набор запекается один раз (ASSET-12). */
  private settle(): void {
    if (!this.started || this.disposed || this.pending > 0 || this.baked !== null) return;
    this.baked = bakeSkinVariants(
      this.variants.map((name, variant) => ({ name, images: this.images[variant]! })),
    );
    this.listener(this.baked);
  }
}

/**
 * Массив текстур одного слота: слой — вариант скина. Цветовое пространство
 * зависит от вида карты — тем же правилом, что у детального яруса
 * (`textureFromImage`): карта нормалей это данные, а не цвет.
 */
export function skinArrayTexture(
  set: BakedSkinSet,
  slot: number,
  kind: VatMapKind,
): THREE.DataArrayTexture | null {
  const baked = set.slots.find((candidate) => candidate.slot === slot);
  if (baked === undefined) return null;
  const texture = own(
    'texture',
    'model',
    new THREE.DataArrayTexture(
      baked.pixels,
      baked.width,
      baked.height,
      set.variants.length,
    ),
  );
  texture.colorSpace = kind === 'normal' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Источники варианта — вход теста раскладки; повторяет вход `BatchSkinLoader`. */
export function variantSources(
  model: NormalizedModel,
  visual: EntityVisual | undefined,
  variant: string,
): ReadonlyMap<number, SkinTextureSource> {
  return skinTextureSources(model, visual, variant === BASE_SKIN_VARIANT ? undefined : variant);
}
