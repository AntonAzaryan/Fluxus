/**
 * Бой демо-арены как контент: настоящая `content/scenes/duel.scene.json`,
 * настоящий `content/matches/duel.match.json` и сценарные `InputFrame`.
 *
 * Проверяется не ядро, а ПОЛИТИКА, написанная в JSON: заряд фаербола, щит с
 * рикошетом, перехват снаряда, лок манёвров, реген, смерть и респавн. Мир
 * поднимается тем же `buildMatchWorld`, каким его поднимают сервер и клиент
 * (NTR-14), а не собирается тестом заново, — иначе проверялась бы сборка
 * теста, а не сборка матча.
 *
 * Расстановка у каждого сценария своя: героев сцены разносит на 31 единицу, и
 * ждать снаряд две сотни тиков ради проверки урона незачем. Расстановка —
 * поле документа прогона (SER-8), поэтому подмена её здесь не трогает ни
 * сцену, ни матч.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  tick as simTick,
  world as coreWorld,
  worldInitHash,
  type EntityId,
  type InputFrame,
  type ScenarioSpawn,
  type SimulationState,
  type Simulation,
} from '@game-mvp/core';
import { buildMatchWorld } from '@game-mvp/net';
import { ACTION_BITS, PLAYER_ID, createDemoSimulation } from '../demo/sim.js';
import { demoMatchConfig } from '../demo/match.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import type { SceneDef } from '@game-mvp/core';

const SCENE = sceneJson as unknown as SceneDef;
const MATCH = demoMatchConfig();

const F = (units: number): number => Math.round(units * FIXED_ONE);
const units = (raw: number): number => raw / FIXED_ONE;

const CAST = 1 << ACTION_BITS.cast;
const SHIELD = 1 << ACTION_BITS.shield;
const CATCH = 1 << ACTION_BITS.catch;
const DODGE = 1 << ACTION_BITS.dodge;

/** Направления прицела: доля оборота в Q16.16 (EXPR-2), 0 — на восток. */
const EAST = 0;
const WEST = 0x8000;

/** Числа боя, вокруг которых написаны ожидания, — те же, что в сцене. */
const CHARGE_TICKS = 60;
const OVERCHARGE_TICKS = 18;
const SHIELD_TICKS = 18;
const CARRY_TICKS = 24;
const CAST_COOLDOWN = 90;
const RESPAWN_DELAY = 180;

interface Duel {
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly p1: EntityId;
  readonly p2: EntityId;
  /** Прогоняет один тик указанными кнопками игроков и отдаёт типы событий. */
  step(buttons?: { p1?: number; p2?: number }, aim?: { p1?: number; p2?: number }): string[];
  /** Все типы событий, случившиеся за прогон, с номером тика. */
  readonly log: { tick: number; type: string }[];
}

interface Placement {
  readonly x: number;
  readonly y: number;
  /** Стартовое здоровье: сценарий смерти не обязан выбивать все 500 (SER-8). */
  readonly hp?: number;
}

/**
 * Дуэль двух героев на настоящей сцене. Позиции задаются расстановкой прогона,
 * точка респавна — той же записью: у героя она своя, и респавн обязан вернуть
 * его именно туда, откуда он начал.
 */
function duel(first: Placement, second: Placement): Duel {
  const spawn = (slot: number, at: Placement): ScenarioSpawn => ({
    prefab: 'Hero',
    overrides: {
      Player: { slot },
      Position: { x: F(at.x), y: F(at.y) },
      Respawn: { x: F(at.x), y: F(at.y) },
      ...(at.hp !== undefined ? { Health: { hp: F(at.hp) } } : {}),
    },
  });
  const built = buildMatchWorld({
    scene: SCENE,
    seed: MATCH.seed,
    players: [...MATCH.players],
    initial: [spawn(0, first), spawn(1, second)],
    ...(MATCH.physics !== undefined ? { physics: MATCH.physics } : {}),
    ...(MATCH.locomotion !== undefined ? { locomotion: MATCH.locomotion } : {}),
  });
  const heroes = [...coreWorld.listAlive(built.state.world)].filter((entity) =>
    coreWorld.hasTag(built.state.world, entity, 'Hero'),
  );
  const [p1, p2] = heroes as [EntityId, EntityId];
  const log: { tick: number; type: string }[] = [];
  const aimState = { p1: EAST, p2: WEST };

  return {
    sim: built.sim,
    state: built.state,
    p1,
    p2,
    log,
    step(buttons = {}, aim = {}) {
      if (aim.p1 !== undefined) aimState.p1 = aim.p1;
      if (aim.p2 !== undefined) aimState.p2 = aim.p2;
      const at = built.state.tick + 1;
      const frames: InputFrame[] = MATCH.players.map((playerId, slot) => ({
        tick: at,
        playerId,
        seq: at,
        move: { x: 0, y: 0 },
        aimDir: slot === 0 ? aimState.p1 : aimState.p2,
        buttons: (slot === 0 ? buttons.p1 : buttons.p2) ?? 0,
      }));
      const result = simTick(built.sim, built.state, frames);
      const types = [...result.events].map((event) => event.type);
      for (const type of types) log.push({ tick: at, type });
      return types;
    },
  };
}

const field = (duel: Duel, entity: EntityId, component: string, name: string): number =>
  coreWorld.getField(duel.state.world, entity, component, name);
const hp = (d: Duel, entity: EntityId): number => units(field(d, entity, 'Health', 'hp'));
const has = (d: Duel, entity: EntityId, component: string): boolean =>
  coreWorld.hasComponent(d.state.world, entity, component);

/** Живые снаряды сцены — по тегу prefab'а, а не по составу компонентов. */
function fireballs(d: Duel): EntityId[] {
  return [...coreWorld.listAlive(d.state.world)].filter((entity) =>
    coreWorld.hasTag(d.state.world, entity, 'Fireball'),
  );
}

function tagged(d: Duel, tag: string): EntityId[] {
  return [...coreWorld.listAlive(d.state.world)].filter((entity) =>
    coreWorld.hasTag(d.state.world, entity, tag),
  );
}

/** Тап каста: нажатие открывает заряд, отпускание стреляет накопленным. */
function tapCast(d: Duel, who: 'p1' | 'p2'): void {
  d.step({ [who]: CAST });
  d.step({});
}

/** Прогон до первого события типа `type`; отдаёт тик или null. */
function runUntil(d: Duel, type: string, limit: number, buttons: () => object = () => ({})): number | null {
  for (let i = 0; i < limit; i++) {
    if (d.step(buttons()).includes(type)) return d.state.tick;
  }
  return null;
}

// --------------------------------------------------------------------- фаербол

describe('фаербол демо-арены: тап, заряд и перезаряд', () => {
  it('тап наносит 100 и уводит каст на 90 тиков перезарядки', () => {
    const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    tapCast(d, 'p1');

    // Перезарядка встала на тике выстрела; следующий тик уже её сдвинул.
    expect(field(d, d.p1, 'Cooldowns', 'cast')).toBe(CAST_COOLDOWN);
    const ball = fireballs(d)[0]!;
    expect(units(field(d, ball, 'Damage', 'amount'))).toBe(100);
    expect(field(d, ball, 'Owner', 'entity')).toBe(d.p1);

    const at = runUntil(d, 'FireballHit', 60);
    expect(at).not.toBeNull();
    // Урон снят на том же тике: реген (order 12) прошёл раньше попадания и
    // упёрся в потолок, поэтому здесь ровно 500 − 100.
    expect(hp(d, d.p2)).toBe(400);
    expect(fireballs(d)).toHaveLength(0);
    expect(field(d, d.p1, 'Cooldowns', 'cast')).toBe(CAST_COOLDOWN - (at! - 2));
  });

  it('заряд в 60 тиков даёт 400 урона и снаряд вдвое крупнее', () => {
    const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    const tap = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    tapCast(tap, 'p1');
    const small = field(tap, fireballs(tap)[0]!, 'Collider', 'radius');

    // Нажатие + 60 тиков удержания: на отпускании накоплено ровно 60.
    d.step({ p1: CAST });
    for (let i = 0; i < CHARGE_TICKS; i++) d.step({ p1: CAST });
    expect(field(d, d.p1, 'Charging', 'ticks')).toBe(CHARGE_TICKS);
    d.step({});

    const ball = fireballs(d)[0]!;
    expect(units(field(d, ball, 'Damage', 'amount'))).toBe(400);
    expect(field(d, ball, 'Collider', 'radius')).toBe(small * 2);

    expect(runUntil(d, 'FireballHit', 60)).not.toBeNull();
    expect(hp(d, d.p2)).toBe(100);
  });

  it('передержанный заряд рвёт в руках: 250 по кругу и ни одного снаряда', () => {
    // Второй герой — внутри радиуса взрыва: под раздачу попадают все, включая
    // самого кастера.
    const d = duel({ x: 22, y: 24 }, { x: 24, y: 24 });
    d.step({ p1: CAST });
    // Порог — chargeTicks + overchargeTicks; рвёт на тике, где счётчик его превысил.
    for (let i = 0; i < CHARGE_TICKS + OVERCHARGE_TICKS; i++) {
      expect(d.step({ p1: CAST })).not.toContain('FireballExploded');
    }
    expect(d.step({ p1: CAST })).toContain('FireballExploded');

    expect(fireballs(d)).toHaveLength(0);
    expect(has(d, d.p1, 'Charging')).toBe(false);
    expect(hp(d, d.p1)).toBe(250);
    expect(hp(d, d.p2)).toBe(250);
    expect(field(d, d.p1, 'Cooldowns', 'cast')).toBe(CAST_COOLDOWN);
  });
});

// ----------------------------------------------------------------------- щит

describe('щит демо-арены: поглощение и рикошет', () => {
  it('снаряд отражается от щита нормалью контакта и меняет владельца', () => {
    const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    tapCast(d, 'p1');
    const ball = fireballs(d)[0]!;
    const speed = field(d, ball, 'Velocity', 'x');
    expect(speed).toBeGreaterThan(0);

    // Щит поднимается заранее и живёт 18 тиков — снаряд успевает доехать.
    const raised = d.state.tick + 1;
    d.step({ p2: SHIELD });
    expect(has(d, d.p2, 'Shielded')).toBe(true);
    expect(tagged(d, 'Shield')).toHaveLength(1);

    const at = runUntil(d, 'FireballRicochet', SHIELD_TICKS);
    expect(at).not.toBeNull();
    // Лобовое попадание в круг щита: нормаль (−1, 0), и v′ = v − 2(v·n)n
    // разворачивает скорость точно, без потери модуля.
    expect(field(d, ball, 'Velocity', 'x')).toBe(-speed);
    expect(field(d, ball, 'Velocity', 'y')).toBe(0);
    // Владелец сменился на хозяина щита — отражённый снаряд бьёт кастера.
    expect(field(d, ball, 'Owner', 'entity')).toBe(d.p2);
    expect(hp(d, d.p2)).toBe(500);

    expect(runUntil(d, 'FireballHit', 60)).not.toBeNull();
    expect(hp(d, d.p1)).toBe(400);

    // Щит — короткоживущая сущность: 18 тиков, и ни щита, ни состояния.
    while (d.state.tick < raised + SHIELD_TICKS) d.step();
    expect(tagged(d, 'Shield')).toHaveLength(0);
    expect(has(d, d.p2, 'Shielded')).toBe(false);
  });

  it('щит держит и площадной урон: под взрывом заряда защищённый цел', () => {
    const d = duel({ x: 22, y: 24 }, { x: 24, y: 24 });
    d.step({ p1: CAST });
    for (let i = 0; i < CHARGE_TICKS + OVERCHARGE_TICKS - 1; i++) d.step({ p1: CAST });
    // Щит поднят на предпоследнем тике заряда: взрыв застаёт его живым.
    d.step({ p1: CAST, p2: SHIELD });
    expect(d.step({ p1: CAST })).toContain('FireballExploded');

    expect(hp(d, d.p1)).toBe(250);
    expect(hp(d, d.p2)).toBe(500);
  });

  it('щит не поднимается во время заряда: каст занят, кнопка молчит', () => {
    const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    d.step({ p1: CAST });
    expect(has(d, d.p1, 'Charging')).toBe(true);
    d.step({ p1: CAST | SHIELD });

    expect(has(d, d.p1, 'Shielded')).toBe(false);
    expect(tagged(d, 'Shield')).toHaveLength(0);
    expect(field(d, d.p1, 'Cooldowns', 'shield')).toBe(0);
  });
});

// ------------------------------------------------------------------- перехват

/** Ловит снаряд соперника: p2 стреляет на запад, p1 держит и отпускает R. */
function catchRig(): Duel {
  const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
  tapCast(d, 'p2');
  const ball = fireballs(d)[0]!;
  // Ждём, пока снаряд войдёт в зону: конус 30° перед p1, дальность 0,3..3.
  while (units(field(d, ball, 'Position', 'x')) > 22.5) d.step();
  d.step({ p1: CATCH });
  expect(coreWorld.hasComponent(d.state.world, d.p1, 'Catching')).toBe(true);
  d.step({});
  return d;
}

describe('перехват демо-арены: зона, ловля и бросок', () => {
  it('зона перехвата живёт, пока держат кнопку, и следует за прицелом', () => {
    const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    d.step({ p1: CATCH });
    const [zone] = tagged(d, 'CatchZone');
    expect(zone).toBeDefined();
    // Зона стоит перед героем по прицелу: смещение — поле `Follow` prefab'а.
    d.step({ p1: CATCH });
    expect(units(field(d, zone!, 'Position', 'x'))).toBeGreaterThan(20);
    expect(units(field(d, zone!, 'Position', 'y'))).toBeCloseTo(24, 5);

    d.step({});
    expect(tagged(d, 'CatchZone')).toHaveLength(0);
    expect(has(d, d.p1, 'Catching')).toBe(false);
  });

  it('снаряд в конусе ловится: скорость гаснет, владелец меняется, ловец занят', () => {
    const d = catchRig();
    const ball = fireballs(d)[0]!;

    expect(has(d, d.p1, 'Carrying')).toBe(true);
    expect(field(d, d.p1, 'Carrying', 'projectile')).toBe(ball);
    expect(field(d, ball, 'Velocity', 'x')).toBe(0);
    expect(field(d, ball, 'Owner', 'entity')).toBe(d.p1);
    // Полётный таймер снят — пойманный снаряд не истекает в руках.
    expect(has(d, d.p1, 'ActionLock')).toBe(true);
    expect(coreWorld.hasComponent(d.state.world, ball, 'Lifetime')).toBe(false);
    expect(field(d, d.p1, 'Cooldowns', 'catch')).toBeGreaterThan(0);
  });

  it('бросок в течение 0,4 с возвращает снаряд с новым владельцем', () => {
    const d = catchRig();
    const ball = fireballs(d)[0]!;
    d.step({ p1: CAST });

    expect(has(d, d.p1, 'Carrying')).toBe(false);
    expect(has(d, d.p1, 'ActionLock')).toBe(false);
    expect(field(d, ball, 'Velocity', 'x')).toBeGreaterThan(0);
    expect(field(d, ball, 'Owner', 'entity')).toBe(d.p1);

    expect(runUntil(d, 'FireballHit', 90)).not.toBeNull();
    // Урон снаряда не изменился — он всё тот же, что бросил соперник.
    expect(hp(d, d.p2)).toBe(400);
  });

  it('не брошенный за 24 тика снаряд рвёт в руках ловца', () => {
    const d = catchRig();
    for (let i = 0; i < CARRY_TICKS; i++) {
      expect(d.step()).not.toContain('FireballExploded');
    }
    expect(d.step()).toContain('FireballExploded');

    expect(fireballs(d)).toHaveLength(0);
    expect(has(d, d.p1, 'Carrying')).toBe(false);
    expect(has(d, d.p1, 'ActionLock')).toBe(false);
    expect(hp(d, d.p1)).toBe(250);
  });
});

// ----------------------------------------------------------------- лок манёвров

describe('лок манёвров (LOC-7): заряд и ноша отбирают уклон и прыжок', () => {
  it('во время заряда уклон не стартует', () => {
    const d = duel({ x: 20, y: 24 }, { x: 24, y: 24 });
    d.step({ p1: CAST });
    expect(field(d, d.p1, 'ActionLock', 'mask')).toBe(1);
    for (let i = 0; i < 4; i++) d.step({ p1: CAST | DODGE });
    expect(field(d, d.p1, 'LocomotionState', 'state')).toBe(0);
  });

  it('с пойманным снарядом уклон не стартует, а после броска — стартует', () => {
    const d = catchRig();
    for (let i = 0; i < 4; i++) d.step({ p1: DODGE });
    expect(field(d, d.p1, 'LocomotionState', 'state')).toBe(0);

    d.step({ p1: CAST });
    expect(has(d, d.p1, 'ActionLock')).toBe(false);
    // Уклону нужно направление (LOC-4) — оно приходит движением, не кнопкой,
    // поэтому здесь проверяется снятый лок, а не сам манёвр.
    expect(has(d, d.p1, 'Carrying')).toBe(false);
  });
});

// -------------------------------------------------- здоровье, смерть и респавн

describe('здоровье, смерть и респавн демо-арены', () => {
  it('реген — 10 hp в секунду и упирается в потолок', () => {
    const d = duel({ x: 20, y: 24, hp: 300 }, { x: 30, y: 24 });
    for (let i = 0; i < 60; i++) d.step();
    expect(hp(d, d.p1)).toBe(310);
    // Целый герой на потолке остаётся на потолке.
    expect(hp(d, d.p2)).toBe(500);
  });

  it('смерть от урона считается и возвращает героя на СВОЙ спавн через 3 с', () => {
    const d = duel({ x: 20, y: 24, hp: 80 }, { x: 24, y: 24 });
    tapCast(d, 'p2');
    const died = runUntil(d, 'EntityDied', 60);
    expect(died).not.toBeNull();

    expect(has(d, d.p1, 'Dead')).toBe(true);
    expect(field(d, d.p1, 'Score', 'deaths')).toBe(1);
    // Управление отобрано, скорость обнулена: труп не едет по арене.
    expect(has(d, d.p1, 'LocomotionState')).toBe(false);
    expect(field(d, d.p1, 'Velocity', 'x')).toBe(0);
    expect(field(d, d.p1, 'Respawn', 'ticks')).toBe(RESPAWN_DELAY);

    for (let i = 0; i < RESPAWN_DELAY - 1; i++) d.step();
    expect(has(d, d.p1, 'Dead')).toBe(true);
    expect(d.step()).toContain('EntityRespawned');

    expect(has(d, d.p1, 'Dead')).toBe(false);
    expect(hp(d, d.p1)).toBe(500);
    expect(units(field(d, d.p1, 'Position', 'x'))).toBe(20);
    expect(units(field(d, d.p1, 'Position', 'y'))).toBe(24);
    // Машина манёвров вернулась — герой снова управляем.
    expect(has(d, d.p1, 'LocomotionState')).toBe(true);
    expect(field(d, d.p1, 'Score', 'deaths')).toBe(1);
  });

  it('смерть в пустоте считается тем же счётчиком и возвращает на спавн', () => {
    // Одиночная сборка демо: герой сцены один, спавн — из его же prefab'а.
    const { sim, state, playerId } = createDemoSimulation(SCENE);
    const spawnX = coreWorld.getField(state.world, playerId, 'Respawn', 'x');
    let died: number | null = null;
    let respawned: number | null = null;

    for (let tick = 1; tick <= 1500; tick++) {
      // Пока жив — идём на запад к кромке диска; мёртвый ввода не получает.
      const move = { x: died === null ? -FIXED_ONE : 0, y: 0 };
      const result = simTick(sim, state, [
        { tick, playerId: PLAYER_ID, seq: tick, move, aimDir: 0, buttons: 0 },
      ]);
      for (const event of result.events) {
        if (event.type === 'EntityDied' && died === null) died = tick;
        if (event.type === 'EntityRespawned' && respawned === null) respawned = tick;
      }
      if (respawned !== null) break;
    }

    expect(died).not.toBeNull();
    expect(respawned).toBe(died! + RESPAWN_DELAY);
    expect(coreWorld.getField(state.world, playerId, 'Score', 'deaths')).toBe(1);
    expect(coreWorld.getField(state.world, playerId, 'Position', 'x')).toBe(spawnX);
    expect(coreWorld.hasComponent(state.world, playerId, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'LevelOverride')).toBe(false);
    expect(coreWorld.hasComponent(state.world, playerId, 'LocomotionState')).toBe(true);
    expect(
      coreWorld.getField(state.world, playerId, 'Health', 'hp') / FIXED_ONE,
    ).toBe(500);
  });
});

// ----------------------------------------------------------------- детерминизм

describe('детерминизм боя (DET-1)', () => {
  it('два прогона одного сценария сходятся побитово', () => {
    const script = (d: Duel): string => {
      // Заряд, щит соперника, рикошет, перехват и бросок — весь набор в одном
      // прогоне: расхождение любой из систем разведёт хеши.
      d.step({ p1: CAST });
      for (let i = 0; i < 20; i++) d.step({ p1: CAST });
      d.step({ p2: SHIELD });
      for (let i = 0; i < 40; i++) d.step({ p1: i < 10 ? CAST : 0, p2: i === 20 ? CATCH : 0 });
      for (let i = 0; i < 60; i++) d.step({ p1: i === 30 ? CAST : 0 });
      return worldInitHash({ world: d.state.world, mode: d.state.mode });
    };
    expect(script(duel({ x: 20, y: 24 }, { x: 24, y: 24 }))).toBe(
      script(duel({ x: 20, y: 24 }, { x: 24, y: 24 })),
    );
  });
});
