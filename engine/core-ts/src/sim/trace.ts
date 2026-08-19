/**
 * Приёмник трейса, укладывающий записи построчно (CLI-7): одна запись — одна
 * самостоятельная строка. Прогон, оборванный жёсткой границей (FP-4), обязан
 * оставлять уже выведенное читаемым, а незакрытый JSON-массив не парсится
 * целиком — именно в той аварии, ради которой трейс включали.
 *
 * Ввода-вывода здесь нет: запись строки — инъектируемая функция, у ядра
 * по-прежнему ноль зависимостей. Куда она пишет — stderr, файл или буфер в
 * тесте — решает хост.
 */
import { canonicalJson } from './canonicalJson.js';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_KINDS } from '../types.js';
import type { DiagnosticRecord, DiagnosticsSink, TraceLevel, TraceSelect } from '../types.js';

/**
 * Ключи сортируются каноническим порядком (SER-6): трейс — воспроизводимый
 * артефакт (DIAG-6), и построчное сравнение двух прогонов не должно зависеть
 * от порядка вставки полей.
 */
export function traceLine(entry: DiagnosticRecord): string {
  return canonicalJson(entry);
}

export function createJsonlSink(trace: TraceLevel, write: (line: string) => void): DiagnosticsSink {
  return {
    trace,
    record(entry) {
      write(`${traceLine(entry)}\n`);
    },
  };
}

/**
 * Запись о нарушенном инварианте (FP-4). Отбор её не выбрасывает никогда
 * (DIAG-9): DIAG-3 уже вывела такие записи из-под регулятора объёма, и sink,
 * глушащий сигнал о дефекте ради размера файла, отменял бы это решение задним
 * числом.
 */
function isInvariantRecord(entry: DiagnosticRecord): boolean {
  return entry.kind === 'invariant' || entry.kind === 'assert';
}

/**
 * Отбор записей (DIAG-9) поверх готового приёмника: в `sink` уходит только то,
 * что пропустил предикат, плюс записи о нарушенных инвариантах — их отбор не
 * выбрасывает никогда.
 *
 * Одна реализация на всех: отбирают оба хоста — прогонщик сценария (`bin/sim.mjs`,
 * CLI-7) и хост матча в сетевом слое (DIAG-8), — и «тот же отбор» в требовании
 * CLI-11 обязан означать ту же функцию, а не два похожих условия.
 * `undefined` — отбора нет: приёмник возвращается как есть, лишней обёртки на
 * горячем пути тика не появляется.
 */
export function selectingSink(sink: DiagnosticsSink, select: TraceSelect | undefined): DiagnosticsSink {
  if (select === undefined) return sink;
  return {
    trace: sink.trace,
    record(entry) {
      if (!select(entry) && !isInvariantRecord(entry)) return;
      sink.record(entry);
    },
  };
}

/**
 * Словарь отбора (DIAG-9): виды записей плюс их стабильные коды (DIAG-2). Оба
 * перечня — рантайм-значения ядра, поэтому новый вид или новый код становится
 * допустимым именем сам, без правки запускалок. Наружу словарь не публикуется:
 * обе его половины уже в поверхности по отдельности, а третье имя рядом с ними
 * было бы ещё одним местом, где перечень может отстать.
 */
const SELECT_NAMES: readonly string[] = [...DIAGNOSTIC_KINDS, ...DIAGNOSTIC_CODES];

/**
 * Разбор строки отбора — `<вид|код>,...` — в предикат (DIAG-9).
 *
 * Живёт в ядре, потому что отбирают ОБА хоста: прогон сценария (`bin/sim.mjs`,
 * CLI-7) и запускалка матча (CLI-11, «тем же образом, каким их принимает CLI
 * прогона сценария»). Разойдись разбор, и одна и та же строка означала бы в двух
 * командах разное — при том, что трейс матча переснимается прогоном его записи.
 *
 * Незнакомое имя — отказ, а не пустой трейс: файл без единой строки выглядит
 * как «в бою ничего не происходило», а это самый дорогой способ ошибиться.
 * Пустое значение означает «отбора нет» — полный поток, а не предикат, не
 * пропускающий ничего.
 */
export function parseTraceSelect(spec: string | undefined): TraceSelect | undefined {
  if (spec === undefined || spec === '') return undefined;
  const names = spec
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) return undefined;
  for (const name of names) {
    if (!SELECT_NAMES.includes(name)) {
      throw new Error(
        `отбор записей трейса: неизвестное имя "${name}"; ` +
          `виды: ${DIAGNOSTIC_KINDS.join(', ')}; коды: ${DIAGNOSTIC_CODES.join(', ')}`,
      );
    }
  }
  const wanted = new Set(names);
  return (entry) => wanted.has(entry.kind) || wanted.has(entry.code);
}
