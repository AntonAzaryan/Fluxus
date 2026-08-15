/**
 * «Сказать один раз» — общий приём рендера на негодные данные документа
 * (ASSET-8, REND-23, REND-24): неизвестный примитив, состояние вне списка
 * `stateComponents`, недоехавший ассет. Кадр из-за них не отказывает, но и
 * молчать о них нельзя — а повторять на каждый кадр значило бы утопить консоль.
 *
 * Ключ — то, о чём говорится (имя примитива, состояния, ассета), а не текст:
 * одно и то же явление под разными формулировками остаётся одним.
 */

/** Канал предупреждений и память сказанного; канал не задан — `console.warn`. */
export function createWarnOnce(
  warn: ((message: string) => void) | undefined,
): (key: string, message: string) => void {
  const sink = warn ?? ((message: string): void => { console.warn(message); });
  const warned = new Set<string>();
  return (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    sink(message);
  };
}
