/**
 * Общие поля манифеста визуалов, которые проверяются одинаково у РАЗНЫХ его
 * записей: таблица «строка → строка», наклон по поверхности (REND-10),
 * вертикальное смещение (REND-12), ярус и пороги LOD (ASSET-13).
 *
 * Живут отдельно потому, что владельцев у них больше одного: `surfaceAlign`
 * пишет и запись вида, и сам манифест, а `verticalOffset` — и запись вида, и
 * запись эффекта-оболочки (REND-23). Второго написания этих правил быть не
 * должно: разошедшиеся тексты находок читаются автором как разные форматы.
 */
import type { VisualTier } from './manifest.js';
import { closedKeys, isFiniteNumber, isRecord, typeName } from './validation.js';

/** Запись «строка → строка» с непустыми значениями. */
export function validateStringMap(v: unknown, path: string, what: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект «${what}», получено ${typeName(v)}`);
    return;
  }
  for (const [key, val] of Object.entries(v)) {
    if (typeof val !== 'string' || val.length === 0) {
      errors.push(`${path}.${key}: ожидалась непустая строка, получено ${typeName(val)}`);
    }
  }
}

/** `surfaceAlign` записи или манифеста: factor в [0..1], лимит угла >= 0 (REND-10). */
export function validateSurfaceAlign(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { factor, maxAngleDeg? }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, ['factor', 'maxAngleDeg'], errors);
  if (!isFiniteNumber(v.factor) || v.factor < 0 || v.factor > 1) {
    errors.push(`${path}.factor: обязательное поле — число в [0..1], получено ${typeName(v.factor)}`);
  }
  if ('maxAngleDeg' in v && (!isFiniteNumber(v.maxAngleDeg) || v.maxAngleDeg < 0)) {
    errors.push(`${path}.maxAngleDeg: ожидалось неотрицательное число градусов`);
  }
}

/** Поля `verticalOffset` — они же перечень допустимых ключей секции (REND-12). */
const VERTICAL_OFFSET_FIELDS = [
  'jumpArc',
  'maneuverArc',
  'flightArc',
  'fallSpeed',
  'fallDepth',
] as const;

/** `verticalOffset` записи: все поля опциональны и неотрицательны (REND-12). */
export function validateVerticalOffset(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(
      `${path}: ожидался объект { ${VERTICAL_OFFSET_FIELDS.map((f) => `${f}?`).join(', ')} }, получено ${typeName(v)}`,
    );
    return;
  }
  const fields = VERTICAL_OFFSET_FIELDS;
  closedKeys(v, path, fields, errors);
  for (const field of fields) {
    const value = v[field];
    if (field in v && (!isFiniteNumber(value) || value < 0)) {
      errors.push(`${path}.${field}: ожидалось неотрицательное число мировых единиц`);
    }
  }
}

/** Ярусы, которые запись вправе назвать (ASSET-13); перечень закрыт рендером. */
export const VISUAL_TIERS: readonly VisualTier[] = ['batched', 'detailed'];

/**
 * `lodThresholds` записи (ASSET-13): доли высоты кадра в `(0..1]`, строго
 * убывающие. Строгое убывание — не придирка: порог, не меньший предыдущего,
 * означает уровень, который не выбирается никогда, и молча пропасть такая
 * запись не должна.
 */
export function validateLodThresholds(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path}: ожидался массив порогов переключения LOD, получено ${typeName(v)}`);
    return;
  }
  let previous = Number.POSITIVE_INFINITY;
  v.forEach((value, i) => {
    if (!isFiniteNumber(value) || value <= 0 || value > 1) {
      errors.push(`${path}[${i}]: ожидалась доля высоты кадра в (0..1], получено ${typeName(value)}`);
      return;
    }
    if (value >= previous) {
      errors.push(`${path}[${i}]: пороги должны строго убывать, а ${value} не меньше ${previous}`);
    }
    previous = value;
  });
}
