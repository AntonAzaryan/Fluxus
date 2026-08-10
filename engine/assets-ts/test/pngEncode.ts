/**
 * Минимальный кодировщик PNG для тестов декодера. Собирает файл из чанков и
 * сжимает строки через `CompressionStream` — зеркало того, чем декодер
 * распаковывает.
 *
 * Кодировщик в тестах, а не фикстуры-файлы: круговой прогон «известные пиксели
 * → PNG → декодер» проверяет ровно то, что нужно (включая все пять построчных
 * фильтров), и не превращает правку декодера в правку бинарников.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
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

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Прямое применение построчного фильтра — обратное тому, что делает декодер. */
function filterRow(
  row: Uint8Array,
  prev: Uint8Array | null,
  filter: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let x = 0; x < row.length; x++) {
    const raw = row[x]!;
    const a = x >= bpp ? row[x - bpp]! : 0;
    const b = prev ? prev[x]! : 0;
    const c = prev && x >= bpp ? prev[x - bpp]! : 0;
    let predictor: number;
    switch (filter) {
      case 0:
        predictor = 0;
        break;
      case 1:
        predictor = a;
        break;
      case 2:
        predictor = b;
        break;
      case 3:
        predictor = (a + b) >> 1;
        break;
      default: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        break;
      }
    }
    out[x] = (raw - predictor) & 0xff;
  }
  return out;
}

export interface PngSpec {
  width: number;
  height: number;
  colorType: number;
  bitDepth?: number;
  /** Нефильтрованные строки, по `stride` байт. */
  rows: Uint8Array[];
  /** Фильтр на строку; по умолчанию 0 (None). */
  filters?: number[];
  palette?: Uint8Array;
  transparency?: Uint8Array;
  interlace?: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function encodePng(spec: PngSpec): Promise<ArrayBuffer> {
  const bitDepth = spec.bitDepth ?? 8;
  const channels = CHANNELS[spec.colorType]!;
  const bpp = Math.max(1, (channels * bitDepth) / 8);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, spec.width);
  view.setUint32(4, spec.height);
  ihdr[8] = bitDepth;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlace ?? 0;

  const stride = spec.rows[0]?.length ?? 0;
  const raw = new Uint8Array((stride + 1) * spec.height);
  let offset = 0;
  spec.rows.forEach((row, y) => {
    const filter = spec.filters?.[y] ?? 0;
    raw[offset++] = filter;
    raw.set(filterRow(row, y > 0 ? spec.rows[y - 1]! : null, filter, bpp), offset);
    offset += stride;
  });

  const parts: Uint8Array[] = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', ihdr),
    ...(spec.palette ? [chunk('PLTE', spec.palette)] : []),
    ...(spec.transparency ? [chunk('tRNS', spec.transparency)] : []),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];

  let total = 0;
  for (const part of parts) total += part.length;
  const file = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    file.set(part, cursor);
    cursor += part.length;
  }
  return file.buffer;
}

declare const CompressionStream: new (format: string) => {
    readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
    writable: { getWriter(): { write(c: Uint8Array): Promise<void>; close(): Promise<void> } };
  };
