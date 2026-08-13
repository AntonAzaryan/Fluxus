/**
 * Демо-сцена как контент (`content/scenes/duel.scene.json`): проверяется не
 * ядро, а проводка сборки демо и политика падения в пустоту, написанная в JSON.
 *
 * Механизм — за ядром (`arena` ARENA-5 эмитит `FellThroughFloor`), политика —
 * системы сцены `FallStart`/`FallDeath`: снижение по тикам и смерть по
 * достижении глубины. Тест ловит ровно то, что unit-тесты пакетов не видят:
 * сцена, у которой герой не подписан на проверку пола или у сборки нет арены,
 * тикает штатно и молча.
 *
 * Арена — диск радиуса 22 в сетке 48×48 (клетки вне вписанной окружности без
 * пола) с четырьмя плато по квадрантам и рампой к каждому со стороны центра.
 * Здесь пиннится геометрия, от которой зависит геймплей: подъём по рампе
 * действительно проходим (TERR-5), а шаг за кромку диска — провал.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  tick as simTick,
  world as coreWorld,
  type EntityId,
  type SceneDef,
  type WorldState,
} from '@game-mvp/core';
import { PLAYER_ID, createDemoSimulation } from '../demo/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

const SCENE = sceneJson as unknown as SceneDef;

/** Расстановка матча дуэли (SER-8): по ней спавнятся оба героя. */
const MATCH = matchJson as unknown as {
  readonly initial: readonly {
    readonly prefab: string;
    readonly overrides?: { readonly Position?: { readonly x: number; readonly y: number } };
  }[];
};

/** Центр диска и его радиус — те же числа, что в секции `arena` сцены. */
const CENTER = 24;

/**
 * Путь до плато северо-западного квадранта (уровень 2): обойти плато с юга,
 * подняться по коридору центра к подножию рампы и войти на неё с востока —
 * рампа подходит к плато со стороны середины арены.
 */
const RAMP_PATH: readonly (readonly [number, number])[] = [
  [8.5, 20.5],
  [20.5, 20.5],
  [20.5, 14.5],
  [17.5, 14.5],
];

/** Уровень плато, на которое ведёт `RAMP_PATH`. */
const RAMP_PLATFORM_LEVEL = 2;

/** Мировая координата героя в единицах клеток — по ней и строится маршрут. */
function positionOf(world: WorldState, entity: EntityId, field: 'x' | 'y'): number {
  return coreWorld.getField(world, entity, 'Position', field) / FIXED_ONE;
}

/**
 * Ход по маршруту осевыми шагами: по каждой оси ввод держится, пока цель
 * дальше допуска. Диагоналей нет намеренно — ввод сцены нормализуется, и
 * осевой шаг делает маршрут воспроизводимым.
 */
function walkPath(path: readonly (readonly [number, number])[], limit: number) {
  const demo = createDemoSimulation(SCENE);
  const { sim, state, playerId, terrain } = demo;
  const TOLERANCE = 0.3;
  let leg = 0;
  let tickNo = 0;
  while (leg < path.length && tickNo < limit) {
    tickNo += 1;
    const [targetX, targetY] = path[leg]!;
    const dx = targetX - positionOf(state.world, playerId, 'x');
    const dy = targetY - positionOf(state.world, playerId, 'y');
    if (Math.abs(dx) <= TOLERANCE && Math.abs(dy) <= TOLERANCE) {
      leg += 1;
      continue;
    }
    // Сначала выравнивается ось с большим остатком: путь состоит из осевых
    // отрезков, и второй остаток на каждом из них уже нулевой.
    const move =
      Math.abs(dx) > Math.abs(dy)
        ? { x: dx > 0 ? FIXED_ONE : -FIXED_ONE, y: 0 }
        : { x: 0, y: dy > 0 ? FIXED_ONE : -FIXED_ONE };
    simTick(sim, state, [
      { tick: tickNo, playerId: PLAYER_ID, seq: tickNo, move, aimDir: 0, buttons: 0 },
    ]);
  }
  return { ...demo, terrain, legsDone: leg, ticks: tickNo };
}

/** Уход на запад до края диска: пола там нет, и герой проваливается. */
function walkOffTheEdge(limit: number) {
  const { sim, state, playerId } = createDemoSimulation(SCENE);
  let fellAt: number | null = null;
  let diedAt: number | null = null;
  let fellAtX = 0;
  for (let tick = 1; tick <= limit; tick++) {
    const result = simTick(sim, state, [
      {
        tick,
        playerId: PLAYER_ID,
        seq: tick,
        move: { x: -FIXED_ONE, y: 0 },
        aimDir: 0,
        buttons: 0,
      },
    ]);
    for (const event of result.events) {
      if (event.type === 'FellThroughFloor' && fellAt === null) {
        fellAt = tick;
        fellAtX = positionOf(state.world, playerId, 'x');
      }
      if (event.type === 'EntityDied' && diedAt === null) diedAt = tick;
    }
    if (diedAt !== null) break;
  }
  return { state, playerId, fellAt, diedAt, fellAtX, atX: positionOf(state.world, playerId, 'x') };
}

describe('демо-сцена: кромка диска и смерть в пустоте (ARENA-5)', () => {
  it('герой доходит до кромки, проваливается и умирает достигнув глубины', () => {
    const { state, playerId, fellAt, diedAt, fellAtX, atX } = walkOffTheEdge(600);

    expect(fellAt).not.toBeNull();
    expect(diedAt).not.toBeNull();
    // Смерть — не в тике провала: снижение занимает `deathDepth / speed` = 300
    // шагов, первый из которых делается на самом тике провала (`FallDeath`
    // идёт после `FallStart` в том же тике). Столько же длится снижение модели
    // в рендере: 75 единиц на 15 единицах в секунду при 60 Гц (REND-12).
    expect(diedAt! - fellAt!).toBe(299);
    // Провал случился на западной кромке диска, а не где-то в его середине.
    expect(fellAtX).toBeLessThan(CENTER - 21);

    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(true);
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(true);
    // Управление отобрано на входе в провал: конфигурации локомоушена нет.
    // Скорость при этом не трогается — импульс, с которым герой ушёл за кромку,
    // сохраняется, и он падает по дуге, а не оседает отвесно на месте.
    expect(coreWorld.hasComponent(state.world, playerId, 'Locomotion')).toBe(false);
    expect(coreWorld.getField(state.world, playerId, 'Velocity', 'x')).toBeLessThan(0);
    expect(atX).toBeLessThan(fellAtX);
    // Override уровня (ARENA-6): падающий больше не выводит уровень из позиции.
    expect(coreWorld.hasComponent(state.world, playerId, 'LevelOverride')).toBe(true);
  });

  it('зажатая кнопка каста не спамит фаерболы: каст ловит фронт (INP-2)', () => {
    // Held-семантика ввода (INP-2) даёт бит во всех тиках удержания; детектор
    // фронта в JSON-системе `Cast` (`buttons && !prevButtons`) обязан сработать
    // ровно один раз на нажатие — иначе слой ввода сломал бы существующий
    // контент.
    const { sim, state } = createDemoSimulation(SCENE);
    const CAST = 1 << 0;
    const fireballs = (): number => {
      let count = 0;
      for (const entity of coreWorld.listAlive(state.world)) {
        if (coreWorld.hasTag(state.world, entity, 'Fireball')) count += 1;
      }
      return count;
    };

    for (let tick = 1; tick <= 10; tick++) {
      simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons: CAST },
      ]);
    }
    expect(fireballs()).toBe(1);

    // Отпустил и нажал снова — второй фаербол, фронт не потерялся.
    simTick(sim, state, [
      { tick: 11, playerId: PLAYER_ID, seq: 11, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 },
    ]);
    simTick(sim, state, [
      { tick: 12, playerId: PLAYER_ID, seq: 12, move: { x: 0, y: 0 }, aimDir: 0, buttons: CAST },
    ]);
    expect(fireballs()).toBe(2);
  });

  it('на полу событий провала нет и герой жив', () => {
    const { sim, state, playerId } = createDemoSimulation(SCENE);
    for (let tick = 1; tick <= 60; tick++) {
      const result = simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 },
      ]);
      for (const event of result.events) {
        expect(event.type).not.toBe('FellThroughFloor');
        expect(event.type).not.toBe('EntityDied');
      }
    }
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
  });
});

describe('демо-сцена: подъём по рампе на плато (TERR-5, TERR-7)', () => {
  it('герой проходит рампу и оказывается на уровне плато', () => {
    const { state, playerId, terrain, legsDone } = walkPath(RAMP_PATH, 1200);

    // Маршрут пройден целиком: упёршись в обрыв, герой не дошёл бы до цели.
    expect(legsDone).toBe(RAMP_PATH.length);
    expect(terrain.levelOf(playerId)).toBe(RAMP_PLATFORM_LEVEL);
    // Провала по дороге не случилось: рампа и плато — клетки с полом.
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
  });

  it('подъём идёт ступенями по единице: уровень растёт, а не прыгает', () => {
    // Рампа плато уровня 2 — одна полоса уровня 1: на пути от подножия до
    // плато встречаются ровно уровни 0, 1, 2, каждый следующий на единицу выше.
    const seen: number[] = [];
    const demo = createDemoSimulation(SCENE);
    const { sim, state, playerId, terrain } = demo;
    let tickNo = 0;
    for (const [targetX, targetY] of RAMP_PATH) {
      while (tickNo < 1200) {
        const dx = targetX - positionOf(state.world, playerId, 'x');
        const dy = targetY - positionOf(state.world, playerId, 'y');
        if (Math.abs(dx) <= 0.3 && Math.abs(dy) <= 0.3) break;
        tickNo += 1;
        const move =
          Math.abs(dx) > Math.abs(dy)
            ? { x: dx > 0 ? FIXED_ONE : -FIXED_ONE, y: 0 }
            : { x: 0, y: dy > 0 ? FIXED_ONE : -FIXED_ONE };
        simTick(sim, state, [
          { tick: tickNo, playerId: PLAYER_ID, seq: tickNo, move, aimDir: 0, buttons: 0 },
        ]);
        const level = terrain.levelOf(playerId);
        if (seen[seen.length - 1] !== level) seen.push(level);
      }
    }
    expect(seen).toEqual([0, 1, RAMP_PLATFORM_LEVEL]);
  });
});

describe('демо-матч: симметричный спавн героев на полу диска', () => {
  it('обе записи расстановки стоят на полу, на земле и зеркально центру', () => {
    const { terrain } = createDemoSimulation(SCENE);
    const positions = MATCH.initial.map((entry) => entry.overrides?.Position);
    expect(positions.every((p) => p !== undefined)).toBe(true);

    for (const position of positions as { x: number; y: number }[]) {
      expect(terrain.hasFloorAt(position)).toBe(true);
      expect(terrain.levelAt(position)).toBe(0);
      expect(position.y / FIXED_ONE).toBe(CENTER);
    }

    const [p1, p2] = positions as { x: number; y: number }[];
    const left = p1!.x / FIXED_ONE;
    const right = p2!.x / FIXED_ONE;
    expect(left).toBeLessThan(CENTER);
    expect(right).toBeGreaterThan(CENTER);
    expect(CENTER - left).toBe(right - CENTER);
  });
});
