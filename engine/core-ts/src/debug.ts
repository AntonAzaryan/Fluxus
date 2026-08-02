/**
 * Debug-сборка (FP-4): статически подставляемое бандлером условие, а не рантайм-флаг.
 * В релизе `DEBUG === false`, и все ветки с assert вырезаются минификатором.
 */
export const DEBUG: boolean =
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Диагностика, не влияющая на результат расчёта: в релизе не вызывается вовсе. */
export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
