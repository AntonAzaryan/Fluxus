/**
 * Отладочный прогон стенда одной командой (CLI-11) — на настоящем прогоне.
 *
 * Проверяется здесь то, чего не проверяет ни один тест пакета: что команда
 * действительно САМОДОСТАТОЧНА — боты занимают слоты сами, матч кончается сам,
 * а на диске остаётся полный набор артефактов. Утверждение это про процесс, а не
 * про модуль, и держаться на ручном прогоне оно не может: сорваться ему есть на
 * чём (порядок закрытия трейса, отказ шага, флаг, который молча не сработал), а
 * заметить срыв без чтения каталога нельзя.
 *
 * Прогон запускается подпроцессом — как его запускает человек (`npm run
 * demo:debug`), и с тем же интерпретатором (`process.execPath`). Чтение дерева
 * контента законно: это тест ИГРЫ (CONT-1).
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Матч в 300 тиков (5 с при 60 Гц): короче — и боты не успевают ни разу выстрелить. */
const MAX_TICKS = 300;
const STAND = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'demo-serve.mjs');

/** Свободный порт у системы: фиксированный номер занял бы соседний прогон. */
function freePort(): number {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  probe.close();
  return port;
}

interface RunSummary {
  readonly ticks: number;
  readonly phase: string;
  readonly record?: string;
  readonly journal?: { readonly facts: number; readonly unknownTypes: readonly string[] };
  readonly trace?: { readonly path: string; readonly failure?: string };
  readonly failed?: Readonly<Record<string, string>>;
}

describe('CLI-11: отладочный прогон матча одной командой', () => {
  let dir: string;
  let stdout: string;
  let status: number | null;
  let summary: RunSummary;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-debug-'));
    const run = spawnSync(
      process.execPath,
      [STAND, '--debug', '--port', String(freePort()), '--max-ticks', String(MAX_TICKS), '--out-dir', dir],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 120_000 },
    );
    status = run.status;
    stdout = run.stdout;
    summary = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunSummary;
  }, 150_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('матч заканчивается САМ и без человека за клавиатурой', () => {
    // Ни второго процесса, ни Ctrl+C: команда вышла нулевым кодом сама.
    expect(status, stdout.slice(-400)).toBe(0);
    expect(summary.phase).toBe('ended');
    expect(summary.ticks).toBeGreaterThanOrEqual(MAX_TICKS);
  });

  it('на диске лежат все четыре артефакта', () => {
    for (const name of ['trace.jsonl', 'match.scenario.json', 'journal.jsonl', 'run.json']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
      expect(statSync(join(dir, name)).size, name).toBeGreaterThan(0);
    }
    // Запись лежит РЯДОМ с трейсом (DIAG-9): без неё трейс невоспроизводим.
    expect(summary.record).toBe('match.scenario.json');
    expect(summary.trace?.path).toBe('trace.jsonl');
    expect(summary.trace?.failure).toBeUndefined();
    expect(summary.failed).toBeUndefined();
  });

  it('журнал боя собран, и незнакомых словарю типов в нём нет (DIAG-10)', () => {
    // Событие, которого словарь не знает, — не отказ прогона, а отставший
    // словарь; здесь он обязан быть не отставшим: сцена и словарь едут вместе.
    expect(summary.journal?.unknownTypes).toEqual([]);
    expect(summary.journal?.facts).toBeGreaterThan(0);
  });

  it('данных окружения нет ни в одном артефакте (CLI-11)', () => {
    // Два прогона одной записи обязаны сравниваться `diff`'ом, и строка со
    // временем красила бы их целиком — по тому же основанию, по которому её нет
    // в записи диагностики (DIAG-2).
    for (const name of ['trace.jsonl', 'match.scenario.json', 'journal.jsonl', 'run.json']) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, `${name}: отметка времени ISO`).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      // Миллисекунды эпохи — тринадцатизначное число: ни тик, ни Q16.16-величина
      // такой длины в этих документах не бывает.
      expect(text, `${name}: миллисекунды эпохи`).not.toMatch(/(^|[^\d.])\d{13}([^\d]|$)/);
      for (const word of ['pid', 'timestamp', 'hostname', 'Date', 'startedAt', 'finishedAt']) {
        expect(text, `${name}: поле "${word}"`).not.toContain(`"${word}"`);
      }
      // Путь машины внутри артефакта — тоже данные окружения: сводка называет
      // артефакты относительными именами.
      expect(text, `${name}: абсолютный путь каталога прогона`).not.toContain(dir);
    }
  });

  it('трейс несёт только записи диагностики и отметки ветви (DIAG-9)', () => {
    const lines = readFileSync(join(dir, 'trace.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(0);
    let marks = 0;
    for (const line of lines) {
      const value = JSON.parse(line) as Record<string, unknown>;
      if ('mark' in value) {
        marks++;
        // Отметка отличима по признаку и данных окружения не несёт.
        expect(Object.keys(value).sort()).toEqual(['epoch', 'mark', 'tick']);
        continue;
      }
      expect(value).toHaveProperty('seq');
      expect(value).toHaveProperty('code');
    }
    expect(marks).toBeGreaterThan(0);
  });

  it('собственный отчёт запускалки идёт потоком, отдельным от трейса', () => {
    // Трейс уехал в файл, а отчёт — в stdout; проверяется, что отчёт не пуст и
    // строк трейса в нём нет (CLI-11): артефакт со строками постороннего
    // происхождения разбирается человеком, а не программой.
    expect(stdout).toContain('артефакты прогона');
    expect(stdout).not.toContain('"seq"');
  });
});
