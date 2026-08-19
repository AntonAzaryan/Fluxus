/**
 * Видимость сущностей-спутников платформы (NET-12): маска слота способности и
 * маска инстанса баффа.
 *
 * Стенд настоящий: сцена с туманом войны, нативная `VisibilitySystem` (900) и
 * платформа, поднятая `loadScene`. Расставленных руками битов здесь нет
 * намеренно — предмет проверки в том, что маска спутника производна от
 * результата НАСТОЯЩЕГО пересчёта FoW, а маска слота — наоборот, от него не
 * зависит вовсе.
 */
import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { getField, hasComponent, removeComponent, setField, spawn } from '../src/ecs/world.js';
import { requireModifierList } from '../src/systems/modifiers.js';
import {
  teamBit,
  VisibilitySystem,
  VISIBILITY_COMPONENT,
  VISION_MODIFIER_COMPONENT,
} from '../src/systems/visibility.js';
import { ABILITY_SLOT_COMPONENT, BUFF_INSTANCE_COMPONENT } from '../src/systems/abilities/components.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { filterSnapshot } from '../src/sim/filter.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { query } from '../src/ecs/query.js';
import type { EntityId, SimulationState, WorldState } from '../src/types.js';

const F = fixed.fromFloat;

/** Ровная площадка: разницы уровней и укрытий в проверке нет. */
const TERRAIN = {
  width: 8,
  height: 8,
  tileSize: fixed.fromInt(1),
  levels: Array.from({ length: 8 }, () => '00000000'),
  flags: Array.from({ length: 8 }, () => '........'),
};

const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Player', fields: { slot: 'i32' } },
  ],
  prefabs: [
    {
      name: 'Hero',
      components: {
        Position: { x: 0, y: 0 },
        Player: { slot: 0 },
        Vision: { radius: F(2) },
        Visibility: { visibleTo: 0 },
        Team: { id: 0 },
        VisionModifier: {},
      },
    },
    /** Сущность без стороны и без `Visibility`: публична и своей никому не является. */
    { name: 'Crate', components: { Position: { x: 0, y: 0 } } },
    { name: 'Slot', components: { AbilitySlot: {} } },
    { name: 'Buff', components: { BuffInstance: {} } },
  ],
  fog: true,
  terrain: TERRAIN,
  // Способность инертна намеренно: предмет проверки — маска слота, а не каст.
  // Компонента ввода в сцене нет, поэтому фронт бита не наступает никогда.
  abilities: [{ id: 'idle', trigger: { input: { bit: 0 } }, effects: [] }],
  buffs: [{ id: 'mark', class: 'positive' }],
  abilityRuntime: { teamField: ['Player', 'slot'] },
  capacity: 32,
};

interface Stand {
  readonly world: WorldState;
  readonly state: SimulationState;
  step(): void;
  place(prefab: string, overrides?: Record<string, Record<string, number>>): EntityId;
  mask(entity: EntityId): number;
  masked(entity: EntityId): boolean;
}

function stand(): Stand {
  const loaded = loadScene(SCENE);
  loaded.systems.register(new VisibilitySystem(requireModifierList(loaded.modifiers, VISION_MODIFIER_COMPONENT)));
  const sim: Simulation = {
    systems: loaded.systems,
    worldSeed: 1,
    math: mathApi,
    modifiers: loaded.modifiers,
    terrain: loaded.terrain!,
    ...(loaded.abilities !== undefined ? { abilities: loaded.abilities } : {}),
  };
  const state = initialState(loaded.world, 1);
  return {
    world: loaded.world,
    state,
    step: () => void tick(sim, state),
    place: (prefab, overrides) => spawn(loaded.world, prefab, overrides),
    mask: (entity) => getField(loaded.world, entity, VISIBILITY_COMPONENT, 'visibleTo'),
    masked: (entity) => hasComponent(loaded.world, entity, VISIBILITY_COMPONENT),
  };
}

/** Два героя враждующих сторон, стоящие в пределах обзора друг друга. */
function duel(h: Stand): { readonly first: EntityId; readonly second: EntityId } {
  const first = h.place('Hero');
  const second = h.place('Hero', { Position: { x: F(1), y: 0 }, Player: { slot: 1 }, Team: { id: 1 } });
  return { first, second };
}

const BOTH = teamBit(0) | teamBit(1);

describe('AbilityVisibilitySystem: маска слота способности (NET-12)', () => {
  it('содержит ровно сторону владельца и не выводится из его собственной маски', () => {
    const h = stand();
    const { first } = duel(h);
    const slot = h.place('Slot', { AbilitySlot: { owner: first, abilityId: 0, slotIndex: 0 } });
    h.step();

    // Контроль: владелец виден ОБЕИМ сторонам — маска слота обязана этого не
    // унаследовать, иначе противник получил бы кулдауны и прицеливание.
    expect(h.mask(first)).toBe(BOTH);
    expect(h.mask(slot)).toBe(teamBit(0));

    // И персональный снапшот противника такого слота не содержит вовсе.
    const foreign = filterSnapshot(h.state, 1);
    expect([...query(foreign.world, { all: [ABILITY_SLOT_COMPONENT] })]).toHaveLength(0);
    const own = filterSnapshot(h.state, 0);
    expect([...query(own.world, { all: [ABILITY_SLOT_COMPONENT] })]).toHaveLength(1);
  });

  it('слот владельца без объявленной стороны не виден никому', () => {
    // Направление умолчания NET-12 у спутника обратное: сказать о стороне
    // нечего — значит, слот вырезается из каждого персонального снапшота, а не
    // попадает во все сразу.
    const h = stand();
    duel(h);
    const ghost = h.place('Crate');
    const slot = h.place('Slot', { AbilitySlot: { owner: ghost, abilityId: 0, slotIndex: 0 } });
    h.step();

    expect(h.mask(slot)).toBe(0);
    expect([...query(filterSnapshot(h.state, 0).world, { all: [ABILITY_SLOT_COMPONENT] })]).toHaveLength(0);
  });
});

describe('AbilityVisibilitySystem: маска инстанса баффа (NET-12)', () => {
  it('копирует маску цели и уходит в туман вместе с ней', () => {
    const h = stand();
    const { second } = duel(h);
    const instance = h.place('Buff', { BuffInstance: { target: second, buffId: 0 } });
    h.step();

    // Пока цель видна обеим сторонам, инстанс виден ровно тем же.
    expect(h.mask(second)).toBe(BOTH);
    expect(h.mask(instance)).toBe(BOTH);

    // Цель уходит за предел обзора чужого наблюдателя.
    setField(h.world, second, 'Position', 'x', F(5));
    h.step();
    expect(h.mask(second)).toBe(teamBit(1));
    expect(h.mask(instance)).toBe(teamBit(1));

    const foreign = filterSnapshot(h.state, 0);
    expect([...query(foreign.world, { all: [BUFF_INSTANCE_COMPONENT] })]).toHaveLength(0);
  });

  it('цель без маски делает инстанс таким же публичным', () => {
    const h = stand();
    duel(h);
    const crate = h.place('Crate');
    const instance = h.place('Buff', { BuffInstance: { target: crate, buffId: 0 } });
    h.step();

    // Совпадение с маской цели полное, включая её отсутствие: у цели нет
    // утверждения о видимости — нет его и у инстанса (NET-12).
    expect(h.masked(instance)).toBe(false);
    expect([...query(filterSnapshot(h.state, 0).world, { all: [BUFF_INSTANCE_COMPONENT] })]).toHaveLength(1);
  });

  it('цель потеряла маску — инстанс теряет её следом', () => {
    const h = stand();
    const { second } = duel(h);
    const instance = h.place('Buff', { BuffInstance: { target: second, buffId: 0 } });
    h.step();
    expect(h.masked(instance)).toBe(true);

    removeComponent(h.world, second, VISIBILITY_COMPONENT);
    h.step();
    expect(h.masked(instance)).toBe(false);
  });
});
