/**
 * Секции камеры в манифесте визуалов: эффекты камеры (ASSET-8) и конфиг камеры
 * (ASSET-10) — их состав, машинные описания, по которым секции проверяются, и
 * сама валидация.
 *
 * Живут отдельно от `manifest.ts` по тому же основанию, по какому отдельно живёт
 * блок света записи (`visualLight.ts`): это самостоятельный формат со своим
 * составом и своими адресами находок, а манифест только называет его секцией.
 *
 * Своего перечня типов эффектов и параметров конфига здесь нет и быть не должно
 * (CAM-9, CAM-1): перечень живёт в коде камеры и приезжает сюда описанием —
 * второй перечень, заведённый в модуле ассетов, разошёлся бы с камерой молча.
 */
import { closedKeys, isFiniteNumber, isRecord, typeName } from './validation.js';

/**
 * Секция эффектов камеры (ASSET-8): таблицы «тип события тика → импульсный
 * эффект» и «компонента-состояние сущности → длящийся эффект». Набор типов
 * эффектов определяется кодом камеры; привязка и числа — только здесь.
 * Запись с неизвестным типом эффекта — предупреждение и пропуск на
 * потребителе, не ошибка валидации: манифест переживает код.
 */
export interface CameraEffectsSection {
  events?: Record<string, CameraEffectDef>;
  states?: Record<string, CameraEffectDef>;
}

/** Тип эффекта плюс его числовые параметры (амплитуда, частота, радиус…). */
export interface CameraEffectDef {
  effect: string;
  [param: string]: string | number;
}

/**
 * Вид эффекта (`camera` CAM-9): импульсный запускается событием тика, длящийся
 * висит, пока на цели есть состояние. Вид определяет, в какой из двух таблиц
 * секции запись законна.
 */
export type CameraEffectKind = 'impulse' | 'lasting';

/**
 * Параметр эффекта: имя, значение по умолчанию и границы осмысленности (CAM-9).
 * Границы — не окно вкуса: код камеры знает, что амплитуда неотрицательна, но
 * не знает, какая тряска уместна на этой арене (механизм против политики).
 */
export interface CameraEffectParamSpec {
  readonly name: string;
  readonly defaultValue: number;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Описание одного типа эффекта (CAM-9). Фабрики эффекта здесь нет и быть не
 * может: она render-специфична, а этот контракт — вход валидации секции, то
 * есть принадлежит формату (ASSET-8). Слой эффектов расширяет его своим типом.
 */
export interface CameraEffectTypeSpec {
  /** Значение `effect` записи манифеста, которым запись ссылается на тип. */
  readonly id: string;
  readonly kind: CameraEffectKind;
  readonly params: readonly CameraEffectParamSpec[];
}

/**
 * Машинное описание типов эффектов камеры (CAM-9) — вход валидации секции
 * (ASSET-8). Модуль ассетов знает ФОРМУ описания, но не его содержимое:
 * перечень типов живёт в коде камеры, и второго перечня здесь не заводится.
 *
 * `binding` — параметры самой привязки, общие для всех записей одного вида
 * (сила импульса и радиус ослабления у импульсных). Собирающему запись они
 * неотличимы от параметров типа; различие видно только тому, кто строит эффект.
 */
export interface CameraEffectsDescription {
  readonly types: readonly CameraEffectTypeSpec[];
  readonly binding: Readonly<Record<CameraEffectKind, readonly CameraEffectParamSpec[]>>;
}

/** Тип по идентификатору записи; `undefined` — описание такого типа не объявляет. */
export function cameraEffectType(
  description: CameraEffectsDescription,
  id: string,
): CameraEffectTypeSpec | undefined {
  return description.types.find((type) => type.id === id);
}

/**
 * Все параметры, законные в записи данного типа: параметры типа плюс параметры
 * привязки его вида. Один ответ на весь репозиторий — им пользуются и валидация
 * секции, и слой эффектов, и редактор.
 */
export function cameraEffectParams(
  description: CameraEffectsDescription,
  type: CameraEffectTypeSpec,
): readonly CameraEffectParamSpec[] {
  return [...type.params, ...description.binding[type.kind]];
}

/**
 * Нижняя граница «строго положительно» — наименьшее представимое положительное
 * число. Границы описания включающие (`min`/`max`), и строгую положительность,
 * о которой CAM-9 говорит прямым текстом («частота положительна»), в них
 * выражает именно она: любое положительное значение её проходит, ноль и
 * отрицательное — нет.
 *
 * Названа, а не написана числом на месте, ради двух вещей: код камеры объявляет
 * ею положительные параметры одним словом, а `cameraEffectRangeText` печатает по
 * ней открытый ноль вместо `5e-324` — граница адресована автору манифеста, а не
 * читателю представления чисел.
 */
export const POSITIVE_MIN = Number.MIN_VALUE;

/**
 * Диапазон параметра интервальной записью: `[0..+∞)`, `[0..10]`, `(0..+∞)`.
 * Скобка называет включение границы, и строго положительный минимум показан
 * открытым нулём.
 */
export function cameraEffectRangeText(spec: CameraEffectParamSpec): string {
  const low = spec.min === undefined ? '(-∞' : spec.min === POSITIVE_MIN ? '(0' : `[${spec.min}`;
  const high = spec.max === undefined ? '+∞)' : `${spec.max}]`;
  return `${low}..${high}`;
}

/**
 * Значение в объявленных границах? Один ответ на весь репозиторий: им судят и
 * валидация секции (ошибка, ASSET-8), и операция редактора (отказ) — второе
 * сравнение разошлось бы с первым молча.
 */
export function cameraEffectParamInRange(spec: CameraEffectParamSpec, value: number): boolean {
  if (spec.min !== undefined && value < spec.min) return false;
  return !(spec.max !== undefined && value > spec.max);
}

/**
 * Значение параметра, приведённое к объявленным границам (CAM-6). Для строго
 * положительной границы приведение точно по построению: `POSITIVE_MIN` —
 * ближайшее к нулю положительное число, и ближе к запрошенному нулю привести
 * нельзя.
 */
export function clampCameraEffectParam(spec: CameraEffectParamSpec, value: number): number {
  const low = spec.min === undefined ? value : Math.max(spec.min, value);
  return spec.max === undefined ? low : Math.min(spec.max, low);
}

/**
 * Секция конфига камеры (ASSET-10): значения настроечных чисел единого конфига
 * камеры (`camera` CAM-1) — наклон, дистанция и лимиты зума, FOV, скорости,
 * константы сглаживания, ширина edge-зоны, глобальный множитель силы эффектов
 * (CAM-6). Секция задаёт ЗНАЧЕНИЯ; состав параметров и их умолчания принадлежат
 * коду камеры, и манифест их перечня не нормирует — отсюда открытая запись
 * «имя параметра → число», а не именованные поля.
 *
 * Отсутствие секции или отдельного параметра означает умолчание кода.
 */
export type CameraConfigSection = Record<string, number>;

/**
 * Машинное описание конфига камеры (CAM-1) — вход валидации секции (ASSET-10),
 * как описание типов эффектов у секции эффектов (ASSET-8). Перечень параметров
 * живёт в коде камеры и приезжает сюда аргументом: второй перечень, заведённый
 * в модуле ассетов, разошёлся бы с камерой молча.
 */
export interface CameraConfigDescription {
  /** Имена параметров, которые знает код камеры. */
  readonly params: readonly string[];
}

/**
 * Секция конфига камеры (ASSET-10). Числовая природа значений проверяется
 * всегда — это структура секции, и проверяют её все потребители одинаково,
 * подали им описание или нет: иначе один и тот же документ был бы валиден у
 * клиента и невалиден у редактора.
 *
 * Знание о СОСТАВЕ параметров приходит только описанием (CAM-1). Параметр, им
 * не объявленный, — предупреждение и пропуск, а не ошибка: та же граница
 * переживания манифестом кода, что у секции эффектов (ASSET-8), и документ,
 * написанный для сборки камеры с другим набором параметров, обязан оставаться
 * загружаемым.
 */
export function validateCameraConfig(
  section: unknown,
  errors: string[],
  warnings: string[],
  description: CameraConfigDescription | undefined,
): void {
  const path = 'cameraConfig';
  if (!isRecord(section)) {
    errors.push(`${path}: ожидался объект «параметр камеры → число», получено ${typeName(section)}`);
    return;
  }
  for (const [param, value] of Object.entries(section)) {
    if (!isFiniteNumber(value)) {
      errors.push(
        `${path}.${param}: параметр конфига камеры — конечное число, получено ${typeName(value)}`,
      );
    }
    if (description !== undefined && !description.params.includes(param)) {
      warnings.push(
        `${path}.${param}: параметр конфигом камеры не объявлен — он будет пропущен (допустимы: ${description.params.join(', ')})`,
      );
    }
  }
}

/** Вид эффекта, законный в таблице секции: у `events` — импульсный, у `states` — длящийся. */
const TABLE_KIND: Readonly<Record<'events' | 'states', CameraEffectKind>> = Object.freeze({
  events: 'impulse',
  states: 'lasting',
});

/**
 * Секция эффектов камеры (ASSET-8). Структура проверяется строго (typo —
 * ошибка), а типы эффектов — только если валидации передали их описание
 * (CAM-9): своего перечня типов у модуля ассетов нет и быть не должно, иначе он
 * стал бы вторым перечнем к перечню камеры и разошёлся бы с ним молча.
 *
 * Разделение находок задано ASSET-8. Неизвестный тип, тип другого вида, чем
 * таблица, и незаявленный параметр — предупреждения: манифест переживает код, и
 * документ, написанный для сборки камеры с другим набором типов, обязан
 * оставаться загружаемым. Значение вне объявленного диапазона — ошибка: тип
 * известен, границу назвал тот же код, который это число прочтёт, а молчаливое
 * приведение к границе (CAM-6) — поведение кадра, а не разрешение писать такое
 * на диск.
 */
export function validateCameraEffects(
  section: unknown,
  errors: string[],
  warnings: string[],
  description: CameraEffectsDescription | undefined,
): void {
  const path = 'cameraEffects';
  if (!isRecord(section)) {
    errors.push(`${path}: ожидался объект { events?, states? }, получено ${typeName(section)}`);
    return;
  }
  closedKeys(section, path, ['events', 'states'], errors);
  for (const table of ['events', 'states'] as const) {
    if (!(table in section)) continue;
    const entries = section[table];
    if (!isRecord(entries)) {
      errors.push(`${path}.${table}: ожидался объект «имя → эффект», получено ${typeName(entries)}`);
      continue;
    }
    for (const [name, def] of Object.entries(entries)) {
      validateEffectEntry(def, `${path}.${table}.${name}`, TABLE_KIND[table], description, errors, warnings);
    }
  }
}

/**
 * Одна запись таблицы: сперва структура (она проверяется всегда), затем — если
 * описание камеры подано — сама запись против объявленного типа (CAM-9).
 */
function validateEffectEntry(
  def: unknown,
  defPath: string,
  kind: CameraEffectKind,
  description: CameraEffectsDescription | undefined,
  errors: string[],
  warnings: string[],
): void {
  if (!isRecord(def)) {
    errors.push(`${defPath}: ожидался объект { effect, …параметры }, получено ${typeName(def)}`);
    return;
  }
  if (typeof def.effect !== 'string' || def.effect.length === 0) {
    errors.push(`${defPath}.effect: обязательное поле — тип эффекта (непустая строка)`);
  }
  for (const [param, value] of Object.entries(def)) {
    if (param === 'effect') continue;
    if (!isFiniteNumber(value)) {
      errors.push(`${defPath}.${param}: параметр эффекта — конечное число, получено ${typeName(value)}`);
    }
  }
  if (description === undefined || typeof def.effect !== 'string') return;
  validateEffectAgainstDescription(def, defPath, kind, description, errors, warnings);
}

/** Запись против описания типов (CAM-9): своих правил о типах здесь нет. */
function validateEffectAgainstDescription(
  def: Record<string, unknown>,
  defPath: string,
  kind: CameraEffectKind,
  description: CameraEffectsDescription,
  errors: string[],
  warnings: string[],
): void {
  const id = def.effect as string;
  const type = cameraEffectType(description, id);
  if (type === undefined) {
    warnings.push(
      `${defPath}.effect: тип эффекта "${id}" описанием камеры не объявлен — запись будет пропущена (CAM-9)`,
    );
    return;
  }
  if (type.kind !== kind) {
    warnings.push(
      `${defPath}.effect: тип "${id}" объявлен как ${type.kind}, а таблица требует ${kind} — запись будет пропущена`,
    );
    return;
  }
  const declared = new Map(cameraEffectParams(description, type).map((spec) => [spec.name, spec]));
  for (const [param, value] of Object.entries(def)) {
    if (param === 'effect') continue;
    const spec = declared.get(param);
    if (spec === undefined) {
      warnings.push(
        `${defPath}.${param}: параметр типом "${id}" не объявлен — он будет проигнорирован (допустимы: ${[...declared.keys()].join(', ')})`,
      );
      continue;
    }
    if (!isFiniteNumber(value)) continue; // о не-числе уже сказано ошибкой выше
    if (!cameraEffectParamInRange(spec, value)) {
      errors.push(
        `${defPath}.${param}: значение ${value} вне диапазона ${cameraEffectRangeText(spec)}, объявленного типом "${id}"`,
      );
    }
  }
}

// ------------------------------------- пути камеры (ASSET-17, `camera` CAM-10)

/**
 * Секция кинематографических путей камеры (ASSET-17): «имя пути → путь».
 * Значения принадлежат документу; состав каналов ключа, их границы и перечень
 * имён сглаживания — коду камеры (CAM-10) и приезжают сюда описанием. Своего
 * перечня у модуля ассетов нет и быть не должно — по тем же основаниям, по
 * каким его нет у секций ASSET-8 и ASSET-10.
 */
export type CameraPathsSection = Record<string, CameraPathDef>;

/** Один путь: ключи и признак кольца. */
export interface CameraPathDef {
  readonly keys: readonly CameraPathKeyDef[];
  /** Путь идёт по кругу, пока его не остановят (CAM-10); нет — false. */
  readonly loop?: boolean;
}

/**
 * Ключ пути: каналы позы плюс длительность до СЛЕДУЮЩЕГО ключа и имя
 * сглаживания параметра отрезка. Открытая запись, потому что перечень каналов
 * нормирует код камеры, а не формат.
 */
export interface CameraPathKeyDef {
  /** Секунды до следующего ключа; у последнего ключа не читается. */
  readonly duration?: number;
  /** Имя сглаживания из описания (CAM-10); нет — линейное. */
  readonly easing?: string;
  readonly [channel: string]: number | string | undefined;
}

/**
 * Канал ключа: имя, обязательность и границы осмысленности (CAM-10). Границы —
 * не окно вкуса: камера знает, что дистанция положительна, но не знает, какой
 * облёт уместен на этой арене (механизм против политики).
 */
export interface CameraPathChannelSpec {
  readonly name: string;
  readonly required: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** Машинное описание пути (CAM-10) — вход валидации секции (ASSET-17). */
export interface CameraPathDescription {
  readonly channels: readonly CameraPathChannelSpec[];
  readonly easings: readonly string[];
}

/** Служебные поля ключа, каналами не являющиеся. */
const PATH_KEY_META: readonly string[] = ['duration', 'easing'];
const PATH_KEYS: readonly string[] = ['keys', 'loop'];

/**
 * Секция путей камеры (ASSET-17). Структура проверяется всегда и строго: путь
 * без ключей, ключ без точки наблюдения и неположительная длительность —
 * ошибки, а не предупреждения; такой документ не о пути, а об опечатке.
 *
 * Знание о СОСТАВЕ каналов и перечне сглаживаний приходит только описанием
 * (CAM-10). Канал и имя сглаживания, им не объявленные, — предупреждение и
 * пропуск: та же граница переживания манифестом кода, что у ASSET-8 и ASSET-10.
 */
export function validateCameraPaths(
  section: unknown,
  errors: string[],
  warnings: string[],
  description: CameraPathDescription | undefined,
): void {
  const root = 'cameraPaths';
  if (!isRecord(section)) {
    errors.push(`${root}: ожидался объект «имя пути → путь», получено ${typeName(section)}`);
    return;
  }
  for (const [name, path] of Object.entries(section)) {
    validateOnePath(path, `${root}.${name}`, errors, warnings, description);
  }
}

function validateOnePath(
  path: unknown,
  at: string,
  errors: string[],
  warnings: string[],
  description: CameraPathDescription | undefined,
): void {
  if (!isRecord(path)) {
    errors.push(`${at}: ожидалась запись пути, получено ${typeName(path)}`);
    return;
  }
  closedKeys(path, at, PATH_KEYS, errors);
  if (path.loop !== undefined && typeof path.loop !== 'boolean') {
    errors.push(`${at}.loop: ожидался флаг, получено ${typeName(path.loop)}`);
  }
  const keys = path.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    errors.push(`${at}.keys: ожидался непустой список ключей пути`);
    return;
  }
  keys.forEach((key, index) => {
    validatePathKey(key, `${at}.keys[${String(index)}]`, index === keys.length - 1, errors, warnings, description);
  });
}

function validatePathKey(
  key: unknown,
  at: string,
  last: boolean,
  errors: string[],
  warnings: string[],
  description: CameraPathDescription | undefined,
): void {
  if (!isRecord(key)) {
    errors.push(`${at}: ожидалась запись ключа, получено ${typeName(key)}`);
    return;
  }
  validateKeyTiming(key, at, last, errors, warnings, description);
  validateKeyChannels(key, at, errors, warnings, description);
}

/** Длительность до следующего ключа и имя сглаживания параметра отрезка (CAM-10). */
function validateKeyTiming(
  key: Record<string, unknown>,
  at: string,
  last: boolean,
  errors: string[],
  warnings: string[],
  description: CameraPathDescription | undefined,
): void {
  // Длительность последнего ключа не читается — идти после него некуда, — но
  // названная негодной остаётся опечаткой и на нём.
  if (key.duration !== undefined) {
    if (!isFiniteNumber(key.duration) || key.duration <= 0) {
      errors.push(
        `${at}.duration: ожидалось положительное число секунд, получено ${typeName(key.duration)}`,
      );
    }
  } else if (!last) {
    errors.push(`${at}.duration: длительность до следующего ключа обязательна`);
  }
  if (key.easing === undefined) return;
  if (typeof key.easing !== 'string') {
    errors.push(`${at}.easing: ожидалось имя сглаживания, получено ${typeName(key.easing)}`);
    return;
  }
  if (description !== undefined && !description.easings.includes(key.easing)) {
    warnings.push(
      `${at}.easing: сглаживание "${key.easing}" камере неизвестно — будет линейное ` +
        `(допустимы: ${description.easings.join(', ')})`,
    );
  }
}

/** Канал вне описания: предупреждение и пропуск — манифест переживает код. */
function warnUnknownChannel(
  at: string,
  channel: string,
  warnings: string[],
  description: CameraPathDescription,
): void {
  warnings.push(
    `${at}.${channel}: канал камерой не объявлен — он будет пропущен ` +
      `(допустимы: ${description.channels.map((one) => one.name).join(', ')})`,
  );
}

/** Значение канала против границ осмысленности описания (CAM-10). */
function checkChannelRange(
  at: string,
  spec: CameraPathChannelSpec,
  value: number,
  errors: string[],
): void {
  const low = spec.min !== undefined && value < spec.min;
  const high = spec.max !== undefined && value > spec.max;
  if (!low && !high) return;
  errors.push(
    `${at}.${spec.name}: значение ${String(value)} вне допустимого диапазона ` +
      `[${String(spec.min ?? '-∞')}, ${String(spec.max ?? '+∞')}]`,
  );
}

/** Каналы позы ключа: числовая природа, объявленность описанием и границы (CAM-10). */
function validateKeyChannels(
  key: Record<string, unknown>,
  at: string,
  errors: string[],
  warnings: string[],
  description: CameraPathDescription | undefined,
): void {
  for (const [channel, value] of Object.entries(key)) {
    if (PATH_KEY_META.includes(channel)) continue;
    if (!isFiniteNumber(value)) {
      errors.push(`${at}.${channel}: канал ключа — конечное число, получено ${typeName(value)}`);
      continue;
    }
    const spec = description?.channels.find((one) => one.name === channel);
    if (spec !== undefined) checkChannelRange(at, spec, value, errors);
    else if (description !== undefined) warnUnknownChannel(at, channel, warnings, description);
  }
  for (const spec of description?.channels ?? []) {
    if (spec.required && !isFiniteNumber(key[spec.name])) {
      errors.push(`${at}.${spec.name}: обязательный канал ключа не назван либо не число`);
    }
  }
}
