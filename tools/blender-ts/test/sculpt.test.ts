/**
 * Скалпт-поверхность как источник рельефа (BLND-13): объединение sculpt-мешей,
 * квантование уровней, пол из дыр, по-граничное правило рамп, остаток кривизны
 * и взаимоисключение с grid-объектами.
 *
 * Blender не зовётся ни в какой форме (BLND-7): меши собираются в память как
 * треугольники в мировых величинах конвейера и пакуются в `.glb` тем же
 * контейнером, что у grid-фикстур.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '@game-mvp/editor-core';
import { parseGltf } from '../src/gltf.js';
import { runImport } from '../src/importer.js';
import { generateCellLayer, type CellLayer } from '../src/maps.js';
import { generateSpatialLayer } from '../src/layer.js';
import { normalizeDocument } from '../src/normalize.js';
import {
  CURVATURE_ID,
  MANIFEST_ID,
  PRESENTATION_ID,
  SCENE_ID,
  SOURCE_ID,
  TARGET_TERRAIN,
  TERRAIN_ASSET,
  contentFiles,
  context,
  curvatureDocument,
  packGlb,
  presentationDocument,
  sceneDocument,
} from './support.js';

/** Треугольник в мировых величинах: [x, y, elevation] на вершину. */
type WorldTriangle = readonly (readonly [number, number, number])[];

interface SculptNodeSpec {
  readonly name: string;
  readonly triangles: readonly WorldTriangle[];
  readonly extras?: Record<string, unknown>;
}

/** Горизонтальная пластина [x0..x1]×[y0..y1] на высоте `h` — два треугольника. */
function plate(x0: number, y0: number, x1: number, y1: number, h: number): WorldTriangle[] {
  return [
    [
      [x0, y0, h],
      [x1, y0, h],
      [x1, y1, h],
    ],
    [
      [x0, y0, h],
      [x1, y1, h],
      [x0, y1, h],
    ],
  ];
}

/** Блок: крышка на `top`, дно на `bottom` и четыре вертикальные стенки. */
function box(x0: number, y0: number, x1: number, y1: number, bottom: number, top: number): WorldTriangle[] {
  const wall = (ax: number, ay: number, bx: number, by: number): WorldTriangle[] => [
    [
      [ax, ay, bottom],
      [bx, by, bottom],
      [bx, by, top],
    ],
    [
      [ax, ay, bottom],
      [bx, by, top],
      [ax, ay, top],
    ],
  ];
  return [
    ...plate(x0, y0, x1, y1, top),
    ...plate(x0, y0, x1, y1, bottom),
    ...wall(x0, y0, x1, y0),
    ...wall(x1, y0, x1, y1),
    ...wall(x1, y1, x0, y1),
    ...wall(x0, y1, x0, y0),
  ];
}

/** Наклонная пластина: высота — линейная функция `h(x, y) = base + gx·x + gy·y`. */
function slope(x0: number, y0: number, x1: number, y1: number, base: number, gx: number, gy: number): WorldTriangle[] {
  const at = (x: number, y: number): readonly [number, number, number] => [x, y, base + gx * x + gy * y];
  return [
    [at(x0, y0), at(x1, y0), at(x1, y1)],
    [at(x0, y0), at(x1, y1), at(x0, y1)],
  ];
}

/**
 * `.glb` из sculpt-объектов: мировые `(x, y, elevation)` пакуются в glTF как
 * `(x, elevation, −y)` — то же соответствие осей, что читает `worldPoint`.
 */
function sculptGlb(nodes: readonly SculptNodeSpec[]): Uint8Array {
  const buffers: Uint8Array[] = [];
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const meshes: unknown[] = [];
  const gltfNodes: unknown[] = [];
  let byteOffset = 0;

  for (const node of nodes) {
    if (node.triangles.length === 0) {
      // Узел без геометрии — empty Blender с семантикой (цель проверки BLND-13).
      gltfNodes.push({ name: node.name, extras: node.extras ?? { sculpt: 1 } });
      continue;
    }
    const positions: number[] = [];
    const indices: number[] = [];
    for (const triangle of node.triangles) {
      for (const [x, y, elevation] of triangle) {
        indices.push(positions.length / 3);
        positions.push(x, elevation, -y);
      }
    }
    const positionBytes = new Uint8Array(Float32Array.from(positions).buffer);
    const indexBytes = new Uint8Array(Uint32Array.from(indices).buffer);
    const positionView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: positionBytes.byteLength });
    byteOffset += positionBytes.byteLength;
    const indexView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: indexBytes.byteLength });
    byteOffset += indexBytes.byteLength;
    buffers.push(positionBytes, indexBytes);
    const positionAccessor = accessors.length;
    accessors.push({ bufferView: positionView, componentType: 5126, count: positions.length / 3, type: 'VEC3' });
    const indexAccessor = accessors.length;
    accessors.push({ bufferView: indexView, componentType: 5125, count: indices.length, type: 'SCALAR' });
    const mesh = meshes.length;
    meshes.push({ primitives: [{ attributes: { POSITION: positionAccessor }, indices: indexAccessor, mode: 4 }] });
    gltfNodes.push({ name: node.name, mesh, extras: node.extras ?? { sculpt: 1 } });
  }

  const binary = new Uint8Array(byteOffset);
  let cursor = 0;
  for (const bytes of buffers) {
    binary.set(bytes, cursor);
    cursor += bytes.byteLength;
  }
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: gltfNodes.map((_, index) => index) }],
    nodes: gltfNodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  return packGlb(json, binary);
}

function cellsOf(glb: Uint8Array, overrides: Parameters<typeof context>[0] = { terrain: TARGET_TERRAIN }): CellLayer {
  const document = parseGltf(glb);
  return generateCellLayer(document, normalizeDocument(document), context(overrides));
}

const errorsOf = (layer: CellLayer): string[] =>
  layer.findings.filter((finding) => finding.severity === 'error').map((finding) => `${finding.object}: ${finding.message}`);

/** Арена 4×4 клетки размера 1 (TARGET_TERRAIN) — общая цель всех сценариев. */
const ARENA = 4;

describe('BLND-13: уровни, пол и рампы из скалпта', () => {
  it('плоская пластина даёт плато нулевого уровня без флагов и кривизны', () => {
    const layer = cellsOf(sculptGlb([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) }]));

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain).toEqual({ levels: ['0000', '0000', '0000', '0000'], flags: ['....', '....', '....', '....'] });
    expect(layer.curvature?.rows.flat()).toEqual(new Array(25).fill(0));
  });

  it('вертикальный обрыв квантуется в уровни без рамп: скачок выше порога', () => {
    const glb = sculptGlb([
      { name: 'low', triangles: plate(0, 0, 2, ARENA, 0) },
      { name: 'high', triangles: box(2, 0, ARENA, ARENA, 0, 1) },
    ]);
    const layer = cellsOf(glb);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.levels).toEqual(['0011', '0011', '0011', '0011']);
    expect(layer.terrain?.flags).toEqual(['....', '....', '....', '....']);
  });

  it('непрерывный склон получает цепочку рамп на нижних клетках пар', () => {
    // h(x) = x: центры клеток 0.5..3.5 квантуются в уровни 1..4, перепад между
    // столбцами — единица, поверхность через границы непрерывна.
    const layer = cellsOf(sculptGlb([{ name: 'hill', triangles: slope(0, 0, ARENA, ARENA, 0, 1, 0) }]));

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.levels).toEqual(['1234', '1234', '1234', '1234']);
    expect(layer.terrain?.flags).toEqual(['^^^.', '^^^.', '^^^.', '^^^.']);
    // Остаток пиннится числом: узловая база цепочки рамп — верхняя сторона
    // узла (max по cornerLevels), и совпадение со скалптом гарантировано только
    // по ней — известный предел правила углов REND-9 (BLND-13, change
    // ramp-chain-surface). Крайний узел x=4 сэмплируется точно на краю → 0.
    expect(layer.curvature?.rows).toEqual(new Array(5).fill([-32, -32, -32, -32, 0]));
  });

  it('обрыв внутри клетки — тоже обрыв: стенка не обязана совпадать с границей', () => {
    // Стенка на x=2.3 — внутри клетки x=2, не на границе клеток. Непрерывность
    // проверяется вдоль отрезка между центрами, и скачок ловится любой позицией.
    const glb = sculptGlb([
      { name: 'low', triangles: plate(0, 0, 2.3, ARENA, 0) },
      { name: 'high', triangles: box(2.3, 0, ARENA, ARENA, 0, 1) },
    ]);
    const layer = cellsOf(glb);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.levels).toEqual(['0011', '0011', '0011', '0011']);
    expect(layer.terrain?.flags).toEqual(['....', '....', '....', '....']);
  });

  it('навес: считается верхняя поверхность, пространство под ним в модель не попадает', () => {
    const glb = sculptGlb([
      { name: 'floor', triangles: plate(0, 0, ARENA, ARENA, 0) },
      { name: 'canopy', triangles: plate(1, 1, 2, 2, 3) },
    ]);
    const layer = cellsOf(glb);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.levels).toEqual(['0000', '0300', '0000', '0000']);
    expect(layer.terrain?.flags).toEqual(['....', '....', '....', '....']);
  });

  it('порог обрыва — свойство автора: cliffJump выше скачка превращает обрыв в рампу', () => {
    const glb = sculptGlb([
      { name: 'low', triangles: plate(0, 0, 2, ARENA, 0), extras: { sculpt: 1, cliffJump: 2 } },
      { name: 'high', triangles: box(2, 0, ARENA, ARENA, 0, 1) },
    ]);
    const layer = cellsOf(glb);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.flags).toEqual(['.^..', '.^..', '.^..', '.^..']);
  });

  it('дыра в меше — клетка без пола, а не находка', () => {
    const cells: WorldTriangle[] = [];
    for (let y = 0; y < ARENA; y++) {
      for (let x = 0; x < ARENA; x++) {
        if (x === 1 && y === 1) continue;
        cells.push(...plate(x, y, x + 1, y + 1, 0));
      }
    }
    const layer = cellsOf(sculptGlb([{ name: 'floor', triangles: cells }]));

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.flags).toEqual(['....', '._..', '....', '....']);
    expect(layer.terrain?.levels).toEqual(['0000', '0000', '0000', '0000']);
  });

  it('дыра в плато наследует уровень плато: ложного кольца обрывов нет', () => {
    // Уровень клетки-дыры — уровень ближайшей клетки с полом (BLND-13): из него
    // строятся клифы и высота восстановленного пола, и ноль дырявил бы плато
    // кольцом обрывов, блокирующим движение и обзор.
    const cells: WorldTriangle[] = [];
    for (let y = 0; y < ARENA; y++) {
      for (let x = 0; x < ARENA; x++) {
        if (x === 1 && y === 1) continue;
        cells.push(...plate(x, y, x + 1, y + 1, 2));
      }
    }
    const layer = cellsOf(sculptGlb([{ name: 'plateau', triangles: cells }]));

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.levels).toEqual(['2222', '2222', '2222', '2222']);
    expect(layer.terrain?.flags).toEqual(['....', '._..', '....', '....']);
  });

  it('высота вне алфавита уровней — отказ с адресом клетки и сырой высотой, не кламп', () => {
    const layer = cellsOf(sculptGlb([{ name: 'tower', triangles: plate(0, 0, ARENA, ARENA, 19.75) }]));

    const errors = errorsOf(layer).join('\n');
    expect(errors).toContain('вне диапазона');
    expect(errors).toContain('19.75');
    expect(layer.terrain).toBeUndefined();
  });
});

describe('BLND-13: объединение множества мешей', () => {
  const cubes: readonly SculptNodeSpec[] = [
    { name: 'a', triangles: box(0, 0, 3, 3, 0, 1) },
    { name: 'b', triangles: box(2, 2, ARENA, ARENA, 0, 2) },
  ];

  it('пересекающиеся блоки объединяются верхним пересечением', () => {
    const layer = cellsOf(sculptGlb([{ name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0) }, ...cubes]));

    expect(errorsOf(layer)).toEqual([]);
    // Клетка (2, 2) накрыта обоими блоками: побеждает верхний (уровень 2).
    expect(layer.terrain?.levels).toEqual(['1110', '1110', '1122', '0022']);
  });

  it('перестановка объектов местами не меняет в слоях ни байта', () => {
    const base: SculptNodeSpec = { name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0) };
    const forward = cellsOf(sculptGlb([base, ...cubes]));
    const backward = cellsOf(sculptGlb([...[...cubes].reverse(), base]));

    expect(JSON.stringify({ terrain: forward.terrain, curvature: forward.curvature })).toEqual(
      JSON.stringify({ terrain: backward.terrain, curvature: backward.curvature }),
    );
  });

  it('повторная дискретизация того же источника байт-в-байт та же (BLND-4)', () => {
    const glb = sculptGlb([{ name: 'hill', triangles: slope(0, 0, ARENA, ARENA, 0, 1, 0.25) }]);

    expect(JSON.stringify(cellsOf(glb))).toEqual(JSON.stringify(cellsOf(glb)));
  });

  it('разные cliffJump на разных объектах — ошибка: у параметра один источник', () => {
    const glb = sculptGlb([
      { name: 'a', triangles: plate(0, 0, 2, ARENA, 0), extras: { sculpt: 1, cliffJump: 0.5 } },
      { name: 'b', triangles: plate(2, 0, ARENA, ARENA, 0), extras: { sculpt: 1, cliffJump: 1 } },
    ]);

    expect(errorsOf(cellsOf(glb)).join('\n')).toContain('один источник');
  });
});

describe('BLND-13: остаток кривизны', () => {
  it('плато между уровнями: уровень квантуется вниз, остаток уходит в кривизну точно', () => {
    // Пластина на 0.25: уровень 0, остаток 0.25 шага = 8/32 в каждом узле.
    const layer = cellsOf(sculptGlb([{ name: 'raised', triangles: plate(0, 0, ARENA, ARENA, 0.25) }]));

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.levels).toEqual(['0000', '0000', '0000', '0000']);
    expect(layer.curvature?.rows.flat()).toEqual(new Array(25).fill(8));
  });

  it('у обрыва точна верхняя кромка: остаток считается от верхнего уровня узла', () => {
    // Обе поверхности ровно на целых уровнях: остаток нулевой и у кромки —
    // узлы границы берут базу верхней кромки (уровень 1), и выборка скалпта
    // на границе тоже отдаёт верхнюю поверхность.
    const glb = sculptGlb([
      { name: 'low', triangles: plate(0, 0, 2, ARENA, 0) },
      { name: 'high', triangles: box(2, 0, ARENA, ARENA, 0, 1) },
    ]);
    const layer = cellsOf(glb);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.curvature?.rows.flat()).toEqual(new Array(25).fill(0));
  });
});

describe('BLND-13: границы формата', () => {
  it('sculpt вместе с grid-объектом — ошибка: у слоя один источник', () => {
    const layer = cellsOf(
      sculptGlb([
        { name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) },
        { name: 'grid', triangles: plate(0, 0, ARENA, ARENA, 0), extras: { terrain: 1 } },
      ]),
    );

    expect(errorsOf(layer).join('\n')).toContain('один источник (BLND-13)');
    expect(layer.terrain).toBeUndefined();
    expect(layer.curvature).toBeUndefined();
  });

  it('манифест без адреса карты кривизны — ошибка: скалпт переписывает оба слоя', () => {
    const glb = sculptGlb([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) }]);
    const layer = cellsOf(glb, { terrain: TARGET_TERRAIN, curvatureMap: null });

    expect(errorsOf(layer).join('\n')).toContain('terrain.curvatureMap');
  });

  it('sculpt-объект без геометрии — ошибка с именем объекта', () => {
    const layer = cellsOf(
      sculptGlb([
        { name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) },
        { name: 'ghost', triangles: [] },
      ]),
    );

    expect(errorsOf(layer).join('\n')).toContain('ghost: объект без геометрии');
  });

  it('walkable на sculpt-объекте — ошибка слоя размещений (BLND-3)', () => {
    const glb = sculptGlb([
      { name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0), extras: { sculpt: 1, walkable: true } },
    ]);
    const document = parseGltf(glb);
    const layer = generateSpatialLayer(normalizeDocument(document), context({ terrain: TARGET_TERRAIN }));

    expect(
      layer.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message).join('\n'),
    ).toContain('walkable');
  });

  it('sculpt-объект не порождает записей размещений и decorations', () => {
    const document = parseGltf(sculptGlb([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) }]));
    const layer = generateSpatialLayer(normalizeDocument(document), context({ terrain: TARGET_TERRAIN }));

    expect(layer.findings).toEqual([]);
    expect(layer.initial).toEqual([]);
    expect(layer.decorations).toEqual([]);
  });
});

describe('BLND-13: импорт целиком', () => {
  it('sculpt-источник переписывает оба слоя и не трогает initial и presentation', async () => {
    // Пластина на 0.25: уровни нулевые (перепишут ассет цели), остаток 8/32 в
    // каждом узле (перепишет нулевую карту кривизны цели).
    const glb = sculptGlb([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0.25) }]);
    const files = contentFiles(glb, sceneDocument([], TERRAIN_ASSET), presentationDocument(), {
      [CURVATURE_ID]: JSON.stringify(curvatureDocument(), null, 2),
    });
    const memory = createMemoryHost({ files });
    const sceneBefore = JSON.parse(new TextDecoder().decode(await memory.content.read(SCENE_ID))) as {
      initial: unknown[];
    };

    const result = await runImport({ host: memory.content, source: SOURCE_ID, manifest: MANIFEST_ID });

    expect(result.ok).toBe(true);
    expect(result.written).toContain(CURVATURE_ID);
    const sceneAfter = JSON.parse(new TextDecoder().decode(await memory.content.read(SCENE_ID))) as {
      initial: unknown[];
      terrain: { levels: string[] };
    };
    expect(sceneAfter.terrain.levels).toEqual(['0000', '0000', '0000', '0000']);
    const curvature = JSON.parse(new TextDecoder().decode(await memory.content.read(CURVATURE_ID))) as {
      rows: number[][];
    };
    expect(curvature.rows).toEqual(new Array(5).fill(new Array(5).fill(8)));
    expect(sceneAfter.initial).toEqual(sceneBefore.initial);
    const presentation = JSON.parse(new TextDecoder().decode(await memory.content.read(PRESENTATION_ID))) as {
      decorations?: unknown[];
    };
    expect(presentation.decorations ?? []).toEqual([]);

    // Повторный импорт того же источника не пишет ничего (BLND-4).
    const again = await runImport({ host: memory.content, source: SOURCE_ID, manifest: MANIFEST_ID });
    expect(again.ok).toBe(true);
    expect(again.written).toEqual([]);
  });
});
