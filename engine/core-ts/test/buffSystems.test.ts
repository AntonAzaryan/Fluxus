/**
 * Рантайм баффов (BUFF-1..BUFF-7) на настоящем стенде из `loadScene` и `tick`:
 * наложение, стакинг, статовые правки, периодика, реакции, истечение, снятие и
 * рассеивание идущего каста.
 *
 * Баффы накладываются обычным `spawnEntity` (BUFF-1) — отдельного канала
 * «применить бафф» платформа не заводит, и тесты пользуются ровно тем же
 * действием, что и контент.
 */
import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { destroy, getField, hasComponent, setField, spawn } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { InputSystem } from '../src/systems/inputSystem.js';
import {
  ABILITY_SLOT_COMPONENT,
  BUFF_INSTANCE_COMPONENT,
  NO_PHASE,
} from '../src/systems/abilities/components.js';
import { INTERRUPT_DISPEL } from '../src/systems/abilities/interrupt.js';
import { BUFF_NEGATIVE, BUFF_POSITIVE, type AbilityDef, type BuffDef } from '../src/systems/abilities/model.js';
import { RingHistory } from '../src/sim/history.js';
import { createInputLog, createRewindController } from '../src/sim/rewind.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import type { SystemDef } from '../src/dsl/evaluatedSystem.js';
import {
  FIXED_ONE,
  type EntityId,
  type GameEvent,
  type InputFrame,
  type SimulationState,
} from '../src/types.js';

const F = fixed.fromFloat;

/** Бит каста — политика контента (INP-4). */
const CAST = 1 << 0;

const COMPONENTS: SceneDef['components'] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  {
    name: 'Input',
    fields: {
      aimDir: 'fixed',
      buttons: 'i32',
      moveX: 'fixed',
      moveY: 'fixed',
      prevButtons: 'i32',
      seq: 'i32',
      targetX: 'fixed',
      targetY: 'fixed',
    },
  },
  { name: 'Player', fields: { slot: 'i32' } },
  { name: 'Health', fields: { hp: 'fixed' } },
  { name: 'Marked', fields: { flag: 'i32' } },
];

const PREFABS: NonNullable<SceneDef['prefabs']> = [
  {
    name: 'Hero',
    components: { Position: { x: 0, y: 0 }, Input: {}, Player: { slot: 0 }, Health: { hp: F(10) }, TimeScale: {}, TimeScaleModifiers: {} },
  },
  { name: 'Foe', components: { Position: { x: F(3), y: 0 }, Health: { hp: F(10) } } },
  // Носитель баффов, которого не жалко удалить: игроком он не является, и
  // `InputSystem` его исчезновения не замечает (TICK-5).
  { name: 'Dummy', components: { Position: { x: F(1), y: 0 }, TimeScale: {}, TimeScaleModifiers: {} } },
  { name: 'Buff', components: { BuffInstance: {} } },
];

/** Prefab слота живёт отдельно: компонент платформы способностей есть не у всякой сцены. */
const SLOT_PREFAB: NonNullable<SceneDef['prefabs']>[number] = {
  name: 'Slot',
  components: { AbilitySlot: {}, AbilityCooldown: { remaining: 0, total: 0 } },
};

function scene(buffs: readonly BuffDef[], extra: Partial<SceneDef> = {}): SceneDef {
  return { components: COMPONENTS, prefabs: PREFABS, timeScale: true, buffs, ...extra };
}

interface Harness {
  readonly world: ReturnType<typeof loadScene>['world'];
  readonly sim: Simulation;
  readonly state: SimulationState;
  step(buttons?: number): readonly GameEvent[];
  place(prefab: string, overrides?: Record<string, Record<string, number>>): EntityId;
  give(target: EntityId, buffId?: number, source?: EntityId): EntityId;
  field(instance: EntityId, name: string): number;
  instances(): readonly EntityId[];
}

function harness(def: SceneDef): Harness {
  const loaded = loadScene(def);
  const { world, systems } = loaded;
  systems.register(new InputSystem({ players: ['p1'] }));
  const sim: Simulation = {
    systems,
    worldSeed: 1,
    math: mathApi,
    modifiers: loaded.modifiers,
    ...(loaded.abilities !== undefined ? { abilities: loaded.abilities } : {}),
  };
  const state = initialState(world, 1);
  let seq = 0;

  return {
    world,
    sim,
    state,
    step: (buttons = 0) => {
      seq += 1;
      const frame: InputFrame = {
        tick: state.tick + 1,
        playerId: 'p1',
        seq,
        move: { x: 0, y: 0 },
        aimDir: 0,
        buttons,
      };
      return [...tick(sim, state, [frame]).events];
    },
    place: (prefab, overrides) => spawn(world, prefab, overrides),
    give: (target, buffId = 0, source = -1) =>
      spawn(world, 'Buff', { BuffInstance: { target, source, buffId } }),
    field: (instance, name) => getField(world, instance, BUFF_INSTANCE_COMPONENT, name),
    instances: () => [...query(world, { all: [BUFF_INSTANCE_COMPONENT] })],
  };
}

function eventsOfType(events: readonly GameEvent[], type: string): readonly GameEvent[] {
  return events.filter((event) => event.type === type);
}

const TIME_SCALE = (entity: EntityId, world: Harness['world']): number =>
  getField(world, entity, 'TimeScale', 'value');

// ------------------------------------------------------------- наложение

describe('Наложение инстанса (BUFF-1, BUFF-2)', () => {
  const slow: BuffDef = {
    id: 'slow',
    class: 'negative',
    durationTicks: 3,
    statMods: [{ component: 'TimeScaleModifiers', value: F(0.5) }],
  };

  it('спавн инстанса — единственный канал выдачи: класс и остаток берутся из определения', () => {
    const h = harness(scene([slow]));
    const hero = h.place('Hero');
    const instance = h.give(hero);
    // До первого тика в мире лежит ровно то, что положил контент.
    expect(h.field(instance, 'class')).toBe(0);
    h.step();
    expect(h.field(instance, 'class')).toBe(BUFF_NEGATIVE);
    expect(h.field(instance, 'remaining')).toBe(3);
    expect(h.field(instance, 'stacks')).toBe(1);
    expect(h.field(instance, 'periodicTicks')).toBe(0);
  });

  it('на тике наложения остаток не убывает — счётчики идут от него (BUFF-5)', () => {
    const h = harness(scene([slow]));
    const hero = h.place('Hero');
    const instance = h.give(hero);
    h.step();
    expect(h.field(instance, 'remaining')).toBe(3);
    h.step();
    expect(h.field(instance, 'remaining')).toBe(2);
    expect(h.field(instance, 'periodicTicks')).toBe(1);
  });

  it('постоянный бафф не истекает сам (BUFF-2, BUFF-6)', () => {
    const passive: BuffDef = { id: 'passive', class: 'positive' };
    const h = harness(scene([passive]));
    const hero = h.place('Hero');
    const instance = h.give(hero);
    for (let i = 0; i < 20; i++) h.step();
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(true);
    expect(h.field(instance, 'class')).toBe(BUFF_POSITIVE);
    expect(h.field(instance, 'remaining')).toBe(0);
  });

  it('контент отбирает баффы обычным запросом по полям (BUFF-1)', () => {
    const positive: BuffDef = { id: 'haste', class: 'positive' };
    const h = harness(scene([slow, positive]));
    const hero = h.place('Hero');
    h.give(hero, 0);
    h.give(hero, 1);
    h.step();
    const classes = h.instances().map((instance) => h.field(instance, 'class'));
    expect(classes.filter((value) => value === BUFF_NEGATIVE)).toHaveLength(1);
    expect(classes.filter((value) => value === BUFF_POSITIVE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- стакинг

describe('Политики стакинга (BUFF-3)', () => {
  const base: BuffDef = { id: 'x', class: 'negative', durationTicks: 5 };

  it('`refresh`: повторное наложение продлевает действующий, второй сущности не появляется', () => {
    const h = harness(scene([{ ...base, stacking: 'refresh' }]));
    const hero = h.place('Hero');
    const first = h.give(hero);
    h.step();
    h.step();
    expect(h.field(first, 'remaining')).toBe(4);
    h.give(hero);
    h.step();
    expect(h.instances()).toEqual([first]);
    // Продление задаёт длительность НОВОГО наложения, а убывание тика идёт от неё.
    expect(h.field(first, 'remaining')).toBe(4);
    expect(h.field(first, 'stacks')).toBe(1);
  });

  it('`stack`: стаки растут до потолка, длительность продлевается', () => {
    const h = harness(scene([{ ...base, stacking: 'stack', maxStacks: 3 }]));
    const hero = h.place('Hero');
    const first = h.give(hero);
    h.step();
    for (let i = 0; i < 5; i++) {
      h.give(hero);
      h.step();
    }
    expect(h.instances()).toEqual([first]);
    expect(h.field(first, 'stacks')).toBe(3);
  });

  it('`independent`: два источника — два инстанса со своими остатками', () => {
    const h = harness(scene([{ ...base, stacking: 'independent', durationTicks: 3 }]));
    const hero = h.place('Hero');
    const first = h.give(hero);
    h.step();
    const second = h.give(hero);
    h.step();
    expect(h.instances()).toEqual([first, second]);
    expect(h.field(first, 'remaining')).toBe(2);
    expect(h.field(second, 'remaining')).toBe(3);
    // Погас один — второй продолжает действовать.
    h.step();
    h.step();
    expect(hasComponent(h.world, first, BUFF_INSTANCE_COMPONENT)).toBe(false);
    expect(hasComponent(h.world, second, BUFF_INSTANCE_COMPONENT)).toBe(true);
  });

  it('два наложения на одном тике сводятся в порядке идентификаторов сущностей', () => {
    const h = harness(scene([{ ...base, stacking: 'stack', maxStacks: 5 }]));
    const hero = h.place('Hero');
    const first = h.give(hero);
    const second = h.give(hero);
    h.step();
    // Первый по порядку обхода становится действующим, второй сводится в него.
    expect(h.instances()).toEqual([first]);
    expect(first).toBeLessThan(second);
    expect(h.field(first, 'stacks')).toBe(2);
  });

  it('стаки — данные для выражений определения, а не сложение платформы', () => {
    const stacking: BuffDef = {
      ...base,
      stacking: 'stack',
      maxStacks: 4,
      periodic: {
        everyTicks: 1,
        do: [{ emitEvent: { type: 'Tick', data: { n: { var: 'stacks' } } } }],
      },
    };
    const h = harness(scene([stacking]));
    const hero = h.place('Hero');
    h.give(hero);
    h.step();
    h.give(hero);
    const events = h.step();
    expect(eventsOfType(events, 'Tick')[0]!.data.n).toBe(2);
  });
});

// -------------------------------------------------------- статовые правки

describe('Статовые правки существующим механизмом слотов (BUFF-4)', () => {
  const half: BuffDef = {
    id: 'half',
    class: 'negative',
    durationTicks: 2,
    stacking: 'independent',
    statMods: [{ component: 'TimeScaleModifiers', value: F(0.5) }],
  };

  it('источник ставится при появлении и снимается при истечении', () => {
    const h = harness(scene([half]));
    const hero = h.place('Hero');
    const instance = h.give(hero);
    h.step();
    // `TimeScaleSystem` сводит список на −900, а бафф пишет в него на 820:
    // эффективный темп доезжает следующим тиком — та же задержка в тик, что и у
    // любого источника этого списка, и второй полосы сведения ради неё не
    // заводится.
    h.step();
    expect(TIME_SCALE(hero, h.world)).toBe(F(0.5));
    h.step();
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(false);
    // `TimeScaleSystem` сводит список на −900, поэтому снятое на 820 значение
    // доезжает до эффективного темпа следующим тиком — та же задержка в тик,
    // что и у любого источника этого списка.
    h.step();
    expect(TIME_SCALE(hero, h.world)).toBe(FIXED_ONE);
  });

  it('два инстанса — разные идентификаторы источника, произведение слотов', () => {
    const h = harness(scene([half]));
    const hero = h.place('Hero');
    const first = h.give(hero);
    const second = h.give(hero);
    h.step();
    const ids = [0, 1, 2, 3].map((slot) => getField(h.world, hero, 'TimeScaleModifiers', `id${slot}`));
    const occupied = ids.filter((id) => id !== 0);
    expect(occupied).toHaveLength(2);
    expect(new Set(occupied).size).toBe(2);
    expect(occupied).not.toContain(0);
    expect(first).not.toBe(second);
    h.step();
    // Произведение двух половин — четверть (TIME-7 сводит список произведением).
    expect(TIME_SCALE(hero, h.world)).toBe(F(0.25));
  });

  it('свободных слотов не осталось — громкая ошибка, а не вытеснение чужого источника', () => {
    const h = harness(scene([half], { modifierSlots: 2 }));
    const hero = h.place('Hero');
    for (let i = 0; i < 3; i++) h.give(hero);
    expect(() => h.step()).toThrow(/TimeScaleModifiers: все 2 слот/);
  });

  it('цель без списка источников — громкая ошибка, а не правка без эффекта', () => {
    const h = harness(scene([half]));
    h.place('Hero');
    const foe = h.place('Foe');
    h.give(foe);
    expect(() => h.step()).toThrow(/не несёт списка источников "TimeScaleModifiers"/);
  });
});

// ------------------------------------------------- периодика и реакции

describe('Периодика и реакции на события (BUFF-5)', () => {
  const dot: BuffDef = {
    id: 'dot',
    class: 'negative',
    durationTicks: 10,
    periodic: {
      everyTicks: 3,
      do: [{ emitEvent: { type: 'Damage', data: { target: { var: 'target' } } } }],
    },
  };

  it('DoT существует без единого нового механизма: срабатывания по периоду от наложения', () => {
    const h = harness(scene([dot]));
    const hero = h.place('Hero');
    h.give(hero);
    const fired: number[] = [];
    for (let i = 1; i <= 10; i++) {
      if (eventsOfType(h.step(), 'Damage').length > 0) fired.push(i);
    }
    // Тик 1 — наложение, счётчик стартует с него: срабатывания на 4, 7 и 10.
    expect(fired).toEqual([4, 7, 10]);
  });

  it('реакция на событие исполняется на тике события и читает его поля', () => {
    const proc: BuffDef = {
      id: 'proc',
      class: 'positive',
      triggers: [
        {
          type: 'Collision',
          as: 'hit',
          do: [{ emitEvent: { type: 'Proc', data: { nx: { eventField: [{ var: 'hit' }, 'nx'] } } } }],
        },
      ],
    };
    const collider: SystemDef = {
      name: 'FakeCollision',
      order: 200,
      do: [{ emitEvent: { type: 'Collision', data: { nx: FIXED_ONE } } }],
    };
    const h = harness(scene([proc], { systems: [collider] }));
    const hero = h.place('Hero');
    h.give(hero);
    h.step();
    const events = h.step();
    expect(eventsOfType(events, 'Proc')).toHaveLength(1);
    expect(eventsOfType(events, 'Proc')[0]!.data.nx).toBe(FIXED_ONE);
  });

  it('порядок исполнения между инстансами — порядок обхода запроса (QUERY-2)', () => {
    const marker: BuffDef = {
      id: 'marker',
      class: 'positive',
      stacking: 'independent',
      periodic: { everyTicks: 1, do: [{ emitEvent: { type: 'Tick', data: { self: { var: 'self' } } } }] },
    };
    const h = harness(scene([marker]));
    const hero = h.place('Hero');
    const first = h.give(hero);
    const second = h.give(hero);
    h.step();
    const order = eventsOfType(h.step(), 'Tick').map((event) => event.data.self);
    expect(order).toEqual([first, second]);
  });

  it('периодика переживает перемотку: счётчик приходит из снапшота', () => {
    const h = harness(scene([dot]));
    const hero = h.place('Hero');
    h.give(hero);
    const history = new RingHistory({ interval: 1, capacity: 16 });
    const inputs = createInputLog();
    history.record(h.state);

    const fired: number[] = [];
    const advance = (): void => {
      inputs.record(h.state.tick + 1, []);
      if (eventsOfType([...tick(h.sim, h.state).events], 'Damage').length > 0) {
        fired.push(h.state.tick);
      }
      history.record(h.state);
    };
    for (let i = 0; i < 8; i++) advance();
    expect(fired).toEqual([4, 7]);

    const wsm = createRewindController(h.sim, h.state, { history, inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(5);
    wsm.pause();
    wsm.resume();
    const replay: number[] = [];
    for (let i = 0; i < 3; i++) {
      inputs.record(h.state.tick + 1, []);
      if (eventsOfType([...tick(h.sim, h.state).events], 'Damage').length > 0) {
        replay.push(h.state.tick);
      }
    }
    // Следующее срабатывание случается на том же тике, что и на первом проходе.
    expect(replay).toEqual([7]);
  });
});

// ------------------------------------------- истечение, снятие, рассеивание

describe('Истечение, снятие и рассеивание (BUFF-6)', () => {
  const bleed: BuffDef = {
    id: 'bleed',
    class: 'negative',
    durationTicks: 2,
    stacking: 'independent',
    statMods: [{ component: 'TimeScaleModifiers', value: F(0.5) }],
    onExpire: [
      {
        emitEvent: {
          type: 'Gone',
          data: {
            self: { var: 'self' },
            reason: { getComponent: [{ var: 'self' }, 'BuffInstance', 'dispelled'] },
          },
        },
      },
    ],
  };

  it('остаток исчерпан — `onExpire`, снятие источников, удаление сущности', () => {
    const h = harness(scene([bleed]));
    const hero = h.place('Hero');
    const instance = h.give(hero);
    h.step();
    h.step();
    const gone = eventsOfType(h.step(), 'Gone');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.data.self).toBe(instance);
    expect(gone[0]!.data.reason).toBe(0);
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(false);
    expect(getField(h.world, hero, 'TimeScaleModifiers', 'id0')).toBe(0);
  });

  it('снятие выражается признаком, и разбирает его платформа тем же путём', () => {
    const h = harness(scene([bleed]));
    const hero = h.place('Hero');
    const instance = h.give(hero);
    h.step();
    setField(h.world, instance, BUFF_INSTANCE_COMPONENT, 'dispelled', 7);
    const gone = eventsOfType(h.step(), 'Gone');
    expect(gone).toHaveLength(1);
    // Причина снятия различима: «истёк сам» — ноль, «рассеян» — код контента.
    expect(gone[0]!.data.reason).toBe(7);
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(false);
    expect(getField(h.world, hero, 'TimeScaleModifiers', 'id0')).toBe(0);
  });

  it('рассеивание отрицательных — обычный запрос по классу плюс признак', () => {
    const dispel: SystemDef = {
      name: 'Dispel',
      order: 400,
      query: { all: ['BuffInstance'] },
      as: 'b',
      do: [
        {
          if: {
            cond: { '==': [{ getComponent: [{ var: 'b' }, 'BuffInstance', 'class'] }, BUFF_NEGATIVE] },
            then: [
              {
                modifyComponent: {
                  entity: { var: 'b' },
                  component: 'BuffInstance',
                  values: { dispelled: 1 },
                },
              },
            ],
          },
        },
      ],
    };
    const good: BuffDef = { id: 'good', class: 'positive', stacking: 'independent' };
    const h = harness(scene([bleed, good], { systems: [dispel] }));
    const hero = h.place('Hero');
    const bad = h.give(hero, 0);
    const nice = h.give(hero, 1);
    h.step();
    h.step();
    expect(hasComponent(h.world, bad, BUFF_INSTANCE_COMPONENT)).toBe(false);
    expect(hasComponent(h.world, nice, BUFF_INSTANCE_COMPONENT)).toBe(true);
  });

  it('цель исчезла — инстансы удаляются без `onExpire`', () => {
    const h = harness(scene([bleed]));
    h.place('Hero');
    const dummy = h.place('Dummy');
    const instance = h.give(dummy);
    h.step();
    destroy(h.world, dummy);
    const events = h.step();
    expect(eventsOfType(events, 'Gone')).toHaveLength(0);
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(false);
  });

  it('цель исчезла раньше наложения — инстанс убирается тем же правилом', () => {
    const h = harness(scene([bleed]));
    h.place('Hero');
    const dummy = h.place('Dummy');
    const instance = h.give(dummy);
    destroy(h.world, dummy);
    h.step();
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(false);
  });
});

// ------------------------------------------------- рассеивание каста (ABIL-6)

describe('Рассеивание идущего каста — источник прерывания `dispel` (BUFF-6, ABIL-6)', () => {
  const channel: AbilityDef = {
    id: 'channel',
    trigger: { input: { bit: 0 } },
    cooldownTicks: 6,
    phases: [
      {
        id: 'channel',
        trigger: 'auto',
        durationTicks: 20,
        // Каст выражается баффом на кастере: инстанс спавнится входом в фазу и
        // ссылается на сущность-слот источником.
        onEnter: [
          {
            spawnEntity: {
              prefab: 'Buff',
              overrides: {
                BuffInstance: { target: { var: 'owner' }, source: { var: 'self' }, buffId: 0 },
              },
            },
          },
        ],
        onCancel: [{ emitEvent: { type: 'Cancelled', data: { src: { var: 'lastInterrupt' } } } }],
      },
    ],
    effects: [{ emitEvent: { type: 'Done' } }],
  };
  const mark: BuffDef = { id: 'mark', class: 'negative', stacking: 'independent' };

  function stand(): Harness {
    return harness(
      scene([mark], {
        prefabs: [...PREFABS, SLOT_PREFAB],
        abilities: [channel],
        abilityRuntime: { teamField: ['Player', 'slot'] },
      }),
    );
  }

  it('снятие баффа-каста прерывает каст источником `dispel` на том же тике', () => {
    const h = stand();
    const hero = h.place('Hero');
    const slot = h.place('Slot', { AbilitySlot: { owner: hero, abilityId: 0, slotIndex: 0 } });
    h.step(CAST);
    expect(getField(h.world, slot, ABILITY_SLOT_COMPONENT, 'phase')).toBe(0);
    const instance = h.instances()[0]!;
    h.step(CAST);

    setField(h.world, instance, BUFF_INSTANCE_COMPONENT, 'dispelled', 1);
    const events = h.step(CAST);
    expect(eventsOfType(events, 'Cancelled')[0]?.data.src).toBe(INTERRUPT_DISPEL);
    expect(getField(h.world, slot, ABILITY_SLOT_COMPONENT, 'phase')).toBe(NO_PHASE);
    expect(eventsOfType(events, 'Done')).toHaveLength(0);
  });

  it('истечение того же баффа каста не трогает: рассеивание — не истечение', () => {
    const h = stand();
    const hero = h.place('Hero');
    const slot = h.place('Slot', { AbilitySlot: { owner: hero, abilityId: 0, slotIndex: 0 } });
    h.step(CAST);
    const instance = h.instances()[0]!;
    setField(h.world, instance, BUFF_INSTANCE_COMPONENT, 'remaining', 1);
    const events = h.step(CAST);
    expect(hasComponent(h.world, instance, BUFF_INSTANCE_COMPONENT)).toBe(false);
    expect(eventsOfType(events, 'Cancelled')).toHaveLength(0);
    expect(getField(h.world, slot, ABILITY_SLOT_COMPONENT, 'phase')).toBe(0);
  });

  it('бафф с источником-не-слотом снимается, никого не прерывая', () => {
    const h = stand();
    const hero = h.place('Hero');
    const slot = h.place('Slot', { AbilitySlot: { owner: hero, abilityId: 0, slotIndex: 0 } });
    h.step(CAST);
    const loose = h.give(hero, 0, hero);
    h.step(CAST);
    setField(h.world, loose, BUFF_INSTANCE_COMPONENT, 'dispelled', 1);
    const events = h.step(CAST);
    expect(eventsOfType(events, 'Cancelled')).toHaveLength(0);
    expect(getField(h.world, slot, ABILITY_SLOT_COMPONENT, 'phase')).toBe(0);
  });
});

// ------------------------------------------------- дисциплина аллокаций

describe('Дисциплина аллокаций платформы баффов (ABIL-10)', () => {
  it('сто инстансов — тик не порождает запросов пропорционально их числу', () => {
    const marker: BuffDef = { id: 'marker', class: 'positive', stacking: 'independent' };
    const counts: number[] = [];
    for (const total of [10, 100]) {
      const h = harness(scene([marker]));
      const hero = h.place('Hero');
      for (let i = 0; i < total; i++) h.give(hero);
      let queries = 0;
      const system = h.sim.systems.ordered().find((candidate) => candidate.name === 'Buff')!;
      const inner = system.run.bind(system);
      const probe = { ...system, run: (ctx: Parameters<typeof inner>[0]) => {
        inner({ ...ctx, query: (spec) => { queries += 1; return ctx.query(spec); } });
      } };
      h.sim.systems.override(probe);
      for (let i = 0; i < 5; i++) h.step();
      counts.push(queries);
    }
    expect(counts[0]).toBe(counts[1]);
    // Ровно один запрос на тик: оба прохода идут по одной выборке.
    expect(counts[1]).toBe(5);
  });
});
