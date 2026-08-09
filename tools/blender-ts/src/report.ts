/**
 * Как импорт рассказывает о себе человеку: находки разбора (BLND-3, BLND-6) и
 * находки валидации результата (ED-8, ED-21).
 *
 * Отдельный модуль, потому что рассказчиков теперь два — разовый запуск
 * (`cli.ts`) и watch-цикл (`watch.ts`), — а формат сообщения обязан быть один.
 * Разойдись он, и автор читал бы про один и тот же объект Blender двумя
 * разными строками в зависимости от того, каким способом он запустил импорт.
 *
 * Строк интерфейса здесь нет: текст находки принадлежит правилу и приходит из
 * ресурсов (ED-27, ED-28), а этот модуль только ставит его в строку вывода.
 */
import { StringResources, formatIssue, type ValidationIssue } from '@game-mvp/editor-core';
import { BLENDER_BUNDLES } from './i18n.js';
import type { ImportResult } from './importer.js';
import type { Finding } from './layer.js';

/** Куда пишет инструмент: машинный JSON — в `out`, отчёт человеку — в `err`. */
export interface ReportIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export function importResources(locale: string): StringResources {
  return new StringResources({ locale, editor: BLENDER_BUNDLES });
}

/**
 * Находка разбора источника. Адрес — имя объекта Blender: ровно то, что автор
 * видит в outliner'е и по чему находит правку (BLND-6).
 */
export function formatFinding(finding: Finding): string {
  return `  ${finding.severity === 'error' ? 'ошибка' : 'предупреждение'} — ${finding.object}: ${finding.message}`;
}

/** Находка валидации: та же строка ресурса, что увидел бы автор в редакторе (ED-28). */
export function formatBlocking(issue: ValidationIssue, resources: StringResources): string {
  return `  ${issue.documentId}: ${formatIssue(issue, resources)}`;
}

/** Весь отчёт об одном импорте: сперва источник, потом результат его записи. */
export function reportFindings(
  result: ImportResult,
  err: (text: string) => void,
  resources: StringResources,
): void {
  for (const finding of result.findings) err(formatFinding(finding));
  for (const issue of result.blocking) err(formatBlocking(issue, resources));
}
