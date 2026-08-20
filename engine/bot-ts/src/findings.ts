/**
 * Находки валидации документов бота — профиля (BOT-6) и документа поведения
 * (BOT-8).
 *
 * Общий модуль, а не копия разбора в каждом документе: правила игры у них ОДНИ
 * (BOT-8 — «теми же правилами игры, что профиль»), и разъехаться им нельзя.
 * Дизайнер, читающий находку про кривую, обязан видеть тот же формат пути и тот
 * же язык, что в находке про способность.
 *
 * Адресат находок — геймдизайнер, отсюда две конвенции. Первая: разбор НЕ
 * бросает на первой находке, а собирает их все — «почини одно, узнай про
 * следующее» худший из возможных циклов правки. Вторая: находка называет путь
 * поля документа, а не имя переменной кода.
 */

export interface Findings {
  readonly issues: string[];
}

/** Диапазон числового поля; `int` требует целого. */
export interface NumberRange {
  readonly min: number;
  readonly max: number;
  readonly int?: boolean;
}

export function record(input: unknown, path: string, findings: Findings): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    findings.issues.push(`${path}: ожидался объект`);
    return {};
  }
  return input as Record<string, unknown>;
}

export function num(
  input: Record<string, unknown>,
  key: string,
  path: string,
  range: NumberRange,
  findings: Findings,
): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    findings.issues.push(`${path}.${key}: ожидалось конечное число`);
    return range.min;
  }
  if (range.int === true && !Number.isInteger(value)) {
    findings.issues.push(`${path}.${key}: ожидалось целое, получено ${value}`);
    return range.min;
  }
  if (value < range.min || value > range.max) {
    findings.issues.push(`${path}.${key}: ${value} вне [${range.min}, ${range.max}]`);
    return range.min;
  }
  return value;
}

/**
 * Значение из ЗАКРЫТОГО словаря (BOT-9): неизвестное имя — находка с самим
 * именем, а не молчаливое умолчание. Умолчание выбирает вызывающий: у одних
 * полей молчание документа законно (`hands`, `commit`), у других — ошибка.
 */
export function oneOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  path: string,
  known: readonly T[],
  findings: Findings,
): T | undefined {
  const value = input[key];
  if ((known as readonly unknown[]).includes(value)) return value as T;
  findings.issues.push(
    `${path}.${key}: ожидалось одно из ${known.join('|')}, получено ${JSON.stringify(value)}`,
  );
  return undefined;
}

/** Непустое имя документа или записи: «способность 3» дизайнеру не адресуется. */
export function name(input: Record<string, unknown>, path: string, findings: Findings): string {
  const value = input.name;
  if (typeof value === 'string' && value !== '') return value;
  findings.issues.push(`${path}.name: ожидалась непустая строка`);
  return '';
}

/**
 * Версия формы документа. Расхождение называется ВСЕГДА, а не только когда
 * прочих находок нет: документ будущей формы шумит несовпадением полей, и
 * именно версия объясняет этот шум — промолчать о ней значит спрятать причину
 * за следствием (BOT-6, BOT-8).
 */
export function schema(
  input: Record<string, unknown>,
  path: string,
  expected: number,
  findings: Findings,
): number {
  const value = num(input, 'schema', path, { min: 1, max: 1_000_000, int: true }, findings);
  if (value !== expected) {
    findings.issues.push(`${path}.schema: ${value} — реализация читает форму ${expected}`);
  }
  return value;
}

/** Бросает собранные находки одним текстом; чистый список — молчание. */
export function throwFindings(prefix: string, findings: Findings): void {
  if (findings.issues.length === 0) return;
  throw new Error(`${prefix}: ${findings.issues.join('; ')}`);
}
