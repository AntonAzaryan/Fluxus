/**
 * Разбор экспорта: обе формы glTF и то подмножество, которое читает конвейер
 * (BLND-3, design 2). Blender не вызывается — фикстуры закоммичены (BLND-7).
 */
import { describe, expect, it } from 'vitest';
import {
  GltfParseError,
  isGlb,
  meshPositions,
  nodesOf,
  parseGlb,
  parseGltf,
  readAccessor,
  readMeshGeometry,
  rootNodesOf,
} from '../src/gltf.js';
import { TERRAIN_GRID, fixture, fixtureBytes, gridGlb, gridSource, packGlb } from './support.js';

describe('BLND-3: разбор .gltf', () => {
  it('узлы читаются с именем, трансформом и extras', () => {
    const nodes = nodesOf(fixture('placements.gltf'));
    expect(nodes.map((node) => node.name)).toEqual([
      'zeta-hero',
      'alpha-hero',
      'beta-statue',
      'marker-center',
    ]);
    expect(nodes[0]?.extras).toEqual({ prefab: 'Hero', 'Player.slot': 1, 'Locomotion.maxSpeed': 0.5 });
    expect(nodes[3]?.extras).toBeUndefined();
  });

  it('корни сцены берутся из объявленной сцены, а не из всех узлов подряд', () => {
    expect(rootNodesOf(fixture('axes.gltf'))).toEqual([0, 1, 2]);
  });

  it('документ, не разбирающийся как JSON, — отказ, а не пустой результат', () => {
    expect(() => parseGltf(new TextEncoder().encode('{'))).toThrow(GltfParseError);
  });
});

describe('BLND-9/BLND-10: позиции вершин grid-меша', () => {
  it('аксессор читается из data:-URI буфера', () => {
    const positions = meshPositions(fixture('grid.gltf'), 0);
    expect(positions).toHaveLength(9);
    // Сетка 3×3: столбец задаёт x, строка — z, высота — y (см. CONVENTIONS.md).
    expect(positions[0]).toEqual([0, 0, 0]);
    expect(positions[4]).toEqual([1, 1, -1]);
    expect(positions[8]).toEqual([2, 2, -2]);
  });

  it('геометрия отдаёт грани и пользовательские каналы вершин', () => {
    const geometry = readMeshGeometry(parseGltf(gridGlb([TERRAIN_GRID])), 0, ['_RAMP', '_NOFLOOR', '_ABSENT']);

    // Сетка 4×4 отдельными квадами: 16 клеток по 4 вершины и по 2 треугольника.
    expect(geometry.positions).toHaveLength(64);
    expect(geometry.triangles).toHaveLength(96);
    expect(geometry.attributes._RAMP).toHaveLength(64);
    // Канала нет ни у одного примитива — `null`, а не молчаливые нули: «нет
    // канала» и «канал из нулей» для конвенции одно и то же, но врать про
    // прочитанное парсер не должен.
    expect(geometry.attributes._ABSENT).toBeNull();
  });

  it('примитив не-треугольного режима — отказ: клеточные данные читаются с граней', () => {
    const source = gridSource([TERRAIN_GRID]);
    const meshes = source.json.meshes as { primitives: { mode: number }[] }[];
    meshes[0]!.primitives[0]!.mode = 1;
    expect(() => readMeshGeometry(parseGltf(packGlb(source.json, source.binary)), 0)).toThrow(/mode 4/);
  });

  it('примитив без атрибутов пропускается, а не роняет разбор безымянным TypeError', () => {
    // Формат объявляет `attributes` обязательным, но документ приезжает
    // разбором чужого JSON: сломанный экспорт вправе его не иметь. Такой
    // примитив проходит той же веткой, что и примитив без `POSITION`, —
    // пропускается; о непокрытых адресах сообщает вызывающий находкой (BLND-6),
    // а не средой исполнения.
    const source = gridSource([TERRAIN_GRID]);
    const meshes = source.json.meshes as { primitives: Record<string, unknown>[] }[];
    delete meshes[0]!.primitives[0]!.attributes;
    const geometry = readMeshGeometry(parseGltf(packGlb(source.json, source.binary)), 0);

    // Все клетки сетки лежат в одном примитиве, поэтому без его атрибутов меш
    // отдаёт пустую геометрию — но отдаёт, а не роняет разбор.
    expect(geometry.positions).toHaveLength(0);
    expect(geometry.triangles).toHaveLength(0);
  });

  it('буфер внешним файлом — честный отказ с причиной, а не молчаливые нули', () => {
    const document = {
      json: {
        accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
        bufferViews: [{ buffer: 0, byteLength: 12 }],
        buffers: [{ byteLength: 12, uri: 'grid.bin' }],
      },
      binaryChunk: null,
    } as const;
    expect(() => readAccessor(document, 0)).toThrow(/внешним файлом/);
  });
});

describe('BLND-3: разбор контейнера .glb', () => {
  const json = JSON.parse(new TextDecoder().decode(fixtureBytes('placements.gltf'))) as unknown;

  it('форма определяется содержимым, а не расширением файла', () => {
    expect(isGlb(fixtureBytes('placements.gltf'))).toBe(false);
    expect(isGlb(packGlb(json))).toBe(true);
  });

  it('контейнер даёт тот же документ, что и текстовая форма', () => {
    expect(parseGltf(packGlb(json)).json).toEqual(parseGltf(fixtureBytes('placements.gltf')).json);
  });

  it('бинарный чанк достаётся буферу без "uri"', () => {
    const binary = new Uint8Array(12);
    new DataView(binary.buffer).setFloat32(0, 1.5, true);
    const packed = packGlb(
      {
        accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
        bufferViews: [{ buffer: 0, byteLength: 12 }],
        buffers: [{ byteLength: 12 }],
      },
      binary,
    );
    expect(readAccessor(parseGlb(packed), 0)).toEqual([[1.5, 0, 0]]);
  });

  it('контейнер чужой версии — отказ', () => {
    const packed = packGlb(json);
    new DataView(packed.buffer).setUint32(4, 1, true);
    expect(() => parseGlb(packed)).toThrow(/версия контейнера/);
  });
});
