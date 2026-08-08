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
 *
 * ## Ключ — тот же ключ, что у описания поля
 *
 * Оба ключа собираются `descriptionKey` слоя локалей, а не своей конкатенацией,
 * и это не косметика. Отчёт ED-28 двусторонний и работает на путях схемы: без
 * общего вывода пространство `validation.*` осталось бы вне его обеих сторон —
 * недокументированное правило и осиротевшая причина не обнаруживались бы ничем.
 * Вид пути один на всё пространство (`validation`), сегменты — `rule`/`reason`,
 * затем id правила и код причины по частям. Точка внутри id (`core.scene`) —
 * разделитель сегментов, а не символ имени, поэтому ключ выходит тот же, что
 * давала прежняя конкатенация: ни одна уже показанная строка не переехала.
 */
import { formatPath } from '../document/index.js';
import { descriptionKey, schemaPathOf, type SchemaPath, type TextSource } from '../i18n/index.js';
import type { RuleReasons, ValidationIssue } from './types.js';

/**
 * Вид описываемого для всего слоя валидации. Один на правила и причины: вид —
 * первая сторона отчёта ED-28, и разными видами они разошлись бы по двум
 * несвязанным отчётам, хотя мнёт их одно и то же переименование правила.
 */
export const VALIDATION_KIND = 'validation';

const RULE_SEGMENT = 'rule';
const REASON_SEGMENT = 'reason';

/** Ключ описания самого правила — то, чем вклад объяснён человеку и каталогу. */
export const RULE_DESCRIPTION_PREFIX = `${VALIDATION_KIND}.${RULE_SEGMENT}`;

/** Ключи причин. */
export const REASON_PREFIX = `${VALIDATION_KIND}.${REASON_SEGMENT}`;

/**
 * Код причины «правило упало само»: минтит его прогон, а не правило, поэтому
 * объявлять его правилу нечем и не нужно — он есть у каждого по построению.
 */
export const RULE_FAILED = 'ruleFailed';

/** Путь описания правила: `validation.rule.<id по сегментам>`. */
export function ruleDescriptionPath(ruleId: string): SchemaPath {
  if (ruleId === '') throw new Error('ключ описания правила: пустой id');
  return schemaPathOf(VALIDATION_KIND, [RULE_SEGMENT, ...ruleId.split('.')]);
}

/** Путь причины: `validation.reason.<id по сегментам>.<код>`. */
export function reasonPath(ruleId: string, code: string): SchemaPath {
  if (ruleId === '' || code === '') throw new Error('ключ причины: пустой id правила или код');
  return schemaPathOf(VALIDATION_KIND, [REASON_SEGMENT, ...ruleId.split('.'), ...code.split('.')]);
}

export function ruleDescriptionKey(ruleId: string): string {
  return descriptionKey(ruleDescriptionPath(ruleId));
}

export function reasonKey(ruleId: string, code: string): string {
  return descriptionKey(reasonPath(ruleId, code));
}

/** Все коды причин правила: объявленные им и тот, что минтит прогон. */
export function reasonCodesOf(rule: RuleReasons): readonly string[] {
  return [...new Set([...rule.reasonCodes, RULE_FAILED])];
}

/**
 * Вторая сторона отчёта ED-28 для пространства `validation.*`: описание правила
 * и по причине на каждый код, который правило способно сообщить.
 *
 * Список выводится из самих правил, а не поддерживается рядом с бандлом:
 * рукописный перечень ключей — та же таблица, которую ED-28 запрещает для
 * полей, и разошёлся бы он так же молча — на первом же правиле, добавленном без
 * правки перечня. Отсюда и `reasonCodes` у правила (`types.ts`): объявляет их
 * тот же вклад, который причины и сообщает, а прогон не даёт объявлению
 * разойтись с сообщаемым.
 */
export function validationDescriptionPaths(rules: Iterable<RuleReasons>): SchemaPath[] {
  const paths: SchemaPath[] = [];
  const seen = new Set<string>();
  const take = (path: SchemaPath): void => {
    const key = descriptionKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(path);
  };
  for (const rule of rules) {
    take(ruleDescriptionPath(rule.id));
    for (const code of reasonCodesOf(rule)) take(reasonPath(rule.id, code));
  }
  return paths;
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
