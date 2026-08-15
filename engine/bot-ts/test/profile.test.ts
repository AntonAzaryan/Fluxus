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
import { BOT_BEHAVIORS, parseBotProfile } from '../src/profile.js';

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
    expect(profile.schema).toBe(1);
    for (const behavior of BOT_BEHAVIORS) {
      expect(typeof profile.utility[behavior], behavior).toBe('number');
    }
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
    const ability = { ...(profile.ability as Record<string, unknown>), button: 20 };
    expect(() => parseBotProfile({ ...profile, ability })).toThrow(/button/);
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
