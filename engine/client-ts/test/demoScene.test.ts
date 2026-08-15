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
 * Арена — диск пола радиуса ~22 в сетке 48×48 (клетки вне вписанной окружности
 * без пола) с четырьмя плато по квадрантам и рампой к каждому со стороны
 * центра. Здесь пиннится геометрия, от которой зависит геймплей: подъём по
 * КАЖДОЙ из четырёх рамп действительно проходим (TERR-5), а шаг за кромку
 * диска — с любой стороны провал.
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

/** Центр арены — те же числа, что в секции `arena` сцены. */
const CENTER = 24;
/** Радиус круга арены (ARENA-1); диск пола заведомо шире него. */
const ARENA_RADIUS = 21;

type Waypoint = readonly [number, number];

/**
 * Маршрут к плато квадранта. Каждый начинается на спавне p1 и идёт по
 * свободному коридору центра до подножия рампы: рампа подходит к плато со
 * стороны середины арены, и войти на неё можно только с земляной клетки её же
 * колонки — бока полос выше первой отделены от земли обрывами в два уровня.
 */
interface RampRoute {
  readonly name: string;
  readonly level: number;
  readonly path: readonly Waypoint[];
}

const RAMP_ROUTES: readonly RampRoute[] = [
  // СЗ, уровень 2: одна полоса рампы в колонке 19, вход с земли колонки 20.
  { name: 'СЗ', level: 2, path: [[8.5, 20.5], [20.5, 20.5], [20.5, 14.5], [17.5, 14.5]] },
  // СВ, уровень 3: полосы 28 и 27, вход с земли колонки 26.
  { name: 'СВ', level: 3, path: [[26.5, 24.5], [26.5, 14.5], [29.5, 14.5]] },
  // ЮЗ, уровень 4: полосы 19–21, вход с земли колонки 22.
  { name: 'ЮЗ', level: 4, path: [[22.5, 24.5], [22.5, 32.5], [17.5, 32.5]] },
  // ЮВ, уровень 5: полосы 25–28, вход с земли колонки 24.
  { name: 'ЮВ', level: 5, path: [[24.5, 24.5], [24.5, 32.5], [29.5, 32.5]] },
];

/** Мировая координата героя в единицах клеток — по ней и строится маршрут. */
function positionOf(world: WorldState, entity: EntityId, field: 'x' | 'y'): number {
  return coreWorld.getField(world, entity, 'Position', field) / FIXED_ONE;
}

/**
 * Ход по маршруту осевыми шагами: по каждой оси ввод держится, пока цель
 * дальше допуска. Диагоналей нет намеренно — ввод сцены нормализуется, и
 * осевой шаг делает маршрут воспроизводимым. `onTick` зовётся после каждого
 * ПРОТИКАННОГО тика: наблюдение за дорогой — дело вызывающего, а второго
 * прохода по тому же маршруту ради него заводить незачем.
 */
function walkPath(
  path: readonly Waypoint[],
  limit: number,
  onTick?: (demo: ReturnType<typeof createDemoSimulation>) => void,
) {
  const demo = createDemoSimulation(SCENE);
  const { sim, state, playerId } = demo;
  const TOLERANCE = 0.3;
  let leg = 0;
  let ticks = 0;
  while (leg < path.length && ticks < limit) {
    const [targetX, targetY] = path[leg]!;
    const dx = targetX - positionOf(state.world, playerId, 'x');
    const dy = targetY - positionOf(state.world, playerId, 'y');
    if (Math.abs(dx) <= TOLERANCE && Math.abs(dy) <= TOLERANCE) {
      // Точка маршрута достигнута — тик на это не тратится.
      leg += 1;
      continue;
    }
    // Сначала выравнивается ось с большим остатком: путь состоит из осевых
    // отрезков, и второй остаток на каждом из них уже нулевой.
    const move =
      Math.abs(dx) > Math.abs(dy)
        ? { x: dx > 0 ? FIXED_ONE : -FIXED_ONE, y: 0 }
        : { x: 0, y: dy > 0 ? FIXED_ONE : -FIXED_ONE };
    ticks += 1;
    simTick(sim, state, [
      { tick: ticks, playerId: PLAYER_ID, seq: ticks, move, aimDir: 0, buttons: 0 },
    ]);
    onTick?.(demo);
  }
  return { ...demo, legsDone: leg, ticks };
}

/** Уход по прямой до кромки диска: пола там нет, и герой проваливается. */
function walkOffTheEdge(direction: -1 | 1, limit: number) {
  const { sim, state, playerId } = createDemoSimulation(SCENE);
  let fellAt: number | null = null;
  let diedAt: number | null = null;
  let leftAt: number | null = null;
  let fellAtX = 0;
  for (let tick = 1; tick <= limit; tick++) {
    const result = simTick(sim, state, [
      {
        tick,
        playerId: PLAYER_ID,
        seq: tick,
        move: { x: direction * FIXED_ONE, y: 0 },
        aimDir: 0,
        buttons: 0,
      },
    ]);
    for (const event of result.events) {
      if (event.type === 'LeftArena' && leftAt === null) leftAt = tick;
      if (event.type === 'FellThroughFloor' && fellAt === null) {
        fellAt = tick;
        fellAtX = positionOf(state.world, playerId, 'x');
      }
      if (event.type === 'EntityDied' && diedAt === null) diedAt = tick;
    }
    if (diedAt !== null) break;
  }
  return { state, playerId, fellAt, diedAt, leftAt, fellAtX, atX: positionOf(state.world, playerId, 'x') };
}

describe('демо-сцена: кромка диска и смерть в пустоте (ARENA-5)', () => {
  for (const [side, direction, beyond] of [
    ['западной', -1, (x: number): boolean => x < CENTER - ARENA_RADIUS],
    ['восточной', 1, (x: number): boolean => x > CENTER + ARENA_RADIUS],
  ] as const) {
    it(`герой доходит до ${side} кромки, проваливается и умирает достигнув глубины`, () => {
      const { state, playerId, fellAt, diedAt, leftAt, fellAtX, atX } = walkOffTheEdge(direction, 1200);

      expect(fellAt).not.toBeNull();
      expect(diedAt).not.toBeNull();
      // Смерть — не в тике провала: снижение занимает `deathDepth / speed` = 300
      // шагов, первый из которых делается на самом тике провала (`FallDeath`
      // идёт после `FallStart` в том же тике). Столько же длится снижение модели
      // в рендере: 75 единиц на 15 единицах в секунду при 60 Гц (REND-12).
      expect(diedAt! - fellAt!).toBe(299);
      // Круг арены вложен в диск пола: выход за него случается СТРОГО раньше
      // провала, и политика, повешенная на `LeftArena`, успевает сработать по
      // ещё стоящему на полу герою (ARENA-1..5).
      expect(leftAt).not.toBeNull();
      expect(leftAt!).toBeLessThan(fellAt!);
      // Провал случился на кромке диска, а не где-то в его середине.
      expect(beyond(fellAtX)).toBe(true);

      expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(true);
      expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(true);
      // Управление отобрано на входе в провал: конфигурации локомоушена нет.
      // Скорость при этом не трогается — импульс, с которым герой ушёл за кромку,
      // сохраняется, и он падает по дуге, а не оседает отвесно на месте.
      expect(coreWorld.hasComponent(state.world, playerId, 'Locomotion')).toBe(false);
      expect(
        coreWorld.getField(state.world, playerId, 'Velocity', 'x') * direction,
      ).toBeGreaterThan(0);
      expect((atX - fellAtX) * direction).toBeGreaterThan(0);
      // Override уровня (ARENA-6): падающий больше не выводит уровень из позиции.
      expect(coreWorld.hasComponent(state.world, playerId, 'LevelOverride')).toBe(true);
    });
  }

  it('зажатая кнопка каста копит заряд и стреляет ровно раз — на отпускании (INP-2)', () => {
    // Held-семантика ввода (INP-2) даёт бит во всех тиках удержания. Каст
    // ловит фронт (`ChargeStart`), выстрел — ОТСУТСТВИЕ бита на фоне прошлого
    // тика (`ChargeRelease`): удержание не спамит снарядами, а копит заряд, и
    // на одно нажатие приходится ровно один снаряд.
    const { sim, state, playerId } = createDemoSimulation(SCENE);
    const CAST = 1 << 0;
    const fireballs = (): number => {
      let count = 0;
      for (const entity of coreWorld.listAlive(state.world)) {
        if (coreWorld.hasTag(state.world, entity, 'Fireball')) count += 1;
      }
      return count;
    };
    /** Все снаряды, ЖИВШИЕ за прогон: долетевший исчезает, и живого счёта мало. */
    const spawned = new Set<EntityId>();
    const step = (tick: number, buttons: number): void => {
      simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move: { x: 0, y: 0 }, aimDir: 0, buttons },
      ]);
      for (const entity of coreWorld.listAlive(state.world)) {
        if (coreWorld.hasTag(state.world, entity, 'Fireball')) spawned.add(entity);
      }
    };

    for (let tick = 1; tick <= 10; tick++) step(tick, CAST);
    // Кнопка всё ещё зажата — снаряда нет, есть заряд.
    expect(fireballs()).toBe(0);
    expect(coreWorld.hasComponent(state.world, playerId, 'Charging')).toBe(true);

    step(11, 0);
    expect(fireballs()).toBe(1);
    expect(coreWorld.hasComponent(state.world, playerId, 'Charging')).toBe(false);

    // Повторное нажатие на неостывшем кулдауне заряда не начинает.
    expect(coreWorld.getField(state.world, playerId, 'Cooldowns', 'cast')).toBeGreaterThan(0);
    step(12, CAST);
    expect(coreWorld.hasComponent(state.world, playerId, 'Charging')).toBe(false);
    expect(fireballs()).toBe(1);

    // Второй цикл «нажал-отпустил» после кулдауна даёт ВТОРОЙ снаряд: удержание
    // не спамит, но и не запирает способность навсегда. Считаются РОДИВШИЕСЯ
    // за прогон, а не живые: первый снаряд к этому времени долетел и исчез.
    expect(spawned.size).toBe(1);
    let tick = 13;
    while (coreWorld.getField(state.world, playerId, 'Cooldowns', 'cast') > 0) {
      step(tick, 0);
      tick += 1;
    }
    step(tick, CAST);
    step(tick + 1, 0);
    expect(spawned.size).toBe(2);
    expect(fireballs()).toBe(1);
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

describe('демо-сцена: подъём по рампам всех четырёх квадрантов (TERR-5, TERR-7)', () => {
  for (const route of RAMP_ROUTES) {
    it(`${route.name}: герой проходит рампу ступенями по единице до уровня ${route.level}`, () => {
      // Уровни собираются по дороге: подъём обязан идти ступенями по единице,
      // а не прыжком через обрыв, — и последняя ступень равна уровню плато.
      const seen: number[] = [];
      const { state, playerId, terrain, legsDone } = walkPath(route.path, 1500, (demo) => {
        const level = demo.terrain.levelOf(demo.playerId);
        if (seen[seen.length - 1] !== level) seen.push(level);
      });

      // Маршрут пройден целиком: упёршись в обрыв, герой не дошёл бы до цели.
      expect(legsDone).toBe(route.path.length);
      expect(terrain.levelOf(playerId)).toBe(route.level);
      expect(seen).toEqual(Array.from({ length: route.level + 1 }, (_, i) => i));
      // Провала по дороге не случилось: рампа и плато — клетки с полом.
      expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
      expect(coreWorld.hasComponent(state.world, playerId, 'Dead')).toBe(false);
    });
  }
});

describe('демо-матч: симметричный спавн героев на полу диска', () => {
  it('обе записи расстановки стоят в центрах клеток, на земле и зеркально центру', () => {
    const { terrain, grid } = createDemoSimulation(SCENE);
    const positions = MATCH.initial.map((entry) => entry.overrides?.Position);
    expect(positions.every((p) => p !== undefined)).toBe(true);

    for (const position of positions as { x: number; y: number }[]) {
      expect(terrain.hasFloorAt(position)).toBe(true);
      expect(terrain.levelAt(position)).toBe(0);
      // Ряд спавна — тот, в котором лежит центр арены.
      expect(Math.floor(position.y / FIXED_ONE)).toBe(CENTER);
    }

    const [p1, p2] = positions as { x: number; y: number }[];
    const left = p1!.x / FIXED_ONE;
    const right = p2!.x / FIXED_ONE;
    expect(left).toBeLessThan(CENTER);
    expect(right).toBeGreaterThan(CENTER);
    // Зеркальны и мировые позиции, и клетки под ними: спавн в центре клетки, а
    // не в её углу, — иначе одна из двух позиций разрешалась бы в клетку-соседа.
    expect(CENTER - left).toBe(right - CENTER);
    expect(Math.floor(left) + Math.floor(right)).toBe(grid.width - 1);
  });
});
