/**
 * Набор вариантов скинов записи манифеста (ASSET-12, четвёртая производная):
 * текстуры скинов записи (ASSET-6) в форме, пригодной для разделяемого
 * GPU-хранилища с выбором варианта пер-инстансным индексом (`rendering`
 * REND-6).
 *
 * Форма — слоёный массив на СЛОТ текстуры: слот остаётся единицей подмены
 * скина, а вариант — слоем. Пер-инстансно тогда хранится одно число (индекс
 * слоя), а не копия материала: гарантия «смена скина одного не трогает других»
 * держится тем, что инстансы читают разные слои общего массива.
 *
 * Почему индексы сквозные и почему все слои одного слота одного размера:
 * массив текстур GPU иначе не бывает — слои одного массива обязаны совпадать
 * по размеру и формату. Поэтому размеры нормализуются здесь, при запекании, а
 * не остаются заботой потребителя (design D8).
 *
 * Модуль рендер-агностичен (ASSET-5): наружу идут пиксели и раскладка, а не
 * `DataArrayTexture`. Запекание детерминировано (ASSET-12): ресайз — выборка
 * ближайшего пикселя, никакой фильтрации, зависящей от реализации.
 */
import type { DecodedImage } from './image.js';

/**
 * Один вариант: имя скина записи манифеста и его картинки по слотам. Слот, о
 * котором вариант молчит, берётся у ПЕРВОГО варианта — это и есть смысл
 * «скин подменяет часть слотов, остальные остаются модельными» (ASSET-6).
 */
export interface SkinVariantSource {
  /** Имя скина записи; у базового варианта модели имя пустое. */
  readonly name: string;
  readonly images: ReadonlyMap<number, DecodedImage>;
}

/** Слот текстуры как массив слоёв «вариант». */
export interface BakedSkinSlot {
  /** Номер слота модели (`TextureSlotRef.slot`) — по нему материал и находит карту. */
  readonly slot: number;
  readonly width: number;
  readonly height: number;
  /** RGBA8 подряд, `width × height × 4` байт на слой; слоёв — по числу вариантов. */
  readonly pixels: Uint8Array;
}

/** Запечённый набор вариантов записи (ASSET-12). */
export interface BakedSkinSet {
  /** Имена вариантов в порядке индексов: индекс — то, что кладётся в атрибут инстанса. */
  readonly variants: readonly string[];
  /** Слоты в порядке возрастания номера. */
  readonly slots: readonly BakedSkinSlot[];
}

export interface BakeSkinParams {
  /**
   * Верхняя граница стороны слоя, пиксели. Слои крупнее ужимаются: бюджет
   * памяти массива текстур — параметр запекания, а не свойство исходников.
   */
  readonly maxSize?: number;
}

/** По умолчанию слой не крупнее этого: 2048 — потолок, безопасный для WebGL2. */
export const DEFAULT_SKIN_MAX_SIZE = 2048;

/**
 * Запекает набор вариантов (ASSET-12). Первый вариант — базовый: он задаёт
 * состав слотов и подставляется там, где вариант о слоте молчит.
 *
 * Сторона слоя — ближайшая сверху степень двойки от максимума вариантов слота,
 * обрезанная `maxSize`: массиву текстур нужен один размер на все слои, а
 * степень двойки снимает вопрос о мипах и повторе.
 */
export function bakeSkinVariants(
  sources: readonly SkinVariantSource[],
  params: BakeSkinParams = {},
): BakedSkinSet {
  const maxSize = Math.max(1, Math.floor(params.maxSize ?? DEFAULT_SKIN_MAX_SIZE));
  // Базовый вариант — первый: он задаёт состав слотов и подставляется там, где
  // вариант о слоте молчит. Нет его — запекать нечего.
  const base = sources[0];
  if (base === undefined) return { variants: [], slots: [] };

  // Состав слотов — объединение по всем вариантам, по возрастанию номера:
  // порядок обхода не должен зависеть от порядка вставки в Map (ASSET-12).
  const slotNumbers = [
    ...new Set(sources.flatMap((source) => [...source.images.keys()])),
  ].sort((a, b) => a - b);

  const slots: BakedSkinSlot[] = [];
  for (const slot of slotNumbers) {
    let width = 1;
    let height = 1;
    for (const source of sources) {
      const image = source.images.get(slot);
      if (image === undefined) continue;
      width = Math.max(width, image.width);
      height = Math.max(height, image.height);
    }
    width = Math.min(nextPowerOfTwo(width), maxSize);
    height = Math.min(nextPowerOfTwo(height), maxSize);

    const layer = width * height * 4;
    const pixels = new Uint8Array(layer * sources.length);
    const fallback = base.images.get(slot);
    sources.forEach((source, index) => {
      // Вариант молчит о слоте — слой берётся у базового; молчат оба — слой
      // остаётся нулевым (прозрачным): «текстуры нет» и «текстура чёрная» на
      // GPU различаются только этим, а исключение здесь погасило бы всю запись.
      const image = source.images.get(slot) ?? fallback;
      if (image === undefined) return;
      resampleInto(image, pixels, index * layer, width, height);
    });
    slots.push({ slot, width, height, pixels });
  }

  return { variants: sources.map((source) => source.name), slots };
}

/**
 * Индекс варианта по имени; `-1` — набор такого варианта не несёт. Отдельная
 * функция, а не метод набора: набор — данные (ASSET-5), и сериализовать его
 * когда-нибудь придётся целиком.
 */
export function skinVariantIndex(set: BakedSkinSet, name: string | undefined): number {
  return set.variants.indexOf(name ?? '');
}

/** Ближайшая сверху степень двойки, не меньше 1. */
function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/**
 * Изображение в слой заданного размера выборкой ближайшего пикселя. Ближайший,
 * а не усреднение: детерминизм запекания (ASSET-12) требует правила, которое
 * не зависит от реализации, а скины — атласы, где смешивать соседей всё равно
 * нельзя.
 */
function resampleInto(
  image: DecodedImage,
  out: Uint8Array,
  offset: number,
  width: number,
  height: number,
): void {
  if (image.width === width && image.height === height) {
    out.set(image.pixels.subarray(0, width * height * 4), offset);
    return;
  }
  for (let y = 0; y < height; y++) {
    // Центр целевого пикселя переводится в исходные оси — так масштаб не
    // сдвигает картинку на полпикселя.
    const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
      const from = (sy * image.width + sx) * 4;
      const to = offset + (y * width + x) * 4;
      out[to] = image.pixels[from] ?? 0;
      out[to + 1] = image.pixels[from + 1] ?? 0;
      out[to + 2] = image.pixels[from + 2] ?? 0;
      out[to + 3] = image.pixels[from + 3] ?? 0;
    }
  }
}
