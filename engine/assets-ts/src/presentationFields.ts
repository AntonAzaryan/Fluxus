/**
 * Общие примитивы валидации СЕКЦИЙ парного presentation-документа
 * (`presentation-scene` PRES-2): подсекция по адресу, закрытый состав ключей,
 * числовое поле в диапазоне и поле цвета.
 *
 * Живут отдельно потому, что секций у документа больше одной, а правила у них
 * общие: состав закрыт на каждом уровне, находка адресует УРОВЕНЬ, на котором
 * нашлась, а отсутствие поля — документированное умолчание подсистемы рендера,
 * а не ошибка. Второго набора этих правил быть не должно: разошедшиеся тексты
 * находок читаются автором как разные форматы, а формат один.
 *
 * Границы те же, что у всего документа: здесь проверяется ФОРМА данных, а
 * политика картинки — сами умолчания — живёт у подсистем рендера (`render-ts`).
 */

/** Ответ «получено что-то не то» — одним словарём на все секции документа. */
export function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Цвет в документе — `#rrggbb`: одна форма записи на все секции, чтобы дифф
 * правки не гадал о синонимах и чтобы тон тумана и тон света читались одинаково.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Подсекция по адресу: не объект — адресный отказ и `null`, дальше разбирать
 * нечего. Отсутствие подсекции — умолчания подсистемы, а не ошибка, поэтому
 * `undefined` сюда не доходит: его отсеивает вызывающий.
 */
export function subsection(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  errors.push(`${path}: ожидался объект секции, получено ${typeName(value)}`);
  return null;
}

/** Ключ, которого формат не знает, — ошибка с перечнем допустимых соседей (PRES-2). */
export function closedKeys(
  node: Record<string, unknown>,
  path: string,
  keys: readonly string[],
  errors: string[],
): void {
  for (const key of Object.keys(node)) {
    if (keys.includes(key)) continue;
    errors.push(`${path}.${key}: неизвестное поле (допустимы: ${keys.join(', ')})`);
  }
}

/** Границы числового поля: что за величина и в каком диапазоне она осмысленна. */
export interface NumberRange {
  readonly what: string;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  /** Границы исключающие: `min` и `max` сами значениями не являются. */
  readonly exclusive?: boolean;
}

/**
 * Числовое поле подсекции. Отсутствие — умолчание подсистемы (PRES-2), а
 * диапазон здесь — форма данных, а не политика картинки: отрицательная
 * интенсивность и неположительная экспозиция не имеют прочтения ни при каких
 * умолчаниях.
 */
export function numberField(
  node: Record<string, unknown>,
  path: string,
  key: string,
  range: NumberRange,
  errors: string[],
): void {
  if (!(key in node)) return;
  const value = node[key];
  const exclusive = range.exclusive === true;
  const bad =
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (range.integer === true && !Number.isInteger(value)) ||
    (range.min !== undefined && (exclusive ? value <= range.min : value < range.min)) ||
    (range.max !== undefined && (exclusive ? value >= range.max : value > range.max));
  if (bad) errors.push(`${path}.${key}: ожидалось ${range.what}, получено ${typeName(value)}`);
}

/**
 * Поле цвета ПО ИМЕНИ — та же форма `#rrggbb` на все секции документа. Имя
 * приходит параметром потому, что тонов у подсекции бывает больше одного:
 * полусферная подсветка (`rendering` REND-29) несёт «небо» и «землю», и второй
 * её тон обязан проверяться тем же правилом и тем же текстом отказа, что первый.
 */
export function namedColorField(
  node: Record<string, unknown>,
  path: string,
  key: string,
  errors: string[],
): void {
  if (!(key in node)) return;
  const value = node[key];
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) {
    errors.push(`${path}.${key}: ожидался цвет формы "#rrggbb", получено ${typeName(value)}`);
  }
}

/** Тон источника — та же форма `#rrggbb`, что у тона тумана. */
export function colorField(node: Record<string, unknown>, path: string, errors: string[]): void {
  namedColorField(node, path, 'color', errors);
}

/** Булево поле секции: отсутствие и `false` неразличимы (PRES-2), третьего прочтения нет. */
export function booleanField(
  node: Record<string, unknown>,
  path: string,
  key: string,
  what: string,
  errors: string[],
): void {
  if (!(key in node)) return;
  if (typeof node[key] !== 'boolean') {
    errors.push(`${path}.${key}: ожидался ${what} (true либо false), получено ${typeName(node[key])}`);
  }
}
