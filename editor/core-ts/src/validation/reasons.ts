/**
 * Ключи строковых ресурсов слоя валидации (ED-27, ED-28) — единственная точка
 * их вывода.
 *
 * Причина находки приходит ключом, а не готовой фразой: результат уходит и в
 * интерфейс, и машинному потребителю (ED-30), а локаль на то, что он получает,
 * влиять не должна. Ключ выводится из пары «правило + код причины», поэтому
 * таблицы «находка → ключ» не существует — ровно по той причине, по которой
 * ED-28 запрещает её для полей: таблица расходится с реальностью на первом же
 * переименовании, и расхождения никто не замечает.
 *
 * Пространство ключей — `validation.*`, рядом с `operation.*` слоя операций и
 * вне пространства описаний полей (`component.`, `schema.`, …): иначе каждая
 * причина числилась бы осиротевшим ключом в отчёте ED-28.
 */
import { formatPath } from '../document/index.js';
import type { TextSource } from '../i18n/index.js';
import type { ValidationIssue } from './types.js';

/** Ключ описания самого правила — то, чем вклад объяснён человеку и каталогу. */
export const RULE_DESCRIPTION_PREFIX = 'validation.rule';

/** Ключи причин. */
export const REASON_PREFIX = 'validation.reason';

export function ruleDescriptionKey(ruleId: string): string {
  if (ruleId === '') throw new Error('ключ описания правила: пустой id');
  return `${RULE_DESCRIPTION_PREFIX}.${ruleId}`;
}

export function reasonKey(ruleId: string, code: string): string {
  if (ruleId === '' || code === '') throw new Error('ключ причины: пустой id правила или код');
  return `${REASON_PREFIX}.${ruleId}.${code}`;
}

/**
 * Подстановка `{имя}` из параметров находки. Плюс два имени, которые есть у
 * любой находки и которых поэтому нет в её параметрах: `{path}` и `{received}`.
 *
 * Отсутствие ресурса даёт сам ключ (ED-28): пустая подсказка запрещена, а
 * видимый ключ — признак того, что строку не завели. Разобранные поля находки
 * при этом на месте, и внешний потребитель чинит нарушение по ним, а не по
 * тексту (ED-30).
 */
export function formatIssue(issue: ValidationIssue, resources: TextSource): string {
  const template = resources.text(issue.reasonKey);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => {
    const value = issue.reasonParams[name];
    if (value !== undefined) return String(value);
    if (name === 'path') return `${issue.documentId}:${formatPath(issue.path)}`;
    if (name === 'received') return issue.received === undefined ? '—' : JSON.stringify(issue.received);
    return whole;
  });
}
