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
import type { DiagnosticRecord, DiagnosticsSink, TraceLevel } from '../types.js';

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
