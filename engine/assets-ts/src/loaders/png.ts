/**
 * Загрузчик текстур PNG: декодирует файл в пиксели прямо здесь (ASSET-5), а не
 * отдаёт байты потребителю. Иначе декодирование происходит на каждый инстанс, и
 * разделяемым остаётся только сжатый буфер, который ничего не стоит.
 *
 * Декодер свой, потому что модуль рендер-агностичен: `createImageBitmap` дал бы
 * нативную скорость, но вытащить из него пиксели без canvas нельзя, а canvas —
 * это DOM. Распаковка идёт через `DecompressionStream` — он есть и в Node 18+,
 * и в браузерах, поэтому зависимостей на inflate не нужно вовсе.
 *
 * Границы поддержки (решение 7 design'а): 8 и 16 бит на канал, цветовые типы
 * grayscale / RGB / палитра / grayscale+alpha / RGBA, tRNS для палитры;
 * 16 бит приводятся к 8. Чересстрочные (Adam7) и битовые глубины меньше 8
 * отклоняются внятной ошибкой — контент предконвертируется нами, и поддержка
 * редких случаев дешевле в конвертере, чем в рантайме.
 */

import type { DecodedImage } from '../image.js';
import type { AssetLoader, LoaderContext } from '../types.js';

/**
 * `DecompressionStream` живёт и в Node >= 18, и в браузерах, но объявлен в
 * lib.dom, которую пакет намеренно не подключает (ASSET-5: никакого DOM). Здесь
 * объявлена ровно та часть, которой мы пользуемся, — заодно это документирует
 * требование к рантайму.
 */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}
interface ChunkWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
declare const DecompressionStream: new (format: string) => {
    readable: { getReader(): ChunkReader };
    writable: { getWriter(): ChunkWriter };
  };

/** 8-байтовая сигнатура PNG по спецификации. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Похожи ли байты на PNG. Один ответ на весь модуль: по нему и декодер узнаёт
 * свой файл, и загрузчик glTF решает, есть ли у встроенного изображения декодер
 * (ASSET-5) — второе написание сигнатуры разошлось бы с первым молча.
 */
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Число каналов на цветовой тип PNG; palette (3) хранит один индекс. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** zlib-распаковка потоком: без зависимостей и одинаково в Node и браузере. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  // Писать и читать надо параллельно: writer.write() резолвится только по мере
  // вычитывания. Ошибку записи глотаем здесь — она же придёт из read() ниже,
  // но уже с контекстом, а необработанный reject уронил бы процесс.
  void (async (): Promise<void> => {
    await writer.write(data);
    await writer.close();
  })().catch(() => undefined);

  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      parts.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Снятие построчных фильтров PNG. Фильтр — предсказание байта по левому (a),
 * верхнему (b) и левому-верхнему (c) соседям; данные восстанавливаются
 * последовательно, поэтому цикл идёт строго по порядку строк и байтов.
 */
function unfilter(raw: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++] ?? 0;
    const row = y * stride;
    unfilterRow(out, raw, src, row, row - stride, stride, bpp, filter, y > 0);
    src += stride;
  }
  return out;
}

/**
 * Одна строка: соседи берутся из УЖЕ восстановленных байтов `out`, поэтому
 * порядок внутри строки строгий. Модульная функция с явными аргументами, а не
 * замыкание: вызывается она на каждую строку изображения.
 */
function unfilterRow(
  out: Uint8Array,
  raw: Uint8Array,
  src: number,
  row: number,
  prev: number,
  stride: number,
  bpp: number,
  filter: number,
  hasPrev: boolean,
): void {
  for (let x = 0; x < stride; x++) {
    const value = raw[src + x] ?? 0;
    const a = x >= bpp ? out[row + x - bpp]! : 0;
    const b = hasPrev ? out[prev + x]! : 0;
    const c = hasPrev && x >= bpp ? out[prev + x - bpp]! : 0;
    out[row + x] = restoreByte(filter, value, a, b, c) & 0xff;
  }
}

/** Байт по номеру фильтра: снимаем предсказание по соседям a (левый), b (верхний), c (левый-верхний). */
function restoreByte(filter: number, value: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return value;
    case 1:
      return value + a;
    case 2:
      return value + b;
    case 3:
      return value + ((a + b) >> 1);
    case 4: {
      // Paeth: выбираем соседа, ближайшего к линейному предсказанию a+b-c
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
    default:
      throw new Error(`неизвестный фильтр строки PNG: ${filter}`);
  }
}

/** Разбор чанков: заголовок, палитра, прозрачность палитры и склеенные IDAT. */
function readChunks(view: DataView, bytes: Uint8Array, id: string): {
  header: Header;
  palette: Uint8Array | null;
  transparency: Uint8Array | null;
  idat: Uint8Array;
} {
  let offset = 8;
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const start = offset + 8;
    if (start + length > bytes.length) {
      throw new Error(`ассет "${id}": PNG обрывается внутри чанка "${type}"`);
    }
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(start),
        height: view.getUint32(start + 4),
        bitDepth: bytes[start + 8]!,
        colorType: bytes[start + 9]!,
        interlace: bytes[start + 12]!,
      };
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, start + length);
    } else if (type === 'tRNS') {
      transparency = bytes.subarray(start, start + length);
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4; // + CRC
  }

  if (header == null) throw new Error(`ассет "${id}": в PNG нет чанка IHDR`);
  if (idatParts.length === 0) throw new Error(`ассет "${id}": в PNG нет данных изображения`);

  let total = 0;
  for (const part of idatParts) total += part.length;
  const idat = new Uint8Array(total);
  let cursor = 0;
  for (const part of idatParts) {
    idat.set(part, cursor);
    cursor += part.length;
  }
  return { header, palette, transparency, idat };
}

/** Развёртка распакованных строк в RGBA8 — единственный формат `DecodedImage`. */
function toRgba8(
  data: Uint8Array,
  header: Header,
  channels: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
  id: string,
): Uint8Array {
  const { width, height, bitDepth, colorType } = header;
  const step = bitDepth === 16 ? 2 : 1; // 16 бит → берём старший байт
  const stride = width * channels * step;
  const pixels = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * stride + x * channels * step;
      const dst = (y * width + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      switch (colorType) {
        case 0: // grayscale
          r = g = b = data[src]!;
          break;
        case 2: // RGB
          r = data[src]!;
          g = data[src + step]!;
          b = data[src + 2 * step]!;
          break;
        case 3: {
          // палитра: значение — индекс в PLTE, альфа (если есть) — из tRNS
          const index = data[src]!;
          if (palette == null) {
            throw new Error(`ассет "${id}": PNG с палитрой, но без чанка PLTE`);
          }
          r = palette[index * 3] ?? 0;
          g = palette[index * 3 + 1] ?? 0;
          b = palette[index * 3 + 2] ?? 0;
          a = transparency?.[index] ?? 255;
          break;
        }
        case 4: // grayscale + alpha
          r = g = b = data[src]!;
          a = data[src + step]!;
          break;
        default: // 6: RGBA
          r = data[src]!;
          g = data[src + step]!;
          b = data[src + 2 * step]!;
          a = data[src + 3 * step]!;
          break;
      }
      pixels[dst] = r;
      pixels[dst + 1] = g;
      pixels[dst + 2] = b;
      pixels[dst + 3] = a;
    }
  }
  return pixels;
}

/** Декодирование PNG в RGBA8. Headless, без DOM и GPU (ASSET-5). */
export async function decodePng(bytes: ArrayBuffer, id: string): Promise<DecodedImage> {
  const data = new Uint8Array(bytes);
  if (!isPng(data)) {
    throw new Error(`ассет "${id}" не является PNG: неверная сигнатура файла`);
  }

  const { header, palette, transparency, idat } = readChunks(
    new DataView(data.buffer, data.byteOffset, data.byteLength),
    data,
    id,
  );

  if (header.interlace !== 0) {
    throw new Error(
      `ассет "${id}": чересстрочный (Adam7) PNG не поддерживается — пересохраните файл без интерлейса`,
    );
  }
  if (header.bitDepth !== 8 && header.bitDepth !== 16) {
    throw new Error(
      `ассет "${id}": PNG с ${header.bitDepth} бит на канал не поддерживается — пересохраните файл в 8 бит`,
    );
  }
  const channels = CHANNELS[header.colorType];
  if (channels === undefined) {
    throw new Error(`ассет "${id}": неизвестный цветовой тип PNG (${header.colorType})`);
  }

  const bytesPerPixel = Math.max(1, (channels * header.bitDepth) / 8);
  const stride = (header.width * channels * header.bitDepth) / 8;
  const inflated = await inflate(idat);
  const expected = (stride + 1) * header.height;
  if (inflated.length < expected) {
    throw new Error(
      `ассет "${id}": PNG распаковался в ${inflated.length} байт вместо ${expected} — файл повреждён`,
    );
  }
  const rows = unfilter(inflated, stride, header.height, bytesPerPixel);

  return Object.freeze({
    width: header.width,
    height: header.height,
    format: 'rgba8' as const,
    pixels: toRgba8(rows, header, channels, palette, transparency, id),
  });
}

/** Загрузчик текстур PNG для реестра сервиса (ASSET-3). */
export const pngTextureLoader: AssetLoader<DecodedImage> = {
  kind: 'texture',
  extensions: ['.png'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): Promise<DecodedImage> {
    return decodePng(bytes, ctx.id);
  },
};
