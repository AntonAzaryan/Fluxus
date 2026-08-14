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
import { ACTION_BITS, FIREBALL_LIFETIME_TICKS } from '../app/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';
import manifestJson from '../../../content/visuals/manifest.json';

const SCENE = sceneJson as unknown as SceneDef;
const MANIFEST = manifestJson as unknown as {
  readonly effects: { readonly byKind: Record<string, { readonly radius: number }> };
};
const MATCH = matchJson as unknown as {
  readonly seed: number;
  readonly players: readonly string[];
  readonly locomotion: Record<string, unknown>;
};

const CAST = 1 << ACTION_BITS.cast;
const DODGE = 1 << ACTION_BITS.dodge;
const JUMP = 1 << ACTION_BITS.jump;
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
/**
 * `AbilityConfig.holdTicks`. Тик захвата тратит первый из них, поэтому окно
 * броска — `HOLD_TICKS − 1` = 24 тика = ровно 400 мс при 60 Гц.
 */
const HOLD_TICKS = 25;
const THROW_WINDOW_TICKS = HOLD_TICKS - 1;
const EXPLOSION_DAMAGE = 250;
/** `Collider.radius` героя и множитель купола — те же поля, что читает `DomeCast`. */
const HERO_RADIUS = 19661;
const DOME_RADIUS_MUL = 229376;
/** Раствор сектора захвата в единицах угла ядра (FP-7): 5461/65536 ≈ 30°. */
const CAPTURE_HALF_ANGLE = 5461;

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
  /** Ось движения в Q16.16; манёвру уклона направление обязательно (LOC-4). */
  readonly moveX?: number;
  readonly moveY?: number;
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
  // Слот игрока — из компонента, а не из порядка обхода мира: `listAlive` даёт
  // порядок raw-индексов (QUERY-2), и связь «нулевой в списке = p1» держалась бы
  // на совпадении, а не на данных.
  const heroes: EntityId[] = [];
  for (const entity of coreWorld.listAlive(built.state.world)) {
    if (!coreWorld.hasTag(built.state.world, entity, 'Hero')) continue;
    heroes[coreWorld.getField(built.state.world, entity, 'Player', 'slot')] = entity;
  }
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
          move: { x: a.moveX ?? 0, y: a.moveY ?? 0 },
          aimDir: a.aimDir ?? AIM_EAST,
          buttons: a.buttons ?? 0,
        },
        {
          tick,
          playerId: MATCH.players[1]!,
          seq: tick,
          move: { x: b.moveX ?? 0, y: b.moveY ?? 0 },
          aimDir: b.aimDir ?? AIM_WEST,
          buttons: b.buttons ?? 0,
        },
      ]);
      return tick;
    },
  };
}

interface Ffa {
  readonly state: SimulationState;
  /** Герои в порядке слотов — то есть в порядке переданных абсцисс. */
  readonly heroes: readonly EntityId[];
  /** Тик с явными вводами всех слотов; недоданный кадр — нейтраль. */
  step: (frames?: readonly Frame[]) => void;
}

/**
 * Свободная схватка на N героев: `arena()` — дуэль на списке игроков матча, а
 * очередь захвата (кто именно ловит и что достаётся проигравшему гонку) видна
 * только там, где участников больше двух. Позиции — абсциссы на ОДНОЙ ординате:
 * все стоят на линии, и «снаряд в секторе» сводится к «снаряд на запад».
 */
function ffa(xs: readonly number[]): Ffa {
  const players = xs.map((_, index) => `p${index + 1}`);
  const built = buildMatchWorld({
    scene: SCENE,
    seed: MATCH.seed,
    players,
    initial: xs.map((cell, index) => ({
      prefab: 'Hero',
      overrides: {
        Player: { slot: index },
        Position: { x: cell * FIXED_ONE, y: 24.5 * FIXED_ONE },
      },
    })),
    physics: {},
    locomotion: MATCH.locomotion,
  });
  const heroes: EntityId[] = [];
  for (const entity of coreWorld.listAlive(built.state.world)) {
    if (!coreWorld.hasTag(built.state.world, entity, 'Hero')) continue;
    heroes[coreWorld.getField(built.state.world, entity, 'Player', 'slot')] = entity;
  }
  let tick = 0;
  return {
    state: built.state,
    heroes,
    step(frames = []) {
      tick += 1;
      simTick(
        built.sim,
        built.state,
        players.map((playerId, index) => ({
          tick,
          playerId,
          seq: tick,
          move: { x: 0, y: 0 },
          aimDir: frames[index]?.aimDir ?? AIM_EAST,
          buttons: frames[index]?.buttons ?? 0,
        })),
      );
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

/**
 * Числа, продублированные ВНЕ `AbilityConfig`. Каждое из них — сознательное
 * зеркало: манифест визуалов и константы сборки не читают компоненты мира и
 * читать их не будут (REND-1). Расхождение такого зеркала ничего не ломает —
 * оно молча врёт игроку (нарисованный купол не совпадает с замедляющим,
 * полётная дуга не совпадает с полётом), поэтому ловится здесь.
 */
describe('зеркала балансных чисел сцены', () => {
  const ability = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!.components.AbilityConfig!;

  it('полное время полёта сборки — то же, что `AbilityConfig.throwLifetime`', () => {
    expect(FIREBALL_LIFETIME_TICKS).toBe(ability.throwLifetime);
    // И умолчание prefab'а тоже: `Cast`/`ThrowHeld` его перекрывают, но снаряд,
    // рождённый мимо них, обязан жить столько же.
    expect(SCENE.prefabs!.find((p) => p.name === 'Fireball')!.components.Lifetime!.ticks).toBe(
      ability.throwLifetime,
    );
  });

  it('радиус оболочки купола в манифесте — радиус, который считает `DomeCast`', () => {
    const world = Math.floor((HERO_RADIUS * DOME_RADIUS_MUL) / FIXED_ONE) / FIXED_ONE;
    expect(MANIFEST.effects.byKind.SlowDome!.radius).toBeCloseTo(world, 3);
  });
});

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
    // Сдвиг, а не деление: шаг — Q16.16, и `/ 4` завёл бы в тест дробь, которой
    // в фиксированной точке не существует.
    expect(slowedStep).toBe(fullStep >> 2);
  });

  it('радиус купола — ровно 3.5 радиуса коллайдера кастера', () => {
    const a = arena();
    pressB(a, DOME);
    const dome = domes(a.state)[0]!;
    // Формула живёт в `DomeCast` (`Collider.radius × AbilityConfig.domeRadiusMul`),
    // а здесь пиннится её РЕЗУЛЬТАТ: ретюн любого из двух чисел виден в диффе
    // теста, а не только в поведении на экране.
    const expected = Math.floor((HERO_RADIUS * DOME_RADIUS_MUL) / FIXED_ONE);
    expect(expected).toBe(68813);
    expect(coreWorld.getField(a.state.world, dome, 'DomeState', 'radius')).toBe(expected);
    // То же число лежит умолчанием в prefab'е `SlowDome` — они обязаны совпадать.
    expect(SCENE.prefabs!.find((p) => p.name === 'SlowDome')!.components.DomeState!.radius).toBe(
      expected,
    );
  });

  it('выход из купола восстанавливает шаг ТОЧНО, пока купол ещё жив', () => {
    // Герои рядом: снаряд успевает и войти в купол, и выйти из него до того,
    // как кончится его собственный полёт.
    const a = arena(2);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;

    const before = x(a.state, shot);
    a.step(NEUTRAL);
    const fullStep = x(a.state, shot) - before;
    expect(fullStep).toBeGreaterThan(0);

    pressB(a, DOME);
    let sawSlow = false;
    let exitStep: number | null = null;
    for (let i = 0; i < DOME_TICKS && fireballs(a.state).length > 0; i++) {
      const from = x(a.state, shot);
      a.step(NEUTRAL);
      if (fireballs(a.state).length === 0) break;
      if (timeScale(a.state, shot) === SLOW) {
        sawSlow = true;
        continue;
      }
      // Первый обычный тик ПОСЛЕ замедления — это и есть выход из купола.
      if (sawSlow && exitStep === null) exitStep = x(a.state, shot) - from;
    }

    expect(sawSlow).toBe(true);
    // Множитель снят полностью, а не «почти»: восстановление — не сглаживание.
    expect(timeScale(a.state, shot)).toBe(FIXED_ONE);
    expect(exitStep).toBe(fullStep);
    // И всё это — пока купол ЖИВ: восстановил его выход из радиуса, а не смерть.
    expect(domes(a.state)).toHaveLength(1);
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

    // Тик захвата уже потратил один тик окна: до взрыва остаётся ровно окно
    // броска — 24 тика, те самые 400 мс при 60 Гц.
    for (let i = 0; i < THROW_WINDOW_TICKS; i++) {
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
      for (let i = 0; i < THROW_WINDOW_TICKS; i++) a.step(NEUTRAL);
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

  it('бросок проходит на ПОСЛЕДНЕМ тике окна: оно ровно 24 тика (400 мс)', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);

    // На последнем тике окна взрыв ещё не случился: `ThrowHeld` (order 31) идёт
    // раньше `HeldPin` (order 105), и бросок успевает.
    for (let i = 0; i < THROW_WINDOW_TICKS - 1; i++) a.step(NEUTRAL);
    a.step(NEUTRAL, { buttons: CAST });

    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    expect(coreWorld.getField(a.state.world, shot, 'Velocity', 'x')).toBeLessThan(0);
    // Здоровье цело: взрыва в руках не было.
    expect(coreWorld.getField(a.state.world, p2, 'Health', 'hp')).toBe(1000);
  });

  it('пойманный снаряд запрещает манёвры, но не ходьбу (LOC-7)', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(true);

    // Фронт уклона С НАПРАВЛЕНИЕМ (без него манёвр игнорируется и без лока,
    // LOC-4) — состояние машины манёвров не двигается.
    a.step(NEUTRAL, { buttons: DODGE, moveX: FIXED_ONE });
    expect(coreWorld.getField(a.state.world, p2, 'LocomotionState', 'state')).toBe(0);
    // И фронт прыжка тоже: заблокированы оба класса, а не один.
    a.step(NEUTRAL, { moveX: FIXED_ONE });
    a.step(NEUTRAL, { buttons: JUMP, moveX: FIXED_ONE });
    expect(coreWorld.getField(a.state.world, p2, 'LocomotionState', 'state')).toBe(0);
    // Ходьба при этом жива — лок селективный (LOC-7), а не «стой на месте».
    expect(coreWorld.getField(a.state.world, p2, 'Velocity', 'x')).toBeGreaterThan(0);
  });

  it('контроль: без пойманного снаряда те же фронты манёвр запускают', () => {
    const a = arena(8);
    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: DODGE, moveX: FIXED_ONE });
    expect(coreWorld.getField(a.state.world, p2, 'LocomotionState', 'state')).not.toBe(0);

    const b = arena(8);
    const other = b.heroes[1]!;
    b.step(NEUTRAL, { buttons: JUMP });
    expect(coreWorld.getField(b.state.world, other, 'LocomotionState', 'state')).not.toBe(0);
  });

  it('второй захват на неостывшем кулдауне не срабатывает', () => {
    const a = arena(8);
    pressA(a, CAST);
    const first = fireballs(a.state)[0]!;
    shotInReach(a, first);

    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(coreWorld.hasComponent(a.state.world, first, 'Held')).toBe(true);
    // Бросок освобождает руки, но кулдаун захвата продолжает тикать.
    a.step(NEUTRAL, { buttons: CAST });
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);

    // Второй снаряд подлетает, пока захват не остыл.
    pressA(a, CAST);
    const second = fireballs(a.state).find((entity) => entity !== first)!;
    expect(second).toBeDefined();
    shotInReach(a, second);
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBeGreaterThan(0);

    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(coreWorld.hasComponent(a.state.world, second, 'Held')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
  });

  it('граница сектора: снаряд у самой кромки раствора ловится, за ней — нет', () => {
    // Снаряд подходит РОВНО с запада (обе позиции на одной ординате), поэтому
    // угол между прицелом и направлением на снаряд — это отклонение прицела от
    // запада: раствор проверяется одним числом, без геометрии в тесте.
    const attempt = (offset: number): boolean => {
      const a = arena(8);
      pressA(a, CAST);
      const shot = fireballs(a.state)[0]!;
      const p2 = a.heroes[1]!;
      for (let i = 0; i < 200 && x(a.state, p2) - x(a.state, shot) > 2 * FIXED_ONE; i++) {
        a.step(NEUTRAL);
      }
      const aimDir = (AIM_WEST + offset) & 0xffff;
      a.step(NEUTRAL, { buttons: CAPTURE, aimDir });
      a.step(NEUTRAL, { aimDir });
      return coreWorld.hasComponent(a.state.world, shot, 'Held');
    };

    expect(attempt(CAPTURE_HALF_ANGLE - 100)).toBe(true);
    expect(attempt(CAPTURE_HALF_ANGLE + 100)).toBe(false);
    // Симметрично: раствор считается по модулю угла, а не по знаку.
    expect(attempt(-(CAPTURE_HALF_ANGLE - 100))).toBe(true);
    expect(attempt(-(CAPTURE_HALF_ANGLE + 100))).toBe(false);
  });

  /**
   * Латентный дефект FFA, а не дуэли: `CaptureRelease` обходит героев, команды
   * применяются одним flush'ем в конце системы, и два героя, отпустившие R на
   * одном тике над одним снарядом, оба получают `Holding` + `ActionLock` —
   * а `Held.holder` достаётся последнему записавшему. `HeldPin` снимает лок
   * только с НАСТОЯЩЕГО держателя, и второй остался бы залоченным навсегда.
   * Лечит это `HoldingGuard` (order 104): `Holding`, которому не отвечает
   * `Held.holder`, снимается тем же тиком.
   */
  it('двойной захват одного снаряда не оставляет второго героя в вечном локе', () => {
    // Стрелок и двое ловцов рядом: снаряд попадает в радиус и в раствор обоих
    // на одном и том же тике.
    const a = ffa([20, 26, 27]);
    const catchers = [a.heroes[1]!, a.heroes[2]!];

    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    expect(shot).toBeDefined();
    for (let i = 0; i < 200 && x(a.state, shot) < 24.2 * FIXED_ONE; i++) a.step();

    // Оба отпускают R на одном тике.
    a.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }, { buttons: CAPTURE, aimDir: AIM_WEST }]);
    a.step([NEUTRAL, { aimDir: AIM_WEST }, { aimDir: AIM_WEST }]);

    const holding = catchers.filter((hero) => coreWorld.hasComponent(a.state.world, hero, 'Holding'));
    // Снаряд один — и держатель у него ровно один.
    expect(holding).toHaveLength(1);
    expect(coreWorld.getField(a.state.world, shot, 'Held', 'holder')).toBe(holding[0]);
    // А проигравший гонку не остался залоченным с пустыми руками.
    for (const hero of catchers) {
      if (hero === holding[0]) continue;
      expect(coreWorld.hasComponent(a.state.world, hero, 'ActionLock')).toBe(false);
    }
  });

  /**
   * Из двух подходящих снарядов берётся БЛИЖАЙШИЙ (`nearestTo`, ACT-5), а не
   * первый по порядку выборки (QUERY-2 — по возрастанию raw-индекса). Разница
   * видна только там, где старший снаряд дальше младшего: два стрелка на разном
   * удалении, дальний стреляет первым.
   */
  it('из двух чужих снарядов в секторе ловится ближайший (ACT-5)', () => {
    const a = ffa([18, 28, 23]);
    // Дальний стрелок (слот 0) — первым: его снаряд получает МЕНЬШИЙ raw-индекс.
    a.step([{ buttons: CAST }]);
    a.step();
    const far = fireballs(a.state)[0]!;
    // Пауза подобрана так, чтобы младший снаряд обогнал старшего: 12 тиков —
    // это 3 клетки хода при разнице стартов в 5.
    for (let i = 0; i < 12; i++) a.step();
    a.step([NEUTRAL, NEUTRAL, { buttons: CAST }]);
    a.step();
    const near = fireballs(a.state).find((entity) => entity !== far)!;
    expect(near).toBeDefined();

    const p2 = a.heroes[1]!;
    // Ждём кадра, где ОБА в радиусе захвата и ближний действительно ближе.
    for (let i = 0; i < 200; i++) {
      const dFar = x(a.state, p2) - x(a.state, far);
      const dNear = x(a.state, p2) - x(a.state, near);
      if (dFar <= 2.9 * FIXED_ONE && dNear < dFar) break;
      a.step();
    }
    expect(x(a.state, p2) - x(a.state, near)).toBeLessThan(x(a.state, p2) - x(a.state, far));
    expect(fireballs(a.state).find((entity) => entity === far)).toBeDefined();

    a.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }]);
    a.step([NEUTRAL, { aimDir: AIM_WEST }]);
    expect(coreWorld.getField(a.state.world, p2, 'Holding', 'projectile')).toBe(near);
    expect(coreWorld.hasComponent(a.state.world, far, 'Held')).toBe(false);
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
