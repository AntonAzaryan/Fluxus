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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Умеет ли окружение заводить ссылку на КАТАЛОГ.
 *
 * На Windows это привилегия (режим разработчика либо администратор), и её
 * отсутствие — свойство машины, а не дефект кода. Случай поэтому ПРОПУСКАЕТСЯ
 * явно: назвать проверку непроведённой честнее, чем подменить её ссылкой,
 * которой в проверяемом сценарии нет.
 *
 * Junction, привилегии не требующий, заменой не служит: он нацеливается только
 * на ЛОКАЛЬНЫЙ том, а том репозитория бывает и не таким. На машине, где это
 * писалось, junction на каталог репозитория создавался успешно, после чего
 * любое обращение к нему падало с «имя содержит по крайней мере одну точку
 * подключения, которая ссылается на том, к которому объект устройства не
 * подключен». Проба поэтому заводит обычную ссылку — она такого ограничения не
 * знает и проверяет ровно то право, которое тесту и нужно.
 */
const DIRECTORY_LINKS_ALLOWED = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'journal-linkprobe-'));
  try {
    // Цель у пробы своя, а не каталог репозитория: проверяется право заводить
    // ссылку, и трогать ради этого дерево репозитория незачем.
    mkdirSync(join(probe, 'target'));
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
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

  /**
   * Отбор записей на прогоне сценария (DIAG-9, CLI-11). Без него трейс матча,
   * снятый с отбором, переснять было бы нечем: запись рядом есть, а команды,
   * принимающей тот же отбор, — нет.
   */
  it('--trace-select сужает трейс тем же словарём, что и запускалки матча', () => {
    const scenario = join(GOLDEN_DIR, 'collision-bounce.scenario.json');
    const full = runSim([scenario, '--trace=full']);
    const selected = runSim([scenario, '--trace=full', '--trace-select=event']);
    expect(selected.status, selected.stderr).toBe(0);

    const kinds = (text: string): string[] =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
    expect(new Set(kinds(selected.stderr))).toEqual(new Set(['event']));
    expect(kinds(selected.stderr).length).toBeGreaterThan(0);
    expect(kinds(full.stderr).length).toBeGreaterThan(kinds(selected.stderr).length);
    // Документ CLI-3 отбор не трогает — он про трейс, а не про вывод (CLI-7).
    expect(selected.stdout).toBe(full.stdout);
  });

  it('незнакомое имя отбора — код 2 и подсказка, а не пустой трейс', () => {
    const { status, stderr } = runSim([
      join(GOLDEN_DIR, `${SCENARIO}.scenario.json`),
      '--trace=full',
      '--trace-select=events',
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain('неизвестное имя "events"');
    expect(stderr).toContain('usage:');
  });

  it('раздельная форма флагов работает наравне с `=` (CLI-11)', () => {
    // `--trace full --trace-out <path>` — форма, обещанная описанием команд и
    // принимаемая запускалками матча; молча превращаться в путь сценария она не
    // должна: прогон с флагом до сценария завершался бы нулём БЕЗ трейса.
    const dir = mkdtempSync(join(tmpdir(), 'sim-args-'));
    const scenario = join(GOLDEN_DIR, 'collision-bounce.scenario.json');
    const spacedOut = join(dir, 'spaced.jsonl');
    const equalsOut = join(dir, 'equals.jsonl');

    const spaced = runSim([scenario, '--trace', 'full', '--trace-select', 'event', '--trace-out', spacedOut]);
    const equals = runSim([scenario, '--trace=full', '--trace-select=event', `--trace-out=${equalsOut}`]);
    expect(spaced.status, spaced.stderr).toBe(0);
    expect(spaced.stdout).toBe(equals.stdout);
    expect(readFileSync(spacedOut, 'utf8')).toBe(readFileSync(equalsOut, 'utf8'));
    expect(readFileSync(spacedOut, 'utf8')).not.toBe('');

    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Опечатка в аргументах — отказ с кодом 2, а не тихое умолчание (CLI-11): до
   * правки любой не-флаговый аргумент молча становился путём сценария, и прогон
   * `--trace-out t.jsonl scenario.json` завершался нулём без файла трейса —
   * прогоном, делающим не то, что написано в команде.
   */
  const BAD_SIM_ARGS: Readonly<Record<string, readonly string[]>> = {
    'незнакомый флаг': ['s.json', '--trqce=full'],
    '--trace-out без значения': ['s.json', '--trace-out'],
    '--trace-select, за которым флаг': ['s.json', '--trace-select', '--trace=full'],
    'раздельный --trace с недопустимым уровнем': ['--trace', 's.json'],
    'второй файл сценария': ['a.json', 'b.json'],
  };

  for (const [name, args] of Object.entries(BAD_SIM_ARGS)) {
    it(`${name} — код 2 и подсказка`, () => {
      const { status, stderr, stdout } = runSim(args);
      expect(status).toBe(2);
      expect(stderr).toContain('usage:');
      // Ни байта документа CLI-3: отказ разбора не должен выглядеть прогоном.
      expect(stdout).toBe('');
    });
  }
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

  /**
   * Опечатка в аргументах — отказ, а не тихое умолчание. Самый дорогой из
   * случаев — `--dict` без значения: он давал бы ПОЛНЫЙ журнал, где у всех
   * фактов неизвестная семантика, то есть результат, неотличимый от законного
   * прогона без словаря (CLI-12).
   */
  const BAD_ARGS: Readonly<Record<string, readonly string[]>> = {
    '--dict без значения': ['t.jsonl', '--dict'],
    '--dict, за которым флаг': ['t.jsonl', '--dict', '--format=text'],
    '--out без значения': ['t.jsonl', '--out'],
    'незнакомый флаг': ['t.jsonl', '--dictt', 'x.json'],
    'незнакомая форма': ['t.jsonl', '--format=csv'],
    'второй файл трейса': ['a.jsonl', 'b.jsonl'],
  };

  for (const [name, args] of Object.entries(BAD_ARGS)) {
    it(`${name} — код 2 и подсказка`, () => {
      const { status, stderr, stdout } = runJournal(args);
      expect(status).toBe(2);
      expect(stderr).toContain('usage:');
      // Ни строчки журнала: отказ разбора не должен выглядеть пустым журналом.
      expect(stdout).toBe('');
    });
  }

  it.skipIf(!DIRECTORY_LINKS_ALLOWED)('работает и через симлинк на каталог репозитория', () => {
    // Признак «запущен как команда» сравнивает URL после разрешения симлинков:
    // сравнение строк путей давало бы через симлинк ПУСТОЙ вывод и код 0 —
    // самый дорогой вид отказа для того, кто зовёт команду из скрипта.
    const dir = mkdtempSync(join(tmpdir(), 'journal-link-'));
    const link = join(dir, 'core-link');
    symlinkSync(ROOT, link, 'dir');
    const tracePath = join(dir, 'trace.jsonl');
    const sim = runSim([join(GOLDEN_DIR, 'input-drive.scenario.json'), '--trace=full', `--trace-out=${tracePath}`]);
    expect(sim.status, sim.stderr).toBe(0);

    const direct = runJournal([tracePath]);
    const viaLink = spawnSync(process.execPath, [join(link, 'bin', 'journal.mjs'), tracePath], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(viaLink.status, viaLink.stderr).toBe(0);
    expect(viaLink.stdout).toBe(direct.stdout);
    expect(viaLink.stdout).not.toBe('');

    rmSync(dir, { recursive: true, force: true });
  });

  it('раздельная форма флага работает наравне с `=`', () => {
    // `--format text` — форма, которой пользуется вторая семья команд
    // (запускалки матча); молча превращаться в путь трейса она не должна.
    const dir = mkdtempSync(join(tmpdir(), 'journal-args-'));
    const tracePath = join(dir, 'trace.jsonl');
    const sim = runSim([join(GOLDEN_DIR, 'input-drive.scenario.json'), '--trace=full', `--trace-out=${tracePath}`]);
    expect(sim.status, sim.stderr).toBe(0);

    const spaced = runJournal([tracePath, '--format', 'text']);
    const equals = runJournal([tracePath, '--format=text']);
    expect(spaced.status, spaced.stderr).toBe(0);
    expect(spaced.stdout).toBe(equals.stdout);
    expect(spaced.stdout).toContain('tick');

    rmSync(dir, { recursive: true, force: true });
  });
});
