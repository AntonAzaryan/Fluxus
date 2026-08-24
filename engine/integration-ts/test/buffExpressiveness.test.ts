/**
 * BUFF-7: пассивка, аура, DoT и зона — тот же механизм, а не ветви таксономии.
 *
 * Проверка здесь и в интеграционной суите (CLI-9) потому, что её предмет — не
 * поведение отдельной системы, а состав: четыре разных игровых понятия обязаны
 * собираться из уже существующих частей платформы, и ни одного поля-перечисления
 * вида ради них не появляться. Каждый сценарий требования получает свой тест, и
 * каждый собирается ТОЛЬКО записями таблиц определений сцены плюс одной обычной
 * системой сцены — код платформы во всех четырёх один и тот же.
 *
 * Сцена — публичная фикстура `buffScene`, поднимаемая публичным `loadScene`:
 * чужие `test/` не импортируются (CLI-9).
 */
import { describe, expect, it } from 'vitest';
import {
  BUFF_INSTANCE_COMPONENT,
  BUFF_NEGATIVE,
  BUFF_POSITIVE,
  fixed,
  initialState,
  loadScene,
  mathApi,
  query,
  tick,
  worldInitSpawn,
  world as coreWorld,
  type EntityId,
  type GameEvent,
  type Simulation,
  type SimulationState,
  type WorldState,
} from '@fluxus/core';
import { AURAD, BURN, CHILLED, PASSIVE, buffScene } from './fixtures.js';

interface Stand {
  readonly world: WorldState;
  readonly state: SimulationState;
  step(): readonly GameEvent[];
  place(prefab: string, overrides?: Record<string, Record<string, number>>): EntityId;
  buffs(target: EntityId, buffId: number): readonly EntityId[];
  timeScale(entity: EntityId): number;
}

function stand(): Stand {
  const loaded = loadScene(buffScene());
  const sim: Simulation = {
    systems: loaded.systems,
    worldSeed: 1,
    math: mathApi,
    modifiers: loaded.modifiers,
    ...(loaded.abilities !== undefined ? { abilities: loaded.abilities } : {}),
  };
  const state = initialState(loaded.world, 1);
  const field = (entity: EntityId, name: string): number =>
    coreWorld.getField(loaded.world, entity, BUFF_INSTANCE_COMPONENT, name);

  return {
    world: loaded.world,
    state,
    step: () => [...tick(sim, state).events],
    place: (prefab, overrides) => worldInitSpawn(loaded.world, prefab, overrides),
    buffs: (target, buffId) =>
      [...query(loaded.world, { all: [BUFF_INSTANCE_COMPONENT] })].filter(
        (instance) =>
          field(instance, 'target') === target &&
          field(instance, 'buffId') === buffId &&
          field(instance, 'class') !== 0,
      ),
    timeScale: (entity) => coreWorld.getField(loaded.world, entity, 'TimeScale', 'value'),
  };
}

describe('BUFF-7: пассивка, аура, DoT и зона — состав блоков, а не виды', () => {
  it('пассивка героя — постоянный бафф со статовой правкой, без особого механизма', () => {
    const h = stand();
    const hero = h.place('Hero');
    h.place('Buff', { BuffInstance: { target: hero, buffId: PASSIVE } });
    h.step();
    // Список источников сводится на −900, поэтому эффективный темп доезжает
    // следующим тиком — обычная задержка любого источника этого списка.
    h.step();
    expect(h.timeScale(hero)).toBe(fixed.fromFloat(1.5));

    // Постоянный бафф не истекает: сотня тиков ничего не меняет.
    for (let i = 0; i < 100; i++) h.step();
    expect(h.buffs(hero, PASSIVE)).toHaveLength(1);
    expect(h.timeScale(hero)).toBe(fixed.fromFloat(1.5));
  });

  it('аура вокруг сущности — `always` плюс `refresh`; вышедший теряет бафф сам', () => {
    const h = stand();
    const caster = h.place('Hero');
    // Уходит сам: сущность стартует в круге и покидает его собственным
    // движением — руками мир тест не правит, потому что и не может (TICK-3).
    const walker = h.place('Walker', { Player: { slot: 1 }, Drift: { step: fixed.fromFloat(0.5) } });
    h.place('Slot', { AbilitySlot: { owner: caster, abilityId: 0, slotIndex: 0 } });

    h.step();
    h.step();
    expect(h.buffs(walker, AURAD)).toHaveLength(1);
    expect(h.buffs(caster, AURAD)).toHaveLength(1);

    for (let i = 0; i < 10; i++) h.step();
    // Кастер остался в круге: повторное наложение продлевает ОДИН инстанс,
    // сколько бы тиков аура ни работала (BUFF-3), второй сущности нет.
    expect(h.buffs(caster, AURAD)).toHaveLength(1);
    // Ушедший перестал получать продление, и бафф погас по собственной короткой
    // длительности — системы «следить за выходом» не появилось.
    expect(h.buffs(walker, AURAD)).toHaveLength(0);
  });

  it('DoT — бафф с периодикой: «урон» целиком принадлежит контенту', () => {
    const h = stand();
    const hero = h.place('Hero');
    h.place('Buff', { BuffInstance: { target: hero, buffId: BURN } });

    const fired: number[] = [];
    for (let i = 1; i <= 12; i++) {
      if (h.step().some((event) => event.type === 'Burn')) fired.push(i);
    }
    // Наложение на первом тике, период три, длительность девять: три
    // срабатывания, последнее — на тике истечения.
    expect(fired).toEqual([4, 7, 10]);
    expect(h.buffs(hero, BURN)).toHaveLength(0);
  });

  it('зона с эффектом — сущность с длительностью плюс бафф на вошедших', () => {
    const h = stand();
    const hero = h.place('Hero');
    const away = h.place('Hero', { Player: { slot: 1 }, Position: { x: fixed.fromInt(9), y: 0 } });
    const dome = h.place('Dome', { AbilityDuration: { abilityId: 0, remaining: 6 } });

    h.step();
    h.step();
    expect(h.buffs(hero, CHILLED)).toHaveLength(1);
    expect(h.buffs(away, CHILLED)).toHaveLength(0);
    expect(h.timeScale(hero)).toBe(fixed.fromFloat(0.5));

    // Зона истекла — продлевать дебафф стало нечему, и он гаснет сам.
    for (let i = 0; i < 6; i++) h.step();
    expect(coreWorld.hasComponent(h.world, dome, 'AbilityDuration')).toBe(false);
    expect(h.buffs(hero, CHILLED)).toHaveLength(0);
    h.step();
    expect(h.timeScale(hero)).toBe(fixed.fromInt(1));
  });

  it('классы — данные для отбора контентом, а не ветка платформы', () => {
    const h = stand();
    const hero = h.place('Hero');
    h.place('Buff', { BuffInstance: { target: hero, buffId: PASSIVE } });
    h.place('Buff', { BuffInstance: { target: hero, buffId: BURN } });
    h.step();
    const classOf = (instance: EntityId): number =>
      coreWorld.getField(h.world, instance, BUFF_INSTANCE_COMPONENT, 'class');
    expect(h.buffs(hero, PASSIVE).map(classOf)).toEqual([BUFF_POSITIVE]);
    expect(h.buffs(hero, BURN).map(classOf)).toEqual([BUFF_NEGATIVE]);
  });
});
