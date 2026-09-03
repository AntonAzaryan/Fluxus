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
import { requireModifierList } from '../src/systems/modifiers.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { CandidatePicker } from '../src/systems/abilities/runtime.js';
import { StepShapeGate } from '../src/systems/abilities/shape.js';
import { EASING_LINEAR } from '../src/systems/tween.js';
import {
  DETECTION_SOURCES_COMPONENT,
  STEALTH_SOURCES_COMPONENT,
  VISION_MODIFIER_COMPONENT,
  VisibilitySystem,
} from '../src/systems/visibility.js';
import { loadScene, type Scene, type SceneDef } from '../src/sim/scene.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { runScenarioBytes, type ScenarioDef } from '../src/sim/scenario.js';
import { traceLine } from '../src/sim/trace.js';
import type { PrefabDef } from '../src/ecs/world.js';
import type { StaticCollider } from '../src/systems/collisionGeometry.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type ComponentSchema,
  type DiagnosticRecord,
  type DiagnosticsSink,
  type EntityId,
  type FieldOverrides,
  type SimulationState,
  type System,
  type TraceLevel,
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

// У каждой платформы ядра своя строка сводки (PERF-3): на сцене без агентов,
// без навигации, без способностей, баффов, твинов и тумана их счётчики нули, и
// именно нулём отличают «работы не было» от «её сложили с чужой».
const EXPECTED_COST = {
  abilityCandidates: 0,
  broadPhasePairs: 1,
  buffCandidates: 0,
  buffSteps: 0,
  commandsApplied: 2,
  eventsEmitted: 0,
  expressions: 2,
  navNodes: 0,
  npcNeighbors: 0,
  projectileSteps: 0,
  raycasts: 1,
  tweenSteps: 0,
  visibilityPairs: 0,
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

/**
 * Сценарии со счётчиками: в сумме по набору обязан двигаться каждый счётчик,
 * у которого в golden-наборе есть нагрузка. Платформ способностей и баффов в
 * наборе нет ни одной — их счётчики меряются стендами платформ ниже.
 */
const SCENARIOS = ['movement', 'physics', 'visibility', 'dsl-raycast', 'arena-time'] as const;

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

    // Сводка идёт ПОСЛЕ всей работы тика (PERF-3): раньше её объём ещё неполон.
    // На уровне `systems` с единственной системой тик выдаёт ровно четыре
    // записи — SYSTEM_BEGIN (seq 0), SYSTEM_END (1), сводку стоимости (2) и
    // сводку размера состояния (3, PERF-8). Порядок двух сводок между собой
    // фиксирован и проверяется здесь: он задаёт их номера, а номер — часть
    // побитовой сверки трейса (DIAG-6).
    for (const cost of costs) {
      const ofTick = entries.filter((entry) => entry.tick === cost.tick);
      expect(ofTick.map((entry) => entry.code)).toEqual([
        'SYSTEM_BEGIN',
        'SYSTEM_END',
        COST_CODE,
        'TICK_FOOTPRINT',
      ]);
      expect(cost.seq).toBe(2);
      // Ни одной записи РАБОТЫ после сводки: границы систем, команды и события
      // своего тика уже позади, а следом идёт только соседняя сводка.
      const after = ofTick.filter((entry) => entry.seq > cost.seq);
      expect(after.map((entry) => entry.code)).toEqual(['TICK_FOOTPRINT']);
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
      'abilityCandidates',
      'broadPhasePairs',
      'buffCandidates',
      'buffSteps',
      'commandsApplied',
      'eventsEmitted',
      'expressions',
      'navNodes',
      'npcNeighbors',
      'projectileSteps',
      'raycasts',
      'tweenSteps',
      'visibilityPairs',
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

    // Удваивается КАЖДАЯ строка сводки, включая нулевые: вдвое от нуля — ноль,
    // и платформа, которой на этой сцене нет вовсе, обязана остаться нулём.
    const doubled: Record<string, number> = {};
    for (const [name, value] of Object.entries(EXPECTED_COST)) doubled[name] = value * 2;
    expect(costRecords(entries)[0]?.data).toEqual(doubled);
  });

  it('на записанных сценариях двигается каждый счётчик', () => {
    const total = {
      broadPhasePairs: 0,
      commandsApplied: 0,
      eventsEmitted: 0,
      expressions: 0,
      raycasts: 0,
      tweenSteps: 0,
      visibilityPairs: 0,
    };
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

// ------------------------------- стенды платформ ядра (PERF-3, design D1)

/**
 * Сцена трёх платформ на одном мире: способности (снаряд), баффы и твины.
 * Стенд общий намеренно — каждый тест читает не только своё число, но и нули
 * соседей: платформа, приписавшая работу чужой строке, красит его.
 */
const PLATFORM_SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Health', fields: { hp: 'fixed' } },
  ],
  prefabs: [
    { name: 'Target', components: { Position: { x: 0, y: 0 }, Health: { hp: FIXED_ONE } } },
    // Снаряд без пределов: ни времени жизни, ни дальности (оба включаются
    // только положительным значением, ABIL-9) — он летит, пока стенд тикает, и
    // каждый тик стоит ровно одного шага.
    { name: 'Ball', components: { Position: { x: 0, y: 0 }, AbilityProjectile: {} } },
    { name: 'Instance', components: { BuffInstance: {} } },
    {
      name: 'Tweened',
      components: {
        Health: { hp: 0 },
        // Секунда при шаге 1/60 (TIME-1): на первом же тике твин не завершается,
        // и шаг у него настоящий. Личной оси времени у стенда нет — флаг
        // `ignoreTimeScale` берёт глобальную (TWEEN-7).
        Tween: {
          def: 0,
          duration: FIXED_ONE,
          easing: EASING_LINEAR,
          elapsed: 0,
          from: 0,
          to: FIXED_ONE,
          ignoreTimeScale: 1,
        },
      },
    },
  ],
  abilities: [{ id: 'shot', trigger: { always: {} }, effects: [], projectile: {} }],
  buffs: [{ id: 'mark', class: 'positive', stacking: 'refresh' }],
  tweens: [{ target: 'Health.hp' }],
};

/** Ровная сетка 4×4: обрывов нет, уровень у всех один — фильтр высоты никого не режет. */
const FLAT_TERRAIN = {
  width: 4,
  height: 4,
  tileSize: fixed.fromInt(1),
  levels: Array.from({ length: 4 }, () => '0000'),
  flags: Array.from({ length: 4 }, () => '....'),
};

/**
 * Сцена тумана войны: наблюдатель и цели. Наблюдатель объявлен БЕЗ `Visibility`
 * намеренно — иначе он попадал бы в собственную выборку кандидатов, и пар
 * оказалось бы на одну больше числа целей.
 */
const FOG_SCENE: SceneDef = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  prefabs: [
    {
      name: 'Eye',
      components: {
        Position: { x: 0, y: 0 },
        Vision: { radius: fixed.fromInt(5) },
        Team: { id: 0 },
        VisionModifier: {},
        DetectionSources: {},
      },
    },
    {
      name: 'Mark',
      components: {
        Position: { x: fixed.fromInt(1), y: 0 },
        Visibility: { visibleTo: 0 },
        StealthSources: {},
      },
    },
  ],
  fog: true,
  terrain: FLAT_TERRAIN,
};

interface Stand {
  place(prefab: string, overrides?: FieldOverrides): EntityId;
  /** Один тик со снятой сводкой стоимости: числа `data` записи `TICK_COST`. */
  step(): Record<string, number>;
}

/** Стенд сцены: `extend` дописывает системы, которые сцена не регистрирует сама. */
function sceneStand(def: SceneDef, extend?: (scene: Scene) => void): Stand {
  const scene = loadScene(def);
  extend?.(scene);
  const state = initialState(scene.world, WORLD_SEED);
  return {
    place: (prefab, overrides) => spawn(scene.world, prefab, overrides),
    step: () => {
      const { sink, entries } = collector('systems');
      tick(
        {
          systems: scene.systems,
          worldSeed: WORLD_SEED,
          math: mathApi,
          modifiers: scene.modifiers,
          ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
          ...(scene.abilities !== undefined ? { abilities: scene.abilities } : {}),
          physics: createPhysicsApi(scene.world, new PhysicsWorld([])),
          diagnostics: sink,
        },
        state,
      );
      return costData(entries);
    },
  };
}

/** Числа последней сводки: `data` объявлена как «число или строка» (DIAG-2). */
function costData(entries: readonly DiagnosticRecord[]): Record<string, number> {
  const data = costRecords(entries).at(-1)?.data ?? {};
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(data)) out[name] = Number(value);
  return out;
}

/** Сводка одного тика мира с одной системой — стенд для платформ вне сцены. */
function costOfSystem(system: System, spawns: number): Record<string, number> {
  const world = createWorld(SCHEMAS, PREFABS);
  for (let i = 0; i < spawns; i++) spawn(world, 'unit');
  const registry = new SystemRegistry();
  registry.register(system);
  const { sink, entries } = collector('systems');
  tick(
    { systems: registry, worldSeed: WORLD_SEED, math: mathApi, diagnostics: sink },
    initialState(world, WORLD_SEED),
  );
  return costData(entries);
}

describe('PERF-3: у каждой платформы ядра — своя строка сводки', () => {
  it('снаряд в полёте стоит один шаг за тик (ABIL-9)', () => {
    const stand = sceneStand(PLATFORM_SCENE);
    stand.place('Ball');
    expect(stand.step().projectileSteps).toBe(1);
    expect(stand.step().projectileSteps).toBe(1);
    stand.place('Ball');
    // Второй снаряд — второй шаг того же тика: единица счётчика — шаг, а не тик.
    expect(stand.step().projectileSteps).toBe(2);
  });

  it('твин стоит один шаг за тик, и строка у него своя (TWEEN-1)', () => {
    const stand = sceneStand(PLATFORM_SCENE);
    stand.place('Tweened');
    const cost = stand.step();
    expect(cost.tweenSteps).toBe(1);
    // Соседние платформы стенда не тронуты: на этом тике их сущностей нет вовсе.
    expect(cost.projectileSteps).toBe(0);
    expect(cost.buffSteps).toBe(0);
  });

  it('проходы баффов и поиск хозяина — РАЗНЫЕ строки (BUFF-3, BUFF-5)', () => {
    const stand = sceneStand(PLATFORM_SCENE);
    const target = stand.place('Target');
    const instance = { target, source: NO_ENTITY, buffId: 0 };
    stand.place('Instance', { BuffInstance: instance });
    stand.place('Instance', { BuffInstance: instance });
    const cost = stand.step();

    // Проходов по инстансам два — наложение и ход (см. шапку `buffs.ts`), — и
    // каждый обходит оба инстанса: работа исполнена дважды и считается дважды.
    expect(cost.buffSteps).toBe(4);
    // Поиск стакающегося хозяина — отдельная величина: первый инстанс
    // осматривает оба (хозяина ещё нет), второй находит первого сразу и перебор
    // обрывает. Именно расхождение двух строк и называет виновника, когда поиск
    // станет квадратичным.
    expect(cost.buffCandidates).toBe(3);
  });

  it('пара «наблюдатель × цель» — своя строка, а линия видимости — нет (FOW-5)', () => {
    const stand = sceneStand(FOG_SCENE, (scene) => {
      scene.systems.register(
        new VisibilitySystem({
          lists: {
            vision: requireModifierList(scene.modifiers, VISION_MODIFIER_COMPONENT),
            stealth: requireModifierList(scene.modifiers, STEALTH_SOURCES_COMPONENT),
            detection: requireModifierList(scene.modifiers, DETECTION_SOURCES_COMPONENT),
          },
          hardStealthMask: scene.stealthHardMask ?? ~0,
        }),
      );
    });
    stand.place('Eye');
    stand.place('Mark');
    stand.place('Mark', { Position: { x: fixed.fromInt(2), y: 0 } });

    const cost = stand.step();
    expect(cost.visibilityPairs).toBe(2);
    // Второго счётчика линии видимости рядом нет намеренно: она идёт лучом
    // Physics API и уже посчитана в `raycasts` — по лучу на пару, дошедшую до
    // проверки. Два счётчика обещали бы одну работу дважды (design D1).
    expect(cost.raycasts).toBe(2);
  });

  it('скан кандидатов таргетинга считает ОСМОТР, а не исход (ABIL-5)', () => {
    // Скан — цикл `CandidatePicker` по запросу к миру; фигура шага не связана,
    // то есть не сужает ничего, и предиката контента нет: осмотрены все живые
    // носители `Position`, а выбран из них один.
    const picker = new CandidatePicker();
    const shape = new StepShapeGate();
    const scan: System = {
      name: 'Scan',
      order: 1,
      run: (ctx) => {
        picker.nearest(ctx, 0, 0, 0, 0, undefined, undefined, shape, {});
      },
    };
    expect(costOfSystem(scan, 3).abilityCandidates).toBe(3);
    expect(costOfSystem(scan, 5).abilityCandidates).toBe(5);
  });

  it('эмиссия события считается по событию (EVT-1)', () => {
    const emitter: System = {
      name: 'Emitter',
      order: 1,
      run: (ctx) => {
        ctx.events.emit('Boom');
        ctx.events.emit('Boom');
      },
    };
    expect(costOfSystem(emitter, 1).eventsEmitted).toBe(2);
    // Тик без единой эмиссии — ноль, а не отсутствие строки: сводка держит
    // строку каждой платформы всегда (PERF-3).
    expect(costOfSystem({ name: 'Idle', order: 1, run: () => {} }, 1).eventsEmitted).toBe(0);
  });
});
