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
    slots: [],
    enemies: [],
    threats: [],
    arenaRadius: 20,
    carrying: false,
    ...overrides,
  };
}

function enemyAt(x: number, y: number, visible = true): PerceivedWorld['enemies'][number] {
  return { id: 2, x, y, vx: 0, vy: 0, slot: 0, team: 0, seenTick: 100, visible };
}

function threatAt(x: number, vx: number, closing = true): PerceivedWorld['threats'][number] {
  return { id: 3, x, y: 0, vx, vy: 0, distance: Math.abs(x), closing };
}

/**
 * Тик решения (BOT-6). Здесь он всегда наступил: вероятностей профиля в этих
 * проверках нет, а всё остальное слой решает каждый тик независимо от него.
 */
const DECIDING = true;

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
    expect(layer.step(near, plan(), 0, DECIDING).buttons).toBe(1);
    expect(layer.step(near, plan(), 1, DECIDING).buttons).toBe(0);
  });

  it('заряд держится ровно `holdTicks` и отпускается спадом', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    const held: number[] = [];
    for (let tick = 0; tick < 6; tick++) held.push(layer.step(near, plan(), tick, DECIDING).buttons);
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
    expect(layer.step(near, plan(), 0, DECIDING).buttons).toBe(1);
    expect(layer.step(near, plan(), 1, DECIDING).buttons).toBe(0);
    for (let tick = 2; tick < 6; tick++) expect(layer.step(near, plan(), tick, DECIDING).buttons).toBe(0);
    expect(layer.step(near, plan(), 6, DECIDING).buttons).toBe(1);
  });

  it('нулевой вес выключает способность целиком', () => {
    const layer = new AbilityLayer(withAbilities([{ ...CAST, weight: 0 }]), random());
    expect(layer.step(scene({ enemies: [enemyAt(2, 0)] }), plan(), 0, DECIDING).buttons).toBe(0);
  });
});

describe('способности: выбор цели (BOT-3, BOT-6)', () => {
  it('по врагу — только по видимому: помнимое положение кулдауна не стоит', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    const remembered = scene({ enemies: [enemyAt(2, 0, false)] });
    expect(layer.step(remembered, plan(), 0, DECIDING).buttons).toBe(0);
  });

  it('враг за дальностью — не жмётся', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    expect(layer.step(scene({ enemies: [enemyAt(20, 0)] }), plan(), 0, DECIDING).buttons).toBe(0);
  });

  it('по угрозе — только по сближающейся: улетающий снаряд не страшен', () => {
    const layer = new AbilityLayer(withAbilities([SHIELD]), random());
    const leaving = scene({ threats: [threatAt(2, 1, false)] });
    expect(layer.step(leaving, plan(), 0, DECIDING).buttons).toBe(0);
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    expect(layer.step(incoming, plan(), 1, DECIDING).buttons).toBe(1 << 6);
  });

  it('перехват прицела: применение по угрозе смотрит на снаряд', () => {
    const layer = new AbilityLayer(withAbilities([SHIELD]), random());
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    expect(layer.step(incoming, plan(), 0, DECIDING).aim).toEqual({ x: -2, y: 0 });
  });

  it('соревнуются весом и близостью: защита от снаряда в упор перебивает каст', () => {
    const layer = new AbilityLayer(withAbilities([CAST, SHIELD]), random());
    const both = scene({ enemies: [enemyAt(2, 0)], threats: [threatAt(-1, 1)] });
    expect(layer.step(both, plan(), 0, DECIDING).buttons).toBe(1 << 6);
  });

  it('заряд бросается досрочно, когда прилетает то, от чего есть чем закрыться', () => {
    const layer = new AbilityLayer(withAbilities([CAST, SHIELD]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    expect(layer.step(near, plan(), 0, DECIDING).buttons).toBe(1);
    expect(layer.holding).toBe('cast');
    const attacked = scene({ enemies: [enemyAt(2, 0)], threats: [threatAt(-1, 1)] });
    // Спад заряда — тик раньше срока: докачивать под летящий снаряд некогда.
    expect(layer.step(attacked, plan(), 1, DECIDING).buttons).toBe(0);
    expect(layer.holding).toBeUndefined();
    expect(layer.step(attacked, plan(), 2, DECIDING).buttons).toBe(1 << 6);
  });
});

/**
 * Ручки профиля, названные «на тике решения» (BOT-6). Тик решения у мозга один,
 * и ведёт его слой маршрутов: слой способностей его СПРАШИВАЕТ. Здесь он
 * задаётся явно — стенд проверяет именно то, что от него зависит.
 */
describe('способности: тик решения (BOT-6)', () => {
  const PHASED: BotAbilityProfile = {
    ...CAST,
    holdTicks: 1,
    cooldownTicks: 0,
    cast: {
      slotIndex: 0,
      commit: 'confirm',
      confirmButton: 8,
      cancelButton: 9,
      steps: [{ aim: 'enemy', confirmDelayTicks: 30, pointNoise: 0 }],
      holdTicks: 4,
      cancelChance: 1,
      giveUpTicks: 120,
    },
  };

  /** Мир-стенд каста: видимый враг и слот, который сообщает «каст идёт». */
  function casting(tick: number): PerceivedWorld {
    return scene({
      tick,
      observedTick: tick,
      enemies: [enemyAt(2, 0)],
      slots: [{ slotIndex: 0, phase: 0, staged: 0 }],
    });
  }

  it('вероятность отмены разыгрывается на тике решения, а не каждый тик', () => {
    const layer = new AbilityLayer(withAbilities([PHASED]), random());
    // Тик 0 — начало каста: отменять ещё нечего.
    expect(layer.step(casting(0), plan(), 0, DECIDING).buttons).toBe(1);
    // Тики без решения — заряд ведётся дальше, хотя `cancelChance` единица.
    for (let tick = 1; tick <= 4; tick++) {
      expect(layer.step(casting(tick), plan(), tick, false).cancelBit).toBeUndefined();
      expect(layer.holding).toBe('cast');
    }
    // Первый же тик решения — отмена: единичная вероятность выпадает всегда.
    expect(layer.step(casting(5), plan(), 5, DECIDING).cancelBit).toBe(9);
    expect(layer.holding).toBeUndefined();
  });

  it('реакция на мир от тика решения не зависит: под снаряд заряд бросается сразу', () => {
    const layer = new AbilityLayer(
      withAbilities([{ ...PHASED, cast: { ...PHASED.cast!, cancelChance: 0 } }, SHIELD]),
      random(),
    );
    expect(layer.step(casting(0), plan(), 0, DECIDING).buttons).toBe(1);
    const attacked = scene({
      tick: 1,
      observedTick: 1,
      enemies: [enemyAt(2, 0)],
      threats: [threatAt(-1, 1)],
      slots: [{ slotIndex: 0, phase: 0, staged: 0 }],
    });
    // Тик решения не наступил, а закрыться надо сейчас: отмена всё равно уходит.
    expect(layer.step(attacked, plan(), 1, false).cancelBit).toBe(9);
  });
});

/**
 * Руки бота (BOT-6): сцена разводит два своих определения на одном бите
 * условием на владельце, и профиль повторяет это условие. Мозг про определения
 * не знает — он сверяет требование документа со своим наблюдением.
 */
/**
 * Каст, который подтверждается ОТПУСКАНИЕМ (ABIL-4, ABIL-5): фаза длится, пока
 * бит триггера держится, и прекращение удержания И записывает прицеливание того
 * тика в шаг, И завершает фазу. Бит подтверждения в этом не участвует вовсе.
 *
 * Проверяется ровно то, что уедет во `InputFrame` (BOT-5): маска и точка. Бот
 * обязан отдать точку НА ТОМ ЖЕ тике, на котором бит спал, — иначе симуляции
 * нечего записывать в шаг.
 */
describe('способности: каст с подтверждением отпусканием (BOT-6, ABIL-4)', () => {
  const HOLD = 4;
  const GRAB: BotAbilityProfile = {
    name: 'capture',
    button: 5,
    target: 'threat',
    range: 6,
    holdTicks: 1,
    cooldownTicks: 40,
    weight: 2,
    cast: {
      slotIndex: 2,
      commit: 'release',
      cancelButton: 9,
      steps: [{ aim: 'threat', confirmDelayTicks: HOLD, pointNoise: 0 }],
      holdTicks: HOLD,
      cancelChance: 0,
      giveUpTicks: 120,
    },
  };

  /** Мир-стенд: сближающийся снаряд и слот перехвата в объявленной фазе. */
  function grabbing(tick: number, phase: number): PerceivedWorld {
    return scene({
      tick,
      observedTick: tick,
      threats: [threatAt(-3, 1)],
      slots: [{ slotIndex: 2, phase, staged: 0 }],
    });
  }

  it('бит держится `holdTicks`, спадает шагом — и точка едет тем же тиком', () => {
    const layer = new AbilityLayer(withAbilities([GRAB]), random());
    const bit = 1 << GRAB.button;

    // Нажатие и удержание: точка есть, подтверждать нечем и незачем.
    for (let tick = 0; tick < HOLD; tick++) {
      const intent = layer.step(grabbing(tick, tick === 0 ? -1 : 0), plan(), tick, DECIDING);
      expect(intent.buttons, `тик ${tick}`).toBe(bit);
      expect(intent.confirmBit, `тик ${tick}`).toBeUndefined();
    }

    // Спад бита — он и есть подтверждение шага (ABIL-4): маска пуста, точка на
    // месте, фронта подтверждения нет.
    const release = layer.step(grabbing(HOLD, 0), plan(), HOLD, DECIDING);
    expect(release.buttons).toBe(0);
    expect(release.confirmBit).toBeUndefined();
    expect(release.target).toEqual({ x: -3, y: 0 });
  });

  it('фронт подтверждения не шлётся никогда — ни на одном тике каста', () => {
    const layer = new AbilityLayer(withAbilities([GRAB]), random());
    for (let tick = 0; tick <= 12; tick++) {
      const intent = layer.step(grabbing(tick, tick === 0 ? -1 : 0), plan(), tick, DECIDING);
      expect(intent.confirmBit, `тик ${tick}`).toBeUndefined();
    }
  });
});

describe('способности: требование к рукам (BOT-6)', () => {
  const CHARGE: BotAbilityProfile = { ...CAST, hands: 'free' };
  const THROW: BotAbilityProfile = {
    name: 'throwHeld',
    button: 0,
    hands: 'full',
    target: 'enemy',
    range: 8,
    holdTicks: 1,
    cooldownTicks: 20,
    weight: 2,
  };

  it('со свободными руками жмётся заряд, с пойманным снарядом — бросок', () => {
    const free = new AbilityLayer(withAbilities([CHARGE, THROW]), random());
    expect(free.step(scene({ enemies: [enemyAt(2, 0)] }), plan(), 0, DECIDING).buttons).toBe(1);
    expect(free.holding).toBe('cast');

    const full = new AbilityLayer(withAbilities([CHARGE, THROW]), random());
    const carrying = scene({ enemies: [enemyAt(2, 0)], carrying: true });
    expect(full.step(carrying, plan(), 0, DECIDING).buttons).toBe(1);
    // Бит тот же, а решение — другое: заряд руками с шаром не кастуется, и
    // сцена этот же бит прочтёт как бросок.
    expect(full.holding).toBe('throwHeld');
  });

  it('без требования к рукам способность применяется в обоих состояниях', () => {
    const layer = new AbilityLayer(withAbilities([SHIELD]), random());
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    expect(layer.step(incoming, plan(), 0, DECIDING).buttons).toBe(1 << 6);
    const carrying = scene({ threats: [threatAt(-2, 1)], carrying: true });
    const other = new AbilityLayer(withAbilities([SHIELD]), random());
    expect(other.step(carrying, plan(), 0, DECIDING).buttons).toBe(1 << 6);
  });
});

describe('способности: манёвры и рельеф (LOC-4, LOC-5)', () => {
  const dodge: BotAbilityProfile = { ...SHIELD, name: 'dodge', button: 2, requiresMoving: true };

  it('манёвр без направления не жмётся: симуляция его игнорирует', () => {
    const layer = new AbilityLayer(withAbilities([dodge]), random());
    const incoming = scene({ threats: [threatAt(-2, 1)] });
    // Цель маршрута там же, где бот: вектор движения нулевой.
    expect(layer.step(incoming, plan(0, 0), 0, DECIDING).buttons).toBe(0);
    expect(layer.step(incoming, plan(0, 5), 1, DECIDING).buttons).toBe(1 << 2);
  });

  it('уступ по курсу в пределах прыжка — прыжок', () => {
    const layer = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: ledgeTerrain(4) });
    const at = scene({ self: { id: 1, x: 3.2, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(7, 2), 0, DECIDING).buttons).toBe(1 << 3);
  });

  it('уступ выше прыжка не жмётся: обрыв блокирует и в полёте (PHYS-11)', () => {
    const layer = new AbilityLayer(withAbilities([{ ...JUMP, rise: 0 }]), random(), {
      terrain: ledgeTerrain(4),
    });
    const at = scene({ self: { id: 1, x: 3.2, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(7, 2), 0, DECIDING).buttons).toBe(0);
  });

  it('спуск с уступа — тоже прыжок: наземного вниз обрыв не пускает (PHYS-11)', () => {
    const layer = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: ledgeTerrain(4) });
    // Бот СВЕРХУ (уровень 1) и идёт вниз. Без прыжка он остался бы на плато
    // навсегда: при нулевом допуске обрыв блокирует в обе стороны.
    const at = scene({ self: { id: 1, x: 4.6, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(0, 2), 0, DECIDING).buttons).toBe(1 << 3);
  });

  it('ровное место — не прыжок: кнопка не жмётся просто так', () => {
    const layer = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: ledgeTerrain(4) });
    const at = scene({ self: { id: 1, x: 1, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    expect(layer.step(at, plan(3, 2), 0, DECIDING).buttons).toBe(0);
  });

  it('дыра по курсу, за которой есть пол, — прыжок; без террейна — никогда', () => {
    const at = scene({ self: { id: 1, x: 3.2, y: 2, vx: 0, vy: 0, slot: 1, team: 1 } });
    const jumper = new AbilityLayer(withAbilities([JUMP]), random(), { terrain: holeTerrain(4) });
    expect(jumper.step(at, plan(7, 2), 0, DECIDING).buttons).toBe(1 << 3);
    const blind = new AbilityLayer(withAbilities([JUMP]), random());
    expect(blind.step(at, plan(7, 2), 0, DECIDING).buttons).toBe(0);
  });
});

describe('способности: разрыв непрерывности (SHELL-7, NTR-16)', () => {
  it('перемотка снимает удержание и кулдауны — они про стёртую ветвь', () => {
    const layer = new AbilityLayer(withAbilities([CAST]), random());
    const near = scene({ enemies: [enemyAt(2, 0)] });
    expect(layer.step(near, plan(), 100, DECIDING).buttons).toBe(1);
    expect(layer.holding).toBe('cast');
    layer.forget();
    expect(layer.holding).toBeUndefined();
    // Номера тиков после перемотки идут НАЗАД: несброшенный кулдаун держал бы
    // способность незаряженной ровно ту глубину, которую унесла перемотка.
    expect(layer.step(near, plan(), 10, DECIDING).buttons).toBe(1);
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
