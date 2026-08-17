/**
 * Счётчики объёма работы тика (`performance-budget` PERF-3).
 *
 * Проверяется ровно то, ради чего они заведены: сводка покидает симуляцию
 * существующим стоком диагностики обычной записью DIAG-2, воспроизводима
 * побитово (DIAG-6), инертна для тика (DIAG-4) и считает отмеренную работу, а
 * не приблизительную.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { evaluate } from '../src/dsl/expr.js';
import { createWorld, spawn } from '../src/ecs/world.js';
import { createPhysicsApi, PhysicsWorld } from '../src/systems/physics.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { runScenarioBytes, type ScenarioDef } from '../src/sim/scenario.js';
import { traceLine } from '../src/sim/trace.js';
import type { PrefabDef } from '../src/ecs/world.js';
import type { StaticCollider } from '../src/systems/collisionGeometry.js';
import type {
  ComponentSchema,
  DiagnosticRecord,
  DiagnosticsSink,
  SimulationState,
  System,
  TraceLevel,
} from '../src/types.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');
const WORLD_SEED = 4242;
const COST_CODE = 'TICK_COST';

const SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Health', fields: { current: 'fixed' } },
];

const PREFABS: PrefabDef[] = [
  { name: 'unit', components: { Position: { x: 0, y: 0 }, Health: { current: 65536 } } },
];

/**
 * Одна статика в одной клетке сетки broad-phase: сторона клетки — 4 единицы
 * (умолчание `PhysicsWorld`), поэтому квадрат 1..2 целиком лежит в клетке (0, 0),
 * и обход огибающей луча осматривает ровно одного кандидата.
 */
const STATICS: StaticCollider[] = [
  {
    minX: fixed.fromInt(1),
    minY: fixed.fromInt(1),
    maxX: fixed.fromInt(2),
    maxY: fixed.fromInt(2),
    tags: [],
    layer: 1,
  },
];

function collector(trace: TraceLevel): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace, record: (entry) => entries.push(entry) }, entries };
}

/** Сводки стоимости в порядке выдачи — остальные записи трейса здесь не при чём. */
function costRecords(entries: readonly DiagnosticRecord[]): DiagnosticRecord[] {
  return entries.filter((entry) => entry.code === COST_CODE);
}

/**
 * Мир и симуляция с физикой: `state` возвращается отдельно, потому что тики
 * прогоняются по одному — счётчики обнуляются на каждом.
 */
function freshWorld(): { sim: (diagnostics?: DiagnosticsSink) => Simulation; state: SimulationState } {
  const world = createWorld(SCHEMAS, PREFABS);
  spawn(world, 'unit');
  const physicsWorld = new PhysicsWorld(STATICS);
  const registry = new SystemRegistry();
  registry.register(measuredWork());
  return {
    sim: (diagnostics?: DiagnosticsSink) => ({
      systems: registry,
      worldSeed: WORLD_SEED,
      math: mathApi,
      physics: createPhysicsApi(world, physicsWorld),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    }),
    state: initialState(world, WORLD_SEED),
  };
}

/**
 * Ровно отмеренная работа одного тика:
 *
 * - две команды Command Buffer, обе применяются (адресат жив);
 * - два применения оператора DSL (`+` и `*`); литералы `2`, `3`, `4` работой не
 *   считаются и через таблицу операторов не проходят;
 * - один луч Physics API;
 * - один кандидат broad-phase: огибающая луча (0,0)..(3,3) накрывает клетку
 *   (0, 0), в которой лежит единственная статика.
 */
function measuredWork(): System {
  return {
    name: 'Worker',
    order: 1,
    run: (ctx) => {
      const entity = ctx.query({ all: ['Health'] })[0]!;
      ctx.commands.setField(entity, 'Health', 'current', 1);
      ctx.commands.setField(entity, 'Position', 'x', 2);
      evaluate({ '+': [{ '*': [2, 3] }, 4] }, ctx);
      ctx.physics?.raycast({ x: 0, y: 0 }, { x: fixed.fromInt(3), y: fixed.fromInt(3) });
    },
  };
}

const EXPECTED_COST = { commands: 2, expressions: 2, broadPhasePairs: 1, raycasts: 1 };

function loadScenario(name: string): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.scenario.json`), 'utf8')) as ScenarioDef;
}

/** Сводки стоимости прогона сценария, каждая — канонической строкой (SER-6). */
function costLines(def: ScenarioDef): string[] {
  const { sink, entries } = collector('systems');
  runScenarioBytes(def, sink);
  return costRecords(entries).map((entry) => traceLine(entry));
}

/** Сценарии со счётчиками: в сумме по набору обязан двигаться каждый счётчик. */
const SCENARIOS = ['movement', 'physics', 'visibility', 'dsl-raycast'] as const;

describe('PERF-3: сводка стоимости — обычная запись диагностики (DIAG-2)', () => {
  it('одна запись на тик, вида `tickCost` и с кодом TICK_COST', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);
    tick(sim(sink), state);

    const costs = costRecords(entries);
    expect(costs).toHaveLength(2);
    expect(costs[0]).toMatchObject({ tick: 1, kind: 'tickCost', level: 'info', code: COST_CODE });
    expect(costs[1]).toMatchObject({ tick: 2, kind: 'tickCost', level: 'info', code: COST_CODE });
    expect(typeof costs[0]?.seq).toBe('number');
  });

  it('запись принадлежит тику, а не системе: имени системы и исхода команды в ней нет', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    const cost = costRecords(entries)[0]!;
    expect(cost.system).toBeUndefined();
    expect(cost.outcome).toBeUndefined();
    // Отметки реального времени в записи нет — иначе сводка перестала бы быть
    // воспроизводимой (DIAG-2, DIAG-6).
    const plain = JSON.parse(traceLine(cost)) as Record<string, unknown>;
    expect(plain.timestamp).toBeUndefined();
    expect(plain.time).toBeUndefined();
  });

  it('данные записи — только числа названных счётчиков', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    const data = costRecords(entries)[0]?.data ?? {};
    expect(Object.keys(data).sort()).toEqual(['broadPhasePairs', 'commands', 'expressions', 'raycasts']);
    for (const value of Object.values(data)) expect(Number.isInteger(value)).toBe(true);
  });

  it('уровень `off` сводки не пишет: счётчики — штатная телеметрия (DIAG-3)', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('off');
    tick(sim(sink), state);
    expect(costRecords(entries)).toHaveLength(0);
  });

  it('полный уровень пишет сводку тоже — она не заменяется потоком команд', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('full');
    tick(sim(sink), state);
    expect(costRecords(entries)).toHaveLength(1);
  });

  it('оборванный тик сводки не получает — его объём работы неполон', () => {
    const world = createWorld(SCHEMAS, PREFABS);
    spawn(world, 'unit');
    const registry = new SystemRegistry();
    registry.register({
      name: 'Bad',
      order: 1,
      run: () => {
        throw new Error('падение системы');
      },
    });
    const { sink, entries } = collector('systems');
    expect(() =>
      tick(
        { systems: registry, worldSeed: WORLD_SEED, math: mathApi, diagnostics: sink },
        initialState(world, WORLD_SEED),
      ),
    ).toThrow(/падение системы/);
    expect(costRecords(entries)).toHaveLength(0);
  });
});

describe('PERF-3: счётчики считают отмеренную работу', () => {
  it('крошечная сцена: значения совпадают с ручным счётом', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);
    expect(costRecords(entries)[0]?.data).toEqual(EXPECTED_COST);
  });

  it('счётчики обнуляются на каждом тике, а не копятся сквозь прогон', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    for (let i = 0; i < 3; i++) tick(sim(sink), state);
    for (const cost of costRecords(entries)) expect(cost.data).toEqual(EXPECTED_COST);
  });

  it('вдвое больше той же работы — вдвое больше в счётчиках', () => {
    const world = createWorld(SCHEMAS, PREFABS);
    spawn(world, 'unit');
    const physicsWorld = new PhysicsWorld(STATICS);
    const registry = new SystemRegistry();
    registry.register(measuredWork());
    // Та же работа второй системой: `order` различает их (DET-9), объём удваивается.
    registry.register({ ...measuredWork(), name: 'Worker2', order: 2 });

    const { sink, entries } = collector('systems');
    tick(
      {
        systems: registry,
        worldSeed: WORLD_SEED,
        math: mathApi,
        physics: createPhysicsApi(world, physicsWorld),
        diagnostics: sink,
      },
      initialState(world, WORLD_SEED),
    );

    expect(costRecords(entries)[0]?.data).toEqual({
      commands: EXPECTED_COST.commands * 2,
      expressions: EXPECTED_COST.expressions * 2,
      broadPhasePairs: EXPECTED_COST.broadPhasePairs * 2,
      raycasts: EXPECTED_COST.raycasts * 2,
    });
  });

  it('на записанных сценариях двигается каждый счётчик', () => {
    const total = { commands: 0, expressions: 0, broadPhasePairs: 0, raycasts: 0 };
    for (const name of SCENARIOS) {
      const { sink, entries } = collector('systems');
      runScenarioBytes(loadScenario(name), sink);
      for (const cost of costRecords(entries)) {
        for (const key of Object.keys(total) as (keyof typeof total)[]) {
          total[key] += Number(cost.data?.[key] ?? 0);
        }
      }
    }
    for (const [key, value] of Object.entries(total)) expect(value, key).toBeGreaterThan(0);
  });
});

describe('DIAG-6: счётчики воспроизводимы побитово', () => {
  for (const name of SCENARIOS) {
    it(`${name}: два прогона одного сценария дают побитово одинаковые сводки`, () => {
      const first = costLines(loadScenario(name));
      expect(first.length).toBeGreaterThan(0);
      expect(costLines(loadScenario(name))).toEqual(first);
    });
  }
});

describe('DIAG-4/PERF-3: учёт инертен, а без стока не исполняется', () => {
  for (const name of SCENARIOS) {
    it(`${name}: документ прогона со сводками байт в байт равен документу без стока`, () => {
      const def = loadScenario(name);
      const plain = runScenarioBytes(def);
      const { sink } = collector('systems');
      expect(runScenarioBytes(def, sink)).toEqual(plain);
    });
  }

  it('без подключённого стока записей нет вовсе — учёту некуда и незачем считать', () => {
    const { sim, state } = freshWorld();
    const { entries } = collector('systems');
    tick(sim(), state);
    expect(entries).toHaveLength(0);
  });
});
