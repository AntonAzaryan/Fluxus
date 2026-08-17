/**
 * Слой способностей классического мозга: тап и заряд, кулдаун с джиттером,
 * выбор между способностями по цели, перехват прицела и запрыгивание на уступ.
 *
 * Мир здесь литеральный: слой живёт за границей BOT-3 — он работает с float и
 * снапшота не касается вовсе, а собранная руками фикстура проверяла бы разбор
 * снапшота, а не решение. Настоящий поток наблюдений остаётся там, где он
 * что-то значит, — в конце файла, где мозг целиком играет в матче.
 */
import { describe, expect, it } from 'vitest';
import { AbilityLayer } from '../src/brains/classic/abilities.js';
import { MicroLayer } from '../src/brains/classic/micro.js';
import { brainRandom } from '../src/brains/classic/random.js';
import { classicBrain } from '../src/brains/classic/classicBrain.js';
import type { PerceivedWorld } from '../src/brains/classic/perception.js';
import type { BehaviorPlan } from '../src/brains/classic/utility.js';
import { BotHost } from '../src/host.js';
import type { BotAbilityProfile, BotProfile } from '../src/profile.js';
import {
  boltConfig,
  connectBot,
  connectHuman,
  harness,
  holeTerrain,
  ledgeTerrain,
  settle,
  stepMatch,
  testProfile,
} from './fixtures.js';

const random = (): ReturnType<typeof brainRandom> => brainRandom(7, 'abilities');

function scene(overrides: Partial<PerceivedWorld> = {}): PerceivedWorld {
  return {
    tick: 100,
    observedTick: 100,
    self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
    enemies: [],
    threats: [],
    arenaRadius: 20,
    ...overrides,
  };
}

function enemyAt(x: number, y: number, visible = true): PerceivedWorld['enemies'][number] {
  return { id: 2, x, y, vx: 0, vy: 0, slot: 0, team: 0, seenTick: 100, visible };
}

function threatAt(x: number, vx: number, closing = true): PerceivedWorld['threats'][number] {
  return { id: 3, x, y: 0, vx, vy: 0, distance: Math.abs(x), closing };
}

/** План маршрута: цель движения задаётся явно — от неё зависят манёвры. */
function plan(targetX = 0, targetY = 0): BehaviorPlan {
  return { behavior: 'pressure', targetX, targetY, aim: undefined, strafe: false };
}

const CAST: BotAbilityProfile = {
  name: 'cast',
  button: 0,
  target: 'enemy',
  range: 8,
  holdTicks: 4,
  cooldownTicks: 20,
  weight: 1,
};

const SHIELD: BotAbilityProfile = {
  name: 'shield',
  button: 6,
  target: 'threat',
  range: 5,
  holdTicks: 1,
  cooldownTicks: 30,
  weight: 2,
};

const JUMP: BotAbilityProfile = {
  name: 'jump',
  button: 3,
  target: 'cliff',
  range: 1.6,
  rise: 1,
  holdTicks: 1,
  cooldownTicks: 10,
  weight: 1,
  requiresMoving: true,
};

function withAbilities(
  abilities: readonly BotAbilityProfile[],
  overrides: Partial<BotProfile> = {},
): BotProfile {
  return testProfile({ abilities, ...overrides });
}

describe('способности: удержание и отпускание (BOT-6)', () => {
  it('тап — тик с битом и тик без него: сцена получает и фронт, и спад', () => {
    const layer = new AbilityLayer(withAbilities([{ ...CAST, holdTicks: 1 }]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    expect(layer.step(near, plan(), 0).buttons).toBe(1);
    expect(layer.step(near, plan(), 1).buttons).toBe(0);
  });

  it('заряд держится ровно `holdTicks` и отпускается спадом', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    const held: number[] = [];
    for (let tick = 0; tick < 6; tick++) held.push(layer.step(near, plan(), tick).buttons);
    // Четыре тика с битом, затем спад — и дальше кулдаун, а не второй заряд.
    expect(held).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it('кулдаун отсчитывается от отпускания: раньше срока способность молчит', () => {
    const layer = new AbilityLayer(
      // Джиттер решений нулевой — иначе кулдаун поехал бы и срок не читался глазами.
      withAbilities([{ ...CAST, holdTicks: 1, cooldownTicks: 5 }]),
      random(),
    );
    const near = scene({ enemies: [enemyAt(2, 0)] });
    expect(layer.step(near, plan(), 0).buttons).toBe(1);
    expect(layer.step(near, plan(), 1).buttons).toBe(0);
    for (let tick = 2; tick < 6; tick++) expect(layer.step(near, plan(), tick).buttons).toBe(0);
    expect(layer.step(near, plan(), 6).buttons).toBe(1);
  });

  it('нулевой вес выключает способность целиком', () => {
    const layer = new AbilityLayer(withAbilities([{ ...CAST, weight: 0 }]), random());
    expect(layer.step(scene({ enemies: [enemyAt(2, 0)] }), plan(), 0).buttons).toBe(0);
  });
});

describe('способности: выбор цели (BOT-3, BOT-6)', () => {
  it('по врагу — только по видимому: помнимое положение кулдауна не стоит', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    const remembered = scene({ enemies: [enemyAt(2, 0, false)] });
    expect(layer.step(remembered, plan(), 0).buttons).toBe(0);
  });

  it('враг за дальностью — не жмётся', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    expect(layer.step(scene({ enemies: [enemyAt(20, 0)] }), plan(), 0).buttons).toBe(0);
  });

  it('по угрозе — только по сближающейся: улетающий снаряд не страшен', () => {
    const layer = new AbilityLayer(withAbilities([SHIELD]), random());
    const leaving = scene({ threats: [threatAt(2, 1, false)] });
    expect(layer.step(leaving, plan(), 0).buttons).toBe(0);
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    expect(layer.step(incoming, plan(), 1).buttons).toBe(1 << 6);
  });

  it('перехват прицела: применение по угрозе смотрит на снаряд', () => {
    const layer = new AbilityLayer(withAbilities([SHIELD]), random());
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    expect(layer.step(incoming, plan(), 0).aim).toEqual({ x: -2, y: 0 });
  });

  it('соревнуются весом и близостью: защита от снаряда в упор перебивает каст', () => {
    const layer = new AbilityLayer(withAbilities([CAST, SHIELD]), random());
    const both = scene({ enemies: [enemyAt(2, 0)], threats: [threatAt(-1, 1)] });
    expect(layer.step(both, plan(), 0).buttons).toBe(1 << 6);
  });

  it('заряд бросается досрочно, когда прилетает то, от чего есть чем закрыться', () => {
    const layer = new AbilityLayer(withAbilities([CAST, SHIELD]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    expect(layer.step(near, plan(), 0).buttons).toBe(1);
    expect(layer.holding).toBe('cast');
    const attacked = scene({ enemies: [enemyAt(2, 0)], threats: [threatAt(-1, 1)] });
    // Спад заряда — тик раньше срока: докачивать под летящий снаряд некогда.
    expect(layer.step(attacked, plan(), 1).buttons).toBe(0);
    expect(layer.holding).toBeUndefined();
    expect(layer.step(attacked, plan(), 2).buttons).toBe(1 << 6);
  });
});

describe('способности: манёвры и рельеф (LOC-4, LOC-5)', () => {
  const dodge: BotAbilityProfile = { ...SHIELD, name: 'dodge', button: 2, requiresMoving: true };

  it('манёвр без направления не жмётся: симуляция его игнорирует', () => {
    const layer = new AbilityLayer(withAbilities([dodge]), random());
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    // Цель маршрута там же, где бот: вектор движения нулевой.
    expect(layer.step(incoming, plan(0, 0), 0).buttons).toBe(0);
    expect(layer.step(incoming, plan(0, 5), 1).buttons).toBe(1 << 2);
  });

  it('уступ по курсу в пределах прыжка — прыжок', () => {
    const layer = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: ledgeTerrain(4) });
    const at = scene({ self: { id: 1, x: 3.2, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(7, 2), 0).buttons).toBe(1 << 3);
  });

  it('уступ выше прыжка не жмётся: обрыв блокирует и в полёте (PHYS-11)', () => {
    const layer = new AbilityLayer(withAbilities([{ ...JUMP, rise: 0 }]), random(), {
      terrain: ledgeTerrain(4),
    });
    const at = scene({ self: { id: 1, x: 3.2, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(7, 2), 0).buttons).toBe(0);
  });

  it('спуск с уступа — тоже прыжок: наземного вниз обрыв не пускает (PHYS-11)', () => {
    const layer = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: ledgeTerrain(4) });
    // Бот СВЕРХУ (уровень 1) и идёт вниз. Без прыжка он остался бы на плато
    // навсегда: при нулевом допуске обрыв блокирует в обе стороны.
    const at = scene({ self: { id: 1, x: 4.6, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(0, 2), 0).buttons).toBe(1 << 3);
  });

  it('ровное место — не прыжок: кнопка не жмётся просто так', () => {
    const layer = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: ledgeTerrain(4) });
    const at = scene({ self: { id: 1, x: 1, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(3, 2), 0).buttons).toBe(0);
  });

  it('дыра по курсу, за которой есть пол, — прыжок; без террейна — никогда', () => {
    const at = scene({ self: { id: 1, x: 3.2, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    const jumper = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: holeTerrain(4) });
    expect(jumper.step(at, plan(7, 2), 0).buttons).toBe(1 << 3);
    const blind = new AbilityLayer(withAbilities([JUMP]), random());
    expect(blind.step(at, plan(7, 2), 0).buttons).toBe(0);
  });
});

describe('способности: разрыв непрерывности (SHELL-7, NTR-16)', () => {
  it('перемотка снимает удержание и кулдауны — они про стёртую ветвь', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    expect(layer.step(near, plan(), 100).buttons).toBe(1);
    expect(layer.holding).toBe('cast');
    layer.forget();
    expect(layer.holding).toBeUndefined();
    // Номера тиков после перемотки идут НАЗАД: несброшенный кулдаун держал бы
    // способность незаряженной ровно ту глубину, которую унесла перемотка.
    expect(layer.step(near, plan(), 10).buttons).toBe(1);
  });
});

describe('микро-слой: стрейф (BOT-6)', () => {
  const options = { tickSeconds: 1 / 60 };

  function run(profile: BotProfile, ticks: number): { x: number; y: number } {
    const layer = new MicroLayer(profile, random(), options);
    const world = scene({ enemies: [enemyAt(9, 0)] });
    const route: BehaviorPlan = { ...plan(9, 0), strafe: true };
    let intent = layer.step(route, world, 0);
    for (let tick = 1; tick < ticks; tick++) intent = layer.step(route, world, tick);
    return { x: intent.moveX, y: intent.moveY };
  }

  it('нулевой стрейф даёт прямой ход, ненулевой — поперечную составляющую', () => {
    expect(Math.abs(run(testProfile(), 10).y)).toBeLessThan(1e-6);
    const strafing = run(
      testProfile({
        movement: {
          maxSpeed: 1,
          arriveTolerance: 0.25,
          edgeMargin: 2,
          engageRange: 8,
          strafe: 0.5,
          strafePeriodTicks: 30,
        },
      }),
      10,
    );
    expect(Math.abs(strafing.y)).toBeGreaterThan(0);
    // И вперёд бот при этом идти не перестаёт: стрейф подмешивается к ходу, а не
    // заменяет его.
    expect(strafing.x).toBeGreaterThan(0);
  });

  it('дойдя до дистанции боя, бот кружит, а не замирает на линии огня', () => {
    const profile = testProfile({
      movement: {
        maxSpeed: 1,
        arriveTolerance: 0.25,
        edgeMargin: 2,
        engageRange: 8,
        strafe: 0.6,
        strafePeriodTicks: 30,
      },
    });
    const layer = new MicroLayer(profile, random(), options);
    const world = scene({ enemies: [enemyAt(5, 0)] });
    // Цель маршрута — там, где бот стоит: ход steering'а ноль, и ось
    // поперечности остаётся только от направления на противника.
    const route: BehaviorPlan = { ...plan(0, 0), aim: { x: 5, y: 0 }, strafe: true };
    let intent = layer.step(route, world, 0);
    for (let tick = 1; tick < 5; tick++) intent = layer.step(route, world, tick);
    expect(Math.abs(intent.moveY)).toBeGreaterThan(0.5);
    expect(Math.abs(intent.moveX)).toBeLessThan(1e-6);
  });

  it('стрейф не делает бота быстрее доли хода из профиля (INP-3)', () => {
    const profile = testProfile({
      movement: {
        maxSpeed: 0.5,
        arriveTolerance: 0.25,
        edgeMargin: 2,
        engageRange: 8,
        strafe: 1,
        strafePeriodTicks: 5,
      },
    });
    const layer = new MicroLayer(profile, random(), options);
    const world = scene({ enemies: [enemyAt(9, 0)] });
    const route: BehaviorPlan = { ...plan(9, 0), strafe: true };
    for (let tick = 0; tick < 40; tick++) {
      const intent = layer.step(route, world, tick);
      expect(Math.hypot(intent.moveX, intent.moveY)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  it('сторона стрейфа держится период из профиля, а не дрожит каждый тик', () => {
    const profile = testProfile({
      movement: {
        maxSpeed: 1,
        arriveTolerance: 0.25,
        edgeMargin: 2,
        engageRange: 8,
        strafe: 0.6,
        strafePeriodTicks: 12,
      },
    });
    const layer = new MicroLayer(profile, random(), options);
    const world = scene({ enemies: [enemyAt(9, 0)] });
    const route: BehaviorPlan = { ...plan(9, 0), strafe: true };
    const sides: number[] = [];
    for (let tick = 0; tick < 12; tick++) sides.push(Math.sign(layer.step(route, world, tick).moveY));
    expect(new Set(sides).size).toBe(1);
  });
});

describe('мозг в матче: несколько способностей одним кодом (BOT-6)', () => {
  it('бот жмёт и каст по врагу, и защиту по летящему снаряду', async () => {
    // Снаряд летит в слот бота, противник стоит рядом: обе цели есть
    // одновременно, и профиль решает, чем именно бот отвечает.
    const fixture = harness(boltConfig(0.1));
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: classicBrain({ tickSeconds: 1 / 60 }),
      profile: withAbilities([{ ...CAST, holdTicks: 2 }, SHIELD]),
    });
    await settle();
    for (let i = 0; i < 90; i++) await stepMatch(fixture, [human.host, seat]);

    const frames = (fixture.server.toScenario().inputs ?? []).filter(
      (frame) => frame.playerId === 'bot-1',
    );
    const pressed = new Set(frames.map((frame) => frame.buttons).filter((mask) => mask !== 0));
    expect(pressed.has(1 << CAST.button)).toBe(true);
    expect(pressed.has(1 << SHIELD.button)).toBe(true);
    // Две кнопки разом не жмутся: маска одна, и сцена читала бы их как
    // последовательность, которой бот не задумывал.
    for (const mask of pressed) expect(mask & (mask - 1)).toBe(0);
    bots.dispose();
  });
});
