/**
 * Примитивы валидации СЕКЦИЙ парного presentation-документа
 * (`presentation-scene` PRES-2): подсекция по адресу, необязательная подсекция,
 * числовое поле в диапазоне, поле цвета и булево поле.
 *
 * Живут отдельно потому, что секций у документа больше одной, а правила у них
 * общие: состав закрыт на каждом уровне, находка адресует УРОВЕНЬ, на котором
 * нашлась, а отсутствие поля — документированное умолчание подсистемы рендера,
 * а не ошибка. Второго набора этих правил быть не должно: разошедшиеся тексты
 * находок читаются автором как разные форматы, а формат один.
 *
 * Примитивы, общие у документа с ОСТАЛЬНЫМИ документами модуля (словарь типов,
 * запись, конечное число, закрытый состав ключей, форма цвета), живут ярусом
 * ниже — в `validation.ts`.
 *
 * Границы те же, что у всего документа: здесь проверяется ФОРМА данных, а
 * политика картинки — сами умолчания — живёт у подсистем рендера (`render-ts`).
 */
import { HEX_COLOR_RE, isRecord, typeName } from './validation.js';

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

/**
 * Необязательная подсекция по имени: ненаписанной подсекции нет — это
 * умолчания подсистемы (PRES-2), а написанная обязана быть объектом, иначе
 * адресный отказ и `null`. Один порядок на все секции документа: разойдись он,
 * одна из секций молча начала бы принимать не-объект.
 */
export function optionalSubsection(
  node: Record<string, unknown>,
  path: string,
  key: string,
  errors: string[],
): Record<string, unknown> | null {
  if (!(key in node)) return null;
  return subsection(node[key], `${path}.${key}`, errors);
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
