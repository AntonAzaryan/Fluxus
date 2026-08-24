/**
 * Слой запускалок (CLI-11): разбор флагов трейса, словарь отбора и файловый
 * писатель.
 *
 * Проверять его тестом, а не ручным прогоном, приходится ровно потому, что
 * ошибка здесь не видна: флаг, который молча не сработал, даёт не отказ, а
 * прогон, делающий не то, что написано в команде, — трейс без отбора, трейс,
 * который не выключился, трейс, оборвавшийся вместе со всем набором артефактов.
 * Ни одно из этих положений дел не отличимо от нормального без чтения файлов.
 *
 * `process.argv` подменяется прямо здесь: разбор флагов на то и разбор, что его
 * вход — командная строка, и подмена входа честнее второго API «для тестов».
 */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DiagnosticRecord } from '@fluxus/core';
import {
  fileLineWriter,
  guardedLineWriter,
  openMatchTrace,
  parseTraceSelect,
  traceOptions,
  TRACE_USAGE,
  TRACE_WITHOUT_RECORD,
} from '../bin/trace.mjs';

const ORIGINAL_ARGV = process.argv;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'trace-cli-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
});

/** Аргументы прогона так, как их видит запускалка: `node <бин> <флаги>`. */
function argv(...args: readonly string[]): void {
  process.argv = ['node', 'bin/serve.mjs', ...args];
}

function record(overrides: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return { tick: 1, seq: 0, kind: 'event', level: 'info', code: 'EVENT', ...overrides };
}

describe('CLI-11: флаг принимается обеими формами', () => {
  it('уровень трейса — и `--trace=full`, и `--trace full`, и голый `--trace`', () => {
    argv('--trace=full');
    expect(traceOptions().level).toBe('full');
    argv('--trace', 'full');
    expect(traceOptions().level).toBe('full');
    argv('--trace');
    expect(traceOptions().level).toBe('full');
  });

  it('`--trace=off` выключает трейс поверх умолчания отладочного прогона', () => {
    // Стенд подаёт `{ level: 'full' }` умолчанием (`--debug`), и без этой ветки
    // пользователь не мог бы выключить трейс вовсе: флаг молча не срабатывал бы,
    // а файл продолжал писаться.
    argv('--trace=off');
    expect(traceOptions({ level: 'full' }).level).toBe('off');
    argv('--trace', 'off');
    expect(traceOptions({ level: 'full' }).level).toBe('off');
  });

  it('отбор и путь вывода — тоже обе формы, и `--trace-select` не путается с `--trace`', () => {
    argv('--trace=full', '--trace-select=event', '--trace-out=/tmp/a.jsonl');
    const equals = traceOptions();
    expect(equals.level).toBe('full');
    expect(equals.out).toBe('/tmp/a.jsonl');
    expect(equals.select?.(record())).toBe(true);
    expect(equals.select?.(record({ kind: 'command', code: 'COMMAND' }))).toBe(false);

    argv('--trace', 'full', '--trace-select', 'event', '--trace-out', '/tmp/b.jsonl');
    const spaced = traceOptions();
    expect(spaced.level).toBe('full');
    expect(spaced.out).toBe('/tmp/b.jsonl');
    expect(spaced.select?.(record())).toBe(true);
  });

  it('умолчание — выключенный трейс: прогон тот же, каким был до отладочного режима', () => {
    argv();
    expect(traceOptions()).toEqual({ level: 'off', select: undefined, out: undefined });
    expect(openMatchTrace(traceOptions())).toBeUndefined();
  });

  it('неизвестный уровень — отказ, а не молчаливое умолчание', () => {
    argv('--trace=verbose');
    expect(() => traceOptions()).toThrow(/неизвестный уровень/);
  });

  it('обе формы названы в usage — иначе печаталась бы неработающая', () => {
    expect(TRACE_USAGE).toContain('--trace=off|systems|full');
    expect(TRACE_USAGE).toContain('--trace-select=');
    expect(TRACE_USAGE).toContain('--trace-out=');
  });
});

describe('DIAG-9: словарь отбора — один на команду сценария и запускалку матча', () => {
  it('пустое значение означает «отбора нет», а не «не пропускать ничего»', () => {
    expect(parseTraceSelect(undefined)).toBeUndefined();
    expect(parseTraceSelect('')).toBeUndefined();
    expect(parseTraceSelect(' , ')).toBeUndefined();
  });

  it('имена берутся из видов записей и из кодов (DIAG-2)', () => {
    const byKind = parseTraceSelect('event,tickCost')!;
    expect(byKind(record())).toBe(true);
    expect(byKind(record({ kind: 'tickCost', code: 'TICK_COST' }))).toBe(true);
    expect(byKind(record({ kind: 'command', code: 'COMMAND' }))).toBe(false);

    const byCode = parseTraceSelect('SYSTEM_BEGIN')!;
    expect(byCode(record({ kind: 'systemBegin', code: 'SYSTEM_BEGIN' }))).toBe(true);
    expect(byCode(record())).toBe(false);
  });

  it('пробелы вокруг имён не значимы: список набирают руками', () => {
    const select = parseTraceSelect(' event , command ')!;
    expect(select(record())).toBe(true);
    expect(select(record({ kind: 'command', code: 'COMMAND' }))).toBe(true);
  });

  it('незнакомое имя — отказ, а не пустой трейс', () => {
    // Пустой файл читается как «в бою ничего не происходило» — самый дорогой
    // способ ошибиться, и потому отбор об опечатке говорит вслух.
    expect(() => parseTraceSelect('events')).toThrow(/неизвестное имя "events"/);
  });

  it('отбор доезжает до файла, а запись о нарушенном инварианте проходит сквозь него (FP-4)', () => {
    const path = join(dir, 'selected.jsonl');
    argv('--trace=systems', '--trace-select=event', '--trace-out', path);
    const opened = openMatchTrace(traceOptions())!;
    opened.trace.sink.record(record());
    opened.trace.sink.record(record({ kind: 'command', code: 'COMMAND' }));
    opened.trace.sink.record(record({ kind: 'invariant', level: 'error', code: 'FIXED_OVERFLOW' }));
    opened.close();
    const codes = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as DiagnosticRecord).code);
    expect(codes).toEqual(['EVENT', 'FIXED_OVERFLOW']);
    expect(opened.failure).toBeUndefined();
  });
});

describe('DIAG-8: отказ записи гасит трейс, а не прогон', () => {
  it('писатель ловит ошибку сам, помнит ПЕРВУЮ и больше не пишет', () => {
    let calls = 0;
    const writer = guardedLineWriter(
      () => {
        calls++;
        throw new Error(`отказ ${calls}`);
      },
      () => {},
    );
    writer.write('раз\n');
    writer.write('два\n');
    expect(calls).toBe(1);
    expect(writer.failure).toBe('отказ 1');
  });

  it('закрытие после отказа не бросает и не теряет первую ошибку', () => {
    const writer = guardedLineWriter(
      () => {
        throw new Error('нет места на диске');
      },
      () => {
        throw new Error('и закрыть не вышло');
      },
    );
    writer.write('строка\n');
    expect(() => { writer.close(); }).not.toThrow();
    expect(writer.failure).toBe('нет места на диске');
  });

  it('отказ ТОЛЬКО на сбросе хвоста тоже назван, а не унесён исключением', () => {
    // Тот самый случай: строки уместились в буфер, а упало закрытие — то есть
    // отказ приходит на сворачивание прогона, где исключение унесло бы с собой
    // все остальные артефакты (CLI-11).
    const writer = guardedLineWriter(
      () => {},
      () => {
        throw new Error('ENOSPC: no space left on device, write');
      },
    );
    writer.write('строка\n');
    expect(writer.failure).toBeUndefined();
    expect(() => { writer.close(); }).not.toThrow();
    expect(writer.failure).toContain('ENOSPC');
  });

  it('второе закрытие — не ошибка на ровном месте, и после него писатель молчит', () => {
    let finished = 0;
    let written = 0;
    const writer = guardedLineWriter(
      () => {
        written++;
      },
      () => {
        finished++;
      },
    );
    writer.close();
    writer.close();
    writer.write('поздняя\n');
    expect(finished).toBe(1);
    expect(written).toBe(0);
  });
});

describe('CLI-11: файловый писатель', () => {
  it('хвост буфера дописывается закрытием, а прогон начинается с пустого файла', () => {
    const path = join(dir, 'trace.jsonl');
    // Остаток прошлого прогона обязан исчезнуть: склеенные трейсы сравнивают
    // построчно (DIAG-6).
    const stale = openSync(path, 'w');
    writeSync(stale, 'мусор прошлого прогона\n');
    closeSync(stale);

    const writer = fileLineWriter(path);
    writer.write('{"a":1}\n');
    writer.write('{"a":2}\n');
    writer.close();
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
    expect(writer.failure).toBeUndefined();
  });

  // `/dev/full` — единственный портативный способ получить настоящий ENOSPC; на
  // системе без него проверка пропускается, а контракт держат тесты выше.
  it.skipIf(!existsSync('/dev/full'))('настоящий ENOSPC назван полем failure, наружу не летит', () => {
    const writer = fileLineWriter('/dev/full');
    // Строки мелкие — до порога сброса они лежат в буфере, и отказ приходит
    // ровно на закрытии.
    writer.write('{"a":1}\n');
    expect(() => { writer.close(); }).not.toThrow();
    expect(writer.failure).toContain('ENOSPC');
  });
});

describe('CLI-11: трейс без записи назван причиной', () => {
  it('текст предупреждения один на все запускалки', () => {
    // Один, потому что одно и то же положение дел не должно читаться в двух
    // стендах как два разных (DIAG-9).
    expect(TRACE_WITHOUT_RECORD).toContain('DIAG-9');
    expect(TRACE_WITHOUT_RECORD).toContain('трейс снимается без записи матча');
  });
});
