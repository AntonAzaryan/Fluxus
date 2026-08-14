/**
 * Способности демо-сцены как КОНТЕНТ: купол замедления и захват снаряда
 * (`content/scenes/duel.scene.json`, JSON-системы `DomeCast`/`DomeSlow`/
 * `DomeExpire`/`CaptureRelease`/`ThrowHeld`/`HeldPin`).
 *
 * Проверяется не ядро — механизмы (`time` TIME-7/TIME-8, `locomotion` LOC-7,
 * Query API, Command Buffer) уже закрыты своими unit-тестами, — а политика,
 * написанная в JSON: кого купол замедляет и на сколько, кого не трогает, что
 * происходит с владельцем снаряда после переброса и чем кончается невыброшенный
 * захват. Ровно это unit-тесты пакетов не видят: сцена, у которой снаряд не
 * несёт владельца или купол ставит модификатор всем подряд, тикает штатно и
 * молча.
 *
 * Мир поднимается той же сборкой, что матч демо (`buildMatchWorld`, NTR-14):
 * двое игроков в сцене есть только в матче, а расстановка здесь своя —
 * спавн-точки арены разнесены на треть карты, и снаряд летел бы до соперника
 * дольше, чем длится любая из способностей.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  tick as simTick,
  world as coreWorld,
  type EntityId,
  type SceneDef,
  type SimulationState,
  type Simulation,
} from '@game-mvp/core';
import { buildMatchWorld } from '@game-mvp/net';
import { ACTION_BITS } from '../demo/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

const SCENE = sceneJson as unknown as SceneDef;
const MATCH = matchJson as unknown as {
  readonly seed: number;
  readonly players: readonly string[];
  readonly locomotion: Record<string, unknown>;
};

const CAST = 1 << ACTION_BITS.cast;
const DOME = 1 << ACTION_BITS.slowDome;
const CAPTURE = 1 << ACTION_BITS.capture;

/** Прицел в единицах угла ядра (FP-7): полный оборот — 65536. */
const AIM_EAST = 0;
const AIM_WEST = 0x8000;

/** Множитель купола и предел замедления — те же числа, что в `AbilityConfig`. */
const SLOW = 16384;
const DOME_TICKS = 120;
const DOME_COOLDOWN = 600;
const CAPTURE_COOLDOWN = 120;
const HOLD_TICKS = 24;
const EXPLOSION_DAMAGE = 250;

interface Arena {
  readonly sim: Simulation;
  readonly state: SimulationState;
  /** Герои в порядке слотов: `p1` — нулевой, `p2` — первый. */
  readonly heroes: readonly EntityId[];
  /** Тик с явными вводами обоих слотов; возвращает номер тика. */
  step: (a: Frame, b?: Frame) => number;
}

interface Frame {
  readonly buttons?: number;
  readonly aimDir?: number;
}

const NEUTRAL: Frame = {};

/**
 * Двое героев на одной линии в центре арены: `p1` слева, `p2` справа, между
 * ними четыре клетки — снаряд покрывает их за десяток тиков.
 */
function arena(gap = 4): Arena {
  const left = (24 - gap / 2) * FIXED_ONE;
  const right = (24 + gap / 2) * FIXED_ONE;
  const built = buildMatchWorld({
    scene: SCENE,
    seed: MATCH.seed,
    players: MATCH.players,
    initial: [
      { prefab: 'Hero', overrides: { Position: { x: left, y: 24.5 * FIXED_ONE } } },
      {
        prefab: 'Hero',
        overrides: { Player: { slot: 1 }, Position: { x: right, y: 24.5 * FIXED_ONE } },
      },
    ],
    physics: {},
    locomotion: MATCH.locomotion,
  });
  const heroes = [...coreWorld.listAlive(built.state.world)].filter((entity) =>
    coreWorld.hasTag(built.state.world, entity, 'Hero'),
  );
  let tick = 0;
  return {
    sim: built.sim,
    state: built.state,
    heroes,
    step(a, b = NEUTRAL) {
      tick += 1;
      simTick(built.sim, built.state, [
        {
          tick,
          playerId: MATCH.players[0]!,
          seq: tick,
          move: { x: 0, y: 0 },
          aimDir: a.aimDir ?? AIM_EAST,
          buttons: a.buttons ?? 0,
        },
        {
          tick,
          playerId: MATCH.players[1]!,
          seq: tick,
          move: { x: 0, y: 0 },
          aimDir: b.aimDir ?? AIM_WEST,
          buttons: b.buttons ?? 0,
        },
      ]);
      return tick;
    },
  };
}

function tagged(state: SimulationState, tag: string): EntityId[] {
  return [...coreWorld.listAlive(state.world)].filter((entity) =>
    coreWorld.hasTag(state.world, entity, tag),
  );
}

const fireballs = (state: SimulationState): EntityId[] => tagged(state, 'Fireball');
const domes = (state: SimulationState): EntityId[] => tagged(state, 'SlowDome');

/** Множитель времени сущности; компонента нет — обычный темп (TIME-3). */
function timeScale(state: SimulationState, entity: EntityId): number {
  return coreWorld.hasComponent(state.world, entity, 'TimeScale')
    ? coreWorld.getField(state.world, entity, 'TimeScale', 'value')
    : FIXED_ONE;
}

const x = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Position', 'x');

/** Фронт кнопки: тик с битом и тик без него (INP-2, TICK-4). */
function pressA(a: Arena, buttons: number, aimDir = AIM_EAST): void {
  a.step({ buttons, aimDir });
  a.step({ aimDir });
}

function pressB(a: Arena, buttons: number, aimDir = AIM_WEST): void {
  a.step(NEUTRAL, { buttons, aimDir });
  a.step(NEUTRAL, { aimDir });
}

describe('купол замедления: чужой снаряд идёт вчетверо медленнее (TIME-7, TIME-8)', () => {
  it('снаряд p1 внутри купола p2 получает ровно 0.25× и восстанавливается на выходе', () => {
    const a = arena(8);
    // p1 стреляет на восток, в сторону p2.
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    expect(coreWorld.getField(a.state.world, shot, 'Owner', 'slot')).toBe(0);

    // Шаг снаряда в обычном темпе — эталон для сравнения.
    const before = x(a.state, shot);
    a.step(NEUTRAL);
    const fullStep = x(a.state, shot) - before;
    expect(fullStep).toBeGreaterThan(0);
    expect(timeScale(a.state, shot)).toBe(FIXED_ONE);

    // p2 ставит купол. Подходящего снаряда он коснётся, когда тот войдёт в радиус.
    pressB(a, DOME);
    expect(domes(a.state)).toHaveLength(1);

    let slowedStep: number | null = null;
    for (let i = 0; i < DOME_TICKS && fireballs(a.state).length > 0; i++) {
      const from = x(a.state, shot);
      a.step(NEUTRAL);
      if (fireballs(a.state).length === 0) break;
      if (timeScale(a.state, shot) === SLOW && slowedStep === null) {
        slowedStep = x(a.state, shot) - from;
      }
    }

    expect(slowedStep).not.toBeNull();
    // Ровно вчетверо: физика умножает шаг на итоговый множитель (TIME-3), сама
    // скорость в компоненте не трогается — замедление не «прилипает».
    expect(slowedStep).toBe(fullStep / 4);
  });

  it('свой снаряд купол не замедляет — на этом держится смысл переброса', () => {
    const a = arena(8);
    // Купол ставит p2, и он же стреляет — сквозь собственный купол.
    pressB(a, DOME);
    pressB(a, CAST);
    const shot = fireballs(a.state)[0]!;
    expect(coreWorld.getField(a.state.world, shot, 'Owner', 'slot')).toBe(1);

    for (let i = 0; i < 20 && fireballs(a.state).length > 0; i++) {
      a.step(NEUTRAL);
      if (fireballs(a.state).length === 0) break;
      expect(timeScale(a.state, shot)).toBe(FIXED_ONE);
    }
  });

  it('истёкший купол исчезает и снимает своё замедление', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    pressB(a, DOME);

    let sawSlow = false;
    for (let i = 0; i < DOME_TICKS + 4 && domes(a.state).length > 0; i++) {
      a.step(NEUTRAL);
      if (fireballs(a.state).length > 0 && timeScale(a.state, shot) === SLOW) sawSlow = true;
    }
    expect(sawSlow).toBe(true);
    // Купол снят по истечении своего срока, а не остался висеть навсегда.
    expect(domes(a.state)).toHaveLength(0);
  });

  it('кулдаун купола гейтит повторный каст и тикает вниз', () => {
    const a = arena();
    pressB(a, DOME);
    const p2 = a.heroes[1]!;
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'slowDome')).toBe(DOME_COOLDOWN - 1);
    // Второй фронт на неостывшей способности второго купола не даёт.
    pressB(a, DOME);
    expect(domes(a.state)).toHaveLength(1);

    for (let i = 0; i < DOME_COOLDOWN; i++) a.step(NEUTRAL);
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'slowDome')).toBe(0);
  });
});

describe('захват снаряда: удержание, переброс и смена владельца', () => {
  /** p1 стреляет в p2; тикаем, пока снаряд не окажется в зоне захвата p2. */
  function shotInReach(a: Arena, shot: EntityId): void {
    const p2 = a.heroes[1]!;
    for (let i = 0; i < 200; i++) {
      const gap = x(a.state, p2) - x(a.state, shot);
      if (gap <= 2 * FIXED_ONE) return;
      a.step(NEUTRAL);
    }
    throw new Error('снаряд не долетел до зоны захвата');
  }

  it('отпускание R ловит чужой снаряд: он замирает у держателя и лочит манёвры (LOC-7)', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    // Удержание — бит во всех тиках; захват разрешается на ОТПУСКАНИИ (INP-2).
    a.step(NEUTRAL, { buttons: CAPTURE });
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    a.step(NEUTRAL, {});

    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);
    expect(coreWorld.getField(a.state.world, shot, 'Held', 'holder')).toBe(p2);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(true);
    expect(coreWorld.getField(a.state.world, p2, 'Holding', 'projectile')).toBe(shot);
    // Манёвры запрещены битом 0 маски лока; ходьба им не задета (LOC-7).
    expect(coreWorld.getField(a.state.world, p2, 'ActionLock', 'mask')).toBe(1);
    expect(coreWorld.getField(a.state.world, shot, 'Velocity', 'x')).toBe(0);
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBeGreaterThan(0);

    // Пойманный снаряд висит на держателе и не тратит свой полёт.
    const life = coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks');
    a.step(NEUTRAL);
    expect(coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks')).toBe(life);
    expect(Math.abs(x(a.state, shot) - x(a.state, p2))).toBeLessThan(FIXED_ONE);
  });

  it('снаряд позади героя вне сектора не ловится, но кулдаун списывается', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    // Прицел на восток — снаряд подходит с запада, то есть за спиной.
    a.step(NEUTRAL, { buttons: CAPTURE, aimDir: AIM_EAST });
    a.step(NEUTRAL, { aimDir: AIM_EAST });

    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    // Кулдаун ставится на тике отпускания и на нём же ещё не тикает: убавляет
    // его `CooldownTick` (order 10), а `CaptureRelease` идёт позже (order 38).
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBe(CAPTURE_COOLDOWN);
  });

  it('переброс меняет владельца: купол бросившего его больше не замедляет, а купол соперника — да', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);

    // Переброс ЛКМ тем же прицелом: снаряд уходит обратно на запад.
    a.step(NEUTRAL, { buttons: CAST });
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'ActionLock')).toBe(false);
    // Владелец сменился на бросившего — вот на чём и держится связка способностей.
    expect(coreWorld.getField(a.state.world, shot, 'Owner', 'slot')).toBe(1);
    expect(coreWorld.getField(a.state.world, shot, 'Velocity', 'x')).toBeLessThan(0);

    // Купол ставит сам бросивший: свой снаряд он не трогает.
    pressB(a, DOME);
    for (let i = 0; i < 12 && fireballs(a.state).length > 0; i++) {
      a.step(NEUTRAL);
      if (fireballs(a.state).length === 0) break;
      expect(timeScale(a.state, shot)).toBe(FIXED_ONE);
    }

    // А купол соперника — замедляет: снаряд теперь для него чужой.
    pressA(a, DOME);
    let slowed = false;
    for (let i = 0; i < 60 && fireballs(a.state).length > 0; i++) {
      a.step(NEUTRAL);
      if (fireballs(a.state).length === 0) break;
      if (timeScale(a.state, shot) === SLOW) {
        slowed = true;
        break;
      }
    }
    expect(slowed).toBe(true);
  });

  it('невыброшенный за 400 мс снаряд взрывается на держателе и снимает 250 hp', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    const hpBefore = coreWorld.getField(a.state.world, p2, 'Health', 'hp');
    expect(hpBefore).toBe(1000);

    // Тик захвата уже потратил один тик окна: до взрыва остаётся HOLD_TICKS − 1.
    for (let i = 0; i < HOLD_TICKS - 1; i++) {
      expect(coreWorld.getField(a.state.world, p2, 'Health', 'hp')).toBe(hpBefore);
      a.step(NEUTRAL);
    }
    expect(coreWorld.getField(a.state.world, p2, 'Health', 'hp')).toBe(hpBefore - EXPLOSION_DAMAGE);
    // Снаряда нет, руки свободны, лок снят.
    expect(fireballs(a.state)).toHaveLength(0);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'ActionLock')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Dead')).toBe(false);
  });

  it('четыре взрыва в руках убивают героя через общий путь смерти сцены', () => {
    const a = arena(8);
    const p2 = a.heroes[1]!;
    let died = false;

    for (let round = 0; round < 4 && !died; round++) {
      pressA(a, CAST);
      const shot = fireballs(a.state)[0]!;
      for (let i = 0; i < 200 && x(a.state, p2) - x(a.state, shot) > 2 * FIXED_ONE; i++) {
        a.step(NEUTRAL);
      }
      a.step(NEUTRAL, { buttons: CAPTURE });
      a.step(NEUTRAL, {});
      expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);
      for (let i = 0; i < HOLD_TICKS - 1; i++) a.step(NEUTRAL);
      // Кулдаун захвата — 2 с; следующий раунд ждёт его.
      for (let i = 0; i < CAPTURE_COOLDOWN; i++) {
        a.step(NEUTRAL);
        if (coreWorld.hasComponent(a.state.world, p2, 'Dead')) break;
      }
      died = coreWorld.hasComponent(a.state.world, p2, 'Dead');
    }

    expect(coreWorld.getField(a.state.world, p2, 'Health', 'hp')).toBe(0);
    expect(died).toBe(true);
    // Смерть от урона идёт тем же путём, что смерть в пустоте: управление снято.
    expect(coreWorld.hasComponent(a.state.world, p2, 'Locomotion')).toBe(false);
  });

  it('пока снаряд в руках, обычный каст не проходит', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(fireballs(a.state)).toHaveLength(1);

    // ЛКМ — это переброс, а не новый фаербол: снарядов по-прежнему один.
    a.step(NEUTRAL, { buttons: CAST });
    expect(fireballs(a.state)).toHaveLength(1);
  });
});
