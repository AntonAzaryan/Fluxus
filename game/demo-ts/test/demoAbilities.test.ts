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
  fixed,
  tick as simTick,
  world as coreWorld,
  type EntityId,
  type SceneDef,
  type SimulationState,
  type Simulation,
} from '@game-mvp/core';
import { buildMatchWorld, REWIND_REQUEST_EVENT } from '@game-mvp/net';
import { ViewBuffer, type TickView } from '@game-mvp/render';
import {
  ACTION_BITS,
  FIREBALL_LIFETIME_TICKS,
  RESPAWN_EVENT,
  TICK_SECONDS,
  stateBit,
} from '../app/sim.js';
import { createDemoExtractor } from '../app/extractor.js';
import { DEMO_SCRUB_EVERY } from '../app/match.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';
import manifestJson from '../../../content/visuals/manifest.json';

const SCENE = sceneJson as unknown as SceneDef;
const MANIFEST = manifestJson as unknown as {
  readonly effects: {
    readonly byKind: Record<string, { readonly radius: number }>;
    readonly byState: Record<
      string,
      { readonly radius: number; readonly alpha: number; readonly color: string }
    >;
    readonly byEvent: Record<string, { readonly radius: number; readonly radiusTo: number }>;
  };
};
const MATCH = matchJson as unknown as {
  readonly seed: number;
  readonly players: readonly string[];
  readonly locomotion: Record<string, unknown>;
  /** Пересчёт видимости (NTR-14, FOW-4): сцена с `fog` без него не собирается. */
  readonly visibility?: Record<string, never>;
  readonly tickRate?: number;
  readonly snapshotRate?: number;
  readonly rewind?: {
    readonly interval: number;
    readonly capacity: number;
    readonly exempt?: readonly { readonly component: string }[];
    readonly holdButton?: number;
    readonly step?: number;
  };
};

const CAST = 1 << ACTION_BITS.cast;
const KILL = 1 << ACTION_BITS.kill;
const DODGE = 1 << ACTION_BITS.dodge;
const JUMP = 1 << ACTION_BITS.jump;
const DOME = 1 << ACTION_BITS.slowDome;
const CAPTURE = 1 << ACTION_BITS.capture;
const SHIELD = 1 << ACTION_BITS.shield;

/** Прицел в единицах угла ядра (FP-7): полный оборот — 65536. */
const AIM_EAST = 0;
const AIM_WEST = 0x8000;

/**
 * Множитель купола и предел замедления — те же числа, что в `AbilityConfig`.
 * 13107/65536 — это НЕ ровно 1/5: точной пятой доли в двоичной дроби не
 * существует, поэтому шаг замедленного снаряда пиннится настоящим произведением
 * фиксированной точки (`fixed.mul`), а не делением на пять.
 */
const SLOW = 13107;
const DOME_TICKS = 180;
const DOME_COOLDOWN = 300;
const CAPTURE_COOLDOWN = 120;
/**
 * `AbilityConfig.holdTicks`. Тик захвата тратит первый из них, поэтому окно
 * броска — `HOLD_TICKS − 1` = 120 тиков = ровно 2 с при 60 Гц.
 */
const HOLD_TICKS = 121;
const THROW_WINDOW_TICKS = HOLD_TICKS - 1;
const EXPLOSION_DAMAGE = 250;
/** `Collider.radius` героя и множитель купола — те же поля, что читает `DomeCast`. */
const HERO_RADIUS = 19661;
const DOME_RADIUS_MUL = 655360;
/** Раствор сектора захвата в единицах угла ядра (FP-7): 5461/65536 ≈ 30°. */
const CAPTURE_HALF_ANGLE = 5461;

/** Заряд каста — те же поля `AbilityConfig`, по которым решает `ChargeRelease`. */
const CAST_COOLDOWN = 60;
const CHARGE_TICKS = 60;
const CHARGE_GRACE_TICKS = 18;
const CHARGE_MAX_SCALE = 2 * FIXED_ONE;
/** Порог «тяжёлого» снаряда: с него `ChargeRelease` спавнит prefab `HeavyFireball`. */
const CHARGE_HEAVY_SCALE = 1.5 * FIXED_ONE;
const HIT_DAMAGE = 100;
const OVERCHARGE_DAMAGE = 250;
const OVERCHARGE_RADIUS = 3 * FIXED_ONE;
/**
 * Щит — те же поля `AbilityConfig`/`Cooldowns`, по которым решают `ShieldCast`
 * и `ShieldRicochet`. Радиус щита — множитель 2,6 от коллайдера героя; сам
 * множитель в Q16.16 неточен (2,6 в двоичной дроби не существует), поэтому
 * ПИННИТСЯ его произведение, а не он сам.
 */
const SHIELD_COOLDOWN = 150;
const SHIELD_TICKS = 60;
const SHIELD_RADIUS_MUL = 170394;
const SHIELD_RADIUS = 51118;
/** Радиус коллайдера снаряда — ровно половина героического. */
const FIREBALL_RADIUS = 9830;
/** Радиус коллайдера тяжёлого снаряда — вдвое больше обычного, то есть героический. */
const HEAVY_FIREBALL_RADIUS = 19661;

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
function arena(gap = 4, scene: SceneDef = SCENE): Arena {
  const left = (24 - gap / 2) * FIXED_ONE;
  const right = (24 + gap / 2) * FIXED_ONE;
  const built = buildMatchWorld({
    scene,
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
    // Сцена демо включает туман войны (fog): без объявления пересчёта видимости
    // мир матча не собирается (NTR-14, FOW-4). Поле — из документа матча.
    ...(MATCH.visibility !== undefined ? { visibility: MATCH.visibility } : {}),
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
  readonly sim: Simulation;
  readonly state: SimulationState;
  /** Герои в порядке слотов — то есть в порядке переданных абсцисс. */
  readonly heroes: readonly EntityId[];
  /** Тик с явными вводами всех слотов; недоданный кадр — нейтраль. Отдаёт типы событий тика. */
  step: (frames?: readonly Frame[]) => readonly string[];
  /**
   * Биты состояний (CAM-6) сущности за ПОСЛЕДНИЙ шаг — то, что уезжает рендеру
   * и включает оболочку `effects.byState`. Снимаются внутри `step`: view на
   * `TickResult` живёт только внутри dispatch (OBS-3). Пусты, пока харнесс не
   * создан с `{ extract: true }`, — лишний проход Extractor'а нужен единицам
   * тестов, а не каждому тику каждого.
   */
  stateBits: (entity: EntityId) => number;
  /**
   * Доставленный вид последнего шага (REND-2) — ровно то, что видит рендер:
   * события тика, признак разрыва непрерывности и пер-сущностные записи. Как и
   * `stateBits`, живёт только у харнесса с `{ extract: true }`.
   */
  view: () => TickView;
}

/**
 * Свободная схватка на N героев: `arena()` — дуэль на списке игроков матча, а
 * очередь захвата (кто именно ловит и что достаётся проигравшему гонку) видна
 * только там, где участников больше двух. Позиция — абсцисса на общей ординате
 * либо пара `[x, y]`: снаряд теперь СБИВАЕТ героя, попав в его коллайдер, и
 * тесту, которому нужен пролетающий мимо снаряд, ординату приходится разводить.
 */
function ffa(
  cells: readonly (number | readonly [number, number])[],
  options: { readonly extract?: boolean } = {},
): Ffa {
  const points: readonly (readonly [number, number])[] = cells.map((cell) =>
    typeof cell === 'number' ? ([cell, 24.5] as const) : cell,
  );
  const players = points.map((_, index) => `p${index + 1}`);
  const built = buildMatchWorld({
    scene: SCENE,
    seed: MATCH.seed,
    players,
    initial: points.map(([cx, cy], index) => ({
      prefab: 'Hero',
      overrides: {
        Player: { slot: index },
        Position: { x: Math.round(cx * FIXED_ONE), y: Math.round(cy * FIXED_ONE) },
      },
    })),
    physics: {},
    locomotion: MATCH.locomotion,
    // То же основание, что у `arena`: сцена с fog требует пересчёта видимости.
    ...(MATCH.visibility !== undefined ? { visibility: MATCH.visibility } : {}),
  });
  const heroes: EntityId[] = [];
  for (const entity of coreWorld.listAlive(built.state.world)) {
    if (!coreWorld.hasTag(built.state.world, entity, 'Hero')) continue;
    heroes[coreWorld.getField(built.state.world, entity, 'Player', 'slot')] = entity;
  }
  const extractor = options.extract === true ? createDemoExtractor(undefined) : null;
  const buffer = new ViewBuffer({ tickSeconds: TICK_SECONDS, clock: () => 0 });
  let tick = 0;
  return {
    sim: built.sim,
    state: built.state,
    heroes,
    step(frames = []) {
      tick += 1;
      const result = simTick(
        built.sim,
        built.state,
        players.map((playerId, index) => ({
          tick,
          playerId,
          seq: tick,
          move: { x: frames[index]?.moveX ?? 0, y: frames[index]?.moveY ?? 0 },
          aimDir: frames[index]?.aimDir ?? AIM_EAST,
          buttons: frames[index]?.buttons ?? 0,
        })),
      );
      if (extractor !== null) buffer.apply(extractor.extract(result));
      return [...result.events].map((event) => event.type);
    },
    stateBits: (entity) => buffer.view.entities.get(entity)?.states ?? 0,
    view: () => buffer.view,
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

const y = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Position', 'y');

/**
 * Членство снаряда в щите — ОСЕВОЙ бокс, а не круг. `ShieldRicochet` сравнивает
 * |dx| и |dy| с `shieldR + halfX/halfY` снаряда именно потому, что урон
 * `FireballHit` растёт из `Overlap` физики, а тот — пересечение ОГИБАЮЩИХ
 * (PHYS-12): вписанный в бокс круг оставлял бы угловую лунку, где урон уже
 * есть, а рикошета ещё нет.
 */
const inShieldBox = (
  state: SimulationState,
  shot: EntityId,
  hero: EntityId,
  band: number,
): boolean =>
  Math.abs(x(state, shot) - x(state, hero)) <= band &&
  Math.abs(y(state, shot) - y(state, hero)) <= band;

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
 * Заряд каста: `held` тиков УДЕРЖАНИЯ сверх тика нажатия, затем отпускание.
 * Тик нажатия окном заряда не считается (`ChargeRelease` вычитает его), поэтому
 * `charge(a, 0)` — это самый быстрый тап, `charge(a, CHARGE_TICKS)` — полный.
 */
function chargeA(a: Arena, held: number, aimDir = AIM_EAST): void {
  a.step({ buttons: CAST, aimDir });
  for (let i = 0; i < held; i++) a.step({ buttons: CAST, aimDir });
  a.step({ aimDir });
}

const projectile = (state: SimulationState, entity: EntityId, field: string): number =>
  coreWorld.getField(state.world, entity, 'Projectile', field);

const hp = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Health', 'hp');

const shielded = (state: SimulationState, entity: EntityId): boolean =>
  coreWorld.hasComponent(state.world, entity, 'Shielded');

const owner = (state: SimulationState, entity: EntityId): number =>
  coreWorld.getField(state.world, entity, 'Owner', 'slot');

const vel = (state: SimulationState, entity: EntityId, axis: 'x' | 'y'): number =>
  coreWorld.getField(state.world, entity, 'Velocity', axis);

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
    // И умолчание prefab'а тоже: `ChargeRelease`/`ThrowHeld` его перекрывают, но снаряд,
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
    // Ровно впятеро с точностью фиксированной точки: физика умножает шаг на
    // итоговый множитель (TIME-3), сама скорость в компоненте не трогается —
    // замедление не «прилипает». Пиннится НАСТОЯЩЕЕ произведение Q16.16, а не
    // `fullStep / 5`: 13107/65536 меньше пятой доли на 0,00015, и шаг выходит на
    // единицу Q16.16 короче честной пятой части. Эта единица — не погрешность
    // теста, а поведение симуляции, и оно обязано быть видно.
    expect(slowedStep).toBe(fixed.mul(fullStep, SLOW));
    expect(slowedStep).toBe(8191);
    expect(fullStep / 5).toBe(8192);
  });

  it('радиус купола — ровно 10 радиусов коллайдера кастера', () => {
    const a = arena();
    pressB(a, DOME);
    const dome = domes(a.state)[0]!;
    // Формула живёт в `DomeCast` (`Collider.radius × AbilityConfig.domeRadiusMul`),
    // а здесь пиннится её РЕЗУЛЬТАТ: ретюн любого из двух чисел виден в диффе
    // теста, а не только в поведении на экране.
    const expected = Math.floor((HERO_RADIUS * DOME_RADIUS_MUL) / FIXED_ONE);
    expect(expected).toBe(196610);
    expect(coreWorld.getField(a.state.world, dome, 'DomeState', 'radius')).toBe(expected);
    // То же число лежит умолчанием в prefab'е `SlowDome` — они обязаны совпадать.
    expect(SCENE.prefabs!.find((p) => p.name === 'SlowDome')!.components.DomeState!.radius).toBe(
      expected,
    );
  });

  it('выход из купола восстанавливает шаг ТОЧНО, пока купол ещё жив', () => {
    // Кастер купола стоит В СТОРОНЕ от линии огня: снаряд теперь сбивает героя,
    // попав в его коллайдер, и «пролететь купол насквозь» иначе нечему.
    // Ордината разведена на 2.5 клетки — купол (радиус 3) линию огня накрывает,
    // а сам герой от неё дальше суммы радиусов.
    const a = ffa([18, [24, 27]]);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;

    const before = x(a.state, shot);
    a.step();
    const fullStep = x(a.state, shot) - before;
    expect(fullStep).toBeGreaterThan(0);

    a.step([NEUTRAL, { buttons: DOME }]);
    a.step();
    let sawSlow = false;
    let exitStep: number | null = null;
    for (let i = 0; i < DOME_TICKS && fireballs(a.state).length > 0; i++) {
      const from = x(a.state, shot);
      a.step();
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

  it('снаряд позади героя вне сектора не ловится, и кулдаун НЕ списывается', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    const p2 = a.heroes[1]!;
    // Ждём КРАЯ зоны (радиус захвата — 3 клетки), а не её середины: после
    // промаха снаряду нужно ещё два тика подлёта на удавшуюся попытку.
    for (let i = 0; i < 200 && x(a.state, p2) - x(a.state, shot) > 3 * FIXED_ONE; i++) {
      a.step(NEUTRAL);
    }

    // Прицел на восток — снаряд подходит с запада, то есть за спиной.
    a.step(NEUTRAL, { buttons: CAPTURE, aimDir: AIM_EAST });
    a.step(NEUTRAL, { aimDir: AIM_EAST });

    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    // Кулдаун платится за ПОЙМАННЫЙ снаряд, а не за нажатие: промах ничего не
    // стоит и разрешает немедленную повторную попытку. `CaptureRelease` ставит
    // его внутри ветки «снаряд найден», поэтому здесь он остаётся нулём.
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBe(0);

    // И повторная попытка СЛЕДУЮЩИМ ЖЕ движением ловит: промах не отнял у
    // игрока способность на две секунды.
    a.step(NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST });
    a.step(NEUTRAL, { aimDir: AIM_WEST });
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);
    // А вот УДАВШИЙСЯ захват кулдаун списывает — тем же тиком и полностью.
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBe(CAPTURE_COOLDOWN);
  });

  it('переброс меняет владельца: купол бросившего его больше не замедляет, а купол соперника — да', () => {
    // Шире прежнего: переброшенный снаряд летит вдвое с половиной быстрее и
    // долетал бы до стрелка раньше, чем тот успеет поставить свой купол.
    const a = arena(16);
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
    for (let i = 0; i < 5 && fireballs(a.state).length > 0; i++) {
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

  it('невыброшенный за 2 с снаряд взрывается на держателе и снимает 250 hp', () => {
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
    // броска — 120 тиков, те самые 2 с при 60 Гц.
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

  it('смерть держателя роняет снаряд: труп его не таскает и в руках не рвёт', () => {
    // РЕГРЕССИЯ. Пути смерти снимали с умирающего `Locomotion` и `Shielded`, но
    // не `Holding`, а `HoldingGuard` (order 104) сверяет лишь то, что `Held`
    // снаряда всё ещё называет того же держателя. Труп поэтому продолжал
    // таскать снаряд за собой весь остаток окна: `HeldPin` (order 105) читает
    // `Input.aimDir` и `Position` мертвеца, — а на конце окна снаряд рвался «в
    // руках трупа» уроном, который `DamageApply` (not: ["Dead"]) молча выбрасывал.
    // Смерть теперь отпускает захват ТЕМ ЖЕ путём, что бросок (`ThrowHeld`): со
    // снаряда снимается `Held`, с держателя — `Holding` и `ActionLock`.
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    shotInReach(a, shot);

    const p2 = a.heroes[1]!;
    a.step(NEUTRAL, { buttons: CAPTURE });
    a.step(NEUTRAL, {});
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(true);

    // Полёта пойманный снаряд не тратит — это и есть точка отсчёта.
    const life = coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks');
    for (let i = 0; i < 10; i++) a.step(NEUTRAL);
    expect(coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks')).toBe(life);

    // Мгновенная смерть на середине окна броска (`KillSwitch`, order 20 — то
    // есть ДО `HoldingGuard` и `HeldPin` того же тика).
    a.step(NEUTRAL, { buttons: KILL, aimDir: AIM_WEST });
    expect(coreWorld.hasComponent(a.state.world, p2, 'Dead')).toBe(true);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'ActionLock')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    // Отпущенный снаряд снова тратит полёт: `FireballFlight` исключает `Held`.
    expect(coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks')).toBe(life - 1);

    // И труп его больше не таскает: разворот прицела мертвеца снаряд не двигает.
    const droppedX = x(a.state, shot);
    const droppedY = y(a.state, shot);
    for (let i = 0; i < 5; i++) a.step(NEUTRAL, { aimDir: AIM_EAST });
    expect(x(a.state, shot)).toBe(droppedX);
    expect(y(a.state, shot)).toBe(droppedY);

    // Кончается он как обычный отпущенный снаряд — своим `Lifetime`, а не
    // взрывом в руках на конце окна удержания. Остатка полёта на окно не
    // хватает, поэтому «когда именно исчез» — это и есть различающий признак.
    const left = coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks');
    expect(left).toBe(life - 6);
    expect(left).toBeLessThan(THROW_WINDOW_TICKS);
    for (let i = 0; i < left - 1; i++) a.step(NEUTRAL);
    expect(fireballs(a.state)).toHaveLength(1);
    a.step(NEUTRAL);
    expect(fireballs(a.state)).toHaveLength(0);
  });

  it('захват отпускают ВСЕ три пути смерти сцены, а не только один', () => {
    // Поведенчески выше проверен `KillSwitch`; здесь — структурный пин на то,
    // что падение и обнуление здоровья не разошлись с ним молча. Новый путь
    // смерти, оставляющий снаряд в руках трупа, обязан быть виден в диффе.
    //
    // Пути ищутся ОБХОДОМ, а не списком имён: смерть в этой сцене перестала быть
    // терминальной (`Respawn`), и путь, добавленный мимо этого теста, всё равно
    // окажется в выдаче. `Respawn` в неё не попадает намеренно: он `Dead` снимает,
    // а не ставит, — и его собственное снятие `Holding` при полном отпускании на
    // смерти уже ничего не находит. Именно это и требуется: воскресший не может
    // держать снаряд, который пережил его смерть.
    const marksDead = (system: { readonly do: unknown }): boolean => {
      let found = false;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (node === null || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        const add = record.addComponent as { component?: string } | undefined;
        if (add?.component === 'Dead') found = true;
        for (const value of Object.values(record)) walk(value);
      };
      walk(system.do);
      return found;
    };
    const paths = SCENE.systems!.filter(marksDead).map((system) => system.name);
    expect(paths).toEqual(['KillSwitch', 'FallDeath', 'HealthDeath']);

    const releases = (name: string): boolean => {
      const system = SCENE.systems!.find((candidate) => candidate.name === name);
      expect(system, `в сцене нет системы ${name}`).toBeDefined();
      const dropped = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (node === null || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        const remove = record.removeComponent as Record<string, unknown> | undefined;
        if (typeof remove?.component === 'string') dropped.add(remove.component);
        for (const value of Object.values(record)) walk(value);
      };
      walk(system);
      // Обе половины связки: руки держателя и метка на снаряде.
      return dropped.has('Holding') && dropped.has('Held');
    };
    for (const path of paths) {
      expect(releases(path), `путь смерти ${path} не отпускает захват`).toBe(true);
    }
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

  it('бросок проходит на ПОСЛЕДНЕМ тике окна: оно ровно 120 тиков (2 с)', () => {
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
    // Второй снаряд шлёт ТРЕТИЙ герой: у каста теперь свой кулдаун в 90 тиков,
    // и один стрелок за окно захвата (120 тиков) второй раз не выстрелит.
    // Он же стоит в стороне от линии огня — его снаряд обязан долететь до
    // ловца, а не сбить самого ловца по дороге.
    const a = ffa([20, 28, [20, 25.2]]);
    const p2 = a.heroes[1]!;
    const reach = (shot: EntityId): void => {
      for (let i = 0; i < 200; i++) {
        if (x(a.state, p2) - x(a.state, shot) <= 2 * FIXED_ONE) return;
        a.step();
      }
      throw new Error('снаряд не долетел до зоны захвата');
    };

    a.step([{ buttons: CAST }]);
    a.step();
    const first = fireballs(a.state)[0]!;
    reach(first);
    a.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }]);
    a.step([NEUTRAL, { aimDir: AIM_WEST }]);
    expect(coreWorld.hasComponent(a.state.world, first, 'Held')).toBe(true);
    // Бросок освобождает руки, но кулдаун захвата продолжает тикать.
    a.step([NEUTRAL, { buttons: CAST, aimDir: AIM_WEST }]);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);

    // Второй снаряд подлетает, пока захват не остыл.
    a.step([NEUTRAL, NEUTRAL, { buttons: CAST }]);
    a.step();
    const second = fireballs(a.state).find((entity) => entity !== first)!;
    expect(second).toBeDefined();
    reach(second);
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBeGreaterThan(0);

    a.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }]);
    a.step([NEUTRAL, { aimDir: AIM_WEST }]);
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
    // Оба стрелка стоят В СТОРОНЕ от ловца по ординате: снаряд теперь сбивает
    // героя, попав в коллайдер, и снаряд на линии до выбора «ближайшего» просто
    // не доживал бы. Ловец заранее ставит купол: в нём чужие снаряды ползут
    // вчетверо медленнее, и окно, где ОБА внутри зоны захвата, из доли тика
    // становится несколькими тиками — иначе выбор ближайшего не наблюдаем.
    const a = ffa([[18, 25.25], 28, [23, 23.75]]);
    const p2 = a.heroes[1]!;
    a.step([NEUTRAL, { buttons: DOME }]);
    a.step();

    // Дальний стрелок (слот 0) — первым: его снаряд получает МЕНЬШИЙ raw-индекс.
    a.step([{ buttons: CAST }]);
    a.step();
    const far = fireballs(a.state)[0]!;
    // Пауза подобрана так, чтобы младший снаряд шёл впереди старшего, но
    // недалеко: разница стартов — 5 клеток, три тика хода съедают почти две.
    for (let i = 0; i < 3; i++) a.step();
    a.step([NEUTRAL, NEUTRAL, { buttons: CAST }]);
    a.step();
    const near = fireballs(a.state).find((entity) => entity !== far)!;
    expect(near).toBeDefined();

    // Ждём кадра, где ОБА в радиусе захвата; ловец всё это время держит R и
    // отпускает ровно на нужном тике — двухтиковый «нажал-отпустил» за это
    // время увёл бы ближний снаряд за спину ловцу.
    const hold: readonly Frame[] = [NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }];
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      a.step(hold);
      const dFar = x(a.state, p2) - x(a.state, far);
      const dNear = x(a.state, p2) - x(a.state, near);
      ready = dFar <= 2.8 * FIXED_ONE && dNear > 0;
    }
    expect(ready).toBe(true);
    // Дальний снаряд ЖИВ: уничтоженный прошёл бы обе проверки ниже даром — и
    // «ближайший выбран», и «дальний не пойман» держались бы на том, что его
    // просто нет. Тест о выборе цели, а не о её исчезновении.
    expect(fireballs(a.state)).toContain(far);
    expect(x(a.state, p2) - x(a.state, near)).toBeLessThan(x(a.state, p2) - x(a.state, far));

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

/**
 * Ретюн раунда 2 и новые числа заряда — закреплены ЗДЕСЬ, а не только в
 * поведении на экране. Каждое из них тюнится игровым дизайнером в JSON, и тест
 * ловит не «неправильное» значение, а МОЛЧАЛИВОЕ его изменение: диффу теста
 * приходится объяснять, почему купол стал жить втрое дольше.
 */
describe('числа способностей: ретюн виден в диффе', () => {
  const hero = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
  const ability = hero.components.AbilityConfig!;
  const cooldowns = hero.components.Cooldowns!;

  it('перезарядки: каст 1.5 с, купол 5 с, захват 2 с', () => {
    expect(cooldowns.castMax).toBe(CAST_COOLDOWN);
    expect(cooldowns.slowDomeMax).toBe(DOME_COOLDOWN);
    expect(cooldowns.captureMax).toBe(CAPTURE_COOLDOWN);
  });

  it('длительности: купол 3 с, окно броска 2 с', () => {
    expect(ability.domeTicks).toBe(DOME_TICKS);
    // Тик захвата тратит первый тик удержания — окно броска ровно на единицу
    // короче (`HeldPin` идёт в том же тике, что и захват).
    expect(ability.holdTicks).toBe(HOLD_TICKS);
    expect(THROW_WINDOW_TICKS).toBe(120);
  });

  it('заряд: 1 с до двойного размера, 300 мс передержки, урон 100/250', () => {
    expect(ability.chargeTicks).toBe(CHARGE_TICKS);
    expect(ability.chargeGraceTicks).toBe(CHARGE_GRACE_TICKS);
    expect(ability.chargeMaxScale).toBe(CHARGE_MAX_SCALE);
    expect(ability.chargeHeavyScale).toBe(CHARGE_HEAVY_SCALE);
    expect(ability.hitDamage).toBe(HIT_DAMAGE);
    expect(ability.overchargeDamage).toBe(OVERCHARGE_DAMAGE);
    expect(ability.overchargeRadius).toBe(OVERCHARGE_RADIUS);
  });

  it('коллайдер снаряда — ровно половина героического, и манифест это зеркалит', () => {
    const fireball = SCENE.prefabs!.find((prefab) => prefab.name === 'Fireball')!;
    const collider = fireball.components.Collider!;
    expect(collider.radius).toBe(FIREBALL_RADIUS);
    expect(FIREBALL_RADIUS).toBe(Math.floor(HERO_RADIUS / 2)); // 19661 нечётен — вниз
    expect(collider.halfX).toBe(FIREBALL_RADIUS);
    expect(collider.halfY).toBe(FIREBALL_RADIUS);
    // Оболочка эффекта числами симуляции не питается (REND-1) — совпадение
    // размеров держится только этим зеркалом.
    expect(MANIFEST.effects.byKind.Fireball!.radius).toBeCloseTo(FIREBALL_RADIUS / FIXED_ONE, 3);
  });

  it('тяжёлый снаряд бьёт по своей картинке: коллайдер вдвое больше обычного', () => {
    // «Растёт вдвое» — это и хитбокс, а не только картинка: шар, который видно
    // радиусом 0.3, обязан и попадать радиусом 0.3, иначе игрок мажет по тому,
    // во что целился. Радиус тяжёлого равен ГЕРОИЧЕСКОМУ — он же вдвое больше
    // обычного снаряда.
    const heavy = SCENE.prefabs!.find((prefab) => prefab.name === 'HeavyFireball')!;
    const collider = heavy.components.Collider!;
    expect(collider.radius).toBe(HEAVY_FIREBALL_RADIUS);
    expect(HEAVY_FIREBALL_RADIUS).toBe(2 * FIREBALL_RADIUS + 1); // 9830·2, поправка округления
    expect(collider.halfX).toBe(HEAVY_FIREBALL_RADIUS);
    expect(collider.halfY).toBe(HEAVY_FIREBALL_RADIUS);
    // И то же зеркало в манифесте: нарисованный радиус — тот, которым бьют.
    expect(MANIFEST.effects.byKind.HeavyFireball!.radius).toBeCloseTo(
      HEAVY_FIREBALL_RADIUS / FIXED_ONE,
      2,
    );
    expect(heavy.tags).toEqual(['HeavyFireball', 'Fireball']);
  });

  it('щит: перезарядка 2,5 с, длительность 1 с, радиус 2,6 коллайдера героя', () => {
    expect(cooldowns.shieldMax).toBe(SHIELD_COOLDOWN);
    expect(ability.shieldTicks).toBe(SHIELD_TICKS);
    expect(ability.shieldRadiusMul).toBe(SHIELD_RADIUS_MUL);
    // Формула живёт в `ShieldRicochet` (`Collider.radius × shieldRadiusMul`), а
    // здесь пиннится её РЕЗУЛЬТАТ — как и у купола: ретюн любого из двух чисел
    // виден в диффе теста, а не только в поведении на экране.
    const world = Math.floor((HERO_RADIUS * SHIELD_RADIUS_MUL) / FIXED_ONE);
    expect(world).toBe(SHIELD_RADIUS);
    expect(SHIELD_RADIUS).toBe(Math.floor(HERO_RADIUS * 2.6));
  });

  it('геометрия щита: бокс щита содержит бокс урона и не перепрыгивается свипом', () => {
    // Три СТРУКТУРНЫХ неравенства щита — то, что делает его непротекающим при
    // любой геометрии подлёта. Они держатся не на «примерно», а на числах
    // prefab'а, и ретюн любого из них обязан быть виден в диффе теста.
    const band = SHIELD_RADIUS + FIREBALL_RADIUS;

    // (а) Бокс щита СТРОГО содержит бокс урона. Урон рождается из `Overlap`
    // физики — пересечения ОГИБАЮЩИХ (PHYS-12) с полуосями героя и снаряда, а
    // членство в щите меряется теми же полуосями снаряда плюс `shieldR`.
    // Пока `shieldR` больше полуоси героя, лунки «урон есть, рикошета нет» не
    // существует ни при какой диагонали: по каждой оси бокс щита шире.
    expect(SHIELD_RADIUS).toBeGreaterThan(HERO_RADIUS);

    // (б) Свип тика не перешагивает бокс НАСКВОЗЬ: полная ширина щита по оси
    // больше самого длинного шага снаряда, поэтому обе точки хода не могут
    // оказаться снаружи по разные стороны. `ShieldRicochet` мерит КОНЕЧНУЮ
    // точку тика, а `Overlap` — заметаемый объём; без этого неравенства
    // быстрый снаряд успевал бы задеть героя, не побывав внутри бокса.
    const maxStep = ability.throwSpeed!;
    expect(2 * band).toBeGreaterThan(maxStep);
    // Тяжёлый шар только шире — своё неравенство он наследует с запасом.
    expect(2 * (SHIELD_RADIUS + HEAVY_FIREBALL_RADIUS)).toBeGreaterThan(maxStep);

    // (в) Потолок ×64-нормализации нормали. `vec.lengthSq` увеличенной разности
    // считает dot в Q16.16, и (64·d)² обязана влезть в i32: расстояние контакта
    // d < 2,828 клетки (2√2, сырое 185364). Членство БОКСОВОЕ, и самая дальняя
    // точка бокса — его угол (band·√2), поэтому потолок на сам band вдвое
    // строже: band < 2 клетки. `shieldRadiusMul` рекламируется тюнимым, а
    // соседний `domeRadiusMul` уже 10× — на таком множителе нормализация
    // переполнилась бы молча, и снаряд разгонялся бы с каждым отскоком.
    expect(band).toBeLessThan(2 * FIXED_ONE);
    expect(Math.ceil(band * Math.SQRT2)).toBeLessThan(185364);
    expect(SHIELD_RADIUS + HEAVY_FIREBALL_RADIUS).toBeLessThan(2 * FIXED_ONE);
  });

  it('сфера щита в манифесте — синяя, полупрозрачная и ровно радиуса щита', () => {
    // Оболочка `effects.byState` числами симуляции не питается (REND-1):
    // совпадение нарисованного пузыря с отражающим держится этим зеркалом.
    const record = MANIFEST.effects.byState.Shielded!;
    expect(record.radius).toBeCloseTo(SHIELD_RADIUS / FIXED_ONE, 3);
    expect(record.alpha).toBe(0.3);
    expect(record.color).toBe('#4aa3ff');
  });

  it('вспышка взрыва заряда в манифесте — радиус самого взрыва из `AbilityConfig`', () => {
    // `ChargeExploded` бьёт площадью, и его вспышка обещает ровно ту площадь:
    // ретюн `overchargeRadius` без манифеста нарисовал бы не тот круг.
    expect(MANIFEST.effects.byEvent.ChargeExploded!.radiusTo).toBeCloseTo(
      OVERCHARGE_RADIUS / FIXED_ONE,
      3,
    );
  });
});

/** Узел JSON сцены как объект — предикат обхода систем, а не приведение типа. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DetonationSite {
  /** Система, в теле которой стоит emit взрыва. */
  readonly system: string;
  /** Переменная итерации системы — снаряд, о котором она говорит. */
  readonly as: string | undefined;
  /** Аргумент первого `destroyEntity` ПОСЛЕ emit в той же ветке; `undefined` — его там нет. */
  readonly destroyed: unknown;
}

/**
 * Все места сцены, где эмитится `FireballExploded`, — обходом дерева систем, а
 * не списком имён в тесте: путь детонации, добавленный мимо этого теста, всё
 * равно окажется в выдаче и будет проверен наравне с четырьмя нынешними.
 */
function detonationSites(): DetonationSite[] {
  const found: DetonationSite[] = [];
  for (const system of SCENE.systems ?? []) {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach((item: unknown, index) => {
          if (isRecord(item) && isRecord(item.emitEvent) && item.emitEvent.type === 'FireballExploded') {
            // Уничтожение ищется дальше по ТОЙ ЖЕ ветке, а не строго следующим
            // действием: у `HeldPin` между ними стоит снятие захвата с держателя.
            const destroy = node
              .slice(index + 1)
              .map((action: unknown) => (isRecord(action) ? action.destroyEntity : undefined))
              .find((entry: unknown) => isRecord(entry));
            found.push({ system: system.name, as: system.as, destroyed: destroy?.entity });
          }
          visit(item);
        });
        return;
      }
      if (isRecord(node)) for (const value of Object.values(node)) visit(value);
    };
    visit(system.do);
  }
  return found;
}

/**
 * Детонация снаряда как КОНТРАКТ, повторённый в четырёх системах: `emitEvent
 * FireballExploded` и `destroyEntity` того же снаряда — в одной ветке и в этом
 * порядке.
 *
 * Копий четыре, и они остаются копиями намеренно. Свести их в одну систему,
 * подписанную на внутреннее событие, мешает не DSL, а расписание: `destroyEntity`
 * в теле триггера убирает снаряд из ВСЕХ последующих запросов того же тика, и
 * порядок этого убирания у четырёх путей разный. `FireballImpact` стоит на
 * order 60 — ДО физики (её anchor — 100), и снаряд, у которого кончилась жизнь,
 * не летит, не рикошетит и не бьёт героя в свой последний тик. Перенос его
 * взрыва в общую систему после order 113 отдал бы этот тик физике: истёкший
 * снаряд, стоящий на сопернике, снял бы с него `hitDamage` — поведение, которого
 * сегодня нет (проверено прогоном A/B на копии сцены). Дублируется же при этом
 * ровно одно действие `destroyEntity`: сам emit с позицией взрыва обязан
 * остаться на месте триггера — позиция у каждого пути своя, а у `HeldPin` она
 * ещё и снята ДО того, как тот же тик подтянет снаряд к держателю.
 *
 * Поэтому копии живут, а в step их держит этот тест: комментария в сцене быть не
 * может (`system.schema.json` — `additionalProperties: false`), и инвариант
 * записан здесь.
 */
describe('детонация снаряда: четыре пути, один контракт', () => {
  const sites = detonationSites();

  it('взрыв эмитят ровно четыре системы сцены — по одному разу каждая', () => {
    // Порядок — порядок систем в сцене, то есть по `order`: 60, 105, 112, 113.
    expect(sites.map((site) => site.system)).toEqual([
      'FireballImpact',
      'HeldPin',
      'FireballHit',
      'FireballWall',
    ]);
  });

  it('за каждым взрывом в той же ветке уничтожается ТОТ ЖЕ снаряд', () => {
    // Оба пункта — про молчаливые поломки. Без `destroyEntity` снаряд
    // взрывался бы каждый тик до конца жизни; с `destroyEntity` не той
    // переменной — уносил бы чужую сущность.
    expect(sites.map((site) => site.destroyed)).toEqual(
      sites.map((site) => ({ var: site.as })),
    );
  });
});

/**
 * Пределы Q16.16 в числах сцены: ретюн ЗА границу ловится здесь.
 *
 * Симуляция считает в Q16.16 (FP-1), и `wrap` в `math/fixed.ts` заворачивает
 * результат по i32: в debug-сборке это assert, в релизной — молчаливое
 * переполнение. У трёх чисел сцены запас до этой границы конечен, и ни у одного
 * он не виден в самом числе — только в произведении, которое из него растёт.
 *
 * Клампа в контенте на них нет намеренно. Кламп у места вычисления снял бы
 * симптом и спрятал причину: щит после клампа отражал бы не туда (кламп по
 * одной оси поворачивает нормаль), а урон молча упирался бы в потолок вместо
 * заказанного дизайнером числа. Красный тест называет ошибку вслух и ровно в
 * тот момент, когда число меняют, — это и есть здесь единственный сторож.
 */
describe('пределы фиксированной точки: ретюн за границу ловится тестом', () => {
  const hero = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
  const ability = hero.components.AbilityConfig!;
  const cooldowns = hero.components.Cooldowns!;
  /** Снаряды сцены — все prefab'ы, которые несут `Projectile` и коллайдер. */
  const shots = SCENE.prefabs!.filter(
    (prefab) => prefab.components.Projectile !== undefined && prefab.components.Collider !== undefined,
  );

  /** `normScale` — из самой системы `ShieldRicochet`, а не из копии числа в тесте. */
  function ricochetNormScale(): number {
    const system = SCENE.systems!.find((entry) => entry.name === 'ShieldRicochet')!;
    const first: unknown = system.do[0];
    const bindings =
      isRecord(first) && isRecord(first.let) && isRecord(first.let.bindings)
        ? first.let.bindings
        : {};
    const value = bindings.normScale;
    if (typeof value !== 'number') throw new Error('ShieldRicochet: не найден биндинг normScale');
    return value;
  }

  it('щит: предмасштабирование `normScale` не переполняет `vec.lengthSq` ни у одного снаряда', () => {
    // `ShieldRicochet` берёт вектор от центра держателя к снаряду, множит его на
    // `normScale` (ради точности `vec.normalize`: у короткого вектора деление на
    // длину теряет значащие биты) и меряет `vec.lengthSq` — то есть
    // `mul(x,x) + mul(y,y)`. В i32 первой упирается именно эта сумма, а не
    // масштабирование: сам вектор ограничен гейтом рикошета — снаряд отражается,
    // только пока |dx| ≤ shieldR + halfX и |dy| ≤ shieldR + halfY, — поэтому
    // предел считается ИЗ ЭТОГО гейта, а не из размеров арены.
    const normScale = ricochetNormScale();
    expect(normScale).toBe(64 * FIXED_ONE);
    // Обе величины — из самой сцены: предел обязан пересчитываться от ретюна,
    // а не от зеркал теста (их совпадение со сценой пиннит тест радиуса щита).
    const shieldR = Math.floor(
      (hero.components.Collider!.radius! * ability.shieldRadiusMul!) / FIXED_ONE,
    );
    expect(shieldR).toBe(SHIELD_RADIUS);

    const worst = shots.map((prefab) => {
      const collider = prefab.components.Collider!;
      const axis = (half: number): number => {
        const band = shieldR + half; // предельное смещение, на котором рикошет ещё возможен
        const scaled = Math.floor((band * normScale) / FIXED_ONE);
        return Math.floor((scaled * scaled) / FIXED_ONE); // mul(x, x)
      };
      return [prefab.name, axis(collider.halfX!) + axis(collider.halfY!)] as const;
    });

    // Числа пиннятся: ретюн `Collider.radius` героя, `shieldRadiusMul` или
    // размера снаряда виден в диффе теста, а не только на дне запаса.
    expect(worst).toEqual([
      ['Fireball', 464332338],
      ['HeavyFireball', 626208354],
    ]);
    const overflowed = worst.filter(([, lengthSq]) => lengthSq > fixed.INT32_MAX).map(([name]) => name);
    expect(overflowed).toEqual([]);
    // Запас в ЛИНЕЙНОМ размере — корень из запаса в квадрате длины: полоса
    // рикошета (`shieldR` + скин снаряда) может вырасти ещё в 1,85 раза, дальше
    // сумма в i32 не помещается. Самый тесный случай — тяжёлый снаряд: скин у
    // него вдвое толще обычного, и запаса остаётся меньше двух, а не 2,15.
    // Ретюн щита с 1,3 на 2,6 съел ровно половину этого запаса: полоса растёт
    // линейно, а сумма — квадратично. Предел полосы ровно 2 клетки (131072:
    // `band × 64` упирается в 2^23), то есть `shieldRadiusMul` больше ≈5,66 при
    // сегодняшнем героическом коллайдере уже переполняет.
    const tightest = Math.max(...worst.map(([, lengthSq]) => lengthSq));
    expect(Math.floor(Math.sqrt(fixed.INT32_MAX / tightest) * 100) / 100).toBe(1.85);
  });

  it('заряд: `hitDamage` на максимальном заряде помещается в Q16.16', () => {
    // `ChargeRelease` считает урон как `toInt(fromInt(hitDamage) × scale²)`.
    // `scale` система сама зажимает сверху `chargeMaxScale` (min/max по `held`),
    // поэтому предел даёт именно квадрат максимума: `fromInt(hitDamage)` — это
    // hitDamage×65536, и произведение с scale² обязано остаться в i32.
    const scaleSq = Math.floor((ability.chargeMaxScale! * ability.chargeMaxScale!) / FIXED_ONE);
    expect(scaleSq).toBe(4 * FIXED_ONE);

    const product = ability.hitDamage! * scaleSq; // = mul(fromInt(hitDamage), scaleSq)
    expect(product).toBe(26214400);
    expect(fixed.toInt(product)).toBe(4 * HIT_DAMAGE); // те же 400, что пиннит тест роста урона

    // Предел ретюна: при нынешнем `chargeMaxScale` — 8191 урона, и ни единицей
    // больше. 8192 завернулось бы в отрицательное число, то есть максимальный
    // заряд ЛЕЧИЛ бы цель.
    const limit = Math.floor(fixed.INT32_MAX / scaleSq);
    expect(limit).toBe(8191);
    expect(ability.hitDamage!).toBeLessThanOrEqual(limit);
  });

  it('купол: id модификатора `1000 + slot` требует, чтобы купол не пережил свой кулдаун', () => {
    // `DomeSlow` и `DomeExpire` адресуют замедление по id `1000 + Owner.slot` —
    // ключ на СЛОТ, а не на купол. Пока у слота может быть только один живой
    // купол, это одно и то же; как только `domeTicks` перевалит за
    // `slowDomeMax`, второй купол того же героя встанет на тот же id, а истечение
    // первого сняло бы замедление, поставленное вторым.
    expect(ability.domeTicks!).toBeLessThanOrEqual(cooldowns.slowDomeMax!);
    expect(ability.domeTicks!).toBe(DOME_TICKS);
    expect(cooldowns.slowDomeMax!).toBe(DOME_COOLDOWN);
  });

  it('купол: сколько ни жми, двух живых куполов одного героя не бывает', () => {
    // Числовой инвариант выше — про причину, этот тест — про следствие, и он
    // не зависит от того, верно ли посчитан на бумаге тик смерти купола.
    const a = arena();
    const seen = new Set<EntityId>();
    let together = 0;
    for (let i = 0; i < 2 * DOME_COOLDOWN + 4; i++) {
      // Фронт кнопки каждый второй тик: касты идут при первой же возможности.
      a.step(NEUTRAL, i % 2 === 0 ? { buttons: DOME } : NEUTRAL);
      const alive = domes(a.state);
      for (const dome of alive) seen.add(dome);
      together = Math.max(together, alive.length);
    }
    // За два кулдауна купол встаёт дважды — иначе тест ничего не доказывает.
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(together).toBe(1);
  });
});

describe('фаербол: урон по герою, препятствия и пол', () => {
  it('попадание по чужому герою снимает 100 hp и уносит снаряд', () => {
    const a = arena(8);
    const p2 = a.heroes[1]!;
    pressA(a, CAST); // быстрый тап — обычный шар
    const shot = fireballs(a.state)[0]!;
    expect(projectile(a.state, shot, 'damage')).toBe(HIT_DAMAGE);
    expect(projectile(a.state, shot, 'scale')).toBe(FIXED_ONE);

    for (let i = 0; i < 60 && fireballs(a.state).length > 0; i++) a.step(NEUTRAL);
    expect(hp(a.state, p2)).toBe(1000 - HIT_DAMAGE);
    // Снаряд израсходован попаданием, а не долетел до конца жизни.
    expect(fireballs(a.state)).toHaveLength(0);
    // Стрелок цел: свой снаряд владельца не задевает (`Owner.slot`).
    expect(hp(a.state, a.heroes[0]!)).toBe(1000);
  });

  it('снаряд взрывается об обрыв плато и дальше не летит', () => {
    // Герой под южной кромкой северо-западного плато (уровень 1, ряды 11–18,
    // колонки 11–18): снаряд на север упирается в ПОДЪЁМ на y = 19, и гейт
    // (PHYS-11) при `cliffRise = −1` подъёма не пропускает.
    const a = ffa([[14, 22.5]]);
    const AIM_NORTH = 0xc000; // −y: cos = 0, sin = −1
    a.step([{ buttons: CAST, aimDir: AIM_NORTH }]);
    a.step([{ aimDir: AIM_NORTH }]);
    const shot = fireballs(a.state)[0]!;
    const life = coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks');
    expect(life).toBeGreaterThan(0);

    let exploded = false;
    let stopY = 0;
    for (let i = 0; i < 12 && fireballs(a.state).length > 0; i++) {
      stopY = coreWorld.getField(a.state.world, shot, 'Position', 'y');
      exploded = a.step().includes('FireballExploded');
      if (exploded) break;
    }
    expect(exploded).toBe(true);
    expect(fireballs(a.state)).toHaveLength(0);
    // Взрыв пришёлся на обрыв, а не на конец жизни: до него было ещё далеко.
    expect(stopY).toBeGreaterThan(19 * FIXED_ONE);
    expect(stopY).toBeLessThan(20 * FIXED_ONE);
  });

  /**
   * Урон одного тика СКЛАДЫВАЕТСЯ. Команды буфера — последняя-побеждает на поле
   * (CMD-3), и система, которая писала бы `Health.hp` на каждое событие `Damage`
   * по прочитанному из ЖИВОГО мира значению, оставляла бы от N попаданий за тик
   * ровно одно — последнее. Поэтому `DamageApply` обходит цели, а не события:
   * на цель приходится одно чтение, одна сумма и одна запись.
   */
  it('два снаряда в одного героя за тик снимают ОБА урона, а не последний (CMD-3)', () => {
    // Стрелки стоят симметрично центральному герою: снаряды выходят на равном
    // удалении и доходят до его коллайдера одним и тем же тиком.
    const a = ffa([20, 24, 28]);
    const victim = a.heroes[1]!;
    a.step([{ buttons: CAST }, NEUTRAL, { buttons: CAST, aimDir: AIM_WEST }]);
    a.step([NEUTRAL, NEUTRAL, { aimDir: AIM_WEST }]);
    expect(fireballs(a.state)).toHaveLength(2);

    let events: readonly string[] = [];
    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) {
      events = a.step([NEUTRAL, NEUTRAL, { aimDir: AIM_WEST }]);
    }

    expect(fireballs(a.state)).toHaveLength(0);
    expect(hp(a.state, victim)).toBe(1000 - 2 * HIT_DAMAGE);
    // И ровно две вспышки на два израсходованных снаряда: дедупликация взрыва
    // считается ПО СНАРЯДУ (`FireballHit` обходит снаряды), а не одним общим
    // счётчиком на весь обход событий.
    expect(events.filter((type) => type === 'FireballExploded')).toHaveLength(2);
    expect(events.filter((type) => type === 'HeroHit')).toHaveLength(2);
  });

  it('передержка и попадание в один тик снимают и 250, и 100', () => {
    // Момент разрыва заряда детерминирован (см. тест передержки), а время
    // полёта снаряда меряется отдельным прогоном той же геометрии: числа
    // скорости и коллайдеров в тест не переписываются.
    const GAP = 6;
    const probe = ffa([[24, 24.5], [24 + GAP, 24.5]]);
    const dummy = probe.heroes[0]!;
    probe.step([NEUTRAL, { buttons: CAST, aimDir: AIM_WEST }]);
    let flight = 0;
    for (let t = 2; t <= 200 && flight === 0; t++) {
      probe.step([NEUTRAL, { aimDir: AIM_WEST }]);
      if (hp(probe.state, dummy) < 1000) flight = t - 1; // тиков от НАЖАТИЯ до попадания
    }
    expect(flight).toBeGreaterThan(0);

    // Тик разрыва: заряд считается со следующего после нажатия тика, и
    // `ChargeTick` (order 29) прибавляет свой до проверки (order 35).
    const blastTick = CHARGE_TICKS + CHARGE_GRACE_TICKS + 2;
    const fireTick = blastTick - flight;
    expect(fireTick).toBeGreaterThan(0);

    const a = ffa([[24, 24.5], [24 + GAP, 24.5]]);
    const caster = a.heroes[0]!;
    let events: readonly string[] = [];
    for (let t = 1; t <= blastTick; t++) {
      events = a.step([
        { buttons: CAST },
        t === fireTick ? { buttons: CAST, aimDir: AIM_WEST } : { aimDir: AIM_WEST },
      ]);
    }

    // Оба урона пришли одним тиком — и оба легли на кастера.
    expect(events).toContain('ChargeExploded');
    expect(events).toContain('FireballExploded');
    expect(hp(a.state, caster)).toBe(1000 - OVERCHARGE_DAMAGE - HIT_DAMAGE);
    // Стрелок вне радиуса передержки (6 клеток при радиусе 3) и цел.
    expect(hp(a.state, a.heroes[1]!)).toBe(1000);
  });

  it('долетевший снаряд больше НЕ выбивает пол под собой', () => {
    // Пустая линия на восток: снаряд никого не задевает и умирает от старости.
    const a = ffa([[6, 24.5]]);
    const terrain = a.sim.terrain!;
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    let at = { x: 0, y: 0 };
    let exploded = false;
    for (let i = 0; i < FIREBALL_LIFETIME_TICKS + 4 && !exploded; i++) {
      at = {
        x: coreWorld.getField(a.state.world, shot, 'Position', 'x'),
        y: coreWorld.getField(a.state.world, shot, 'Position', 'y'),
      };
      expect(terrain.hasFloorAt(at)).toBe(true);
      exploded = a.step().includes('FireballExploded');
    }
    expect(exploded).toBe(true);
    expect(fireballs(a.state)).toHaveLength(0);
    // Тот самый `carveFloor`, который раньше делал `FireballImpact`: пола под
    // точкой взрыва он больше не снимает, и шаг туда не смертелен.
    expect(terrain.hasFloorAt(at)).toBe(true);
  });
});

/**
 * Снаряд над рельефом ведёт себя как летящий, а не как пешеход: `cliffRise: −1`
 * в его коллайдере включает направленный гейт обрыва (PHYS-11) с НУЛЕВЫМ
 * допуском подъёма. Политика тут вся в контенте — знак поля в prefab'е и
 * одноуровневые плато карты, — а механизм лишь читает поле, поэтому проверяется
 * это здесь, а не в unit-тестах ядра.
 *
 * Геометрия: северо-западное плато — уровень 1, ряды 11–18, колонки 11–18;
 * западная его кромка — ребро x = 11, восточная — рампа в колонке 19 (ряды
 * 13–16), проходимая по построению (TERR-5). Ряд 14 весь этот разрез и содержит.
 */
describe('фаербол над рельефом: направленный гейт обрыва (PHYS-11)', () => {
  /** Ряд разреза: он же ряд рампы северо-западного плато. */
  const ROW_Y = 14.5;
  /** Западная кромка северо-западного плато. */
  const RIM_X = 11;

  /** Тик выстрела: фронт ЛКМ и отпускание — самый быстрый тап, обычный шар. */
  function shoot(a: Ffa, aimDir: number): EntityId {
    a.step([{ buttons: CAST, aimDir }]);
    a.step([{ aimDir }]);
    const shot = fireballs(a.state)[0]!;
    expect(shot).toBeDefined();
    return shot;
  }

  it('выстрел в подъём взрывается о кромку плато', () => {
    // Стрелок на земле к западу от плато: снаряд идёт на восток, в подъём.
    const a = ffa([[8.5, ROW_Y]]);
    const shot = shoot(a, AIM_EAST);
    expect(a.sim.terrain!.levelAt({ x: x(a.state, shot), y: y(a.state, shot) })).toBe(0);

    let exploded = false;
    let stopX = 0;
    for (let i = 0; i < 12 && fireballs(a.state).length > 0; i++) {
      stopX = x(a.state, shot);
      exploded = a.step().includes('FireballExploded');
      if (exploded) break;
    }
    expect(exploded).toBe(true);
    expect(fireballs(a.state)).toHaveLength(0);
    // Взрыв пришёлся на кромку, а не на конец жизни: до неё лететь семь тиков.
    expect(stopX).toBeGreaterThan((RIM_X - 1) * FIXED_ONE);
    expect(stopX).toBeLessThan(RIM_X * FIXED_ONE);
  });

  it('выстрел С плато вниз свою кромку пролетает', () => {
    // Тот же самый обрыв, что и в тесте выше, — но заходом со стороны спуска:
    // герой стоит НА плато, и его снаряд уходит с кромки на землю, не
    // детонируя о неё. Ровно это и невыразимо при `cliffRise: 0`.
    const a = ffa([[15.5, ROW_Y]]);
    const terrain = a.sim.terrain!;
    expect(terrain.levelOf(a.heroes[0]!)).toBe(1);

    const shot = shoot(a, AIM_WEST);
    expect(terrain.levelAt({ x: x(a.state, shot), y: y(a.state, shot) })).toBe(1);

    let exploded = false;
    let crossed = false;
    for (let i = 0; i < 20 && !crossed; i++) {
      exploded = a.step().includes('FireballExploded');
      if (exploded || fireballs(a.state).length === 0) break;
      crossed = x(a.state, shot) < (RIM_X - 0.5) * FIXED_ONE;
    }
    expect(exploded).toBe(false);
    expect(crossed).toBe(true);
    // Снаряд жив, летит дальше и уже на земле — спуск гейт пропустил целиком.
    expect(fireballs(a.state)).toContain(shot);
    expect(vel(a.state, shot, 'x')).toBeLessThan(0);
    expect(terrain.levelAt({ x: x(a.state, shot), y: y(a.state, shot) })).toBe(0);
  });

  it('по рамповому коридору снаряд идёт насквозь — подниматься там не через что', () => {
    // Рампа обрыва не порождает (TERR-5): переход в единицу через клетку-рампу
    // проходим, статики на нём нет, и гейт снаряда там вообще не спрашивают.
    // Снаряд с востока входит в коридор колонки 19 и оказывается НА плато.
    const a = ffa([[22.5, ROW_Y]]);
    const terrain = a.sim.terrain!;
    const shot = shoot(a, AIM_WEST);

    let exploded = false;
    let onPlateau = false;
    for (let i = 0; i < 20 && !onPlateau; i++) {
      exploded = a.step().includes('FireballExploded');
      if (exploded || fireballs(a.state).length === 0) break;
      const at = { x: x(a.state, shot), y: y(a.state, shot) };
      onPlateau = at.x < 18 * FIXED_ONE && terrain.levelAt(at) === 1;
    }
    expect(exploded).toBe(false);
    expect(onPlateau).toBe(true);
    expect(fireballs(a.state)).toContain(shot);
  });

  it('над клетками без пола снаряд летит дальше и не падает', () => {
    // У снаряда нет `FallConfig`, а `FallStart` без него `Falling` не вешает —
    // провал в пустоту это политика героев, а не всего, что пересекло кромку
    // диска. Стрелок у западного края диска бьёт наружу, за границу пола.
    expect(SCENE.prefabs!.find((p) => p.name === 'Fireball')!.components.FallConfig).toBeUndefined();
    const a = ffa([[6, 24.5]]);
    const terrain = a.sim.terrain!;
    const shot = shoot(a, AIM_WEST);

    let overVoid = false;
    let exploded = false;
    let lastX = x(a.state, shot);
    for (let i = 0; i < 20 && !overVoid; i++) {
      exploded = a.step().includes('FireballExploded');
      if (exploded || fireballs(a.state).length === 0) break;
      const at = { x: x(a.state, shot), y: y(a.state, shot) };
      // Летит, а не оседает: шаг по оси выстрела на каждом тике полноценный.
      expect(at.x).toBeLessThan(lastX);
      lastX = at.x;
      overVoid = !terrain.hasFloorAt(at);
    }
    expect(exploded).toBe(false);
    expect(overVoid).toBe(true);
    // Над пустотой снаряд жив и падать не начал.
    expect(fireballs(a.state)).toContain(shot);
    expect(coreWorld.hasComponent(a.state.world, shot, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, shot, 'LevelOverride')).toBe(false);
  });
});

describe('заряд каста: рост, выстрел и передержка', () => {
  /** Урон и размер снаряда, выпущенного после `held` тиков удержания. */
  function shotAfter(held: number): { damage: number; scale: number; heavy: boolean } {
    const a = arena(8);
    chargeA(a, held);
    const shot = fireballs(a.state)[0]!;
    expect(shot).toBeDefined();
    return {
      damage: projectile(a.state, shot, 'damage'),
      scale: projectile(a.state, shot, 'scale'),
      heavy: coreWorld.hasTag(a.state.world, shot, 'HeavyFireball'),
    };
  }

  it('размер и урон растут по заряду: 0 → 100, половина → 225, максимум → 400', () => {
    // Тик нажатия окном заряда не считается: самый быстрый тап (отпускание на
    // следующем тике) обязан дать ОБЫЧНЫЙ шар, а не «чуть заряженный».
    expect(shotAfter(0)).toEqual({ damage: HIT_DAMAGE, scale: FIXED_ONE, heavy: false });
    // Половина заряда — полуторный размер и ровно его квадрат в уроне.
    expect(shotAfter(CHARGE_TICKS / 2)).toEqual({
      damage: 225,
      scale: CHARGE_HEAVY_SCALE,
      heavy: true,
    });
    expect(shotAfter(CHARGE_TICKS)).toEqual({
      damage: 400,
      scale: CHARGE_MAX_SCALE,
      heavy: true,
    });
    // Дальше максимума размер не растёт — растёт только риск передержки.
    expect(shotAfter(CHARGE_TICKS + CHARGE_GRACE_TICKS - 1).damage).toBe(400);
  });

  it('выстрел ставит кулдаун каста, и на нём заряд не начинается', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    chargeA(a, 0);
    // Кулдаун ставится в тике выстрела, а убавляет его `CooldownTick` (order 10)
    // со следующего — здесь он ещё полный.
    expect(coreWorld.getField(a.state.world, p1, 'Cooldowns', 'cast')).toBe(CAST_COOLDOWN);
    a.step({ buttons: CAST });
    expect(coreWorld.hasComponent(a.state.world, p1, 'Charging')).toBe(false);
    expect(fireballs(a.state)).toHaveLength(1);

    for (let i = 0; i < CAST_COOLDOWN; i++) a.step(NEUTRAL);
    expect(coreWorld.getField(a.state.world, p1, 'Cooldowns', 'cast')).toBe(0);
    a.step({ buttons: CAST });
    expect(coreWorld.hasComponent(a.state.world, p1, 'Charging')).toBe(true);
  });

  it('передержка на 300 мс сверх максимума рвёт заряд в самом кастере', () => {
    // Сосед стоит внутри радиуса взрыва (3 клетки), но в стороне от прицела:
    // взрыв площадной и целится не прицелом, а расстоянием.
    const a = ffa([24, [26, 24.5]]);
    const caster = a.heroes[0]!;
    const neighbour = a.heroes[1]!;
    let exploded: readonly string[] = [];
    let ticks = 0;
    while (ticks < 200 && !exploded.includes('ChargeExploded')) {
      expect(hp(a.state, caster)).toBe(1000);
      exploded = a.step([{ buttons: CAST }]);
      ticks += 1;
    }
    expect(exploded).toContain('ChargeExploded');
    // Заряд считается тиками ПОСЛЕ тика нажатия, и `ChargeTick` (order 29)
    // прибавляет свой тик до проверки (order 35) — отсюда две служебные
    // единицы. Сам порог — ровно 78 тиков заряда: максимум плюс 300 мс.
    expect(ticks - 2).toBe(CHARGE_TICKS + CHARGE_GRACE_TICKS);
    // Урон достаётся и кастеру: свои промахи стоят ровно столько же.
    expect(hp(a.state, caster)).toBe(1000 - OVERCHARGE_DAMAGE);
    expect(hp(a.state, neighbour)).toBe(1000 - OVERCHARGE_DAMAGE);
    // Кровь на попадание — то же событие, что у прямого попадания снарядом.
    expect(exploded).toContain('HeroHit');
    // Заряд израсходован, снаряда не родилось, кулдаун списан.
    expect(coreWorld.hasComponent(a.state.world, caster, 'Charging')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, caster, 'ActionLock')).toBe(false);
    expect(fireballs(a.state)).toHaveLength(0);
    expect(coreWorld.getField(a.state.world, caster, 'Cooldowns', 'cast')).toBe(CAST_COOLDOWN);
  });

  it('вне радиуса передержка не задевает никого', () => {
    const a = ffa([24, [28, 24.5]]);
    const far = a.heroes[1]!;
    for (let i = 0; i < CHARGE_TICKS + CHARGE_GRACE_TICKS + 2; i++) a.step([{ buttons: CAST }]);
    expect(hp(a.state, a.heroes[0]!)).toBe(1000 - OVERCHARGE_DAMAGE);
    expect(hp(a.state, far)).toBe(1000);
  });

  it('во время заряда манёвры заперты, а ходьба свободна (LOC-7)', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    a.step({ buttons: CAST });
    expect(coreWorld.getField(a.state.world, p1, 'ActionLock', 'mask')).toBe(1);

    // Фронт уклона С НАПРАВЛЕНИЕМ (без него манёвр игнорируется и без лока).
    a.step({ buttons: CAST | DODGE, moveX: FIXED_ONE });
    expect(coreWorld.getField(a.state.world, p1, 'LocomotionState', 'state')).toBe(0);
    a.step({ buttons: CAST, moveX: FIXED_ONE });
    a.step({ buttons: CAST | JUMP, moveX: FIXED_ONE });
    expect(coreWorld.getField(a.state.world, p1, 'LocomotionState', 'state')).toBe(0);
    // Ходьба при этом жива — лок селективный, а не «стой и заряжай».
    expect(coreWorld.getField(a.state.world, p1, 'Velocity', 'x')).toBeGreaterThan(0);
    // Отпустил — лок снят вместе с зарядом.
    a.step({ moveX: FIXED_ONE });
    expect(coreWorld.hasComponent(a.state.world, p1, 'ActionLock')).toBe(false);
  });

  it('во время заряда захват не срабатывает, а с пойманным снарядом не начинается заряд', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    const p2 = a.heroes[1]!;
    for (let i = 0; i < 200 && x(a.state, p2) - x(a.state, shot) > 2 * FIXED_ONE; i++) {
      a.step(NEUTRAL);
    }

    // p2 держит ЛКМ (заряд) и одновременно пробует поймать: захват заперт.
    a.step(NEUTRAL, { buttons: CAST });
    expect(coreWorld.hasComponent(a.state.world, p2, 'Charging')).toBe(true);
    a.step(NEUTRAL, { buttons: CAST | CAPTURE, aimDir: AIM_WEST });
    a.step(NEUTRAL, { buttons: CAST, aimDir: AIM_WEST });
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    // Кулдаун захвата не списан: `CaptureRelease` до своей ветки не дошёл.
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'capture')).toBe(0);
  });

  it('с пойманным снарядом в руках заряд не начинается — ЛКМ это бросок', () => {
    const a = arena(8);
    pressA(a, CAST);
    const shot = fireballs(a.state)[0]!;
    const p2 = a.heroes[1]!;
    for (let i = 0; i < 200 && x(a.state, p2) - x(a.state, shot) > 2 * FIXED_ONE; i++) {
      a.step(NEUTRAL);
    }
    a.step(NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST });
    a.step(NEUTRAL, { aimDir: AIM_WEST });
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(true);

    a.step(NEUTRAL, { buttons: CAST, aimDir: AIM_WEST });
    expect(coreWorld.hasComponent(a.state.world, p2, 'Charging')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p2, 'Holding')).toBe(false);
    expect(fireballs(a.state)).toHaveLength(1);
  });

  it('накопленный урон переживает захват и переброс', () => {
    const a = arena(16);
    const p1 = a.heroes[0]!;
    const p2 = a.heroes[1]!;
    chargeA(a, CHARGE_TICKS);
    const shot = fireballs(a.state)[0]!;
    expect(projectile(a.state, shot, 'damage')).toBe(400);

    for (let i = 0; i < 200 && x(a.state, p2) - x(a.state, shot) > 2 * FIXED_ONE; i++) {
      a.step(NEUTRAL);
    }
    a.step(NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST });
    a.step(NEUTRAL, { aimDir: AIM_WEST });
    expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);
    // Захват сохраняет заряд: держать в руках 400 — не то же самое, что 100.
    expect(projectile(a.state, shot, 'damage')).toBe(400);

    // Переброс на запад: владельцем становится бросивший.
    a.step(NEUTRAL, { buttons: CAST, aimDir: AIM_WEST });
    expect(coreWorld.getField(a.state.world, shot, 'Owner', 'slot')).toBe(1);
    expect(projectile(a.state, shot, 'damage')).toBe(400);

    for (let i = 0; i < 60 && fireballs(a.state).length > 0; i++) a.step(NEUTRAL);
    // Прилетело обратно в стрелка — его же зарядом.
    expect(hp(a.state, p1)).toBe(1000 - 400);
    // А бросивший цел: снаряд после переброса принадлежит ЕМУ.
    expect(hp(a.state, p2)).toBe(1000);
  });
});

/**
 * Щит (`ShieldCast` → `ShieldRicochet` → `ShieldExpire`). Механизмы под него
 * ядро дало заранее (фронт кнопки INP-2, селективный лок LOC-7, честная нормаль
 * контакта PHYS-9), а политика — здесь: КОГО пузырь отражает, что при этом
 * происходит с владельцем снаряда и как рикошет складывается с куполом и
 * захватом. Ровно это и ловится тестом: сцена, у которой щит отражает свои же
 * снаряды или отражает дважды за тик, тикает штатно и молча.
 *
 * Геометрия рикошета — не физика ядра, а её ПОВТОРЕНИЕ в контенте: снаряд
 * проходит сквозь героя (`blockMask` снаряда — только статика), поэтому события
 * `Collision` с нормалью щит не порождает, и нормаль считается по линии центров
 * — ровно так, как её определяет PHYS-9 для круглого препятствия.
 */
describe('щит: рикошет снаряда, смена владельца и связки способностей', () => {
  it('чужой снаряд отражается: скорость развёрнута, владелец — хозяин щита', () => {
    const a = ffa([20, 28]);
    const p1 = a.heroes[0]!;
    const p2 = a.heroes[1]!;
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    const speed = vel(a.state, shot, 'x');
    expect(speed).toBeGreaterThan(0);
    expect(owner(a.state, shot)).toBe(0);

    // Щит — каст-и-забыл: один фронт `E`, удержание ему ничего не добавляет.
    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, p2)).toBe(true);

    let events: readonly string[] = [];
    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) {
      events = a.step();
      if (owner(a.state, shot) === 1) break;
    }
    expect(events).toContain('ShieldRicochet');
    expect(owner(a.state, shot)).toBe(1);
    // Отражение сохраняет модуль: снаряд летит обратно ровно с той же скоростью.
    // Линия центров здесь строго горизонтальна, поэтому в фиксированной точке
    // это точное равенство, а не «примерно».
    expect(vel(a.state, shot, 'x')).toBe(-speed);
    expect(vel(a.state, shot, 'y')).toBe(0);
    // Урон хозяину щита не прошёл: `FireballHit` (order 112) читает владельца
    // ПОСЛЕ рикошета (order 108), а свой снаряд владельца не задевает.
    expect(hp(a.state, p2)).toBe(1000);

    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) a.step();
    // Стрелок получил свой же снаряд обратно.
    expect(hp(a.state, p1)).toBe(1000 - HIT_DAMAGE);
    expect(hp(a.state, p2)).toBe(1000);
  });

  it('щит истекает ровно через 60 тиков, и уязвимость возвращается', () => {
    const a = ffa([20, 28]);
    const p2 = a.heroes[1]!;
    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, p2)).toBe(true);
    // Тик каста — первый из 60: `ShieldExpire` (order 111) идёт после
    // `ShieldCast` (order 39) и убавляет счётчик уже на нём. Снимается компонент
    // ПОСЛЕ рикошета (order 108) — та же очерёдность, что у купола (`DomeSlow`
    // 34 перед `DomeExpire` 36): последний тик счётчика ещё отражает, поэтому
    // защита длится все 60 тиков, а нарисован пузырь 59 — состояние снимается с
    // конца тика.
    for (let i = 1; i < SHIELD_TICKS; i++) {
      expect(shielded(a.state, p2)).toBe(true);
      a.step();
    }
    expect(shielded(a.state, p2)).toBe(false);

    // Без щита тот же снаряд снимает свои 100.
    a.step([{ buttons: CAST }]);
    a.step();
    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) a.step();
    expect(hp(a.state, p2)).toBe(1000 - HIT_DAMAGE);
  });

  it('кулдаун щита — 3 с, и до его конца второй щит не ставится', () => {
    const a = ffa([20, 28]);
    const p2 = a.heroes[1]!;
    a.step([NEUTRAL, { buttons: SHIELD }]);
    // Кулдаун ставится в тике каста; убавляет его `CooldownTick` (order 10) со
    // следующего — здесь он ещё полный.
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'shield')).toBe(SHIELD_COOLDOWN);

    // Щит истёк, кулдаун ещё идёт — повторный фронт пустой.
    for (let i = 0; i < SHIELD_TICKS + 4; i++) a.step();
    expect(shielded(a.state, p2)).toBe(false);
    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, p2)).toBe(false);

    for (let i = 0; i < SHIELD_COOLDOWN; i++) a.step();
    expect(coreWorld.getField(a.state.world, p2, 'Cooldowns', 'shield')).toBe(0);
    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, p2)).toBe(true);
  });

  it('свой снаряд щит не отражает — выстрел из-под пузыря уходит как обычно', () => {
    // Вынос выстрела МЕНЬШЕ радиуса пузыря: снаряд рождается ВНУТРИ щита, и без
    // сравнения `Owner.slot` с `Player.slot` хозяин щита сбивал бы им себя же.
    // Неравенство пиннится здесь: перетюн выноса или радиуса щита сделал бы
    // проверку владельца лишней молча, а не в диффе.
    const ability = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!.components
      .AbilityConfig!;
    expect(ability.throwOffset).toBeLessThan(SHIELD_RADIUS + FIREBALL_RADIUS);

    const a = ffa([20, 28]);
    const p1 = a.heroes[0]!;
    const p2 = a.heroes[1]!;
    a.step([{ buttons: SHIELD }]);
    expect(shielded(a.state, p1)).toBe(true);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    const speed = vel(a.state, shot, 'x');
    expect(speed).toBeGreaterThan(0);

    // Пузырь стрелка снаряд не трогает: ни курса, ни владельца.
    for (let i = 0; i < 10 && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length === 0) break;
      expect(vel(a.state, shot, 'x')).toBe(speed);
      expect(owner(a.state, shot)).toBe(0);
    }
    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) a.step();
    // И долетает до соперника ровно так же, как без щита.
    expect(hp(a.state, p2)).toBe(1000 - HIT_DAMAGE);
    expect(hp(a.state, p1)).toBe(1000);
  });

  it('пойманный снаряд щит не отражает — он в руках, а не в полёте', () => {
    // Захват ставит снаряд в 0,45 клетки от держателя (`HeldPin`), то есть
    // ВНУТРИ его пузыря, и снаряд там чужой. Без исключения `Held` щит выбивал
    // бы из рук то, что только что поймано.
    const a = ffa([20, 28]);
    const p2 = a.heroes[1]!;
    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, p2)).toBe(true);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;

    // Ловим ДО того, как снаряд войдёт в пузырь: щит и захват целятся в одно и
    // то же, и очередь между ними решает захват (order 38 < 108).
    let caught = false;
    for (let i = 0; i < 40 && !caught && fireballs(a.state).length > 0; i++) {
      a.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }]);
      if (x(a.state, p2) - x(a.state, shot) <= 2 * FIXED_ONE) {
        a.step([NEUTRAL, { aimDir: AIM_WEST }]);
        caught = coreWorld.hasComponent(a.state.world, shot, 'Held');
      }
    }
    expect(caught).toBe(true);

    // Снаряд висит в руках, пока щит ещё жив: владелец прежний, скорость нулевая.
    for (let i = 0; i < 10; i++) {
      a.step([NEUTRAL, { aimDir: AIM_WEST }]);
      expect(coreWorld.hasComponent(a.state.world, shot, 'Held')).toBe(true);
      expect(owner(a.state, shot)).toBe(0);
      expect(vel(a.state, shot, 'x')).toBe(0);
    }
    expect(shielded(a.state, p2)).toBe(true);
  });

  it('щит, поднятый над влетевшим снарядом, разворачивает его с места — по линии центров', () => {
    // Снаряд идёт МИМО героя со сдвигом по ординате: коллайдеры не пересекаются
    // (0,47 больше суммы полувысот 0,45), а в круг щита он входит, и нормаль
    // контакта тут диагональная — та самая линия центров, которой PHYS-9
    // определяет отскок от КРУГЛОГО препятствия.
    const shooter = [20, 24.5] as const;
    const keeper = [28, 24.97] as const;
    const band = SHIELD_RADIUS + FIREBALL_RADIUS;

    /**
     * Прогон «купол соперника, выстрел, щит на тике `castAt`». Купол нужен,
     * чтобы снаряд полз вчетверо медленнее: шагом в 0,625 клетки он
     * перепрыгивал бы коридор, где оказывается внутри пузыря.
     */
    function run(castAt: number, ticks: number): { a: Ffa; shot: EntityId | null } {
      const a = ffa([shooter, keeper]);
      let shot: EntityId | null = null;
      for (let t = 1; t <= ticks; t++) {
        const frames: Frame[] = [NEUTRAL, NEUTRAL];
        if (t === 1) frames[1] = { buttons: DOME };
        if (t === 2) frames[0] = { buttons: CAST };
        if (t === castAt) frames[1] = { buttons: SHIELD };
        a.step(frames);
        shot ??= fireballs(a.state)[0] ?? null;
      }
      return { a, shot };
    }

    const gap = (a: Ffa, shot: EntityId): { dx: number; dist: number } => {
      const dx = x(a.state, shot) - x(a.state, a.heroes[1]!);
      const dy =
        coreWorld.getField(a.state.world, shot, 'Position', 'y') -
        coreWorld.getField(a.state.world, a.heroes[1]!, 'Position', 'y');
      return { dx, dist: Math.hypot(dx, dy) };
    };

    // Тик, на котором снаряд УЖЕ внутри круга и ещё сближается, меряется
    // отдельным прогоном той же геометрии — как и время полёта в тесте
    // передержки: числа скорости и радиусов в тест не переписываются.
    let castAt = 0;
    for (let t = 4; t <= 120 && castAt === 0; t++) {
      const probe = run(0, t);
      if (probe.shot === null || fireballs(probe.a.state).length === 0) continue;
      const { dx, dist } = gap(probe.a, probe.shot);
      if (dist <= band && dx < 0) castAt = t + 1;
    }
    expect(castAt).toBeGreaterThan(0);

    // Состояние ПЕРЕД щитом: снаряд внутри круга, пузыря ещё нет.
    const before = run(0, castAt - 1);
    const early = before.shot!;
    expect(shielded(before.a.state, before.a.heroes[1]!)).toBe(false);
    expect(owner(before.a.state, early)).toBe(0);
    expect(gap(before.a, early).dist).toBeLessThanOrEqual(band);
    const speed = Math.hypot(vel(before.a.state, early, 'x'), vel(before.a.state, early, 'y'));

    const after = run(castAt, castAt);
    const shot = after.shot!;
    expect(owner(after.a.state, shot)).toBe(1);
    // Отражение по линии центров: герой севернее — снаряд уходит на юг.
    expect(vel(after.a.state, shot, 'y')).toBeLessThan(0);
    // Модуль скорости сохранён: отражение — поворот, а не толчок. Диагональная
    // нормаль стоит округления в единицы Q16.16, и допуск здесь именно на них.
    const reflected = Math.hypot(vel(after.a.state, shot, 'x'), vel(after.a.state, shot, 'y'));
    expect(reflected / speed).toBeCloseTo(1, 3);
    expect(hp(after.a.state, after.a.heroes[1]!)).toBe(1000);
  });

  it('после рикошета купол нового владельца снаряд не замедляет, а купол прежнего — да', () => {
    // Рикошет меняет владельца ровно так же, как переброс: связка способностей
    // держится на одном и том же поле `Owner.slot`.
    const a = ffa([20, 28]);
    a.step([NEUTRAL, { buttons: SHIELD }]);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;

    for (let i = 0; i < 60 && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length > 0 && owner(a.state, shot) === 1) break;
    }
    expect(owner(a.state, shot)).toBe(1);

    // Купол ставит хозяин щита — свой снаряд он не трогает.
    a.step([NEUTRAL, { buttons: DOME }]);
    for (let i = 0; i < 5 && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length === 0) break;
      expect(timeScale(a.state, shot)).toBe(FIXED_ONE);
    }

    // А купол прежнего хозяина — замедляет: снаряд теперь для него чужой.
    a.step([{ buttons: DOME }]);
    let slowed = false;
    for (let i = 0; i < 60 && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length === 0) break;
      if (timeScale(a.state, shot) === SLOW) {
        slowed = true;
        break;
      }
    }
    expect(slowed).toBe(true);
  });

  it('отражённый снаряд ловится захватом — стрелок ловит собственный шар', () => {
    const a = ffa([20, 28]);
    const p1 = a.heroes[0]!;
    a.step([NEUTRAL, { buttons: SHIELD }]);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    for (let i = 0; i < 60 && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length > 0 && owner(a.state, shot) === 1) break;
    }
    expect(owner(a.state, shot)).toBe(1);

    // Снаряд возвращается — стрелок держит R и отпускает у самой зоны.
    let caught = false;
    for (let i = 0; i < 60 && !caught && fireballs(a.state).length > 0; i++) {
      // Прицел на восток: снаряд возвращается СПРАВА, и сектор захвата должен
      // смотреть на него — раствор считается от `aimDir` (`CaptureRelease`).
      a.step([{ buttons: CAPTURE, aimDir: AIM_EAST }]);
      if (x(a.state, shot) - x(a.state, p1) <= 2 * FIXED_ONE) {
        a.step([{ aimDir: AIM_EAST }]);
        caught = coreWorld.hasComponent(a.state.world, shot, 'Held');
      }
    }
    expect(caught).toBe(true);
    expect(coreWorld.getField(a.state.world, shot, 'Held', 'holder')).toBe(p1);
    expect(coreWorld.hasComponent(a.state.world, p1, 'Holding')).toBe(true);
  });

  it('тяжёлый шар возвращается стрелку целиком: 400 урона и тот же размер', () => {
    const a = ffa([20, 28]);
    const p1 = a.heroes[0]!;
    const p2 = a.heroes[1]!;
    // Полный заряд: 60 тиков удержания сверх тика нажатия.
    for (let i = 0; i <= CHARGE_TICKS; i++) a.step([{ buttons: CAST }]);
    // Отпускание — тем же тиком щит соперника: пузырь живёт секунду, и ставить
    // его заранее бессмысленно.
    a.step([NEUTRAL, { buttons: SHIELD }]);
    const shot = fireballs(a.state)[0]!;
    expect(projectile(a.state, shot, 'damage')).toBe(400);
    expect(coreWorld.hasTag(a.state.world, shot, 'HeavyFireball')).toBe(true);

    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length > 0 && owner(a.state, shot) === 1) break;
    }
    expect(owner(a.state, shot)).toBe(1);
    // Рикошет не трогает ни урон, ни размер — как и захват с перебросом.
    expect(projectile(a.state, shot, 'damage')).toBe(400);
    expect(projectile(a.state, shot, 'scale')).toBe(CHARGE_MAX_SCALE);

    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) a.step();
    expect(hp(a.state, p1)).toBe(1000 - 400);
    expect(hp(a.state, p2)).toBe(1000);
  });

  it('во время заряда и с пойманным снарядом щит не ставится', () => {
    // Те же две блокировки, что у захвата: заряд и занятые руки.
    const a = ffa([20, 28]);
    const p1 = a.heroes[0]!;
    a.step([{ buttons: CAST }]);
    expect(coreWorld.hasComponent(a.state.world, p1, 'Charging')).toBe(true);
    a.step([{ buttons: CAST | SHIELD }]);
    expect(shielded(a.state, p1)).toBe(false);
    // Кулдаун не списан: `ShieldCast` до своей ветки не дошёл.
    expect(coreWorld.getField(a.state.world, p1, 'Cooldowns', 'shield')).toBe(0);

    const b = ffa([20, 28]);
    const keeper = b.heroes[1]!;
    b.step([{ buttons: CAST }]);
    b.step();
    const shot = fireballs(b.state)[0]!;
    for (let i = 0; i < 200 && x(b.state, keeper) - x(b.state, shot) > 2 * FIXED_ONE; i++) {
      b.step();
    }
    b.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }]);
    b.step([NEUTRAL, { aimDir: AIM_WEST }]);
    expect(coreWorld.hasComponent(b.state.world, keeper, 'Holding')).toBe(true);
    b.step([NEUTRAL, { buttons: SHIELD, aimDir: AIM_WEST }]);
    expect(shielded(b.state, keeper)).toBe(false);
    expect(coreWorld.getField(b.state.world, keeper, 'Cooldowns', 'shield')).toBe(0);
  });

  it('щит не запирает ни манёвры, ни касты — он только пузырь', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    a.step({ buttons: SHIELD });
    expect(shielded(a.state, p1)).toBe(true);
    // Лока действий щит не вешает вовсе (LOC-7 — это про заряд и захват).
    expect(coreWorld.hasComponent(a.state.world, p1, 'ActionLock')).toBe(false);
    a.step({ buttons: DODGE, moveX: FIXED_ONE });
    expect(coreWorld.getField(a.state.world, p1, 'LocomotionState', 'state')).not.toBe(0);
    // И каст под щитом идёт: взаимных блокировок у них нет.
    a.step({ buttons: CAST });
    expect(coreWorld.hasComponent(a.state.world, p1, 'Charging')).toBe(true);
    expect(shielded(a.state, p1)).toBe(true);
  });

  it('два снаряда в один щит отражаются оба — по разу каждый', () => {
    // Стрелки симметричны хозяину щита: снаряды входят в пузырь одним и тем же
    // тиком. Рикошет считается ПО СНАРЯДУ (система обходит снаряды, а не щиты),
    // и одного щита хватает на обоих.
    const a = ffa([20, 24, 28]);
    const keeper = a.heroes[1]!;
    a.step([NEUTRAL, { buttons: SHIELD }]);
    a.step([{ buttons: CAST }, NEUTRAL, { buttons: CAST, aimDir: AIM_WEST }]);
    a.step([NEUTRAL, NEUTRAL, { aimDir: AIM_WEST }]);
    const shots = fireballs(a.state);
    expect(shots).toHaveLength(2);
    const speeds = shots.map((shot) => vel(a.state, shot, 'x'));

    let events: readonly string[] = [];
    for (let i = 0; i < 20 && fireballs(a.state).length === 2; i++) {
      events = a.step([NEUTRAL, NEUTRAL, { aimDir: AIM_WEST }]);
      if (shots.every((shot) => owner(a.state, shot) === 1)) break;
    }
    // Два рикошета одним тиком — и ровно два, а не один общий на обход.
    expect(events.filter((type) => type === 'ShieldRicochet')).toHaveLength(2);
    for (const [index, shot] of shots.entries()) {
      expect(owner(a.state, shot)).toBe(1);
      expect(vel(a.state, shot, 'x')).toBe(-speeds[index]!);
    }
    expect(hp(a.state, keeper)).toBe(1000);

    // Каждый снаряд возвращается СВОЕМУ стрелку.
    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) {
      a.step([NEUTRAL, NEUTRAL, { aimDir: AIM_WEST }]);
    }
    expect(hp(a.state, a.heroes[0]!)).toBe(1000 - HIT_DAMAGE);
    expect(hp(a.state, a.heroes[2]!)).toBe(1000 - HIT_DAMAGE);
    expect(hp(a.state, keeper)).toBe(1000);
  });

  it('два щита над одним снарядом дают РОВНО один рикошет — ближайшего (ACT-5)', () => {
    // Два хозяина щитов стоят по разные стороны от линии огня, каждый чуть
    // дальше суммы полувысот: снаряд не задевает коллайдер ни одного, но
    // попадает в ОБА щитовых бокса сразу. Северный ближе на две сотых клетки —
    // он и ловит (`nearestTo` меряет РАССТОЯНИЕ, боксом решается только
    // членство), а второй проход обязан не состояться: иначе скорость
    // отразилась бы дважды (то есть не отразилась вовсе), а владелец достался
    // бы последнему.
    const a = ffa([
      [20, 24.5],
      [28, 24.96],
      [28, 24.02],
    ]);
    const north = a.heroes[1]!;
    const south = a.heroes[2]!;
    const band = SHIELD_RADIUS + FIREBALL_RADIUS;
    // Купол северного замедляет чужой снаряд вчетверо: полным шагом он
    // перепрыгнул бы коридор, где оба бокса накрывают его разом.
    a.step([NEUTRAL, { buttons: DOME }]);
    a.step([NEUTRAL, { buttons: SHIELD }, { buttons: SHIELD }]);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;

    let both = false;
    for (let i = 0; i < 200 && !both && fireballs(a.state).length > 0; i++) {
      a.step();
      if (fireballs(a.state).length === 0) break;
      both =
        inShieldBox(a.state, shot, north, band) && inShieldBox(a.state, shot, south, band);
    }
    expect(both).toBe(true);
    expect(shielded(a.state, north)).toBe(true);
    expect(shielded(a.state, south)).toBe(true);

    // Владелец — ближайший из двух, и ровно он.
    expect(owner(a.state, shot)).toBe(1);
    // Отражение однократное: от северного снаряд уходит на юг. Второй проход
    // южного развернул бы его обратно на север.
    expect(vel(a.state, shot, 'y')).toBeLessThan(0);
    expect(hp(a.state, north)).toBe(1000);
    expect(hp(a.state, south)).toBe(1000);
  });

  it('два щита друг против друга гоняют снаряд, пока не кончится его жизнь', () => {
    // Пинг-понг обязан КОНЧАТЬСЯ: рикошет не продлевает `Lifetime` (в отличие
    // от переброса), поэтому снаряд доживает свои 50 тиков и взрывается сам.
    const a = ffa([22.5, 25.5]);
    a.step([{ buttons: SHIELD }, { buttons: SHIELD }]);
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    const life = coreWorld.getField(a.state.world, shot, 'Lifetime', 'ticks');
    expect(life).toBeGreaterThan(0);

    let flips = 0;
    let previous = owner(a.state, shot);
    let ticks = 0;
    for (; ticks < FIREBALL_LIFETIME_TICKS + 10 && fireballs(a.state).length > 0; ticks++) {
      a.step();
      if (fireballs(a.state).length === 0) break;
      const current = owner(a.state, shot);
      if (current !== previous) flips += 1;
      previous = current;
    }
    // Снаряд не завис между щитами — он кончился сам, и до предела жизни.
    expect(fireballs(a.state)).toHaveLength(0);
    expect(ticks).toBeLessThanOrEqual(FIREBALL_LIFETIME_TICKS);
    // И успел смениться владельцем не один раз — это именно пинг-понг.
    expect(flips).toBeGreaterThanOrEqual(3);
    // Ни один из двоих не получил урона своим же снарядом.
    expect(hp(a.state, a.heroes[0]!)).toBe(1000);
    expect(hp(a.state, a.heroes[1]!)).toBe(1000);
  });

  it('диагональный подлёт не течёт: угол урона накрыт боксом щита', () => {
    // РЕГРЕССИЯ. Урон растёт из `Overlap` физики — пересечения ОГИБАЮЩИХ
    // (PHYS-12), и по диагонали его угол достаёт до 0,45·√2 = 0,636 клетки.
    // Круг радиуса 0,54, которым щит мерился раньше, этот угол не накрывал:
    // снаряд, пришедший в лунку между 0,54 и 0,636, снимал хозяину щита 100 hp
    // без единого рикошета. Членство теперь ОСЕВОЕ — тот же бокс, которым
    // считает урон, только шире на `shieldR`.
    const AIM_NE = 8192; // 1/8 оборота — ровно 45°
    const a = ffa([
      [20, 22],
      [22.085, 24.085],
    ]);
    const keeper = a.heroes[1]!;
    const band = SHIELD_RADIUS + FIREBALL_RADIUS;

    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, keeper)).toBe(true);
    a.step([{ buttons: CAST, aimDir: AIM_NE }]);
    a.step([{ aimDir: AIM_NE }]);
    const shot = fireballs(a.state)[0]!;

    let ricochets = 0;
    let contact = 0;
    let newOwner = -1;
    for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) {
      const bounced = a.step([{ aimDir: AIM_NE }]).filter(
        (type) => type === 'ShieldRicochet',
      ).length;
      ricochets += bounced;
      if (bounced === 0 || fireballs(a.state).length === 0) continue;
      // Мерить надо в тике рикошета: дальше снаряд улетает, а потом и гибнет.
      contact = Math.hypot(
        x(a.state, shot) - x(a.state, keeper),
        y(a.state, shot) - y(a.state, keeper),
      );
      newOwner = owner(a.state, shot);
    }

    // Ровно один рикошет — и он состоялся.
    expect(ricochets).toBe(1);
    // Контакт случился ВНЕ старого круга: это ровно та угловая лунка, в которой
    // щит протекал. Пиннится именно неравенство — на нём держится регрессия.
    expect(contact).toBeGreaterThan(band);
    // Владелец сменился в том же тике — связка способностей цела.
    expect(newOwner).toBe(1);
    // И урона хозяину щита не прошло.
    expect(hp(a.state, keeper)).toBe(1000);
  });

  it('снаряд ровно в центре героя разворачивается точно назад', () => {
    // Вырожденная ветка: линии центров нет, и нормаль система берёт из
    // СОБСТВЕННОГО курса снаряда со знаком минус. Отражение через такую нормаль
    // — точный разворот, без единицы Q16.16 расхождения.
    // Точка, в которую снаряд попадает ТОЧНО, меряется отдельным прогоном той
    // же геометрии: числа выноса и скорости в тест не переписываются. Второй
    // герой прогона уведён с линии огня — снаряд обязан долететь свободно.
    const probe = ffa([20, [24, 40]]);
    probe.step([{ buttons: CAST }]);
    probe.step();
    const flying = fireballs(probe.state)[0]!;
    let center = 0;
    for (let t = 0; t < 20 && fireballs(probe.state).length > 0; t++) {
      probe.step();
      if (fireballs(probe.state).length === 0) break;
      const at = x(probe.state, flying);
      if (at >= 27 * FIXED_ONE && at <= 28 * FIXED_ONE) center = at;
    }
    expect(center).toBeGreaterThan(0);

    // Герой ровно в этой точке. Шаг снаряда (0,625 клетки) КОРОЧЕ бокса щита
    // (0,93), поэтому влетающий снаряд стоящий пузырь встречает на кромке — до
    // центра ему при поднятом щите не добраться никогда. Вырожденная ветка
    // достижима только вторым способом: щит поднимается ровно на том тике, на
    // котором снаряд встаёт в центр героя (`ShieldCast` — order 39, шаг физики —
    // 100, рикошет — 108, и всё это один тик).
    const a = ffa([20, center / FIXED_ONE]);
    const keeper = a.heroes[1]!;
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;
    const speed = vel(a.state, shot, 'x');
    expect(speed).toBeGreaterThan(0);

    let bounced = false;
    let raised = false;
    for (let i = 0; i < 30 && !bounced && fireballs(a.state).length > 0; i++) {
      // Ровно один шаг до центра — значит этот тик и есть тик контакта.
      const last = x(a.state, keeper) - x(a.state, shot) === speed;
      raised ||= last;
      bounced = a.step(last ? [NEUTRAL, { buttons: SHIELD }] : []).includes('ShieldRicochet');
    }
    expect(raised).toBe(true);
    expect(bounced).toBe(true);
    // Снаряд стоял ТОЧНО в центре: разность центров нулевая.
    expect(x(a.state, shot)).toBe(x(a.state, keeper));
    expect(y(a.state, shot)).toBe(y(a.state, keeper));
    // Разворот точный — ровно минус исходная скорость.
    expect(vel(a.state, shot, 'x')).toBe(-speed);
    expect(vel(a.state, shot, 'y')).toBe(0);
    expect(hp(a.state, keeper)).toBe(1000);
  });

  it('защита длится все 60 тиков: снаряд 60-го ещё отражается, 61-го — уже нет', () => {
    // Нарисованный пузырь живёт 59 тиков (тест истечения выше), а ЗАЩИЩАЕТ щит
    // все 60: `ShieldRicochet` (order 108) идёт перед `ShieldExpire` (order 111),
    // и на последнем тике счётчика снаряд ещё отскакивает. Здесь пиннится
    // вторая половина этой асимметрии — та, что не про картинку.
    /**
     * Прогон «щит на ПЕРВОМ тике, выстрел на тике `shotAt`»: тик каста — первый
     * из 60, поэтому номер тика контакта и есть номер тика счётчика. Отдаёт тик
     * рикошета (0 — рикошета не было) и здоровье хозяина щита.
     */
    function run(shotAt: number): { bounceAt: number; keeperHp: number } {
      const a = ffa([20, 28]);
      const keeper = a.heroes[1]!;
      let bounceAt = 0;
      for (let t = 1; t <= shotAt + 40; t++) {
        const frames: Frame[] = [NEUTRAL, NEUTRAL];
        if (t === 1) frames[1] = { buttons: SHIELD };
        if (t === shotAt) frames[0] = { buttons: CAST };
        if (a.step(frames).includes('ShieldRicochet') && bounceAt === 0) bounceAt = t;
        if (t > shotAt + 1 && fireballs(a.state).length === 0) break;
      }
      return { bounceAt, keeperHp: hp(a.state, keeper) };
    }

    // Время полёта меряется отдельным прогоном той же геометрии — числа
    // скорости и дистанции в тест не переписываются.
    const probe = run(2);
    expect(probe.bounceAt).toBeGreaterThan(0);
    const flight = probe.bounceAt - 2;

    // Выстрел так, чтобы контакт пришёлся на 60-й тик счётчика — последний.
    // Компонент снимается ПОСЛЕ рикошета (`ShieldExpire` order 111 идёт за
    // `ShieldRicochet` order 108), поэтому снаряд ещё отражается.
    const last = run(SHIELD_TICKS - flight);
    expect(last.bounceAt).toBe(SHIELD_TICKS);
    expect(last.keeperHp).toBe(1000);

    // Тиком позже щита уже нет вовсе — и тот же снаряд снимает свои 100.
    const late = run(SHIELD_TICKS - flight + 1);
    expect(late.bounceAt).toBe(0);
    expect(late.keeperHp).toBe(1000 - HIT_DAMAGE);
  });

  it('смерть под щитом снимает пузырь ТЕМ ЖЕ тиком — на трупе он не висит', () => {
    // `ShieldRicochet` труп исключает (`not: ["Dead"]`), поэтому оставшийся
    // `Shielded` ничего не защищал бы, а рисовался бы ещё до 59 тиков: синяя
    // сфера над телом, обещающая игроку защиту, которой нет.
    const a = ffa([20, 28], { extract: true });
    const keeper = a.heroes[1]!;
    const bubble = stateBit('Shielded');

    a.step([NEUTRAL, { buttons: SHIELD }]);
    expect(shielded(a.state, keeper)).toBe(true);
    expect(a.stateBits(keeper) & bubble).toBe(bubble);

    // Мгновенная смерть на середине щита (`KillSwitch`, order 20).
    a.step([NEUTRAL, { buttons: KILL }]);
    expect(coreWorld.hasComponent(a.state.world, keeper, 'Dead')).toBe(true);
    // ТЕМ ЖЕ тиком, а не через `ShieldExpire` следующего.
    expect(shielded(a.state, keeper)).toBe(false);
    expect(a.stateBits(keeper) & bubble).toBe(0);

    // И дальше не воскресает.
    a.step();
    expect(shielded(a.state, keeper)).toBe(false);
    expect(a.stateBits(keeper) & bubble).toBe(0);
  });

  it('щит снимают ВСЕ три пути смерти сцены, а не только один', () => {
    // Поведенчески выше проверен `KillSwitch`; здесь — структурный пин на то,
    // что падение и обнуление здоровья не разошлись с ним молча. Новый путь
    // смерти без снятия щита обязан быть виден в диффе этого теста.
    const drops = (name: string): boolean => {
      const system = SCENE.systems!.find((candidate) => candidate.name === name);
      expect(system, `в сцене нет системы ${name}`).toBeDefined();
      let found = false;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (node === null || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        const remove = record.removeComponent as Record<string, unknown> | undefined;
        if (remove?.component === 'Shielded') found = true;
        for (const value of Object.values(record)) walk(value);
      };
      walk(system);
      return found;
    };
    for (const path of ['KillSwitch', 'FallDeath', 'HealthDeath']) {
      expect(drops(path), `путь смерти ${path} не снимает Shielded`).toBe(true);
    }
  });

  it('захват и щит одним тиком: захват решает, щит не встаёт и кулдаун цел', () => {
    // `ShieldCast` (order 39) идёт ПОСЛЕ `CaptureRelease` (order 38): отпускание
    // `R` и нажатие `E` одним тиком дают руки, занятые снарядом, — а не
    // Shielded+Holding разом, что противоречило бы заявленной блокировке
    // «щит нельзя с пойманным снарядом».
    const a = ffa([20, 28]);
    const keeper = a.heroes[1]!;
    a.step([{ buttons: CAST }]);
    a.step();
    const shot = fireballs(a.state)[0]!;

    // Держим `R` зажатым, пока снаряд не подойдёт в сектор захвата.
    for (let i = 0; i < 200 && x(a.state, keeper) - x(a.state, shot) > 2 * FIXED_ONE; i++) {
      a.step([NEUTRAL, { buttons: CAPTURE, aimDir: AIM_WEST }]);
    }
    // Тот самый тик: `R` отпущено, `E` нажато.
    a.step([NEUTRAL, { buttons: SHIELD, aimDir: AIM_WEST }]);

    expect(coreWorld.hasComponent(a.state.world, keeper, 'Holding')).toBe(true);
    expect(shielded(a.state, keeper)).toBe(false);
    // Кулдаун щита не списан: `ShieldCast` отсеян запросом, а не веткой.
    expect(coreWorld.getField(a.state.world, keeper, 'Cooldowns', 'shield')).toBe(0);
  });

  it('щит не крадёт снаряд без отражения: перебор подклеточных выравниваний', () => {
    // РЕГРЕССИЯ. Смена владельца и событие `ShieldRicochet` стояли ВНЕ ветки
    // отражения и срабатывали, даже когда формула разворота ничего не давала:
    // снаряд у стрелка отбирали, курса ему не меняли, а ложный `bounced` тем же
    // тиком глушил взрыв `FireballWall`. Видно это только перебором
    // подклеточных выравниваний — на «круглых» позициях щит выглядит здоровым.
    //
    // На чём ветка расходилась: нормаль строится по линии центров, и стоит
    // первой точке тика внутри бокса оказаться УЖЕ за центром хозяина, как она
    // смотрит ВПЕРЁД — `v·n ≥ 0`, разворота из формулы не выходит. При щите 1,3
    // это случалось прямо здесь: шаг снаряда за тик (`throwSpeed` = 0,625
    // клетки) был БОЛЬШЕ полуребра бокса щита (0,545). Ретюн на 2,6 развёл эти
    // числа — полуребро стало 0,93, — и стоящий пузырь влетающий снаряд теперь
    // встречает строго на подлёте к центру: перебор проходит и без гейта.
    // Тест остаётся: он пиннит сам контракт (ровно один рикошет, разворот,
    // смена владельца, ни капли урона), и обратный ретюн любого из двух чисел
    // вернёт сюда ту же регрессию. Ветку `reached` при сегодняшних числах
    // держит соседний тест — «щит, поднятый над снарядом ЗА центром».
    const failures: string[] = [];
    for (let k = 0; k < 256; k++) {
      const a = ffa([20, 28 + k / 256]);
      const keeper = a.heroes[1]!;
      a.step([NEUTRAL, { buttons: SHIELD }]);
      a.step([{ buttons: CAST }]);
      a.step();
      const shot = fireballs(a.state)[0]!;
      const speed = vel(a.state, shot, 'x');
      let ricochets = 0;
      let slot = owner(a.state, shot);
      let back = speed;
      for (let i = 0; i < 30 && fireballs(a.state).length > 0; i++) {
        ricochets += a.step().filter((type) => type === 'ShieldRicochet').length;
        if (fireballs(a.state).length === 0) break;
        slot = owner(a.state, shot);
        back = vel(a.state, shot, 'x');
        if (ricochets > 0) break;
      }
      const at = `сдвиг ${k}/256 клетки`;
      if (ricochets !== 1) failures.push(`${at}: рикошетов ${ricochets}, а не один`);
      if (slot !== 1) failures.push(`${at}: владелец ${slot}, а не хозяин щита`);
      // Развёрнут, а не просто отобран, — вот на чём держится регрессия.
      if (back >= 0) failures.push(`${at}: курс не развёрнут (vx = ${back})`);
      // Модуль скорости сохранён. Точное равенство тут не выйдет: у контактов
      // почти в центре нормаль диагональная, и её нормализация стоит сотен
      // единиц Q16.16 — процента запаса на них хватает с избытком.
      if (Math.abs(Math.abs(back) - speed) > speed / 100) {
        failures.push(`${at}: модуль скорости уплыл (${back} против ${speed})`);
      }
      if (hp(a.state, keeper) !== 1000) failures.push(`${at}: щит протёк на урон`);
    }
    expect(failures).toEqual([]);
  });

  it('щит, поднятый над снарядом ЗА центром, но внутри тела, всё равно отражает', () => {
    // Вторая половина гейта — дизъюнкт `reached`, и после ретюна щита на 2,6 он
    // держится только этим тестом. Нормаль по линии центров у снаряда ЗА центром
    // хозяина смотрит вперёд (`v·n > 0`), и одной проверки скалярного
    // произведения хватило бы, чтобы такой снаряд пролетел мимо щита насквозь —
    // а он уже внутри бокса ТЕЛА, и следующая же система тика (`FireballHit`,
    // order 112) снимет с хозяина 100 hp сквозь поднятый пузырь. Поэтому гейт
    // отражает и по факту достижения тела, а не только по встречному курсу.
    //
    // Достижимо это ровно одним способом: щит поднимается на том тике, на
    // котором снаряд встаёт за центром, — стоящий пузырь при полуребре 0,93 и
    // шаге 0,625 такую точку снаряду пройти не даёт. Выравнивание перебирается,
    // а не пишется числом: оно растёт из скорости и радиусов, не из теста.
    const BODY = HERO_RADIUS + FIREBALL_RADIUS;
    const cases: string[] = [];
    for (let k = 0; k < 256 && cases.length < 4; k++) {
      const a = ffa([20, 28 + k / 256]);
      const keeper = a.heroes[1]!;
      a.step([{ buttons: CAST }]);
      a.step();
      const shot = fireballs(a.state)[0]!;
      const speed = vel(a.state, shot, 'x');
      for (let i = 0; i < 40 && fireballs(a.state).length > 0; i++) {
        const ahead = x(a.state, shot) + vel(a.state, shot, 'x') - x(a.state, keeper);
        const raise = ahead > 0 && ahead <= BODY;
        const events = a.step(raise ? [NEUTRAL, { buttons: SHIELD }] : []);
        if (!raise) continue;
        // Снаряд стоит ЗА центром: нормаль смотрит вперёд, и ветка `v·n < 0`
        // сюда не привела бы — сработать мог только `reached`.
        expect(x(a.state, shot) - x(a.state, keeper)).toBe(ahead);
        expect(events.filter((type) => type === 'ShieldRicochet')).toHaveLength(1);
        // Развернули, забрали себе и не пропустили урон.
        expect(vel(a.state, shot, 'x')).toBeLessThan(0);
        expect(owner(a.state, shot)).toBe(1);
        expect(hp(a.state, keeper)).toBe(1000);
        cases.push(`сдвиг ${k}/256: ahead=${ahead}, шаг=${speed}`);
        break;
      }
    }
    // Перебор обязан найти такие выравнивания — иначе тест зелен ни от чего.
    expect(cases).toHaveLength(4);
  });

  it('снаряд, уже миновавший героя, щит пропускает — а встречный отражает', () => {
    // Вторая половина того же вопроса: отражать надо ВСТРЕЧНОЕ. Снаряд, который
    // на момент каста уже за спиной хозяина и уходит, щит трогать не должен —
    // ни курса, ни владельца, ни события. Геометрия та же, что у теста «щит,
    // поднятый над влетевшим снарядом», только со сдвигом по ординате В ЛУНКУ
    // между боксом тела (0,45) и боксом щита (0,93 после ретюна на 2,6):
    // снаряд идёт мимо тела, урона не наносит и до `reached`-ветки не достаёт.
    const shooter = [20, 24.5] as const;
    const keeper = [28, 24.97] as const;
    const band = SHIELD_RADIUS + FIREBALL_RADIUS;
    const body = HERO_RADIUS + FIREBALL_RADIUS;
    // Сдвиг по ординате — ровно в лунку: тела не касается, бокса щита касается.
    const dy = Math.round((keeper[1] - shooter[1]) * FIXED_ONE);
    expect(dy).toBeGreaterThan(body);
    expect(dy).toBeLessThanOrEqual(band);

    /** Прогон «купол хозяина щита, выстрел, щит на тике `castAt`». */
    function run(castAt: number, ticks: number): { a: Ffa; shot: EntityId | null; bounces: number } {
      const a = ffa([shooter, keeper]);
      let shot: EntityId | null = null;
      let bounces = 0;
      for (let t = 1; t <= ticks; t++) {
        const frames: Frame[] = [NEUTRAL, NEUTRAL];
        if (t === 1) frames[1] = { buttons: DOME };
        if (t === 2) frames[0] = { buttons: CAST };
        if (t === castAt) frames[1] = { buttons: SHIELD };
        bounces += a.step(frames).filter((type) => type === 'ShieldRicochet').length;
        shot ??= fireballs(a.state)[0] ?? null;
      }
      return { a, shot, bounces };
    }

    const dx = (a: Ffa, shot: EntityId): number => x(a.state, shot) - x(a.state, a.heroes[1]!);

    // Тики «ещё сближается» и «уже уходит» меряются отдельными прогонами той же
    // геометрии — числа скорости и радиусов в тест не переписываются.
    let toward = 0;
    let past = 0;
    for (let t = 4; t <= 200 && past === 0; t++) {
      const probe = run(0, t);
      if (probe.shot === null || fireballs(probe.a.state).length === 0) continue;
      const gap = dx(probe.a, probe.shot);
      if (Math.abs(gap) > band) continue;
      if (gap < 0 && toward === 0) toward = t + 1;
      if (gap > 0 && toward !== 0) past = t + 1;
    }
    expect(toward).toBeGreaterThan(0);
    expect(past).toBeGreaterThan(toward);

    // Встречный снаряд щит отражает и забирает себе. Нормаль тут диагональная
    // (хозяин севернее линии огня), поэтому разворот виден по ординате: до
    // рикошета снаряд шёл строго на восток, после — уходит на юг.
    const met = run(toward, toward);
    expect(met.bounces).toBe(1);
    expect(owner(met.a.state, met.shot!)).toBe(1);
    expect(vel(met.a.state, met.shot!, 'y')).toBeLessThan(0);

    // А ушедший — пропускает: снаряд остаётся стрелка и летит своим курсом.
    const gone = run(past, past);
    const shot = gone.shot!;
    expect(dx(gone.a, shot)).toBeGreaterThan(0);
    expect(gone.bounces).toBe(0);
    expect(owner(gone.a.state, shot)).toBe(0);
    expect(vel(gone.a.state, shot, 'x')).toBeGreaterThan(0);
    // Курс не тронут вовсе: восточный выстрел так и идёт без ординаты.
    expect(vel(gone.a.state, shot, 'y')).toBe(0);
    // И пузырь при этом действительно стоял — пропуск не от отсутствия щита.
    expect(shielded(gone.a.state, gone.a.heroes[1]!)).toBe(true);

    // Ещё десяток тиков под тем же пузырём: снаряд уходит, владелец прежний.
    const before = x(gone.a.state, shot);
    for (let i = 0; i < 10 && fireballs(gone.a.state).length > 0; i++) gone.a.step();
    if (fireballs(gone.a.state).length > 0) {
      expect(x(gone.a.state, shot)).toBeGreaterThan(before);
      expect(owner(gone.a.state, shot)).toBe(0);
    }
    expect(hp(gone.a.state, gone.a.heroes[1]!)).toBe(1000);
  });
});

/**
 * Возрождение героя как КОНТЕНТ (`SpawnAnchor`, `Respawn`): смерть в этой сцене
 * перестала быть терминальной. Точку возрождения снимает первый тик — `Spawn`
 * запоминает НАЧАЛЬНУЮ позицию героя, где бы его ни расставили (матч, соло,
 * тест), — а `Respawn` через `AbilityConfig.respawnTicks` возвращает героя туда
 * же целым и с чистыми состояниями.
 *
 * Проверяется политика сцены, а не механизм ядра: что счётчик отмеряет ровно
 * заявленные тики, что убраны ВСЕ следы каждого из путей смерти (компонентов у
 * них разный набор) и что возрождения двух героев не мешают друг другу.
 */
describe('возрождение героя: смерть больше не терминальна', () => {
  const hero = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
  const ability = hero.components.AbilityConfig!;
  /** `AbilityConfig.respawnTicks` — 10 секунд при 60 Гц. */
  const RESPAWN_TICKS = 600;
  const REWIND = 1 << ACTION_BITS.rewind;

  const alive = (a: Arena, entity: EntityId): boolean =>
    !coreWorld.hasComponent(a.state.world, entity, 'Dead');

  /** Первый `addComponent` заданного компонента в теле системы — её значения. */
  function addedValues(node: unknown, component: string): Record<string, number> | undefined {
    if (Array.isArray(node)) {
      for (const item of node as readonly unknown[]) {
        const found = addedValues(item, component);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof node !== 'object' || node === null) return undefined;
    const record = node as Record<string, unknown>;
    const add = record.addComponent as
      | { component?: string; values?: Record<string, number> }
      | undefined;
    if (add?.component === component && add.values !== undefined) return add.values;
    for (const value of Object.values(record)) {
      const found = addedValues(value, component);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  it('срок возрождения — 10 с, и он длиннее окна пойманного снаряда', () => {
    expect(ability.respawnTicks).toBe(RESPAWN_TICKS);
    expect(RESPAWN_TICKS).toBe(10 * 60);
    // Снаряд, пойманный трупом, обязан разрешиться СВОИМ таймаутом раньше, чем
    // держатель воскреснет: иначе `HeldPin` взорвал бы его в руках уже живого
    // героя и снял бы 250 hp за смерть, случившуюся десять секунд назад.
    expect(RESPAWN_TICKS).toBeGreaterThan(ability.holdTicks!);
  });

  it('локомоушен возрождения — те же числа, что у prefab’а (зеркало)', () => {
    // Все три пути смерти снимают `Locomotion`, и вернуть его может только
    // `addComponent`, а он заполняет ВСЕ поля схемы: недоданное поле стало бы
    // нулём, и воскресший герой не сдвинулся бы с места. Второго набора чисел
    // в сцене нет — есть эта копия, и держит её в согласии с prefab'ом тест.
    const respawn = SCENE.systems!.find((system) => system.name === 'Respawn')!;
    expect(addedValues(respawn.do, 'Locomotion')).toEqual(hero.components.Locomotion);
  });

  it('точка возрождения снимается первым тиком и не едет за героем', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    const spawnX = x(a.state, p1);
    const spawnY = y(a.state, p1);
    a.step(NEUTRAL);
    expect(coreWorld.getField(a.state.world, p1, 'Spawn', 'x')).toBe(spawnX);
    expect(coreWorld.getField(a.state.world, p1, 'Spawn', 'y')).toBe(spawnY);

    for (let i = 0; i < 60; i++) a.step({ moveY: FIXED_ONE });
    expect(y(a.state, p1)).toBeGreaterThan(spawnY);
    // Точка спавна — свойство расстановки, а не текущего положения.
    expect(coreWorld.getField(a.state.world, p1, 'Spawn', 'y')).toBe(spawnY);
  });

  it('смерть от урона: ровно через 600 тиков герой жив, целый и в точке спавна', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    const spawnX = x(a.state, p1);
    const spawnY = y(a.state, p1);

    // Ульта взводится ДО смерти: её cooldown — exempt-компонент со своей
    // жизнью, и возрождение обязано оставить его тикать, а не обнулить.
    a.step({ buttons: REWIND });
    // Уходим со спавна и тратим щит с куполом: возвращение и сброс перезарядок
    // должны быть видны в числах, а не подразумеваться.
    a.step({ buttons: SHIELD });
    a.step({ buttons: DOME });
    for (let i = 0; i < 60; i++) a.step({ moveY: FIXED_ONE });
    expect(y(a.state, p1)).toBeGreaterThan(spawnY);
    expect(coreWorld.getField(a.state.world, p1, 'Cooldowns', 'shield')).toBeGreaterThan(0);

    const deathTick = a.step({ buttons: KILL });
    expect(alive(a, p1)).toBe(false);
    expect(coreWorld.getField(a.state.world, p1, 'Dead', 'atTick')).toBe(deathTick);

    let tick = deathTick;
    while (tick - deathTick < RESPAWN_TICKS - 1) {
      tick = a.step(NEUTRAL);
      // Ни тиком раньше: труп лежит все 599 промежуточных тиков.
      expect(alive(a, p1)).toBe(false);
    }
    tick = a.step(NEUTRAL);
    expect(tick - deathTick).toBe(RESPAWN_TICKS);
    expect(alive(a, p1)).toBe(true);

    expect(coreWorld.getField(a.state.world, p1, 'Health', 'hp')).toBe(1000);
    expect(x(a.state, p1)).toBe(spawnX);
    expect(y(a.state, p1)).toBe(spawnY);
    expect(vel(a.state, p1, 'x')).toBe(0);
    expect(vel(a.state, p1, 'y')).toBe(0);
    // Управление вернулось вместе с конфигурацией локомоушена, машина манёвров
    // в исходном состоянии.
    expect(coreWorld.hasComponent(a.state.world, p1, 'Locomotion')).toBe(true);
    expect(coreWorld.getField(a.state.world, p1, 'LocomotionState', 'state')).toBe(0);
    expect(coreWorld.getField(a.state.world, p1, 'Collider', 'cliffRise')).toBe(0);
    // Транзиентные состояния сняты.
    for (const component of ['Falling', 'LevelOverride', 'Shielded', 'ActionLock', 'Charging', 'Holding']) {
      expect(coreWorld.hasComponent(a.state.world, p1, component)).toBe(false);
    }
    // Перезарядки способностей обнулены — воскресший кастует сразу.
    for (const field of ['capture', 'cast', 'dodge', 'jump', 'shield', 'slowDome']) {
      expect(coreWorld.getField(a.state.world, p1, 'Cooldowns', field)).toBe(0);
    }
    // А cooldown ульты — нет: он exempt-компонент и живёт своей жизнью (сцена
    // взвела его 1200 тиков назад минус прожитое).
    const rewind = coreWorld.getField(a.state.world, p1, 'RewindCooldown', 'ticks');
    expect(rewind).toBeGreaterThan(0);
    expect(rewind).toBe(1200 - (tick - 1));
  });

  it('перезарядка ДЛИННЕЕ окна смерти обнуляется возрождением, а не дотикивает', () => {
    // Сброс перезарядок в `Respawn` при сегодняшних числах не наблюдаем:
    // `CooldownTick` тикает и у трупа, а самый долгий максимум (300) втрое
    // короче окна возрождения (600), — то есть к воскрешению всё и так по нулям.
    // Это НЕ повод убирать сброс: он и есть та защита, которая держит инвариант
    // «воскресший кастует сразу» при ретюне любого из двух чисел. Здесь ретюн
    // и разыгрывается: сцена с перезарядкой щита длиннее окна смерти.
    const LONG = 900;
    expect(LONG).toBeGreaterThan(RESPAWN_TICKS);
    const retuned: SceneDef = {
      ...SCENE,
      prefabs: SCENE.prefabs!.map((prefab) =>
        prefab.name === 'Hero'
          ? {
              ...prefab,
              components: {
                ...prefab.components,
                Cooldowns: { ...prefab.components.Cooldowns, shieldMax: LONG },
              },
            }
          : prefab,
      ),
    };

    const a = arena(8, retuned);
    const p1 = a.heroes[0]!;
    const shield = (): number => coreWorld.getField(a.state.world, p1, 'Cooldowns', 'shield');
    a.step({ buttons: SHIELD });
    expect(shield()).toBe(LONG);

    const deathTick = a.step({ buttons: KILL });
    let tick = deathTick;
    while (tick - deathTick < RESPAWN_TICKS - 1) tick = a.step(NEUTRAL);
    // Последний тик до возрождения: труп лежит, а перезарядка ещё идёт — именно
    // с ней воскресший и остался бы без сброса.
    expect(alive(a, p1)).toBe(false);
    expect(shield()).toBeGreaterThan(0);

    a.step(NEUTRAL);
    expect(alive(a, p1)).toBe(true);
    expect(shield()).toBe(0);
  });

  it('воскресший кастует немедленно — сброшенная перезарядка не обещание', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    a.step({ buttons: CAST });
    a.step(NEUTRAL);
    expect(fireballs(a.state)).toHaveLength(1);

    const deathTick = a.step({ buttons: KILL });
    for (let i = 0; i < RESPAWN_TICKS; i++) a.step(NEUTRAL);
    expect(alive(a, p1)).toBe(true);
    expect(a.step(NEUTRAL) - deathTick).toBe(RESPAWN_TICKS + 1);

    const before = fireballs(a.state).length;
    pressA(a, CAST);
    expect(fireballs(a.state).length).toBe(before + 1);
  });

  it('провал в пустоту возвращает героя на спавн со снятыми `Falling` и `LevelOverride`', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    const spawnX = x(a.state, p1);
    const spawnY = y(a.state, p1);

    let deathTick = -1;
    for (let i = 0; i < 1200 && deathTick === -1; i++) {
      const tick = a.step({ moveX: -FIXED_ONE });
      if (!alive(a, p1)) deathTick = tick;
    }
    expect(deathTick).toBeGreaterThan(0);
    // Смерть именно ПРОВАЛОМ: путь через `FallStart`/`FallDeath`, а не урон.
    expect(coreWorld.hasComponent(a.state.world, p1, 'Falling')).toBe(true);
    expect(coreWorld.hasComponent(a.state.world, p1, 'LevelOverride')).toBe(true);
    expect(coreWorld.getField(a.state.world, p1, 'Health', 'hp')).toBe(1000);

    // Труп не едет. Управление провал отбирает, а скорость оставляет — герой
    // падает по дуге, — но СМЕРТЬ её обнуляет, иначе тот же импульс десять
    // секунд тащил бы тело прочь, и возрождение выглядело бы телепортом с
    // другого конца карты. Пиннится всё окно, а не первый его тик.
    const deadX = x(a.state, p1);
    const deadY = y(a.state, p1);
    for (let i = 0; i < RESPAWN_TICKS; i++) {
      a.step(NEUTRAL);
      if (!alive(a, p1)) {
        expect(x(a.state, p1)).toBe(deadX);
        expect(y(a.state, p1)).toBe(deadY);
      }
    }
    expect(alive(a, p1)).toBe(true);
    expect(coreWorld.hasComponent(a.state.world, p1, 'Falling')).toBe(false);
    expect(coreWorld.hasComponent(a.state.world, p1, 'LevelOverride')).toBe(false);
    expect(x(a.state, p1)).toBe(spawnX);
    expect(y(a.state, p1)).toBe(spawnY);
    expect(coreWorld.hasComponent(a.state.world, p1, 'Locomotion')).toBe(true);
  });

  it('смерть соседа посреди чужого окна возрождения ничего не сдвигает', () => {
    const a = arena(8);
    const p1 = a.heroes[0]!;
    const p2 = a.heroes[1]!;

    const firstDeath = a.step({ buttons: KILL });
    // Второй умирает на середине окна первого — счётчики независимы, потому что
    // считаются от СВОЕГО `Dead.atTick`.
    for (let i = 0; i < RESPAWN_TICKS / 2 - 1; i++) a.step(NEUTRAL);
    const secondDeath = a.step(NEUTRAL, { buttons: KILL });
    expect(secondDeath - firstDeath).toBe(RESPAWN_TICKS / 2);
    expect(alive(a, p1)).toBe(false);
    expect(alive(a, p2)).toBe(false);

    for (let i = 0; i < RESPAWN_TICKS / 2; i++) a.step(NEUTRAL);
    // Первый воскрес ровно на своём 600-м тике, второй ещё лежит.
    expect(alive(a, p1)).toBe(true);
    expect(alive(a, p2)).toBe(false);

    for (let i = 0; i < RESPAWN_TICKS / 2; i++) a.step(NEUTRAL);
    expect(alive(a, p2)).toBe(true);
    // И каждый — в своей точке, а не в чужой.
    expect(x(a.state, p1)).toBeLessThan(x(a.state, p2));
  });

  it('возрождение доезжает до рендера СОБЫТИЕМ, а не разрывом доставки', () => {
    // Сквозной путь до того шва, где рендер снимает фиксацию последнего кадра
    // клипа смерти (`rendering` REND-4): доставленный вид. Проверяется ровно
    // то, на чём держится картинка живого героя, — что снять фиксацию нечем,
    // кроме события: сущность та же, разрыва непрерывности нет, а прыжок на
    // точку спавна приезжает пер-сущностным телепортом, который значит «не
    // интерполировать», а не «этот труп ожил».
    const a = ffa([20, 28], { extract: true });
    const p1 = a.heroes[0]!;
    a.step(); // первый тик снимает точку спавна (`SpawnAnchor`)
    const spawnY = coreWorld.getField(a.state.world, p1, 'Spawn', 'y');

    // Уходим со спавна — иначе возрождение не двигало бы героя вовсе.
    for (let i = 0; i < 60; i++) a.step([{ moveY: FIXED_ONE }]);
    expect(y(a.state, p1)).toBeGreaterThan(spawnY);

    a.step([{ buttons: KILL }]);
    expect(coreWorld.hasComponent(a.state.world, p1, 'Dead')).toBe(true);
    for (let i = 0; i < RESPAWN_TICKS - 1; i++) a.step();
    expect(coreWorld.hasComponent(a.state.world, p1, 'Dead')).toBe(true);

    const types = a.step();
    expect(types).toContain(RESPAWN_EVENT);
    expect(coreWorld.hasComponent(a.state.world, p1, 'Dead')).toBe(false);

    const view = a.view();
    expect(view.freshEvents).toBe(true);
    // Разрыва непрерывности НЕТ: мир идёт вперёд, и `onSnap` рендеру никто не
    // адресует — раньше именно поэтому герой оставался невидимым.
    expect(view.snapAll).toBe(false);
    const respawn = view.events.find((event) => event.type === RESPAWN_EVENT)!;
    expect(respawn.data.entity).toBe(p1);
    const hero = view.entities.get(p1)!;
    // Сущность НЕ пересоздана: инстанс и его контроллер у рендера те же.
    expect(hero.spawned).toBe(false);
    // Прыжок на спавн виден телепортом — и только им.
    expect(hero.snap).toBe(true);
    expect(hero.currY).toBeCloseTo(spawnY / FIXED_ONE, 6);
  });
});

/**
 * Ульта отката как КОНТЕНТ (`RewindCast`, `RewindCooldownTick`): проверяется не
 * механизм перемотки — он закрыт тестами ядра, сети и оболочки, — а политика,
 * написанная в сцене: гейт по фронту кнопки и по cooldown'у, взвод cooldown'а и
 * состав payload'а запроса. Мир здесь никто не перематывает: ядро событие не
 * интерпретирует, а хоста в этом стенде нет (WSM-5).
 */
describe('ульта отката: политика в сцене (RewindCast)', () => {
  /** Те же числа, что в `duel.scene.json`: 20 секунд перезарядки и 7 секунд глубины. */
  const REWIND_COOLDOWN = 1200;
  const REWIND_DEPTH = 420;
  const REWIND = 1 << ACTION_BITS.rewind;

  const requests = (state: SimulationState): readonly Record<string, number>[] =>
    [...state.events].filter((event) => event.type === REWIND_REQUEST_EVENT).map((e) => e.data);

  it('фронт кнопки эмитит запрос с инициатором и глубиной и взводит cooldown', () => {
    const a = arena();
    const hero = a.heroes[0]!;
    a.step({ buttons: REWIND });

    expect(requests(a.state)).toEqual([{ depthTicks: REWIND_DEPTH, initiator: hero }]);
    expect(coreWorld.getField(a.state.world, hero, 'RewindCooldown', 'ticks')).toBe(REWIND_COOLDOWN);
  });

  it('удержание второго запроса не даёт: ульта ловит фронт (INP-2)', () => {
    const a = arena();
    a.step({ buttons: REWIND });
    a.step({ buttons: REWIND });

    expect(requests(a.state)).toEqual([]);
  });

  it('во время cooldown ульта не кастуется', () => {
    const a = arena();
    const hero = a.heroes[0]!;
    a.step({ buttons: REWIND });
    // Отпустили и нажали снова через сотню тиков: фронт есть, cooldown — нет.
    for (let i = 0; i < 100; i++) a.step(NEUTRAL);
    a.step({ buttons: REWIND });

    expect(requests(a.state)).toEqual([]);
    // Cooldown при этом убывает по тику, а не стоит.
    expect(coreWorld.getField(a.state.world, hero, 'RewindCooldown', 'ticks')).toBe(
      REWIND_COOLDOWN - 101,
    );
  });

  it('заряженный каст ульту не пускает: гейт по Charging', () => {
    const a = arena();
    // ЛКМ зажата — герой копит заряд (`ChargeStart`), и `RewindCast` его не видит.
    a.step({ buttons: CAST });
    a.step({ buttons: CAST | REWIND });

    expect(requests(a.state)).toEqual([]);
  });

  it('конфиг матча и раскладка сборки называют одно и то же', () => {
    // Бит удержания сервер читает по номеру из документа матча, а сцена ловит
    // фронт по своему литералу: разойдись они — ульта кастовалась бы одной
    // кнопкой, а скраб вёлся бы другой.
    expect(MATCH.rewind?.holdButton).toBe(ACTION_BITS.rewind);
    // Cooldown ульты переживает откат (REW-9) — иначе удержанная кнопка
    // кастовала бы её заново на первом же живом тике после возобновления.
    expect(MATCH.rewind?.exempt).toEqual([{ component: 'RewindCooldown' }]);
    // Буфер истории обязан покрывать глубину автостопа: 30 × (15 − 1) = 420.
    const depth = (MATCH.rewind!.interval) * (MATCH.rewind!.capacity - 1);
    expect(depth).toBeGreaterThanOrEqual(REWIND_DEPTH);
  });

  it('темп скраба локальной сборки — темп цикла рассылки матча (SHELL-8)', () => {
    // Сервер делает шаг ведения точки раз в ЦИКЛ РАССЫЛКИ (REW-13), локальная
    // оболочка — раз в `scrub.every` тиков. Величина одна и та же, и выводиться
    // она обязана из документа матча: совпади они умолчаниями — ульта отматывала
    // бы на разную глубину за одно и то же удержание в зависимости от того, кто
    // произвёл тик.
    const cycleTicks = Math.max(
      1,
      Math.round((MATCH.tickRate ?? 60) / (MATCH.snapshotRate ?? 30)),
    );
    expect(DEMO_SCRUB_EVERY).toBe(cycleTicks);
    // И шаг в тиках — тот же, что у сервера: он приезжает из того же документа.
    expect(MATCH.rewind?.step).toBeGreaterThan(0);
  });
});
