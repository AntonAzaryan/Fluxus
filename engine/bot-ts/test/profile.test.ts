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
import { BOT_BEHAVIORS, BOT_PROFILE_SCHEMA, parseBotProfile } from '../src/profile.js';

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
