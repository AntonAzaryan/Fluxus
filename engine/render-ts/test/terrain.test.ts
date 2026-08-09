/**
 * Террейн-ступени (REND-7): площадки, стенки по cliff-отрезкам ядра, рампы,
 * дыры и пересборка чанка по мутации пола. Плюс документный вход `applyGrid`
 * (ED-10, ED-11, ED-15) и возврат пола документа после превью (ED-9).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@game-mvp/core';
import { validateCurvatureMap, type TerrainCurvatureMap } from '@game-mvp/assets';
import {
  DEFAULT_CURVATURE_TESSELLATION,
  TerrainSubsystem,
  VisualSurfaceSource,
  buildFloorGeometry,
  buildWallGeometry,
  cornerLevels,
  createVisualSurface,
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

    // Стенки + один чанк пола.
    expect(ctx.scene.children.length).toBe(2);
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
  const map = rows('.');
  for (const [x, y] of cells) {
    map[y] = `${map[y]!.slice(0, x)}7${map[y]!.slice(x + 1)}`;
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
    const n = DEFAULT_CURVATURE_TESSELLATION;
    const curved = 9;
    expect(subsystem.floorVertexCount).toBe(
      curved * n * n * 4 + (DOC_WIDTH * DOC_HEIGHT - curved) * 4,
    );
  });

  it('смена размеров арены пересобирает раскладку чанков', () => {
    const { subsystem, ctx } = setup();
    expect(ctx.scene.children.length).toBe(3); // три чанка пола, обрывов нет

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
    expect(ctx.scene.children.length).toBe(1);
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
    expect(curved.positions.length / 3).toBe(N * N * 4);
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
    // Подквады ребра не сварены между собой, поэтому по две вершины на каждый.
    expect(onEdge).toBe(2 * N);
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
