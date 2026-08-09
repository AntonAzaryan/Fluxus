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

/**
 * Манифест визуалов цели (ASSET-9). Запись есть у каждого prefab'а: пара
 * «prefab — запись манифеста» проверяется валидацией на общих основаниях
 * (ED-19), и цель импорта обязана быть согласованной ДО импорта — иначе тест
 * проверял бы, что чужое нарушение не мешает записи, а не то, что мешает своё.
 */
export const MANIFEST: VisualManifest = {
  entities: {
    Hero: { model: 'visuals/models/hero.gltf' },
    Rock: { model: 'visuals/models/rock.gltf' },
    Marker: { model: 'visuals/models/marker.gltf' },
  },
  decorations: { Statue: { model: 'visuals/models/statue.gltf' } },
};

export function context(overrides: Partial<SpatialLayerContext> = {}): SpatialLayerContext {
  return { components: COMPONENTS, prefabs: PREFABS, visuals: MANIFEST, ...overrides };
}

/* Цель импорта: дерево контента из тех же схем и prefab'ов, что и контекст выше. */

export const SCENE_ID = 'scenes/duel.scene.json';
export const PRESENTATION_ID = 'scenes/duel.presentation.json';
export const SOURCE_ID = 'scenes/duel.gltf';
export const MANIFEST_ID = 'visuals/manifest.json';

/**
 * Конфиг сцены цели. Полей сверх производных здесь нарочно много: BLND-2
 * требует, чтобы импорт не тронул ни одного из них, и проверять это на
 * документе из одного `initial` было бы нечем.
 */
export function sceneDocument(initial: readonly unknown[] = []): Record<string, unknown> {
  return {
    capacity: 64,
    components: COMPONENTS.map((schema) => ({ name: schema.name, fields: { ...schema.fields } })),
    prefabs: PREFABS.map((def) => ({ name: def.name, components: structuredClone(def.components) })),
    systems: [
      {
        name: 'Drift',
        order: 10,
        query: { all: ['Position', 'Locomotion'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: { x: { getComponent: [{ var: 'e' }, 'Position', 'x'] } },
            },
          },
        ],
      },
    ],
    initial: [...initial],
  };
}

/** Парный presentation-документ цели (PRES-1, PRES-2). */
export function presentationDocument(decorations: readonly unknown[] = []): Record<string, unknown> {
  return { decorations: [...decorations] };
}

/** Манифест визуалов дерева (ASSET-9) — тот же, что подаётся контекстом. */
export function manifestDocument(): Record<string, unknown> {
  return structuredClone(MANIFEST) as unknown as Record<string, unknown>;
}

/** Дерево контента цели: сцена, парный документ, манифест и экспорт источника. */
export function contentFiles(
  source: string = 'placements.gltf',
  scene: Record<string, unknown> = sceneDocument(),
  presentation: Record<string, unknown> = presentationDocument(),
): Record<string, string | Uint8Array> {
  return {
    [SCENE_ID]: JSON.stringify(scene, null, 2),
    [PRESENTATION_ID]: JSON.stringify(presentation, null, 2),
    [MANIFEST_ID]: JSON.stringify(manifestDocument(), null, 2),
    [SOURCE_ID]: fixtureBytes(source),
  };
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
