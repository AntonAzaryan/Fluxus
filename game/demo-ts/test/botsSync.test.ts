/**
 * Генерация записей профиля из сцены и аннотации (BOT-13) — на настоящем
 * прогоне команды `npm run bots:sync` по временному дереву контента.
 *
 * Прогон подпроцессом, как её запускает дизайнер: проверяется не модуль правил
 * (он проверен рядом, `botHints.test.ts`), а то, что КОМАНДА действительно
 * приводит документ к сцене, не трогает числа сложности и второй раз подряд не
 * меняет ни байта. Утверждение это про файл на диске, и заметить его срыв без
 * чтения файла нельзя.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bots-sync.mjs');

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
 * Профиль-фикстура: механика записей разошлась со сценой (бит, цель, руки, вид
 * подтверждения, удержание мгновенной способности, заниженный кулдаун), а числа
 * сложности выкручены — по ним и проверяется, что генерация их не тронула.
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
    { name: 'dash', button: 2, target: 'threat', range: 6, holdTicks: 4, cooldownTicks: 30, weight: 0.9 },
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

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'bots-sync-'));
  mkdirSync(join(root, 'scenes'), { recursive: true });
  mkdirSync(join(root, 'bots'), { recursive: true });
  writeFileSync(join(root, 'scenes', 'probe.scene.json'), JSON.stringify(SCENE, null, 2));
  writeFileSync(join(root, 'scenes', 'probe.bots.json'), JSON.stringify(HINTS, null, 2));
  writeFileSync(join(root, 'bots', 'probe.json'), JSON.stringify(PROFILE, null, 2));
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

const abilitiesOf = (root: string): readonly Ability[] =>
  (JSON.parse(readFileSync(join(root, 'bots', 'probe.json'), 'utf8')) as { abilities: Ability[] }).abilities;

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
  });

  /** Сценарий BOT-13 «Повторная генерация не трогает сложность». */
  it('числа сложности исполнения остались как были', () => {
    const cast = byName(root, 'cast');
    expect(cast.range).toBe(7.5);
    expect(cast.weight).toBe(2.5);
    expect(cast.cooldownTicks).toBe(62);
    expect(cast.cast!.holdTicks).toBe(20);
    expect(cast.cast!.cancelChance).toBe(0.17);
    expect(cast.cast!.giveUpTicks).toBe(111);
    expect(cast.cast!.steps[0]!.pointNoise).toBe(1.25);
  });

  it('кулдаун ниже сценного поднят до сценного, удержание мгновенной стало тапом', () => {
    const dash = byName(root, 'dash');
    expect(dash.cooldownTicks).toBeGreaterThanOrEqual(60);
    expect(dash.holdTicks).toBe(1);
    // Требование движения — семантика аннотации, и оно доехало.
    expect(dash.requiresMoving).toBe(true);
    // Вес — число сложности, и он не тронут.
    expect(dash.weight).toBe(0.9);
  });

  /** Сценарий BOT-13 «В сцену добавили способность». */
  it('способность, которой в профиле не было, заведена скелетом', () => {
    const guard = byName(root, 'guard');
    expect(guard.button).toBe(6);
    expect(guard.target).toBe('threat');
    expect(guard.range).toBe(9);
    expect(guard.holdTicks).toBe(1);
    expect(guard.cooldownTicks).toBeGreaterThanOrEqual(150);
    expect(guard.cast).toBeUndefined();
    expect(first).toContain('заведён скелет записи');
  });

  it('второй запуск подряд не меняет ни байта', () => {
    const before = readFileSync(join(root, 'bots', 'probe.json'), 'utf8');
    const again = run(root);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('без изменений');
    expect(readFileSync(join(root, 'bots', 'probe.json'), 'utf8')).toBe(before);
  }, 120_000);
});

describe('BOT-6: состав способностей бота остаётся выбором дизайнера', () => {
  it('--no-add правит существующие записи и не заводит новых', () => {
    const root = tree();
    try {
      const result = run(root, '--no-add');
      expect(result.status, result.stderr).toBe(0);
      expect(abilitiesOf(root).map((ability) => ability.name)).toEqual(['cast', 'dash']);
      expect(byName(root, 'cast').button).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

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
