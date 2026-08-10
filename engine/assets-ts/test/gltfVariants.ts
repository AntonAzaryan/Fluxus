/**
 * Варианты рукописной фикстуры `gltf-mini` — то, чего в ней нет, а штатный
 * экспортёр Blender выдаёт: «Embedded»-упаковка (буфер и изображения
 * data-URI внутри JSON), меш из нескольких примитивов (экспортёр режет меш по
 * материалам) и ненормированные веса скининга.
 *
 * Собираются кодом из ТОЙ ЖЕ базовой фикстуры, а не лежат отдельными файлами:
 * вариант отличается ровно тем, что проверяет, и разницу видно в этом файле
 * глазами — как в `glbFixture.ts` для контейнера.
 */

import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { FIXTURES_DIR } from './helpers.js';
import { encodeEmbeddedPng, EXTERNAL_TEXTURE_URI, JPEG_BYTES } from './glbFixture.js';

/** ID вариантов — в папке базовой фикстуры, чтобы `.bin` и PNG резолвились так же (ASSET-3). */
export const DATA_URI_ID = 'gltf-mini/embedded-uri.gltf';
export const MULTI_PRIM_ID = 'gltf-mini/multi-primitive.gltf';
export const UNNORMALIZED_ID = 'gltf-mini/unnormalized-weights.gltf';

/** Индексы в базовой фикстуре, на которые вариантам приходится ссылаться поимённо. */
const PROP_MESH = 1;
const BODY_MESH = 0;
const PROP_POSITION_ACCESSOR = 4;
const PROP_INDICES_ACCESSOR = 5;

type Json = Record<string, unknown>;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function jsonBytes(doc: Json): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(JSON.stringify(doc)));
}

/**
 * base64 — штатным кодировщиком Node, а НЕ обратной функцией загрузчика:
 * круговой прогон одной и той же реализации проверял бы её саму с собой.
 */
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Разобранный документ базовой фикстуры и байты её буфера. */
async function readBase(): Promise<{ doc: Json; bin: Uint8Array }> {
  const doc = JSON.parse(await readFile(join(FIXTURES_DIR, 'gltf-mini/model.gltf'), 'utf8')) as Json;
  const bin = new Uint8Array(await readFile(join(FIXTURES_DIR, 'gltf-mini/model.bin')));
  return { doc, bin };
}

/**
 * «Embedded»-упаковка: буфер и два изображения строками `data:...;base64,...`
 * прямо в JSON, третье изображение — по-прежнему внешним файлом. Читать рядом
 * нечего, поэтому источник данных для теста не нужен вовсе.
 */
export async function buildDataUriFixture(): Promise<ArrayBuffer> {
  const { doc, bin } = await readBase();
  const png = await encodeEmbeddedPng();
  return jsonBytes({
    ...doc,
    buffers: [
      { uri: `data:application/octet-stream;base64,${base64(bin)}`, byteLength: bin.length },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
    images: [
      { uri: `data:image/png;base64,${base64(png)}` },
      { uri: EXTERNAL_TEXTURE_URI },
      { uri: `data:image/jpeg;base64,${base64(JPEG_BYTES)}` },
    ],
  });
}

/**
 * Меш "PropMesh" из двух примитивов: второй повторяет геометрию первого, но БЕЗ
 * `material` — так экспортёр отдаёт деталь без назначенного материала.
 */
export async function buildMultiPrimitiveFixture(): Promise<{ gltf: ArrayBuffer; bin: ArrayBuffer }> {
  const { doc, bin } = await readBase();
  const meshes = [...(doc.meshes as Json[])];
  const prop = meshes[PROP_MESH]!;
  meshes[PROP_MESH] = {
    ...prop,
    primitives: [
      ...(prop.primitives as Json[]),
      { attributes: { POSITION: PROP_POSITION_ACCESSOR }, indices: PROP_INDICES_ACCESSOR },
    ],
  };
  return { gltf: jsonBytes({ ...doc, meshes }), bin: toArrayBuffer(bin) };
}

/**
 * Веса скининга "Body" суммой 4 вместо 1: значение `[2, 2, 0, 0]` на вершину
 * дописывается в конец буфера отдельным bufferView и accessor'ом.
 */
export async function buildUnnormalizedWeightsFixture(): Promise<{
  gltf: ArrayBuffer;
  bin: ArrayBuffer;
}> {
  const { doc, bin } = await readBase();
  const VERTICES = 3;
  const weights = new Float32Array(VERTICES * 4);
  for (let v = 0; v < VERTICES; v++) {
    weights[v * 4] = 2;
    weights[v * 4 + 1] = 2;
  }
  // Байты Float32Array — порядок платформы; accessor'ы glTF little-endian, и
  // тесты гоняются только на LE-платформах, как и весь остальной репозиторий.
  const weightBytes = new Uint8Array(weights.buffer);
  const grown = new Uint8Array(bin.length + weightBytes.length);
  grown.set(bin, 0);
  grown.set(weightBytes, bin.length);

  const bufferViews = [
    ...(doc.bufferViews as Json[]),
    { buffer: 0, byteOffset: bin.length, byteLength: weightBytes.length },
  ];
  const accessors = [
    ...(doc.accessors as Json[]),
    { bufferView: bufferViews.length - 1, componentType: 5126, count: VERTICES, type: 'VEC4' },
  ];
  const weightsAccessor = accessors.length - 1;

  const meshes = [...(doc.meshes as Json[])];
  const body = meshes[BODY_MESH]!;
  const primitives = [...(body.primitives as Json[])];
  const first = primitives[0]!;
  primitives[0] = {
    ...first,
    attributes: { ...(first.attributes as Json), WEIGHTS_0: weightsAccessor },
  };
  meshes[BODY_MESH] = { ...body, primitives };

  return {
    gltf: jsonBytes({
      ...doc,
      buffers: [{ uri: 'model.bin', byteLength: grown.length }],
      bufferViews,
      accessors,
      meshes,
    }),
    bin: toArrayBuffer(grown),
  };
}
