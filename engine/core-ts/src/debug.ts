/**
 * Debug-сборка (FP-4): статически подставляемое бандлером условие, а не рантайм-флаг.
 * В релизе `DEBUG === false`, и все ветки с assert вырезаются минификатором.
 */
export const DEBUG: boolean =
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Диагностика ассертов (FP-4): подключаемый sink, по умолчанию no-op — тихо в тестах и в релизе. */
export type AssertSink = (message: string) => void;

let sink: AssertSink = () => {};

/** Подменяет получателя диагностики мягкого `assert` (например, тестовый шпион или логгер на хосте). */
export function setAssertSink(fn: AssertSink): void {
  sink = fn;
}

/**
 * Мягкая диагностика (FP-4): при нарушении условия НЕ бросает исключение и не влияет на
 * результат вызвавшей операции — сообщение уходит только в sink. Одинаково в debug и release.
 * Вызывающий код сам решает, звать ли её под `if (DEBUG)` (обычно да — не платить за вызов в release).
 */
export function assert(condition: boolean, message: string): void {
  if (!condition) sink(`assertion failed: ${message}`);
}

/**
 * Жёсткая граница (FP-4/ID-1): бросает исключение в ОБОИХ режимах сборки. Только для мест,
 * где нарушение не имеет детерминированного продолжения (рождение EntityId, аллокация и т.п.).
 */
export function assertInvariant(condition: boolean, message: string): void {
  if (!condition) throw new Error(`invariant violated: ${message}`);
}
