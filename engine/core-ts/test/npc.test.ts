/**
 * Платформа поведения NPC (`npc-behavior` NPC-1..NPC-8) на настоящем стенде из
 * `loadScene` и `tick`: HFSM, каденс решений с бюджетом, threat-таблица, выбор
 * цели, движение по маршруту, расхождение и режиссёр волн.
 *
 * Сцена здесь синтетическая и живёт в тесте: предмет проверки — МЕХАНИЗМ,
 * который понимает реализация, а не числа, которые тюнит дизайнер. Тестовые
 * фикстуры движка контентом не являются и остаются в `engine/` (CONT-4).
 */
import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { addComponent, getField, setField, spawn } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { buildNavigation, type NavigationOptions } from '../src/systems/nav/navigation.js';
import { snapshotToPlain } from '../src/sim/serialization.js';
import {
  initialState,
  restoreSnapshot,
  takeSnapshot,
  tick,
  type Simulation,
} from '../src/sim/tick.js';
import {
  NPC_AGENT_COMPONENT,
  NPC_ROUTE_COMPONENT,
  NPC_THREAT_COMPONENT,
} from '../src/systems/npc/components.js';
import { compileNpcCatalog } from '../src/systems/npc/document.js';
import {
  NO_SLOT,
  NPC_CONDITIONS,
  NPC_INPUTS,
  type NpcPlatformDef,
} from '../src/systems/npc/model.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type EntityId,
  type GameEvent,
  type SimulationState,
  type System,
  type SystemContext,
} from '../src/types.js';

const F = fixed.fromFloat;
const ONE = FIXED_ONE;

/** Прямая `y = x`: единичный наклон в Q16.16. */
const RISING = { type: 'linear', slope: ONE, intercept: 0 } as const;

const COMPONENTS: SceneDef['components'] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Team', fields: { id: 'i32' } },
  { name: 'Health', fields: { hp: 'i32', hpMax: 'i32' } },
  { name: 'Dead', fields: { at: 'i32' } },
];

const PREFABS: NonNullable<SceneDef['prefabs']> = [
  {
    name: 'Creep',
    components: {
      Position: { x: 0, y: 0 },
      Velocity: { x: 0, y: 0 },
      Team: { id: 1 },
      Health: { hp: 100, hpMax: 100 },
      NpcAgent: {},
      NpcThreat: {},
      NpcRoute: {},
    },
  },
  {
    name: 'Hero',
    components: { Position: { x: 0, y: 0 }, Team: { id: 0 }, Health: { hp: 100, hpMax: 100 } },
  },
  // Крип БЕЗ компонента маршрута: им проверяется ветка «маршрута нет вовсе»
  // условия `routeDone` (NPC-7) — она отвечает «пройден», а не «не знаю».
  {
    name: 'Loose',
    components: {
      Position: { x: 0, y: 0 },
      Velocity: { x: 0, y: 0 },
      Team: { id: 1 },
      Health: { hp: 100, hpMax: 100 },
      NpcAgent: {},
      NpcThreat: {},
    },
  },
  { name: 'Point', components: { Position: { x: 0, y: 0 }, Waypoint: {} } },
  { name: 'Director', components: { NpcDirector: {} } },
];

const BINDINGS: NonNullable<NpcPlatformDef['bindings']> = {
  position: 'Position',
  velocity: 'Velocity',
  health: ['Health', 'hp'],
  healthMax: ['Health', 'hpMax'],
  team: ['Team', 'id'],
  deadMarker: 'Dead',
};

/** Крип: гонится за целью, иначе стоит. Интервал решений — четыре тика. */
function chaser(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    name: 'chaser',
    tier: 'mass',
    decision: { intervalTicks: 4 },
    ranges: { sense: F(20), attack: F(1), arrive: F(1), separation: F(2) },
    speed: F(1),
    separationWeight: 0,
    threat: {
      switchMargin: 0,
      sources: [
        {
          event: 'Damage',
          victimField: 'target',
          sourceField: 'source',
          amountField: 'amount',
          weight: ONE,
        },
      ],
    },
    states: [
      {
        name: 'chase',
        actions: [
          { executor: 'seekTarget', considerations: [{ input: 'targetKnown', curve: RISING, weight: ONE }] },
        ],
      },
    ],
    ...over,
  };
}

/** Ходок: идёт по маршруту, пока он не кончится. */
function walker(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    name: 'walker',
    tier: 'mass',
    decision: { intervalTicks: 1 },
    ranges: { sense: F(20), attack: F(1), arrive: F(1), separation: F(2) },
    speed: F(1),
    separationWeight: 0,
    states: [
      {
        name: 'march',
        actions: [
          { executor: 'followRoute', considerations: [{ input: 'routeRemaining', curve: RISING, weight: ONE }] },
        ],
      },
    ],
    ...over,
  };
}

/** Босс: две фазы по порогу здоровья, каждая со своей ротацией каста. */
function boss(): Record<string, unknown> {
  return {
    schema: 1,
    name: 'boss',
    tier: 'elite',
    decision: { intervalTicks: 1 },
    ranges: { sense: F(20), attack: F(2), arrive: F(1), separation: 0 },
    speed: F(1),
    states: [
      {
        name: 'calm',
        actions: [
          {
            executor: 'cast',
            event: 'BossSlam',
            considerations: [{ input: 'targetKnown', curve: RISING, weight: ONE }],
          },
        ],
        transitions: [{ to: 'rage', when: { kind: 'healthBelow', value: ONE / 2 } }],
      },
      {
        name: 'rage',
        actions: [
          {
            executor: 'cast',
            event: 'BossRage',
            considerations: [{ input: 'always', curve: { type: 'constant', value: ONE }, weight: ONE }],
          },
        ],
      },
    ],
  };
}

interface Harness {
  readonly world: ReturnType<typeof loadScene>['world'];
  /** Состояние симуляции — нужно тому, кто снимает и возвращает снапшот (SNAP-1). */
  readonly state: SimulationState;
  step(): readonly GameEvent[];
  place(prefab: string, overrides?: Record<string, Record<string, number>>): EntityId;
  field(entity: EntityId, component: string, name: string): number;
  emit(type: string, data: Record<string, number>): void;
  /**
   * Событие, публикуемое РАНЬШЕ системы поведения. Условие перехода `event`
   * видит шину по общему правилу (EVT-2) — только от систем с меньшим `order`,
   * — поэтому сигнал, на который сцена хочет переводить фазу, публикует система
   * раньше −795. Урон в этой сцене публикуется позже (как и в игре) и переходом
   * служить не может; накоплению угрозы (840) он виден.
   */
  signal(type: string, data: Record<string, number>): void;
}

/**
 * Стенд: сцена, интегратор скорости на свободном `order` между движением NPC
 * (70) и физикой (100) и шина для событий урона на месте систем сцены.
 */
function harness(
  npc: NpcPlatformDef,
  extra: Partial<SceneDef> = {},
  nav?: NavigationOptions,
): Harness {
  const loaded = loadScene({ components: COMPONENTS, prefabs: PREFABS, npc, ...extra });
  const { world, systems } = loaded;
  let pending: { type: string; data: Record<string, number> } | undefined;
  let early: { type: string; data: Record<string, number> } | undefined;
  // Раньше системы поведения (−795): так сцена публикует сигналы, по которым
  // документ переводит фазы (EVT-2).
  systems.register({
    name: 'SceneSignal',
    order: -950,
    run: (ctx: SystemContext) => {
      if (early === undefined) return;
      ctx.events.emit(early.type, early.data);
      early = undefined;
    },
  });
  systems.register({
    name: 'Integrate',
    order: 90,
    run: (ctx: SystemContext) => {
      for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
        ctx.commands.setField(
          entity,
          'Position',
          'x',
          fixed.add(ctx.get(entity, 'Position', 'x'), ctx.get(entity, 'Velocity', 'x')),
        );
        ctx.commands.setField(
          entity,
          'Position',
          'y',
          fixed.add(ctx.get(entity, 'Position', 'y'), ctx.get(entity, 'Velocity', 'y')),
        );
      }
    },
  });
  // Публикация урона — работа системы сцены; её `order` меньше `NpcThreat`
  // (840), поэтому событие видно накоплению угрозы на том же тике (EVT-2).
  systems.register({
    name: 'SceneDamage',
    order: 200,
    run: (ctx: SystemContext) => {
      if (pending === undefined) return;
      ctx.events.emit(pending.type, pending.data);
      pending = undefined;
    },
  });

  // Навигация — зависимость сборки (DI-3, NAV-1): её наличие и переводит
  // движение с прямого seek на путь из `findPath` (NPC-6).
  const navigation = nav === undefined ? undefined : buildNavigation(loaded.terrain!.grid, nav);
  const sim: Simulation = {
    systems,
    worldSeed: 1,
    math: mathApi,
    ...(navigation === undefined ? {} : { navigation }),
  };
  const state = initialState(world, 1);
  return {
    world,
    state,
    step: () => [...tick(sim, state).events],
    place: (prefab, overrides) => spawn(world, prefab, overrides),
    field: (entity, component, name) => getField(world, entity, component, name),
    emit: (type, data) => {
      pending = { type, data };
    },
    signal: (type, data) => {
      early = { type, data };
    },
  };
}

describe('NPC-2: документ поведения — контент, словари закрыты', () => {
  it('валидный документ компилируется целиком', () => {
    const catalog = compileNpcCatalog({ behaviors: [chaser() as never], bindings: BINDINGS });
    expect(catalog.behaviors).toHaveLength(1);
    expect(catalog.behaviors[0]!.name).toBe('chaser');
    expect(catalog.behaviors[0]!.states[0]!.actions[0]!.considerations).toHaveLength(1);
  });

  it('неизвестный исполнитель — находка с его именем', () => {
    const broken = chaser({
      states: [{ name: 'chase', actions: [{ executor: 'flank', considerations: [] }] }],
    });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/flank/);
  });

  it('неизвестный вход — находка с его именем', () => {
    const broken = chaser({
      states: [
        {
          name: 'chase',
          actions: [
            { executor: 'hold', considerations: [{ input: 'enemyMorale', curve: RISING, weight: ONE }] },
          ],
        },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/enemyMorale/);
  });

  /** Ось входа `abilityReady` (NPC-7) в документе-однодневке — ею проверяется форма. */
  const readyAxis = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    chaser({
      states: [
        {
          name: 'chase',
          actions: [
            {
              executor: 'hold',
              considerations: [{ input: 'abilityReady', curve: RISING, weight: ONE, ...over }],
            },
          ],
        },
      ],
    });

  it('«abilityReady» без слота — находка валидации с путём поля', () => {
    // NPC-7: consideration этого входа, не назвавший `slot`, — находка. Слот и
    // есть адресат наблюдения: без него спрашивать нечего.
    expect(() => compileNpcCatalog({ behaviors: [readyAxis() as never] })).toThrow(/slot/);
  });

  it('слот у постороннего входа — находка: параметризован ровно один', () => {
    // Зеркало ботовской валидации (BOT-9): лишнее поле — признак того, что
    // документ писали, не понимая, что настраивают.
    const broken = chaser({
      states: [
        {
          name: 'chase',
          actions: [
            {
              executor: 'hold',
              considerations: [{ input: 'targetKnown', curve: RISING, weight: ONE, slot: 0 }],
            },
          ],
        },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/abilityReady/);
  });

  it('названный слот доезжает до скомпилированной оси, у прочих его нет', () => {
    const catalog = compileNpcCatalog({
      behaviors: [readyAxis({ slot: 3 }) as never, chaser() as never],
      bindings: BINDINGS,
    });
    expect(catalog.behaviors[0]!.states[0]!.actions[0]!.considerations[0]!.slot).toBe(3);
    // «Слот не назван» — своё значение, а не ноль: нулевой индекс законен.
    expect(catalog.behaviors[1]!.states[0]!.actions[0]!.considerations[0]!.slot).toBe(NO_SLOT);
  });

  it('дробный и отрицательный слот — находки: индекс слота целый и неотрицательный', () => {
    expect(() => compileNpcCatalog({ behaviors: [readyAxis({ slot: -1 }) as never] })).toThrow(/slot/);
    expect(() => compileNpcCatalog({ behaviors: [readyAxis({ slot: 1.5 }) as never] })).toThrow(/slot/);
  });

  it('неизвестная форма кривой — находка с её именем и словарём', () => {
    const broken = chaser({
      states: [
        {
          name: 'chase',
          actions: [
            {
              executor: 'hold',
              considerations: [{ input: 'always', curve: { type: 'sine' }, weight: ONE }],
            },
          ],
        },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/sine/);
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/logistic/);
  });

  it('параметр-доля общей модели ограничен [0, 1] у обоих потребителей', () => {
    // `constant.value` помечен в общей модели как доля (NPC-3): документ NPC
    // обязан ограничивать его тем же диапазоном, что документ бота, — иначе
    // один параметр одной формы значил бы у них разное.
    const broken = chaser({
      states: [
        {
          name: 'chase',
          actions: [
            {
              executor: 'hold',
              considerations: [
                { input: 'always', curve: { type: 'constant', value: 5 * ONE }, weight: ONE },
              ],
            },
          ],
        },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/value/);
    // Коэффициент формы долей не помечен и шире единицы законен.
    const steep = chaser({
      states: [
        {
          name: 'chase',
          actions: [
            {
              executor: 'hold',
              considerations: [
                {
                  input: 'always',
                  curve: { type: 'linear', slope: 5 * ONE, intercept: 0 },
                  weight: ONE,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [steep as never] })).not.toThrow();
  });

  it('чужая версия формы документа названа явно', () => {
    expect(() => compileNpcCatalog({ behaviors: [chaser({ schema: 2 }) as never] })).toThrow(/schema/);
  });

  it('переход в несуществующее состояние назван вместе со списком объявленных', () => {
    const broken = boss();
    (broken.states as Record<string, unknown>[])[0]!.transitions = [
      { to: 'phase3', when: { kind: 'elapsed', ticks: 1 } },
    ];
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/phase3/);
  });

  it('молчание документа об интервале пересчёта расхождения — нормативные три тика', () => {
    // Умолчание живёт в требовании (NPC-2, NPC-6), а не в выборе реализации:
    // документ, его не назвавший, обязан исполняться двумя реализациями ядра
    // одинаково (CLI-6).
    const catalog = compileNpcCatalog({ behaviors: [chaser() as never], bindings: BINDINGS });
    expect(catalog.behaviors[0]!.separationIntervalTicks).toBe(3);
  });

  it('документ, которому нужен потиковый пересчёт расхождения, называет единицу', () => {
    const catalog = compileNpcCatalog({
      behaviors: [chaser({ separationIntervalTicks: 1 }) as never],
      bindings: BINDINGS,
    });
    expect(catalog.behaviors[0]!.separationIntervalTicks).toBe(1);
  });

  it('нулевой интервал пересчёта расхождения — находка валидации с путём поля', () => {
    // Ноль — не «выключить расхождение», а ошибка документа (NPC-6).
    const broken = chaser({ separationIntervalTicks: 0 });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(
      /separationIntervalTicks/,
    );
  });

  it('tier "elite" с интервалом больше тика — противоречие документа', () => {
    const broken = chaser({ tier: 'elite', decision: { intervalTicks: 4 } });
    expect(() => compileNpcCatalog({ behaviors: [broken as never] })).toThrow(/elite/);
  });

  it('исполнитель "cast" обязан назвать событие, прочие — не вправе', () => {
    const noEvent = chaser({
      states: [
        { name: 'chase', actions: [{ executor: 'cast', considerations: [{ input: 'always', curve: RISING, weight: ONE }] }] },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [noEvent as never] })).toThrow(/cast/);
    const strayEvent = chaser({
      states: [
        {
          name: 'chase',
          actions: [
            { executor: 'hold', event: 'X', considerations: [{ input: 'always', curve: RISING, weight: ONE }] },
          ],
        },
      ],
    });
    expect(() => compileNpcCatalog({ behaviors: [strayEvent as never] })).toThrow(/event/);
  });
});

describe('NPC-1, NPC-4: решения внутри тика, каденс детерминирован', () => {
  it('агент выбирает цель и сближается с ней', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    const hero = h.place('Hero', { Position: { x: F(10), y: 0 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(hero);
    const before = h.field(creep, 'Position', 'x');
    h.step();
    expect(h.field(creep, 'Position', 'x')).toBeGreaterThan(before);
  });

  it('два прогона одной сцены дают побитово равные состояния (DET-1)', () => {
    const run = (): number[] => {
      const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
      h.place('Hero', { Position: { x: F(10), y: F(3) } });
      const creeps = [
        h.place('Creep', { Position: { x: 0, y: 0 } }),
        h.place('Creep', { Position: { x: F(1), y: 0 } }),
        h.place('Creep', { Position: { x: 0, y: F(1) } }),
      ];
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        h.step();
        for (const creep of creeps) {
          out.push(h.field(creep, 'Position', 'x'), h.field(creep, 'Position', 'y'));
        }
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('пересмотр идёт в предсказуемых окнах: интервал K — раз в K тиков', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    h.place('Hero', { Position: { x: F(10), y: 0 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    const decided: number[] = [];
    for (let i = 0; i < 12; i++) {
      h.step();
      decided.push(h.field(creep, NPC_AGENT_COMPONENT, 'decidedTick'));
    }
    // Первый пересмотр — вход в начальное состояние; дальше тики пересмотра
    // образуют арифметическую прогрессию с шагом интервала документа.
    const unique = [...new Set(decided)].slice(1);
    expect(unique.length).toBeGreaterThan(1);
    for (let i = 1; i < unique.length; i++) {
      expect(unique[i]! - unique[i - 1]!).toBe(4);
    }
  });

  it('бюджет ограничивает число пересмотров за тик, не число агентов', () => {
    const h = harness({
      behaviors: [chaser({ decision: { intervalTicks: 1 } }) as never],
      bindings: BINDINGS,
      decisionBudget: 1,
    });
    h.place('Hero', { Position: { x: F(10), y: 0 } });
    const creeps = [
      h.place('Creep', { Position: { x: 0, y: 0 } }),
      h.place('Creep', { Position: { x: F(1), y: 0 } }),
      h.place('Creep', { Position: { x: F(2), y: 0 } }),
    ];
    h.step();
    const decided = creeps.map((creep) => h.field(creep, NPC_AGENT_COMPONENT, 'decidedTick'));
    // Первый тик: вход в состояние форсирует пересмотр у всех, но бюджет — один.
    expect(decided.filter((value) => value === 1)).toHaveLength(1);
  });
});

describe('NPC-1: мёртвый агент не решает и не двигается', () => {
  it('тело на арене не приобретает цели и не получает скорости', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    h.place('Hero', { Position: { x: F(10), y: 0 } });
    const corpse = h.place('Creep', { Position: { x: 0, y: 0 } });
    addComponent(h.world, corpse, 'Dead', { at: 0 });
    for (let i = 0; i < 5; i++) h.step();
    expect(h.field(corpse, NPC_AGENT_COMPONENT, 'target')).toBe(NO_ENTITY);
    expect(h.field(corpse, 'Velocity', 'x')).toBe(0);
    expect(h.field(corpse, 'Position', 'x')).toBe(0);
  });

  it('бюджет решений тратится на живых, а не на тела', () => {
    const h = harness({
      behaviors: [chaser({ decision: { intervalTicks: 1 } }) as never],
      bindings: BINDINGS,
      decisionBudget: 1,
    });
    h.place('Hero', { Position: { x: F(10), y: 0 } });
    const corpse = h.place('Creep', { Position: { x: 0, y: 0 } });
    addComponent(h.world, corpse, 'Dead', { at: 0 });
    const live = h.place('Creep', { Position: { x: F(1), y: 0 } });
    h.step();
    // Единственный тик бюджета достался живому: тело выборки не занимает вовсе.
    expect(h.field(live, NPC_AGENT_COMPONENT, 'decidedTick')).toBe(1);
  });
});

describe('NPC-3: вход «сколько агент в состоянии» считается от ТЕКУЩЕГО состояния', () => {
  /**
   * Документ-щуп: в состоянии `fresh` соревнуются два действия — «стоять», чей
   * вес растёт со временем в состоянии, и «идти к цели» с постоянным весом
   * ниже. На тике ВХОДА в состояние `stateElapsed` обязан быть нулём, то есть
   * побеждать должен seek: иначе агент читал бы время, проведённое в состоянии,
   * которое он только что покинул.
   */
  function elapsedProbe(): Record<string, unknown> {
    const rising = { input: 'stateElapsed', curve: RISING, weight: ONE };
    const constant = { input: 'always', curve: { type: 'constant', value: ONE / 2 }, weight: ONE };
    return {
      schema: 1,
      name: 'probe',
      tier: 'elite',
      decision: { intervalTicks: 1 },
      ranges: { sense: F(20), attack: F(1), arrive: F(1), separation: 0 },
      speed: F(1),
      separationWeight: 0,
      scales: { elapsedTicks: 8, crowd: 4 },
      states: [
        {
          name: 'warm',
          actions: [{ executor: 'hold', considerations: [constant] }],
          transitions: [{ to: 'fresh', when: { kind: 'elapsed', ticks: 8 } }],
        },
        {
          name: 'fresh',
          actions: [
            { executor: 'hold', considerations: [rising] },
            { executor: 'seekTarget', considerations: [constant] },
          ],
        },
      ],
    };
  }

  it('на тике входа вход равен нулю, а не времени прошлого состояния', () => {
    const h = harness({ behaviors: [elapsedProbe() as never], bindings: BINDINGS });
    h.place('Hero', { Position: { x: F(10), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    // Восемь тиков в `warm` — ровно шкала `elapsedTicks`, то есть вход дошёл бы
    // до единицы, если бы считался от входа в ПРЕДЫДУЩЕЕ состояние.
    for (let i = 0; i < 9; i++) h.step();
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'state')).toBe(1);
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'enteredTick')).toBe(9);
    // На тике входа `stateElapsed` = 0, поэтому «стоять» набирает ноль и
    // выигрывает постоянное действие — второе в документе.
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'action')).toBe(1);
    // Со временем ось растёт и обгоняет постоянную — тогда побеждает первое.
    for (let i = 0; i < 6; i++) h.step();
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'action')).toBe(0);
  });
});

describe('NPC-5: threat-таблица фиксированной ёмкости', () => {
  it('крип переключается на источник урона по порогу документа', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    const near = h.place('Hero', { Position: { x: F(2), y: 0 } });
    const far = h.place('Hero', { Position: { x: F(12), y: 0 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(near);
    h.emit('Damage', { target: creep, source: far, amount: 50 });
    h.step();
    expect(h.field(creep, NPC_THREAT_COMPONENT, 'value0')).toBeGreaterThan(0);
    // Форс-пересмотр по провокации — в начале следующего тика, вне окна каденса.
    h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(far);
  });

  it('переполнение ёмкости вытесняет наименьшую угрозу, таблица не растёт', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    const heroes = [1, 2, 3, 4, 5].map((i) => h.place('Hero', { Position: { x: F(30 + i), y: 0 } }));
    h.step();
    for (const [index, hero] of heroes.entries()) {
      h.emit('Damage', { target: creep, source: hero, amount: (index + 1) * 10 });
      h.step();
    }
    const sources = [0, 1, 2, 3].map((slot) => h.field(creep, NPC_THREAT_COMPONENT, `source${slot}`));
    expect(sources).toHaveLength(4);
    // Самый слабый источник вытеснен последним, самым сильным.
    expect(sources).not.toContain(heroes[0]);
    expect(sources).toContain(heroes[4]);
  });
});

describe('NPC-5: накопление угрозы ограничено представлением, а не верой в данные', () => {
  it('огромная величина события не переполняет таблицу и не уводит угрозу в минус', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    const hero = h.place('Hero', { Position: { x: F(40), y: 0 } });
    h.step();
    // Счётчик события — число СЦЕНЫ, документом не проверенное: перевод в
    // Q16.16 без насыщения вылетел бы за i32 на первом же начислении.
    for (let i = 0; i < 4; i++) {
      h.emit('Damage', { target: creep, source: hero, amount: 2_000_000_000 });
      h.step();
    }
    const value = h.field(creep, NPC_THREAT_COMPONENT, 'value0');
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(0x1fffffff);
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(hero);
  });

  it('threat-таблица без компонента агента угрозы не копит', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    // Настоящий агент на сцене нужен: без него система угрозы не исполняет
    // ничего, и проверка прошла бы на пустом месте.
    h.place('Creep', { Position: { x: F(30), y: F(30) } });
    const bare = h.place('Hero', { Position: { x: F(2), y: 0 } });
    // Сущность со ЗНАЧКОМ таблицы, но без агента: чтение поля тотально (ECS-7),
    // и без проверки она сошла бы за агента документа номер ноль.
    addComponent(h.world, bare, NPC_THREAT_COMPONENT, {});
    const hero = h.place('Hero', { Position: { x: F(4), y: 0 } });
    h.step();
    h.emit('Damage', { target: bare, source: hero, amount: 50 });
    h.step();
    expect(h.field(bare, NPC_THREAT_COMPONENT, 'value0')).toBe(0);
  });
});

describe('NPC-5, NPC-4: смерть цели ведёт к перевыбору вне окна каденса', () => {
  it('мёртвая цель заменяется на следующем тике, каденс соседей не нарушен', () => {
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    const first = h.place('Hero', { Position: { x: F(2), y: 0 } });
    const second = h.place('Hero', { Position: { x: F(6), y: 0 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(first);
    addComponent(h.world, first, 'Dead', { at: 1 });
    h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(second);
  });
});

describe('NPC-10: восприятие уважает стелс и детекцию', () => {
  /**
   * Сцена с туманом войны: схемы стелса и детекции дописывает `fog` (FOW-3),
   * поэтому свой `Team` из объявленных убран — его несёт группа тумана.
   * Канал 0 — жёсткий, канал 1 объявлен мягким: для выбора цели NPC разницы
   * быть не должно (NPC-10). `StealthState` ставится тестом руками: платформа
   * читает свёртку, а не источники, и пересчёт видимости ей для этого не нужен.
   */
  const FOG_EXTRA: Partial<SceneDef> = {
    components: COMPONENTS.filter((schema) => schema.name !== 'Team'),
    terrain: {
      width: 8,
      height: 8,
      tileSize: ONE,
      levels: Array.from({ length: 8 }, () => '00000000'),
      flags: Array.from({ length: 8 }, () => '........'),
    },
    fog: true,
    softStealthChannels: [1],
  };
  const HARD = 1 << 0;
  const SOFT = 1 << 1;

  function fogHarness(): Harness {
    return harness({ behaviors: [chaser() as never], bindings: BINDINGS }, FOG_EXTRA);
  }

  it('скрытая цель не выбирается и не участвует входом: агент ведёт себя, как будто её нет', () => {
    const h = fogHarness();
    const hidden = h.place('Hero', { Position: { x: F(2), y: 0 } });
    addComponent(h.world, hidden, 'StealthState', { mask: HARD });
    const visible = h.place('Hero', { Position: { x: F(6), y: 0 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();

    // Ближе стоит скрытый — но целью становится видимый, как в прогоне без скрытого.
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(visible);
  });

  it('мягкий канал скрывает от выбора целью так же, как жёсткий (FOW-13)', () => {
    const h = fogHarness();
    const hidden = h.place('Hero', { Position: { x: F(2), y: 0 } });
    addComponent(h.world, hidden, 'StealthState', { mask: SOFT });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();

    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(NO_ENTITY);
  });

  it('агент с детекцией канала выбирает цель штатно', () => {
    const h = fogHarness();
    const hidden = h.place('Hero', { Position: { x: F(2), y: 0 } });
    addComponent(h.world, hidden, 'StealthState', { mask: HARD });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    addComponent(h.world, creep, 'DetectionState', { mask: HARD });
    h.step();

    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(hidden);
  });

  it('угроза от скрытого источника копится, но целью он не становится, пока скрыт', () => {
    const h = fogHarness();
    const hidden = h.place('Hero', { Position: { x: F(3), y: 0 } });
    addComponent(h.world, hidden, 'StealthState', { mask: HARD });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    h.emit('Damage', { target: creep, source: hidden, amount: 50 });
    h.step();

    // Накопление — событийное и политике не мешает (NPC-5)…
    expect(h.field(creep, NPC_THREAT_COMPONENT, 'value0')).toBeGreaterThan(0);
    // …но лидер таблицы скрыт и целью не назначен.
    h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(NO_ENTITY);

    // Стелс спал — накопленная угроза немедленно даёт цель в ближайшее окно решений.
    setField(h.world, hidden, 'StealthState', 'mask', 0);
    for (let i = 0; i < 4; i++) h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'target')).toBe(hidden);
  });
});

describe('NPC-6: движение — политика над навигационным швом', () => {
  it('волна проходит маршрут в сцене без Navigation API', () => {
    const h = harness({ behaviors: [walker() as never], bindings: BINDINGS });
    h.place('Point', { Position: { x: F(5), y: 0 }, Waypoint: { route: 0, index: 0 } });
    h.place('Point', { Position: { x: F(5), y: F(5) }, Waypoint: { route: 0, index: 1 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 }, NpcRoute: { route: 0, index: 0 } });
    for (let i = 0; i < 12; i++) h.step();
    // Первая точка пройдена — прогресс маршрута продвинулся.
    expect(h.field(creep, NPC_ROUTE_COMPONENT, 'index')).toBeGreaterThan(0);
    expect(h.field(creep, 'Position', 'y')).toBeGreaterThan(0);
  });

  it('скученные крипы расходятся, стоимость шага не растёт квадратично', () => {
    const h = harness({
      behaviors: [chaser({ separationWeight: ONE, ranges: { sense: F(20), attack: F(1), arrive: F(1), separation: F(3) } }) as never],
      bindings: BINDINGS,
    });
    const creeps = [
      h.place('Creep', { Position: { x: 0, y: 0 } }),
      h.place('Creep', { Position: { x: F(0.25), y: 0 } }),
      h.place('Creep', { Position: { x: 0, y: F(0.25) } }),
    ];
    const spread = (): number => {
      let maximum = 0;
      for (const a of creeps) {
        for (const b of creeps) {
          const dx = h.field(a, 'Position', 'x') - h.field(b, 'Position', 'x');
          const dy = h.field(a, 'Position', 'y') - h.field(b, 'Position', 'y');
          maximum = Math.max(maximum, Math.abs(dx) + Math.abs(dy));
        }
      }
      return maximum;
    };
    const before = spread();
    for (let i = 0; i < 10; i++) h.step();
    expect(spread()).toBeGreaterThan(before);
  });
});

/** Ассет террейна сцены — тип поля, без «может отсутствовать». */
type TerrainAsset = NonNullable<SceneDef['terrain']>;

describe('NPC-6: при собранной навигации сближение идёт по findPath', () => {
  /** Медленный преследователь: за тик проходит четверть мировой единицы. */
  const SLOW = { speed: F(0.25) };

  /**
   * Восемь на восемь: левая половина — уровень 0, правая — уровень 1. Перепад
   * проходим ТОЛЬКО по рампе в двух нижних рядах (TERR-5), поэтому прямой seek
   * упирается в кромку обрыва, а путь обязан вести к рампе.
   */
  const CLIFF: TerrainAsset = {
    width: 8,
    height: 8,
    tileSize: ONE,
    levels: [
      '00001111',
      '00001111',
      '00001111',
      '00001111',
      '00001111',
      '00001111',
      '00001111',
      '00001111',
    ],
    flags: [
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '...^....',
      '...^....',
    ],
  };

  /** Тот же перепад БЕЗ рампы: другой берег недостижим вовсе (NAV-1). */
  const SHEER: TerrainAsset = { ...CLIFF, flags: CLIFF.levels.map(() => '........') };

  /** Ровное поле: прямая до цели проходима целиком, и путь сглаживается в неё. */
  const FLAT: TerrainAsset = {
    ...CLIFF,
    levels: CLIFF.levels.map(() => '00000000'),
    flags: CLIFF.levels.map(() => '........'),
  };

  const NAV: NavigationOptions = { budget: 512, maxAgentRadius: ONE >> 1 };

  function chase(terrain: TerrainAsset, nav?: NavigationOptions): Harness {
    const h = harness({ behaviors: [chaser(SLOW) as never], bindings: BINDINGS }, { terrain }, nav);
    h.place('Hero', { Position: { x: F(7.5), y: F(0.5) } });
    h.place('Creep', { Position: { x: F(0.5), y: F(0.5) } });
    return h;
  }

  /** Единственный крип сцены — он же последняя расставленная сущность. */
  function creepOf(h: Harness): EntityId {
    return query(h.world, { all: [NPC_AGENT_COMPONENT] })[0]!;
  }

  it('цель за обрывом: агент идёт к рампе, а не в кромку обрыва', () => {
    const withNav = chase(CLIFF, NAV);
    const creep = creepOf(withNav);
    for (let i = 0; i < 30; i++) withNav.step();
    // Рампа внизу: путь обязан увести агента вниз, чего прямой seek не делает.
    expect(withNav.field(creep, 'Position', 'y')).toBeGreaterThan(F(0.5));
    expect(withNav.field(creep, NPC_AGENT_COMPONENT, 'pathValid')).toBe(1);

    // Та же сцена без навигации — прежний прямой seek: строго вдоль ряда.
    const direct = chase(CLIFF);
    const same = creepOf(direct);
    for (let i = 0; i < 30; i++) direct.step();
    expect(direct.field(same, 'Position', 'y')).toBe(F(0.5));
    expect(direct.field(same, NPC_AGENT_COMPONENT, 'pathValid')).toBe(0);
  });

  it('точка маршрута за обрывом: следование маршрутом идёт тем же путём', () => {
    // Маршрут и преследование делят один механизм (NPC-6): различается только
    // источник очередной цели, поэтому обход обрыва обязан работать у обоих.
    const route = (nav?: NavigationOptions): Harness => {
      const h = harness(
        { behaviors: [walker({ ...SLOW, ranges: { sense: F(20), attack: F(1), arrive: F(1), separation: 0 } }) as never], bindings: BINDINGS },
        { terrain: CLIFF },
        nav,
      );
      h.place('Point', { Position: { x: F(7.5), y: F(0.5) }, Waypoint: { route: 0, index: 0 } });
      h.place('Creep', { Position: { x: F(0.5), y: F(0.5) }, NpcRoute: { route: 0, index: 0 } });
      return h;
    };
    const withNav = route(NAV);
    const creep = creepOf(withNav);
    for (let i = 0; i < 30; i++) withNav.step();
    expect(withNav.field(creep, 'Position', 'y')).toBeGreaterThan(F(0.5));

    const direct = route();
    const same = creepOf(direct);
    for (let i = 0; i < 30; i++) direct.step();
    expect(direct.field(same, 'Position', 'y')).toBe(F(0.5));
  });

  it('недостижимая цель деградирует до прямого seek, матч не падает', () => {
    const h = chase(SHEER, NAV);
    const creep = creepOf(h);
    // Десять тиков: агент ещё на своём берегу — стенда с физикой здесь нет, и
    // дойдя до кромки, он перешагнул бы её, оказавшись с целью на одном уровне.
    for (let i = 0; i < 10; i++) h.step();
    expect(h.field(creep, 'Position', 'x')).toBeLessThan(F(4));
    // Держимой точки нет — `unreachable` её сбрасывает, — и агент идёт прямо.
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'pathValid')).toBe(0);
    expect(h.field(creep, 'Position', 'y')).toBe(F(0.5));
    expect(h.field(creep, 'Position', 'x')).toBeGreaterThan(F(0.5));
  });

  it('на ровном поле путь совпадает с прямым seek байт-в-байт', () => {
    const withNav = chase(FLAT, NAV);
    const direct = chase(FLAT);
    const a = creepOf(withNav);
    const b = creepOf(direct);
    for (let i = 0; i < 20; i++) {
      withNav.step();
      direct.step();
      expect(withNav.field(a, 'Position', 'x')).toBe(direct.field(b, 'Position', 'x'));
      expect(withNav.field(a, 'Position', 'y')).toBe(direct.field(b, 'Position', 'y'));
    }
  });

  it('перемотка возвращает держимую точку пути, и прогон с отката совпадает', () => {
    const h = chase(CLIFF, NAV);
    const creep = creepOf(h);
    for (let i = 0; i < 5; i++) h.step();
    const held = [
      h.field(creep, NPC_AGENT_COMPONENT, 'pathValid'),
      h.field(creep, NPC_AGENT_COMPONENT, 'pathX'),
      h.field(creep, NPC_AGENT_COMPONENT, 'pathY'),
    ];
    expect(held[0]).toBe(1);
    // Точка входит в снапшот вместе с миром (SNAP-1) — своей структуры у
    // платформы нет, поэтому перемотка возвращает её даром.
    const snapshot = takeSnapshot(h.state);
    expect(snapshotToPlain(snapshot).world.components.NpcAgent).toBeDefined();

    for (let i = 0; i < 6; i++) h.step();
    const live = snapshotToPlain(takeSnapshot(h.state));
    restoreSnapshot(h.state, snapshot);
    expect([
      h.field(creep, NPC_AGENT_COMPONENT, 'pathValid'),
      h.field(creep, NPC_AGENT_COMPONENT, 'pathX'),
      h.field(creep, NPC_AGENT_COMPONENT, 'pathY'),
    ]).toEqual(held);
    for (let i = 0; i < 6; i++) h.step();
    expect(snapshotToPlain(takeSnapshot(h.state))).toEqual(live);
  });
});

describe('NPC-6: пересчёт вектора расхождения идёт каденсом', () => {
  /**
   * Толкучка: агент стоит и только расходится с соседями. Скорость и вес
   * расхождения — единица, поэтому записанная скорость РАВНА применённому
   * вектору расхождения, и наблюдать вектор можно прямо полем `Velocity`.
   */
  function crowder(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 1,
      name: 'crowder',
      tier: 'mass',
      decision: { intervalTicks: 1 },
      ranges: { sense: F(20), attack: F(1), arrive: F(1), separation: F(3) },
      speed: ONE,
      separationWeight: ONE,
      states: [
        {
          name: 'stand',
          actions: [
            {
              executor: 'hold',
              considerations: [{ input: 'always', curve: { type: 'constant', value: ONE }, weight: ONE }],
            },
          ],
        },
      ],
      ...over,
    };
  }

  it('сосед сдвинулся вне окна — агент идёт с последним пересчитанным вектором', () => {
    const h = harness({ behaviors: [crowder() as never], bindings: BINDINGS });
    const agent = h.place('Creep', { Position: { x: 0, y: 0 } });
    const neighbour = h.place('Creep', { Position: { x: F(1), y: 0 } });
    // Расстановка закрепляется перед каждым тиком прямой записью мира — приём
    // ТЕСТА (внутри тика мутации идут только через Command Buffer, DET-7):
    // предмет проверки — окно пересчёта, а не траектория толкучки.
    const pin = (at: number): void => {
      setField(h.world, agent, 'Position', 'x', 0);
      setField(h.world, agent, 'Position', 'y', 0);
      setField(h.world, neighbour, 'Position', 'x', at);
      setField(h.world, neighbour, 'Position', 'y', 0);
    };
    // Окно агента места 0 — тики, кратные трём (нормативное умолчание NPC-2).
    for (let tick = 1; tick <= 3; tick++) {
      pin(F(1));
      h.step();
    }
    // Вектор смотрит ПРОЧЬ от соседа; единичным он выходит с точностью Q16.16,
    // поэтому проверяется знак и совпадение с держимым, а не круглое число.
    const held = h.field(agent, 'Velocity', 'x');
    expect(held).toBeLessThan(0);
    // Вектор — состояние симуляции, а не кэш платформы: он лежит полем
    // компонента и потому уезжает в снапшот вместе с миром (SNAP-1).
    expect(h.field(agent, NPC_AGENT_COMPONENT, 'sepX')).toBe(held);
    // Сосед перепрыгнул на другую сторону, но окна агента на этих тиках нет —
    // применяется прежний вектор, а не свежий.
    for (let tick = 4; tick <= 5; tick++) {
      pin(-F(1));
      h.step();
      expect(h.field(agent, 'Velocity', 'x')).toBe(held);
    }
    // В своё окно вектор пересчитывается по текущему миру.
    pin(-F(1));
    h.step();
    expect(h.field(agent, 'Velocity', 'x')).toBeGreaterThan(0);
    expect(h.field(agent, NPC_AGENT_COMPONENT, 'sepX')).toBe(h.field(agent, 'Velocity', 'x'));
  });

  it('окна пересчёта размазаны местом агента в обходе (QUERY-2)', () => {
    const h = harness({ behaviors: [crowder() as never], bindings: BINDINGS });
    const places: readonly (readonly [number, number])[] = [
      [0, 0],
      [F(1), 0],
      [0, F(1)],
    ];
    const creeps = places.map(([x, y]) => h.place('Creep', { Position: { x, y } }));
    const pin = (): void => {
      creeps.forEach((creep, index) => {
        setField(h.world, creep, 'Position', 'x', places[index]![0]);
        setField(h.world, creep, 'Position', 'y', places[index]![1]);
      });
    };
    const firstWindow = creeps.map(() => 0);
    for (let tick = 1; tick <= 4; tick++) {
      pin();
      h.step();
      creeps.forEach((creep, index) => {
        if (firstWindow[index] === 0 && h.field(creep, 'Velocity', 'x') !== 0) {
          firstWindow[index] = tick;
        }
      });
    }
    // Окно — `(тик + место в обходе) % 3 === 0`: у мест 0, 1 и 2 первое окно
    // приходится на тики 3, 2 и 1. До своего окна агент идёт с нулевым
    // вектором — умолчанием полей.
    expect(firstWindow).toEqual([3, 2, 1]);
  });

  it('документ, назвавший единицу, пересчитывает вектор каждый тик', () => {
    const h = harness({
      behaviors: [crowder({ separationIntervalTicks: 1 }) as never],
      bindings: BINDINGS,
    });
    const agent = h.place('Creep', { Position: { x: 0, y: 0 } });
    const neighbour = h.place('Creep', { Position: { x: F(1), y: 0 } });
    const pin = (at: number): void => {
      setField(h.world, agent, 'Position', 'x', 0);
      setField(h.world, agent, 'Position', 'y', 0);
      setField(h.world, neighbour, 'Position', 'x', at);
      setField(h.world, neighbour, 'Position', 'y', 0);
    };
    pin(F(1));
    h.step();
    expect(h.field(agent, 'Velocity', 'x')).toBeLessThan(0);
    // Свежесть — на том же тике, а не через окно: следующий тик уже отвечает по
    // сдвинувшемуся соседу.
    pin(-F(1));
    h.step();
    expect(h.field(agent, 'Velocity', 'x')).toBeGreaterThan(0);
  });

  it('перемотка на тик МЕЖДУ окнами возвращает держимый вектор (SNAP-1, REW-2)', () => {
    // Скорость мелкая нарочно: агенты остаются соседями все девять тиков, и
    // вектор расхождения на тике снапшота заведомо не нулевой — иначе проверка
    // прошла бы на пустом месте.
    const h = harness({ behaviors: [crowder({ speed: F(0.1) }) as never], bindings: BINDINGS });
    const creeps = [
      h.place('Creep', { Position: { x: 0, y: 0 } }),
      h.place('Creep', { Position: { x: F(1), y: 0 } }),
      h.place('Creep', { Position: { x: 0, y: F(1) } }),
    ];
    // Окна агента места 0 — тики 3 и 6; снимок берётся на тике 4, то есть
    // ПОСРЕДИ интервала: держимый вектор в этот момент есть, а пересчёта на
    // следующем тике не будет.
    for (let i = 0; i < 4; i++) h.step();
    expect(h.state.tick).toBe(4);
    const held = creeps.map((creep) => h.field(creep, NPC_AGENT_COMPONENT, 'sepX'));
    expect(held.some((value) => value !== 0)).toBe(true);
    const snapshot = takeSnapshot(h.state);

    // Честный прогон дальше — до тика 9.
    for (let i = 0; i < 5; i++) h.step();
    const live = snapshotToPlain(takeSnapshot(h.state));

    // Откат в середину интервала и тот же путь заново: вектор приезжает из
    // снапшота вместе с миром, поэтому прогон с отката побитово совпадает с
    // живым. Не снапшоться он — агенты вышли бы из отката с нулевым вектором и
    // разошлись бы с живым прогоном на первом же тике.
    restoreSnapshot(h.state, snapshot);
    expect(h.state.tick).toBe(4);
    expect(creeps.map((creep) => h.field(creep, NPC_AGENT_COMPONENT, 'sepX'))).toEqual(held);
    for (let i = 0; i < 5; i++) h.step();
    expect(snapshotToPlain(takeSnapshot(h.state))).toEqual(live);
  });

  it('документ без расхождения держимого вектора не пишет вовсе', () => {
    // Ранний выход остаётся ранним (NPC-6): ни запроса к сетке, ни записей в
    // компонент — веса расхождения у `chaser` ноль.
    const h = harness({ behaviors: [chaser() as never], bindings: BINDINGS });
    h.place('Hero', { Position: { x: F(10), y: 0 } });
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.place('Creep', { Position: { x: F(1), y: 0 } });
    for (let i = 0; i < 6; i++) h.step();
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'sepX')).toBe(0);
    expect(h.field(creep, NPC_AGENT_COMPONENT, 'sepY')).toBe(0);
  });
});

describe('NPC-8: волны — Director-слой из контентных таблиц', () => {
  it('состав волны меняется таблицей, код режиссёра не трогается', () => {
    const h = harness({
      behaviors: [walker() as never],
      bindings: BINDINGS,
      waves: {
        cap: 16,
        entries: [{ prefab: 'Creep', count: 3, behavior: 0, delayTicks: 0, spacingTicks: 1, route: 0 }],
      },
    });
    h.place('Point', { Position: { x: F(5), y: 0 }, Waypoint: { route: 0, index: 0 } });
    h.place('Director');
    for (let i = 0; i < 10; i++) h.step();
    const spawned = countAgents(h);
    expect(spawned).toBe(3);
  });

  it('волна с нулевым составом не выпускает никого', () => {
    const h = harness({
      behaviors: [walker() as never],
      bindings: BINDINGS,
      waves: {
        cap: 16,
        entries: [
          { prefab: 'Creep', count: 0, behavior: 0, delayTicks: 0, spacingTicks: 0, x: 0, y: 0 },
          { prefab: 'Creep', count: 1, behavior: 0, delayTicks: 0, spacingTicks: 0, x: 0, y: 0 },
        ],
      },
    });
    h.place('Director');
    for (let i = 0; i < 8; i++) h.step();
    // Ноль в составе волны значит ноль: выпущен только боец ВТОРОЙ волны.
    expect(countAgents(h)).toBe(1);
  });

  it('мёртвые агенты предел не занимают: место освобождается их смертью', () => {
    const h = harness({
      behaviors: [walker() as never],
      bindings: BINDINGS,
      waves: {
        cap: 1,
        entries: [{ prefab: 'Creep', count: 3, behavior: 0, delayTicks: 0, spacingTicks: 0, x: 0, y: 0 }],
      },
    });
    h.place('Director');
    for (let i = 0; i < 4; i++) h.step();
    expect(countAgents(h)).toBe(1);
    // Тело остаётся на арене — так живут сцены с маркером мёртвых, — но место
    // в пределе оно занимать не должно (NPC-8).
    const first = query(h.world, { all: [NPC_AGENT_COMPONENT] })[0]!;
    addComponent(h.world, first, 'Dead', { at: 4 });
    for (let i = 0; i < 3; i++) h.step();
    expect(countAgents(h)).toBe(2);
  });

  it('лимит активных NPC откладывает спавн, а не пропускает его', () => {
    const h = harness({
      behaviors: [walker() as never],
      bindings: BINDINGS,
      waves: {
        cap: 2,
        entries: [{ prefab: 'Creep', count: 4, behavior: 0, delayTicks: 0, spacingTicks: 0, x: 0, y: 0 }],
      },
    });
    h.place('Director');
    for (let i = 0; i < 10; i++) h.step();
    expect(countAgents(h)).toBe(2);
  });
});

describe('NPC-2: имя поля адресата события называет документ, а не механизм', () => {
  /** Босс, чья вторая фаза открывается событием сцены, адресованным полем `target`. */
  function signalled(entityField?: string): Record<string, unknown> {
    const doc = boss();
    (doc.states as Record<string, unknown>[])[0]!.transitions = [
      {
        to: 'rage',
        when: { kind: 'event', event: 'Damage', ...(entityField === undefined ? {} : { entityField }) },
      },
    ];
    return doc;
  }

  it('переход по событию срабатывает на поле, названном документом', () => {
    const h = harness({ behaviors: [signalled('target') as never], bindings: BINDINGS });
    const hero = h.place('Hero', { Position: { x: F(3), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'state')).toBe(0);
    h.signal('Damage', { target: npc, source: hero, amount: 5 });
    h.step();
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'state')).toBe(1);
  });

  it('событие, адресованное другому, перехода не даёт', () => {
    const h = harness({ behaviors: [signalled('target') as never], bindings: BINDINGS });
    const hero = h.place('Hero', { Position: { x: F(3), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    h.signal('Damage', { target: hero, source: npc, amount: 5 });
    h.step();
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'state')).toBe(0);
  });

  it('документ, адресата не назвавший, читает событие как общий сигнал сцены', () => {
    const h = harness({ behaviors: [signalled() as never], bindings: BINDINGS });
    const hero = h.place('Hero', { Position: { x: F(3), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.step();
    h.signal('Damage', { target: hero, source: npc, amount: 5 });
    h.step();
    expect(h.field(npc, NPC_AGENT_COMPONENT, 'state')).toBe(1);
  });
});

describe('NPC-7: фазы босса и каст штатной машиной способностей', () => {
  it('переход фазы по здоровью меняет ротацию, каст идёт событием', () => {
    const h = harness({ behaviors: [boss() as never], bindings: BINDINGS });
    h.place('Hero', { Position: { x: F(3), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    const calm = h.step();
    expect(calm.map((event) => event.type)).toContain('BossSlam');
    expect(calm.find((event) => event.type === 'BossSlam')!.data.caster).toBe(npc);
    // Здоровье падает ниже порога документа — фаза меняется вместе с ротацией.
    // Прямая запись мира — приём ТЕСТА: внутри тика мутации идут только через
    // Command Buffer (DET-7).
    setField(h.world, npc, 'Health', 'hp', 10);
    const raged = h.step();
    expect(raged.map((event) => event.type)).toContain('BossRage');
    expect(raged.map((event) => event.type)).not.toContain('BossSlam');
  });

  it('просьба о касте — фронт, а не уровень: событие уходит на смене действия', () => {
    const h = harness({ behaviors: [boss() as never], bindings: BINDINGS });
    h.place('Hero', { Position: { x: F(3), y: 0 } });
    h.place('Creep', { Position: { x: 0, y: 0 } });
    expect(h.step().map((event) => event.type)).toContain('BossSlam');
    // Тот же tier решает каждый тик, но действие не менялось — просьба не
    // повторяется: гейт повторов у платформы способностей свой (ABIL-7).
    expect(h.step().map((event) => event.type)).not.toContain('BossSlam');
    expect(h.step().map((event) => event.type)).not.toContain('BossSlam');
  });

  /**
   * Второго пути каста платформа не вводит (NPC-7): ротация ПРОСИТ способность
   * событием, дальше работают штатные фазы (ABIL-4) и штатный словарь
   * прерываний (ABIL-6).
   */
  function bossStand(): Harness {
    const h = harness(
      { behaviors: [boss() as never], bindings: BINDINGS },
      {
        prefabs: [
          ...PREFABS,
          { name: 'Slot', components: { AbilitySlot: {}, AbilityCooldown: { remaining: 0, total: 0 } } },
        ],
        abilities: [
          {
            id: 'slam',
            trigger: { event: { type: 'BossSlam' } },
            cooldownTicks: 20,
            phases: [{ id: 'windup', trigger: 'auto', durationTicks: 3, timeout: { then: 'commit' } }],
            interrupts: { damaged: { cooldown: 'full' } },
            effects: [{ emitEvent: { type: 'SlamHit' } }],
          },
        ],
        abilityRuntime: {
          deadMarker: 'Dead',
          damageEvent: { type: 'Damage', entityField: 'target', amountField: 'amount' },
        },
      },
    );
    return h;
  }

  it('каст ротации проходит фазами штатной машины и доходит до эффектов (ABIL-4)', () => {
    const h = bossStand();
    h.place('Hero', { Position: { x: F(3), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.place('Slot', { AbilitySlot: { owner: npc, abilityId: 0, slotIndex: 0 } });
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) seen.push(...h.step().map((event) => event.type));
    expect(seen).toContain('SlamHit');
  });

  it('прерывание телеграфированного каста — штатным словарём способности (ABIL-6)', () => {
    const h = bossStand();
    const hero = h.place('Hero', { Position: { x: F(3), y: 0 } });
    const npc = h.place('Creep', { Position: { x: 0, y: 0 } });
    h.place('Slot', { AbilitySlot: { owner: npc, abilityId: 0, slotIndex: 0 } });
    h.step();
    h.emit('Damage', { target: npc, source: hero, amount: 5 });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push(...h.step().map((event) => event.type));
    // Каст сорван, кулдаун взведён целиком — до конца прогона эффект не идёт.
    expect(seen).not.toContain('SlamHit');
  });
});

function countAgents(h: Harness): number {
  return query(h.world, { all: [NPC_AGENT_COMPONENT] }).length;
}

// ------------------------------------------------------- дисциплина аллокаций

describe('Дисциплина аллокаций платформы NPC (NPC-4)', () => {
  /**
   * Счётчика аллокаций в vitest нет, поэтому проверяется наблюдаемое: число
   * запросов к миру за тик. Каждый запрос — единственный контейнер, который
   * система заводит на тик; всё прочее (сетка соседей, индекс маршрутов, кадр
   * агента, спецификации запросов) живёт на экземпляре системы. Постоянное
   * число запросов при десятикратном росте числа агентов и означает «тик не
   * аллоцирует пропорционально их числу».
   *
   * Чего эта проверка НЕ видит: аллокации внутри самих систем. Их отсутствие
   * держится конструкцией и читается на ревью — сетка соседей адресуется
   * открыто в типизированных массивах (`grid.ts`), кадр решателя лежит полями
   * решателя, направления считаются полями системы движения. Единственная
   * оставленная аллокация на наполнение — карты индекса маршрутов, и величина
   * её есть число точек маршрута, а не число агентов (`routes.ts`).
   */
  class CountingProbe implements System {
    readonly name: string;
    readonly order: number;
    queries = 0;
    private readonly inner: System;

    constructor(inner: System) {
      this.inner = inner;
      this.name = inner.name;
      this.order = inner.order;
    }

    run(ctx: SystemContext): void {
      const probe: SystemContext = {
        ...ctx,
        query: (spec) => {
          this.queries += 1;
          return ctx.query(spec);
        },
      };
      this.inner.run(probe);
    }
  }

  function queriesFor(agents: number): number {
    const loaded = loadScene({
      components: COMPONENTS,
      prefabs: PREFABS,
      npc: { behaviors: [chaser() as never], bindings: BINDINGS },
    });
    const probes: CountingProbe[] = [];
    for (const system of [...loaded.systems.ordered()]) {
      if (!system.name.startsWith('Npc')) continue;
      const probe = new CountingProbe(system);
      loaded.systems.override(probe);
      probes.push(probe);
    }
    spawn(loaded.world, 'Hero', { Position: { x: F(10), y: 0 } });
    for (let i = 0; i < agents; i++) {
      spawn(loaded.world, 'Creep', { Position: { x: F(i), y: 0 } });
    }
    const sim: Simulation = { systems: loaded.systems, worldSeed: 1, math: mathApi };
    const state = initialState(loaded.world, 1);
    tick(sim, state);
    return probes.reduce((sum, probe) => sum + probe.queries, 0);
  }

  it('число запросов к миру за тик не зависит от числа агентов', () => {
    expect(queriesFor(40)).toBe(queriesFor(4));
  });
});

// --------------------------------------------------------- закрытые словари

/**
 * Словари условий переходов и входов скоринга ЗАКРЫТЫ (NPC-2, NPC-7), и
 * закрытость — это обязанность, а не только запрет: контент вправе назвать
 * ЛЮБОЕ имя из словаря, поэтому вычислено в гейте обязано быть каждое. Таблицы
 * ниже индексируются самими словарями, и `Record` делает пропуск ошибкой
 * ТИПИЗАЦИИ: имя, добавленное в `NPC_CONDITIONS`/`NPC_INPUTS` без разбора
 * здесь, красит `npm run typecheck`, а не проезжает молча.
 */

/** Положение мира и время, за которое проба обязана ответить. */
interface Probe {
  /** Расстановка сцены до первого тика. */
  readonly place: (h: Harness) => void;
  /** Что сцена делает ПЕРЕД тиком номер `i` (нумерация с нуля). */
  readonly during?: (h: Harness, i: number) => void;
  /** Сколько тиков смотреть; по умолчанию четыре. */
  readonly ticks?: number;
  /** Добавка к сцене пробы — платформа способностей у входа `abilityReady`. */
  readonly scene?: Partial<SceneDef>;
}

/** Типы событий пробы за отведённые ей тики. */
function probeCast(behavior: Record<string, unknown>, probe: Probe): readonly string[] {
  const h = harness({ behaviors: [behavior as never], bindings: BINDINGS }, probe.scene ?? {});
  probe.place(h);
  const seen: string[] = [];
  for (let i = 0; i < (probe.ticks ?? 4); i++) {
    probe.during?.(h, i);
    for (const event of h.step()) seen.push(event.type);
  }
  return seen;
}

/**
 * Проба словаря условий: документ из двух фаз, где переход `probe → hit`
 * сторожит РОВНО ОДНО проверяемое условие. Фаза читается шиной — каждая
 * кастует своё событие (NPC-7), — а не внутренним полем платформы: проверяется,
 * что условие ВЫЧИСЛЯЕТСЯ и меняет ротацию, а не как платформа хранит номер
 * состояния. Тиков больше одного намеренно: смена фазы — переход следующего
 * пересмотра, и проба на одном тике мерила бы момент входа в мир.
 */
function conditionProbe(when: Record<string, unknown>): Record<string, unknown> {
  const always = { input: 'always', curve: { type: 'constant', value: ONE }, weight: ONE };
  return {
    schema: 1,
    name: 'probe',
    // `elite` с интервалом в тик: проба обязана пересматривать решение каждый
    // тик, иначе зелёной её сделал бы каденс, а не условие.
    tier: 'elite',
    decision: { intervalTicks: 1 },
    ranges: { sense: F(20), attack: F(20), arrive: F(1), separation: F(2) },
    speed: F(1),
    states: [
      {
        name: 'probe',
        actions: [{ executor: 'cast', event: 'Probe', considerations: [always] }],
        transitions: [{ to: 'hit', when }],
      },
      { name: 'hit', actions: [{ executor: 'cast', event: 'Hit', considerations: [always] }] },
    ],
  };
}

/**
 * Проба словаря входов: состояние с ОДНИМ действием, вес которого даёт
 * проверяемый вход. Каст означает ненулевую полезность, его отсутствие —
 * нулевую: «нулевая полезность не выбирается вовсе» (NPC-3), и второго способа
 * отличить их у документа нет.
 */
function inputProbe(
  input: string,
  curve: Record<string, unknown> = RISING,
): Record<string, unknown> {
  // `abilityReady` — единственный параметризованный вход словаря (NPC-7): он
  // обязан назвать слот, и проба называет тот, который сама кладёт в мир.
  const axis =
    input === 'abilityReady'
      ? { input, slot: PROBE_SLOT, curve, weight: ONE }
      : { input, curve, weight: ONE };
  return {
    schema: 1,
    name: 'probe',
    tier: 'elite',
    decision: { intervalTicks: 1 },
    ranges: { sense: F(20), attack: F(20), arrive: F(1), separation: F(2) },
    speed: F(1),
    states: [
      { name: 'weigh', actions: [{ executor: 'cast', event: 'Weighed', considerations: [axis] }] },
    ],
  };
}

/** Индекс слота, о готовности которого проба спрашивает (ABIL-1). */
const PROBE_SLOT = 0;

/**
 * Сцена пробы входа `abilityReady`: платформа способностей с определением,
 * которое само не стартует (триггер — событие, которого никто не публикует) и
 * не кончается само (фаза `auto` без срока). Предмет пробы — ВХОД, а не машина
 * каста: её собственные переходы закрыты `abilitySystems.test.ts`.
 */
const ABILITY_SCENE: Partial<SceneDef> = {
  prefabs: [
    ...PREFABS,
    { name: 'Slot', components: { AbilitySlot: {}, AbilityCooldown: { remaining: 0, total: 0 } } },
  ],
  abilities: [
    {
      id: 'probe',
      trigger: { event: { type: 'NeverAsked', as: 'ask' } },
      phases: [{ id: 'hold', trigger: 'auto' }],
    },
  ] as unknown as NonNullable<SceneDef['abilities']>,
};

/** Мир слота способности: чем он занят и кому принадлежит (ABIL-1, ABIL-7). */
interface SlotWorld {
  /** Индекс слота у владельца; проба спрашивает `PROBE_SLOT`. */
  readonly slotIndex?: number;
  /** Остаток кулдауна в тиках. */
  readonly cooldown?: number;
  /** Идёт каст: индекс активной фазы определения. */
  readonly phase?: number;
  /** Слот принадлежит не агенту, а постороннему. */
  readonly foreign?: boolean;
}

/** Крип, которому выдан слот способности описанного положения. */
const slotted =
  (world: SlotWorld = {}) =>
  (h: Harness): void => {
    const creep = h.place('Creep', { Position: { x: 0, y: 0 } });
    const owner = world.foreign ? h.place('Hero', { Position: { x: F(3), y: 0 } }) : creep;
    const cooldown = world.cooldown ?? 0;
    h.place('Slot', {
      AbilitySlot: {
        owner,
        slotIndex: world.slotIndex ?? PROBE_SLOT,
        ...(world.phase === undefined ? {} : { phase: world.phase }),
      },
      AbilityCooldown: { remaining: cooldown, total: cooldown },
    });
  };

describe('NPC-2, NPC-7: каждое условие закрытого словаря вычисляется', () => {
  /** Сторож перехода вместе с миром, в котором проверяется его вердикт. */
  interface Verdict extends Probe {
    /** Условие, как его пишет документ. */
    readonly when: Record<string, unknown>;
  }

  /** Разбор одного имени словаря: где условие истинно и где ложно. */
  interface ConditionCase {
    /** Мир, в котором условие ИСТИННО: проба обязана уйти в `hit`. */
    readonly fires: Verdict;
    /** Мир, в котором оно ЛОЖНО: проба обязана остаться в `probe`. */
    readonly holds: Verdict;
  }

  const creep = (h: Harness): void => void h.place('Creep', { Position: { x: 0, y: 0 } });
  const hurtCreep = (h: Harness): void => {
    setField(h.world, h.place('Creep', { Position: { x: 0, y: 0 } }), 'Health', 'hp', 10);
  };
  const heroAt = (x: number) => (h: Harness): void => {
    h.place('Hero', { Position: { x, y: 0 } });
    creep(h);
  };

  const CASES: Record<(typeof NPC_CONDITIONS)[number], ConditionCase> = {
    healthBelow: {
      fires: { when: { kind: 'healthBelow', value: ONE / 2 }, place: hurtCreep },
      holds: { when: { kind: 'healthBelow', value: ONE / 2 }, place: creep },
    },
    healthAbove: {
      // Полное здоровье — доля единица, строго выше половины; раненый порог не
      // берёт. Пара зеркальна `healthBelow`: у документа есть обе стороны.
      fires: { when: { kind: 'healthAbove', value: ONE / 2 }, place: creep },
      holds: { when: { kind: 'healthAbove', value: ONE / 2 }, place: hurtCreep },
    },
    elapsed: {
      fires: { when: { kind: 'elapsed', ticks: 1 }, place: creep },
      // Порог, до которого проба не доживает: таймер идёт, но не набран.
      holds: { when: { kind: 'elapsed', ticks: 100 }, place: creep },
    },
    event: {
      // Сигнал публикует система РАНЬШЕ поведения (EVT-2) и не на первом тике:
      // на тике входа фаза только выбирается.
      fires: {
        when: { kind: 'event', event: 'Phase' },
        place: creep,
        during: (h, i) => {
          if (i === 1) h.signal('Phase', {});
        },
      },
      holds: { when: { kind: 'event', event: 'Phase' }, place: creep },
    },
    targetWithin: {
      fires: { when: { kind: 'targetWithin', value: F(5) }, place: heroAt(F(2)) },
      holds: { when: { kind: 'targetWithin', value: F(5) }, place: heroAt(F(10)) },
    },
    targetBeyond: {
      fires: { when: { kind: 'targetBeyond', value: F(5) }, place: heroAt(F(10)) },
      // Цели нет вовсе — «дальше порога» не истинно: условие о ЦЕЛИ, а её
      // отсутствие называет `noTarget`.
      holds: { when: { kind: 'targetBeyond', value: F(5) }, place: creep },
    },
    hasTarget: {
      fires: { when: { kind: 'hasTarget' }, place: heroAt(F(3)) },
      holds: { when: { kind: 'hasTarget' }, place: creep },
    },
    noTarget: {
      fires: { when: { kind: 'noTarget' }, place: creep },
      holds: { when: { kind: 'noTarget' }, place: heroAt(F(3)) },
    },
    routeDone: {
      // Точек маршрута на арене нет — обход пройден.
      fires: { when: { kind: 'routeDone' }, place: creep },
      holds: {
        when: { kind: 'routeDone' },
        place: (h) => {
          h.place('Point', { Position: { x: F(5), y: 0 }, Waypoint: { route: 0, index: 0 } });
          h.place('Creep', { Position: { x: 0, y: 0 }, NpcRoute: { route: 0, index: 0 } });
        },
      },
    },
  };

  for (const kind of NPC_CONDITIONS) {
    const { fires, holds } = CASES[kind];
    it(`«${kind}»: истинное условие переводит фазу, ложное — держит`, () => {
      expect(probeCast(conditionProbe(fires.when), fires)).toContain('Hit');
      const held = probeCast(conditionProbe(holds.when), holds);
      expect(held).toContain('Probe');
      expect(held).not.toContain('Hit');
    });
  }

  it('«routeDone»: агент без компонента маршрута отвечает «пройден», а не молчит', () => {
    // Ветка отдельным тестом: у пробы выше маршрут есть всегда, а документ
    // вправе повесить `routeDone` на поведение, которому маршрут не выдают —
    // и ответ там «обход кончился», а не «не знаю».
    const events = probeCast(conditionProbe({ kind: 'routeDone' }), {
      place: (h) => {
        h.place('Point', { Position: { x: F(5), y: 0 }, Waypoint: { route: 0, index: 0 } });
        h.place('Loose', { Position: { x: 0, y: 0 } });
      },
    });
    expect(events).toContain('Hit');
  });
});

describe('NPC-3: каждый вход закрытого словаря вычисляется', () => {
  /** Мир пробы вместе с кривой отклика, на которой смотрят вход. */
  interface Weighing extends Probe {
    /** Кривая отклика; по умолчанию прямая `y = x`. */
    readonly curve?: Record<string, unknown>;
  }

  /** Разбор одного имени словаря: где вход даёт вес и где — ноль. */
  interface InputCase {
    /** Мир, где вход даёт ненулевую полезность: действие выбирается. */
    readonly weighs: Weighing | null;
    /** Мир, где вход даёт ноль: действие не выбирается вовсе (NPC-3). */
    readonly zero: Weighing | null;
  }

  const creep = (h: Harness): void => void h.place('Creep', { Position: { x: 0, y: 0 } });

  const CASES: Record<(typeof NPC_INPUTS)[number], InputCase> = {
    // Ось-константа: нулём не бывает по определению — на то она и «всегда».
    always: { weighs: { curve: { type: 'constant', value: ONE }, place: creep }, zero: null },
    targetKnown: {
      weighs: {
        place: (h) => {
          h.place('Hero', { Position: { x: F(3), y: 0 } });
          creep(h);
        },
      },
      zero: { place: creep },
    },
    targetDistance: {
      // Цель у дальнего края чувства — доля пути к нему почти единица.
      weighs: {
        place: (h) => {
          h.place('Hero', { Position: { x: F(19), y: 0 } });
          creep(h);
        },
      },
      // Цель в той же точке — расстояние ноль, и вес нулевой.
      zero: {
        place: (h) => {
          h.place('Hero', { Position: { x: 0, y: 0 } });
          creep(h);
        },
      },
    },
    healthFraction: {
      weighs: { place: creep },
      zero: {
        place: (h) => {
          setField(h.world, h.place('Creep', { Position: { x: 0, y: 0 } }), 'Health', 'hp', 0);
        },
      },
    },
    crowding: {
      weighs: {
        place: (h) => {
          creep(h);
          h.place('Creep', { Position: { x: F(1), y: 0 } });
        },
      },
      // Сосед один — сам агент; шкала расхождения его не считает.
      zero: { place: creep },
    },
    stateElapsed: {
      // Ненулевым вход становится со ВТОРОГО тика в состоянии; на тике входа он
      // ровно ноль (проверено выше по файлу), и это единственный его нуль.
      weighs: { place: creep },
      zero: { place: creep, ticks: 1 },
    },
    routeRemaining: {
      weighs: {
        place: (h) => {
          h.place('Point', { Position: { x: F(5), y: 0 }, Waypoint: { route: 0, index: 0 } });
          h.place('Creep', { Position: { x: 0, y: 0 }, NpcRoute: { route: 0, index: 0 } });
        },
      },
      zero: { place: creep },
    },
    abilityReady: {
      // Слот свободен и кулдаун выстоял — каст стартовал бы (ABIL-7), и вход
      // даёт единицу.
      weighs: { place: slotted(), scene: ABILITY_SCENE },
      // Кулдаун не выстоял: заявку гейт триггера всё равно уронил бы, и ось её
      // не подаёт (NPC-7).
      zero: { place: slotted({ cooldown: 30 }), scene: ABILITY_SCENE },
    },
  };

  for (const input of NPC_INPUTS) {
    const { weighs, zero } = CASES[input];
    it(`«${input}»: ненулевой вес выбирает действие, нулевой — не выбирает`, () => {
      if (weighs !== null) {
        expect(probeCast(inputProbe(input, weighs.curve), weighs)).toContain('Weighed');
      }
      if (zero !== null) {
        expect(probeCast(inputProbe(input, zero.curve), zero)).not.toContain('Weighed');
      }
    });
  }

  it('«targetDistance»: цели нет — «дальше некуда», а не подмена расстояния нулём', () => {
    // Отсутствие цели говорит вход `targetKnown`; расстояние в этом положении
    // мира обязано быть максимальным, иначе документ, сближающийся по нему, на
    // пустой арене замирал бы вместо поиска.
    const alone = probeCast(inputProbe('targetDistance'), {
      place: (h) => void h.place('Creep', { Position: { x: 0, y: 0 } }),
    });
    expect(alone).toContain('Weighed');
  });

  it('«abilityReady»: идущий каст того же слота выключает ось', () => {
    // Вторая половина гейта (ABIL-7): слот в фазе не стартует, сколько бы ни
    // выстоял кулдаун, — и вход отвечает тем же нулём, что при откате.
    const busy = probeCast(inputProbe('abilityReady'), {
      place: slotted({ phase: 0 }),
      scene: ABILITY_SCENE,
    });
    expect(busy).not.toContain('Weighed');
  });

  it('«abilityReady»: неположительный остаток кулдауна — та же готовность, что у гейта', () => {
    // Гейт триггера держит старт ПОЛОЖИТЕЛЬНЫМ остатком (ABIL-7), а поле
    // остатка — обычный i32, в который пишет и контент. Вход обязан отвечать
    // ровно то же: иначе документ считал бы неготовым слот, каст которого
    // машина способностей стартовала бы, — то самое расхождение двух прочтений
    // одного гейта, которого NPC-7 не допускает.
    const spent = probeCast(inputProbe('abilityReady'), {
      place: slotted({ cooldown: -5 }),
      scene: ABILITY_SCENE,
    });
    expect(spent).toContain('Weighed');
  });

  it('«abilityReady»: чужой слот и слот с другим индексом читаются нулём', () => {
    // NPC-7: «Слот, которого у агента нет, SHALL читаться нулём» — и исход не
    // зависит от раскладки слотов ДРУГИХ агентов: готовый слот постороннего
    // ось агента не включает.
    const foreign = probeCast(inputProbe('abilityReady'), {
      place: slotted({ foreign: true }),
      scene: ABILITY_SCENE,
    });
    expect(foreign).not.toContain('Weighed');

    const other = probeCast(inputProbe('abilityReady'), {
      place: slotted({ slotIndex: PROBE_SLOT + 1 }),
      scene: ABILITY_SCENE,
    });
    expect(other).not.toContain('Weighed');
  });

  it('«abilityReady»: сцена без способностей отвечает нулём, а не падает', () => {
    // Документ вправе назвать вход в сцене, где платформы способностей нет
    // вовсе (SER-7): компонента слота у мира нет, и готового слота — тоже.
    const bare = probeCast(inputProbe('abilityReady'), {
      place: (h) => void h.place('Creep', { Position: { x: 0, y: 0 } }),
    });
    expect(bare).not.toContain('Weighed');
  });

  it('«healthFraction»: убывающая кривая делает раненого агента активнее целого', () => {
    // Кривая с отрицательным наклоном — штатный способ записать убывание
    // (NPC-3); ею документ выражает «чем хуже дела, тем нужнее действие».
    const falling = { type: 'linear', slope: -ONE, intercept: ONE };
    const hurt = probeCast(inputProbe('healthFraction', falling), {
      place: (h) => {
        setField(h.world, h.place('Creep', { Position: { x: 0, y: 0 } }), 'Health', 'hp', 10);
      },
    });
    const whole = probeCast(inputProbe('healthFraction', falling), {
      place: (h) => void h.place('Creep', { Position: { x: 0, y: 0 } }),
    });
    expect(hurt).toContain('Weighed');
    // Целое здоровье на убывающей кривой — ровно ноль: действие не выбирается.
    expect(whole).not.toContain('Weighed');
  });
});
