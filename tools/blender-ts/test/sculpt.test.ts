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
import { createTerrainGrid } from '@fluxus/core';
import { CURVATURE_SCALE, validateCurvatureMap } from '@fluxus/assets';
import { createMemoryHost } from '@fluxus/editor-core';
// Правило углов рендера — то же, что читает `sculpt.ts`: второй реализации
// узловой базы BLND-13 не допускает (REND-9).
import { cornerLevels, createVisualSurface } from '@fluxus/render/visualSurface';
import { parseGltf } from '../src/gltf.js';
import { runImport } from '../src/importer.js';
import { LEVEL_UNIT, generateCellLayer, type CellLayer } from '../src/maps.js';
import { nodeBaseLevels } from '../src/sculpt.js';
import { generateSpatialLayer } from '../src/layer.js';
import { normalizeDocument } from '../src/normalize.js';
import {
  CURVATURE_ID,
  MANIFEST_ID,
  PAINT_ID,
  PRESENTATION_ID,
  SCENE_ID,
  SOURCE_ID,
  TARGET_TERRAIN,
  TERRAIN_ASSET,
  box,
  contentFiles,
  context,
  curvatureDocument,
  plate,
  plateauWithHole,
  presentationDocument,
  sceneDocument,
  sculptGlb,
  slope,
  type SculptNodeSpec,
  type WorldTriangle,
} from './support.js';

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
    // узла (max по cornerLevels), и в узлах между смежными рампами ступенчатая
    // форма едина (REND-9), поэтому остаток восстанавливает длинный склон точно
    // — см. тесты цепочки ниже. Крайний узел x=4 сэмплируется точно на краю → 0.
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
    const layer = cellsOf(sculptGlb([{ name: 'floor', triangles: plateauWithHole(ARENA, 0, 1, 1) }]));

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.flags).toEqual(['....', '._..', '....', '....']);
    expect(layer.terrain?.levels).toEqual(['0000', '0000', '0000', '0000']);
  });

  it('дыра в плато наследует уровень плато: ложного кольца обрывов нет', () => {
    // Уровень клетки-дыры — уровень ближайшей клетки с полом (BLND-13): из него
    // строятся клифы и высота восстановленного пола, и ноль дырявил бы плато
    // кольцом обрывов, блокирующим движение и обзор.
    const layer = cellsOf(sculptGlb([{ name: 'plateau', triangles: plateauWithHole(ARENA, 2, 1, 1) }]));

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

describe('BLND-13 + REND-9: цепочка рамп восстанавливается точно', () => {
  /** Тот же источник, что у теста «непрерывный склон»: h(x) = x, склон в 4 уровня. */
  const chainLayer = (): CellLayer =>
    cellsOf(sculptGlb([{ name: 'hill', triangles: slope(0, 0, ARENA, ARENA, 0, 1, 0) }]));

  /** Сетка ядра из карт импортированного слоя — вход правила углов рендера. */
  const gridOfLayer = (layer: CellLayer) =>
    createTerrainGrid({
      ...TARGET_TERRAIN,
      levels: [...layer.terrain!.levels],
      flags: [...layer.terrain!.flags],
    });

  it('узловая база остатка — верхняя сторона узла: смыкание пар её не сдвинуло', () => {
    const grid = gridOfLayer(chainLayer());

    // База узла — максимум заявок примыкающих клеток; на цепочке это старший
    // уровень примыкающих клеток (уровни 1..4, у правого края арены — 4).
    // Обобщение правила углов (REND-9) её не двигает НИ В ОДНОМ узле:
    // подавленная заявка верхней клетки пары равна притяжению нижней вверх,
    // поэтому максимум прежний — числа теста «цепочка рамп» байт-в-байт те же.
    const columns = [1, 2, 3, 4, 4];
    expect([...nodeBaseLevels(grid)]).toEqual(new Array(ARENA + 1).fill(columns).flat());

    // Связка держится обоими концами, а не совпадением чисел: верхняя клетка
    // пары остаётся на своём уровне, нижняя дотягивается вверх до него же.
    expect(cornerLevels(grid, 0, 0)[1]).toBe(2);
    expect(cornerLevels(grid, 1, 0)[0]).toBe(2);
  });

  it('поверхность движка из записанных слоёв совпадает со скалптом в узлах цепочки', () => {
    const layer = chainLayer();
    const checked = validateCurvatureMap({
      width: layer.curvature!.width,
      height: layer.curvature!.height,
      rows: layer.curvature!.rows.map((row) => [...row]),
    });
    if (!checked.ok) throw new Error(checked.errors.join('; '));
    // Поверхность строится из ЗАПИСАННЫХ слоёв: уровни, рампы и остаток; шаг
    // высоты движка — единица уровня конвейера (LEVEL_UNIT).
    const surface = createVisualSurface(gridOfLayer(layer), LEVEL_UNIT, checked.map);

    // Скалпт — плоскость h(x) = x при клетке размера 1: высота узла равна его
    // координате. Совпадение проверяется у КАЖДОЙ клетки, включая обе клетки
    // пары рамп: общее ребро одно, разрыва посреди склона нет (REND-9).
    const quantum = LEVEL_UNIT / CURVATURE_SCALE;
    const cornerDx = [0, 1, 1, 0]; // порядок cornerLevels: c00, c10, c11, c01
    for (let y = 0; y < ARENA; y++) {
      for (let x = 0; x < ARENA; x++) {
        const heights = surface.cornerHeights(x, y);
        for (let corner = 0; corner < cornerDx.length; corner++) {
          expect(Math.abs(heights[corner]! - (x + cornerDx[corner]!))).toBeLessThanOrEqual(quantum);
        }
      }
    }
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

describe('BLND-14: раскраска скалпт-поверхности', () => {
  /**
   * Раскрашенная арена: плита слота 1 и приподнятый блок слота 2 над правой
   * верхней четвертью. Слот клетки — у геометрии ВЕРХНЕГО пересечения, поэтому
   * под блоком читается его слот, а не слот плиты под ним.
   */
  const PAINTED_ARENA: readonly SculptNodeSpec[] = [
    { name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 1 },
    { name: 'patch', triangles: box(2, 0, ARENA, 2, 0, 1), paint: 2 },
  ];

  const paintOf = (nodes: readonly SculptNodeSpec[]): CellLayer => cellsOf(sculptGlb(nodes));

  it('слот клетки берётся у геометрии верхнего пересечения в её центре', () => {
    const layer = paintOf(PAINTED_ARENA);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.paint).toEqual({ width: 4, height: 4, rows: ['1122', '1122', '1111', '1111'] });
    // Рельеф тот же источник даёт по-прежнему: раскраска ездит РЯДОМ с ним.
    expect(layer.terrain?.levels).toEqual(['0011', '0011', '0000', '0000']);
  });

  it('перестановка объектов местами не меняет в карте ни байта (BLND-13)', () => {
    const forward = paintOf(PAINTED_ARENA);
    const backward = paintOf([...PAINTED_ARENA].reverse());

    expect(JSON.stringify(backward.paint)).toEqual(JSON.stringify(forward.paint));
  });

  it('на равной высоте выигрывает старший слот, а не первый встреченный', () => {
    // Две пластины на одном уровне — обычное дело у наложенных примитивов:
    // «первый встреченный» зависел бы от порядка объектов (BLND-13).
    const lower: SculptNodeSpec = { name: 'a-lower', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 1 };
    const upper: SculptNodeSpec = { name: 'b-upper', triangles: plate(0, 0, 2, 2, 0), paint: 4 };

    for (const nodes of [
      [lower, upper],
      [upper, lower],
    ]) {
      const layer = paintOf(nodes);
      expect(errorsOf(layer)).toEqual([]);
      expect(layer.paint?.rows).toEqual(['4411', '4411', '1111', '1111']);
    }
  });

  it('геометрия без канала уступает несущей канал на равной высоте', () => {
    const layer = paintOf([
      { name: 'a-painted', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 3 },
      { name: 'b-plain', triangles: plate(0, 0, ARENA, ARENA, 0) },
    ]);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.paint?.rows).toEqual(['3333', '3333', '3333', '3333']);
  });

  it('расхождение вершин грани пересечения — отказ с адресом клетки, а не голосование', () => {
    const layer = paintOf([
      { name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 1 },
      {
        name: 'split',
        triangles: plate(1, 1, 2, 2, 1),
        paint: [
          [2, 5, 2],
          [2, 5, 2],
        ],
      },
    ]);

    const errors = errorsOf(layer).join('\n');
    expect(errors).toContain('split: клетка (1, 1)');
    expect(errors).toContain('разные значения канала');
    expect(layer.paint).toBeUndefined();
  });

  it('нераскрашенный объект под верхним пересечением — отказ с клеткой и именем объекта', () => {
    const layer = paintOf([
      { name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 1 },
      { name: 'rock', triangles: box(1, 1, 2, 2, 0, 1) },
    ]);

    const errors = errorsOf(layer).join('\n');
    expect(errors).toContain('rock: клетка (1, 1)');
    expect(errors).toContain('_PAINT');
    expect(layer.paint).toBeUndefined();
  });

  it('канала нет ни у одного объекта — карты нет вовсе и находки нет (BLND-2)', () => {
    const layer = paintOf([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) }]);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.paint).toBeUndefined();
    // Рельеф при этом переписывается: канала нет только у раскраски.
    expect(layer.terrain).toBeDefined();
  });

  it('дыра берёт слот ближайшей клетки с полом: вернувшийся пол вернётся им же', () => {
    const layer = paintOf([{ name: 'plateau', triangles: plateauWithHole(ARENA, 0, 1, 1), paint: 3 }]);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.flags).toEqual(['....', '._..', '....', '....']);
    expect(layer.paint?.rows).toEqual(['3333', '3333', '3333', '3333']);
  });

  it('слот вне алфавита карты — отказ с адресом клетки, а не кламп', () => {
    const layer = paintOf([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 12 }]);

    expect(errorsOf(layer).join('\n')).toContain('вне алфавита');
    expect(layer.paint).toBeUndefined();
  });

  it('значение между слотами — отказ, а не округление', () => {
    const layer = paintOf([
      {
        name: 'arena',
        triangles: plate(0, 0, ARENA, ARENA, 0),
        paint: [
          [1.4, 1.4, 1.4],
          [1.4, 1.4, 1.4],
        ],
      },
    ]);

    expect(errorsOf(layer).join('\n')).toContain('не разрешается в целый индекс слота');
    expect(layer.paint).toBeUndefined();
  });

  it('манифест без карты раскраски — отказ с именем ключа (BLND-14)', () => {
    const layer = cellsOf(sculptGlb(PAINTED_ARENA), { terrain: TARGET_TERRAIN, paintMap: null });

    expect(errorsOf(layer).join('\n')).toContain('terrain.paintMap');
    expect(layer.paint).toBeUndefined();
  });

  it('пола нет вовсе — слот дыры нулевой: брать его неоткуда', () => {
    // Объект из одних вертикальных стенок: канал он несёт, но горизонтальной
    // поверхности не даёт ни одной клетке — пересечений нет, волне не от чего
    // идти, и слот `0` здесь не умолчание, а единственное определённое значение
    // (BLND-14).
    const wall: WorldTriangle[] = [
      [
        [0, 0, 0],
        [ARENA, 0, 0],
        [ARENA, 0, 2],
      ],
      [
        [0, 0, 0],
        [ARENA, 0, 2],
        [0, 0, 2],
      ],
    ];
    const layer = paintOf([{ name: 'wall', triangles: wall, paint: 5 }]);

    expect(errorsOf(layer)).toEqual([]);
    expect(layer.terrain?.flags).toEqual(['____', '____', '____', '____']);
    expect(layer.paint?.rows).toEqual(['0000', '0000', '0000', '0000']);
  });

  it('повторная дискретизация того же источника даёт ту же карту (BLND-4)', () => {
    const glb = sculptGlb(PAINTED_ARENA);

    expect(JSON.stringify(cellsOf(glb).paint)).toEqual(JSON.stringify(cellsOf(glb).paint));
  });
});

describe('BLND-14: импорт раскрашенного скалпта целиком', () => {
  const PAINTED: readonly SculptNodeSpec[] = [
    { name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 1 },
    { name: 'patch', triangles: box(2, 0, ARENA, 2, 0, 1), paint: 2 },
  ];

  const ZERO_PAINT = JSON.stringify({ width: 4, height: 4, rows: ['0000', '0000', '0000', '0000'] }, null, 2);

  const treeOf = (
    nodes: readonly SculptNodeSpec[],
    extra: Record<string, string | Uint8Array> = {},
  ): ReturnType<typeof createMemoryHost> =>
    createMemoryHost({
      files: contentFiles(sculptGlb(nodes), sceneDocument([], TERRAIN_ASSET), presentationDocument(), {
        [CURVATURE_ID]: JSON.stringify(curvatureDocument(), null, 2),
        ...extra,
      }),
    });

  const readJson = async (memory: ReturnType<typeof createMemoryHost>, id: string): Promise<unknown> =>
    JSON.parse(new TextDecoder().decode(await memory.content.read(id)));

  it('раскрашенный скалпт переписывает карту, и повторный импорт не пишет ничего', async () => {
    const memory = treeOf(PAINTED, { [PAINT_ID]: ZERO_PAINT });

    const result = await runImport({ host: memory.content, source: SOURCE_ID, manifest: MANIFEST_ID });

    expect(result.ok).toBe(true);
    expect(result.written).toContain(PAINT_ID);
    expect(await readJson(memory, PAINT_ID)).toEqual({
      width: 4,
      height: 4,
      rows: ['1122', '1122', '1111', '1111'],
    });

    const again = await runImport({ host: memory.content, source: SOURCE_ID, manifest: MANIFEST_ID });
    expect(again.ok).toBe(true);
    expect(again.written).toEqual([]);
  });

  it('скалпт без канала не создаёт документа карты вовсе (BLND-2)', async () => {
    const memory = treeOf([{ name: 'arena', triangles: plate(0, 0, ARENA, ARENA, 0) }]);

    const result = await runImport({ host: memory.content, source: SOURCE_ID, manifest: MANIFEST_ID });

    expect(result.ok).toBe(true);
    expect(result.layer.paint).toBeUndefined();
    // Документ не открывался и не создавался: слоя у источника нет.
    expect(await memory.content.stat(PAINT_ID)).toBeUndefined();
  });

  it('режим проверки называет карту раскраски и не пишет ничего (BLND-6)', async () => {
    const memory = treeOf(PAINTED, { [PAINT_ID]: ZERO_PAINT });

    const result = await runImport({
      host: memory.content,
      source: SOURCE_ID,
      manifest: MANIFEST_ID,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.layer.paint?.rows).toEqual(['1122', '1122', '1111', '1111']);
    expect(result.written).toEqual([]);
    expect(new TextDecoder().decode(await memory.content.read(PAINT_ID))).toBe(ZERO_PAINT);
  });

  it('отказ раскраски не оставляет на диске половины импорта (BLND-6)', async () => {
    const memory = treeOf(
      [
        { name: 'base', triangles: plate(0, 0, ARENA, ARENA, 0), paint: 1 },
        { name: 'rock', triangles: box(1, 1, 2, 2, 0, 1) },
      ],
      { [PAINT_ID]: ZERO_PAINT },
    );
    const before = {
      scene: await readJson(memory, SCENE_ID),
      curvature: await readJson(memory, CURVATURE_ID),
      paint: await readJson(memory, PAINT_ID),
    };

    const result = await runImport({ host: memory.content, source: SOURCE_ID, manifest: MANIFEST_ID });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(await readJson(memory, SCENE_ID)).toEqual(before.scene);
    expect(await readJson(memory, CURVATURE_ID)).toEqual(before.curvature);
    expect(await readJson(memory, PAINT_ID)).toEqual(before.paint);
  });
});
