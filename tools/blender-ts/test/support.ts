/**
 * Общее для тестов конвейера: чтение закоммиченных фикстур экспорта и
 * минимальная цель импорта.
 *
 * Blender здесь не вызывается ни в какой форме (BLND-7): фикстуры `.gltf`
 * написаны руками, `.glb` собирается из фикстуры прямо в тесте. Цель импорта —
 * схемы и prefabs, объявленные ЗДЕСЬ, а не прочитанные из `content/`: контент
 * правит геймдизайнер, и тест конвейера не должен краснеть от перетюненного
 * числа (CONT-4).
 */
import { readFileSync } from 'node:fs';
import type { ComponentSchema, PrefabDef } from '@game-mvp/core';
import type { VisualManifest } from '@game-mvp/assets';
import { parseGltf, type GltfDocument } from '../src/gltf.js';
import { normalizeDocument, type SourceObject } from '../src/normalize.js';
import type { SpatialLayerContext } from '../src/layer.js';

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

export function fixture(name: string): GltfDocument {
  return parseGltf(fixtureBytes(name));
}

export function objectsOf(name: string): readonly SourceObject[] {
  return normalizeDocument(fixture(name));
}

export function objectNamed(objects: readonly SourceObject[], name: string): SourceObject {
  const found = objects.find((object) => object.name === name);
  if (found === undefined) throw new Error(`фикстура не содержит объекта "${name}"`);
  return found;
}

export const COMPONENTS: readonly ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Facing', fields: { turns: 'fixed' } },
  { name: 'Player', fields: { slot: 'i32' } },
  { name: 'Locomotion', fields: { maxSpeed: 'fixed' } },
];

export const PREFABS: readonly PrefabDef[] = [
  {
    name: 'Hero',
    components: {
      Position: { x: 0, y: 0 },
      Facing: { turns: 0 },
      Player: { slot: 0 },
      Locomotion: { maxSpeed: 0 },
    },
  },
  { name: 'Rock', components: { Position: { x: 0, y: 0 } } },
  /** Prefab без компонента позиции: цель проверки «компонент вне состава» (CMD-6). */
  { name: 'Marker', components: { Player: { slot: 0 } } },
];

export const MANIFEST: VisualManifest = {
  entities: { Hero: { model: 'visuals/models/hero.gltf' } },
  decorations: { Statue: { model: 'visuals/models/statue.gltf' } },
};

export function context(overrides: Partial<SpatialLayerContext> = {}): SpatialLayerContext {
  return { components: COMPONENTS, prefabs: PREFABS, visuals: MANIFEST, ...overrides };
}

/**
 * Контейнер `.glb` из фикстуры `.gltf` — так же, как его собрал бы экспортёр:
 * заголовок, JSON-чанк, бинарный чанк. Собирается в памяти, а не лежит в
 * дереве: бинарная фикстура нечитаема в ревью, а разбор контейнера пиннится и
 * так (постоянная фикстура `.glb` — задача 10.1).
 */
export function packGlb(json: unknown, binary?: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binaryBytes = binary ?? new Uint8Array(0);
  const binaryPadding = (4 - (binaryBytes.byteLength % 4)) % 4;
  const jsonChunk = jsonBytes.byteLength + jsonPadding;
  const binaryChunk = binaryBytes.byteLength + binaryPadding;
  const total = 12 + 8 + jsonChunk + (binary === undefined ? 0 : 8 + binaryChunk);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  // Дополнение JSON-чанка — пробелы, бинарного — нули (правило формата).
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonChunk);
  if (binary !== undefined) {
    const at = 20 + jsonChunk;
    view.setUint32(at, binaryChunk, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(binaryBytes, at + 8);
  }
  return out;
}
