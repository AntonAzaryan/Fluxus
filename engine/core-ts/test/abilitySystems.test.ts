/**
 * Рантайм платформы способностей (ABIL-3..ABIL-9): фазы, прицеливание,
 * прерывания, кулдауны и доставка — на настоящем стенде из `loadScene`,
 * `InputSystem` и `tick`.
 *
 * Ввод подаётся обычными `InputFrame` через `InputSystem` (TICK-4), а точка
 * прицела кадра — сценовым скриптом на свободном `order` между вводом и
 * прицеливанием: поля точки в компоненте ввода появятся вместе с полем `target`
 * кадра (TICK-2, фаза протокола ввода), а платформа читает их уже сейчас.
 */
import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { addComponent, destroy, getField, hasComponent, removeComponent, setField, spawn } from '../src/ecs/world.js';
import { InputSystem } from '../src/systems/inputSystem.js';
import { CastPhaseSystem } from '../src/systems/abilities/phase.js';
import { TargetingCommitSystem } from '../src/systems/abilities/targeting.js';
import {
  ABILITY_COOLDOWN_COMPONENT,
  ABILITY_DURATION_COMPONENT,
  ABILITY_PROJECTILE_COMPONENT,
  ABILITY_SLOT_COMPONENT,
  NO_PHASE,
} from '../src/systems/abilities/components.js';
import {
  INTERRUPT_CANCEL_INPUT,
  INTERRUPT_DAMAGED,
  INTERRUPT_DEATH,
  INTERRUPT_DISABLE,
  INTERRUPT_DISPLACEMENT,
  INTERRUPT_RELEASE,
  INTERRUPT_SUPERSEDE,
  INTERRUPT_TARGET_LOST,
  INTERRUPT_TIMEOUT,
} from '../src/systems/abilities/interrupt.js';
import type { AbilityDef, BuffDef } from '../src/systems/abilities/model.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { FIXED_ONE, type EntityId, type GameEvent, type InputFrame, type System, type SystemContext } from '../src/types.js';

const F = fixed.fromFloat;

/** Биты сцены — политика контента (INP-4): каст 0, подтверждение 1, отмена 2. */
const CAST = 1 << 0;
const CONFIRM = 1 << 1;
const CANCEL = 1 << 2;

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
  { name: 'Dead', fields: { at: 'i32' } },
  { name: 'ActionLock', fields: { mask: 'i32' } },
  { name: 'Enemy', fields: { flag: 'i32' } },
  { name: 'Pushed', fields: { flag: 'i32' } },
  { name: 'Payload', fields: { ticks: 'i32' } },
];

const PREFABS: NonNullable<SceneDef['prefabs']> = [
  { name: 'Hero', components: { Position: { x: 0, y: 0 }, Input: {}, Player: { slot: 0 } } },
  { name: 'Foe', components: { Position: { x: F(3), y: 0 }, Enemy: { flag: 1 } } },
  { name: 'Slot', components: { AbilitySlot: {}, AbilityCooldown: { remaining: 0, total: 0 } } },
  { name: 'Ball', components: { Position: {}, AbilityProjectile: {}, Payload: { ticks: 0 } } },
  { name: 'Zone', components: { Position: {}, AbilityDuration: {} } },
];

const RUNTIME: NonNullable<SceneDef['abilityRuntime']> = {
  deadMarker: 'Dead',
  actionLock: 'ActionLock',
  teamField: ['Player', 'slot'],
  damageEvent: { type: 'Damage', entityField: 'target', amountField: 'amount' },
};

function scene(abilities: readonly AbilityDef[], extra: Partial<SceneDef> = {}): SceneDef {
  return {
    components: COMPONENTS,
    prefabs: PREFABS,
    abilityRuntime: RUNTIME,
    abilities,
    ...extra,
  };
}

interface Harness {
  readonly world: ReturnType<typeof loadScene>['world'];
  readonly scene: ReturnType<typeof loadScene>;
  aim(x: number, y: number): void;
  step(buttons?: number): readonly GameEvent[];
  place(prefab: string, overrides?: Record<string, Record<string, number>>): EntityId;
  slotField(slot: EntityId, field: string): number;
  cooldown(slot: EntityId): number;
}

function harness(def: SceneDef, extraSystems: readonly System[] = []): Harness {
  const loaded = loadScene(def);
  const { world, systems } = loaded;
  systems.register(new InputSystem({ players: ['p1'] }));
  let aimX = 0;
  let aimY = 0;
  // Точка прицела кадра — между раскладкой ввода (−1000) и прицеливанием (−800).
  systems.register({
    name: 'Aim',
    order: -950,
    run: (ctx: SystemContext) => {
      for (const entity of ctx.query({ all: ['Input'] })) {
        ctx.commands.setField(entity, 'Input', 'targetX', aimX);
        ctx.commands.setField(entity, 'Input', 'targetY', aimY);
      }
    },
  });
  for (const system of extraSystems) systems.register(system);

  const sim: Simulation = {
    systems,
    worldSeed: 1,
    math: mathApi,
    ...(loaded.abilities !== undefined ? { abilities: loaded.abilities } : {}),
  };
  const state = initialState(world, 1);
  let seq = 0;

  return {
    world,
    scene: loaded,
    aim: (x, y) => {
      aimX = x;
      aimY = y;
    },
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
    slotField: (slot, field) => getField(world, slot, ABILITY_SLOT_COMPONENT, field),
    cooldown: (slot) => getField(world, slot, ABILITY_COOLDOWN_COMPONENT, 'remaining'),
  };
}

/** Слот способности выдаётся спавном сущности (ABIL-1), а не правкой схем. */
function giveSlot(h: Harness, owner: EntityId, abilityId = 0): EntityId {
  return h.place('Slot', { AbilitySlot: { owner, abilityId, slotIndex: 0 } });
}

function eventsOfType(events: readonly GameEvent[], type: string): readonly GameEvent[] {
  return events.filter((event) => event.type === type);
}

// ------------------------------------------------------------------- фазы

describe('CastPhaseSystem: триггер, гейт и фазы (ABIL-3, ABIL-4, ABIL-7)', () => {
  const instant: AbilityDef = {
    id: 'bolt',
    trigger: { input: { bit: 0 } },
    cooldownTicks: 3,
    effects: [{ emitEvent: { type: 'Cast', data: { slot: { var: 'self' } } } }],
  };

  it('мгновенная способность: фронт бита исполняет эффекты и взводит кулдаун', () => {
    const h = harness(scene([instant]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);

    expect(eventsOfType(h.step(0), 'Cast')).toHaveLength(0);
    const fired = eventsOfType(h.step(CAST), 'Cast');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data.slot).toBe(slot);
    // Кулдаун взведён и уже убавлен своей системой того же тика (order 800).
    expect(h.cooldown(slot)).toBe(2);
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);
  });

  it('удержание кнопки не даёт второго срабатывания — платформа смотрит фронт', () => {
    const h = harness(scene([{ ...instant, cooldownTicks: 0 }]));
    const hero = h.place('Hero');
    giveSlot(h, hero);
    expect(eventsOfType(h.step(CAST), 'Cast')).toHaveLength(1);
    expect(eventsOfType(h.step(CAST), 'Cast')).toHaveLength(0);
    expect(eventsOfType(h.step(0), 'Cast')).toHaveLength(0);
    expect(eventsOfType(h.step(CAST), 'Cast')).toHaveLength(1);
  });

  it('ровно N тиков между кастами независимо от order систем сцены (ABIL-7)', () => {
    const always: AbilityDef = {
      id: 'aura',
      trigger: { always: true },
      cooldownTicks: 3,
      effects: [{ emitEvent: { type: 'Cast' } }],
    };
    // Две сценовые системы по обе стороны закрывающей полосы платформы: их
    // `order` — политика контента, и на длину кулдауна он влиять не вправе.
    const noise = [
      { name: 'Before', order: 500, do: [{ emitEvent: { type: 'Noise' } }] },
      { name: 'After', order: 900, do: [{ emitEvent: { type: 'Noise' } }] },
    ];
    const h = harness(scene([always], { systems: noise }));
    const hero = h.place('Hero');
    giveSlot(h, hero);

    const casts: number[] = [];
    for (let i = 1; i <= 10; i++) {
      if (eventsOfType(h.step(), 'Cast').length > 0) casts.push(i);
    }
    expect(casts).toEqual([1, 4, 7, 10]);
  });

  it('заряд, прицеливание, выпуск: удержание держит фазу, отпускание переводит во вторую', () => {
    const charge: AbilityDef = {
      id: 'charge',
      trigger: { input: { bit: 0 } },
      confirmBit: 1,
      phases: [
        { id: 'wind', trigger: 'hold', onEnter: [{ emitEvent: { type: 'Wind' } }] },
        { id: 'aim', trigger: 'commit', onEnter: [{ emitEvent: { type: 'Aim' } }] },
      ],
      effects: [{ emitEvent: { type: 'Release' } }],
    };
    const h = harness(scene([charge]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);

    expect(eventsOfType(h.step(CAST), 'Wind')).toHaveLength(1);
    expect(h.slotField(slot, 'phase')).toBe(0);
    h.step(CAST);
    expect(h.slotField(slot, 'phase')).toBe(0);
    expect(h.slotField(slot, 'phaseTicks')).toBe(1);
    // Отпускание завершает фазу `hold` штатно — это переход, а не срыв.
    expect(eventsOfType(h.step(0), 'Aim')).toHaveLength(1);
    expect(h.slotField(slot, 'phase')).toBe(1);
    // Фронт бита подтверждения завершает фазу `commit` и весь каст.
    expect(eventsOfType(h.step(CONFIRM), 'Release')).toHaveLength(1);
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);
  });

  it('передержанный заряд уходит в названную фазу, а не срывается (ABIL-4)', () => {
    const overcharge: AbilityDef = {
      id: 'overcharge',
      trigger: { input: { bit: 0 } },
      phases: [
        { id: 'wind', trigger: 'hold', durationTicks: 2, timeout: { then: 'over' } },
        { id: 'over', trigger: 'auto', durationTicks: 1, onEnter: [{ emitEvent: { type: 'Over' } }] },
      ],
      effects: [{ emitEvent: { type: 'Boom', data: { ticks: { var: 'phaseTicks' } } } }],
    };
    const h = harness(scene([overcharge]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);

    h.step(CAST);
    h.step(CAST);
    expect(eventsOfType(h.step(CAST), 'Over')).toHaveLength(1);
    expect(h.slotField(slot, 'phase')).toBe(1);
    const boom = eventsOfType(h.step(CAST), 'Boom');
    expect(boom).toHaveLength(1);
    expect(boom[0]!.data.ticks).toBe(1);
  });

  it('цикл фаз нулевой длительности: за тик ровно один переход (ABIL-4)', () => {
    const loop: AbilityDef = {
      id: 'loop',
      trigger: { input: { bit: 0 } },
      phases: [
        { id: 'a', trigger: 'auto', durationTicks: 0, timeout: { then: 'b' } },
        { id: 'b', trigger: 'auto', durationTicks: 0, timeout: { then: 'a' } },
      ],
      effects: [],
    };
    const h = harness(scene([loop]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);

    h.step(CAST);
    expect(h.slotField(slot, 'phase')).toBe(0);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.step();
      seen.push(h.slotField(slot, 'phase'));
    }
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it('условие сверх триггера — предикат определения (ABIL-3)', () => {
    const gated: AbilityDef = {
      id: 'gated',
      trigger: { input: { bit: 0 } },
      condition: { hasComponent: [{ var: 'owner' }, 'Enemy'] },
      effects: [{ emitEvent: { type: 'Cast' } }],
    };
    const h = harness(scene([gated]));
    const hero = h.place('Hero');
    giveSlot(h, hero);
    expect(eventsOfType(h.step(CAST), 'Cast')).toHaveLength(0);
  });

  it('триггер по событию срабатывает и связывает событие именем (ABIL-3)', () => {
    const proc: AbilityDef = {
      id: 'proc',
      trigger: { event: { type: 'Tock', as: 'e' } },
      effects: [{ emitEvent: { type: 'Cast', data: { value: { eventField: [{ var: 'e' }, 'value'] } } } }],
    };
    // Эмитент обязан стоять раньше фаз (−790), иначе шина его ещё не видит (EVT-2).
    const ticker = { name: 'Ticker', order: -900, do: [{ emitEvent: { type: 'Tock', data: { value: 7 } } }] };
    const h = harness(scene([proc], { systems: [ticker] }));
    const hero = h.place('Hero');
    giveSlot(h, hero);
    const cast = eventsOfType(h.step(), 'Cast');
    expect(cast).toHaveLength(1);
    expect(cast[0]!.data.value).toBe(7);
  });
});

// ------------------------------------------------------------- прицеливание

describe('TargetingCommitSystem: цепочка шагов (ABIL-5)', () => {
  const chain: AbilityDef = {
    id: 'chain',
    trigger: { input: { bit: 0 } },
    confirmBit: 1,
    phases: [{ id: 'aim', trigger: 'commit' }],
    targeting: {
      steps: [
        { kind: 'unit', range: F(10), filter: { hasComponent: [{ var: 'candidate' }, 'Enemy'] } },
        { kind: 'vector' },
      ],
    },
    effects: [
      {
        emitEvent: {
          type: 'Done',
          data: {
            unit: { var: 'unit0' },
            dirX: { 'vec.x': [{ var: 'step1' }] },
            dirY: { 'vec.y': [{ var: 'step1' }] },
          },
        },
      },
    ],
  };

  it('цель, затем вектор: оба шага накоплены и уезжают в эффекты', () => {
    const h = harness(scene([chain]));
    const hero = h.place('Hero');
    const foe = h.place('Foe');
    const slot = giveSlot(h, hero);

    h.step(CAST);
    h.aim(F(3), 0);
    h.step(CAST | CONFIRM);
    expect(h.slotField(slot, 'staged')).toBe(1);
    expect(h.slotField(slot, 'step0e')).toBe(foe);
    // Второй шаг считает направление ОТ сущности первого шага (ABIL-5).
    h.step(CAST);
    h.aim(F(3), F(5));
    const done = eventsOfType(h.step(CAST | CONFIRM), 'Done');
    expect(done).toHaveLength(1);
    expect(done[0]!.data.unit).toBe(foe);
    expect(done[0]!.data.dirX).toBe(0);
    expect(done[0]!.data.dirY).toBe(FIXED_ONE);
    expect(h.slotField(slot, 'staged')).toBe(0);
  });

  it('шаг unit берёт ближайшую к точке прицела; равные — по порядку обхода (QUERY-2)', () => {
    const h = harness(scene([chain]));
    const hero = h.place('Hero');
    const first = h.place('Foe', { Position: { x: F(2), y: F(2) } });
    h.place('Foe', { Position: { x: F(2), y: F(-2) } });
    const slot = giveSlot(h, hero);

    h.step(CAST);
    h.aim(F(2), 0);
    h.step(CAST | CONFIRM);
    expect(h.slotField(slot, 'step0e')).toBe(first);
  });

  it('фильтр — предикат над компонентами: сущность вне фильтра не берётся', () => {
    const h = harness(scene([chain]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    h.aim(F(1), 0);
    h.step(CAST | CONFIRM);
    expect(h.slotField(slot, 'step0e')).toBe(-1);
  });
});

// ---------------------------------------------------- проверка на подтверждении

describe('Проверка накопленных шагов только на подтверждении (ABIL-5)', () => {
  const twoSteps: AbilityDef = {
    id: 'grab',
    trigger: { input: { bit: 0 } },
    confirmBit: 1,
    cooldownTicks: 10,
    phases: [
      {
        id: 'aim',
        trigger: 'commit',
        onCancel: [{ emitEvent: { type: 'Lost', data: { src: { var: 'lastInterrupt' } } } }],
      },
    ],
    targeting: {
      steps: [
        { kind: 'unit', range: F(10), filter: { hasComponent: [{ var: 'candidate' }, 'Enemy'] } },
        { kind: 'point' },
      ],
    },
    effects: [{ emitEvent: { type: 'Done' } }],
  };

  it('цель умерла между накоплением и подтверждением — прерывание targetLost', () => {
    const h = harness(scene([twoSteps]));
    const hero = h.place('Hero');
    const foe = h.place('Foe');
    const slot = giveSlot(h, hero);

    h.step(CAST);
    h.aim(F(3), 0);
    h.step(CAST | CONFIRM);
    expect(h.slotField(slot, 'step0e')).toBe(foe);
    destroy(h.world, foe);
    h.step(CAST);
    const events = h.step(CAST | CONFIRM);
    expect(eventsOfType(events, 'Done')).toHaveLength(0);
    const lost = eventsOfType(events, 'Lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]!.data.src).toBe(INTERRUPT_TARGET_LOST);
    // Умолчание источника — возврат кулдауна (ABIL-6).
    expect(h.cooldown(slot)).toBe(0);
    expect(h.slotField(slot, 'lastInterrupt')).toBe(INTERRUPT_TARGET_LOST);
  });

  it('цель вышла за дальность к моменту подтверждения — тот же источник', () => {
    const h = harness(scene([twoSteps]));
    const hero = h.place('Hero');
    const foe = h.place('Foe');
    const slot = giveSlot(h, hero);

    h.step(CAST);
    h.aim(F(3), 0);
    h.step(CAST | CONFIRM);
    setField(h.world, foe, 'Position', 'x', F(50));
    h.step(CAST);
    expect(eventsOfType(h.step(CAST | CONFIRM), 'Lost')).toHaveLength(1);
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);
  });
});

describe('Видимость цели стороне владельца на подтверждении (ABIL-5, FOW-2)', () => {
  const seek: AbilityDef = {
    id: 'seek',
    trigger: { input: { bit: 0 } },
    confirmBit: 1,
    phases: [{ id: 'aim', trigger: 'commit' }],
    targeting: {
      steps: [
        { kind: 'unit', range: F(10), filter: { hasComponent: [{ var: 'candidate' }, 'Enemy'] } },
        { kind: 'point' },
      ],
    },
    effects: [{ emitEvent: { type: 'Done' } }],
  };

  /** Сцена с туманом требует террейна (SER-7) и объявленной стороны (ABIL-8). */
  const foggy: SceneDef = {
    components: COMPONENTS,
    prefabs: [
      ...PREFABS,
      { name: 'Seen', components: { Position: { x: F(3), y: 0 }, Enemy: { flag: 1 }, Visibility: { visibleTo: 1 } } },
      { name: 'Hidden', components: { Position: { x: F(3), y: 0 }, Enemy: { flag: 1 }, Visibility: { visibleTo: 2 } } },
    ],
    terrain: {
      width: 2,
      height: 2,
      tileSize: fixed.fromInt(8),
      levels: ['00', '00'],
      flags: ['..', '..'],
    },
    fog: true,
    abilityRuntime: RUNTIME,
    abilities: [seek],
  };

  function run(prefab: string): readonly GameEvent[] {
    const h = harness(foggy);
    const hero = h.place('Hero');
    h.place(prefab);
    giveSlot(h, hero);
    h.step(CAST);
    h.aim(F(3), 0);
    h.step(CAST | CONFIRM);
    h.step(CAST);
    return h.step(CAST | CONFIRM);
  }

  it('видимая стороне владельца цель проходит проверку', () => {
    expect(eventsOfType(run('Seen'), 'Done')).toHaveLength(1);
  });

  it('цель, невидимая стороне владельца, проверку не проходит', () => {
    expect(eventsOfType(run('Hidden'), 'Done')).toHaveLength(0);
  });
});

// ------------------------------------------------------------- прерывания

describe('Прерывания: словарь, умолчания и исходы (ABIL-6)', () => {
  function held(extra: Partial<AbilityDef> = {}): AbilityDef {
    return {
      id: 'hold',
      trigger: { input: { bit: 0 } },
      cancelBit: 2,
      cooldownTicks: 10,
      phases: [
        {
          id: 'wind',
          trigger: 'hold',
          onCancel: [{ emitEvent: { type: 'Cancelled', data: { src: { var: 'lastInterrupt' } } } }],
        },
      ],
      effects: [{ emitEvent: { type: 'Done' } }],
      ...extra,
    };
  }

  it('отмена кнопкой: умолчание — возврат кулдауна и сброс прицеливания', () => {
    const h = harness(scene([held()]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    const events = h.step(CAST | CANCEL);
    const cancelled = eventsOfType(events, 'Cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.data.src).toBe(INTERRUPT_CANCEL_INPUT);
    expect(h.cooldown(slot)).toBe(0);
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);
  });

  it('лок действий: источник disable взводит кулдаун целиком', () => {
    const h = harness(scene([held({ interrupts: { disable: { mask: 1 } } })]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    // Компонент лока ставит сцена (в демо — своя система); здесь он появляется
    // между тиками, как это сделала бы она.
    addComponent(h.world, hero, 'ActionLock', { mask: 1 });
    const events = h.step(CAST);
    expect(eventsOfType(events, 'Cancelled')[0]?.data.src).toBe(INTERRUPT_DISABLE);
    expect(h.cooldown(slot)).toBe(9);
  });

  it('смерть владельца: возврат кулдауна, слот остаётся (design Decision 14)', () => {
    const h = harness(scene([held()]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    addComponent(h.world, hero, 'Dead', { at: 1 });
    const events = h.step(CAST);
    expect(eventsOfType(events, 'Cancelled')[0]?.data.src).toBe(INTERRUPT_DEATH);
    expect(h.cooldown(slot)).toBe(0);
    expect(hasComponent(h.world, slot, ABILITY_SLOT_COMPONENT)).toBe(true);
  });

  it('переопределение одной пары «фаза, источник»: половина кулдауна', () => {
    const half = held({
      phases: [
        {
          id: 'wind',
          trigger: 'hold',
          interrupts: { cancelInput: { cooldown: 'partial', refund: F(0.5) } },
          onCancel: [{ emitEvent: { type: 'Cancelled', data: { src: { var: 'lastInterrupt' } } } }],
        },
      ],
    });
    const h = harness(scene([half]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    h.step(CAST | CANCEL);
    // 10 × 0.5 = 5, минус тик собственной системы кулдаунов.
    expect(h.cooldown(slot)).toBe(4);
  });

  it('таймаут с исходом cancel прерывает каст источником timeout', () => {
    const timed = held({
      phases: [
        {
          id: 'wind',
          trigger: 'hold',
          durationTicks: 2,
          timeout: { then: 'cancel' },
          onCancel: [{ emitEvent: { type: 'Cancelled', data: { src: { var: 'lastInterrupt' } } } }],
        },
      ],
    });
    const h = harness(scene([timed]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    h.step(CAST);
    expect(eventsOfType(h.step(CAST), 'Cancelled')[0]?.data.src).toBe(INTERRUPT_TIMEOUT);
    expect(h.cooldown(slot)).toBe(9);
  });

  it('объявленный release срывает каст в фазе, которая бит не потребляет', () => {
    const released = held({
      interrupts: { release: {} },
      phases: [
        {
          id: 'aim',
          trigger: 'commit',
          onCancel: [{ emitEvent: { type: 'Cancelled', data: { src: { var: 'lastInterrupt' } } } }],
        },
      ],
    });
    const h = harness(scene([released]));
    const hero = h.place('Hero');
    giveSlot(h, hero);
    h.step(CAST);
    expect(eventsOfType(h.step(0), 'Cancelled')[0]?.data.src).toBe(INTERRUPT_RELEASE);
  });

  it('предикат смещения владельца — источник displacement', () => {
    const pushed = held({
      interrupts: { displacement: { when: { hasComponent: [{ var: 'owner' }, 'Pushed'] } } },
    });
    const h = harness(scene([pushed]));
    const hero = h.place('Hero');
    giveSlot(h, hero);
    h.step(CAST);
    addComponent(h.world, hero, 'Pushed', { flag: 1 });
    expect(eventsOfType(h.step(CAST), 'Cancelled')[0]?.data.src).toBe(INTERRUPT_DISPLACEMENT);
  });

  it('второй каст того же владельца вытесняет первый (supersede, CMD-5)', () => {
    const first = held();
    const second: AbilityDef = { ...held(), id: 'other', trigger: { input: { bit: 1 } } };
    const h = harness(scene([first, second]));
    const hero = h.place('Hero');
    const slotA = giveSlot(h, hero, 0);
    const slotB = giveSlot(h, hero, 1);

    h.step(CAST);
    expect(h.slotField(slotA, 'phase')).toBe(0);
    const events = h.step(CAST | CONFIRM);
    expect(eventsOfType(events, 'Cancelled')[0]?.data.src).toBe(INTERRUPT_SUPERSEDE);
    expect(h.slotField(slotA, 'phase')).toBe(NO_PHASE);
    expect(h.slotField(slotB, 'phase')).toBe(0);
  });

  it('два старта в одном тике: побеждает второй по порядку обхода', () => {
    const both: AbilityDef = { ...held(), id: 'both' };
    const other: AbilityDef = { ...held(), id: 'other' };
    const h = harness(scene([both, other]));
    const hero = h.place('Hero');
    const slotA = giveSlot(h, hero, 0);
    const slotB = giveSlot(h, hero, 1);
    h.step(CAST);
    expect(h.slotField(slotA, 'phase')).toBe(NO_PHASE);
    expect(h.slotField(slotB, 'phase')).toBe(0);
  });
});

describe('CastInterruptSystem: урон посреди каста (ABIL-6, DET-9)', () => {
  const fragile: AbilityDef = {
    id: 'fragile',
    trigger: { input: { bit: 0 } },
    cooldownTicks: 6,
    interrupts: { damaged: { threshold: F(1) } },
    phases: [
      {
        id: 'wind',
        trigger: 'hold',
        onCancel: [{ emitEvent: { type: 'Cancelled', data: { src: { var: 'lastInterrupt' } } } }],
      },
    ],
    effects: [{ emitEvent: { type: 'Done' } }],
  };

  /** Урон публикует система сцены — как `DamageApply` демо, в середине шкалы. */
  const damage = (amount: number) => ({
    name: 'DamageApply',
    order: 128,
    query: { all: ['Player'] },
    as: 'e',
    do: [{ emitEvent: { type: 'Damage', data: { target: { var: 'e' }, amount } } }],
  });

  it('урон сверх порога прерывает на том же тике, а не на следующем', () => {
    const h = harness(scene([fragile], { systems: [damage(F(5))] }));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    const events = h.step(CAST);
    expect(eventsOfType(events, 'Cancelled')[0]?.data.src).toBe(INTERRUPT_DAMAGED);
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);
    // Прерывание стоит ПОЗЖЕ системы кулдаунов (830 против 800), поэтому
    // взведённый им остаток убавится только на следующем тике (DET-9).
    expect(h.cooldown(slot)).toBe(6);
  });

  it('урон в пределах порога каст не трогает', () => {
    const h = harness(scene([fragile], { systems: [damage(F(0.5))] }));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    expect(h.slotField(slot, 'phase')).toBe(0);
  });

  it('способность, не объявившая damaged, урон не замечает', () => {
    const tough: AbilityDef = { ...fragile, id: 'tough', interrupts: {} };
    const h = harness(scene([tough], { systems: [damage(F(5))] }));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    h.step(CAST);
    expect(h.slotField(slot, 'phase')).toBe(0);
  });

  it('событие баффа тоже видно: периодика на 820 успевает к прерыванию на 830', () => {
    // Урон публикует не система сцены, а периодика баффа — то есть система
    // платформы, стоящая на 820. Прерывание стоит позже неё намеренно (DET-9),
    // и без этого порядка весь урон от баффов проходил бы мимо источника
    // `damaged`.
    const dot: BuffDef = {
      id: 'dot',
      class: 'negative',
      periodic: {
        everyTicks: 1,
        do: [{ emitEvent: { type: 'Damage', data: { target: { var: 'target' }, amount: F(5) } } }],
      },
    };
    const h = harness(
      scene([fragile], {
        prefabs: [...PREFABS, { name: 'Dot', components: { BuffInstance: {} } }],
        buffs: [dot],
      }),
    );
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    // Инстанс накладывается на первом тике, а периодика идёт со следующего.
    h.place('Dot', { BuffInstance: { target: hero, buffId: 0 } });
    h.step();
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);

    const events = h.step(CAST);
    expect(eventsOfType(events, 'Damage')).toHaveLength(1);
    expect(eventsOfType(events, 'Cancelled')[0]?.data.src).toBe(INTERRUPT_DAMAGED);
    expect(h.slotField(slot, 'phase')).toBe(NO_PHASE);
  });
});

// --------------------------------------------------------------- доставка

describe('Доставка: снаряд и эффект с длительностью (ABIL-9)', () => {
  const delivery: AbilityDef = {
    id: 'delivery',
    trigger: { input: { bit: 0 } },
    effects: [],
    projectile: {
      onHit: [
        {
          emitEvent: {
            type: 'Hit',
            data: { self: { var: 'self' }, other: { var: 'other' }, nx: { eventField: [{ var: 'event' }, 'nx'] } },
          },
        },
      ],
      onFade: [{ emitEvent: { type: 'Fade', data: { self: { var: 'self' } } } }],
    },
    duration: { onExpire: [{ emitEvent: { type: 'Expired', data: { self: { var: 'self' } } } }] },
  };

  /** Столкновения публикует физика (PHYS-9); здесь их роль играет система сцены на 200. */
  const collider = {
    name: 'FakePhysics',
    order: 200,
    query: { all: ['AbilityProjectile'] },
    as: 'p',
    do: [{ emitEvent: { type: 'Collision', data: { entity: { var: 'p' }, other: 0, nx: 65536, ny: 0 } } }],
  };

  it('столкновение этого тика запускает список действий определения', () => {
    const h = harness(scene([delivery], { systems: [collider] }));
    h.place('Hero');
    const ball = h.place('Ball', { AbilityProjectile: { abilityId: 0, ticksLeft: 0, range: 0 } });
    const hit = eventsOfType(h.step(), 'Hit');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.data.self).toBe(ball);
    expect(hit[0]!.data.nx).toBe(FIXED_ONE);
  });

  it('исчерпание времени жизни исполняет затухание и удаляет сущность', () => {
    const h = harness(scene([delivery]));
    h.place('Hero');
    const ball = h.place('Ball', { AbilityProjectile: { abilityId: 0, ticksLeft: 2 } });
    expect(eventsOfType(h.step(), 'Fade')).toHaveLength(0);
    expect(eventsOfType(h.step(), 'Fade')).toHaveLength(1);
    expect(hasComponent(h.world, ball, ABILITY_PROJECTILE_COMPONENT)).toBe(false);
  });

  it('исчерпание дальности считается от точки старта', () => {
    const h = harness(scene([delivery]));
    h.place('Hero');
    const ball = h.place('Ball', {
      Position: { x: F(9), y: 0 },
      AbilityProjectile: { abilityId: 0, originX: 0, originY: 0, range: F(4) },
    });
    expect(eventsOfType(h.step(), 'Fade')).toHaveLength(1);
    expect(hasComponent(h.world, ball, ABILITY_PROJECTILE_COMPONENT)).toBe(false);
  });

  it('эффект с длительностью убывает, истекает и удаляется', () => {
    const h = harness(scene([delivery]));
    h.place('Hero');
    const zone = h.place('Zone', { AbilityDuration: { abilityId: 0, remaining: 2 } });
    expect(eventsOfType(h.step(), 'Expired')).toHaveLength(0);
    expect(getField(h.world, zone, ABILITY_DURATION_COMPONENT, 'remaining')).toBe(1);
    expect(eventsOfType(h.step(), 'Expired')).toHaveLength(1);
    expect(hasComponent(h.world, zone, ABILITY_DURATION_COMPONENT)).toBe(false);
  });
});

// ---------------------------------------------------------------- сироты

describe('Слоты-сироты (design Decision 14)', () => {
  const simple: AbilityDef = {
    id: 'simple',
    trigger: { input: { bit: 0 } },
    effects: [{ emitEvent: { type: 'Cast' } }],
  };

  it('владельца больше не существует — слот удаляется', () => {
    const h = harness(scene([simple]));
    h.place('Hero');
    // Владелец — не игрок: платформа не требует, чтобы он был игроком (ABIL-8).
    const summon = h.place('Foe');
    const slot = giveSlot(h, summon);
    h.step();
    expect(hasComponent(h.world, slot, ABILITY_SLOT_COMPONENT)).toBe(true);
    destroy(h.world, summon);
    h.step();
    expect(hasComponent(h.world, slot, ABILITY_SLOT_COMPONENT)).toBe(false);
  });

  it('герой умер и воскрес той же сущностью — способности остались', () => {
    const h = harness(scene([simple]));
    const hero = h.place('Hero');
    const slot = giveSlot(h, hero);
    addComponent(h.world, hero, 'Dead', { at: 1 });
    h.step();
    expect(hasComponent(h.world, slot, ABILITY_SLOT_COMPONENT)).toBe(true);
    // Маркер смерти снимает сцена (в демо это `Respawn`).
    removeComponent(h.world, hero, 'Dead');
    h.step();
    expect(eventsOfType(h.step(CAST), 'Cast')).toHaveLength(1);
  });
});

// ------------------------------------------------------- дисциплина аллокаций

describe('Дисциплина аллокаций платформы (ABIL-10)', () => {
  /**
   * Счётчика аллокаций в vitest нет, поэтому проверяется наблюдаемое: число
   * запросов к миру за тик. Каждый запрос — единственный контейнер, который
   * система заводит на тик; всё прочее (область видимости списка действий,
   * буфер кандидатов, спецификация запроса) живёт на экземпляре системы.
   * Постоянное число запросов при десятикратном росте числа слотов и означает
   * «тик не аллоцирует пропорционально их числу».
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

  const wide: AbilityDef = {
    id: 'wide',
    trigger: { input: { bit: 0 } },
    confirmBit: 1,
    cooldownTicks: 1,
    phases: [{ id: 'aim', trigger: 'commit' }],
    targeting: { steps: [{ kind: 'point' }] },
    effects: [],
  };

  function queriesFor(slots: number): number {
    const loaded = loadScene(scene([wide]));
    const catalog = loaded.abilities!;
    const phase = new CountingProbe(new CastPhaseSystem(catalog));
    const targeting = new CountingProbe(new TargetingCommitSystem(catalog));
    loaded.systems.override(phase);
    loaded.systems.override(targeting);
    loaded.systems.register(new InputSystem({ players: ['p1'] }));

    const sim: Simulation = { systems: loaded.systems, worldSeed: 1, math: mathApi, abilities: catalog };
    const state = initialState(loaded.world, 1);
    const hero = spawn(loaded.world, 'Hero');
    for (let i = 0; i < slots; i++) {
      spawn(loaded.world, 'Slot', { AbilitySlot: { owner: hero, abilityId: 0, slotIndex: i } });
    }
    for (let i = 0; i < 5; i++) {
      tick(sim, state, [
        {
          tick: state.tick + 1,
          playerId: 'p1',
          seq: i,
          move: { x: 0, y: 0 },
          aimDir: 0,
          buttons: i % 2 === 0 ? CAST | CONFIRM : 0,
        },
      ]);
    }
    return phase.queries + targeting.queries;
  }

  it('сто слотов — тик не аллоцирует пропорционально их числу', () => {
    const ten = queriesFor(10);
    const hundred = queriesFor(100);
    expect(ten).toBe(hundred);
    // Ровно по одному запросу на систему на тик, пять тиков, две системы.
    expect(hundred).toBe(10);
  });
});
