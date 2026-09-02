/**
 * Снятие пола действием ядра и запрос пола в выражениях (TERR-8).
 *
 * Харнесс собирает `SystemContext` руками, а не тикает сцену: половина
 * требования — про КОМАНДЫ (одна на слово, только на изменившееся, по
 * возрастанию индекса), а их видно только до flush. Прогон через настоящий
 * `tick` с JSON-системой — отдельным тестом в конце: он стережёт регистрацию
 * (SYS-3) и то, что действие доступно из данных.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '../src/dsl/actions.js';
import { evaluate, type ExprWorld } from '../src/dsl/expr.js';
import { EventBus } from '../src/ecs/events.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { createRngRegistry } from '../src/math/rng.js';
import { createCommandBuffer, type CommandBufferHandle } from '../src/ecs/commands.js';
import { query, queryInto } from '../src/ecs/query.js';
import {
  getField,
  getFieldByHandle,
  getFieldByIndex,
  hasComponent,
  hasComponentByHandle,
  isAlive,
  resolveComponentHandle,
  resolveFieldHandle,
  spawn,
} from '../src/ecs/world.js';
import { loadScene } from '../src/sim/scene.js';
import {
  initialState,
  restoreSnapshot,
  takeSnapshot,
  tick,
  type Simulation,
} from '../src/sim/tick.js';
import { EvaluatedSystem } from '../src/dsl/evaluatedSystem.js';
import { FLOOR_COMPONENT, type TerrainDef } from '../src/systems/terrain.js';
import type { SimulationState, SystemContext, TerrainApi, Vec2 } from '../src/types.js';

const TILE = fixed.fromInt(2);

/**
 * 8×6 клеток по две единицы: 48 клеток — карта пола ложится в два слова, и
 * граница между ними проходит по ряду (`w0` — ряды 0..3, `w1` — 4..5).
 */
const TERRAIN: TerrainDef = {
  width: 8,
  height: 6,
  tileSize: TILE,
  levels: Array.from({ length: 6 }, () => '0'.repeat(8)),
  flags: Array.from({ length: 6 }, () => '.'.repeat(8)),
};

/**
 * Сцена БЕЗ террейна — это сцена без ключа `terrain`, а не с пустым ключом:
 * загрузчик читает отсутствие поля (`def.terrain === undefined`), а документ
 * сцены ключа со значением `undefined` не знает вовсе (SER-7).
 */
const SCENE_BASE = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } as const }],
  prefabs: [{ name: 'Actor', components: { Position: { x: 0, y: 0 } } }],
};

const SCENE = { ...SCENE_BASE, terrain: TERRAIN };

/** Центр клетки: тест не должен зависеть от того, какой клетке досталась граница. */
const at = (cx: number, cy: number): Vec2 => ({
  x: fixed.fromInt(cx * 2 + 1),
  y: fixed.fromInt(cy * 2 + 1),
});

interface Harness {
  readonly ctx: SystemContext;
  readonly commands: CommandBufferHandle;
  readonly terrain: TerrainApi;
  readonly state: SimulationState;
  readonly setFieldLog: string[];
  /** Прочитать бит клетки прямо из компонента — мимо запроса (TERR-6). */
  bit(cell: number): boolean;
}

/** `null` — сцена без террейна: явный `undefined` подставил бы значение по умолчанию. */
function harness(def: TerrainDef | null = TERRAIN): Harness {
  const { world, terrain, modifiers } = loadScene(
    def === null ? SCENE_BASE : { ...SCENE_BASE, terrain: def },
  );
  const commands = createCommandBuffer(world);
  const setFieldLog: string[] = [];

  const ctx: SystemContext = {
    tick: 1,
    query: (spec) => query(world, spec),
    queryInto: (spec, ids, indices) => queryInto(world, spec, ids, indices),
    get: (e, c, f) => getField(world, e, c, f),
    has: (e, c) => hasComponent(world, e, c),
    resolveField: (c, f) => resolveFieldHandle(world, c, f),
    resolveComponent: (c) => resolveComponentHandle(world, c),
    getByHandle: (e, handle) => getFieldByHandle(world, e, handle),
    getByIndex: (index, handle) => getFieldByIndex(world, index, handle),
    hasByHandle: (e, handle) => hasComponentByHandle(world, e, handle),
    isAlive: (e) => isAlive(world, e),
    commands: {
      ...commands,
      setField: (e, c, f, value) => {
        setFieldLog.push(f);
        commands.setField(e, c, f, value);
      },
    },
    events: new EventBus(),
    rng: createRngRegistry(1).forSystem('Test'),
    math: mathApi,
    modifiers,
    inputs: [],
    getEffectiveDelta: (_entity, globalDelta) => globalDelta,
    ...(terrain === undefined ? {} : { terrain }),
  };

  return {
    ctx,
    commands,
    terrain: terrain!,
    state: initialState(world, 1),
    setFieldLog,
    bit: (cell) => {
      const holder = query(world, { all: [FLOOR_COMPONENT] })[0]!;
      const word = getField(world, holder, FLOOR_COMPONENT, `w${cell >>> 5}`);
      return (word & (1 << (cell & 31))) !== 0;
    },
  };
}

/** Клетка `(x, y)` в нумерации TERR-6. */
const cell = (x: number, y: number): number => y * TERRAIN.width + x;

describe('снятие пола: область (TERR-8)', () => {
  it('без радиуса снимает ровно клетку под точкой', () => {
    const h = harness();
    // Точка не в центре, а у самого края клетки: адресует всё равно её.
    execute([{ carveFloor: { at: { vec: [fixed.fromFloat(2.1), fixed.fromFloat(3.9)] } } }], h.ctx);
    h.commands.flush();

    expect(h.bit(cell(1, 1))).toBe(false);
    expect(h.bit(cell(0, 1))).toBe(true);
    expect(h.bit(cell(1, 0))).toBe(true);
  });

  it('радиус — круг по центрам клеток, а не квадрат; граница включительна', () => {
    const h = harness();
    // Центр клетки (2, 1), радиус ровно в клетку: соседи по стороне — на
    // расстоянии 2 (входят), по диагонали — 2.83 (не входят).
    execute([{ carveFloor: { at: { vec: [at(2, 1).x, at(2, 1).y] }, radius: TILE } }], h.ctx);
    h.commands.flush();

    for (const [x, y] of [
      [2, 1],
      [1, 1],
      [3, 1],
      [2, 0],
      [2, 2],
    ] as const) {
      expect(h.bit(cell(x, y)), `клетка (${x}, ${y}) в круге`).toBe(false);
    }
    for (const [x, y] of [
      [1, 0],
      [3, 2],
      [4, 1],
    ] as const) {
      expect(h.bit(cell(x, y)), `клетка (${x}, ${y}) вне круга`).toBe(true);
    }
  });

  it('нулевой радиус снимает только клетку, чей центр совпал с точкой', () => {
    const h = harness();
    execute([{ carveFloor: { at: { vec: [at(2, 1).x, at(2, 1).y] }, radius: 0 } }], h.ctx);
    h.commands.flush();
    expect(h.bit(cell(2, 1))).toBe(false);

    // Та же точка со сдвигом: круг нулевого радиуса центр клетки не накрывает —
    // ради этого случая отсутствие радиуса и не сводится к нулю.
    const off = harness();
    execute([{ carveFloor: { at: { vec: [fixed.fromFloat(5.5), at(2, 1).y] }, radius: 0 } }], off.ctx);
    off.commands.flush();
    expect(off.bit(cell(2, 1))).toBe(true);
    expect(off.setFieldLog).toEqual([]);
  });

  it('обход построчный: команды идут по возрастанию индекса слова', () => {
    const h = harness();
    // Круг у границы слов: ряд 3 лежит в `w0`, ряды 4..5 — в `w1`.
    execute([{ carveFloor: { at: { vec: [at(0, 4).x, at(0, 4).y] }, radius: TILE } }], h.ctx);
    expect(h.setFieldLog).toEqual(['w0', 'w1']);
  });
});

describe('снятие пола: команды (TERR-8, ACT-2)', () => {
  it('мир не меняется до flush', () => {
    const h = harness();
    execute([{ carveFloor: { at: { vec: [at(1, 1).x, at(1, 1).y] } } }], h.ctx);
    expect(h.bit(cell(1, 1))).toBe(true);
    h.commands.flush();
    expect(h.bit(cell(1, 1))).toBe(false);
  });

  it('два снятия в одном тике дают объединение областей (CMD-5)', () => {
    const h = harness();
    execute(
      [
        { carveFloor: { at: { vec: [at(1, 1).x, at(1, 1).y] } } },
        { carveFloor: { at: { vec: [at(2, 1).x, at(2, 1).y] } } },
      ],
      h.ctx,
    );
    h.commands.flush();

    // Без чтения буфера второе снятие вернуло бы бит, погашенный первым.
    expect(h.bit(cell(1, 1))).toBe(false);
    expect(h.bit(cell(2, 1))).toBe(false);
  });

  it('повторное снятие не порождает команды', () => {
    const h = harness();
    const carve = { carveFloor: { at: { vec: [at(1, 1).x, at(1, 1).y] } } };

    execute([carve], h.ctx);
    h.commands.flush();
    expect(h.setFieldLog).toEqual(['w0']);

    h.setFieldLog.length = 0;
    execute([carve], h.ctx);
    h.commands.flush();
    // Значение слова не изменилось — записи нет, и карта пола не помечена
    // изменённой из-за клетки, у которой пола и так не было.
    expect(h.setFieldLog).toEqual([]);
  });
});

describe('снятие пола: границы (TERR-8)', () => {
  it('без радиуса за краем сетки снимает пол ближайшей клетки', () => {
    const h = harness();
    execute([{ carveFloor: { at: { vec: [fixed.fromInt(-100), fixed.fromInt(-100)] } } }], h.ctx);
    h.commands.flush();
    expect(h.bit(cell(0, 0))).toBe(false);
  });

  it('круг, не пересекающийся с сеткой, — действие без эффекта', () => {
    const h = harness();
    execute(
      [{ carveFloor: { at: { vec: [fixed.fromInt(100), fixed.fromInt(100)] }, radius: TILE } }],
      h.ctx,
    );
    h.commands.flush();
    expect(h.setFieldLog).toEqual([]);
    expect(h.bit(cell(7, 5))).toBe(true);
  });

  it('отрицательный радиус — ошибка, а не пустая область', () => {
    const h = harness();
    expect(() =>
      { execute([{ carveFloor: { at: { vec: [at(1, 1).x, at(1, 1).y] }, radius: -TILE } }], h.ctx); },
    ).toThrow(/TERR-8/);
  });

  it('"at" обязателен и должен быть вектором', () => {
    const h = harness();
    expect(() => { execute([{ carveFloor: { radius: TILE } }], h.ctx); }).toThrow(/at/);
    expect(() => { execute([{ carveFloor: { at: fixed.fromInt(1) } }], h.ctx); }).toThrow(
      /действие "carveFloor": "at": ожидалось значение типа vec2/,
    );
  });

  it('сцена без террейна — ошибка, а не действие без эффекта', () => {
    const h = harness(null);
    expect(() => { execute([{ carveFloor: { at: { vec: [0, 0] } } }], h.ctx); }).toThrow(/террейн/);
  });
});

describe('запрос пола в выражениях (EXPR-2, TERR-8)', () => {
  const exprWorld = (h: Harness): ExprWorld => ({
    tick: h.ctx.tick,
    math: h.ctx.math,
    events: h.ctx.events,
    get: h.ctx.get,
    has: h.ctx.has,
    isAlive: h.ctx.isAlive,
    ...(h.ctx.terrain === undefined ? {} : { terrain: h.ctx.terrain }),
  });
  const floorAt = (v: Vec2) => ({ hasFloorAt: [{ vec: [v.x, v.y] }] });

  it('отвечает по текущему состоянию карты', () => {
    const h = harness();
    expect(evaluate(floorAt(at(1, 1)), exprWorld(h))).toBe(true);

    execute([{ carveFloor: { at: { vec: [at(1, 1).x, at(1, 1).y] } } }], h.ctx);
    // До flush мир не менялся — как и у `getComponent` (QUERY-3).
    expect(evaluate(floorAt(at(1, 1)), exprWorld(h))).toBe(true);

    h.commands.flush();
    expect(evaluate(floorAt(at(1, 1)), exprWorld(h))).toBe(false);
  });

  it('тотален за краем сетки', () => {
    const h = harness();
    expect(evaluate(floorAt({ x: fixed.fromInt(-100), y: 0 }), exprWorld(h))).toBe(true);
  });

  it('сцена без террейна — ошибка, а не «пола нет»', () => {
    const h = harness(null);
    expect(() => evaluate(floorAt(at(0, 0)), exprWorld(h))).toThrow(/террейн/);
  });
});

describe('снятие пола и снапшот (TERR-8, TERR-6)', () => {
  it('перемотка возвращает пол вместе с остальным состоянием', () => {
    const h = harness();
    const before = takeSnapshot(h.state);

    execute([{ carveFloor: { at: { vec: [at(3, 2).x, at(3, 2).y] }, radius: TILE } }], h.ctx);
    h.commands.flush();
    expect(h.terrain.hasFloorAt(at(3, 2))).toBe(false);

    restoreSnapshot(h.state, before);
    // Своего механизма отката у действия нет: карта пола — обычный компонент.
    expect(h.terrain.hasFloorAt(at(3, 2))).toBe(true);
    expect(h.terrain.hasFloorAt(at(2, 2))).toBe(true);
  });
});

describe('снятие пола из JSON-системы (ACT-1, SYS-3)', () => {
  it('система сцены выбивает пол и видит его запросом на следующем тике', () => {
    const { world, terrain, systems, modifiers } = loadScene(SCENE);
    systems.register(
      new EvaluatedSystem({
        name: 'Carve',
        order: 10,
        query: { all: ['Position'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                hasFloorAt: [
                  {
                    vec: [
                      { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                      { getComponent: [{ var: 'e' }, 'Position', 'y'] },
                    ],
                  },
                ],
              },
              then: [
                {
                  carveFloor: {
                    at: {
                      vec: [
                        { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                        { getComponent: [{ var: 'e' }, 'Position', 'y'] },
                      ],
                    },
                    radius: TILE,
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const actor = spawn(world, 'Actor', { Position: { x: at(2, 1).x, y: at(2, 1).y } });
    expect(actor).toBeDefined();
    const sim: Simulation = {
      systems,
      worldSeed: 1,
      math: mathApi,
      terrain: terrain!,
      modifiers,
    };
    const state = initialState(world, 1);

    tick(sim, state);
    expect(terrain!.hasFloorAt(at(2, 1))).toBe(false);
    expect(terrain!.hasFloorAt(at(1, 1))).toBe(false);
    expect(terrain!.hasFloorAt(at(1, 0))).toBe(true);
  });
});
