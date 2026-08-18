/**
 * Флаги трейса матча для запускалок (CLI-11) — одно место на все стенды.
 *
 * Одно, потому что уровень, отбор и путь вывода принимаются «тем же образом,
 * каким их принимает CLI прогона сценария» (CLI-11): разойдись запускалки в
 * разборе флагов, и один и тот же `--trace-select` означал бы в двух стендах
 * разное. Здесь же живёт файловый писатель: ввод-вывод — дело запускалки, а не
 * `MatchServer` (NTR-3) и не ядра (DIAG-1).
 *
 * ## Объём (замер: отладочный прогон демо-арены, 600 тиков = 10 с, два бота)
 *
 * - `--trace=full` — 9,2 МиБ и ~60 тыс. строк за прогон, то есть ~55 МиБ и
 *   ~360 тыс. строк на минуту боя;
 * - `--trace=systems` — примерно вчетверо меньше (счётчики систем без потока
 *   команд): порядка 13 МиБ на минуту боя;
 * - `--trace=full --trace-select=event` — 52 КиБ и 325 строк за тот же прогон,
 *   то есть ~310 КиБ на минуту боя: в 180 раз меньше полного.
 *
 * Отсюда рабочий режим журнальных прогонов: полный уровень нужен ради событий
 * (они едут только там, DIAG-3), а отбор возвращает файлу читаемый размер.
 * Четвёртым уровнем детализации отбор становиться MUST NOT (DIAG-9).
 */
import { closeSync, openSync, writeSync } from 'node:fs';
// Статически — только помощник запускалок: он же ставит хук резолва
// (`tsHook.mjs`). Типизированные модули приезжают динамическим импортом ПОСЛЕ
// его установки: статический граф резолвится целиком до первой строки кода, и
// хук на него уже не влияет — тот же приём, что в `serve.mjs`.
import { flag, option } from './matchFile.mjs';

const { DIAGNOSTIC_CODES, TRACE_LEVELS } = await import('@game-mvp/core');
const { createMatchTrace } = await import('../src/match/trace.ts');

/** Виды записей диагностики (DIAG-2) — вторая половина словаря отбора. */
const KINDS = ['assert', 'invariant', 'systemBegin', 'systemEnd', 'command', 'event', 'tickCost'];

/** Порог сброса буфера писателя: строки трейса мелкие, а их сотни тысяч. */
const FLUSH_BYTES = 64 * 1024;

export const TRACE_USAGE =
  '[--trace=off|systems|full] [--trace-select=<вид|код>,...] [--trace-out <path>]';

/**
 * Отбор записей (DIAG-9) — чистая функция от записи: перечисленные виды и коды.
 * Незнакомое имя — отказ, а не пустой трейс: файл без единой строки выглядит
 * как «в бою ничего не происходило», а это самый дорогой способ ошибиться.
 */
export function parseTraceSelect(spec) {
  if (spec === undefined || spec === '') return undefined;
  const names = spec.split(',').map((name) => name.trim()).filter((name) => name !== '');
  if (names.length === 0) return undefined;
  for (const name of names) {
    if (!KINDS.includes(name) && !DIAGNOSTIC_CODES.includes(name)) {
      throw new Error(
        `--trace-select: неизвестное имя "${name}"; виды: ${KINDS.join(', ')}; коды: ${DIAGNOSTIC_CODES.join(', ')}`,
      );
    }
  }
  const wanted = new Set(names);
  return (entry) => wanted.has(entry.kind) || wanted.has(entry.code);
}

/**
 * Буферизованный писатель строк. Файл создаётся пустым: дописывание в остаток
 * прошлого прогона склеило бы два трейса, которые сравнивают построчно (DIAG-6).
 */
export function fileLineWriter(path) {
  const fd = openSync(path, 'w');
  let buffer = '';
  let closed = false;
  return {
    write(line) {
      if (closed) return;
      buffer += line;
      if (buffer.length >= FLUSH_BYTES) {
        writeSync(fd, buffer);
        buffer = '';
      }
    },
    // Идемпотентно: закрыть трейс может и конец прогона, и сигнал остановки, а
    // второе закрытие того же дескриптора — ошибка на ровном месте.
    close() {
      if (closed) return;
      closed = true;
      if (buffer !== '') writeSync(fd, buffer);
      buffer = '';
      closeSync(fd);
    },
  };
}

/**
 * Разбор флагов трейса из `process.argv`. Умолчание — выключенный трейс: с ним
 * прогон обязан быть тем же, каким был до появления отладочного режима (CLI-11).
 */
export function traceOptions(defaults = {}) {
  const level = option('trace', flag('trace') ? 'full' : (defaults.level ?? 'off'));
  if (!TRACE_LEVELS.includes(level)) {
    throw new Error(`--trace: неизвестный уровень "${level}"; известные: ${TRACE_LEVELS.join(', ')}`);
  }
  return {
    level,
    select: parseTraceSelect(option('trace-select', defaults.select)),
    out: option('trace-out', defaults.out),
  };
}

/**
 * Трейс матча по разобранным флагам; `undefined` — трейс выключен.
 *
 * Вывод по умолчанию — stderr: свой отчёт запускалки (соединения, слоты,
 * счётчики) идёт в stdout, и смешивать их нельзя (CLI-11) — артефакт со
 * строками постороннего происхождения разбирается человеком, а не программой.
 */
export function openMatchTrace(options) {
  if (options.level === 'off') return undefined;
  const writer =
    options.out === undefined
      ? { write: (line) => process.stderr.write(line), close: () => {} }
      : fileLineWriter(options.out);
  const trace = createMatchTrace(options.level, options.select, writer.write);
  return { trace, close: () => writer.close() };
}
