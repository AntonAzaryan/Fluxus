/**
 * Сверка бот-профилей с определениями способностей сцены (BOT-13) — на тех
 * самых документах, которые правит дизайнер.
 *
 * Это и есть «проверочный гейт игрового приложения» требования: `npm run check`
 * гоняет тесты демо, и рассинхрон профиля со сценой краснеет здесь — до первого
 * матча со сломанным ботом. Место теста — сборка ИГРЫ, потому что читать оба
 * дерева законно только ей (`game-content` CONT-4, CONT-1); движок в сверке не
 * участвует и участвовать не вправе.
 *
 * Перечень «профиль → сцена» строится ДАННЫМИ: тест обходит парные документы
 * бот-аннотаций дерева (`<база>.bots.json`, BOT-12), а профили берёт из списка
 * `profiles` каждого. Новая сцена с ботами подхватится документами, а не
 * правкой этого файла.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBotProfile, type BotProfile } from '@fluxus/bot';
import { BOT_HINTS_SUFFIX, parseBotHints, type BotHintsDocument } from '../app/botHints.js';
import { expectedAbilities, verifyProfileAbilities, type ContractScene } from '../app/botContract.js';

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), '../../../content');

function read(path: string): unknown {
  return JSON.parse(readFileSync(join(CONTENT, path), 'utf8'));
}

/** Пары «документ бот-аннотаций → парный конфиг сцены» дерева контента. */
function pairs(): readonly { readonly base: string; readonly hints: BotHintsDocument; readonly scene: ContractScene }[] {
  return readdirSync(join(CONTENT, 'scenes'))
    .filter((name) => name.endsWith(BOT_HINTS_SUFFIX))
    .sort()
    .map((name) => {
      const base = name.slice(0, -BOT_HINTS_SUFFIX.length);
      return {
        base,
        hints: parseBotHints(read(`scenes/${name}`), `scenes/${name}`),
        // Парность — по имени файла, как у документа презентации (PRES-1):
        // ссылок между документами пары нет ни в одну сторону.
        scene: read(`scenes/${base}.scene.json`) as ContractScene,
      };
    });
}

const PAIRS = pairs();

describe('BOT-12: парный документ бот-аннотаций сцены', () => {
  it('дуэль описана, и документ разбирается', () => {
    const duel = PAIRS.find((pair) => pair.base === 'duel');
    expect(duel).toBeDefined();
    expect(duel!.hints.schema).toBe(1);
    expect(duel!.hints.profiles).toContain('bots/normal.json');
  });

  /**
   * Ульта отката времени в аннотации отсутствует — как отсутствует и в
   * профилях: её бит ведёт хост мира (`netcode` NET-11), и бот, дёргающий его,
   * останавливал бы матч всем участникам. Отсутствие способности в аннотации
   * означает «боту её не описывали» и находкой не является (BOT-12) — это
   * данные документа, а не ветвление кода.
   */
  it('ульта отката и аура купола боту не описаны', () => {
    const duel = PAIRS.find((pair) => pair.base === 'duel')!;
    const described = duel.hints.abilities.map((hint) => hint.ability);
    expect(described).not.toContain('rewind');
    expect(described).not.toContain('domeAura');
  });

  it('каждая аннотация называет существующее определение сцены', () => {
    for (const pair of PAIRS) {
      expect(expectedAbilities(pair.scene, pair.hints).findings).toEqual([]);
    }
  });
});

describe('BOT-13: отгруженные профили сходятся со сценой', () => {
  const cases = PAIRS.flatMap((pair) =>
    pair.hints.profiles.map((path) => ({ pair, path })),
  );

  it.each(cases.map((entry) => [entry.path, entry] as const))(
    '%s: механика, семантика и кулдаун-инвариант',
    (_path, entry) => {
      const profile = parseBotProfile(read(entry.path), entry.path);
      const derived = expectedAbilities(entry.pair.scene, entry.pair.hints);
      // Находки перечисляются РАЗОМ: адресат — дизайнер, и «почини одно, узнай
      // про следующее» здесь тот же худший цикл правки, что в валидации.
      expect(verifyProfileAbilities(derived.abilities, profile).join('\n')).toBe('');
    },
  );

  /**
   * Профиль, не названный ни одной аннотацией, в гейт не входит вовсе — и
   * узнать об этом надо здесь, а не по боту, играющему мимо сцены. Обратная
   * сторона того же правила, что и опечатка в имени записи (BOT-13).
   */
  it('каждый профиль дерева назван ровно одной аннотацией', () => {
    const profiles = readdirSync(join(CONTENT, 'bots'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => `bots/${entry.name}`)
      .sort();
    expect(profiles.length).toBeGreaterThan(0);
    for (const path of profiles) {
      const claimed = PAIRS.filter((pair) => pair.hints.profiles.includes(path));
      expect(claimed.map((pair) => pair.base), path).toHaveLength(1);
    }
  });

  /**
   * Состав способностей бота — выбор дизайнера (BOT-6): лёгкий профиль не
   * играет захватом, и отсутствие записи находкой быть не должно. Проверяется
   * именно на нём, а не на выдуманном документе: пропади это правило, тест
   * выше покраснел бы на отгруженном контенте.
   */
  it('способность, которой у профиля нет, находкой не является', () => {
    const duel = PAIRS.find((pair) => pair.base === 'duel')!;
    const easy = parseBotProfile(read('bots/easy.json'), 'bots/easy.json');
    expect(easy.abilities.map((ability) => ability.name)).not.toContain('capture');
    const derived = expectedAbilities(duel.scene, duel.hints);
    expect(derived.abilities.map((entry) => entry.name)).toContain('capture');
    expect(verifyProfileAbilities(derived.abilities, easy)).toEqual([]);
  });
});

/** Профиль дуэли с точечной подделкой одной записи — фикстура негативных проверок. */
function tampered(name: string, patch: Record<string, unknown>): BotProfile {
  const document = read('bots/normal.json') as { abilities: Record<string, unknown>[] };
  document.abilities = document.abilities.map((entry) =>
    entry.name === name ? { ...entry, ...patch } : entry,
  );
  return parseBotProfile(document, 'подделанный профиль');
}

describe('BOT-13: рассинхрон становится находкой, а не поведением бота в матче', () => {
  const duel = PAIRS.find((pair) => pair.base === 'duel')!;
  const derived = expectedAbilities(duel.scene, duel.hints).abilities;

  /** Сценарий «Дизайнер поменял бит триггера в сцене» — с той же стороны. */
  it('бит триггера разошёлся со сценой: находка называет способность и оба бита', () => {
    const findings = verifyProfileAbilities(derived, tampered('cast', { button: 1 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"cast"');
    expect(findings[0]).toContain('button');
    expect(findings[0]).toContain('1');
    expect(findings[0]).toContain('0');
  });

  /** Сценарий «Кулдаун профиля ниже сценного». */
  it('кулдаун ниже кулдауна определения: находка называет оба числа', () => {
    const findings = verifyProfileAbilities(derived, tampered('slowDome', { cooldownTicks: 120 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('cooldownTicks');
    expect(findings[0]).toContain('120');
    expect(findings[0]).toContain('300');
    expect(findings[0]).toContain('незаряженную');
  });

  it('кулдаун ВЫШЕ сценного законен: «этот бот применяет её реже»', () => {
    expect(verifyProfileAbilities(derived, tampered('slowDome', { cooldownTicks: 600 }))).toEqual([]);
  });

  /** Сценарий BOT-6 «Профиль со старым описанием способности». */
  it('описание каста пропало, а определение требует подтверждения шага: находка', () => {
    const document = read('bots/normal.json') as { abilities: Record<string, unknown>[] };
    document.abilities = document.abilities.map((entry) => {
      if (entry.name !== 'cast') return entry;
      const { cast: _cast, ...rest } = entry;
      return { ...rest, holdTicks: 1 };
    });
    const findings = verifyProfileAbilities(derived, parseBotProfile(document, 'профиль без каста'));
    expect(findings.join('\n')).toContain('определение сцены требует подтверждения шага');
  });

  it('прицел шага разошёлся с аннотацией: находка называет шаг', () => {
    const findings = verifyProfileAbilities(
      derived,
      tampered('capture', {
        cast: {
          slotIndex: 2,
          commit: 'release',
          cancelButton: 9,
          steps: [{ aim: 'self', confirmDelayTicks: 4, pointNoise: 0.1 }],
          holdTicks: 4,
          cancelChance: 0,
          giveUpTicks: 60,
        },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('cast.steps[0].aim');
    expect(findings[0]).toContain('threat');
  });

  it('удержание вне окна фазы удержания: находка называет окно', () => {
    const cast = (holdTicks: number): Record<string, unknown> => ({
      cast: {
        slotIndex: 0,
        commit: 'release',
        cancelButton: 9,
        steps: [{ aim: 'enemy', confirmDelayTicks: holdTicks, pointNoise: 0.4 }],
        holdTicks,
        cancelChance: 0.05,
        giveUpTicks: 150,
      },
    });
    const findings = verifyProfileAbilities(derived, tampered('cast', cast(90)));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('holdTicks');
    expect(findings[0]).toContain('79');
    // Ровно длительность фазы — законное удержание: отпускание завершает фазу
    // раньше ветки истечения, и находки тут быть не должно (ABIL-4).
    expect(verifyProfileAbilities(derived, tampered('cast', cast(79)))).toEqual([]);
  });

  /**
   * Связка «запись профиля ↔ определение сцены» держится ИМЕНЕМ, и опечатка в
   * нём выключала бы сверку записи молча. Признак — бит: неописанная запись на
   * бите описанного определения почти наверняка оно и есть.
   */
  it('запись профиля на бите описанного определения, которую аннотация не назвала, — находка', () => {
    const document = read('bots/normal.json') as { abilities: Record<string, unknown>[] };
    document.abilities = document.abilities.map((entry) =>
      entry.name === 'shield' ? { ...entry, name: 'shieId' } : entry,
    );
    const findings = verifyProfileAbilities(derived, parseBotProfile(document, 'опечатка в имени'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"shieId"');
    expect(findings[0]).toContain('shield');
    expect(findings[0]).toContain('6');
  });

  /**
   * Прыжок демо — манёвр локомоушена (LOC-5), определения способности у него
   * нет вовсе, и его бит не назначен ни одному описанному определению: запись
   * молча не сверяется, и это законное «боту её не описывали» (BOT-12).
   */
  it('запись на бите, которого нет ни у одного определения, находкой не является', () => {
    const profile = parseBotProfile(read('bots/normal.json'), 'bots/normal.json');
    expect(profile.abilities.map((ability) => ability.name)).toContain('jump');
    expect(derived.map((entry) => entry.button)).not.toContain(3);
    expect(verifyProfileAbilities(derived, profile)).toEqual([]);
  });
});
