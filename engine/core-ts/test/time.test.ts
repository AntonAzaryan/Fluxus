import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { getField, hasComponent, spawn } from '../src/ecs/world.js';
import { mathApi } from '../src/math/mathApi.js';
import {
  TIME_SCALE_MAX,
  TIME_SCALE_MIN,
  TIME_SCALE_MODIFIERS_COMPONENT,
  TIME_SCALE_SCHEMA,
} from '../src/systems/time.js';
import { requireModifierList } from '../src/systems/modifiers.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { FIXED_ONE, TIME_SCALE_COMPONENT, type EntityId, type System, type SystemContext } from '../src/types.js';

const F = fixed.fromFloat;
/** Шаг тика теста — круглая доля секунды, чтобы половина от него была точной. */
const GLOBAL_DELTA = F(0.25);

const SCENE: SceneDef = {
  components: [{ name: 'Probe', fields: { delta: 'fixed' } }],
  // Компоненты и `TimeScaleSystem` подключает сама сцена (SER-7).
  timeScale: true,
  prefabs: [
    {
      name: 'Slowable',
      components: { TimeScaleModifiers: {}, Probe: { delta: 0 } },
    },
    // Сущность без списка источников и без TimeScale — контрольная для TIME-3.
    { name: 'Plain', components: { Probe: { delta: 0 } } },
  ],
};

/** Система-скрипт: тело подменяется в тесте, порядок задаётся конструктором. */
class Script implements System {
  constructor(
    readonly name: string,
    readonly order: number,
    private readonly body: () => (ctx: SystemContext) => void,
  ) {}

  run(ctx: SystemContext): void {
    this.body()(ctx);
  }
}

/** Потребитель времени, опт-инувшийся в TimeScale (TIME-4): пишет свой effective delta. */
const PROBE: System = {
  name: 'Probe',
  order: 0,
  run(ctx) {
    for (const entity of ctx.query({ all: ['Probe'] })) {
      ctx.commands.setField(entity, 'Probe', 'delta', ctx.getEffectiveDelta(entity, GLOBAL_DELTA));
    }
  },
};

function harness(scene: SceneDef = SCENE) {
  const { world, systems, modifiers } = loadScene(scene);
  const mods = requireModifierList(modifiers, TIME_SCALE_MODIFIERS_COMPONENT);
  let script: (ctx: SystemContext) => void = () => {};
  // Скрипт идёт до TimeScaleSystem (order −900): его команды влиты на flush
  // предыдущей системы (CMD-2), поэтому источник действует с того же тика.
  systems.register(new Script('Script', -950, () => script));
  systems.register(PROBE);

  const sim: Simulation = { systems, worldSeed: 1, math: mathApi, modifiers };
  const state = initialState(world, 1);

  return {
    world,
    state,
    sim,
    mods,
    place: (prefab: string) => spawn(world, prefab),
    step: (body: (ctx: SystemContext) => void = () => {}) => {
      script = body;
      const result = tick(sim, state);
      script = () => {};
      return result;
    },
    scaleOf: (entity: EntityId) => getField(world, entity, TIME_SCALE_COMPONENT, 'value'),
    deltaOf: (entity: EntityId) => getField(world, entity, 'Probe', 'delta'),
  };
}

describe('компонент TimeScale (TIME-2, TIME-3)', () => {
  it('по умолчанию единица — без источников темп обычный', () => {
    expect(TIME_SCALE_SCHEMA.defaults?.value).toBe(FIXED_ONE);
  });

  it('сущность без компонента получает globalDelta без изменений', () => {
    const h = harness();
    const plain = h.place('Plain');
    h.step();
    expect(h.deltaOf(plain)).toBe(GLOBAL_DELTA);
    expect(hasComponent(h.world, plain, TIME_SCALE_COMPONENT)).toBe(false);
  });

  it('источник 0.5 — половина шага за тик', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => { h.mods.add(ctx, entity, 1, F(0.5)); });
    expect(h.scaleOf(entity)).toBe(F(0.5));
    expect(h.deltaOf(entity)).toBe(F(0.125));
  });
});

describe('стакинг источников (TIME-7)', () => {
  // Источники ставятся разными тиками: `modifierList.add` ищет свободный слот в
  // живом мире, а команды одной системы вливаются только на её flush (CMD-5),
  // поэтому два add подряд внутри одной системы делят один слот.
  it('два независимых замедления перемножаются', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => { h.mods.add(ctx, entity, 1, F(0.5)); });
    h.step((ctx) => { h.mods.add(ctx, entity, 2, F(0.5)); });
    expect(h.scaleOf(entity)).toBe(F(0.25));
  });

  it('околонулевое произведение клампится снизу, а не делит на ~0', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => { h.mods.add(ctx, entity, 1, F(0.001)); });
    expect(h.scaleOf(entity)).toBe(TIME_SCALE_MIN);
  });

  it('ускорение клампится сверху', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => { h.mods.add(ctx, entity, 1, fixed.fromInt(3)); });
    h.step((ctx) => { h.mods.add(ctx, entity, 2, fixed.fromInt(3)); });
    expect(h.scaleOf(entity)).toBe(TIME_SCALE_MAX);
  });

  it('нейтральное произведение компонента не заводит', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step();
    expect(hasComponent(h.world, entity, TIME_SCALE_COMPONENT)).toBe(false);
    expect(h.deltaOf(entity)).toBe(GLOBAL_DELTA);
  });
});

describe('распределение слотов (TIME-7, TIME-8)', () => {
  it('два источника в одном тике занимают разные слоты, а не делят один', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => {
      h.mods.add(ctx, entity, 1, F(0.5));
      h.mods.add(ctx, entity, 2, F(0.5));
    });
    expect(h.scaleOf(entity)).toBe(F(0.25));
    expect(getField(h.world, entity, 'TimeScaleModifiers', 'id0')).toBe(1);
    expect(getField(h.world, entity, 'TimeScaleModifiers', 'id1')).toBe(2);
  });

  it('переполнение слотов — ошибка, а не вытеснение', () => {
    const h = harness();
    const entity = h.place('Slowable');
    expect(() =>
      h.step((ctx) => {
        for (let id = 1; id <= h.mods.slots + 1; id++) h.mods.add(ctx, entity, id, F(0.9));
      }),
    ).toThrow(/все 4 слот/);
  });

  it('нулевой id источника запрещён', () => {
    const h = harness();
    const entity = h.place('Slowable');
    expect(() => h.step((ctx) => { h.mods.add(ctx, entity, 0, F(0.5)); })).toThrow(/не может быть нулём/);
  });

  it('имена слотов выравниваются нулями при числе слотов больше десяти (SER-6)', () => {
    const h = harness({ ...SCENE, modifierSlots: 12 });
    expect(Object.keys(h.mods.schema.fields).sort()).toContain('id00');
    expect(Object.keys(h.mods.schema.fields).sort()).toContain('id11');
    expect(Object.keys(h.mods.schema.fields)).not.toContain('id0');
  });

  it('две сцены в одном процессе не влияют друг на друга (DI-1)', () => {
    const first = harness();
    const second = harness();
    const a = first.place('Slowable');
    const b = second.place('Slowable');

    // Первая сцена занимает слот 0 своей сущности; вторая обязана начать с него же.
    first.step((ctx) => { first.mods.add(ctx, a, 1, F(0.5)); });
    second.step((ctx) => { second.mods.add(ctx, b, 2, F(0.25)); });

    expect(getField(first.world, a, 'TimeScaleModifiers', 'id0')).toBe(1);
    expect(getField(second.world, b, 'TimeScaleModifiers', 'id0')).toBe(2);
    expect(getField(second.world, b, 'TimeScaleModifiers', 'id1')).toBe(0);
  });

  it('повторный проход по тому же тику даёт то же состояние (REW-7)', () => {
    const h = harness();
    const entity = h.place('Slowable');
    const before = takeSnapshot(h.state);

    const twice = (ctx: SystemContext): void => {
      h.mods.add(ctx, entity, 1, F(0.5));
      h.mods.add(ctx, entity, 2, F(0.5));
    };
    h.step(twice);
    const first = [0, 1].map((i) => getField(h.world, entity, 'TimeScaleModifiers', `id${i}`));

    // Тот же номер тика второй раз: остатка прошлого прохода быть не должно.
    restoreSnapshot(h.state, before);
    h.step(twice);
    expect([0, 1].map((i) => getField(h.world, entity, 'TimeScaleModifiers', `id${i}`))).toEqual(first);
    expect(h.scaleOf(entity)).toBe(F(0.25));
  });
});

describe('управление источниками из систем (TIME-8)', () => {
  it('снятие источника возвращает обычный темп', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => { h.mods.add(ctx, entity, 7, F(0.5)); });
    expect(h.scaleOf(entity)).toBe(F(0.5));

    h.step((ctx) => { h.mods.remove(ctx, entity, 7); });
    expect(h.scaleOf(entity)).toBe(FIXED_ONE);
    expect(h.deltaOf(entity)).toBe(GLOBAL_DELTA);
  });

  it('неизменившееся значение не пишется — сущность не становится dirty', () => {
    const h = harness();
    const entity = h.place('Slowable');
    h.step((ctx) => { h.mods.add(ctx, entity, 1, F(0.5)); });
    expect(h.step().changes.changedEntities(TIME_SCALE_COMPONENT).has(entity)).toBe(false);
    expect(h.scaleOf(entity)).toBe(F(0.5));
  });
});
