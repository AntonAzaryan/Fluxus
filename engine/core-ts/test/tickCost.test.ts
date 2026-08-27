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
import { createPhysicsApi, PhysicsSystem, PhysicsWorld, SHAPE_AABB } from '../src/systems/physics.js';
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

// `npcNeighbors` — своя строка сводки (NPC-6, NPC-9): на сцене без агентов
// она ноль, и именно нулём отличает «работы не было» от «её сложили с чужой».
const EXPECTED_COST = {
  commandsApplied: 2,
  expressions: 2,
  broadPhasePairs: 1,
  npcNeighbors: 0,
  raycasts: 1,
};

/** Сколько тиков прогоняет тест «счётчики обнуляются на каждом тике». */
const REPEATED_TICKS = 3;

/**
 * Поля записи сводки в сериализованном виде (DIAG-2): состав ЗАКРЫТ — ни
 * отметки реального времени, ни данных окружения, ни имени системы, ни исхода
 * команды. Порядок — канонический (SER-6), то есть лексикографический.
 */
const COST_RECORD_KEYS = ['code', 'data', 'kind', 'level', 'seq', 'tick'];

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

// ------------------------------- стенд динамики broad-phase (PHYS-2, PHYS-5)

const HALF = fixed.fromFloat(0.25);

const PHYSICS_SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
  {
    name: 'Collider',
    fields: {
      halfX: 'fixed',
      halfY: 'fixed',
      radius: 'fixed',
      shape: 'i32',
      layer: 'i32',
      blockMask: 'i32',
      hitMask: 'i32',
      cliffRise: 'i32',
    },
  },
];

/** Движущийся идёт только по X: шаг оси в тике ровно один, и обход динамики — тоже. */
const PHYSICS_PREFABS: PrefabDef[] = [
  {
    name: 'mover',
    components: {
      Position: { x: 0, y: 0 },
      Velocity: { x: fixed.fromInt(1), y: 0 },
      Collider: {
        halfX: HALF,
        halfY: HALF,
        radius: HALF,
        shape: SHAPE_AABB,
        layer: 2,
        blockMask: 1,
        hitMask: 1,
      },
    },
  },
  {
    name: 'obstacle',
    components: {
      Position: { x: 0, y: 0 },
      Collider: { halfX: HALF, halfY: HALF, radius: HALF, shape: SHAPE_AABB, layer: 1 },
    },
  },
];

/**
 * Кандидаты broad-phase одного тика физики. Статики в мире нет вовсе, поэтому
 * весь счёт даёт линейный обход динамики: препятствия стоят далеко от
 * движущегося и ни блокировкой, ни пересечением не срабатывают — считается
 * ОСМОТР, а не исход.
 */
function dynamicBroadPhase(obstacles: number, layer: number): number {
  const world = createWorld(PHYSICS_SCHEMAS, PHYSICS_PREFABS);
  spawn(world, 'mover');
  for (let i = 0; i < obstacles; i++) {
    spawn(world, 'obstacle', { Position: { x: fixed.fromInt(10 + i), y: 0 }, Collider: { layer } });
  }
  const registry = new SystemRegistry();
  registry.register(new PhysicsSystem(new PhysicsWorld([])));
  const { sink, entries } = collector('systems');
  tick(
    { systems: registry, worldSeed: WORLD_SEED, math: mathApi, diagnostics: sink },
    initialState(world, WORLD_SEED),
  );
  return Number(costRecords(entries)[0]?.data?.broadPhasePairs ?? -1);
}

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

    // Сводка — ПОСЛЕДНЯЯ запись своего тика (PERF-3): раньше объём работы ещё
    // неполон. На уровне `systems` с единственной системой тик выдаёт ровно три
    // записи — SYSTEM_BEGIN (seq 0), SYSTEM_END (1) и сводку (2), — и номер
    // сводки обязан быть наибольшим в тике, а не просто числом.
    for (const cost of costs) {
      const ofTick = entries.filter((entry) => entry.tick === cost.tick);
      expect(ofTick.map((entry) => entry.code)).toEqual(['SYSTEM_BEGIN', 'SYSTEM_END', COST_CODE]);
      expect(cost.seq).toBe(2);
      expect(cost.seq).toBe(Math.max(...ofTick.map((entry) => entry.seq)));
    }
  });

  it('запись принадлежит тику, а не системе: имени системы и исхода команды в ней нет', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    const cost = costRecords(entries)[0]!;
    expect(cost.system).toBeUndefined();
    expect(cost.outcome).toBeUndefined();
    // Состав сериализованной записи проверяется ЦЕЛИКОМ, а не отсутствием
    // угаданных имён: интерфейс закрыт (DIAG-2), и любое лишнее поле — часы,
    // окружение, имя системы — обязано ронять этот тест. Именно на времени
    // держится воспроизводимость сводки (DIAG-6).
    const plain = JSON.parse(traceLine(cost)) as Record<string, unknown>;
    expect(Object.keys(plain)).toEqual(COST_RECORD_KEYS);
  });

  it('данные записи — только числа названных счётчиков', () => {
    const { sim, state } = freshWorld();
    const { sink, entries } = collector('systems');
    tick(sim(sink), state);

    const data = costRecords(entries)[0]?.data ?? {};
    expect(Object.keys(data).sort()).toEqual([
      'broadPhasePairs',
      'commandsApplied',
      'expressions',
      'npcNeighbors',
      'raycasts',
    ]);
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
    for (let i = 0; i < REPEATED_TICKS; i++) tick(sim(sink), state);
    // Число сводок фиксируется ДО обхода: пустой набор прошёл бы цикл молча, и
    // проверка «на каждом тике» не проверяла бы ничего.
    expect(costRecords(entries)).toHaveLength(REPEATED_TICKS);
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
      commandsApplied: EXPECTED_COST.commandsApplied * 2,
      expressions: EXPECTED_COST.expressions * 2,
      broadPhasePairs: EXPECTED_COST.broadPhasePairs * 2,
      // Вдвое от нуля — ноль: агентов на этой сцене нет, и это тоже удвоение.
      npcNeighbors: EXPECTED_COST.npcNeighbors * 2,
      raycasts: EXPECTED_COST.raycasts * 2,
    });
  });

  it('на записанных сценариях двигается каждый счётчик', () => {
    const total = { commandsApplied: 0, expressions: 0, broadPhasePairs: 0, raycasts: 0 };
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

  it('обход динамики считается наравне с обходом клеток статики (PHYS-5)', () => {
    // Динамика индекса не имеет — её осматривает линейный обход, и работа эта
    // такая же настоящая, как обход клеток. За тик обходов два: выбор
    // блокирующего на единственном шаге оси и сенсоры (PHYS-12), — то есть
    // ровно 2·N кандидатов, где N — препятствия без самого движущегося.
    expect(dynamicBroadPhase(3, 1)).toBe(6);
    expect(dynamicBroadPhase(5, 1)).toBe(10);
    // Кандидат, отсеянный маской слоёв, из счёта не выпадает: его осмотр уже
    // состоялся, и цена у него та же.
    expect(dynamicBroadPhase(3, 8)).toBe(6);
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
