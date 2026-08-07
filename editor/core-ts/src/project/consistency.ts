/**
 * Каркасная половина проверки согласованности на сохранении (ED-21).
 *
 * Здесь — только форма: что такое «расхождение», что видит правило и что такое
 * «группа документов, уходящих на диск вместе». Ни одного имени редактируемого
 * в этом файле нет намеренно (ED-25): какие документы образуют группу и что
 * значит их рассинхронизация — знание вклада, и живёт оно в файле, помеченном
 * `@contribution`.
 *
 * Правило — чистая функция от состояния дерева: ему дают то, что будет лежать
 * на диске после сохранения, и оно называет расхождения. Блокирует запись не
 * правило, а сохранение (`save.ts`): оно сверяет состояние «до» и «после» и
 * отвергает только то, что вносит само. Основание — ED-21 запрещает записать
 * рассинхронизацию, но не делает редактор строже нормы там, где расхождение уже
 * лежит на диске и его подсвечивает валидация (ED-8).
 */
import type { JsonPath, JsonValue } from '../document/json.js';
import type { DocumentId } from '../document/types.js';

/**
 * Найденное расхождение. Структурно, а не текстом (ED-30): адрес — документ и
 * путь, текст — ключ строкового ресурса (ED-27), подстановки — идентификаторы,
 * которые не локализуются.
 */
export interface ConsistencyIssue {
  readonly ruleId: string;
  readonly messageKey: string;
  readonly documentId?: DocumentId;
  readonly path?: JsonPath;
  readonly detail?: Readonly<Record<string, string>>;
}

/** Состояние дерева глазами правила: какие документы есть и что в них будет лежать. */
export interface ProjectView {
  readonly documentIds: readonly DocumentId[];
  value(id: DocumentId): JsonValue | undefined;
}

export interface ConsistencyRule {
  readonly id: string;
  check(view: ProjectView): readonly ConsistencyIssue[];
}

/**
 * Документы, чьи правки обязаны уходить на диск одной записью. Понятие
 * каркасное и от формата документов группы не зависит вовсе — именно поэтому
 * оно распространяется и на документ, формата которого ещё нет.
 */
export interface DocumentGroup {
  readonly id: string;
  readonly members: readonly DocumentId[];
}

/** Ключ тождества расхождения — по нему сохранение отличает внесённое от бывшего до него. */
export function issueKey(issue: ConsistencyIssue): string {
  const detail = Object.entries(issue.detail ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  const path = (issue.path ?? []).join('/');
  return `${issue.ruleId} ${issue.messageKey} ${issue.documentId ?? ''} ${path} ${detail}`;
}
