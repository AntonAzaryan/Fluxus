/**
 * Документ бот-аннотаций (BOT-12) и правила вывода механики из определения
 * сцены (BOT-13) — форма, валидация и вывод на синтетических определениях.
 *
 * Сверка отгруженного контента живёт рядом (`botContract.test.ts`); здесь
 * проверяются САМИ правила, в том числе те их ветки, которых в дуэли нет:
 * подтверждение фронтом против отпускания, кулдаун-выражение против литерала,
 * способность без прицеливания.
 */
import { describe, expect, it } from 'vitest';
import type { AbilityDef, PrefabDef } from '@game-mvp/core';
import { BOT_HINTS_SCHEMA, parseBotHints } from '../app/botHints.js';
import { expectedAbilities, type ContractScene } from '../app/botContract.js';

/** Минимальный валидный документ; тесты правят его точечно. */
function document(abilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: BOT_HINTS_SCHEMA,
    name: 'fixture',
    profiles: ['bots/normal.json'],
    abilities: { cast: { target: 'enemy', range: 10 }, ...abilities },
  };
}

describe('BOT-12: форма документа бот-аннотаций', () => {
  it('валидный документ разбирается, а молчание полей — умолчания', () => {
    const parsed = parseBotHints(document());
    expect(parsed.name).toBe('fixture');
    expect(parsed.abilities).toHaveLength(1);
    const hint = parsed.abilities[0]!;
    // Имя записи профиля молчанием документа совпадает с id определения,
    // цепочка шагов молчанием пуста, а руки молчанием безразличны.
    expect(hint.ability).toBe('cast');
    expect(hint.name).toBe('cast');
    expect(hint.steps).toEqual([]);
    expect(hint.hands).toBeUndefined();
    expect(hint.requiresMoving).toBe(false);
    expect(hint.cooldownTicks).toBeUndefined();
  });

  it('имя записи профиля называется отдельно: определение "fireball" — запись "cast"', () => {
    const parsed = parseBotHints({
      ...document(),
      abilities: { fireball: { name: 'cast', target: 'enemy', range: 12, steps: [{ aim: 'enemy' }] } },
    });
    const hint = parsed.abilities.find((entry) => entry.ability === 'fireball')!;
    expect(hint.name).toBe('cast');
    expect(hint.steps).toEqual([{ aim: 'enemy' }]);
  });

  it('чужая версия формы названа находкой всегда', () => {
    expect(() => parseBotHints({ ...document(), schema: 2 })).toThrow(/schema: 2 — реализация читает форму 1/);
  });

  it('неизвестная цель и неизвестные руки — находки с самим значением', () => {
    expect(() => parseBotHints(document({ dome: { target: 'building', range: 1 } }))).toThrow(
      /target: ожидалось одно из enemy\|threat\|cliff, получено "building"/,
    );
    expect(() => parseBotHints(document({ dome: { target: 'enemy', hands: 'left', range: 1 } }))).toThrow(
      /hands: ожидалось одно из free\|full, получено "left"/,
    );
  });

  it('неизвестный прицел шага — находка с путём шага', () => {
    expect(() =>
      parseBotHints(document({ dome: { target: 'enemy', range: 1, steps: [{ aim: 'cliff' }] } })),
    ).toThrow(/steps\[0\]\.aim: ожидалось одно из enemy\|threat\|self/);
  });

  /** То же правило, что в профиле: `rise` осмыслен только у цели `cliff` — и обязателен у неё. */
  it('перепад уступа у не-cliff и его отсутствие у cliff — находки', () => {
    expect(() => parseBotHints(document({ dome: { target: 'enemy', range: 1, rise: 1 } }))).toThrow(
      /rise: перепад уступа осмыслен только у цели "cliff"/,
    );
    expect(() => parseBotHints(document({ leap: { target: 'cliff', range: 1 } }))).toThrow(
      /rise: цель "cliff" обязана назвать перепад уступа/,
    );
    const parsed = parseBotHints(document({ leap: { target: 'cliff', range: 1, rise: 1 } }));
    expect(parsed.abilities.find((hint) => hint.ability === 'leap')!.rise).toBe(1);
  });

  it('две аннотации на одно имя записи профиля — находка', () => {
    expect(() =>
      parseBotHints(document({ fireball: { name: 'cast', target: 'enemy', range: 1 } })),
    ).toThrow(/запись профиля "cast" названа дважды/);
  });

  it('путь профиля адресуется от корня дерева контента (ASSET-2)', () => {
    expect(() => parseBotHints({ ...document(), profiles: ['../bots/normal.json'] })).toThrow(
      /профиль.*корня дерева контента|profiles\[0\]/,
    );
    expect(() => parseBotHints({ ...document(), profiles: 'bots/normal.json' })).toThrow(
      /profiles: ожидался массив путей/,
    );
  });

  it('находки перечисляются разом, а не по первой', () => {
    let message = '';
    try {
      parseBotHints({ schema: 7, name: '', profiles: [], abilities: { a: { target: 'x', range: -1 } } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('schema');
    expect(message).toContain('name');
    expect(message).toContain('target');
    expect(message).toContain('range');
  });
});

// ------------------------------------------------------- правила вывода

const SLOT: PrefabDef = { name: 'Slot', components: { AbilitySlot: { abilityId: 0, slotIndex: 3 } } };

function scene(def: Partial<AbilityDef>): ContractScene {
  return {
    abilities: [{ id: 'probe', trigger: { input: { bit: 4 } }, effects: [], ...def }],
    prefabs: [SLOT],
  };
}

function hints(hint: Record<string, unknown>): Record<string, unknown> {
  return { schema: BOT_HINTS_SCHEMA, name: 'fixture', profiles: [], abilities: { probe: hint } };
}

function derive(def: Partial<AbilityDef>, hint: Record<string, unknown>): ReturnType<typeof expectedAbilities> {
  return expectedAbilities(scene(def), parseBotHints(hints(hint)));
}

describe('BOT-13: механика выводится из определения, семантика — из аннотации', () => {
  it('мгновенная способность: бит триггера, тап и отсутствие каста', () => {
    const { abilities, findings } = derive({ cooldownTicks: 45 }, { target: 'threat', range: 5 });
    expect(findings).toEqual([]);
    const entry = abilities[0]!;
    expect(entry.button).toBe(4);
    expect(entry.target).toBe('threat');
    expect(entry.cooldownFloor).toBe(45);
    // Ни фаз, ни удержания: держать нечего, применение — тап.
    expect(entry.holdMaxTicks).toBeUndefined();
    expect(entry.cast).toBeUndefined();
  });

  it('фаза отпускания: подтверждение спадом бита, фронта подтверждения нет', () => {
    const { abilities } = derive(
      {
        confirmBit: 8,
        cancelBit: 9,
        phases: [{ id: 'aim', trigger: 'release', durationTicks: 60, timeout: { then: 'cancel' } }],
        targeting: { steps: [{ kind: 'unit' }] },
      },
      { target: 'threat', range: 5, steps: [{ aim: 'threat' }] },
    );
    const cast = abilities[0]!.cast!;
    expect(cast.commit).toBe('release');
    // Бит подтверждения сцена назначила, но касту с отпусканием он не нужен:
    // шаг записывает прекращение удержания (ABIL-4).
    expect(cast.confirmButton).toBeUndefined();
    expect(cast.cancelButton).toBe(9);
    expect(cast.slotIndex).toBe(3);
    expect(cast.steps).toEqual(['threat']);
    // Предел удержания — сама длительность фазы: отпускание завершает её ДО
    // ветки истечения, и ровно `durationTicks` — законное удержание (ABIL-4).
    expect(abilities[0]!.holdMaxTicks).toBe(60);
  });

  /**
   * Предел удержания — сама длительность, без запаса в тик: прекращение
   * удержания завершает фазу РАНЬШЕ ветки истечения, а шаг того же тика записан
   * ещё раньше — системой накопления (ABIL-4, ABIL-5, DET-9). Фаза без
   * длительности предела не даёт вовсе.
   */
  it('предел удержания равен длительности фазы, а фаза без длительности предела не даёт', () => {
    const commit = derive(
      {
        phases: [{ id: 'aim', trigger: 'release', durationTicks: 20, timeout: { then: 'commit' } }],
        targeting: { steps: [{ kind: 'unit' }] },
      },
      { target: 'threat', range: 5, steps: [{ aim: 'threat' }] },
    );
    expect(commit.abilities[0]!.holdMaxTicks).toBe(20);

    const cancel = derive(
      {
        phases: [{ id: 'aim', trigger: 'release', durationTicks: 20, timeout: { then: 'cancel' } }],
        targeting: { steps: [{ kind: 'unit' }] },
      },
      { target: 'threat', range: 5, steps: [{ aim: 'threat' }] },
    );
    expect(cancel.abilities[0]!.holdMaxTicks).toBe(20);

    const endless = derive(
      { phases: [{ id: 'charge', trigger: 'hold' }] },
      { target: 'enemy', range: 5 },
    );
    expect(endless.abilities[0]!.holdMaxTicks).toBe(Number.POSITIVE_INFINITY);
  });

  it('фаза подтверждения: вид подтверждения — фронт, бит берётся из определения', () => {
    const { abilities, findings } = derive(
      {
        confirmBit: 8,
        phases: [
          { id: 'charge', trigger: 'hold', durationTicks: 30, timeout: { then: 'commit' } },
          { id: 'aim', trigger: 'commit' },
        ],
        targeting: { steps: [{ kind: 'unit' }, { kind: 'vector' }] },
      },
      { target: 'enemy', range: 5, steps: [{ aim: 'enemy' }, { aim: 'self' }] },
    );
    expect(findings).toEqual([]);
    const cast = abilities[0]!.cast!;
    expect(cast.commit).toBe('confirm');
    expect(cast.confirmButton).toBe(8);
    expect(cast.steps).toEqual(['enemy', 'self']);
    // Таймаут не срывает каст, значит предел удержания — сама длительность.
    expect(abilities[0]!.holdMaxTicks).toBe(30);
  });

  it('каст с подтверждением без бита подтверждения в сцене — находка', () => {
    const { findings } = derive(
      { phases: [{ id: 'aim', trigger: 'commit' }], targeting: { steps: [{ kind: 'point' }] } },
      { target: 'enemy', range: 5, steps: [{ aim: 'enemy' }] },
    );
    expect(findings.join('\n')).toContain('бита подтверждения не назначило');
  });

  it('кулдаун-литерал даёт нижнюю границу, а кулдаун-выражение требует числа аннотации', () => {
    const expression = { var: 'slot.level' } as unknown as AbilityDef['cooldownTicks'];
    const silent = derive({ cooldownTicks: expression }, { target: 'enemy', range: 5 });
    expect(silent.findings.join('\n')).toContain('число для сверки обязана назвать аннотация');
    const named = derive({ cooldownTicks: expression }, { target: 'enemy', range: 5, cooldownTicks: 90 });
    expect(named.findings).toEqual([]);
    expect(named.abilities[0]!.cooldownFloor).toBe(90);
  });

  it('аннотация спорит с литералом кулдауна — находка', () => {
    const { findings } = derive({ cooldownTicks: 60 }, { target: 'enemy', range: 5, cooldownTicks: 30 });
    expect(findings.join('\n')).toContain('литерал 60');
  });

  it('число шагов аннотации не сошлось с цепочкой определения — находка', () => {
    const { findings } = derive(
      { phases: [{ id: 'aim', trigger: 'release' }], targeting: { steps: [{ kind: 'unit' }] } },
      { target: 'enemy', range: 5 },
    );
    expect(findings.join('\n')).toContain('аннотация описывает 0 шаг(ов)');
  });

  it('аннотация на несуществующее определение и на не-ввод — находки', () => {
    const missing = expectedAbilities(
      scene({}),
      parseBotHints({ schema: BOT_HINTS_SCHEMA, name: 'f', profiles: [], abilities: { ghost: { target: 'enemy', range: 1 } } }),
    );
    expect(missing.abilities).toEqual([]);
    expect(missing.findings.join('\n')).toContain('в сцене нет определения');

    const aura = derive({ trigger: { always: true } }, { target: 'enemy', range: 1 });
    expect(aura.abilities).toEqual([]);
    expect(aura.findings.join('\n')).toContain('не ввод');
  });

  it('нет prefab\'а слота для определения с фазами — находка', () => {
    const { findings } = expectedAbilities(
      { abilities: [{ id: 'probe', trigger: { input: { bit: 1 } }, effects: [], confirmBit: 8, phases: [{ id: 'aim', trigger: 'commit' }] }], prefabs: [] },
      parseBotHints(hints({ target: 'enemy', range: 1 })),
    );
    expect(findings.join('\n')).toContain("нет prefab'а слота");
  });
});
