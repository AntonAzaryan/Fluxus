/**
 * Профиль бота — контент, а не код (BOT-6): состав документа, его валидация на
 * конструировании и референсные профили дерева контента вместе с документами
 * поведения, которые они называют (BOT-8).
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
import { BOT_PROFILE_SCHEMA, parseBotProfile } from '../src/profile.js';
import { BOT_BEHAVIOR_SCHEMA, BOT_EXECUTORS, parseBotBehavior } from '../src/behavior.js';
import { AbilityLayer } from '../src/brains/layers/abilities.js';
import { brainRandom } from '../src/brains/layers/random.js';
import type { PerceivedWorld } from '../src/brains/layers/perception.js';
import type { BehaviorPlan } from '../src/brains/layers/plan.js';
import type { BotAbilityProfile, BotProfile } from '../src/profile.js';

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), '../../../content');
const CONTENT_BOTS = join(CONTENT, 'bots');

function read(name: string): unknown {
  return JSON.parse(readFileSync(join(CONTENT_BOTS, `${name}.json`), 'utf8'));
}

/** Документ поведения по пути, который назвал профиль (BOT-8): путь — данные. */
function readBehavior(path: string): unknown {
  return JSON.parse(readFileSync(join(CONTENT, path), 'utf8'));
}

function valid(): Record<string, unknown> {
  return read('normal') as Record<string, unknown>;
}

describe('референсные профили контента (BOT-6)', () => {
  it.each(['easy', 'normal'])('%s разбирается и несёт все ручки', (name) => {
    const profile = parseBotProfile(read(name), name);
    expect(profile.name).toBe(name);
    expect(profile.schema).toBe(BOT_PROFILE_SCHEMA);
    // Ульта отката времени в списке отсутствовать ОБЯЗАНА: её бит ведёт хост
    // мира (`netcode` NET-11), и бот, дёргающий его, останавливал бы матч всем
    // участникам. Проверяется по имени, а не по номеру бита: номер — раскладка
    // сцены, а имя — то, что дизайнер видит в документе.
    expect(profile.abilities.map((ability) => ability.name)).not.toContain('rewind');
  });

  /**
   * Разрез двух документов (BOT-6, BOT-8): профиль отвечает «насколько хорошо»,
   * а «что делать» — документ поведения, и связку называют ДАННЫЕ. Проверяется
   * это единственным способом, каким её вообще можно проверить, — тем, что
   * названный путь резолвится в документ, который реализация понимает.
   */
  it.each(['easy', 'normal'])('%s называет свой документ поведения, и тот разбирается', (name) => {
    const profile = parseBotProfile(read(name), name);
    expect(profile.behavior).toMatch(/^bots\/behaviors\/.+\.json$/);
    const behavior = parseBotBehavior(readBehavior(profile.behavior), profile.behavior);
    expect(behavior.schema).toBe(BOT_BEHAVIOR_SCHEMA);
    // Политика — это выбор МАРШРУТА, и все четыре исполнителя в отгруженных
    // документах названы: бот, которому нечем отступать, стоял бы у края.
    expect(behavior.actions.map((action) => action.executor).sort()).toEqual(
      [...BOT_EXECUTORS].sort(),
    );
  });

  /**
   * Веса и агрессивность в профиле БОЛЬШЕ НЕ ЖИВУТ (schema 3, BOT-6): политика
   * уехала документом, и документ прошлой формы отличается от нового явно.
   */
  it.each(['easy', 'normal'])('%s не несёт политики выбора: она в документе', (name) => {
    const document = read(name) as Record<string, unknown>;
    expect(document.utility).toBeUndefined();
    expect(document.aggression).toBeUndefined();
    expect(typeof document.behavior).toBe('string');
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
      'throwHeld',
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
    const broken = { ...valid(), name: '', behavior: '' };
    expect(() => parseBotProfile(broken)).toThrow(/name/);
    expect(() => parseBotProfile(broken)).toThrow(/behavior/);
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

  /**
   * Документ поведения профиль называет ПУТЁМ от корня дерева контента
   * (BOT-8, ASSET-2): без него бот не знает, что делать, а абсолютный путь —
   * это адрес файла машины, на которой документ писали.
   */
  it('профиль без документа поведения — находка, а не бот без политики', () => {
    const profile = valid();
    delete profile.behavior;
    expect(() => parseBotProfile(profile)).toThrow(/behavior/);
  });

  it('абсолютный путь документа и выход вверх отвергаются', () => {
    expect(() => parseBotProfile({ ...valid(), behavior: '/bots/behaviors/classic.json' })).toThrow(
      /от корня дерева контента/,
    );
    expect(() => parseBotProfile({ ...valid(), behavior: '../secrets.json' })).toThrow(
      /от корня дерева контента/,
    );
  });

  it('не-объект отвергается сразу', () => {
    expect(() => parseBotProfile(null)).toThrow(/ожидался объект/);
    expect(() => parseBotProfile('easy')).toThrow(/ожидался объект/);
  });

  /**
   * Дистанция боя — не только «где бот хочет драться»: этим же числом словарь
   * входов нормирует расстояния (BOT-9). Ноль отменяет шкалу, и документ
   * поведения поверх такого профиля вычислить нечем — это находка, а не
   * молчаливое умолчание кода.
   */
  it('нулевая дистанция боя — находка: она масштаб входов документа', () => {
    const profile = valid();
    const movement = { ...(profile.movement as Record<string, unknown>), engageRange: 0 };
    expect(() => parseBotProfile({ ...profile, movement })).toThrow(/engageRange/);
    expect(() => parseBotProfile({ ...profile, movement })).toThrow(/МАСШТАБ/);
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
  // Сроки подтверждения здесь не произвольные: документ строится поверх
  // `normal.json`, а тот объявил задержку реакции, и фронт подтверждения не
  // вправе уезжать раньше, чем доезжает картинка мира.
  const cast = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    slotIndex: 0,
    confirmButton: 8,
    cancelButton: 9,
    holdTicks: 4,
    cancelChance: 0,
    giveUpTicks: 120,
    steps: [
      { aim: 'enemy', confirmDelayTicks: 8, pointNoise: 0 },
      { aim: 'self', confirmDelayTicks: 6, pointNoise: 0.5 },
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
    expect(described.commit).toBe('confirm');
    expect(described.steps[0]!.confirmDelayTicks).toBe(8);
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
    const step = { aim: 'enemy', confirmDelayTicks: 6, pointNoise: 0 };
    expect(() => parseBotProfile(withCast({ steps: [step, step, step, step] }))).toThrow(/шагов при пределе/);
  });

  it('шаги не массивом — находка, а не пустая цепочка', () => {
    expect(() => parseBotProfile(withCast({ steps: {} }))).toThrow(/cast\.steps/);
  });

  it('отмена необязательна: профиль вправе не отменять начатый каст', () => {
    const profile = parseBotProfile(withCast({ cancelButton: undefined }));
    expect(profile.abilities[0]!.cast!.cancelButton).toBeUndefined();
  });

  /**
   * Предел ведения и задержка реакции — числа ОДНОГО документа, и разойтись им
   * нельзя: свой каст мозг закрывает по своему слоту из своего снапшота, а тот
   * отстаёт ровно на эту задержку. Профиль, у которого предел короче суммы,
   * описывает каст, который всегда бросается по пределу и ни разу не доводится.
   */
  it('предел ведения короче подтверждений с задержкой реакции — находка', () => {
    const broken = withCast({ giveUpTicks: 3, steps: [{ aim: 'enemy', confirmDelayTicks: 2, pointNoise: 0 }] });
    expect(() => parseBotProfile(broken)).toThrow(/giveUpTicks 3/);
    expect(() => parseBotProfile(broken)).toThrow(/reaction\.delayTicks/);
  });

  /**
   * Фронт подтверждения бот шлёт по СВОИМ часам, ничего в мире не дождавшись.
   * Уехавший раньше, чем доезжает картинка, он заставил бы бота судить о
   * собственном касте по миру, в котором тот ещё не начался, — ровно тем и
   * болел `easy.json` с его `confirmDelayTicks: 12` против задержки в 32 тика.
   */
  it('фронт подтверждения раньше задержки реакции — находка', () => {
    const broken = withCast({ steps: [{ aim: 'enemy', confirmDelayTicks: 3, pointNoise: 0 }] });
    expect(() => parseBotProfile(broken, 'easy')).toThrow(/уезжает на тике 3/);
    expect(() => parseBotProfile(broken, 'easy')).toThrow(/отстаёт на 12/);
  });

  /**
   * У каста с отпусканием фронта подтверждения нет ВОВСЕ (ABIL-4): шаг
   * записывает прекращение удержания бита триггера. Правило про фронт к нему не
   * применяется — иначе рефлекторный перехват был бы обязан ждать дольше
   * собственной реакции бота, то есть был бы запрещён, а не починен.
   */
  it('каст с отпусканием под правило о фронте не подпадает', () => {
    const released = withCast({
      commit: 'release',
      confirmButton: undefined,
      holdTicks: 4,
      steps: [{ aim: 'threat', confirmDelayTicks: 4, pointNoise: 0 }],
    });
    const profile = parseBotProfile(released);
    expect(profile.abilities[0]!.cast!.commit).toBe('release');
    expect(profile.abilities[0]!.cast!.confirmButton).toBeUndefined();
  });
});

/**
 * Способ подтверждения шага — данные профиля (BOT-6, ABIL-4, ABIL-5): фронт
 * бита либо прекращение удержания. Различие это ровно то, что различает виды
 * фаз в сцене, и код мозга о нём знает только по документу.
 */
describe('способ подтверждения шага в профиле (BOT-6, ABIL-4)', () => {
  const casted = (cast: Record<string, unknown>): Record<string, unknown> => {
    const profile = valid();
    const abilities = [...(profile.abilities as Record<string, unknown>[])];
    abilities[0] = { ...abilities[0], cast };
    return { ...profile, abilities };
  };

  const released = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    casted({
      slotIndex: 0,
      commit: 'release',
      cancelButton: 9,
      holdTicks: 6,
      cancelChance: 0,
      giveUpTicks: 120,
      steps: [{ aim: 'enemy', confirmDelayTicks: 6, pointNoise: 0 }],
      ...over,
    });

  // Документ БЕЗ поля `commit` — та самая форма, что писалась до появления фазы
  // `release`. Срок подтверждения тут не произвольный: профиль строится поверх
  // `normal.json`, и фронт обязан уезжать позже, чем доезжает картинка.
  const confirmed = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    casted({
      slotIndex: 0,
      confirmButton: 8,
      cancelButton: 9,
      holdTicks: 6,
      cancelChance: 0,
      giveUpTicks: 120,
      steps: [{ aim: 'enemy', confirmDelayTicks: 14, pointNoise: 0 }],
      ...over,
    });

  it('умолчание — фронт бита: документ прошлой формы читается как читался', () => {
    const profile = parseBotProfile(confirmed());
    expect(profile.abilities[0]!.cast!.commit).toBe('confirm');
    expect(profile.abilities[0]!.cast!.confirmButton).toBe(8);
  });

  it.each(['easy', 'normal'])('%s ведёт заряд отпусканием — как устроен он в сцене', (name) => {
    const cast = parseBotProfile(read(name), name).abilities.find((a) => a.name === 'cast')!.cast!;
    // Определение заряда — одна фаза `release`, и бита подтверждения у неё нет
    // вовсе: профиль, называющий его, описывал бы фронт, которого сцена не ждёт.
    expect(cast.commit).toBe('release');
    expect(cast.confirmButton).toBeUndefined();
    expect(cast.holdTicks).toBe(cast.steps[0]!.confirmDelayTicks);
  });

  it('отгруженный профиль ведёт перехват отпусканием', () => {
    const profile = parseBotProfile(read('normal'), 'normal');
    const capture = profile.abilities.find((ability) => ability.name === 'capture')!;
    expect(capture.cast!.commit).toBe('release');
    // Бит подтверждения не называется: жать его этот каст не станет никогда.
    expect(capture.cast!.confirmButton).toBeUndefined();
    // Спад бита и есть подтверждение, поэтому «сколько держать» и «сколько
    // целиться» — одно число.
    expect(capture.cast!.holdTicks).toBe(capture.cast!.steps[0]!.confirmDelayTicks);
  });

  it('неизвестный способ отвергается, а не толкуется наугад', () => {
    expect(() => parseBotProfile(released({ commit: 'tap' }))).toThrow(/cast\.commit/);
  });

  it('бит подтверждения у отпускания — находка: фронта там нет', () => {
    expect(() => parseBotProfile(released({ confirmButton: 8 }))).toThrow(/confirmButton/);
  });

  it('фронт без названного бита — находка: подтверждать нечем', () => {
    expect(() => parseBotProfile(confirmed({ confirmButton: undefined }))).toThrow(/confirmButton/);
  });

  it('удержание и срок прицеливания шага у отпускания — одно число', () => {
    expect(() => parseBotProfile(released({ holdTicks: 9 }))).toThrow(/holdTicks 9/);
  });

  it('второй шаг у отпускания — находка: спад записывает ровно один', () => {
    const step = { aim: 'enemy', confirmDelayTicks: 6, pointNoise: 0 };
    expect(() => parseBotProfile(released({ steps: [step, step] }))).toThrow(/записывает ровно один/);
  });
});

/**
 * Требование к рукам (BOT-6): единственное, чем документ разводит ДВА
 * определения сцены, сидящих на одном бите.
 */
describe('требование к рукам в профиле (BOT-6)', () => {
  it('отгруженный профиль описывает и заряд, и бросок пойманного снаряда', () => {
    const profile = parseBotProfile(read('normal'), 'normal');
    const onBitZero = profile.abilities.filter((ability) => ability.button === 0);
    // Бит один, записи две, и различает их документ: пойманный снаряд бот
    // бросает, а не держит в руках, пока тот не взорвётся.
    expect(onBitZero.map((ability) => ability.name).sort()).toEqual(['cast', 'throwHeld']);
    expect(onBitZero.map((ability) => ability.hands).sort()).toEqual(['free', 'full']);
  });

  it('неизвестное требование отвергается, а не толкуется наугад', () => {
    const profile = valid();
    const abilities = [...(profile.abilities as Record<string, unknown>[])];
    abilities[0] = { ...abilities[0], hands: 'busy' };
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/hands/);
  });

  it('один бит на две записи разрешён только взаимоисключающими руками', () => {
    const profile = valid();
    const abilities = (profile.abilities as Record<string, unknown>[]).map((ability) =>
      ability.name === 'throwHeld' ? { ...ability, hands: 'free' } : ability,
    );
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/бит 0 назначен дважды/);
  });

  it('без требования к рукам общий бит остаётся коллизией', () => {
    const profile = valid();
    const abilities = (profile.abilities as Record<string, unknown>[]).map((ability) =>
      ability.name === 'throwHeld' ? { ...ability, hands: undefined } : ability,
    );
    expect(() => parseBotProfile({ ...profile, abilities })).toThrow(/бит 0 назначен дважды/);
  });
});

/**
 * Что мозг делает с этим описанием (BOT-6). Проверяется наблюдаемый выход слоя
 * способностей: маска, точка и биты шага — то и ровно то, что уедет во
 * `InputFrame` через границу (BOT-5).
 */
describe('мозг ведёт каст по описанию профиля (BOT-6)', () => {
  /**
   * Тик решения (BOT-6). В этих проверках он наступил всегда: `cancelChance`
   * здесь нулевой, и разыгрывать на нём нечего.
   */
  const DECIDING = true;

  const PLAN: BehaviorPlan = {
    executor: 'pressure',
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
      behavior: 'bots/behaviors/classic.json',
      seed: 7,
    };
  }

  /**
   * Мир-стенд: видимый враг и один слот способности в объявленном состоянии.
   * Тик наблюдения равен тику съёма — стенд без задержки реакции: она здесь
   * ничего не проверяет, а вот СВЕЖЕСТЬ картинки слой читает (`abilities.ts`),
   * и «мир из тика ноль на тике три» был бы стендом про другое.
   */
  function stand(phase: number, staged: number, tick = 0): PerceivedWorld {
    return {
      tick,
      observedTick: tick,
      self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
      slots: [{ slotIndex: 0, phase, staged, cooldown: 0 }],
      enemies: [{ id: 2, x: 4, y: 0, vx: 0, vy: 0, slot: 0, team: 2, seenTick: 0, visible: true }],
      threats: [],
      arenaRadius: 20,
      carrying: false,
    };
  }

  const CAST = {
    slotIndex: 0,
    commit: 'confirm' as const,
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
    const start = layer.step(stand(NO_PHASE, 0, 0), PLAN, 0, DECIDING);
    expect(start.buttons).toBe(1);
    expect(start.confirmBit).toBeUndefined();

    // Тик 1 — срок прицеливания вылежался, шаг подтверждается точкой врага.
    const first = layer.step(stand(0, 0, 1), PLAN, 1, DECIDING);
    expect(first.confirmBit).toBe(8);
    expect(first.target).toEqual({ x: 4, y: 0 });

    // Тик 2 — отправленное ещё не доехало до снапшота (`staged` = 0): второй
    // шаг НЕ подтверждается, иначе бот выпалил бы цепочку за три тика.
    expect(layer.step(stand(0, 0, 2), PLAN, 2, DECIDING).confirmBit).toBeUndefined();

    // Симуляция догнала — подтверждается второй шаг, и целится он уже в себя.
    const second = layer.step(stand(0, 1, 3), PLAN, 3, DECIDING);
    expect(second.confirmBit).toBe(8);
    expect(second.target).toEqual({ x: 0, y: 0 });
  });

  it('слот сообщил «каста нет» — применение закончено, взводится кулдаун', () => {
    const layer = new AbilityLayer(profileWith({ cast: CAST }), brainRandom(1, 'cast'));
    layer.step(stand(NO_PHASE, 0, 0), PLAN, 0, DECIDING);
    layer.step(stand(0, 0, 1), PLAN, 1, DECIDING);
    layer.step(stand(0, 1, 2), PLAN, 2, DECIDING);
    expect(layer.holding).toBe('fireball');
    // Оба шага отправлены, слот вернулся в «каста нет» — каст отыгран.
    const done = layer.step(stand(NO_PHASE, 2, 3), PLAN, 3, DECIDING);
    expect(done.buttons).toBe(0);
    expect(layer.holding).toBeUndefined();
  });

  it('повисший каст бросается по пределу профиля, а не держится вечно', () => {
    const cast = { ...CAST, giveUpTicks: 5 };
    const layer = new AbilityLayer(profileWith({ cast }), brainRandom(1, 'cast'));
    // `staged` не растёт никогда: определение сцены подтверждения не принимает.
    for (let tick = 0; tick <= 5; tick++) layer.step(stand(0, 0, tick), PLAN, tick, DECIDING);
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
      const intent = layer.step(stand(0, 0, tick), PLAN, tick, DECIDING);
      // Ни подтверждения, ни точки — старое описание их не знает.
      expect(intent.confirmBit).toBeUndefined();
      expect(intent.target).toBeUndefined();
    }
    // Шаг цепочки так и не накоплен: сцена его ждёт, а бот его не даёт.
    expect(stand(0, 0).slots[0]!.staged).toBe(0);
  });
});

/**
 * Полный цикл каста на ЧИСЛАХ ОТГРУЖЕННОГО ПРОФИЛЯ (BOT-6). Проверяется не форма
 * документа и не отдельная ветка слоя, а то, доводит ли бот заряд до выпуска на
 * тех числах, которые правит дизайнер: нажатие, удержание фазы и спад бита,
 * которым фаза `release` и записывает шаг, — и вероятность передумать, которую
 * документ меряет ТИКОМ РЕШЕНИЯ.
 *
 * Проверка появилась дырой в покрытии: `cancelChance` разыгрывался каждый тик, и
 * `0.05` из `normal.json` превращались в «пять процентов ЗА ТИК» — до
 * подтверждения на тике 34 доживал один заряд из шести, а остальные сгорали в
 * `ActionLock` фазы удержания и в собственный кулдаун. Не ловил этого никто:
 * интеграционный тест гонял способность старого вида, а стенд формы —
 * `cancelChance: 0` с подтверждением на первом же тике.
 */
describe('заряд отгруженного профиля доходит до выпуска (BOT-6)', () => {
  const PLAN: BehaviorPlan = {
    executor: 'pressure',
    targetX: 0,
    targetY: 0,
    aim: undefined,
    strafe: false,
  };

  interface SlotState {
    readonly phase: number;
    readonly staged: number;
  }

  interface CastRun {
    /** Довёл ли бот заряд до выпуска — то есть до записи шага прицеливания. */
    readonly committed: boolean;
    /** Тик, на котором бит триггера спал; `-1` — заряд не выпущен. */
    readonly commitTick: number;
  }

  /**
   * Один заряд на стенде. Слот здесь — МОДЕЛЬ автомата (ABIL-4, ABIL-5), а не
   * сцена: знает она ровно то, что читает мозг, — фазу и число накопленных
   * шагов, — и движется тем же, чем движется сцена: маской самого бота. Фаза
   * `release` идёт, пока бит триггера держится; прекращение удержания И
   * записывает прицеливание того тика в шаг, И завершает фазу, после чего
   * способность коммитится.
   *
   * Мир бот видит с ОТСТАВАНИЕМ, которое назвал его же профиль
   * (`reaction.delayTicks + jitterTicks`): без него стенд проверял бы каст,
   * которого в матче не бывает, — тот, где бот видит свой слот мгновенно.
   */
  function runCast(profile: BotProfile, seed: number, limitTicks = 240): CastRun {
    const ability = profile.abilities.find((entry) => entry.name === 'cast');
    const cast = ability?.cast;
    if (ability === undefined || cast === undefined) throw new Error('в профиле нет каста');
    const trigger = 1 << ability.button;
    const lag = profile.reaction.delayTicks + profile.reaction.jitterTicks;
    const layer = new AbilityLayer(profile, brainRandom(seed, 'cast-cycle'));

    const history: SlotState[] = [];
    let state: SlotState = { phase: NO_PHASE, staged: 0 };
    let started = false;
    let commitTick = -1;
    let staged = false;
    let done = false;

    for (let tick = 0; tick < limitTicks; tick++) {
      const observedTick = Math.max(0, tick - lag);
      const seen = history[observedTick] ?? { phase: NO_PHASE, staged: 0 };
      const world: PerceivedWorld = {
        tick,
        observedTick,
        self: { id: 1, x: 0, y: 0, vx: 0, vy: 0, slot: 1, team: 1 },
        slots: [{ slotIndex: cast.slotIndex, phase: seen.phase, staged: seen.staged, cooldown: 0 }],
        enemies: [
          { id: 2, x: 6, y: 0, vx: 0, vy: 0, slot: 0, team: 2, seenTick: observedTick, visible: true },
        ],
        threats: [],
        arenaRadius: 20,
        carrying: false,
      };
      // Тик решения — каденс профиля без джиттера: джиттер размыл бы число
      // розыгрышей отмены, а проверяется именно оно.
      const deciding = tick % profile.decision.intervalTicks === 0;
      const intent = layer.step(world, PLAN, tick, deciding);
      const holding = (intent.buttons & trigger) !== 0;

      if (intent.cancelBit !== undefined) {
        done = true;
        state = { phase: NO_PHASE, staged: state.staged };
      } else if (!started && holding) {
        started = true;
        state = { phase: 0, staged: 0 };
      } else if (started && !holding && state.phase !== NO_PHASE) {
        // Спад бита: шаг записывается прицеливанием ЭТОГО тика — без точки
        // записывать нечего, и коммита не будет.
        done = true;
        staged = intent.target !== undefined;
        commitTick = tick;
        state = { phase: NO_PHASE, staged: state.staged + 1 };
      }
      history.push(state);
      if (done) break;
    }
    return { committed: staged, commitTick: staged ? commitTick : -1 };
  }

  /** Доля прогонов, доведённых до выпуска, на разных seed'ах мозга. */
  function committedShare(profile: BotProfile, runs: number): number {
    let committed = 0;
    for (let seed = 1; seed <= runs; seed++) if (runCast(profile, seed).committed) committed++;
    return committed / runs;
  }

  it('вероятность отмены меряется тиком решения: заряд доживает до выпуска', () => {
    // Розыгрыш каждый тик давал бы `0.95^34 ≈ 0.17`. Порог грубый намеренно: он
    // про порядок величины, а не про число, которое дизайнер вправе двигать
    // профилем, не трогая код.
    //
    expect(committedShare(parseBotProfile(read('normal'), 'normal'), 200)).toBeGreaterThan(0.5);
  });

  it('лёгкий профиль доводит свой заряд тем же кодом', () => {
    // `easy` отменяет втрое охотнее (`cancelChance: 0.15`) и передумывает вдвое
    // реже (`intervalTicks: 12`) — заряд у него всё равно долетает, и различие
    // это выражено ровно числами документа.
    expect(committedShare(parseBotProfile(read('easy'), 'easy'), 200)).toBeGreaterThan(0.5);
  });

  it('спад бита уходит на том тике, который назвал профиль', () => {
    const profile = parseBotProfile(read('normal'), 'normal');
    const cast = profile.abilities.find((entry) => entry.name === 'cast')!.cast!;
    // У заряда с отпусканием срок прицеливания шага и длительность удержания —
    // одно число, и спад бита обязан прийтись ровно на него.
    const expected = cast.holdTicks;
    const ticks = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const run = runCast(profile, seed);
      if (run.committed) ticks.add(run.commitTick);
    }
    expect(ticks.size).toBeGreaterThan(0);
    expect([...ticks]).toEqual([expected]);
  });
});
