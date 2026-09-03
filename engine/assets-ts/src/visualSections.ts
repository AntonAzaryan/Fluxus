/**
 * Валидация секций манифеста, за которыми стоят подсистемы рендера: транзиентные
 * эффекты (`rendering` REND-23) и эмиттеры частиц (ASSET-14, REND-24). У обеих
 * по три таблицы источников — по визуальному типу, по имени доставленного
 * состояния и по типу события тика, — и правила разбора таблиц у них общие.
 *
 * Перечня примитивов, кривых и содержимого документа эффекта здесь нет
 * намеренно: их называет рендер и документ эмиттерного ассета, а манифест
 * переживает код (то же основание, что у секции эффектов камеры, ASSET-8).
 */
import { validateVerticalOffset } from './manifestFields.js';
import { closedKeys, isFiniteNumber, isRecord, typeName } from './validation.js';

/** Три таблицы источников секции (REND-23, REND-24): вид, состояние, событие. */
const SOURCE_TABLES = ['byKind', 'byState', 'byEvent'] as const;

/**
 * Секция из трёх таблиц «имя → запись». Одна разборка на обе секции: таблицы у
 * них одни и те же и значат одно и то же, а разойдись их разбор — одна из
 * секций молча приняла бы не-объект там, где вторая отказывает.
 *
 * Пространства ключей у таблиц РАЗНЫЕ и пересекаться им не запрещено: слева
 * визуальные типы, посередине имена компонент-состояний, справа типы событий, и
 * одноимённые записи значат разное.
 */
function validateSourceTables(
  section: unknown,
  path: string,
  what: string,
  validateEntry: (def: unknown, at: string, errors: string[]) => void,
  errors: string[],
): void {
  if (!isRecord(section)) {
    errors.push(`${path}: ожидался объект { byKind?, byState?, byEvent? }, получено ${typeName(section)}`);
    return;
  }
  closedKeys(section, path, SOURCE_TABLES, errors);
  for (const table of SOURCE_TABLES) {
    if (!(table in section)) continue;
    const entries = section[table];
    if (!isRecord(entries)) {
      errors.push(`${path}.${table}: ожидался объект «имя → ${what}», получено ${typeName(entries)}`);
      continue;
    }
    for (const [name, def] of Object.entries(entries)) {
      validateEntry(def, `${path}.${table}.${name}`, errors);
    }
  }
}

/** Поля записи эффекта (REND-23) — они же перечень допустимых ключей. */
const EFFECT_FIELDS = [
  'primitive',
  'color',
  'radius',
  'radiusTo',
  'alpha',
  'alphaTo',
  'durationMs',
  'curve',
  'height',
  'verticalOffset',
  'offset',
  'radiusFromStat',
  'colorAt',
  'blink',
  // Числа формы непроцедурных примитивов (REND-43, REND-23): перечня примитивов
  // у валидации нет, а числа их формы она проверяет на общих основаниях.
  'innerRadius',
  'halfAngleDeg',
  'length',
  'width',
  'edgeSoftness',
  'lift',
  'targetFromStat',
  'trailSamples',
] as const;

/** Числовые поля записи эффекта и их границы; вне границ — ошибка документа. */
const EFFECT_NUMBERS: readonly { readonly name: string; readonly min?: number; readonly max?: number }[] = [
  { name: 'radius', min: 0 },
  { name: 'radiusTo', min: 0 },
  { name: 'alpha', min: 0, max: 1 },
  { name: 'alphaTo', min: 0, max: 1 },
  { name: 'durationMs', min: 0 },
  // Подъём может быть отрицательным (эффект под ногами): границы у него нет,
  // и требуется от него ровно конечность числа. Вынос вперёд по курсу прицела
  // (REND-23) — по той же причине: отрицательный выносит назад.
  { name: 'height' },
  { name: 'offset' },
  { name: 'innerRadius', min: 0 },
  // Полураствор сектора: половина полного оборота и есть предел — больше него
  // сектор перестаёт быть сектором.
  { name: 'halfAngleDeg', min: 0, max: 180 },
  { name: 'length', min: 0 },
  { name: 'width', min: 0 },
  { name: 'edgeSoftness', min: 0, max: 1 },
  // Подъём над полем может быть отрицательным (фигура под настилом): границы у
  // него нет, требуется ровно конечность числа.
  { name: 'lift' },
];

/**
 * Запись эффекта (REND-23). Структура проверяется строго — опечатка в поле
 * data-driven документа почти всегда ошибка автора, — а имена примитива и
 * кривой не проверяются вовсе: их перечень принадлежит рендеру, и второй
 * перечень здесь разошёлся бы с ним молча (то же основание, что у ASSET-8).
 */
function validateEffect(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { primitive, color, radius, … }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, EFFECT_FIELDS, errors);
  for (const field of ['primitive', 'color'] as const) {
    const value = v[field];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${path}.${field}: обязательное поле — непустая строка, получено ${typeName(value)}`);
    }
  }
  // Радиус обязателен, пока запись не назвала ШИРИНУ: ширина и есть признак
  // нерадиального примитива (луч, лента, полоса), у которого радиуса нет
  // (REND-23). Перечня примитивов валидация при этом не знает — она смотрит на
  // состав полей, а не на имя.
  if ('width' in v) {
    if ('radius' in v && (!isFiniteNumber(v.radius) || v.radius < 0)) {
      errors.push(`${path}.radius: ожидался неотрицательный радиус, получено ${typeName(v.radius)}`);
    }
  } else if (!isFiniteNumber(v.radius) || v.radius < 0) {
    errors.push(
      `${path}.radius: обязательное поле — неотрицательный радиус (либо ширина width у нерадиального примитива), получено ${typeName(v.radius)}`,
    );
  }
  if ('targetFromStat' in v && (typeof v.targetFromStat !== 'string' || v.targetFromStat.length === 0)) {
    errors.push(
      `${path}.targetFromStat: ожидалось имя доставленного стата (непустая строка), получено ${typeName(v.targetFromStat)}`,
    );
  }
  if ('trailSamples' in v && (!Number.isInteger(v.trailSamples) || (v.trailSamples as number) < 2)) {
    errors.push(
      `${path}.trailSamples: ожидалось целое число выборок >= 2, получено ${typeName(v.trailSamples)}`,
    );
  }
  validateEffectNumbers(v, path, errors);
  if ('verticalOffset' in v) {
    validateVerticalOffset(v.verticalOffset, `${path}.verticalOffset`, errors);
  }
  validateStatDriven(v, path, errors);
}

/** Поля окна стата (REND-23) — они же перечень допустимых ключей. */
const STAT_WINDOW_FIELDS = ['stat', 'min', 'max', 'from', 'to'] as const;
/** Поля порога цвета и мигания. */
const COLOR_AT_FIELDS = ['phase', 'color'] as const;
const BLINK_FIELDS = ['periodMs', 'alpha'] as const;

/**
 * Ведение записи доставленным статом (REND-23): окно значений, порог цвета и
 * мигание за концом окна. Имя стата не проверяется — словарь статов принадлежит
 * конфигурации сборки воркера (`match-hud` HUD-8), и второй его перечень здесь
 * разошёлся бы с ним молча; проверяется ровно структура и числа.
 *
 * Порог цвета и мигание без окна смысла не имеют: фазы, к которой они привязаны,
 * без окна не существует, и молчаливое игнорирование выдало бы автору
 * работающую запись за нерабочую.
 */
function validateStatDriven(v: Record<string, unknown>, path: string, errors: string[]): void {
  if ('radiusFromStat' in v) validateStatWindow(v.radiusFromStat, `${path}.radiusFromStat`, errors);
  // Порог цвета без окна привязать не к чему: фазы у записи тогда не
  // существует. Мигание — другое дело: с окном оно предупреждает о передержке,
  // без окна пульсирует всегда (луч, лента), и запретом это не является.
  if ('colorAt' in v && !('radiusFromStat' in v)) {
    errors.push(`${path}.colorAt: поле ведётся фазой окна radiusFromStat, а окна в записи нет`);
  }
  if ('colorAt' in v) validateColorAt(v.colorAt, `${path}.colorAt`, errors);
  if ('blink' in v) validateBlink(v.blink, `${path}.blink`, errors);
}

function validateStatWindow(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { stat, max, to, min?, from? }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, STAT_WINDOW_FIELDS, errors);
  if (typeof v.stat !== 'string' || v.stat.length === 0) {
    errors.push(
      `${path}.stat: обязательное поле — имя доставленного стата (непустая строка), получено ${typeName(v.stat)}`,
    );
  }
  for (const field of ['max', 'to'] as const) {
    if (!isFiniteNumber(v[field])) {
      errors.push(`${path}.${field}: обязательное поле — конечное число, получено ${typeName(v[field])}`);
    }
  }
  for (const field of ['min', 'from'] as const) {
    if (field in v && !isFiniteNumber(v[field])) {
      errors.push(`${path}.${field}: ожидалось конечное число, получено ${typeName(v[field])}`);
    }
  }
  validateStatWindowRanges(v, path, errors);
}

/** Границы окна и множителей: отрицательный радиус и пустое окно — ошибки. */
function validateStatWindowRanges(
  v: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  for (const field of ['from', 'to'] as const) {
    const value = v[field];
    if (isFiniteNumber(value) && value < 0) {
      errors.push(
        `${path}.${field}: ожидался неотрицательный множитель радиуса, получено ${String(value)}`,
      );
    }
  }
  // Пустое окно — деление на ноль у потребителя, и молчаливое приведение к
  // границе спрятало бы опечатку автора: конец окна обязан быть строго дальше
  // его начала.
  const min = isFiniteNumber(v.min) ? v.min : 0;
  if (isFiniteNumber(v.max) && v.max <= min) {
    errors.push(`${path}.max: конец окна обязан быть строго больше начала (${String(min)}), получено ${String(v.max)}`);
  }
}

function validateColorAt(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { phase, color }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, COLOR_AT_FIELDS, errors);
  if (!isFiniteNumber(v.phase) || v.phase < 0 || v.phase > 1) {
    errors.push(`${path}.phase: обязательное поле — доля окна в [0..1], получено ${typeName(v.phase)}`);
  }
  if (typeof v.color !== 'string' || v.color.length === 0) {
    errors.push(`${path}.color: обязательное поле — непустая строка, получено ${typeName(v.color)}`);
  }
}

function validateBlink(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { periodMs, alpha }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, BLINK_FIELDS, errors);
  if (!isFiniteNumber(v.periodMs) || v.periodMs <= 0) {
    errors.push(`${path}.periodMs: обязательное поле — положительный период в мс, получено ${typeName(v.periodMs)}`);
  }
  if (!isFiniteNumber(v.alpha) || v.alpha < 0 || v.alpha > 1) {
    errors.push(`${path}.alpha: обязательное поле — множитель альфы в [0..1], получено ${typeName(v.alpha)}`);
  }
}

/** Границы числа записи словами — их и печатает находка поля. */
function effectRangeText(spec: (typeof EFFECT_NUMBERS)[number]): string {
  if (spec.min === undefined) return 'конечное число';
  return spec.max === undefined ? `число >= ${spec.min}` : `число в [${spec.min}..${spec.max}]`;
}

/**
 * Необязательные числа записи эффекта. `radius` через этот проход не идёт: он
 * обязателен, и о его отсутствии сказано отдельной находкой выше.
 */
function validateEffectNumbers(
  v: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  for (const spec of EFFECT_NUMBERS) {
    if (!(spec.name in v) || spec.name === 'radius') continue;
    const value = v[spec.name];
    if (
      !isFiniteNumber(value) ||
      (spec.min !== undefined && value < spec.min) ||
      (spec.max !== undefined && value > spec.max)
    ) {
      errors.push(`${path}.${spec.name}: ожидалось ${effectRangeText(spec)}, получено ${typeName(value)}`);
    }
  }
}

/** Секция транзиентных эффектов (REND-23): три таблицы «имя → запись эффекта». */
export function validateEffects(section: unknown, errors: string[]): void {
  validateSourceTables(section, 'effects', 'эффект', validateEffect, errors);
}

/** Поля записи эмиттера (ASSET-14) — они же перечень допустимых ключей. */
const EMITTER_FIELDS = ['effect', 'socket', 'scale'] as const;

/**
 * Запись эмиттера (ASSET-14). Состав закрыт: неизвестный ключ — ошибка, а не
 * молчаливый игнор. Содержимое документа эффекта не проверяется и здесь: ссылка
 * — это asset id, а форму документа знает его загрузчик (`particleEffect.ts`).
 */
function validateEmitter(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { effect, socket?, scale? }, получено ${typeName(v)}`);
    return;
  }
  closedKeys(v, path, EMITTER_FIELDS, errors);
  if (typeof v.effect !== 'string' || v.effect.length === 0) {
    errors.push(
      `${path}.effect: обязательное поле — asset id эмиттерного ассета (непустая строка), получено ${typeName(v.effect)}`,
    );
  }
  if ('socket' in v && (typeof v.socket !== 'string' || v.socket.length === 0)) {
    errors.push(
      `${path}.socket: ожидалось имя узла-сокета модели (непустая строка), получено ${typeName(v.socket)}`,
    );
  }
  if ('scale' in v && (!isFiniteNumber(v.scale) || v.scale <= 0)) {
    errors.push(`${path}.scale: ожидалось положительное число, получено ${typeName(v.scale)}`);
  }
}

/** Секция эмиттеров частиц (ASSET-14): три таблицы «имя → запись эмиттера». */
export function validateParticles(section: unknown, errors: string[]): void {
  validateSourceTables(section, 'particles', 'эмиттер', validateEmitter, errors);
}
