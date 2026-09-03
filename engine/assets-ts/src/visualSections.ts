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
] as const;

/** Числовые поля записи эффекта и их границы; вне границ — ошибка документа. */
const EFFECT_NUMBERS: readonly { readonly name: string; readonly min?: number; readonly max?: number }[] = [
  { name: 'radius', min: 0 },
  { name: 'radiusTo', min: 0 },
  { name: 'alpha', min: 0, max: 1 },
  { name: 'alphaTo', min: 0, max: 1 },
  { name: 'durationMs', min: 0 },
  // Подъём может быть отрицательным (эффект под ногами): границы у него нет,
  // и требуется от него ровно конечность числа.
  { name: 'height' },
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
  if (!isFiniteNumber(v.radius) || v.radius < 0) {
    errors.push(`${path}.radius: обязательное поле — неотрицательный радиус, получено ${typeName(v.radius)}`);
  }
  validateEffectNumbers(v, path, errors);
  if ('verticalOffset' in v) {
    validateVerticalOffset(v.verticalOffset, `${path}.verticalOffset`, errors);
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

/**
 * Слот tileset'а террейна (ASSET-15): тайлящаяся текстура покрытия и её мировой
 * период. Период в МИРОВЫХ единицах, а не в клетках: у геометрии террейна нет
 * своего UV — координата слота выводится проекцией мировой позиции (REND-39), и
 * период клетками зависел бы от `tileSize` арены.
 */
export interface TerrainTilesetSlot {
  /** ID текстуры дерева контента (ASSET-2). */
  readonly texture: string;
  /** Мировых единиц на период тайла; строго положительный. */
  readonly period: number;
}

/**
 * Tileset террейна (ASSET-15) — АВТОРСКИЙ перечень покрытий: список слотов пола
 * (порядок есть нумерация: индекс `0` — первый элемент) и необязательная запись
 * покрытия стенок обрывов и юбки. Живёт в манифесте, а не в производном
 * документе, потому что его подбирает художник, и импорт из Blender его не
 * переписывает (BLND-2, BLND-14).
 */
export interface TerrainTileset {
  readonly slots: readonly TerrainTilesetSlot[];
  /** Покрытие стенок обрывов и юбки; нет — они рисуются цветом (REND-7). */
  readonly wall?: TerrainTilesetSlot;
}

/** Presentation-данные террейна арены: рельеф (ASSET-7) и текстурирование (ASSET-15). */
export interface TerrainVisualSection {
  /** ID карты кривизны (ASSET-7); нет — плоские ступени REND-7. */
  readonly curvatureMap?: string;
  /** Перечень покрытий поверхности; нет — террейн без текстурирования. */
  readonly tileset?: TerrainTileset;
  /** ID карты раскраски клеток (ASSET-15); нет — террейн без текстурирования. */
  readonly paintMap?: string;
}
