/**
 * Канонический JSON — общий байтовый канон хешей движка: `worldInit` (DET-1) и
 * контент-пака (NET-17). Отдельным модулем, а не копией в каждом: два канона
 * разъедутся на первой же правке одного из них, и хеши, обязанные считаться
 * одинаково, тихо перестанут.
 */

/**
 * JSON без незначащих пробелов, ключи каждого уровня отсортированы (SER-6),
 * порядок элементов массивов сохранён.
 *
 * Сортировка делается здесь, а не полагается на порядок вставки: плоская форма
 * мира строится отсортированной, но норма говорит про поток байт, и зависеть
 * от чужого порядка вставки он не должен. Массивы не сортируются намеренно —
 * порядок объявления компонентов задаёт их битовые id (SER-7), порядок систем
 * нормирован (DET-3).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  // Все числовые значения ядра целые: Q16.16 хранится как i32 (FP-1), поэтому
  // вопроса дробной записи не возникает.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
  return JSON.stringify(value) ?? 'null';
}
