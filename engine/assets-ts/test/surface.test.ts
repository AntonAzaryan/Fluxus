/**
 * Тесты выборки поверхности канонической модели (ASSET-11). Всё headless
 * (ASSET-5): рукописные канонические модели там, где важна читаемость чисел,
 * и glTF-фикстура настила через штатный загрузчик — для сквозного сценария
 * «файл → каноническое представление → запрос» без браузера, GPU и
 * рендер-библиотеки.
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { gltfLoader, modelSurfaceIndex } from '../src/index.js';
import type { ModelSurfaceHit, NormalizedMesh, NormalizedModel } from '../src/index.js';

interface MeshData {
  positions: number[];
  indices: number[];
}

/** Минимальная каноническая модель из голой геометрии — остальное запросу не видно. */
function makeModel(parts: MeshData[]): NormalizedModel {
  const meshes: NormalizedMesh[] = parts.map((part, i) => {
    const vertices = part.positions.length / 3;
    return Object.freeze({
      partId: i,
      positions: Float32Array.from(part.positions),
      normals: null,
      uvs: null,
      indices: Uint16Array.from(part.indices),
      skinIndices: new Uint16Array(vertices * 4),
      skinWeights: new Float32Array(vertices * 4),
      materialIndex: 0,
    });
  });
  return Object.freeze({
    bones: [],
    meshes: Object.freeze(meshes),
    sequences: [],
    materials: [],
    textureSlots: [],
    height: 0,
  });
}

/** Горизонтальный квад [x0,x1]×[y0,y1] на высоте z — два треугольника. */
function quad(z: number, x0: number, y0: number, x1: number, y1: number): MeshData {
  return {
    positions: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

function freshHit(): ModelSurfaceHit {
  return { t: 0, point: [0, 0, 0], normal: [0, 0, 0] };
}

/**
 * glTF-настил на высоте Y=2 (glTF Y-вверх): загрузчик канонизирует в Z-вверх,
 * (x, y, z) → (x, -z, y), настил ложится на z=2 над x∈[0,4], y∈[-4,0].
 * Буфер — data-URI, соседние файлы не нужны. Байты Float32Array — порядок
 * платформы; accessor'ы glTF little-endian, и тесты гоняются только на
 * LE-платформах, как и весь остальной репозиторий.
 */
function buildDeckGltf(): ArrayBuffer {
  const positions = Float32Array.from([0, 2, 0, 4, 2, 0, 4, 2, 4, 0, 2, 4]);
  const indices = Uint16Array.from([0, 1, 2, 0, 2, 3]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Deck', mesh: 0 }],
    meshes: [{ name: 'DeckMesh', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [
      {
        uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
        byteLength: bin.length,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function loadDeck(): Promise<NormalizedModel> {
  return gltfLoader.load(buildDeckGltf(), {
    id: 'decor/deck.gltf',
    read: () => Promise.reject(new Error('соседние файлы фикстуре не нужны')),
  });
}

describe('modelSurfaceIndex (ASSET-11)', () => {
  it('вертикальный луч сверху возвращает верхнюю поверхность: точку, t и нормаль', () => {
    // Настил на z=2 над «лощиной» z=1: ближайшее пересечение луча вниз — верх.
    const model = makeModel([quad(2, 0, 0, 4, 4), quad(1, -1, -1, 5, 5)]);
    const index = modelSurfaceIndex(model);

    const hit = index.raycast(1, 1, 10, 0, 0, -1);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(8, 9);
    expect(hit!.point[0]).toBeCloseTo(1, 9);
    expect(hit!.point[1]).toBeCloseTo(1, 9);
    expect(hit!.point[2]).toBeCloseTo(2, 9);
    expect(hit!.normal[0]).toBeCloseTo(0, 9);
    expect(hit!.normal[1]).toBeCloseTo(0, 9);
    expect(hit!.normal[2]).toBeCloseTo(1, 9);

    // «Верх под точкой» — тот же запрос: над настилом — настил, рядом — лощина.
    expect(index.topAt(2, 2)!.point[2]).toBeCloseTo(2, 9);
    expect(index.topAt(-0.5, -0.5)!.point[2]).toBeCloseTo(1, 9);
  });

  it('нормаль ориентирована навстречу лучу: снизу вверх низ виден с нормалью вниз', () => {
    const model = makeModel([quad(2, 0, 0, 4, 4), quad(1, -1, -1, 5, 5)]);
    const hit = modelSurfaceIndex(model).raycast(1, 1, -5, 0, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit!.point[2]).toBeCloseTo(1, 9);
    expect(hit!.normal[2]).toBeCloseTo(-1, 9);
  });

  it('t — в единицах длины direction: ненормированный луч даёт t вдвое меньше', () => {
    const model = makeModel([quad(2, 0, 0, 4, 4)]);
    const hit = modelSurfaceIndex(model).raycast(1, 1, 10, 0, 0, -2);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(4, 9);
    expect(hit!.point[2]).toBeCloseTo(2, 9);
  });

  it('наклонная поверхность: барицентрическая точка и нормаль треугольника', () => {
    // Рампа из z=0 (y=0) в z=2 (y=2): нормаль — normalize(0, -1, 1).
    const ramp = makeModel([
      { positions: [0, 0, 0, 2, 0, 0, 2, 2, 2, 0, 2, 2], indices: [0, 1, 2, 0, 2, 3] },
    ]);
    const hit = modelSurfaceIndex(ramp).topAt(1, 1);
    expect(hit).not.toBeNull();
    expect(hit!.point[2]).toBeCloseTo(1, 6);
    expect(hit!.normal[0]).toBeCloseTo(0, 6);
    expect(hit!.normal[1]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(hit!.normal[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('невертикальный луч: побеждает ближайшее из двух пересечений', () => {
    // Две «стены» в плоскости YZ на x=1 и x=3; луч вдоль +X бьёт в ближнюю.
    const wall = (x: number): MeshData => ({
      positions: [x, 0, 0, x, 2, 0, x, 2, 2, x, 0, 2],
      indices: [0, 1, 2, 0, 2, 3],
    });
    const hit = modelSurfaceIndex(makeModel([wall(3), wall(1)])).raycast(0, 1, 1, 1, 0, 0);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(1, 9);
    expect(hit!.point[0]).toBeCloseTo(1, 9);
    expect(hit!.normal[0]).toBeCloseTo(-1, 9);
  });

  it('glTF-настил: загрузка и вертикальная выборка в Node, без браузера', async () => {
    const deck = await loadDeck();
    const index = modelSurfaceIndex(deck);
    expect(index.triangleCount).toBe(2);

    // Канонизация Y-вверх → Z-вверх уложила настил на z=2 над y∈[-4,0].
    const hit = index.topAt(1, -1);
    expect(hit).not.toBeNull();
    expect(hit!.point[2]).toBeCloseTo(2, 6);
    expect(hit!.normal[2]).toBeCloseTo(1, 6);

    const ray = index.raycast(3, -3, 7, 0, 0, -1);
    expect(ray).not.toBeNull();
    expect(ray!.t).toBeCloseTo(5, 6);
  });

  it('индекс разделяется потребителями одного ассета и не путается между ассетами', async () => {
    const deck = await loadDeck();
    // Два независимых потребителя (десять мостов одной модели) — один индекс:
    // повторное обращение возвращает тот же объект, структура не перестраивается.
    const first = modelSurfaceIndex(deck);
    const second = modelSurfaceIndex(deck);
    expect(second).toBe(first);

    const other = makeModel([quad(1, 0, 0, 1, 1)]);
    expect(modelSurfaceIndex(other)).not.toBe(first);
    expect(modelSurfaceIndex(other)).toBe(modelSurfaceIndex(other));
  });

  it('hiddenParts: скрытая часть в индекс не попадает — поверхность совпадает с нарисованной (REND-9)', () => {
    // Часть 0 — настил на z=2, часть 1 — «лощина» на z=1.
    const model = makeModel([quad(2, 0, 0, 4, 4), quad(1, -1, -1, 5, 5)]);
    const full = modelSurfaceIndex(model);
    expect(full.triangleCount).toBe(4);
    expect(full.topAt(2, 2)!.point[2]).toBeCloseTo(2, 9);

    // Настил скрыт записью манифеста: верх под той же точкой — нижняя часть,
    // границы — только по видимой геометрии.
    const partial = modelSurfaceIndex(model, [0]);
    expect(partial.triangleCount).toBe(2);
    expect(partial.topAt(2, 2)!.point[2]).toBeCloseTo(1, 9);
    expect([...partial.bounds!.max]).toEqual([5, 5, 1]);

    // Пустой список скрытых — то же, что отсутствие аргумента: индекс общий.
    expect(modelSurfaceIndex(model, [])).toBe(full);
  });

  it('индекс кэшируется по набору скрытых частей: порядок и дубли — не различия (ASSET-11)', () => {
    const model = makeModel([quad(2, 0, 0, 4, 4), quad(1, -1, -1, 5, 5)]);
    // Десять мостов одной записи — один индекс: тот же набор в любом порядке.
    const first = modelSurfaceIndex(model, [1, 0]);
    expect(modelSurfaceIndex(model, [0, 1, 1])).toBe(first);
    // Другой набор частей и полный индекс — другие структуры.
    expect(modelSurfaceIndex(model, [0])).not.toBe(first);
    expect(modelSurfaceIndex(model)).not.toBe(first);
    expect(modelSurfaceIndex(model)).not.toBe(modelSurfaceIndex(model, [0]));
  });

  it('модель без треугольников — «нет пересечения», не ошибка', () => {
    const empty = makeModel([]);
    const index = modelSurfaceIndex(empty);
    expect(index.triangleCount).toBe(0);
    expect(index.bounds).toBeNull();
    expect(index.raycast(0, 0, 10, 0, 0, -1)).toBeNull();
    expect(index.topAt(0, 0)).toBeNull();

    // Меш с вершинами, но без единого треугольника — тот же ответ.
    const noTriangles = makeModel([{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [] }]);
    expect(modelSurfaceIndex(noTriangles).raycast(0, 0, 10, 0, 0, -1)).toBeNull();
  });

  it('вырожденный треугольник пропускается, промах мимо геометрии — null', () => {
    const degenerate = makeModel([
      { positions: [0, 0, 0, 0, 0, 0, 1, 1, 1], indices: [0, 1, 2] },
    ]);
    expect(modelSurfaceIndex(degenerate).raycast(0.5, 0.5, 5, 0, 0, -1)).toBeNull();

    const deck = makeModel([quad(2, 0, 0, 4, 4)]);
    const index = modelSurfaceIndex(deck);
    expect(index.raycast(10, 10, 10, 0, 0, -1)).toBeNull(); // вертикаль мимо bbox
    expect(index.raycast(1, 1, 10, 0, 0, 1)).toBeNull(); // от поверхности прочь
    expect(index.topAt(5, 5)).toBeNull(); // вне XY-границ
  });

  it('bounds — AABB геометрии в канонических осях', () => {
    const model = makeModel([quad(2, 0, 0, 4, 4), quad(1, -1, -1, 5, 5)]);
    const b = modelSurfaceIndex(model).bounds;
    expect(b).not.toBeNull();
    expect([...b!.min]).toEqual([-1, -1, 1]);
    expect([...b!.max]).toEqual([5, 5, 2]);
  });

  it('лестница из 128 треугольников: обход BVH согласован с геометрией', () => {
    // 8×8 клеток-ступеней высотой z = ix + 8·iy одним мешом — дерево делится
    // и по X, и по Y, и каждая вертикаль обязана найти ровно свою ступень.
    const positions: number[] = [];
    const indices: number[] = [];
    const zOf = (ix: number, iy: number): number => ix + 8 * iy;
    for (let iy = 0; iy < 8; iy++) {
      for (let ix = 0; ix < 8; ix++) {
        const v = positions.length / 3;
        const z = zOf(ix, iy);
        positions.push(ix, iy, z, ix + 1, iy, z, ix + 1, iy + 1, z, ix, iy + 1, z);
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
    const index = modelSurfaceIndex(makeModel([{ positions, indices }]));
    expect(index.triangleCount).toBe(128);
    for (let iy = 0; iy < 8; iy++) {
      for (let ix = 0; ix < 8; ix++) {
        const hit = index.topAt(ix + 0.5, iy + 0.5);
        expect(hit).not.toBeNull();
        expect(hit!.point[2]).toBeCloseTo(zOf(ix, iy), 6);
      }
    }
  });

  it('out переиспользуется: возвращается переданный объект, без аллокации', () => {
    const model = makeModel([quad(2, 0, 0, 4, 4)]);
    const index = modelSurfaceIndex(model);
    const out = freshHit();
    expect(index.raycast(1, 1, 10, 0, 0, -1, out)).toBe(out);
    expect(out.point[2]).toBeCloseTo(2, 9);
    expect(index.topAt(2, 2, out)).toBe(out);
    // Промах переданный out не трогает и возвращает null.
    expect(index.raycast(10, 10, 10, 0, 0, -1, out)).toBeNull();
    expect(out.point[2]).toBeCloseTo(2, 9);
  });
});
