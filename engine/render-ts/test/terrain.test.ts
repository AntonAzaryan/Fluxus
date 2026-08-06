/**
 * Террейн-ступени (REND-7): площадки, стенки по cliff-отрезкам ядра, рампы,
 * дыры и пересборка чанка по мутации пола.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@game-mvp/core';
import {
  TerrainSubsystem,
  buildFloorGeometry,
  buildWallGeometry,
  cornerLevels,
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
