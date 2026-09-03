/**
 * Валидация секций манифеста, за которыми стоят подсистемы рендера: транзиентные
 * эффекты (`rendering` REND-23) и эмиттеры частиц (ASSET-14, REND-24). У обеих
 * по три таблицы источников — по визуальному типу, по имени доставленного
 * состояния и по типу события тика, — и правила разбора таблиц у них общие.
 *
 * Перечня примитивов, кривых и содержимого документа эффекта здесь нет
 * намеренно: их называет рендер и документ эмиттерного ассета, а манифест
 * переживает код (то же основание, что у секции эффектов камеры, ASSET-8).
 *
 * Состав же самой записи эффекта здесь есть, и он ОДИН на репозиторий:
 * {@link EFFECT_FIELDS} — машинное описание её полей (имя, род значения,
 * обязательность, границы, состав составного), которым закрывается состав при
 * валидации и по которому строит свои строки панель редактора (`editor` ED-14).
 */
import {
  VERTICAL_OFFSET_FIELDS,
  manifestFieldNames,
  validateVerticalOffset,
  type ManifestFieldSpec,
} from './manifestFields.js';
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

/**
 * Состав СОСТАВНЫХ полей записи (REND-23): окно доставленного стата, порог цвета
 * и мигание. Объявлены раньше самой записи, потому что входят в её описание.
 *
 * Имя и род значения здесь есть, границ чисел нет: своё правило каждое из этих
 * полей говорит СВОИМИ словами («доля окна», «период в мс», «множитель
 * радиуса»), и разложи его на включающие границы описания — находка потеряла бы
 * свой текст. Описание отвечает за состав и род, правило — за числа.
 */
const STAT_WINDOW_FIELDS: readonly ManifestFieldSpec[] = Object.freeze([
  { name: 'stat', kind: 'string', required: true },
  { name: 'min', kind: 'number' },
  { name: 'max', kind: 'number', required: true },
  { name: 'from', kind: 'number' },
  { name: 'to', kind: 'number', required: true },
]);

/** Поля порога цвета и мигания (REND-23). */
const COLOR_AT_FIELDS: readonly ManifestFieldSpec[] = Object.freeze([
  { name: 'phase', kind: 'number', required: true },
  { name: 'color', kind: 'string', required: true },
]);
const BLINK_FIELDS: readonly ManifestFieldSpec[] = Object.freeze([
  { name: 'periodMs', kind: 'number', required: true },
  { name: 'alpha', kind: 'number', required: true },
]);

/** Наименьшее осмысленное число выборок ленты: двумя точками задан отрезок. */
const TRAIL_SAMPLES_MIN = 2;
/** Выборки следа (REND-43) — число со СВОЕЙ находкой, см. {@link validateEffect}. */
const TRAIL_SAMPLES: ManifestFieldSpec = {
  name: 'trailSamples',
  kind: 'number',
  integer: true,
  min: TRAIL_SAMPLES_MIN,
};
/** Радиус (REND-23) — обязателен у радиальных примитивов, и находка у него своя. */
const RADIUS: ManifestFieldSpec = { name: 'radius', kind: 'number', min: 0 };

/**
 * Состав записи эффекта (REND-23) МАШИННЫМ ОПИСАНИЕМ: имя поля, род значения,
 * обязательность и границы числа; у составного поля — его состав.
 *
 * Один перечень на весь репозиторий. Им закрывается состав записи при валидации
 * («неизвестный КЛЮЧ отвергается адресно»), из него же берёт границы общий
 * проход чисел, и из него же строит свои строки панель VFX редактора (`editor`
 * ED-14): второй перечень, набранный потребителем, отстал бы от формата молча —
 * ровно это ED-14 запрещает прямым текстом. Основание то же, по которому набор
 * типов эффектов камеры приезжает в редактор описанием (`camera` CAM-9).
 *
 * Порядок СМЫСЛОВОЙ и является частью описания: от того, что есть у всякой
 * записи, через её жизнь и ведение доставленным статом к числам формы отдельных
 * примитивов (REND-43). Читателю описания он достаётся вместе с именами —
 * подсказка редактора предлагает поля в этом же порядке.
 *
 * Перечня примитивов и кривых здесь по-прежнему нет: их называет рендер, а
 * манифест переживает код (то же основание, что у секции эффектов камеры,
 * ASSET-8).
 */
export const EFFECT_FIELDS: readonly ManifestFieldSpec[] = Object.freeze([
  { name: 'primitive', kind: 'string', required: true },
  { name: 'color', kind: 'string', required: true },
  RADIUS,
  { name: 'radiusTo', kind: 'number', min: 0 },
  { name: 'alpha', kind: 'number', min: 0, max: 1 },
  { name: 'alphaTo', kind: 'number', min: 0, max: 1 },
  { name: 'durationMs', kind: 'number', min: 0 },
  { name: 'curve', kind: 'string' },
  // Подъём может быть отрицательным (эффект под ногами): границы у него нет,
  // и требуется от него ровно конечность числа. Вынос вперёд по курсу прицела
  // (REND-23) — по той же причине: отрицательный выносит назад.
  { name: 'height', kind: 'number' },
  { name: 'verticalOffset', kind: 'composite', fields: VERTICAL_OFFSET_FIELDS },
  { name: 'offset', kind: 'number' },
  { name: 'radiusFromStat', kind: 'composite', fields: STAT_WINDOW_FIELDS },
  { name: 'colorAt', kind: 'composite', fields: COLOR_AT_FIELDS },
  { name: 'blink', kind: 'composite', fields: BLINK_FIELDS },
  // Числа формы непроцедурных примитивов (REND-43, REND-23): перечня примитивов
  // у валидации нет, а числа их формы она проверяет на общих основаниях.
  { name: 'innerRadius', kind: 'number', min: 0 },
  // Полураствор сектора: половина полного оборота и есть предел — больше него
  // сектор перестаёт быть сектором.
  { name: 'halfAngleDeg', kind: 'number', min: 0, max: 180 },
  { name: 'length', kind: 'number', min: 0 },
  { name: 'width', kind: 'number', min: 0 },
  { name: 'edgeSoftness', kind: 'number', min: 0, max: 1 },
  // Подъём над полем может быть отрицательным (фигура под настилом): границы у
  // него нет, требуется ровно конечность числа.
  { name: 'lift', kind: 'number' },
  { name: 'targetFromStat', kind: 'string' },
  TRAIL_SAMPLES,
]);

/** Ключи записи эффекта — ими и закрывается её состав. */
const EFFECT_KEYS = manifestFieldNames(EFFECT_FIELDS);

/**
 * Числа записи со СВОЕЙ находкой: радиус (он обязателен, и о его отсутствии
 * сказано отдельной находкой) и выборки следа (целое, и текст находки говорит,
 * чего именно выборки). Общий проход границ их пропускает — иначе на одно
 * значение автор получил бы две находки, сказанные разными словами.
 */
const OWN_FINDING: readonly string[] = [RADIUS.name, TRAIL_SAMPLES.name];

/** Числа записи, которые проверяет общий проход границ. */
const EFFECT_NUMBERS = EFFECT_FIELDS.filter(
  (field) => field.kind === 'number' && !OWN_FINDING.includes(field.name),
);

/** Обязательные строки записи: без них запись не бывает валидной. */
const EFFECT_REQUIRED_STRINGS = EFFECT_FIELDS.filter(
  (field) => field.kind === 'string' && field.required === true,
);

/**
 * Значение в объявленных границах? Один ответ на модуль: им судит и общий проход
 * чисел, и своё правило поля — второе сравнение разошлось бы с первым молча.
 */
function inBounds(spec: ManifestFieldSpec, value: number): boolean {
  if (spec.min !== undefined && value < spec.min) return false;
  if (spec.max !== undefined && value > spec.max) return false;
  return spec.integer !== true || Number.isInteger(value);
}

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
  closedKeys(v, path, EFFECT_KEYS, errors);
  for (const spec of EFFECT_REQUIRED_STRINGS) {
    const value = v[spec.name];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${path}.${spec.name}: обязательное поле — непустая строка, получено ${typeName(value)}`);
    }
  }
  validateEffectRadius(v, path, errors);
  if ('targetFromStat' in v && (typeof v.targetFromStat !== 'string' || v.targetFromStat.length === 0)) {
    errors.push(
      `${path}.targetFromStat: ожидалось имя доставленного стата (непустая строка), получено ${typeName(v.targetFromStat)}`,
    );
  }
  if ('trailSamples' in v && !(isFiniteNumber(v.trailSamples) && inBounds(TRAIL_SAMPLES, v.trailSamples))) {
    errors.push(
      `${path}.trailSamples: ожидалось целое число выборок >= ${TRAIL_SAMPLES_MIN}, получено ${typeName(v.trailSamples)}`,
    );
  }
  validateEffectNumbers(v, path, errors);
  if ('verticalOffset' in v) {
    validateVerticalOffset(v.verticalOffset, `${path}.verticalOffset`, errors);
  }
  validateStatDriven(v, path, errors);
}

/**
 * Радиус записи (REND-23). Обязателен, пока запись не назвала ШИРИНУ: ширина и
 * есть признак нерадиального примитива (луч, лента, полоса), у которого радиуса
 * нет вовсе. Перечня примитивов валидация при этом не знает — она смотрит на
 * состав полей, а не на имя.
 */
function validateEffectRadius(v: Record<string, unknown>, path: string, errors: string[]): void {
  const ok = isFiniteNumber(v.radius) && inBounds(RADIUS, v.radius);
  if (ok) return;
  if ('width' in v) {
    if ('radius' in v) {
      errors.push(`${path}.radius: ожидался неотрицательный радиус, получено ${typeName(v.radius)}`);
    }
    return;
  }
  errors.push(
    `${path}.radius: обязательное поле — неотрицательный радиус (либо ширина width у нерадиального примитива), получено ${typeName(v.radius)}`,
  );
}

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
  closedKeys(v, path, manifestFieldNames(STAT_WINDOW_FIELDS), errors);
  if (typeof v.stat !== 'string' || v.stat.length === 0) {
    errors.push(
      `${path}.stat: обязательное поле — имя доставленного стата (непустая строка), получено ${typeName(v.stat)}`,
    );
  }
  // Обязательность полей окна — из его описания, а не вторым списком рядом:
  // конец окна и множитель на нём обязательны, начало и множитель на начале
  // имеют умолчания (0 и 1).
  for (const spec of STAT_WINDOW_FIELDS) {
    if (spec.kind !== 'number') continue;
    const value = v[spec.name];
    if (spec.required === true) {
      if (!isFiniteNumber(value)) {
        errors.push(`${path}.${spec.name}: обязательное поле — конечное число, получено ${typeName(value)}`);
      }
    } else if (spec.name in v && !isFiniteNumber(value)) {
      errors.push(`${path}.${spec.name}: ожидалось конечное число, получено ${typeName(value)}`);
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
  closedKeys(v, path, manifestFieldNames(COLOR_AT_FIELDS), errors);
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
  closedKeys(v, path, manifestFieldNames(BLINK_FIELDS), errors);
  if (!isFiniteNumber(v.periodMs) || v.periodMs <= 0) {
    errors.push(`${path}.periodMs: обязательное поле — положительный период в мс, получено ${typeName(v.periodMs)}`);
  }
  if (!isFiniteNumber(v.alpha) || v.alpha < 0 || v.alpha > 1) {
    errors.push(`${path}.alpha: обязательное поле — множитель альфы в [0..1], получено ${typeName(v.alpha)}`);
  }
}

/**
 * Границы числа записи словами — их и печатает находка поля. Целых чисел сюда
 * не приходит: у выборок следа находка своя, со своими словами.
 */
function effectRangeText(spec: ManifestFieldSpec): string {
  if (spec.min === undefined) return 'конечное число';
  return spec.max === undefined ? `число >= ${spec.min}` : `число в [${spec.min}..${spec.max}]`;
}

/**
 * Необязательные числа записи эффекта — те, у которых находка общая. Радиус и
 * выборки следа через этот проход не идут: о них сказано своими находками выше
 * (см. {@link OWN_FINDING}).
 */
function validateEffectNumbers(
  v: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  for (const spec of EFFECT_NUMBERS) {
    if (!(spec.name in v)) continue;
    const value = v[spec.name];
    if (!isFiniteNumber(value) || !inBounds(spec, value)) {
      errors.push(`${path}.${spec.name}: ожидалось ${effectRangeText(spec)}, получено ${typeName(value)}`);
    }
  }
}

/**
 * Значение таблицы эффектов: одна запись либо СПИСОК записей (REND-23). Список
 * — потому что у источника бывает несколько изображений: шар снаряда и его
 * след. Одна запись остаётся законной формой: массив из одного элемента ради
 * единообразия автор писать не обязан.
 *
 * Пустой список отвергается: источник, не рисующий ничего, — почти всегда
 * недописанная правка, а молчаливо принятый он выглядит как сломанный эффект.
 */
function validateEffectEntry(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    validateEffect(v, path, errors);
    return;
  }
  if (v.length === 0) {
    errors.push(`${path}: список изображений пуст — источнику нечего рисовать`);
    return;
  }
  v.forEach((record, index) => {
    validateEffect(record, `${path}[${String(index)}]`, errors);
  });
}

/** Секция транзиентных эффектов (REND-23): три таблицы «имя → запись эффекта». */
export function validateEffects(section: unknown, errors: string[]): void {
  validateSourceTables(section, 'effects', 'эффект', validateEffectEntry, errors);
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
