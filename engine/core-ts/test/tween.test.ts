import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { execute, type Action } from '../src/dsl/actions.js';
import { getField, hasComponent, spawn } from '../src/ecs/world.js';
import { mathApi } from '../src/math/mathApi.js';
import { TIME_SCALE_SCHEMA } from '../src/systems/time.js';
import {
  TweenSystem,
  EASING_INSTANT,
  EASING_LINEAR,
  TWEEN_COMPONENT,
  TWEEN_SCHEMA,
  type TweenDef,
} from '../src/systems/tween.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { FIXED_ONE, type EntityId, type GameEvent, type System, type SystemContext } from '../src/types.js';

const F = fixed.fromFloat;
/** Четыре тика на секунду — чтобы промежуточные доли были точными в Q16.16. */
const GLOBAL_DELTA = F(0.25);

const SCENE: SceneDef = {
  components: [TWEEN_SCHEMA, TIME_SCALE_SCHEMA, { name: 'Health', fields: { value: 'fixed' } }],
  prefabs: [
    { name: 'Target', components: { Health: { value: 0 } } },
    // Замедленная вдвое цель: значение TimeScale уже сведено (TIME-7), система
    // сведения здесь не нужна.
    { name: 'Slowed', components: { Health: { value: 0 }, TimeScale: { value: F(0.5) } } },
  ],
};

/** Определения сцены: путь к полю и onComplete не помещаются в компонент (ECS-3). */
const DEFS: readonly TweenDef[] = [
  { target: 'Health.value' },
  {
    target: 'Health.value',
    onComplete: [{ emitEvent: { type: 'TweenDone', data: { who: { var: 'entity' } } } }],
  },
];

interface TweenArgs {
  readonly entity: EntityId;
  readonly def?: number;
  readonly from?: number;
  readonly to?: number;
  readonly duration?: number;
  readonly easing?: number;
  readonly ignoreTimeScale?: number;
}

function addTween(a: TweenArgs): Action {
  return {
    addTween: {
      entity: a.entity,
      def: a.def ?? 0,
      from: a.from ?? 0,
      to: a.to ?? F(100),
      duration: a.duration ?? FIXED_ONE,
      ...(a.easing === undefined ? {} : { easing: a.easing }),
      ...(a.ignoreTimeScale === undefined ? {} : { ignoreTimeScale: a.ignoreTimeScale }),
    },
  };
}

function harness(defs: readonly TweenDef[] = DEFS) {
  const { world, systems } = loadScene(SCENE);
  let script: (ctx: SystemContext) => void = () => {};
  const runner: System = { name: 'Script', order: -100, run: (ctx) => { script(ctx); } };
  systems.register(runner);
  systems.register(new TweenSystem(defs, { globalDelta: GLOBAL_DELTA }));

  const sim: Simulation = { systems, worldSeed: 1, math: mathApi };
  const state = initialState(world, 1);

  return {
    world,
    place: (prefab = 'Target') => spawn(world, prefab),
    /** Тик с телом скрипта; тело исполняется до TweenSystem и на следующем тике не повторяется. */
    step: (body: (ctx: SystemContext) => void = () => {}): readonly GameEvent[] => {
      script = body;
      const events = [...tick(sim, state).events];
      script = () => {};
      return events;
    },
    health: (entity: EntityId) => getField(world, entity, 'Health', 'value'),
    hasTween: (entity: EntityId) => hasComponent(world, entity, TWEEN_COMPONENT),
  };
}

describe('создание через addTween (TWEEN-5)', () => {
  it('компонент появляется только после flush, а не прямой мутацией', () => {
    const h = harness();
    const target = h.place();
    let visibleImmediately = true;

    h.step((ctx) => {
      execute([addTween({ entity: target })], ctx);
      visibleImmediately = h.hasTween(target);
    });

    expect(visibleImmediately).toBe(false);
    expect(h.hasTween(target)).toBe(true);
  });

  it('JSON-система проходит валидацию и заводит твин (SYS-3)', () => {
    const scene = loadScene({
      ...SCENE,
      systems: [
        {
          name: 'Heal',
          order: -100,
          query: { all: ['Health'] },
          do: [{ addTween: { entity: { var: 'entity' }, def: 0, from: 0, to: F(50), duration: FIXED_ONE } }],
        },
      ],
    });
    scene.systems.register(new TweenSystem(DEFS, { globalDelta: GLOBAL_DELTA }));
    const target = spawn(scene.world, 'Target');
    tick({ systems: scene.systems, worldSeed: 1, math: mathApi }, initialState(scene.world, 1));

    expect(hasComponent(scene.world, target, TWEEN_COMPONENT)).toBe(true);
  });
});

describe('продвижение твинов (TWEEN-3, TWEEN-6)', () => {
  it('linear пишет долю пути в поле из target', () => {
    const h = harness();
    const target = h.place();
    h.step((ctx) => { execute([addTween({ entity: target, easing: EASING_LINEAR })], ctx); });

    expect(h.health(target)).toBe(F(25));
    h.step();
    expect(h.health(target)).toBe(F(50));
    h.step();
    expect(h.health(target)).toBe(F(75));
  });

  it('на последнем шаге пишется ровно `to` и компонент снимается', () => {
    const h = harness();
    const target = h.place();
    h.step((ctx) => { execute([addTween({ entity: target })], ctx); });
    for (let i = 0; i < 3; i++) h.step();

    expect(h.health(target)).toBe(F(100));
    expect(h.hasTween(target)).toBe(false);
    // Твина больше нет — значение не ползёт дальше.
    h.step();
    expect(h.health(target)).toBe(F(100));
  });

  it('интерполяция идёт от from, а не от текущего значения поля', () => {
    const h = harness();
    const target = h.place();
    h.step((ctx) => { execute([addTween({ entity: target, from: F(100), to: F(0) })], ctx); });
    expect(h.health(target)).toBe(F(75));
  });
});

describe('easing (TWEEN-2)', () => {
  it('instant даёт скачок с первого тика, без твина нулевой длительности', () => {
    const h = harness();
    const target = h.place();
    h.step((ctx) => { execute([addTween({ entity: target, easing: EASING_INSTANT })], ctx); });

    expect(h.health(target)).toBe(F(100));
    expect(h.hasTween(target)).toBe(false);
  });

  it('нулевая длительность завершает твин сразу', () => {
    const h = harness();
    const target = h.place();
    h.step((ctx) => { execute([addTween({ entity: target, duration: 0 })], ctx); });
    expect(h.health(target)).toBe(F(100));
  });

  it('неизвестный easing — ошибка, а не молчаливый linear', () => {
    const h = harness();
    const target = h.place();
    expect(() => h.step((ctx) => { execute([addTween({ entity: target, easing: 42 })], ctx); })).toThrow(
      /неизвестный easing 42/,
    );
  });
});

describe('onComplete (TWEEN-4)', () => {
  it('исполняется по завершении и получает сущность', () => {
    const h = harness();
    const target = h.place();
    h.step((ctx) => { execute([addTween({ entity: target, def: 1, duration: GLOBAL_DELTA })], ctx); });

    // Первый же тик доводит elapsed до duration.
    const events = h.step();
    expect(events).toHaveLength(0);
    expect(h.hasTween(target)).toBe(false);
  });

  it('событие несёт сущность из onComplete', () => {
    const h = harness();
    const target = h.place();
    const events = h.step((ctx) =>
      { execute([addTween({ entity: target, def: 1, duration: GLOBAL_DELTA, easing: EASING_INSTANT })], ctx); },
    );
    expect(events).toEqual([{ type: 'TweenDone', data: { who: target } }]);
  });

  it('ошибка внутри onComplete называет систему, путь до узла и причину (SYS-9)', () => {
    // Тело onComplete — тот же Action DSL, что у системы из данных, и ошибка в
    // нём того же класса: без имени системы её пришлось бы искать по всем
    // определениям твинов сцены.
    const broken: readonly TweenDef[] = [
      {
        target: 'Health.value',
        // Ссылка на событие, которого в шине нет: ошибка вычисления класса 3.
        onComplete: [{ emitEvent: { type: 'Boom', data: { d: { eventField: [0, 'nope'] } } } }],
      },
    ];
    const h = harness(broken);
    const target = h.place();

    expect(() =>
      h.step((ctx) => { execute([addTween({ entity: target, duration: GLOBAL_DELTA, easing: EASING_INSTANT })], ctx); }),
    ).toThrow(/система "Tween", узел \[0\]\.emitEvent: нет события с индексом 0/);
  });
});

describe('учёт TimeScale per-tween (TWEEN-7)', () => {
  it('обычный твин на замедленной сущности идёт вдвое медленнее', () => {
    const h = harness();
    const slowed = h.place('Slowed');
    h.step((ctx) => { execute([addTween({ entity: slowed })], ctx); });
    expect(h.health(slowed)).toBe(F(12.5));
  });

  it('помеченный ignoreTimeScale идёт в обычном темпе', () => {
    const h = harness();
    const slowed = h.place('Slowed');
    h.step((ctx) => { execute([addTween({ entity: slowed, ignoreTimeScale: 1 })], ctx); });
    expect(h.health(slowed)).toBe(F(25));
  });
});

describe('таблица определений', () => {
  it('битый target падает на сборке, а не в середине матча', () => {
    expect(() => new TweenSystem([{ target: 'Health' }])).toThrow(/Компонент\.поле/);
    expect(() => new TweenSystem([{ target: 'Health.' }])).toThrow(/Компонент\.поле/);
  });

  it('индекс вне таблицы — ошибка с номером', () => {
    const h = harness();
    const target = h.place();
    expect(() => h.step((ctx) => { execute([addTween({ entity: target, def: 5 })], ctx); })).toThrow(
      /определение 5, в таблице их 2/,
    );
  });
});
