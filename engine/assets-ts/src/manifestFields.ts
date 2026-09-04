/**
 * Общие поля манифеста визуалов, которые проверяются одинаково у РАЗНЫХ его
 * записей: таблица «строка → строка», наклон по поверхности (REND-10),
 * вертикальное смещение (REND-12), ярус и пороги LOD (ASSET-13).
 *
 * Живут отдельно потому, что владельцев у них больше одного: `surfaceAlign`
 * пишет и запись вида, и сам манифест, а `verticalOffset` — и запись вида, и
 * запись эффекта-оболочки (REND-23). Второго написания этих правил быть не
 * должно: разошедшиеся тексты находок читаются автором как разные форматы.
 *
 * Здесь же — ФОРМА машинного описания поля документа ({@link ManifestFieldSpec}),
 * которым владелец формата называет состав своей записи: имя, род значения,
 * обязательность и границы. Форма живёт с общими полями по той же причине, по
 * какой здесь живёт `verticalOffset`: описаний в модуле больше одного, а
 * состав `verticalOffset` — уже одно из них.
 */
import type { VisualTier } from './manifest.js';
import { HEX_COLOR_RE, closedKeys, isFiniteNumber, isRecord, typeName } from './validation.js';

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

/**
 * Род значения поля документа манифеста: число, строка либо СОСТАВНОЙ объект со
 * своим составом. Три рода, а не тип TypeScript: описание адресовано тому, кто
 * поле ПРАВИТ, — валидации, закрывающей состав, и панели редактора, которая по
 * роду выбирает контрол строки (`editor` ED-14).
 */
export type ManifestFieldKind = 'number' | 'string' | 'composite';

/**
 * Одно поле документа манифеста машинным описанием: имя, род значения,
 * обязательность, границы числа и — у составного — его состав.
 *
 * Заведено по тому же основанию, что машинное описание типов эффектов камеры
 * (`camera` CAM-9): перечень принадлежит владельцу формата, и второй его
 * перечень, набранный потребителем, разошёлся бы с первым молча. Границы здесь
 * ВКЛЮЧАЮЩИЕ, как у описания камеры; правило, связывающее два поля между собой
 * (конец окна строго дальше начала), полем описания не выражается и остаётся у
 * валидации — описание говорит о полях, а не обо всей записи.
 */
export interface ManifestFieldSpec {
  readonly name: string;
  readonly kind: ManifestFieldKind;
  /** Обязательное поле: записи без него формат не принимает. */
  readonly required?: boolean;
  /** Целое ли число; без пометки дробное законно. */
  readonly integer?: boolean;
  /** Границы числа включительно; нет границы — требуется ровно конечность. */
  readonly min?: number;
  readonly max?: number;
  /** Состав составного поля; у числа и строки его нет. */
  readonly fields?: readonly ManifestFieldSpec[];
}

/**
 * Имена полей описания — ими и закрывается состав (`closedKeys`). Одна функция
 * на все описания: перечень ключей выводится ИЗ описания, а не пишется рядом с
 * ним вторым списком.
 */
export function manifestFieldNames(fields: readonly ManifestFieldSpec[]): readonly string[] {
  return fields.map((field) => field.name);
}

/** Поля `verticalOffset` — они же перечень допустимых ключей секции (REND-12). */
export const VERTICAL_OFFSET_FIELDS: readonly ManifestFieldSpec[] = Object.freeze([
  { name: 'jumpArc', kind: 'number', min: 0 },
  { name: 'maneuverArc', kind: 'number', min: 0 },
  { name: 'flightArc', kind: 'number', min: 0 },
  { name: 'fallSpeed', kind: 'number', min: 0 },
  { name: 'fallDepth', kind: 'number', min: 0 },
]);

const VERTICAL_OFFSET_KEYS = manifestFieldNames(VERTICAL_OFFSET_FIELDS);

/** `verticalOffset` записи: все поля опциональны и неотрицательны (REND-12). */
export function validateVerticalOffset(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(
      `${path}: ожидался объект { ${VERTICAL_OFFSET_KEYS.map((f) => `${f}?`).join(', ')} }, получено ${typeName(v)}`,
    );
    return;
  }
  closedKeys(v, path, VERTICAL_OFFSET_KEYS, errors);
  for (const field of VERTICAL_OFFSET_KEYS) {
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

/** Поля `tint` записи — они же перечень допустимых ключей блока (ASSET-18). */
const TINT_FIELDS = ['materials', 'byEvent'] as const;
/** Поля одной вспышки тинта (ASSET-18). */
const TINT_FLASH_FIELDS = ['color', 'strength', 'seconds'] as const;

/**
 * `tint` записи (ASSET-18, `rendering` REND-40): маска команд-цвета индексами
 * материалов и таблица вспышек по событиям.
 *
 * Индексы проверяются на целость и неотрицательность, но НЕ на существование
 * материала с таким номером: манифест валидируется без моделей (ASSET-4), и
 * модель вправе доехать позже либо не доехать вовсе. Несуществующий индекс —
 * находка рендера в момент разрешения записи, а не документа.
 */
export function validateVisualTint(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { materials?, byEvent? }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, TINT_FIELDS, errors);
  if ('materials' in v) validateTintMask(v.materials, `${path}.materials`, errors);
  if ('byEvent' in v) validateTintFlashes(v.byEvent, `${path}.byEvent`, errors);
}

/** Маска команд-цвета: индексы материалов модели (ASSET-18). */
function validateTintMask(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path}: ожидался массив индексов материалов модели, получено ${typeName(v)}`);
    return;
  }
  v.forEach((value, i) => {
    if (!isFiniteNumber(value) || value < 0 || !Number.isInteger(value)) {
      errors.push(
        `${path}[${i}]: ожидался неотрицательный целый индекс материала, получено ${typeName(value)}`,
      );
    }
  });
}

/** Таблица «событие → вспышка» блока тинта (ASSET-18). */
function validateTintFlashes(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект «событие → вспышка», получено ${typeName(v)}`);
    return;
  }
  for (const [event, flash] of Object.entries(v)) {
    validateTintFlash(flash, `${path}.${event}`, errors);
  }
}

function validateTintFlash(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { color, strength?, seconds }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, TINT_FLASH_FIELDS, errors);
  if (typeof v.color !== 'string' || !HEX_COLOR_RE.test(v.color)) {
    errors.push(
      `${path}.color: обязательное поле — цвет формы "#rrggbb", получено ${typeName(v.color)}`,
    );
  }
  if ('strength' in v && (!isFiniteNumber(v.strength) || v.strength < 0 || v.strength > 1)) {
    errors.push(`${path}.strength: ожидалось число в [0..1], получено ${typeName(v.strength)}`);
  }
  if (!isFiniteNumber(v.seconds) || v.seconds <= 0) {
    errors.push(
      `${path}.seconds: обязательное поле — длительность вспышки в секундах больше нуля, получено ${typeName(v.seconds)}`,
    );
  }
}

/**
 * `dissolve` записи (`rendering` REND-4): задержка и длительность растворения
 * трупа. Длительность обязательна и положительна — блок с нулевой
 * длительностью означал бы «раствориться мгновенно», а это не растворение, и
 * писать его так автор не должен.
 */
export function validateVisualDissolve(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { delay?, duration }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, ['delay', 'duration'], errors);
  if ('delay' in v && (!isFiniteNumber(v.delay) || v.delay < 0)) {
    errors.push(`${path}.delay: ожидалось неотрицательное число секунд`);
  }
  if (!isFiniteNumber(v.duration) || v.duration <= 0) {
    errors.push(
      `${path}.duration: обязательное поле — длительность растворения в секундах больше нуля, получено ${typeName(v.duration)}`,
    );
  }
}
