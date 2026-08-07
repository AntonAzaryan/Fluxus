/**
 * Двусторонний отчёт о рассогласовании ресурсов описаний (ED-28).
 *
 * Сторон именно две. Проверка «у каждого поля есть описание» ловит
 * недокументированное поле, но оставляет бандл зарастать ключами, про которые
 * неизвестно, живые они или остались от прежнего имени поля; проверка «у
 * каждого ресурса есть поле» — наоборот. Переименование поля схемы даёт обе
 * записи сразу: недокументированное поле под новым путём и осиротевший ключ
 * под прежним, — и именно по паре записей видно, что произошло переименование,
 * а не удаление и добавление.
 */
import { descriptionKey, isDescriptionKey, type SchemaPath } from './keys.js';

export interface ResourceReport {
  /** Ключи путей схемы, для которых ресурса нет: недокументированные поля. */
  readonly undocumented: readonly string[];
  /** Ключи ресурсов в пространстве описаний, которым не соответствует ни один путь схемы. */
  readonly orphaned: readonly string[];
}

/**
 * Обе стороны — на множествах ключей, а не на бандлах: сведением бандлов
 * локали и проекта занимается `StringResources`, отчёту достаточно того, что
 * из этого сведения получилось. Ключи вне пространства описаний (хром
 * редактора) отчёт не рассматривает — их путей схемы не бывает по определению.
 */
export function reportResources(
  paths: Iterable<SchemaPath>,
  keys: Iterable<string>,
): ResourceReport {
  const expected = new Set<string>();
  for (const path of paths) expected.add(descriptionKey(path));
  const present = new Set(keys);

  const undocumented = [...expected].filter((key) => !present.has(key)).sort();
  const orphaned = [...present].filter((key) => isDescriptionKey(key) && !expected.has(key)).sort();
  return { undocumented, orphaned };
}

/** Пустой отчёт — ресурсы и схемы сходятся в обе стороны. */
export function isReportEmpty(report: ResourceReport): boolean {
  return report.undocumented.length === 0 && report.orphaned.length === 0;
}
