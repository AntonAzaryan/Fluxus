/**
 * Все строки JSON-данных одним множеством.
 *
 * Нужно проверке ED-27: видимый автору текст — либо строка ресурса с ключом,
 * либо содержимое открытого документа, и второе тест отличает от подписи,
 * притворившейся значением, тем, что ищет его в самих данных. Собирается
 * обходом, а не перечислением: перечень разошёлся бы с данными на первой же
 * правке.
 *
 * Живёт в слое ресурсов, а не рядом с одним из наборов данных, потому что
 * наборов уже два — контрольный случай визуального языка и материал-заглушка
 * рабочих областей, — и оба проверяются одним и тем же способом.
 */

export function jsonStrings(value: unknown, into: Set<string> = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) jsonStrings(item, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) jsonStrings(item, into);
  }
  return into;
}
