import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { addComponent, getField, setField, spawn } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { loadScene } from '../src/sim/scene.js';
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
      { from: { x: TILE, y: 0 }, to: { x: TILE, y: TILE } },
      { from: { x: TILE, y: TILE }, to: { x: TILE, y: fixed.fromInt(4) } },
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
    expect(grid.cliffs).toEqual([{ from: { x: 0, y: TILE }, to: { x: TILE, y: TILE } }]);
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
});
