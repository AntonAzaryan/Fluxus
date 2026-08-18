/**
 * Регрессия на запускаемость CLI (CLI-1): `bin/sim.mjs` обязан прогонять сценарий
 * штатным `node`, без экспериментальных флагов.
 *
 * Остальные тесты этого не ловят: vitest грузит `src/` через свой трансформ,
 * который умеет весь TypeScript, а `bin/sim.mjs` полагается на strip-only режим
 * Node (>=22.18) — тот только удаляет типы и ничего не порождает. Поэтому
 * parameter property (`constructor(private readonly x: T)`), enum или namespace
 * в `src/` валит CLI на старте, оставляя набор из vitest зелёным. Ровно так
 * ядро и сломалось: `VisibilitySystem` объявляла поле через parameter property.
 *
 * Отсюда и подпроцесс вместо импорта: проверяется именно то, как ядро грузит
 * Node, а не то, как его грузит vitest.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIM = join(ROOT, 'bin', 'sim.mjs');
const GOLDEN_DIR = join(ROOT, '..', 'tests', 'golden');

/** Сценарий с системой, которая и упиралась в strip-only (`VisibilitySystem`). */
const SCENARIO = 'visibility';

function goldenFile(scenario: string): string {
  return readFileSync(join(GOLDEN_DIR, `${scenario}.golden.json`), 'utf8');
}

function runSim(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SIM, ...args], {
    encoding: 'utf8',
    // Никаких NODE_OPTIONS из окружения: иначе чужой
    // `--experimental-transform-types` замаскировал бы поломку и тест бы
    // зеленел там, где обычный `npm run sim` падает.
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('bin/sim.mjs (CLI-1)', () => {
  it('запускается штатным node и печатает разбираемый JSON', () => {
    const { status, stdout, stderr } = runSim([join(GOLDEN_DIR, `${SCENARIO}.scenario.json`)]);

    // stderr в сообщении об ошибке — чтобы упавший разбор типов был виден сразу,
    // а не через «Unexpected end of JSON input».
    expect(status, stderr).toBe(0);

    const report = JSON.parse(stdout) as { scenario: string; worldInitHash: string };
    expect(report.scenario).toBe(SCENARIO);

    // Хэш сверяется с эталоном, а не захардкожен: CLI обязан выдавать то же, что
    // in-process прогон в golden.test.ts (CLI-4), и обновляться вместе с ним.
    const golden = JSON.parse(goldenFile(SCENARIO)) as { worldInitHash: string };
    expect(report.worldInitHash).toBe(golden.worldInitHash);
    expect(golden.worldInitHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('не печатает ничего мимо stdout', () => {
    // Пустой stderr — это и есть проверка «без экспериментальных флагов»:
    // `--experimental-transform-types` печатает ExperimentalWarning именно сюда.
    expect(runSim([join(GOLDEN_DIR, `${SCENARIO}.scenario.json`)]).stderr).toBe('');
  });

  it('байты stdout совпадают с эталоном (CLI-4, DET-1)', () => {
    // Golden-набор сверяют побайтно, поэтому CLI не имеет права ни на лишний
    // перевод строки, ни на приписку рантайма в stdout.
    expect(runSim([join(GOLDEN_DIR, `${SCENARIO}.scenario.json`)]).stdout).toBe(goldenFile(SCENARIO));
  });

  it('без аргумента выходит с кодом 2 и подсказкой', () => {
    const { status, stderr } = runSim([]);
    expect(status).toBe(2);
    expect(stderr).toContain('usage:');
  });
});

/**
 * Журнал боя (CLI-12) — вторая команда поверх ядра, и она грузится тем же
 * strip-only режимом Node. Прогон здесь сквозной: `sim.mjs --trace=full`
 * кладёт трейс, `journal.mjs` собирает по нему журнал, ничего не запуская.
 */
describe('bin/journal.mjs (CLI-12)', () => {
  const JOURNAL = join(ROOT, 'bin', 'journal.mjs');

  function runJournal(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [JOURNAL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    if (result.error !== undefined) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('собирает журнал по сохранённому трейсу, не запуская симуляции', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-cli-'));
    const tracePath = join(dir, 'trace.jsonl');
    // Сцена каста (`input-drive`) эмитит событие — иначе боевых фактов в
    // журнале не было бы вовсе, и проверять было бы нечего.
    const sim = runSim([join(GOLDEN_DIR, 'input-drive.scenario.json'), '--trace=full', `--trace-out=${tracePath}`]);
    expect(sim.status, sim.stderr).toBe(0);

    const { status, stdout, stderr } = runJournal([tracePath]);
    expect(status, stderr).toBe(0);
    const lines = stdout.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(0);
    // Словаря не назвали — журнал собран, семантика у всех фактов неизвестная,
    // а встреченные типы названы отчётом в ДРУГОМ потоке (CLI-12).
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ kind: '$unknown' });
    expect(stderr).toContain('типов событий вне словаря');
    expect(stdout).not.toContain('типов событий вне словаря');

    rmSync(dir, { recursive: true, force: true });
  });

  it('без аргумента выходит с кодом 2 и подсказкой', () => {
    const { status, stderr } = runJournal([]);
    expect(status).toBe(2);
    expect(stderr).toContain('usage:');
  });
});
