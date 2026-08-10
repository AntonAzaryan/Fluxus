/**
 * Сборка фикстур для теста `.glb`: двоичный контейнер со встроенной текстурой и
 * ЭКВИВАЛЕНТНАЯ ему распакованная тройка `.gltf` + `.bin` + внешний PNG.
 *
 * Собирается кодом, а не лежит бинарником, по той же причине, по какой тесты
 * PNG пользуются `pngEncode`: круговой прогон «известные байты → контейнер →
 * загрузчик» проверяет ровно то, что нужно, а правка загрузчика не превращается
 * в правку блоба, который невозможно прочитать глазами. Геометрия, скелет и
 * анимации берутся из уже существующей рукописной фикстуры `gltf-mini`, поэтому
 * обе упаковки описывают заведомо одну и ту же модель — сравнение
 * нормализованных моделей проверяет упаковку, а не совпадение двух наборов
 * чисел.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES_DIR } from './helpers.js';
import { encodePng } from './pngEncode.js';

/** ID контейнера и распакованной модели — в одной папке, чтобы `.bin` и PNG резолвились одинаково (ASSET-3). */
export const GLB_ID = 'gltf-mini/packed.glb';
export const GLTF_ID = 'gltf-mini/unpacked.gltf';
/** Внешний PNG распакованного варианта — те же пиксели, что зашиты в контейнер. */
export const EXTERNAL_PNG_ID = 'gltf-mini/embedded.png';

/** Пиксели встроенной текстуры: 2x2 RGBA, различимые по каналам. */
export const EMBEDDED_PIXELS = [
  10, 20, 30, 255, 40, 50, 60, 255,
  70, 80, 90, 255, 100, 110, 120, 255,
];

/** Ровно то, что видит `resolveDependencyPath` для внешнего изображения фикстуры. */
export const EXTERNAL_TEXTURE_URI = '../shared/atlas.png';
export const EXTERNAL_TEXTURE_PATH = 'shared/atlas.png';

/** Начало JPEG (SOI + APP0): формат без декодера в модуле — повод для слота без источника. */
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);

/** Те же `EMBEDDED_PIXELS` настоящим PNG — общий кирпич всех упаковок фикстуры. */
export async function encodeEmbeddedPng(): Promise<Uint8Array> {
  const row = (a: number[], b: number[]): Uint8Array => Uint8Array.from([...a, ...b]);
  return new Uint8Array(
    await encodePng({
      width: 2,
      height: 2,
      colorType: 6,
      rows: [
        row(EMBEDDED_PIXELS.slice(0, 4), EMBEDDED_PIXELS.slice(4, 8)),
        row(EMBEDDED_PIXELS.slice(8, 12), EMBEDDED_PIXELS.slice(12, 16)),
      ],
    }),
  );
}

const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

/** Выравнивание чанков и bufferView'ов контейнера — 4 байта. */
function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Двоичный контейнер: заголовок 12 байт, JSON-чанк, BIN-чанк. */
function packGlb(json: string, bin: Uint8Array): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPad = pad4(jsonBytes.length);
  const binPad = pad4(bin.length);
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);

  let offset = 12;
  view.setUint32(offset, jsonBytes.length + jsonPad, true);
  view.setUint32(offset + 4, GLB_CHUNK_JSON, true);
  bytes.set(jsonBytes, offset + 8);
  // JSON-чанк добивается ПРОБЕЛАМИ, BIN — нулями (спецификация glTF, §4.4.2).
  bytes.fill(0x20, offset + 8 + jsonBytes.length, offset + 8 + jsonBytes.length + jsonPad);
  offset += 8 + jsonBytes.length + jsonPad;

  view.setUint32(offset, bin.length + binPad, true);
  view.setUint32(offset + 4, GLB_CHUNK_BIN, true);
  bytes.set(bin, offset + 8);
  return out;
}

export interface GlbFixture {
  /** Контейнер: буфер и одно изображение внутри, внешний остаётся файлом. */
  readonly glb: ArrayBuffer;
  /** Та же модель распакованной: JSON, ссылающийся на `.bin` и PNG файлами. */
  readonly gltf: ArrayBuffer;
  readonly bin: ArrayBuffer;
  readonly png: ArrayBuffer;
}

/**
 * Обе упаковки одной модели. Слоты фикстуры покрывают все три вида источника:
 * 0 — встроенный PNG, 1 — внешний файл по `uri`, 2 — встроенный JPEG, для
 * которого декодера в модуле нет.
 */
export async function buildGlbFixture(): Promise<GlbFixture> {
  const baseJson = await readFile(join(FIXTURES_DIR, 'gltf-mini/model.gltf'), 'utf8');
  const baseBin = new Uint8Array(await readFile(join(FIXTURES_DIR, 'gltf-mini/model.bin')));
  const doc = JSON.parse(baseJson) as Record<string, unknown>;

  const png = await encodeEmbeddedPng();

  // BIN контейнера = исходный буфер модели, следом выровненные байты изображений.
  const pngOffset = baseBin.length + pad4(baseBin.length);
  const jpegOffset = pngOffset + png.length + pad4(png.length);
  const bin = new Uint8Array(jpegOffset + JPEG_BYTES.length + pad4(JPEG_BYTES.length));
  bin.set(baseBin, 0);
  bin.set(png, pngOffset);
  bin.set(JPEG_BYTES, jpegOffset);

  const bufferViews = [
    ...(doc.bufferViews as Record<string, number>[]),
    { buffer: 0, byteOffset: pngOffset, byteLength: png.length },
    { buffer: 0, byteOffset: jpegOffset, byteLength: JPEG_BYTES.length },
  ];
  const pngView = bufferViews.length - 2;
  const jpegView = bufferViews.length - 1;

  const textures = [{ source: 0 }, { source: 1 }, { source: 2 }];

  const packed = {
    ...doc,
    buffers: [{ byteLength: bin.length }], // контейнер: буфер без uri — это BIN-чанк
    bufferViews,
    textures,
    images: [
      { bufferView: pngView, mimeType: 'image/png' },
      { uri: EXTERNAL_TEXTURE_URI },
      { bufferView: jpegView, mimeType: 'image/jpeg' },
    ],
  };

  // Распакованный эквивалент: те же JSON-структуры, но буфер и изображение —
  // отдельные файлы. Лишние bufferView'ы изображений здесь не нужны и мешали бы
  // сравнению не больше, чем помогали, поэтому берём исходные.
  const unpacked = {
    ...doc,
    buffers: [{ uri: 'model.bin', byteLength: baseBin.length }],
    textures,
    images: [
      { uri: 'embedded.png' },
      { uri: EXTERNAL_TEXTURE_URI },
      { uri: 'missing-decoder.jpg' },
    ],
  };

  return {
    glb: packGlb(JSON.stringify(packed), bin),
    gltf: toArrayBuffer(new TextEncoder().encode(JSON.stringify(unpacked))),
    bin: toArrayBuffer(baseBin),
    png: toArrayBuffer(png),
  };
}
