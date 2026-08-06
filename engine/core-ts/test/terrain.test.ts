import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { addComponent, getField, setField, spawn } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { mathApi } from '../src/math/mathApi.js';
import { loadScene } from '../src/sim/scene.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { createTerrainGrid, FLOOR_COMPONENT, terrainPrefab, type TerrainDef } from '../src/systems/terrain.js';
import { LEVEL_OVERRIDE_COMPONENT } from '../src/types.js';

const TILE = fixed.fromInt(2);

/**
 * Четыре клетки в ряд: ступенька 0→1 без рампы, потом рампа 1→2 шириной в два
 * ряда, потом дыра в полу.
 */
const def: TerrainDef = {
  width: 4,
  height: 2,
  tileSize: TILE,
  levels: ['0122', '0122'],
  flags: ['..^_', '..^.'],
};

const scene = (terrain: TerrainDef) =>
  loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
    ],
    prefabs: [{ name: 'Actor', components: { Position: { x: 0, y: 0 } } }],
    terrain,
  });

/** Точка в центре клетки — чтобы тест не зависел от того, какой клетке принадлежит граница. */
const at = (cx: number, cy: number) => ({
  x: fixed.fromInt(cx * 2 + 1),
  y: fixed.fromInt(cy * 2 + 1),
});

describe('ассет террейна (TERR-2, TERR-3)', () => {
  it('читает обе карты и размеры', () => {
    const grid = createTerrainGrid(def);
    expect(grid.width).toBe(4);
    expect(grid.tileSize).toBe(TILE);
    expect([...grid.levels]).toEqual([0, 1, 2, 2, 0, 1, 2, 2]);
    expect([...grid.ramps]).toEqual([0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...grid.floor]).toEqual([1, 1, 1, 0, 1, 1, 1, 1]);
  });

  it('отвергает уровень в нижнем регистре', () => {
    expect(() => createTerrainGrid({ ...def, levels: ['012a', '0122'] })).toThrow(/TERR-3/);
  });

  it('отвергает карты, переставленные местами', () => {
    expect(() => createTerrainGrid({ ...def, levels: def.flags })).toThrow(/TERR-3/);
  });

  it('отвергает рваную сетку', () => {
    expect(() => createTerrainGrid({ ...def, levels: ['0122', '012'] })).toThrow(/TERR-2/);
    expect(() => createTerrainGrid({ ...def, flags: ['..^_'] })).toThrow(/TERR-2/);
  });

  it('отвергает арену, не влезающую в Q16.16', () => {
    expect(() => createTerrainGrid({ ...def, width: 40000, tileSize: fixed.fromInt(4) })).toThrow(
      /TERR-2/,
    );
  });

  it('отвергает рампу в одну клетку (TERR-7)', () => {
    expect(() => createTerrainGrid({ ...def, flags: ['..^_', '....'] })).toThrow(/TERR-7/);
  });
});

describe('cliff-геометрия (TERR-5)', () => {
  /** Два одинаковых ряда: рампа получает соседа того же уровня (TERR-7), горизонтальных границ нет. */
  const edges = (row: string, flagRow: string) =>
    createTerrainGrid({
      width: 2,
      height: 2,
      tileSize: TILE,
      levels: [row, row],
      flags: [flagRow, flagRow],
    }).cliffs;

  it('перепад без рампы даёт границу', () => {
    expect(edges('01', '..')).toEqual([
      { from: { x: TILE, y: 0 }, to: { x: TILE, y: TILE }, levelNeg: 0, levelPos: 1 },
      { from: { x: TILE, y: TILE }, to: { x: TILE, y: fixed.fromInt(4) }, levelNeg: 0, levelPos: 1 },
    ]);
  });

  it('равные уровни границы не дают', () => {
    expect(edges('11', '..')).toEqual([]);
  });

  it('перепад в единицу с рампой проходим', () => {
    expect(edges('01', '.^')).toEqual([]);
  });

  it('перепад больше единицы непроходим даже с рампами', () => {
    expect(edges('02', '^^')).toHaveLength(2);
  });

  it('обрыв по вертикали даёт горизонтальный отрезок', () => {
    const grid = createTerrainGrid({
      width: 1,
      height: 2,
      tileSize: TILE,
      levels: ['0', '3'],
      flags: ['.', '.'],
    });
    expect(grid.cliffs).toEqual([
      { from: { x: 0, y: TILE }, to: { x: TILE, y: TILE }, levelNeg: 0, levelPos: 3 },
    ]);
  });

  it('отрезок несёт уровни обеих сторон в обеих ориентациях (TERR-5, PHYS-11)', () => {
    // Вертикальные рёбра: слева уровень 2, справа 0 — `levelNeg` берёт сторону
    // меньшей координаты по нормали, а не меньший из уровней.
    expect(edges('20', '..')).toEqual([
      { from: { x: TILE, y: 0 }, to: { x: TILE, y: TILE }, levelNeg: 2, levelPos: 0 },
      { from: { x: TILE, y: TILE }, to: { x: TILE, y: fixed.fromInt(4) }, levelNeg: 2, levelPos: 0 },
    ]);
    // Горизонтальные рёбра: сверху 0, снизу 2.
    const grid = createTerrainGrid({
      width: 2,
      height: 2,
      tileSize: TILE,
      levels: ['00', '22'],
      flags: ['..', '..'],
    });
    expect(grid.cliffs).toEqual([
      { from: { x: 0, y: TILE }, to: { x: TILE, y: TILE }, levelNeg: 0, levelPos: 2 },
      { from: { x: TILE, y: TILE }, to: { x: fixed.fromInt(4), y: TILE }, levelNeg: 0, levelPos: 2 },
    ]);
  });
});

describe('запросы террейна (TERR-4)', () => {
  it('уровень выводится из позиции', () => {
    const { terrain } = scene(def);
    expect(terrain!.levelAt(at(0, 0))).toBe(0);
    expect(terrain!.levelAt(at(1, 1))).toBe(1);
    expect(terrain!.levelAt(at(3, 0))).toBe(2);
  });

  it('вне сетки берётся ближайшая клетка', () => {
    const { terrain } = scene(def);
    expect(terrain!.levelAt({ x: fixed.fromInt(-100), y: 0 })).toBe(0);
    expect(terrain!.levelAt({ x: fixed.fromInt(100), y: fixed.fromInt(100) })).toBe(2);
  });

  it('уровень сущности меняется от перемещения без мутации компонентов', () => {
    const { world, terrain } = scene(def);
    const actor = spawn(world, 'Actor');
    expect(terrain!.levelOf(actor)).toBe(0);
    setField(world, actor, 'Position', 'x', at(2, 0).x);
    expect(terrain!.levelOf(actor)).toBe(2);
  });

  it('override уровня приоритетнее производного значения (ARENA-6)', () => {
    const { world, terrain } = scene(def);
    const actor = spawn(world, 'Actor');
    addComponent(world, actor, LEVEL_OVERRIDE_COMPONENT, { level: 7 });
    expect(terrain!.levelOf(actor)).toBe(7);
  });
});

describe('карта пола (TERR-6)', () => {
  it('начальное состояние берётся из флагов ассета', () => {
    const { terrain } = scene(def);
    expect(terrain!.hasFloorAt(at(0, 0))).toBe(true);
    expect(terrain!.hasFloorAt(at(3, 0))).toBe(false);
    expect(terrain!.hasFloorAt(at(3, 1))).toBe(true);
  });

  it('пол — обычный компонент: снятие бита видно запросу', () => {
    const { world, terrain } = scene(def);
    const [floorEntity] = query(world, { all: [FLOOR_COMPONENT] });
    expect(floorEntity).toBeDefined();
    setField(world, floorEntity!, FLOOR_COMPONENT, 'w0', 0);
    expect(terrain!.hasFloorAt(at(0, 0))).toBe(false);
  });

  it('карта длиннее 32 клеток раскладывается по словам', () => {
    const width = 40;
    const levels = ['0'.repeat(width), '0'.repeat(width)];
    const flags = ['_'.repeat(width), '.'.repeat(width)];
    const grid = createTerrainGrid({ width, height: 2, tileSize: TILE, levels, flags });
    const prefab = terrainPrefab(grid);
    const values = prefab.components[FLOOR_COMPONENT]!;
    // Клетки 0..39 без пола, 40..79 с полом: граница проходит внутри слова w1.
    expect(values['w0']).toBe(0);
    expect(values['w1']).toBe(0xffffff00 | 0);
    expect(values['w2']).toBe(0xffff);
  });

  it('начальные слова лежат в компоненте, а не в объекте террейна', () => {
    const { world } = scene(def);
    const [floorEntity] = query(world, { all: [FLOOR_COMPONENT] });
    expect(getField(world, floorEntity!, FLOOR_COMPONENT, 'w0')).toBe(0b11110111);
  });

  it('восстановление пола — та же мутация через Command Buffer', () => {
    const { world, terrain, systems } = scene(def);
    const [floorEntity] = query(world, { all: [FLOOR_COMPONENT] });
    // Клетка (3, 0) — дыра из ассета (`_`): пол в ней не снимали, а ставят впервые.
    const hole = 0 * 4 + 3;
    expect(terrain!.hasFloorAt(at(3, 0))).toBe(false);

    let restore = false;
    systems.register({
      name: 'RestoreFloor',
      order: 1,
      run: (ctx) => {
        if (!restore) return;
        const word = ctx.get(floorEntity!, FLOOR_COMPONENT, 'w0');
        ctx.commands.setField(floorEntity!, FLOOR_COMPONENT, 'w0', word | (1 << hole));
      },
    });
    const sim: Simulation = { systems, worldSeed: 1, math: mathApi, terrain: terrain! };
    const state = initialState(world, 1);
    tick(sim, state);
    const snapshot = takeSnapshot(state);

    restore = true;
    const result = tick(sim, state);
    expect(terrain!.hasFloorAt(at(3, 0))).toBe(true);
    // Уровни не тронуты: восстановление — мутация пола, а не рельефа (TERR-6).
    expect(terrain!.levelAt(at(3, 0))).toBe(2);
    // Установка бита участвует в dirty-дельте наравне со снятием.
    expect([...result.changes.changedEntities(FLOOR_COMPONENT)]).toContain(floorEntity);

    restore = false;
    restoreSnapshot(state, snapshot);
    expect(terrain!.hasFloorAt(at(3, 0))).toBe(false);
  });
});

describe('опорная область (ARENA-5, hasFloorWithin)', () => {
  const F = fixed.fromFloat;
  const point = (x: number, y: number) => ({ x: F(x), y: F(y) });
  // Дыра — клетка (3, 0): x ∈ [6, 8), y ∈ [0, 2) при tileSize = 2.

  it('круг целиком над дырой — пола нет, целиком на полу — есть', () => {
    const { terrain } = scene(def);
    expect(terrain!.hasFloorWithin(point(7, 1), F(0.5))).toBe(false);
    expect(terrain!.hasFloorWithin(point(5, 1), F(0.5))).toBe(true);
  });

  it('круг краем достаёт клетку с полом', () => {
    const { terrain } = scene(def);
    // Центр в дыре, но до клетки (2, 0) с полом 0.25 < 0.5.
    expect(terrain!.hasFloorWithin(point(6.25, 1), F(0.5))).toBe(true);
  });

  it('касание границы клетки с полом — опора есть (включительно)', () => {
    const { terrain } = scene(def);
    expect(terrain!.hasFloorWithin(point(6.5, 1), F(0.5))).toBe(true);
    expect(terrain!.hasFloorWithin(point(6.6, 1), F(0.5))).toBe(false);
  });

  it('нулевой радиус тождествен hasFloorAt', () => {
    const { terrain } = scene(def);
    expect(terrain!.hasFloorWithin(point(7, 1), 0)).toBe(terrain!.hasFloorAt(point(7, 1)));
    expect(terrain!.hasFloorWithin(point(5, 1), 0)).toBe(terrain!.hasFloorAt(point(5, 1)));
  });

  it('круг за краем сетки отвечает по ближайшей клетке (TERR-4)', () => {
    const { terrain } = scene(def);
    // Далеко справа от ряда 1 — ближайшая клетка (3, 1), пол есть.
    expect(terrain!.hasFloorWithin(point(100, 3), fixed.fromInt(1))).toBe(true);
    // Далеко справа от ряда 0 — ближайшая клетка (3, 0), дыра.
    expect(terrain!.hasFloorWithin(point(100, 1), fixed.fromInt(1))).toBe(false);
  });
});
