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

  it('лёгкий и сложный различаются только числами: код мозга один', () => {
    const easy = parseBotProfile(read('easy'), 'easy');
    const normal = parseBotProfile(read('normal'), 'normal');
    // Человечность лёгкого профиля выражена именно теми ручками, ради которых
    // BOT-6 написан: реакция медленнее, прицел грязнее, решения реже.
    expect(easy.reaction.delayTicks).toBeGreaterThan(normal.reaction.delayTicks);
    expect(easy.aim.noiseDegrees).toBeGreaterThan(normal.aim.noiseDegrees);
    expect(easy.decision.intervalTicks).toBeGreaterThan(normal.decision.intervalTicks);
    expect(easy.aggression).toBeLessThan(normal.aggression);
    expect(Object.keys(easy).sort()).toEqual(Object.keys(normal).sort());
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
