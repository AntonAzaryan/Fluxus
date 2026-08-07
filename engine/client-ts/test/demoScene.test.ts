/**
 * Демо-сцена как контент (`content/scenes/duel.scene.json`): проверяется не
 * ядро, а проводка сборки демо и политика падения в дыру, написанная в JSON.
 *
 * Механизм — за ядром (`arena` ARENA-5 эмитит `FellThroughFloor`), политика —
 * системы сцены `FallStart`/`FallDeath`: снижение по тикам и смерть по
 * достижении глубины. Тест ловит ровно то, что unit-тесты пакетов не видят:
 * сцена, у которой герой не подписан на проверку пола или у сборки нет арены,
 * тикает штатно и молча.
 */
import { describe, expect, it } from 'vitest';
import { FIXED_ONE, tick as simTick, world as coreWorld, type SceneDef } from '@game-mvp/core';
import { PLAYER_ID, createDemoSimulation } from '../demo/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const SCENE = sceneJson as unknown as SceneDef;

/** Центр дыры демо-арены: ряд 17, колонки 9–10 карты флагов. */
const HOLE_X = 9.5;
const HOLE_Y = 17.5;

function walkIntoHole(limit: number) {
  const { sim, state, playerId } = createDemoSimulation(SCENE);
  const at = (field: 'x' | 'y'): number =>
    coreWorld.getField(state.world, playerId, 'Position', field) / FIXED_ONE;

  let fellAt: number | null = null;
  let diedAt: number | null = null;
  let fellAtY = 0;
  for (let tick = 1; tick <= limit; tick++) {
    const move = {
      x: at('x') > HOLE_X ? -FIXED_ONE : 0,
      y: at('y') < HOLE_Y ? FIXED_ONE : 0,
    };
    const result = simTick(
      sim,
      state,
      [{ tick, playerId: PLAYER_ID, seq: tick, move, aimDir: 0, buttons: 0 }],
    );
    for (const event of result.events) {
      if (event.type === 'FellThroughFloor' && fellAt === null) {
        fellAt = tick;
        fellAtY = at('y');
      }
      if (event.type === 'EntityDied' && diedAt === null) diedAt = tick;
    }
    if (diedAt !== null) break;
  }
  return { state, playerId, fellAt, diedAt, fellAtY, atY: at('y') };
}

describe('демо-сцена: падение в дыру и смерть (ARENA-5)', () => {
  it('герой доходит до дыры, проваливается и умирает достигнув глубины', () => {
    const { state, playerId, fellAt, diedAt, fellAtY, atY } = walkIntoHole(600);

    expect(fellAt).not.toBeNull();
    expect(diedAt).not.toBeNull();
    // Смерть — не в тике провала: снижение занимает `deathDepth / speed` = 30
    // шагов, первый из которых делается на самом тике провала (`FallDeath`
    // идёт после `FallStart` в том же тике). Столько же длится снижение модели
    // в рендере: 7.5 единиц на 15 единицах в секунду при 60 Гц (REND-12).
    expect(diedAt! - fellAt!).toBe(29);

    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(true);
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(true);
    // Управление отобрано на входе в провал: конфигурации локомоушена нет.
    // Скорость при этом не трогается — импульс, с которым герой влетел в дыру,
    // сохраняется, и он падает по дуге, а не оседает отвесно на месте.
    expect(coreWorld.hasComponent(state.world, playerId, 'Locomotion')).toBe(false);
    expect(coreWorld.getField(state.world, playerId, 'Velocity', 'y')).toBeGreaterThan(0);
    expect(atY).toBeGreaterThan(fellAtY);
    // Override уровня (ARENA-6): падающий больше не выводит уровень из позиции.
    expect(coreWorld.hasComponent(state.world, playerId, 'LevelOverride')).toBe(true);
  });

  it('на полу событий провала нет и герой жив', () => {
    const { sim, state, playerId } = createDemoSimulation(SCENE);
    for (let tick = 1; tick <= 60; tick++) {
      const result = simTick(
        sim,
        state,
        [{ tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 }],
      );
      for (const event of result.events) {
        expect(event.type).not.toBe('FellThroughFloor');
        expect(event.type).not.toBe('EntityDied');
      }
    }
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
  });
});
