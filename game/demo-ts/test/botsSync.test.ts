/**
 * Генерация записей профиля из сцены и аннотации (BOT-13) — на настоящем
 * прогоне команды `npm run bots:sync` по временному дереву контента.
 *
 * Прогон подпроцессом, как её запускает дизайнер: проверяется не модуль правил
 * (он проверен рядом, `botHints.test.ts`), а то, что КОМАНДА действительно
 * приводит документ к сцене, не трогает числа профиля и второй раз подряд не
 * меняет ни байта. Утверждение это про файл на диске, и заметить его срыв без
 * чтения файла нельзя.
 *
 * Отдельно и главное — неподвижная точка на ОТГРУЖЕННОМ дереве: прогон команды
 * без флагов по `content/` обязан не менять в нём ничего. Состав способностей
 * бота — решение дизайнера (BOT-6), и команда, дописывающая лёгкому боту
 * способности, которыми он не играет, ломала бы это решение молча.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'bots-sync.mjs');
const CONTENT = join(HERE, '../../../content');

/** Сцена-фикстура: заряд с отпусканием, мгновенный щит и мгновенный рывок. */
const SCENE = {
  components: [],
  abilities: [
    {
      id: 'bolt',
      trigger: { input: { bit: 0 } },
      cancelBit: 9,
      cooldownTicks: 60,
      targeting: { steps: [{ kind: 'vector' }] },
      phases: [{ id: 'charge', trigger: 'release', durationTicks: 40, timeout: { then: 'cancel' } }],
      effects: [],
    },
    { id: 'guard', trigger: { input: { bit: 6 } }, cooldownTicks: 150, effects: [] },
    { id: 'dash', trigger: { input: { bit: 2 } }, cooldownTicks: 60, effects: [] },
  ],
  prefabs: [{ name: 'SlotBolt', components: { AbilitySlot: { abilityId: 0, slotIndex: 0 } } }],
};

const HINTS = {
  schema: 1,
  name: 'probe',
  profiles: ['bots/probe.json'],
  abilities: {
    bolt: { name: 'cast', target: 'enemy', hands: 'free', range: 12, steps: [{ aim: 'enemy' }] },
    guard: { target: 'threat', range: 9 },
    dash: { target: 'threat', range: 6, requiresMoving: true },
  },
};

/**
 * Профиль-фикстура: МЕХАНИКА записей разошлась со сценой (бит, цель, руки, вид
 * подтверждения, биты каста, требование движения), а числа профиля выкручены и
 * законны — по ним и проверяется, что генерация их не тронула.
 */
const PROFILE = {
  schema: 3,
  name: 'probe',
  reaction: { delayTicks: 8, jitterTicks: 4, memoryTicks: 180 },
  aim: { noiseDegrees: 4, noisePeriodTicks: 12 },
  decision: { intervalTicks: 6, jitterTicks: 3 },
  movement: {
    maxSpeed: 1,
    arriveTolerance: 0.4,
    edgeMargin: 2,
    engageRange: 8,
    strafe: 0.5,
    strafePeriodTicks: 34,
  },
  behavior: 'bots/behaviors/classic.json',
  abilities: [
    {
      name: 'cast',
      button: 1,
      target: 'threat',
      range: 7.5,
      holdTicks: 20,
      cooldownTicks: 62,
      weight: 2.5,
      cast: {
        slotIndex: 0,
        commit: 'confirm',
        confirmButton: 8,
        steps: [{ aim: 'enemy', confirmDelayTicks: 20, pointNoise: 1.25 }],
        holdTicks: 20,
        cancelChance: 0.17,
        giveUpTicks: 111,
      },
    },
    { name: 'dash', button: 2, target: 'threat', range: 6, holdTicks: 1, cooldownTicks: 62, weight: 0.9 },
  ],
  seed: 3,
};

interface Ability {
  readonly name: string;
  readonly button: number;
  readonly target: string;
  readonly hands?: string;
  readonly requiresMoving?: boolean;
  readonly range: number;
  readonly holdTicks: number;
  readonly cooldownTicks: number;
  readonly weight: number;
  readonly cast?: {
    readonly commit: string;
    readonly confirmButton?: number;
    readonly cancelButton?: number;
    readonly holdTicks: number;
    readonly cancelChance: number;
    readonly giveUpTicks: number;
    readonly steps: readonly { readonly aim: string; readonly confirmDelayTicks: number; readonly pointNoise: number }[];
  };
}

/** Временное дерево с фикстурой; `patch` правит профиль, `hints` — аннотацию. */
function tree(
  patch: (profile: typeof PROFILE) => unknown = (profile) => profile,
  hints: unknown = HINTS,
): string {
  const root = mkdtempSync(join(tmpdir(), 'bots-sync-'));
  mkdirSync(join(root, 'scenes'), { recursive: true });
  mkdirSync(join(root, 'bots'), { recursive: true });
  writeFileSync(join(root, 'scenes', 'probe.scene.json'), JSON.stringify(SCENE, null, 2));
  writeFileSync(join(root, 'scenes', 'probe.bots.json'), JSON.stringify(hints, null, 2));
  const profile = patch(JSON.parse(JSON.stringify(PROFILE)) as typeof PROFILE);
  writeFileSync(join(root, 'bots', 'probe.json'), JSON.stringify(profile, null, 2));
  return root;
}

function run(root: string, ...args: string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [CLI, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const abilitiesOf = (root: string, name = 'probe'): readonly Ability[] =>
  (JSON.parse(readFileSync(join(root, 'bots', `${name}.json`), 'utf8')) as { abilities: Ability[] }).abilities;

const byName = (root: string, name: string): Ability =>
  abilitiesOf(root).find((ability) => ability.name === name)!;

describe('BOT-13: генерация приводит записи к сцене и аннотации', () => {
  let root: string;
  let first: string;

  beforeAll(() => {
    root = tree();
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    first = result.stdout;
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('механика записи приведена к определению сцены', () => {
    const cast = byName(root, 'cast');
    expect(cast.button).toBe(0);
    expect(cast.cast!.commit).toBe('release');
    // Бит подтверждения у каста с отпусканием не нажимается никогда (ABIL-4),
    // а бит отмены сцена назначила — и он приехал в запись.
    expect(cast.cast!.confirmButton).toBeUndefined();
    expect(cast.cast!.cancelButton).toBe(9);
  });

  it('семантика записи приведена к аннотации', () => {
    const cast = byName(root, 'cast');
    expect(cast.target).toBe('enemy');
    expect(cast.hands).toBe('free');
    expect(cast.cast!.steps[0]!.aim).toBe('enemy');
    expect(byName(root, 'dash').requiresMoving).toBe(true);
  });

  /** Сценарий BOT-13 «Повторная генерация не трогает сложность». */
  it('числа профиля остались как были', () => {
    const cast = byName(root, 'cast');
    expect(cast.range).toBe(7.5);
    expect(cast.weight).toBe(2.5);
    expect(cast.cooldownTicks).toBe(62);
    expect(cast.holdTicks).toBe(20);
    expect(cast.cast!.holdTicks).toBe(20);
    expect(cast.cast!.cancelChance).toBe(0.17);
    expect(cast.cast!.giveUpTicks).toBe(111);
    expect(cast.cast!.steps[0]!.pointNoise).toBe(1.25);
    expect(byName(root, 'dash').weight).toBe(0.9);
  });

  /**
   * Состав способностей бота — решение дизайнера (BOT-6), и «в профиле её нет»
   * читается двояко: сцена только что её получила либо этот уровень сложности
   * ею не играет. Различить их команде нечем, поэтому по умолчанию она не
   * заводит ничего.
   */
  it('способность, которой в профиле нет, без --add не заводится', () => {
    expect(abilitiesOf(root).map((ability) => ability.name)).toEqual(['cast', 'dash']);
    expect(first).not.toContain('скелет');
  });

  it('второй запуск подряд не меняет ни байта', () => {
    const before = readFileSync(join(root, 'bots', 'probe.json'), 'utf8');
    const again = run(root);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('без изменений');
    expect(readFileSync(join(root, 'bots', 'probe.json'), 'utf8')).toBe(before);
  }, 120_000);
});

/** Сценарий BOT-13 «В сцену добавили способность» — заведение записи явное. */
describe('BOT-13: --add заводит скелет записи из двух документов', () => {
  it('скелет несёт механику и семантику документов, а числа — умолчаниями', () => {
    const root = tree();
    try {
      const result = run(root, '--add');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('заведён скелет записи');
      const guard = byName(root, 'guard');
      expect(guard.button).toBe(6);
      expect(guard.target).toBe('threat');
      expect(guard.range).toBe(9);
      expect(guard.holdTicks).toBe(1);
      expect(guard.cooldownTicks).toBeGreaterThanOrEqual(150);
      expect(guard.cast).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * Скелет способности С ФАЗАМИ: описание каста рождается из определения
   * целиком — слот от prefab'а, вид подтверждения от фазы, биты от определения,
   * прицел шага от аннотации. Проверяется на ЗАВОДИМОЙ записи (её в профиле нет
   * вовсе), потому что мгновенный `guard` этой ветки не касается.
   */
  it('скелет каста собирается из фаз определения и прицела аннотации', () => {
    const root = tree((profile) => ({
      ...profile,
      abilities: profile.abilities.filter((ability) => ability.name !== 'cast'),
    }));
    try {
      const result = run(root, '--add');
      expect(result.status, result.stderr).toBe(0);
      const entry = byName(root, 'cast');
      expect(entry.button).toBe(0);
      expect(entry.hands).toBe('free');
      const cast = entry.cast!;
      expect(cast.commit).toBe('release');
      // У каста с отпусканием бита подтверждения нет вовсе (ABIL-4), бит отмены
      // назначен определением, слот взят из prefab'а сцены (ABIL-1).
      expect(cast.confirmButton).toBeUndefined();
      expect(cast.cancelButton).toBe(9);
      expect((cast as unknown as { slotIndex: number }).slotIndex).toBe(0);
      expect(cast.steps).toHaveLength(1);
      expect(cast.steps[0]!.aim).toBe('enemy');
      // Спад бита И ЕСТЬ подтверждение шага: «сколько держать» и «сколько
      // целиться» — одно число, и разойтись им нельзя.
      expect(cast.steps[0]!.confirmDelayTicks).toBe(cast.holdTicks);
      // Держать — в окне фазы (40 тиков), вести каст — дольше подтверждения
      // вместе с отставанием картинки: скелет обязан быть ИГРАБЕЛЬНЫМ.
      expect(cast.holdTicks).toBeGreaterThanOrEqual(1);
      expect(cast.holdTicks).toBeLessThanOrEqual(40);
      expect(cast.giveUpTicks).toBeGreaterThan(cast.steps[0]!.confirmDelayTicks);
      // Второй прогон подряд ничего не меняет — скелет сошёлся со сценой сразу.
      const before = readFileSync(join(root, 'bots', 'probe.json'), 'utf8');
      const again = run(root, '--add');
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toContain('без изменений');
      expect(readFileSync(join(root, 'bots', 'probe.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * Та же сборка каста, но на СУЩЕСТВУЮЩЕЙ записи старого вида (BOT-6: «профиль
   * знает только нажать бит»): описание каста заводится по фазам определения,
   * а числа записи остаются её собственными. Флаг `--add` тут ни при чём —
   * запись уже есть, к сцене приводится её механика.
   */
  it('записи старого вида описание каста заводится по фазам определения', () => {
    const root = tree((profile) => ({
      ...profile,
      abilities: profile.abilities.map((ability) => {
        if (ability.name !== 'cast') return ability;
        const { cast: _cast, ...rest } = ability as Record<string, unknown>;
        return rest;
      }),
    }));
    try {
      const result = run(root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('описание каста заведено по фазам определения');
      const entry = byName(root, 'cast');
      const cast = entry.cast!;
      expect(cast.commit).toBe('release');
      expect(cast.confirmButton).toBeUndefined();
      expect(cast.cancelButton).toBe(9);
      expect(cast.steps[0]!.aim).toBe('enemy');
      expect(cast.steps[0]!.confirmDelayTicks).toBe(cast.holdTicks);
      // Числа самой записи — её собственные, и заведение каста их не тронуло.
      expect(entry.range).toBe(7.5);
      expect(entry.weight).toBe(2.5);
      expect(entry.cooldownTicks).toBe(62);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * Числа профиля генерация НЕ правит — ни выпавшее из окна удержание, ни кулдаун
 * ниже сценного (BOT-13: «MUST NOT их перетирать»). Она их НАЗЫВАЕТ и выходит
 * ненулевым кодом; правит человек, а гейт сверки краснеет тем же текстом.
 */
describe('BOT-13: разошедшееся число профиля — находка, а не правка', () => {
  let root: string;
  let result: { readonly status: number | null; readonly stdout: string; readonly stderr: string };

  beforeAll(() => {
    root = tree((profile) => {
      const abilities = profile.abilities as Record<string, unknown>[];
      // Кулдаун ниже сценного, удержание мгновенной способности не тап и
      // удержание каста за пределом окна фазы — три числа, три находки.
      abilities[1] = { ...abilities[1], cooldownTicks: 30, holdTicks: 4 };
      const cast = abilities[0]!.cast as Record<string, unknown>;
      abilities[0] = {
        ...abilities[0],
        cast: { ...cast, holdTicks: 90, steps: [{ aim: 'enemy', confirmDelayTicks: 90, pointNoise: 1.25 }], giveUpTicks: 150 },
      };
      return profile;
    });
    result = run(root);
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('команда выходит ненулевым кодом и называет находки', () => {
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('находка');
    expect(result.stdout).toContain('cooldownTicks');
    expect(result.stdout).toContain('holdTicks');
  });

  it('сами числа остались на месте, а механика записана', () => {
    expect(byName(root, 'cast').cast!.holdTicks).toBe(90);
    expect(byName(root, 'dash').cooldownTicks).toBe(30);
    expect(byName(root, 'dash').holdTicks).toBe(4);
    expect(byName(root, 'cast').button).toBe(0);
  });
});

describe('bots:sync по отгруженному дереву — неподвижная точка', () => {
  /**
   * Прогон без флагов по КОПИИ настоящего `content/`: ни одного изменения ни в
   * одном профиле. Копия, а не само дерево, потому что тест обязан оставаться
   * читателем контента, а не его редактором.
   */
  it('ни один отгруженный профиль не меняется', () => {
    const root = mkdtempSync(join(tmpdir(), 'bots-sync-content-'));
    try {
      cpSync(join(CONTENT, 'scenes'), join(root, 'scenes'), { recursive: true });
      cpSync(join(CONTENT, 'bots'), join(root, 'bots'), { recursive: true });
      const before = ['easy', 'normal'].map((name) =>
        readFileSync(join(root, 'bots', `${name}.json`), 'utf8'),
      );
      const result = run(root);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('bots/easy.json: без изменений');
      expect(result.stdout).toContain('bots/normal.json: без изменений');
      for (const [index, name] of ['easy', 'normal'].entries()) {
        expect(readFileSync(join(root, 'bots', `${name}.json`), 'utf8')).toBe(before[index]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('bots:sync: флаги отбора и сухой прогон', () => {
  /** Опечатка в `--profile` иначе выглядела бы как «всё уже сходится». */
  it('--profile с незнакомым путём — отказ, а не молчание', () => {
    const root = tree();
    try {
      const result = run(root, '--profile', 'bots/typo.json');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('не назван ни одним документом');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * Пара, отвалившаяся на находке вывода, — не опечатка в `--profile`: «этот
   * профиль назван аннотацией» решают ДАННЫЕ документа, а не то, дошёл ли
   * прогон до него. Иначе дизайнера отправляли бы искать ошибку, которой нет.
   */
  it('находка вывода не выдаётся за незнакомый --profile', () => {
    const root = tree(undefined, {
      ...HINTS,
      abilities: { ...HINTS.abilities, ghost: { target: 'enemy', range: 5 } },
    });
    try {
      const result = run(root, '--profile', 'bots/probe.json');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('в сцене нет определения с таким id');
      expect(result.stderr).not.toContain('не назван ни одним документом');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('--dry-run называет правки и не пишет ничего', () => {
    const root = tree();
    try {
      const before = readFileSync(join(root, 'bots', 'probe.json'), 'utf8');
      const result = run(root, '--dry-run');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('--dry-run');
      expect(readFileSync(join(root, 'bots', 'probe.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
