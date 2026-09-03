/**
 * Клеточные слои источника: карты ассета террейна (BLND-9) и карта кривизны
 * (BLND-10) — чтение сетки, дискретность уровней, валидация той же реализацией,
 * что у кистей ED-10/ED-11, и квантование узловых смещений к решётке 1/32.
 *
 * Blender не зовётся ни в какой форме (BLND-7): сетки строятся в памяти из
 * читаемых карт (`support.ts`), а бинарный чанк — тот же, что собрал бы
 * экспортёр.
 */
import { describe, expect, it } from 'vitest';
import { parseGltf } from '../src/gltf.js';
import { generateCellLayer, withCellLayer } from '../src/maps.js';
import { generateSpatialLayer } from '../src/layer.js';
import { normalizeDocument } from '../src/normalize.js';
import { readCellGrid, NOFLOOR_CHANNEL, RAMP_CHANNEL } from '../src/cells.js';
import type { CellLayer } from '../src/maps.js';
import {
  CURVATURE_GRID,
  CURVATURE_ROWS,
  ZERO_CURVATURE_ROWS,
  TARGET_TERRAIN,
  TERRAIN_FLAGS,
  TERRAIN_GRID,
  TERRAIN_LEVELS,
  context,
  curvatureHeights,
  flagCells,
  gridGlb,
  gridGltf,
  gridSource,
  levelHeights,
  objectsOf,
  paintCells,
  packGlb,
  type GridObjectSpec,
} from './support.js';

/** Слой клеточных данных от набора grid-объектов — через контейнер `.glb`. */
function cellsOf(
  specs: readonly GridObjectSpec[],
  overrides: Parameters<typeof context>[0] = { terrain: TARGET_TERRAIN },
): CellLayer {
  const document = parseGltf(gridGlb(specs));
  return generateCellLayer(document, normalizeDocument(document), context(overrides));
}

const messages = (layer: CellLayer, severity: 'error' | 'warning'): string[] =>
  layer.findings.filter((finding) => finding.severity === severity).map((finding) => `${finding.object}: ${finding.message}`);

describe('BLND-9: карты террейна из клеточных данных', () => {
  it('высоты вершин дают карту уровней, атрибуты — карту вида клеток', () => {
    const layer = cellsOf([TERRAIN_GRID]);

    expect(messages(layer, 'error')).toEqual([]);
    expect(layer.terrain).toEqual({ levels: [...TERRAIN_LEVELS], flags: [...TERRAIN_FLAGS] });
  });

  it('клеточные данные читаются и из бинарного чанка, и из data:-URI одинаково', () => {
    const glb = parseGltf(gridGlb([TERRAIN_GRID]));
    const gltf = parseGltf(gridGltf([TERRAIN_GRID]));

    const fromGlb = generateCellLayer(glb, normalizeDocument(glb), context({ terrain: TARGET_TERRAIN }));
    const fromGltf = generateCellLayer(gltf, normalizeDocument(gltf), context({ terrain: TARGET_TERRAIN }));

    expect(fromGlb.terrain).toEqual(fromGltf.terrain);
  });

  it('направление разреза квада на адрес клетки не влияет: адресует охватывающий прямоугольник', () => {
    const straight = cellsOf([TERRAIN_GRID]);
    const flipped = cellsOf([{ ...TERRAIN_GRID, flipDiagonal: true }]);

    expect(flipped.terrain).toEqual(straight.terrain);
  });

  it('сваренные вершины соседних клеток сетку не ломают', () => {
    // Экспортёр вправе слить вершины с совпадающими позицией и атрибутами.
    // Сетка 2×1 на одном уровне, у которой общая сторона — две вершины, а не
    // четыре: адрес клетки по-прежнему берётся с грани.
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'welded', mesh: 0, extras: { terrain: 1 } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' },
        { bufferView: 1, componentType: 5125, count: 12, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 72 },
        { buffer: 0, byteOffset: 72, byteLength: 48 },
      ],
      buffers: [{ byteLength: 120 }],
    };
    const positions = Float32Array.from([
      0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, -1, 1, 0, -1, 2, 0, -1,
    ]);
    const indices = Uint32Array.from([0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]);
    const binary = new Uint8Array(120);
    binary.set(new Uint8Array(positions.buffer), 0);
    binary.set(new Uint8Array(indices.buffer), 72);
    const document = parseGltf(packGlb(json, binary));
    const objects = normalizeDocument(document);

    const read = readCellGrid(document, objects[0]!, { width: 2, height: 1, cellSize: 1 }, [RAMP_CHANNEL]);

    expect(read.errors).toEqual([]);
    expect(read.grid?.heights).toEqual([0, 0]);
    expect(read.grid?.channels[RAMP_CHANNEL]).toEqual([0, 0]);
  });

  it('высота между уровнями — ошибка с адресом клетки, а не округление', () => {
    const heights = levelHeights(TERRAIN_LEVELS);
    heights[2]![1] = 1.4;

    const layer = cellsOf([{ ...TERRAIN_GRID, heights }]);

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error')).toEqual([
      expect.stringContaining('terrain: клетка (1, 2): высота 1.4'),
    ]);
    expect(messages(layer, 'error')[0]).toContain('BLND-9');
  });

  it('уровень вне диапазона алфавита — ошибка с адресом клетки (TERR-3)', () => {
    const heights = levelHeights(TERRAIN_LEVELS);
    heights[0]![0] = 16;

    const layer = cellsOf([{ ...TERRAIN_GRID, heights }]);

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error')[0]).toContain('клетка (0, 0): уровень 16 вне диапазона [0, 15]');
  });

  it('клетка, помеченная и рампой, и снятым полом, — ошибка: вид клетки один (TERR-3)', () => {
    const layer = cellsOf([
      { ...TERRAIN_GRID, ramp: flagCells(TERRAIN_FLAGS, '^'), noFloor: flagCells(TERRAIN_FLAGS, '^') },
    ]);

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error')[0]).toContain('помечена и рампой, и снятым полом');
  });

  it('сетка другого размера — отказ с именем объекта и размерами (TERR-2)', () => {
    const layer = cellsOf([
      { name: 'terrain', semantic: 'terrain', heights: levelHeights(['000', '000', '000']) },
    ]);

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error').join('\n')).toContain('4×4');
  });

  it('сцена без ассета террейна: сетки нет, и импорт её не выдумывает', () => {
    const layer = cellsOf([TERRAIN_GRID], { terrain: null });

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error')[0]).toContain('нет ассета террейна');
  });

  it('источник без terrain-объекта клеточного слоя не даёт вовсе (BLND-2)', () => {
    const layer = cellsOf([CURVATURE_GRID]);

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error')).toEqual([]);
  });

  it('terrain-объектов несколько — отказ: сетка у сцены одна', () => {
    const layer = cellsOf([TERRAIN_GRID, { ...TERRAIN_GRID, name: 'terrain-second' }]);

    expect(layer.terrain).toBeUndefined();
    expect(messages(layer, 'error')[0]).toContain('несколько');
  });
});

describe('BLND-9, TERR-7: валидация — та же реализация, что у кисти ED-10', () => {
  it('рампа в одну клетку отказывает вызовом createTerrainGrid', () => {
    const flags = ['....', '.^..', '....', '....'];
    const layer = cellsOf([
      {
        ...TERRAIN_GRID,
        heights: levelHeights(['0000', '0000', '1111', '1111']),
        ramp: flagCells(flags, '^'),
        noFloor: flagCells(flags, '_'),
      },
    ]);

    expect(layer.terrain).toBeUndefined();
    const error = messages(layer, 'error')[0]!;
    expect(error).toContain('createTerrainGrid');
    // Сообщение — дословно ядра: адрес клетки и номер требования приходят из
    // него, а не из второй формулировки рядом.
    expect(error).toContain('TERR-7');
    expect(error).toContain('(1, 1)');
  });
});

describe('BLND-10: карта кривизны из узловых данных', () => {
  it('узловые смещения квантуются к решётке 1/32 (ASSET-7)', () => {
    const layer = cellsOf([CURVATURE_GRID]);

    expect(messages(layer, 'error')).toEqual([]);
    expect(layer.curvature).toEqual({ width: 4, height: 4, rows: [...CURVATURE_ROWS] });
  });

  it('промежуточное смещение садится на ближайшую ступень симметрично знаку', () => {
    const rows = curvatureHeights(ZERO_CURVATURE_ROWS);
    // 2.4/32 и −2.4/32: обе ступени обязаны получиться второй, а не разными.
    rows[0] = [2.4 / 32, -2.4 / 32, 0, 0, 0];
    const layer = cellsOf([{ ...CURVATURE_GRID, heights: rows }]);

    expect(layer.curvature?.rows[0]).toEqual([2, -2, 0, 0, 0]);
  });

  it('амплитуда сверх шага уровня переносится как есть: ни клампа, ни предупреждения (BLND-10)', () => {
    const rows = curvatureHeights(ZERO_CURVATURE_ROWS);
    rows[0] = [40 / 32, 0, 0, 0, 0];
    rows[1] = [-77 / 32, 0, 0, 0, 0];
    const layer = cellsOf([{ ...CURVATURE_GRID, heights: rows }]);

    expect(messages(layer, 'error')).toEqual([]);
    expect(layer.curvature?.rows[0]).toEqual([40, 0, 0, 0, 0]);
    expect(layer.curvature?.rows[1]).toEqual([-77, 0, 0, 0, 0]);
    expect(messages(layer, 'warning')).toEqual([]);
  });

  it('манифест не адресует карту кривизны — отказ с именем объекта, а не молчание', () => {
    const layer = cellsOf([CURVATURE_GRID], { terrain: TARGET_TERRAIN, curvatureMap: null });

    expect(layer.curvature).toBeUndefined();
    expect(messages(layer, 'error')[0]).toContain('curvature: манифест визуалов не адресует карту кривизны');
  });

  it('curvature-объект не даёт слоя террейна, terrain-объект — слоя кривизны', () => {
    const both = cellsOf([TERRAIN_GRID, CURVATURE_GRID]);

    expect(both.terrain).toBeDefined();
    expect(both.curvature).toBeDefined();
    expect(cellsOf([CURVATURE_GRID]).terrain).toBeUndefined();
    expect(cellsOf([TERRAIN_GRID]).curvature).toBeUndefined();
  });
});

describe('BLND-14: карта раскраски клеток из канала источника', () => {
  /** Раскраска 4×4: два слота полосами — на границе виден шов, ради которого всё. */
  const PAINT_ROWS: readonly string[] = ['0011', '0011', '0011', '0011'];

  const painted = (rows: readonly string[] = PAINT_ROWS): GridObjectSpec => ({
    ...TERRAIN_GRID,
    paint: paintCells(rows),
  });

  it('канал раскраски даёт карту слотов рядами; ассет террейна тем же чтением', () => {
    const layer = cellsOf([painted()]);
    expect(messages(layer, 'error')).toEqual([]);
    expect(layer.paint).toEqual({ width: 4, height: 4, rows: [...PAINT_ROWS] });
    // Карты террейна тот же объект даёт по-прежнему: раскраска едет РЯДОМ с
    // рампой и полом, потому что красится та же клетка (BLND-14).
    expect(layer.terrain).toEqual({ levels: [...TERRAIN_LEVELS], flags: [...TERRAIN_FLAGS] });
  });

  it('источник без канала раскраски карты не даёт вовсе — документ не переписывается', () => {
    // Нули отсутствующего канала неотличимы от нарисованных, поэтому слот
    // берётся по НАЛИЧИЮ канала, а не по значениям (BLND-2).
    const layer = cellsOf([TERRAIN_GRID]);
    expect(messages(layer, 'error')).toEqual([]);
    expect(layer.paint).toBeUndefined();
  });

  it('клетка без пола раскраску сохраняет: вернувшийся пол вернётся своим слотом', () => {
    // Клетка (0, 0) снята флагом `_` (TERRAIN_FLAGS), и слот у неё свой.
    const layer = cellsOf([painted(['1011', '0011', '0011', '0011'])]);
    expect(messages(layer, 'error')).toEqual([]);
    expect(layer.paint?.rows[0]).toBe('1011');
  });

  it('манифест без карты раскраски — отказ с именем ключа, а не молчаливый пропуск', () => {
    const layer = cellsOf([painted()], { terrain: TARGET_TERRAIN, paintMap: null });
    expect(messages(layer, 'error').join('\n')).toContain('terrain.paintMap');
    expect(layer.paint).toBeUndefined();
  });

  it('дробное значение канала — отказ с адресом клетки, а не округление', () => {
    const rows = paintCells(PAINT_ROWS);
    rows[1]![2] = 1.4;
    const layer = cellsOf([{ ...TERRAIN_GRID, paint: rows }]);
    expect(messages(layer, 'error').join('\n')).toContain('клетка (2, 1)');
    expect(messages(layer, 'error').join('\n')).toContain('не разрешается в целый индекс слота');
    expect(layer.paint).toBeUndefined();
  });

  it('слот вне алфавита карты — отказ с адресом клетки', () => {
    const rows = paintCells(PAINT_ROWS);
    rows[0]![0] = 12;
    const layer = cellsOf([{ ...TERRAIN_GRID, paint: rows }]);
    expect(messages(layer, 'error').join('\n')).toContain('клетка (0, 0)');
    expect(messages(layer, 'error').join('\n')).toContain('вне алфавита');
  });

  it('расхождение вершин одной клетки — ошибка с её адресом, а не большинство голосов', () => {
    // Тот же читатель, что у рампы и пола: значение клетки — единогласие её
    // вершин (BLND-14), и правило у всех каналов одно. Одна вершина правится
    // прямо в бинарном чанке — так выглядела бы правка мимо кисти аддона.
    const source = gridSource([painted()]);
    const json = source.json as unknown as {
      meshes: { primitives: { attributes: Record<string, number> }[] }[];
      accessors: { bufferView: number }[];
      bufferViews: { byteOffset?: number }[];
    };
    const accessor = json.accessors[json.meshes[0]!.primitives[0]!.attributes._PAINT!]!;
    const offset = json.bufferViews[accessor.bufferView]!.byteOffset ?? 0;
    // Вершина 1 — второй угол первой клетки: её слот расходится с остальными.
    new DataView(source.binary.buffer, source.binary.byteOffset).setFloat32(offset + 4, 3, true);

    const document = parseGltf(packGlb(source.json, source.binary));
    const layer = generateCellLayer(document, normalizeDocument(document), context({ terrain: TARGET_TERRAIN }));
    expect(messages(layer, 'error').join('\n')).toContain('клетка (0, 0)');
    expect(messages(layer, 'error').join('\n')).toContain('_PAINT');
    expect(layer.paint).toBeUndefined();
  });
});

describe('BLND-6: клеточные слои складываются в один целевой слой', () => {
  it('находки обоих слоёв едут вместе, а размещения остаются на месте', () => {
    const objects = objectsOf('placements.gltf');
    const cells = cellsOf([TERRAIN_GRID]);

    const merged = withCellLayer(generateSpatialLayer(objects, context()), cells);

    expect(merged.initial.length).toBeGreaterThan(0);
    expect(merged.terrain).toEqual(cells.terrain);
    expect(merged.findings.length).toBe(cells.findings.length);
  });
});

describe('BLND-9: клетки без граней и грани мимо сетки', () => {
  it('грань, чей центр не попадает в центр клетки, — отказ о сдвинутой сетке', () => {
    const document = parseGltf(gridGlb([{ ...TERRAIN_GRID, cellSize: 1.5 }]));
    const objects = normalizeDocument(document);

    const read = readCellGrid(document, objects[0]!, { width: 4, height: 4, cellSize: 1 }, [
      RAMP_CHANNEL,
      NOFLOOR_CHANNEL,
    ]);

    expect(read.grid).toBeNull();
    expect(read.errors.join('\n')).toMatch(/не попадает в центр клетки|вне сетки/);
  });

  it('примитив без атрибутов — та же находка о непокрытых клетках, а не TypeError', () => {
    // `attributes` объявлен форматом обязательным, но документ приезжает
    // разбором чужого JSON. Сломанный экспорт не должен кончаться безымянной
    // ошибкой среды: BLND-6 требует внятной находки, и она здесь та же самая,
    // что у сетки без граней, — потому что для конвейера это одно и то же.
    const source = gridSource([TERRAIN_GRID]);
    const meshes = source.json.meshes as { primitives: Record<string, unknown>[] }[];
    delete meshes[0]!.primitives[0]!.attributes;
    const document = parseGltf(packGlb(source.json, source.binary));
    const objects = normalizeDocument(document);

    const read = readCellGrid(document, objects[0]!, { width: 4, height: 4, cellSize: 1 });

    expect(read.grid).toBeNull();
    expect(read.errors.join('\n')).toContain('не покрыта гранями целиком');
  });

  it('сетка мельче ассета — отказ, называющий непокрытые клетки', () => {
    const document = parseGltf(
      gridGlb([{ name: 'terrain', semantic: 'terrain', heights: [[0, 0, 0, 0]] }]),
    );
    const objects = normalizeDocument(document);

    const read = readCellGrid(document, objects[0]!, { width: 4, height: 4, cellSize: 1 });

    expect(read.grid).toBeNull();
    expect(read.errors.join('\n')).toContain('не покрыта гранями целиком');
  });
});
