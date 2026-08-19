/**
 * Профиль бота — контент, а не код (BOT-6): состав документа, его валидация на
 * конструировании и референсные профили дерева контента.
 *
 * Референсные документы читаются с диска намеренно: «два уровня сложности
 * различаются только JSON-документами» проверяется на тех самых файлах, которые
 * правит дизайнер, а не на их копии в тесте.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NO_PHASE } from '@game-mvp/core';
import { BOT_BEHAVIORS, BOT_PROFILE_SCHEMA, parseBotProfile } from '../src/profile.js';
import { AbilityLayer } from '../src/brains/classic/abilities.js';
import { brainRandom } from '../src/brains/classic/random.js';
import type { PerceivedWorld } from '../src/brains/classic/perception.js';
import type { BehaviorPlan } from '../src/brains/classic/utility.js';
import type { BotAbilityProfile, BotProfile } from '../src/profile.js';

const CONTENT_BOTS = join(dirname(fileURLToPath(import.meta.url)), '../../../content/bots');

function read(name: string): unknown {
  return JSON.parse(readFileSync(join(CONTENT_BOTS, `${name}.json`), 'utf8'));
}

function valid(): Record<string, unknown> {
  return read('normal') as Record<string, unknown>;
}

describe('референсные профили контента (BOT-6)', () => {
  it.each(['easy', 'normal'])('%s разбирается и несёт все ручки', (name) => {
    const profile = parseBotProfile(read(name), name);
    expect(profile.name).toBe(name);
    expect(profile.schema).toBe(BOT_PROFILE_SCHEMA);
    for (const behavior of BOT_BEHAVIORS) {
      expect(typeof profile.utility[behavior], behavior).toBe('number');
    }
    // Ульта отката времени в списке отсутствовать ОБЯЗАНА: её бит ведёт хост
    // мира (`netcode` NET-11), и бот, дёргающий его, останавливал бы матч всем
    // участникам. Проверяется по имени, а не по номеру бита: номер — раскладка
    // сцены, а имя — то, что дизайнер видит в документе.
    expect(profile.abilities.map((ability) => ability.name)).not.toContain('rewind');
  });

  /**
   * Состав способностей — тоже документ (BOT-6): сложный профиль играет всеми
   * боевыми кнопками сцены демо, лёгкий — не всеми, и различие это выражено
   * ровно списком, без единой ветки в коде.
   */
  it('сложный профиль играет всеми боевыми способностями сцены демо', () => {
    const profile = parseBotProfile(read('normal'), 'normal');
    expect(profile.abilities.map((ability) => ability.name).sort()).toEqual([
      'capture',
      'cast',
      'dodge',
      'jump',
      'shield',
      'slowDome',
    ]);
    // Заряд — единственная удерживаемая: остальные тапаются (BOT-6).
    const held = profile.abilities.filter((ability) => ability.holdTicks > 1);
    expect(held.map((ability) => ability.name)).toEqual(['cast']);
    // Прыжок знает, какой перепад он берёт (LOC-5), и требует направления (LOC-4).
    const jump = profile.abilities.find((ability) => ability.target === 'cliff');
    expect(jump?.rise).toBeGreaterThan(0);
    expect(jump?.requiresMoving).toBe(true);
  });

  /**
   * Сравнений «лёгкий медленнее сложного» здесь нет намеренно: это числа,
   * которые тюнит геймдизайнер (BOT-6), и утверждение о их порядке связало бы
   * прогон движка с балансом — ровно та связь, которую CONT-4 запрещает.
   * Проверяется форма документа и то, что реализация его понимает.
   */
  it.each(['easy', 'normal'])('%s переживает round-trip разбора', (name) => {
    const document = read(name);
    const profile = parseBotProfile(document, name);
    expect(parseBotProfile(JSON.parse(JSON.stringify(profile)), name)).toEqual(profile);
  });
});

describe('валидация профиля на конструировании (BOT-6)', () => {
  it('называет все находки разом, а не первую', () => {
    const broken = { ...valid(), name: '', aggression: 5 };
    expect(() => parseBotProfile(broken)).toThrow(/name/);
    expect(() => parseBotProfile(broken)).toThrow(/aggression/);
  });

  it('чужая версия формы документа отвергается', () => {
    expect(() => parseBotProfile({ ...valid(), schema: 99 })).toThrow(/schema/);
  });

  it('версия формы называется и тогда, когда полей тоже не хватает', () => {
    // Документ будущей формы шумит несовпадением полей, и объясняет этот шум
    // именно версия: промолчать о ней значит спрятать причину за следствием.
    expect(() => parseBotProfile({ schema: 99, name: 'future' })).toThrow(/schema: 99/);
  });

  it('бит способности вне ширины `buttons` отвергается (TICK-2)', () => {
    const profile = valid();
    const abilities = [...(profile.abilities as Record<string, unknown>[])];
    abilities[0] = { ...abilities[0], button: 20 };
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/abilities\[0\]\.button/);
  });

  it('две способности на одном бите отвергаются: маска одна и различить их нечем', () => {
    const profile = valid();
    const abilities = (profile.abilities as Record<string, unknown>[]).map((ability, index) =>
      index === 0 ? ability : { ...ability, button: 0 },
    );
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/бит 0 назначен дважды/);
  });

  it('неизвестная цель способности отвергается, а не толкуется наугад', () => {
    const profile = valid();
    const abilities = [...(profile.abilities as Record<string, unknown>[])];
    abilities[0] = { ...abilities[0], target: 'ally' };
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/target/);
  });

  it('перепад уступа у не-cliff способности — находка: настраивали не то', () => {
    const profile = valid();
    const abilities = [...(profile.abilities as Record<string, unknown>[])];
    abilities[0] = { ...abilities[0], rise: 1 };
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/rise/);
  });

  it('cliff без перепада отвергается: прыгать вслепую бот не должен', () => {
    const profile = valid();
    const abilities = (profile.abilities as Record<string, unknown>[]).map((ability) =>
      ability.target === 'cliff' ? { ...ability, rise: undefined } : ability,
    );
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/rise/);
  });

  it('способности не массивом — находка, а не пустой список', () => {
    expect(() => parseBotProfile({ ...valid(), abilities: {} })).toThrow(/abilities/);
  });

  it('пропущенный вес поведения — находка, а не молчаливый ноль', () => {
    const profile = valid();
    const utility = { ...(profile.utility as Record<string, unknown>) };
    delete utility.dodge;
    expect(() => parseBotProfile({ ...profile, utility })).toThrow(/utility\.dodge/);
  });

  it('не-объект отвергается сразу', () => {
    expect(() => parseBotProfile(null)).toThrow(/ожидался объект/);
    expect(() => parseBotProfile('easy')).toThrow(/ожидался объект/);
  });

  it('дробные тики отвергаются: буфер наблюдений меряется тиками', () => {
    const profile = valid();
    const reaction = { ...(profile.reaction as Record<string, unknown>), delayTicks: 1.5 };
    expect(() => parseBotProfile({ ...profile, reaction })).toThrow(/delayTicks/);
  });
});

/**
 * Способность платформы в профиле (BOT-6): фазы каста и цепочка шагов вместо
 * одного бита с дальностью. Соответствие способности СЦЕНЫ и записи профиля —
 * данные документа: индекс слота и биты подтверждения с отменой называет он,
 * а не код мозга.
 */
describe('описание способности платформы (BOT-6, ABIL-4, ABIL-5)', () => {
  const cast = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    slotIndex: 0,
    confirmButton: 8,
    cancelButton: 9,
    holdTicks: 4,
    cancelChance: 0,
    giveUpTicks: 120,
    steps: [
      { aim: 'enemy', confirmDelayTicks: 2, pointNoise: 0 },
      { aim: 'self', confirmDelayTicks: 1, pointNoise: 0.5 },
    ],
    ...over,
  });

  const withCast = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const profile = valid();
    const abilities = [...(profile.abilities as Record<string, unknown>[])];
    abilities[0] = { ...abilities[0], cast: cast(over) };
    return { ...profile, abilities };
  };

  it('разбирается целиком: фазы, шаги и биты — данные профиля', () => {
    const profile = parseBotProfile(withCast());
    const described = profile.abilities[0]!.cast!;
    expect(described.slotIndex).toBe(0);
    expect(described.confirmButton).toBe(8);
    expect(described.cancelButton).toBe(9);
    expect(described.holdTicks).toBe(4);
    expect(described.steps.map((step) => step.aim)).toEqual(['enemy', 'self']);
    expect(described.steps[0]!.confirmDelayTicks).toBe(2);
    expect(described.steps[1]!.pointNoise).toBe(0.5);
  });

  it('переживает round-trip разбора', () => {
    const profile = parseBotProfile(withCast());
    expect(parseBotProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it('бит подтверждения вне ширины `buttons` отвергается (TICK-2)', () => {
    expect(() => parseBotProfile(withCast({ confirmButton: 20 }))).toThrow(/cast\.confirmButton/);
  });

  it('неизвестная цель шага отвергается, а не толкуется наугад', () => {
    const broken = withCast({ steps: [{ aim: 'cliff', confirmDelayTicks: 0, pointNoise: 0 }] });
    expect(() => parseBotProfile(broken)).toThrow(/cast\.steps\[0\]\.aim/);
  });

  it('цепочка длиннее слота отвергается: столько шагов платформе не влезет (ABIL-1)', () => {
    const step = { aim: 'enemy', confirmDelayTicks: 0, pointNoise: 0 };
    expect(() => parseBotProfile(withCast({ steps: [step, step, step, step] }))).toThrow(/шагов при пределе/);
  });

  it('шаги не массивом — находка, а не пустая цепочка', () => {
    expect(() => parseBotProfile(withCast({ steps: {} }))).toThrow(/cast\.steps/);
  });

  it('отмена необязательна: профиль вправе не отменять начатый каст', () => {
    const profile = parseBotProfile(withCast({ cancelButton: undefined }));
    expect(profile.abilities[0]!.cast!.cancelButton).toBeUndefined();
  });
});

/**
 * Что мозг делает с этим описанием (BOT-6). Проверяется наблюдаемый выход слоя
 * способностей: маска, точка и биты шага — то и ровно то, что уедет во
 * `InputFrame` через границу (BOT-5).
 */
describe('мозг ведёт каст по описанию профиля (BOT-6)', () => {
  const PLAN: BehaviorPlan = {
    behavior: 'pressure',
    targetX: 0,
    targetY: 0,
    aim: undefined,
    strafe: false,
  };

  function profileWith(ability: Partial<BotAbilityProfile>): BotProfile {
    return {
      schema: BOT_PROFILE_SCHEMA,
      name: 'stand',
      reaction: { delayTicks: 0, jitterTicks: 0, memoryTicks: 120 },
      aim: { noiseDegrees: 0, noisePeriodTicks: 10 },
      decision: { intervalTicks: 1, jitterTicks: 0 },
      movement: {
        maxSpeed: 1,
        arriveTolerance: 0.25,
        edgeMargin: 2,
        engageRange: 8,
        strafe: 0,
        strafePeriodTicks: 30,
      },
      abilities: [
        {
          name: 'fireball',
          button: 0,
          target: 'enemy',
          range: 20,
          holdTicks: 1,
          cooldownTicks: 30,
          weight: 1,
          ...ability,
        },
      ],
      utility: { pressure: 1, kite: 0.5, retreat: 1, dodge: 1 },
      aggression: 0.6,
      seed: 7,
    };
  }

  /** Мир-стенд: видимый враг и один слот способности в объявленном состоянии. */
  function stand(phase: number, staged: number): PerceivedWorld {
    return {
      tick: 0,
      observedTick: 0,
      self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
      slots: [{ slotIndex: 0, phase, staged }],
      enemies: [{ id: 2, x: 4, y: 0, vx: 0, vy: 0, slot: 0, team: 2, seenTick: 0, visible: true }],
      threats: [],
      arenaRadius: 20,
    };
  }

  const CAST = {
    slotIndex: 0,
    confirmButton: 8,
    cancelButton: 9,
    holdTicks: 2,
    cancelChance: 0,
    giveUpTicks: 120,
    steps: [
      { aim: 'enemy' as const, confirmDelayTicks: 1, pointNoise: 0 },
      { aim: 'self' as const, confirmDelayTicks: 1, pointNoise: 0 },
    ],
  };

  it('цепочка подтверждается по шагу за раз, и следующий шаг ждёт `staged` снапшота', () => {
    const layer = new AbilityLayer(profileWith({ cast: CAST }), brainRandom(1, 'cast'));
    // Тик 0 — только триггер: каста ещё нет, подтверждать нечего.
    const start = layer.step(stand(NO_PHASE, 0), PLAN, 0);
    expect(start.buttons).toBe(1);
    expect(start.confirmBit).toBeUndefined();

    // Тик 1 — срок прицеливания вылежался, шаг подтверждается точкой врага.
    const first = layer.step(stand(0, 0), PLAN, 1);
    expect(first.confirmBit).toBe(8);
    expect(first.target).toEqual({ x: 4, y: 0 });

    // Тик 2 — отправленное ещё не доехало до снапшота (`staged` = 0): второй
    // шаг НЕ подтверждается, иначе бот выпалил бы цепочку за три тика.
    expect(layer.step(stand(0, 0), PLAN, 2).confirmBit).toBeUndefined();

    // Симуляция догнала — подтверждается второй шаг, и целится он уже в себя.
    const second = layer.step(stand(0, 1), PLAN, 3);
    expect(second.confirmBit).toBe(8);
    expect(second.target).toEqual({ x: 0, y: 0 });
  });

  it('слот сообщил «каста нет» — применение закончено, взводится кулдаун', () => {
    const layer = new AbilityLayer(profileWith({ cast: CAST }), brainRandom(1, 'cast'));
    layer.step(stand(NO_PHASE, 0), PLAN, 0);
    layer.step(stand(0, 0), PLAN, 1);
    layer.step(stand(0, 1), PLAN, 2);
    expect(layer.holding).toBe('fireball');
    // Оба шага отправлены, слот вернулся в «каста нет» — каст отыгран.
    const done = layer.step(stand(NO_PHASE, 2), PLAN, 3);
    expect(done.buttons).toBe(0);
    expect(layer.holding).toBeUndefined();
  });

  it('повисший каст бросается по пределу профиля, а не держится вечно', () => {
    const cast = { ...CAST, giveUpTicks: 5 };
    const layer = new AbilityLayer(profileWith({ cast }), brainRandom(1, 'cast'));
    // `staged` не растёт никогда: определение сцены подтверждения не принимает.
    for (let tick = 0; tick <= 5; tick++) layer.step(stand(0, 0), PLAN, tick);
    expect(layer.holding).toBeUndefined();
  });

  /**
   * Профиль, знающий только «нажать бит», способности нового вида выразить не
   * может: бита подтверждения у него нет вовсе, цепочка не накапливается, и
   * симуляция каст не доводит. Чинится это профилем, а не ветвлением в коде.
   */
  it('профиль со старым описанием — способность не применяется', () => {
    const layer = new AbilityLayer(profileWith({ holdTicks: 3 }), brainRandom(1, 'cast'));
    for (let tick = 0; tick <= 4; tick++) {
      const intent = layer.step(stand(0, 0), PLAN, tick);
      // Ни подтверждения, ни точки — старое описание их не знает.
      expect(intent.confirmBit).toBeUndefined();
      expect(intent.target).toBeUndefined();
    }
    // Шаг цепочки так и не накоплен: сцена его ждёт, а бот его не даёт.
    expect(stand(0, 0).slots[0]!.staged).toBe(0);
  });
});
