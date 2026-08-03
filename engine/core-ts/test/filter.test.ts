import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { getField, isAlive, listAlive, setField, spawn } from '../src/ecs/world.js';
import { filterSnapshot, relevantEntityVisible, VIEWPOINT_ALL } from '../src/sim/filter.js';
import { snapshotToPlain } from '../src/sim/serialization.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { teamBit, VisibilitySystem, VISIBILITY_COMPONENT, VISION_MODIFIER_COMPONENT } from '../src/systems/visibility.js';
import { requireModifierList } from '../src/systems/modifiers.js';
import type { EntityId, FieldOverrides, Snapshot } from '../src/types.js';

const F = fixed.fromFloat;

const SCENE: SceneDef = {
  components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
  fog: true,
  prefabs: [
    {
      name: 'Watcher',
      components: {
        Position: { x: 0, y: 0 },
        Vision: { radius: F(3) },
        Visibility: { visibleTo: 0 },
        Team: { id: 0 },
        Stealth: { active: 0 },
      },
    },
    {
      name: 'Enemy',
      components: {
        Position: { x: 0, y: 0 },
        Vision: { radius: F(3) },
        Visibility: { visibleTo: 0 },
        Team: { id: 1 },
        Stealth: { active: 0 },
      },
    },
    /** Обстановка без `Visibility`: секретом не является и режется не должна (NET-12). */
    { name: 'Rock', components: { Position: { x: 0, y: 0 } } },
  ],
};

function harness() {
  const { world, systems, modifiers } = loadScene(SCENE);
  systems.register(new VisibilitySystem(requireModifierList(modifiers, VISION_MODIFIER_COMPONENT)));
  const sim: Simulation = { systems, worldSeed: 1, math: mathApi, modifiers };
  const state = initialState(world, 1);

  return {
    world,
    state,
    place: (prefab: string, overrides?: FieldOverrides) => spawn(world, prefab, overrides),
    step: () => tick(sim, state),
    mask: (entity: EntityId): number => getField(world, entity, VISIBILITY_COMPONENT, 'visibleTo'),
    present: (snapshot: Snapshot, entity: EntityId): boolean => isAlive(snapshot.world, entity),
  };
}

/** Двое врагов вне обзора друг друга: каждый видит только себя (свою команду). */
function apart() {
  const h = harness();
  const watcher = h.place('Watcher', { Position: { x: F(0), y: F(0) } });
  const enemy = h.place('Enemy', { Position: { x: F(50), y: F(50) } });
  const rock = h.place('Rock', { Position: { x: F(1), y: F(1) } });
  h.step();
  return { ...h, watcher, enemy, rock };
}

describe('per-client фильтрация снапшота (NET-12)', () => {
  it('невидимая для команды сущность в снапшот не попадает', () => {
    const h = apart();
    expect(h.mask(h.enemy)).toBe(teamBit(1));

    const forTeam0 = filterSnapshot(h.state, 0);
    expect(h.present(forTeam0, h.watcher)).toBe(true);
    expect(h.present(forTeam0, h.enemy)).toBe(false);

    const forTeam1 = filterSnapshot(h.state, 1);
    expect(h.present(forTeam1, h.watcher)).toBe(false);
    expect(h.present(forTeam1, h.enemy)).toBe(true);
  });

  it('видимого врага снапшот сохраняет', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = h.place('Enemy', { Position: { x: F(2), y: F(0) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
    expect(h.present(filterSnapshot(h.state, 0), enemy)).toBe(true);
    expect(watcher).toBeGreaterThanOrEqual(0);
  });

  it('сущность без Visibility публична для всех', () => {
    const h = apart();
    for (const viewpoint of [0, 1, VIEWPOINT_ALL]) {
      expect(h.present(filterSnapshot(h.state, viewpoint), h.rock)).toBe(true);
    }
  });

  it('фильтрация не мутирует ни мир, ни исходный снапшот', () => {
    const h = apart();
    const before = takeSnapshot(h.state);
    const alive = [...listAlive(h.world)];

    filterSnapshot(h.state, 0);
    filterSnapshot(before, 0);

    expect([...listAlive(h.world)]).toEqual(alive);
    expect([...listAlive(before.world)]).toEqual(alive);
    expect(snapshotToPlain(takeSnapshot(h.state))).toEqual(snapshotToPlain(before));
  });

  it('команда вне 32 бит — ошибка (FOW-2)', () => {
    const h = apart();
    expect(() => filterSnapshot(h.state, 32)).toThrow(/FOW-2/);
  });
});

describe('viewpoint = ALL (NET-15, CLI-5)', () => {
  it('отдаёт полный мир — реплеи и golden не слепнут', () => {
    const h = apart();
    const full = filterSnapshot(h.state, VIEWPOINT_ALL);

    expect([...listAlive(full.world)]).toEqual([...listAlive(h.world)]);
    expect(snapshotToPlain(full)).toEqual(snapshotToPlain(takeSnapshot(h.state)));
  });

  it('работает и от готового снапшота, не только от состояния', () => {
    const h = apart();
    const snapshot = takeSnapshot(h.state);
    expect(h.present(filterSnapshot(snapshot, VIEWPOINT_ALL), h.enemy)).toBe(true);
    expect(h.present(filterSnapshot(snapshot, 0), h.enemy)).toBe(false);
  });
});

describe('своя сущность под стелсом (NET-15)', () => {
  it('есть в своём снапшоте и отсутствует в чужом', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(0), y: F(0) } });
    const enemy = h.place('Enemy', { Position: { x: F(2), y: F(0) } });

    h.step();
    expect(h.present(filterSnapshot(h.state, 0), enemy)).toBe(true);

    setField(h.world, enemy, 'Stealth', 'active', 1);
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(1));
    expect(h.present(filterSnapshot(h.state, 1), enemy)).toBe(true);
    expect(h.present(filterSnapshot(h.state, 0), enemy)).toBe(false);
    // Наблюдателя стелс врага не прячет.
    expect(h.present(filterSnapshot(h.state, 0), watcher)).toBe(true);
  });
});

describe('скрытие не равно смерть (NET-14)', () => {
  it('фильтр вырезает сущность и не порождает ни одного события', () => {
    const h = apart();
    h.state.events.emit('EntityDied', { entity: h.watcher });

    const forTeam0 = filterSnapshot(h.state, 0);
    expect(h.present(forTeam0, h.enemy)).toBe(false);
    // Ушедший в туман враг никакого события не получил: единственное событие —
    // то, что эмитила симуляция, и оно про другую сущность.
    expect(forTeam0.events.map((e) => e.type)).toEqual(['EntityDied']);
    expect(forTeam0.events.every((e) => e.data['entity'] !== h.enemy)).toBe(true);
  });

  it('явная смерть невидимого врага до клиента не доходит, своя — доходит', () => {
    const h = apart();
    h.state.events.emit('EntityDied', { entity: h.enemy });

    expect(filterSnapshot(h.state, 0).events).toHaveLength(0);
    expect(filterSnapshot(h.state, 1).events).toHaveLength(1);
  });
});

describe('фильтрация событий (NET-13)', () => {
  it('политика по умолчанию: уходит, если видима хоть одна упомянутая сторона', () => {
    const h = apart();
    h.state.events.emit('AbilityCast', { source: h.enemy });
    h.state.events.emit('DamageDealt', { source: h.enemy, target: h.watcher });
    h.state.events.emit('RoundEnded', { winner: 1 });

    const types = filterSnapshot(h.state, 0).events.map((e) => e.type);
    // Каст невидимого врага не утекает; урон по своей сущности — уходит;
    // событие без ссылок на сущности общее.
    expect(types).toEqual(['DamageDealt', 'RoundEnded']);
  });

  it('предикат подменяется целиком — политика живёт в netcode-слое', () => {
    const h = apart();
    h.state.events.emit('AbilityCast', { source: h.enemy });
    h.state.events.emit('RoundEnded', { winner: 1 });

    const onlyRound = filterSnapshot(h.state, 0, (event) => event.type === 'RoundEnded');
    expect(onlyRound.events.map((e) => e.type)).toEqual(['RoundEnded']);

    // Дефолт доступен и как обычная функция — netcode может строить поверх него.
    const nothingVisible = relevantEntityVisible({ type: 'AbilityCast', data: { source: h.enemy } }, () => false);
    expect(nothingVisible).toBe(false);
  });

  it('несуществующая ссылка на сущность видимости не даёт', () => {
    const h = apart();
    // -1 — `STATIC_COLLIDER` физики: сущности за ним нет (PHYS-9).
    h.state.events.emit('Collision', { entity: h.enemy, other: -1 });
    expect(filterSnapshot(h.state, 0).events).toHaveLength(0);
    expect(filterSnapshot(h.state, 1).events).toHaveLength(1);
  });
});

describe('сцена без FoW (DI-3)', () => {
  it('без компонента Visibility фильтр ничего не режет', () => {
    const { world } = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [{ name: 'Rock', components: { Position: { x: 0, y: 0 } } }],
    });
    spawn(world, 'Rock');
    const state = initialState(world, 1);

    expect([...listAlive(filterSnapshot(state, 0).world)]).toEqual([...listAlive(world)]);
  });
});
