/**
 * Террейн-ступени (REND-7): площадки, стенки по cliff-отрезкам ядра, рампы,
 * дыры и пересборка чанка по мутации пола. Плюс документный вход `applyGrid`
 * (ED-10, ED-11, ED-15) и возврат пола документа после превью (ED-9).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@fluxus/core';
import {
  validateCurvatureMap,
  validateTerrainPaint,
  type TerrainCurvatureMap,
} from '@fluxus/assets';
import {
  DEFAULT_CURVATURE_TESSELLATION,
  SKIRT_BOTTOMLESS_Z,
  TERRAIN_PAINT_ATTRIBUTE,
  TerrainSubsystem,
  VisualSurfaceSource,
  buildFloorGeometry,
  buildSkirtGeometry,
  buildWallGeometry,
  cornerHeight,
  cornerLevels,
  createCostCounters,
  createVisualSurface,
  sampleWallSide,
  withCostSink,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeTickView } from './fixtures.js';

const STEP = 0.5;

/** 2×2: левый столбец — уровень 0, правый — уровень 1, рамп нет. */
function cliffGrid() {
  return createTerrainGrid({
    width: 2,
    height: 2,
    tileSize: FIXED_ONE,
    levels: ['01', '01'],
    flags: ['..', '..'],
  });
}

/** Те же уровни, но левый столбец — рампа на правое плато. */
function rampGrid() {
  return createTerrainGrid({
    width: 2,
    height: 2,
    tileSize: FIXED_ONE,
    levels: ['01', '01'],
    flags: ['^.', '^.'],
  });
}

describe('стенки по cliff-отрезкам ядра (TERR-5 → REND-7)', () => {
  it('каждый cliff-отрезок даёт квад от нижнего уровня пары до верхнего', () => {
    const grid = cliffGrid();
    // Производная геометрия ядра, не собственный вывод рендера.
    expect(grid.cliffs.length).toBe(2);

    const walls = buildWallGeometry(grid, STEP);
    expect(walls.positions.length).toBe(grid.cliffs.length * 4 * 3);
    expect(walls.indices.length).toBe(grid.cliffs.length * 6);

    // Все стенки стоят на границе x = 1 и тянутся по z от 0 до 1 × STEP.
    for (let v = 0; v < walls.positions.length; v += 3) {
      expect(walls.positions[v]).toBeCloseTo(1, 6);
      const z = walls.positions[v + 2]!;
      expect(z === 0 || Math.abs(z - STEP) < 1e-6).toBe(true);
    }
  });

  it('рампа делает переход проходимым — cliff-отрезков и стенок нет', () => {
    const grid = rampGrid();
    expect(grid.cliffs.length).toBe(0);
    expect(buildWallGeometry(grid, STEP).indices.length).toBe(0);
  });
});

describe('площадки, рампы и дыры (REND-7)', () => {
  it('карта 2×2 с перепадом: квад на клетку, высота — уровень × шаг', () => {
    const grid = cliffGrid();
    const floor = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 2, 2);
    expect(floor.positions.length).toBe(4 * 4 * 3); // 4 клетки по 4 вершины
    expect(floor.indices.length).toBe(4 * 6);

    // Левый столбец лежит на 0, правый — на STEP: вершин поровну.
    let atZero = 0;
    let atStep = 0;
    for (let v = 0; v < floor.positions.length; v += 3) {
      const z = floor.positions[v + 2]!;
      if (Math.abs(z) < 1e-6) atZero++;
      else if (Math.abs(z - STEP) < 1e-6) atStep++;
    }
    expect(atZero).toBe(8);
    expect(atStep).toBe(8);
  });

  it('клетка без пола не получает геометрии — дыра', () => {
    const grid = cliffGrid();
    const floor = new Uint8Array(grid.floor);
    floor[0] = 0;
    const data = buildFloorGeometry(grid, floor, STEP, 0, 0, 2, 2);
    expect(data.positions.length).toBe(3 * 4 * 3);
    expect(data.indices.length).toBe(3 * 6);
  });

  it('углы рампы поднимаются к проходимому соседу на уровень выше', () => {
    const grid = rampGrid();
    // Клетка (0,0): восточный сосед — плато уровня 1; западного нет.
    expect(cornerLevels(grid, 0, 0)).toEqual([0, 1, 1, 0]);
    // Плато остаётся плоским.
    expect(cornerLevels(grid, 1, 0)).toEqual([1, 1, 1, 1]);
  });

  it('наклонная площадка рампы смыкается с плато без щели', () => {
    const grid = rampGrid();
    const data = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 1, 1);
    // Восточное ребро клетки-рампы — на высоте плато.
    const zAt = (index: number): number => data.positions[index * 3 + 2]!;
    const xAt = (index: number): number => data.positions[index * 3]!;
    for (let vertex = 0; vertex < 4; vertex++) {
      expect(zAt(vertex)).toBeCloseTo(xAt(vertex) < 1 ? 0 : STEP, 6);
    }
  });
});

describe('TerrainSubsystem: сцена и мутация пола (REND-7, REND-8)', () => {
  function makeCtx(): RenderContext {
    return {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
  }

  it('init строит стенки и чанки пола; выбитый пол пересобирает чанк к следующему кадру', () => {
    const grid = cliffGrid();
    const subsystem = new TerrainSubsystem(grid, { chunkSize: 8 });
    const ctx = makeCtx();
    subsystem.init(ctx);

    // Стенки + один чанк пола + юбка границы сетки.
    expect(ctx.scene.children.length).toBe(3);
    expect(subsystem.floorVertexCount).toBe(16);

    // Мутация пола: клетка 0 выбита (TERR-6).
    const bits = new Uint8Array(grid.floor);
    bits[0] = 0;
    subsystem.syncTick(makeTickView([], { floorBits: bits, floorChangedCells: [0] }));
    subsystem.updateFrame(0.016, 0);
    expect(subsystem.floorVertexCount).toBe(12); // дыра: квадом меньше
  });
});

// ------------------------------------------------- документный вход (ED-10, ED-15)

const DOC_WIDTH = 24;
const DOC_HEIGHT = 8;
const CHUNK = 8;

function rows(char: string, width = DOC_WIDTH, height = DOC_HEIGHT): string[] {
  return Array.from({ length: height }, () => char.repeat(width));
}

/** Плоская арена 24×8 уровня 0 — три чанка по 8 клеток в ряд. */
function docGrid() {
  return createTerrainGrid({
    width: DOC_WIDTH,
    height: DOC_HEIGHT,
    tileSize: FIXED_ONE,
    levels: rows('0'),
    flags: rows('.'),
  });
}

/** Та же арена, но клетка (x, y) поднята на уровень 1 — кисть уровня (ED-10). */
function docGridRaised(x: number, y: number) {
  const levels = rows('0');
  levels[y] = `${levels[y]!.slice(0, x)}1${levels[y]!.slice(x + 1)}`;
  return createTerrainGrid({
    width: DOC_WIDTH,
    height: DOC_HEIGHT,
    tileSize: FIXED_ONE,
    levels,
    flags: rows('.'),
  });
}

function docCurvature(cells: readonly (readonly [number, number])[]): TerrainCurvatureMap {
  // Мазок по клетке поднимает четыре её узла — узловой эквивалент прежнего
  // per-cell значения 7/16 (14/32 шага высоты).
  const map = Array.from({ length: DOC_HEIGHT + 1 }, () =>
    new Array<number>(DOC_WIDTH + 1).fill(0),
  );
  for (const [x, y] of cells) {
    map[y]![x] = 14;
    map[y]![x + 1] = 14;
    map[y + 1]![x] = 14;
    map[y + 1]![x + 1] = 14;
  }
  const result = validateCurvatureMap({ width: DOC_WIDTH, height: DOC_HEIGHT, rows: map });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

describe('TerrainSubsystem.applyGrid: сетка документа (ED-10, ED-15)', () => {
  function makeCtx(): RenderContext {
    return {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
  }

  function setup(options: { surface?: VisualSurfaceSource } = {}) {
    const grid = docGrid();
    const subsystem = new TerrainSubsystem(grid, { chunkSize: CHUNK, ...options });
    const ctx = makeCtx();
    subsystem.init(ctx);
    const chunkMesh = (cx: number): THREE.Object3D | undefined =>
      ctx.scene.getObjectByName(`terrain:chunk:${cx},0`);
    return { grid, subsystem, ctx, chunkMesh };
  }

  it('правка уровня клетки пересобирает только её чанк — и не раньше следующего кадра', () => {
    const { subsystem, chunkMesh } = setup();
    const before = [chunkMesh(0), chunkMesh(1), chunkMesh(2)];
    expect(before.every((mesh) => mesh !== undefined)).toBe(true);

    // Клетка (1, 1) — вдали от границ чанков: правка не выходит за чанк 0.
    subsystem.applyGrid(docGridRaised(1, 1));
    // ED-15 требует «не позже следующего кадра», а не «в момент правки»:
    // до кадра сцена та же, что была.
    expect(chunkMesh(0)).toBe(before[0]);

    subsystem.updateFrame(0.016, 1);
    expect(chunkMesh(0)).not.toBe(before[0]);
    // Пересборки всей арены не было: соседние чанки — те же объекты сцены.
    expect(chunkMesh(1)).toBe(before[1]);
    expect(chunkMesh(2)).toBe(before[2]);
  });

  it('стенки идут по cliff-геометрии, пересчитанной ядром (TERR-5)', () => {
    const { subsystem, ctx } = setup();
    // Плоская арена: обрывов нет — и стенок нет.
    expect(subsystem.wallVertexCount).toBe(0);

    const raised = docGridRaised(1, 1);
    // Отрезки вывело ядро из карты уровней; рендер их только читает (ED-1).
    expect(raised.cliffs.length).toBe(4);

    subsystem.applyGrid(raised);
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.wallVertexCount).toBe(raised.cliffs.length * 4);
    // Стенки стоят вокруг поднятой клетки и тянутся до её высоты.
    const walls = ctx.scene.getObjectByName('terrain:walls:0,0') as THREE.Mesh | undefined;
    expect(walls).toBeDefined();
    const positions = walls!.geometry.getAttribute('position');
    for (let v = 0; v < positions.count; v++) {
      expect(positions.getX(v)).toBeGreaterThanOrEqual(1);
      expect(positions.getX(v)).toBeLessThanOrEqual(2);
      const z = positions.getZ(v);
      expect(z === 0 || Math.abs(z - STEP) < 1e-6).toBe(true);
    }

    // Обратная правка снимает уровень — и стенки уходят вместе с отрезками.
    subsystem.applyGrid(docGrid());
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.wallVertexCount).toBe(0);
    expect(ctx.scene.getObjectByName('terrain:walls:0,0')).toBeUndefined();
  });

  it('стенка на границе чанков достаётся ровно одному чанку', () => {
    const { subsystem, ctx } = setup();
    // Клетка (7, 1) — последняя в чанке 0; её восточный обрыв лежит на x = 8.
    const raised = docGridRaised(7, 1);
    subsystem.applyGrid(raised);
    subsystem.updateFrame(0.016, 1);
    // Ни одного отрезка дважды и ни одного потерянного: владение — разбиение.
    expect(subsystem.wallVertexCount).toBe(raised.cliffs.length * 4);
    expect(ctx.scene.getObjectByName('terrain:walls:1,0')).toBeUndefined();
  });

  it('возврат сетки документа снимает пол, выбитый в превью (ED-9)', () => {
    const { grid, subsystem } = setup();
    const whole = DOC_WIDTH * DOC_HEIGHT * 4;
    expect(subsystem.floorVertexCount).toBe(whole);

    // Превью: поток тиков выбивает пол (TERR-6) — подсистема держит свою копию.
    const bits = new Uint8Array(grid.floor);
    bits[0] = 0;
    bits[10] = 0;
    subsystem.syncTick(makeTickView([], { floorBits: bits, floorChangedCells: [0, 10] }));
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.floorVertexCount).toBe(whole - 8);

    // Выход из превью: документы не менялись — та же сетка возвращает пол.
    subsystem.applyGrid(grid);
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.floorVertexCount).toBe(whole);
  });

  it('карта кривизны из памяти поднимает только свои чанки (ED-11, REND-9)', () => {
    const grid = docGrid();
    // Без curvatureMapId: ассета нет вовсе, карта приходит из памяти кисти.
    const surface = new VisualSurfaceSource(grid);
    const { subsystem, ctx, chunkMesh } = setup({ surface });
    const before = [chunkMesh(0), chunkMesh(1), chunkMesh(2)];

    surface.setCurvature(docCurvature([[1, 1]]));
    expect(surface.current!.hasCurvature).toBe(true);
    expect(surface.current!.heightAt(1.5, 1.5)).toBeGreaterThan(0);

    subsystem.updateFrame(0.016, 1);
    expect(chunkMesh(0)).not.toBe(before[0]);
    expect(chunkMesh(1)).toBe(before[1]);
    expect(chunkMesh(2)).toBe(before[2]);

    // Пол чанка 0 повторил кривизну, но не изменил числа вершин: силуэт тот же.
    const mesh = ctx.scene.getObjectByName('terrain:chunk:0,0') as THREE.Mesh;
    const positions = mesh.geometry.getAttribute('position');
    let raised = 0;
    for (let v = 0; v < positions.count; v++) {
      const z = positions.getZ(v);
      expect(Math.abs(z)).toBeLessThan(STEP / 2);
      if (z > 0) raised++;
    }
    expect(raised).toBeGreaterThan(0);
    // Разбиваются ровно клетки с ненулевыми УЗЛОВЫМИ смещениями: мазок по
    // клетке (1,1) поднимает четыре её узла, а каждый узел общий у четырёх
    // клеток — итого девять клеток 3×3 вокруг мазка. Остальная арена осталась
    // квадом на клетку: цена платится там, где нарисован рельеф (REND-9).
    // Вершин у разбитой клетки `(N+1)²`, а не `4N²`: подклетки сварены внутри
    // клетки (REND-9, T-6 аудита) — позиция и нормаль суть функции клетки и
    // точки, и на общем ребре подклеток совпадают побитово.
    const n = DEFAULT_CURVATURE_TESSELLATION;
    const curved = 9;
    expect(subsystem.floorVertexCount).toBe(
      curved * (n + 1) * (n + 1) + (DOC_WIDTH * DOC_HEIGHT - curved) * 4,
    );
  });

  it('смена размеров арены пересобирает раскладку чанков', () => {
    const { subsystem, ctx } = setup();
    // Три чанка пола и их юбки по границе сетки, обрывов нет.
    expect(ctx.scene.children.length).toBe(6);

    subsystem.applyGrid(
      createTerrainGrid({
        width: 8,
        height: 8,
        tileSize: FIXED_ONE,
        levels: rows('0', 8, 8),
        flags: rows('.', 8, 8),
      }),
    );
    subsystem.updateFrame(0.016, 1);
    expect(ctx.scene.children.length).toBe(2); // чанк пола + его юбка
    expect(subsystem.floorVertexCount).toBe(8 * 8 * 4);
  });
});

// -------------------------------------- разбиение по кривизне (REND-9)

/**
 * Геометрия — выборка поля высот, а не его углы: клетка с ненулевым узловым
 * смещением разбивается, клетка без кривизны остаётся одним квадом, а швов ни
 * между разбитыми клетками, ни на стыке с неразбитым соседом не возникает.
 */
describe('разбиение клеток с кривизной (REND-9)', () => {
  const N = DEFAULT_CURVATURE_TESSELLATION;
  const TILE = FIXED_ONE / FIXED_ONE;

  /** Плоская арена 24×8 с мазком кривизны по клетке (1,1). */
  function curvedRig() {
    const grid = docGrid();
    const surface = createVisualSurface(grid, STEP, docCurvature([[1, 1]]));
    return { grid, surface };
  }

  /** Вершины геометрии как тройки — сравнивать позиции удобнее по вершинам. */
  function vertices(data: { positions: Float32Array }): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let v = 0; v < data.positions.length; v += 3) {
      out.push([data.positions[v]!, data.positions[v + 1]!, data.positions[v + 2]!]);
    }
    return out;
  }

  it('клетка с кривизной даёт N × N квадов, соседняя плоская остаётся одним', () => {
    const { grid, surface } = curvedRig();
    // Порог — узловые смещения, а не значение карты в клетке: соседка мазка
    // тоже разбивается, а клетка через одну — уже нет.
    expect(surface.hasCellCurvature(1, 1)).toBe(true);
    expect(surface.hasCellCurvature(2, 1)).toBe(true);
    expect(surface.hasCellCurvature(3, 1)).toBe(false);

    const curved = buildFloorGeometry(grid, grid.floor, STEP, 1, 1, 1, 1, surface, N);
    // Квадов по-прежнему N×N, а вершин — сваренная решётка `(N+1)²` вместо
    // `4N²` независимых четвёрок (T-6): индексы считает `terrainFloorQuads`,
    // и цена кадра от сварки не меняется, а память геометрии падает.
    expect(curved.positions.length / 3).toBe((N + 1) * (N + 1));
    expect(curved.indices.length).toBe(N * N * 6);
    // Вершины стоят НА поле: середина клетки поднята над хордой её углов.
    expect(Math.max(...vertices(curved).map(([, , z]) => z))).toBeGreaterThan(0);

    const flat = buildFloorGeometry(grid, grid.floor, STEP, 3, 1, 1, 1, surface, N);
    expect(flat.positions.length / 3).toBe(4);
    expect(flat.indices.length).toBe(6);
  });

  it('T-стыка со щелью нет: на общем ребре с неразбитым соседом вершины лежат на его прямой', () => {
    const { grid, surface } = curvedRig();
    // Клетка (2,1) разбита, её восточный сосед (3,1) — целый квад.
    const curved = buildFloorGeometry(grid, grid.floor, STEP, 2, 1, 1, 1, surface, N);
    const [n00, , , n01] = surface.cornerHeights(3, 1);
    let onEdge = 0;
    for (const [x, y, z] of vertices(curved)) {
      if (Math.abs(x - 3 * TILE) > 1e-12) continue;
      // Прямая соседа между его углами на этом ребре.
      const t = y / TILE - 1;
      expect(z).toBeCloseTo(n00 + (n01 - n00) * t, 12);
      onEdge++;
    }
    // Подклетки сварены внутри клетки: на общем ребре подклеток вершина одна,
    // и вдоль всего ребра клетки их `N + 1`, а не `2N` (T-6).
    expect(onEdge).toBe(N + 1);
  });

  it('швов нет и между двумя разбитыми клетками: общие точки ребра совпадают по высоте', () => {
    const { grid, surface } = curvedRig();
    const west = buildFloorGeometry(grid, grid.floor, STEP, 1, 1, 1, 1, surface, N);
    const east = buildFloorGeometry(grid, grid.floor, STEP, 2, 1, 1, 1, surface, N);
    const onSeam = (data: { positions: Float32Array }): Map<number, number> => {
      const heights = new Map<number, number>();
      for (const [x, y, z] of vertices(data)) {
        if (Math.abs(x - 2 * TILE) > 1e-12) continue;
        heights.set(y, z);
      }
      return heights;
    };
    const a = onSeam(west);
    const b = onSeam(east);
    expect(a.size).toBe(N + 1);
    expect(b.size).toBe(N + 1);
    let raised = 0;
    for (const [y, z] of a) {
      expect(b.has(y)).toBe(true);
      expect(b.get(y)!).toBeCloseTo(z, 12);
      if (z > 0) raised++;
    }
    // Проверка не вырождена: шов проходит по поднятой кривизной части поля.
    expect(raised).toBeGreaterThan(0);
  });

  it('плато с кривизной без граней: нормали вершин пола совпадают через границы клеток', () => {
    const { grid, surface } = curvedRig();
    const data = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 4, surface, N);
    const groups = new Map<string, { x: number; y: number; z: number }[]>();
    for (let v = 0; v < data.positions.length; v += 3) {
      const key = `${data.positions[v]!}|${data.positions[v + 1]!}`;
      const list = groups.get(key) ?? [];
      list.push({
        x: data.normals![v]!,
        y: data.normals![v + 1]!,
        z: data.normals![v + 2]!,
      });
      groups.set(key, list);
    }
    let tilted = 0;
    for (const list of groups.values()) {
      const first = list[0]!;
      for (const n of list) {
        expect(n.x).toBeCloseTo(first.x, 9);
        expect(n.y).toBeCloseTo(first.y, 9);
        expect(n.z).toBeCloseTo(first.z, 9);
      }
      if (Math.hypot(first.x, first.y) > 1e-3) tilted++;
    }
    // Плато не плоское — иначе совпадение нормалей ничего бы не значило.
    expect(tilted).toBeGreaterThan(0);
  });
});

// ------------------------------------- кромка стенки под разбитым полом

describe('кромка стенки идёт по той же выборке, что кромка пола (REND-9)', () => {
  const N = DEFAULT_CURVATURE_TESSELLATION;

  /** Арена, где клетки (1,1) и (2,1) подняты на уровень 1, кривизна — на (1,1). */
  function ledge() {
    const levels = rows('0');
    levels[1] = `011${levels[1]!.slice(3)}`;
    const grid = createTerrainGrid({
      width: DOC_WIDTH,
      height: DOC_HEIGHT,
      tileSize: FIXED_ONE,
      levels,
      flags: rows('.'),
    });
    return { grid, surface: createVisualSurface(grid, STEP, docCurvature([[1, 1]])) };
  }

  it('верх стенки совпадает с кромкой пола в каждой точке разбиения — зазора нет', () => {
    const { grid, surface } = ledge();
    expect(grid.cliffs.length).toBeGreaterThan(0);
    // Кромка плато под стенкой идёт по сглаженной кривизне, а не по прямой.
    expect(surface.hasCellCurvature(2, 1)).toBe(true);

    const bounds = { x0: 0, y0: 0, w: 8, h: 8 };
    const floor = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 8, 8, surface, N);
    const walls = buildWallGeometry(grid, STEP, surface, bounds, N);
    // Разбитая стенка: полоса из N квадов вместо одного на отрезок.
    expect(walls.positions.length / 3).toBeGreaterThan(grid.cliffs.length * 4);

    const floorPoints = new Set<string>();
    for (let v = 0; v < floor.positions.length; v += 3) {
      floorPoints.add(
        `${floor.positions[v]!.toFixed(6)}|${floor.positions[v + 1]!.toFixed(6)}|${floor.positions[v + 2]!.toFixed(6)}`,
      );
    }
    // Вершины 2 и 3 каждого квада полосы — верхняя кромка (см. buildWallGeometry).
    let tops = 0;
    for (let vertex = 0; vertex * 3 < walls.positions.length; vertex++) {
      if (vertex % 4 !== 2 && vertex % 4 !== 3) continue;
      const v = vertex * 3;
      const key = `${walls.positions[v]!.toFixed(6)}|${walls.positions[v + 1]!.toFixed(6)}|${walls.positions[v + 2]!.toFixed(6)}`;
      expect(floorPoints.has(key)).toBe(true);
      tops++;
    }
    expect(tops).toBeGreaterThan(0);
  });

  it('отрезок без кривизны с обеих сторон остаётся одним квадом', () => {
    const grid = docGridRaised(20, 5); // далеко от мазка кривизны
    const surface = createVisualSurface(grid, STEP, docCurvature([[1, 1]]));
    const walls = buildWallGeometry(grid, STEP, surface, undefined, N);
    expect(walls.positions.length / 3).toBe(grid.cliffs.length * 4);
  });
});

// ------------------------------------------------- юбка границы пола (REND-7)

describe('юбка обрыва по границе пола (REND-7)', () => {
  const N = DEFAULT_CURVATURE_TESSELLATION;
  const DEPTH = 3;

  /** Остров 3×3: пол только в центре, уровень 0 везде — обрывов ядра нет. */
  function islandGrid() {
    return createTerrainGrid({
      width: 3,
      height: 3,
      tileSize: FIXED_ONE,
      levels: ['000', '000', '000'],
      flags: ['___', '_._', '___'],
    });
  }

  it('остров: рёбра клетки с полом дают полосы от кромки пола вниз на глубину', () => {
    const grid = islandGrid();
    // Уровни равны — cliff-отрезков ядро не выводит; юбка — единственный обрыв.
    expect(grid.cliffs.length).toBe(0);
    const data = buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, 0, 0, 3, 3);
    expect(data.indices.length).toBe(4 * 6); // четыре ребра центральной клетки
    for (let v = 0; v < data.positions.length; v += 3) {
      const z = data.positions[v + 2]!;
      expect(Math.abs(z) < 1e-6 || Math.abs(z + DEPTH) < 1e-6).toBe(true);
    }
  });

  it('край сетки — та же граница пола: у арены без дыр юбка идёт по периметру', () => {
    const grid = cliffGrid(); // 2×2, пол везде, правый столбец — уровень 1
    const data = buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, 0, 0, 2, 2);
    expect(data.indices.length).toBe(8 * 6); // восемь рёбер периметра
    // Кромки правого столбца стоят на высоте уровня 1 — юбка следует ступеням.
    let atStep = 0;
    for (let vertex = 0; vertex * 3 < data.positions.length; vertex++) {
      if (vertex % 4 !== 2 && vertex % 4 !== 3) continue;
      if (Math.abs(data.positions[vertex * 3 + 2]! - STEP) < 1e-6) atStep++;
    }
    expect(atStep).toBeGreaterThan(0);
  });

  it('глубина 0 выключает юбку — геометрия пуста', () => {
    const grid = islandGrid();
    expect(buildSkirtGeometry(grid, grid.floor, STEP, 0, 0, 0, 3, 3).indices.length).toBe(0);
  });

  it('бесконечная глубина — низ юбки на SKIRT_BOTTOMLESS_Z, квадов не больше', () => {
    const grid = islandGrid();
    const finite = buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, 0, 0, 3, 3);
    const data = buildSkirtGeometry(
      grid,
      grid.floor,
      STEP,
      Number.POSITIVE_INFINITY,
      0,
      0,
      3,
      3,
    );
    expect(data.indices.length).toBe(finite.indices.length);
    // Вершины 0 и 1 каждого квада — нижняя кромка (см. pushSkirt): плоский низ
    // ниже любой видимой точки сцены, верхняя кромка — прежняя кромка пола.
    for (let vertex = 0; vertex * 3 < data.positions.length; vertex++) {
      const z = data.positions[vertex * 3 + 2]!;
      if (vertex % 4 === 0 || vertex % 4 === 1) expect(z).toBe(SKIRT_BOTTOMLESS_Z);
      else expect(Math.abs(z) < 1e-6).toBe(true);
    }
    // Бесконечность не просачивается в буферы: геометрия остаётся конечной.
    expect(data.positions.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('на ребре со стенкой cliff-отрезка юбка начинается от нижней высоты пары', () => {
    // Слева пол уровня 0, справа дыра уровня 1: между ними стенка ядра [0, STEP].
    const grid = createTerrainGrid({
      width: 2,
      height: 1,
      tileSize: FIXED_ONE,
      levels: ['01'],
      flags: ['._'],
    });
    expect(grid.cliffs.length).toBe(1);
    const data = buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, 0, 0, 2, 1);
    expect(data.indices.length).toBe(4 * 6); // четыре ребра клетки с полом
    // Ни одна вершина не поднимается выше нижней высоты пары: пролёт [0, STEP]
    // восточного ребра уже накрыт стенкой — юбка продолжает её вниз встык.
    for (let v = 0; v < data.positions.length; v += 3) {
      expect(data.positions[v + 2]!).toBeLessThanOrEqual(1e-6);
    }
  });

  it('ребро принадлежит чанку клетки с полом — объединение чанков без дублей', () => {
    const grid = docGrid(); // 24×8, три чанка по 8
    const whole = buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, 0, 0, DOC_WIDTH, DOC_HEIGHT);
    expect(whole.indices.length).toBe(2 * (DOC_WIDTH + DOC_HEIGHT) * 6); // периметр
    let sum = 0;
    for (let cx = 0; cx < DOC_WIDTH / CHUNK; cx++) {
      sum += buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, cx * CHUNK, 0, CHUNK, DOC_HEIGHT)
        .indices.length;
    }
    expect(sum).toBe(whole.indices.length);
  });

  it('кромка юбки идёт той же выборкой, что кромка пола над ней (REND-9)', () => {
    const grid = docGrid();
    const surface = createVisualSurface(grid, STEP, docCurvature([[0, 0]]));
    expect(surface.hasCellCurvature(0, 0)).toBe(true);

    const floor = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 8, 8, surface, N);
    const skirt = buildSkirtGeometry(grid, grid.floor, STEP, DEPTH, 0, 0, 8, 8, surface, N);
    // Рёбра клетки с кривизной разбиты: квадов больше, чем рёбер границы.
    expect(skirt.indices.length).toBeGreaterThan((8 + 8 + 8) * 6);

    const floorPoints = new Set<string>();
    for (let v = 0; v < floor.positions.length; v += 3) {
      floorPoints.add(
        `${floor.positions[v]!.toFixed(6)}|${floor.positions[v + 1]!.toFixed(6)}|${floor.positions[v + 2]!.toFixed(6)}`,
      );
    }
    // Вершины 2 и 3 каждого квада полосы — верхняя кромка (см. pushSkirt).
    let tops = 0;
    for (let vertex = 0; vertex * 3 < skirt.positions.length; vertex++) {
      if (vertex % 4 !== 2 && vertex % 4 !== 3) continue;
      const v = vertex * 3;
      const key = `${skirt.positions[v]!.toFixed(6)}|${skirt.positions[v + 1]!.toFixed(6)}|${skirt.positions[v + 2]!.toFixed(6)}`;
      expect(floorPoints.has(key)).toBe(true);
      tops++;
    }
    expect(tops).toBeGreaterThan(0);
  });

  it('выбитый пол растит юбку соседей — и в смежном чанке — не позже следующего кадра', () => {
    const grid = docGrid();
    const subsystem = new TerrainSubsystem(grid, { chunkSize: CHUNK });
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
    subsystem.init(ctx);
    const before = subsystem.skirtVertexCount;
    expect(before).toBe(2 * (DOC_WIDTH + DOC_HEIGHT) * 4); // юбка периметра сетки

    // Клетка (8,4) — первый столбец второго чанка: ребро её западного соседа
    // (7,4) принадлежит чанку 0, и пересобраться обязан и он (TERR-6, REND-7).
    const cell = 4 * DOC_WIDTH + 8;
    const bits = new Uint8Array(grid.floor);
    bits[cell] = 0;
    subsystem.syncTick(makeTickView([], { floorBits: bits, floorChangedCells: [cell] }));
    subsystem.updateFrame(0.016, 0);
    // Четыре новых ребра вокруг дыры — по одному от каждого соседа с полом.
    expect(subsystem.skirtVertexCount).toBe(before + 4 * 4);
  });

  it('юбка не регистрируется теневым кастером и уходит на dispose (REND-31)', () => {
    const grid = islandGrid();
    const casters: THREE.Object3D[] = [];
    const subsystem = new TerrainSubsystem(grid, {
      shadows: {
        setCaster: (mesh) => casters.push(mesh),
        dropCaster: () => {},
        invalidateStatic: () => {},
      },
    });
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
    subsystem.init(ctx);
    expect(subsystem.skirtVertexCount).toBeGreaterThan(0);
    expect(casters.some((mesh) => mesh.name.startsWith('terrain:skirt'))).toBe(false);

    subsystem.dispose();
    expect(subsystem.skirtVertexCount).toBe(0);
    expect(ctx.scene.children.filter((node) => node instanceof THREE.Mesh)).toHaveLength(0);
  });
});

describe('REND-39: текстурирование поверхности — tileset, раскраска, стенки', () => {
  const GRASS = 'visuals/textures/ground-grass.png';
  const DIRT = 'visuals/textures/ground-dirt.png';
  const WALL_ID = 'visuals/textures/ground-cliff.png';
  const PAINT_ID = 'visuals/duel.paint.json';
  const WALL_PERIOD = 2;
  const image = { width: 2, height: 2, format: 'rgba8' as const, pixels: new Uint8Array(16) };

  /** Tileset из двух слотов пола и породы стенок — минимум, на котором виден шов. */
  const tileset = {
    slots: [
      { texture: GRASS, period: 6 },
      { texture: DIRT, period: 3 },
    ],
    wall: { texture: WALL_ID, period: WALL_PERIOD },
  };

  /** Карта раскраски 2×2: левый столбец — слот 0, правый — слот 1. */
  function paintMap(rows: readonly string[] = ['01', '01']) {
    const result = validateTerrainPaint({ width: 2, height: 2, rows: [...rows] });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.map;
  }

  function setup(options: { rows?: readonly string[]; grid?: ReturnType<typeof cliffGrid> } = {}) {
    const assets = makeAssets();
    const warnings: string[] = [];
    const subsystem = new TerrainSubsystem(options.grid ?? cliffGrid(), {
      tileset,
      paintMap: PAINT_ID,
      warn: (message) => warnings.push(message),
    });
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    subsystem.init(ctx);
    const meshOf = (name: string): THREE.Mesh => {
      const mesh = ctx.scene.children.find(
        (node): node is THREE.Mesh => node instanceof THREE.Mesh && node.name === name,
      );
      if (mesh === undefined) throw new Error(`меша ${name} нет в сцене`);
      return mesh;
    };
    const materialOf = (name: string): THREE.MeshStandardMaterial =>
      meshOf(name).material as THREE.MeshStandardMaterial;
    const ready = (rows?: readonly string[]): void => {
      assets.resolve('terrain-paint', PAINT_ID, paintMap(rows));
      assets.resolve('texture', GRASS, image);
      assets.resolve('texture', DIRT, image);
    };
    return { assets, warnings, subsystem, ctx, meshOf, materialOf, ready };
  }

  it('без tileset модуль ассетов не спрашивается, а у пола нет ни uv, ни весов', () => {
    const assets = makeAssets();
    const subsystem = new TerrainSubsystem(cliffGrid());
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    subsystem.init(ctx);
    expect(assets.requests).toHaveLength(0);
    const floor = ctx.scene.getObjectByName('terrain:chunk:0,0') as THREE.Mesh;
    expect(floor.geometry.getAttribute('uv')).toBeUndefined();
    expect(floor.geometry.getAttribute(TERRAIN_PAINT_ATTRIBUTE)).toBeUndefined();
  });

  it('веса слотов: в центре клетки единица своего, в узле четырёх — поровну', () => {
    const { meshOf, ready } = setup();
    ready();
    const geometry = meshOf('terrain:chunk:0,0').geometry;
    const position = geometry.getAttribute('position');
    const paint = geometry.getAttribute(TERRAIN_PAINT_ATTRIBUTE);
    expect(paint.count).toBe(position.count);

    // Узел (1, 1) — общий угол четырёх клеток: два слота по две клетки каждый.
    const node = (x: number, y: number): number[] | null => {
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getX(i) - x) > 1e-9 || Math.abs(position.getY(i) - y) > 1e-9) continue;
        return [paint.getX(i), paint.getY(i), paint.getZ(i), paint.getW(i)];
      }
      return null;
    };
    expect(node(1, 1)).toEqual([0.5, 0.5, 0, 0]);
    // Узел (0, 0) — угол арены: примыкает одна клетка слота 0, и вес нормирован.
    expect(node(0, 0)).toEqual([1, 0, 0, 0]);
    // Узел (2, 0) — правый край: примыкает одна клетка слота 1.
    expect(node(2, 0)).toEqual([0, 1, 0, 0]);
    // Сумма весов — единица в КАЖДОЙ вершине: кромка арены не выцветает.
    for (let i = 0; i < paint.count; i++) {
      expect(paint.getX(i) + paint.getY(i) + paint.getZ(i) + paint.getW(i)).toBeCloseTo(1, 6);
    }
  });

  it('стенки и юбка кроются своей записью: проекция вдоль стенки и по высоте', () => {
    const { assets, meshOf, ready } = setup();
    ready();
    assets.resolve('texture', WALL_ID, image);
    // У пола своего uv нет: слот проецируется фрагментом по мировой точке.
    expect(meshOf('terrain:chunk:0,0').geometry.getAttribute('uv')).toBeUndefined();
    for (const name of ['terrain:walls:0,0', 'terrain:skirt:0,0']) {
      const geometry = meshOf(name).geometry;
      const pos = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      expect(uv.count, name).toBe(pos.count);
      for (let i = 0; i < pos.count; i++) {
        expect(uv.getX(i), name).toBeCloseTo((pos.getX(i) + pos.getY(i)) / WALL_PERIOD, 6);
        expect(uv.getY(i), name).toBeCloseTo(pos.getZ(i) / WALL_PERIOD, 6);
      }
      // Слоты пола на вертикальную грань не приезжают вовсе.
      expect(geometry.getAttribute(TERRAIN_PAINT_ATTRIBUTE), name).toBeUndefined();
    }
  });

  it('материал пола смешивает слоты, оставаясь стандартным: свет и тени прежним механизмом', () => {
    const { materialOf, ready } = setup();
    ready();
    const floor = materialOf('terrain:chunk:0,0');
    expect(floor).toBeInstanceOf(THREE.MeshStandardMaterial);
    // Цвет — множитель поверх смеси: белый отдаёт текстуры как есть.
    expect(floor.color.getHex()).toBe(0xffffff);
    expect(floor.customProgramCacheKey()).toContain('2');

    // Текст программы собирается штатным `onBeforeCompile`: подменяется ровно
    // карта цвета, а свет, тени и туман остаются механизмом three.
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: 'void main() {\n#include <map_fragment>\n}',
    };
    floor.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain(`attribute vec4 ${TERRAIN_PAINT_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain('vTerrainWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    // Ровно два семпла — по числу слотов tileset'а, и период у каждого свой.
    expect([...shader.fragmentShader.matchAll(/texture2D\(tSlot/gu)]).toHaveLength(2);
    expect(shader.fragmentShader).toContain('uSlotPeriod.x');
    expect(shader.fragmentShader).toContain('uSlotPeriod.y');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= blended;');
    // Униформы — те же объекты, что держит подсистема: доехавшая текстура
    // видна программе без пересборки материала.
    expect((shader.uniforms.tSlot0!.value as THREE.Texture).wrapS).toBe(THREE.RepeatWrapping);
    const period = shader.uniforms.uSlotPeriod!.value as THREE.Vector4;
    expect([period.x, period.y]).toEqual([6, 3]);
  });

  it('потолок пресета убирает выборки из программы и сливает хвост tileset в последний слот', () => {
    const { materialOf, meshOf, subsystem, ready } = setup();
    ready();
    subsystem.applyQuality(new Map([['terrain.textureSlots', 1]]));

    const floor = materialOf('terrain:chunk:0,0');
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <begin_vertex>',
      fragmentShader: '#include <map_fragment>',
    };
    floor.onBeforeCompile(shader as never, null as never);
    expect([...shader.fragmentShader.matchAll(/texture2D\(tSlot/gu)]).toHaveLength(1);
    // Веса пересчитаны: клетка слота 1 нарисована оставшимся слотом 0, а не чёрным.
    const paint = meshOf('terrain:chunk:0,0').geometry.getAttribute(TERRAIN_PAINT_ATTRIBUTE);
    for (let i = 0; i < paint.count; i++) expect(paint.getX(i)).toBeCloseTo(1, 6);
  });

  it('карта не той сетки — предупреждение и террейн без текстурирования', () => {
    const { assets, warnings, meshOf } = setup();
    const wrong = validateTerrainPaint({ width: 3, height: 3, rows: ['000', '000', '000'] });
    if (!wrong.ok) throw new Error(wrong.errors.join('; '));
    assets.resolve('terrain-paint', PAINT_ID, wrong.map);
    assets.resolve('texture', GRASS, image);
    expect(warnings.join('\n')).toContain('не совпадает с сеткой террейна');
    expect(meshOf('terrain:chunk:0,0').geometry.getAttribute(TERRAIN_PAINT_ATTRIBUTE)).toBeUndefined();
  });

  it('слот за пределом объявленных — предупреждение с адресом клетки', () => {
    const { warnings, ready } = setup();
    ready(['05', '01']);
    expect(warnings.join('\n')).toContain('клетка (1, 0)');
    expect(warnings.join('\n')).toContain('за пределом объявленных');
  });

  it('недоступная текстура слота — предупреждение с причиной, а не отказ кадра', () => {
    const { assets, warnings, meshOf } = setup();
    assets.fail('texture', GRASS, 'файл не читается');
    expect(warnings.join('\n')).toContain('файл не читается');
    expect(warnings.join('\n')).toContain('заливка цветом');
    expect(meshOf('terrain:chunk:0,0')).toBeDefined();
  });

  it('стенки и юбка делят одну текстуру, юбка темнее тоном', () => {
    const { assets, materialOf } = setup();
    assets.resolve('texture', WALL_ID, image);
    const walls = materialOf('terrain:walls:0,0');
    const skirt = materialOf('terrain:skirt:0,0');
    expect(walls.map).not.toBeNull();
    expect(skirt.map).toBe(walls.map);
    expect(walls.color.getHex()).toBe(0xffffff);
    expect(skirt.color.getHex()).toBeLessThan(0xffffff);
  });

  it('снос отдаёт текстуры слотов (REND-31)', () => {
    const { assets, materialOf, subsystem, ready } = setup();
    ready();
    assets.resolve('texture', WALL_ID, image);
    // Текстура стенок — обычная карта материала, и её видно снаружи; ею и
    // меряется освобождение: слоты пола живут в тех же подписках и уходят с ней.
    const map = materialOf('terrain:walls:0,0').map!;
    let disposed = false;
    map.addEventListener('dispose', () => {
      disposed = true;
    });
    subsystem.dispose();
    expect(disposed).toBe(true);
  });
});

// ------------- раздельные причины пометки и раскладка обрывов по чанкам (T-5)

describe('REND-7: пол и стенки метятся раздельно — выбитый пол стен не двигает', () => {
  function stand(chunkSize = 8) {
    const grid = createTerrainGrid({
      width: 8,
      height: 8,
      tileSize: FIXED_ONE,
      // Возвышенный столбец x = 4: cliff-отрезки ядра идут по его границам.
      levels: Array.from({ length: 8 }, () => '00001000'),
      flags: Array.from({ length: 8 }, () => '........'),
    });
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
    const subsystem = new TerrainSubsystem(grid, { chunkSize });
    subsystem.init(ctx);
    return { grid, ctx, subsystem };
  }

  it('мутация пола пересобирает пол и юбку, а меш стенок остаётся тем же объектом', () => {
    const { grid, ctx, subsystem } = stand();
    const walls = ctx.scene.getObjectByName('terrain:walls:0,0');
    const floor = ctx.scene.getObjectByName('terrain:chunk:0,0');
    expect(walls).toBeDefined();
    expect(subsystem.wallVertexCount).toBeGreaterThan(0);

    const bits = new Uint8Array(grid.floor);
    bits[0] = 0;
    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.syncTick(makeTickView([], { floorBits: bits, floorChangedCells: [0] }));
      subsystem.updateFrame(0.016, 1);
    });

    // Пол и юбка пересобраны — дыра видна не позже следующего кадра (TERR-6).
    expect(ctx.scene.getObjectByName('terrain:chunk:0,0')).not.toBe(floor);
    expect(counters.terrainChunksRebuilt).toBe(1);
    expect(counters.terrainFloorQuads).toBeGreaterThan(0);
    // А стенки — тот же объект сцены и ни одного пересчитанного квада: пол
    // cliff-геометрию изменить не может (TERR-5), и платить за неё незачем.
    expect(ctx.scene.getObjectByName('terrain:walls:0,0')).toBe(walls);
    expect(counters.terrainWallQuads).toBe(0);
    expect(subsystem.wallVertexCount).toBeGreaterThan(0);
  });

  it('правка уровня пересобирает и стенки: раздельность множеств не теряет форму', () => {
    const { ctx, subsystem } = stand();
    const walls = ctx.scene.getObjectByName('terrain:walls:0,0');
    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.applyGrid(
        createTerrainGrid({
          width: 8,
          height: 8,
          tileSize: FIXED_ONE,
          levels: Array.from({ length: 8 }, () => '00011000'),
          flags: Array.from({ length: 8 }, () => '........'),
        }),
      );
      subsystem.updateFrame(0.016, 1);
    });
    expect(ctx.scene.getObjectByName('terrain:walls:0,0')).not.toBe(walls);
    expect(counters.terrainWallQuads).toBeGreaterThan(0);
  });

  it('раскладка обрывов по чанкам-владельцам даёт ровно прежнюю геометрию', () => {
    // Объединение стенок всех чанков — это `grid.cliffs` и ни одного отрезка
    // дважды: предподсчёт обязан быть разбиением, а не эвристикой.
    const { grid, ctx, subsystem } = stand(4);
    let quads = 0;
    for (const node of ctx.scene.children) {
      if (!node.name.startsWith('terrain:walls:')) continue;
      quads += (node as THREE.Mesh).geometry.getIndex()!.count / 6;
    }
    expect(quads).toBe(grid.cliffs.length);
    expect(subsystem.wallVertexCount).toBe(grid.cliffs.length * 4);
  });
});

// ---------------------------- снос подсистемы террейна (REND-31, T-7, T-11)

describe('REND-31: снесённый террейн не метит чанков и не строит мешей', () => {
  it('правка поверхности после сноса не двигает ни одного счётчика', () => {
    const grid = docGrid();
    const surface = new VisualSurfaceSource(grid);
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
    const subsystem = new TerrainSubsystem(grid, { chunkSize: CHUNK, surface });
    subsystem.init(ctx);
    subsystem.dispose();

    const counters = createCostCounters();
    withCostSink(counters, () => {
      // Кисть кривизны после сноса: подписки уже нет.
      surface.setCurvature(docCurvature([[1, 1]]));
      subsystem.updateFrame(0.016, 1);
    });
    expect(counters.terrainChunksMarked).toBe(0);
    expect(counters.terrainChunksRebuilt).toBe(0);
    expect(ctx.scene.children).toEqual([]);
  });

  it('applyGrid после сноса не строит мешей в чужую сцену', () => {
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
    const subsystem = new TerrainSubsystem(docGrid(), { chunkSize: CHUNK });
    subsystem.init(ctx);
    subsystem.dispose();
    subsystem.applyGrid(docGridRaised(1, 1));
    subsystem.updateFrame(0.016, 1);
    expect(ctx.scene.children).toEqual([]);
  });

  it('при подключённом источнике поверхности мазок метится один раз, а не дважды', () => {
    const grid = docGrid();
    const surface = new VisualSurfaceSource(grid);
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: STEP },
    };
    const subsystem = new TerrainSubsystem(grid, { chunkSize: CHUNK, surface });
    subsystem.init(ctx);
    // Тот же канал, которым правка доезжает до подсистемы (REND-9).
    const notified: number[] = [];
    surface.onChange((cells) => {
      if (cells !== null) notified.push(...cells);
    });

    const marked = createCostCounters();
    withCostSink(marked, () => {
      subsystem.applyGrid(docGridRaised(1, 1));
    });

    // Клетка (1, 1) и вся её окрестность SHAPE_RADIUS лежат в чанке 0, поэтому
    // каждая названная источником клетка даёт ровно одну пометку: счётчик
    // обязан совпасть с длиной уведомления. Отметив те же клетки ещё и сам,
    // террейн показывал бы вдвое больше работы, чем сделано, — пересборка при
    // этом одна.
    expect(notified.length).toBeGreaterThan(0);
    expect(marked.terrainChunksMarked).toBe(notified.length);

    const rebuilt = createCostCounters();
    withCostSink(rebuilt, () => {
      subsystem.updateFrame(0.016, 1);
    });
    expect(rebuilt.terrainChunksRebuilt).toBe(1);
  });
});

// ------------------ кромка стенки и юбки без поля идёт по углам рампы (T-11)

describe('REND-9: без источника поверхности кромка стенки — углы рампы, не уровень', () => {
  it('cornerHeight на рампе отдаёт угол cornerLevels, а не плоский уровень клетки', () => {
    // Клетка 0 — рампа нулевого уровня на плато уровня 1: её восточные углы
    // подняты к проходимому соседу (TERR-5), и пол с юбкой стоят именно на них.
    const grid = rampGrid();
    expect(cornerLevels(grid, 0, 0)).toEqual([0, 1, 1, 0]);

    // Узел (1, 0) — восточный угол рампы: высота кромки стенки обязана совпасть
    // с высотой пола там же, иначе между ними щель.
    expect(cornerHeight(grid, STEP, undefined, 0, 1, 0)).toBeCloseTo(1 * STEP, 9);
    // А западный угол остался на своём уровне.
    expect(cornerHeight(grid, STEP, undefined, 0, 0, 0)).toBeCloseTo(0, 9);
    // Ветвь с полем отвечает тем же: правило одно, реализации две быть не должно.
    const surface = createVisualSurface(grid, STEP);
    expect(cornerHeight(grid, STEP, surface, 0, 1, 0)).toBeCloseTo(1 * STEP, 9);
  });

  it('sampleWallSide без поля идёт по билинейной площадке углов, а не по уровню', () => {
    const grid = rampGrid();
    // Восточное ребро рампы (u = 1): оба его угла подняты — высота 1 × STEP.
    expect(sampleWallSide(grid, STEP, undefined, 0, 1, 0.5)).toBeCloseTo(1 * STEP, 9);
    // Середина клетки — половина подъёма, как у плоскости пола.
    expect(sampleWallSide(grid, STEP, undefined, 0, 0.5, 0.5)).toBeCloseTo(0.5 * STEP, 9);
    // С полем — та же величина: выборка одна (REND-9).
    const surface = createVisualSurface(grid, STEP);
    expect(sampleWallSide(grid, STEP, surface, 0, 0.5, 0.5)).toBeCloseTo(0.5 * STEP, 9);
  });

  it('юбка под рампой начинается от той же кромки, что и пол — своей копии правила нет', () => {
    const grid = rampGrid();
    // Юбка идёт по границе сетки; южное ребро клетки-рампы (y = 0) тянется от
    // её углов c00 = 0 и c10 = 1 × STEP.
    const skirt = buildSkirtGeometry(grid, grid.floor, STEP, 1, 0, 0, 1, 1);
    const tops = new Map<number, number>();
    for (let v = 0; v < skirt.positions.length; v += 3) {
      if (Math.abs(skirt.positions[v + 1]!) > 1e-9) continue; // ребро y = 0
      const x = skirt.positions[v]!;
      const z = skirt.positions[v + 2]!;
      tops.set(x, Math.max(tops.get(x) ?? Number.NEGATIVE_INFINITY, z));
    }
    expect(tops.get(0)).toBeCloseTo(0, 9);
    expect(tops.get(1)).toBeCloseTo(1 * STEP, 9);
  });
});
