import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { addComponent, getField, setField, spawn } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { mathApi } from '../src/math/mathApi.js';
import { loadScene } from '../src/sim/scene.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import {
  cellAt,
  createTerrainGrid,
  terrainFlagChar,
  terrainLevelChar,
  terrainPrefab,
  FLOOR_COMPONENT,
  TERRAIN_CELL_KINDS,
  TERRAIN_LEVEL_MAX,
  type TerrainCellKind,
  type TerrainDef,
} from '../src/systems/terrain.js';
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

  it('отвергает две рампы, стоящие друг за другом ПО подъёму (TERR-7)', () => {
    // Уровни '0112': обе рампы уровня 1 ведут с нулевого уровня на второй по оси
    // X, то есть стоят одна за другой по направлению подъёма. Соседняя рампа
    // того же уровня у каждой есть, а дорожка всё равно шириной в клетку —
    // ширина меряется ПОПЕРЁК подъёма.
    expect(() =>
      createTerrainGrid({ ...def, levels: ['0112', '0112'], flags: ['.^^.', '....'] }),
    ).toThrow(/TERR-7/);
  });

  it('принимает угловую рампу: ширина есть поперёк одного из двух подъёмов (TERR-7)', () => {
    // У клетки (2, 1) сосед другого уровня есть и по X, и по Y: осей подъёма
    // две. Поперёк подъёма по X у неё стоит рампа того же уровня (2, 0), и
    // этого довольно — по широкой стороне переход проходим.
    expect(() =>
      createTerrainGrid({
        width: 4,
        height: 3,
        tileSize: TILE,
        levels: ['0122', '0122', '0011'],
        flags: ['..^_', '..^.', '....'],
      }),
    ).not.toThrow();
  });
});

/**
 * Запись клетки текстовой карты — обратный ход к разбору (TERR-3). Проверяется
 * не совпадение с таблицей символов, а круг «записали → ядро прочитало то же»:
 * потребитель ассета (редактор, ED-10) второй копии алфавита не держит (ED-1).
 */
describe('запись карт ассета (TERR-3)', () => {
  it('уровень записывается символом, который разбор читает обратно', () => {
    const levels = Array.from({ length: TERRAIN_LEVEL_MAX + 1 }, (_unused, level) => {
      const char = terrainLevelChar(level);
      expect(char).not.toBeNull();
      return char!;
    }).join('');
    const grid = createTerrainGrid({
      width: TERRAIN_LEVEL_MAX + 1,
      height: 1,
      tileSize: TILE,
      levels: [levels],
      flags: ['.'.repeat(TERRAIN_LEVEL_MAX + 1)],
    });
    expect([...grid.levels]).toEqual(
      Array.from({ length: TERRAIN_LEVEL_MAX + 1 }, (_unused, level) => level),
    );
  });

  it('уровень вне диапазона невыразим — запись отвергает его сама', () => {
    expect(terrainLevelChar(TERRAIN_LEVEL_MAX + 1)).toBeNull();
    expect(terrainLevelChar(-1)).toBeNull();
    expect(terrainLevelChar(1.5)).toBeNull();
    expect(terrainLevelChar(Number.NaN)).toBeNull();
  });

  it('вид клетки записывается символом, дающим те же рампу и пол', () => {
    // Виды берутся у самого перечня (TERR-3): кортеж, а не результат `map`, —
    // тогда у каждого символа есть свой вид, а не «элемент массива».
    const flagChar = (kind: TerrainCellKind): string => {
      const char = terrainFlagChar(kind);
      expect(char).not.toBeNull();
      return char!;
    };
    const [plainKind, rampKind, noFloorKind] = TERRAIN_CELL_KINDS;
    const plain = flagChar(plainKind);
    const ramp = flagChar(rampKind);
    const noFloor = flagChar(noFloorKind);
    const grid = createTerrainGrid({
      width: 2,
      height: 2,
      tileSize: TILE,
      levels: ['00', '00'],
      // Рампа — парой клеток: одиночная запрещена (TERR-7).
      flags: [`${ramp}${ramp}`, `${plain}${noFloor}`],
    });
    expect([...grid.ramps]).toEqual([1, 1, 0, 0]);
    expect([...grid.floor]).toEqual([1, 1, 1, 0]);
  });

  it('неизвестный вид клетки невыразим', () => {
    expect(terrainFlagChar('hole')).toBeNull();
    expect(terrainFlagChar('')).toBeNull();
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

  /**
   * DET-2, условие 4: в `cellAt` делимое бывает отрицательным, и конвенция
   * округления деления у хост-языков разная. Довод «зажим в `[0, width-1]`
   * делает расхождение ненаблюдаемым» держится не на порядке строк, а на этом
   * тесте: тот же расчёт с усечением к нулю обязан давать ту же клетку.
   */
  it('отрицательная координата: конвенция округления деления ненаблюдаема (DET-2)', () => {
    const grid = createTerrainGrid(def);
    /** Тот же `cellAt`, но с усечением к нулю — конвенция второй реализации ядра. */
    const cellAtTrunc = (position: { x: number; y: number }): number => {
      const clamp = (value: number, max: number): number => (value < 0 ? 0 : value > max ? max : value);
      const x = clamp(Math.trunc(position.x / grid.tileSize), grid.width - 1);
      const y = clamp(Math.trunc(position.y / grid.tileSize), grid.height - 1);
      return y * grid.width + x;
    };

    // Три режима отрицательного частного: |q| < 1, ровно -1, меньше -1. Плюс
    // положительные — там конвенции совпадают по определению.
    const points = [-1, -TILE, -TILE - 1, -3 * TILE - 1, 0, TILE, 5 * TILE].flatMap((v) => [
      { x: v, y: 0 },
      { x: 0, y: v },
      { x: v, y: v },
    ]);

    // Анти-вакуумность: расхождение конвенций существует — на первом же входе.
    expect(Math.floor(-1 / TILE)).toBe(-1);
    expect(Math.trunc(-1 / TILE) === 0).toBe(true);

    // `-0` и `0` — один и тот же индекс массива, но не одно значение для
    // `Object.is`, на котором стоит `toBe`; знак нуля здесь и есть та самая
    // ненаблюдаемая разница, поэтому нормализуем сложением.
    const sameIndex = (value: number): number => value + 0;
    for (const point of points) {
      expect(sameIndex(cellAt(grid, point))).toBe(sameIndex(cellAtTrunc(point)));
    }
    // И то же самое через публичный запрос уровня — клетка нулевая.
    const { terrain } = scene(def);
    expect(terrain!.levelAt({ x: -1, y: -1 })).toBe(0);
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
    expect(values.w0).toBe(0);
    expect(values.w1).toBe(0xffffff00 | 0);
    expect(values.w2).toBe(0xffff);
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
