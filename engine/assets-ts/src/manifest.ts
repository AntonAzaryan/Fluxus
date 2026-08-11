/* eslint-disable max-lines -- baseline */
/**
 * Манифест визуалов (ASSET-6): data-driven JSON-документ «sim-идентификатор
 * сущности → визуал», отдельный от конфига сцены. Ссылки направлены только из
 * манифеста в sim-идентификаторы (имена prefab'ов); sim-описания сущностей
 * путей к presentation-ассетам не содержат. Правка манифеста не меняет
 * `worldInit`, снапшоты, golden-файлы и совместимость реплеев.
 *
 * Манифест — политика, не механизм: какая модель у юнита, какой клип на какое
 * действие, какие лимиты у поворота головы — решает этот JSON, а не код.
 *
 * Разделов записей два (ASSET-9): `entities` ключуется sim-идентификатором, а
 * `decorations` — ключом вида, за которым в симуляции нет ничего. Состав записи
 * у них общий, пространство ключей — тоже одно, и разрешает ключ в запись одна
 * функция (`resolveVisual`), а не каждый потребитель по-своему.
 */

/** Ключ — sim-идентификатор (имя prefab'а/архетипа). */
export interface VisualManifest {
  entities: Record<string, EntityVisual>;
  /**
   * Раздел decoration-видов (ASSET-9): записи того же состава, что записи
   * сущностей, но за ключом которых в симуляции нет ничего — ни prefab'а, ни
   * архетипа. Отдельный раздел, а не ключи в `entities`, потому что `entities`
   * ключуется sim-идентификатором, а ED-19 требует подсвечивать «запись
   * манифеста без prefab'а» как рассинхронизацию пары: попади decoration-виды
   * туда, каждый из них стал бы находкой валидации.
   *
   * Ключи обоих разделов лежат в ОДНОМ пространстве (ASSET-9): потребитель
   * разрешает визуальный ключ в запись одним способом (`resolveVisual`), а два
   * раздела с пересекающимися именами сделали бы ответ зависящим от порядка
   * просмотра. Поэтому пересечение имён — ошибка валидации манифеста.
   */
  decorations?: Record<string, EntityVisual>;
  /** Дефолт наклона по поверхности для записей без своего surfaceAlign (REND-10). */
  surfaceAlign?: SurfaceAlign;
  /** Presentation-данные террейна арены. */
  terrain?: { curvatureMap?: string };
  /** Секция эффектов камеры (ASSET-8); потребитель — `camera` CAM-6. */
  cameraEffects?: CameraEffectsSection;
  /** Секция конфига камеры (ASSET-10); потребитель — конвейер `camera` CAM-1. */
  cameraConfig?: CameraConfigSection;
}

/**
 * Запись визуального ключа — одно место разрешения на оба раздела (ASSET-9).
 * Потребители зовут его, а не читают раздел сами: пространство ключей одно, и
 * выбор раздела не должен становиться решением каждого вызывающего.
 *
 * Порядок просмотра здесь ни на что не влияет: пересечение имён отвергается
 * валидацией манифеста, поэтому ключ разрешается не более чем в одну запись.
 */
export function resolveVisual(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
  key: string,
): EntityVisual | undefined {
  return manifest.entities[key] ?? manifest.decorations?.[key];
}

/**
 * Все визуальные ключи манифеста в одном пространстве (ASSET-9) — то, из чего
 * автор выбирает вид для размещения (`presentation-scene` PRES-2) и по чему
 * валидация редактора судит о разрешимости ссылки.
 */
export function visualKeys(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
): readonly string[] {
  return [...Object.keys(manifest.entities), ...Object.keys(manifest.decorations ?? {})];
}

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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
  return [...type.params, ...(description.binding[type.kind] ?? [])];
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
function validateCameraConfig(
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

/**
 * Наклон инстанса по нормали визуальной поверхности (REND-10): up-вектор —
 * slerp(вертикаль, нормаль, factor); maxAngleDeg ограничивает итоговое
 * отклонение от вертикали при любом factor.
 */
export interface SurfaceAlign {
  /** 0 — всегда вертикален, 1 — перпендикулярен поверхности. */
  factor: number;
  maxAngleDeg?: number;
}

/** Дефолт REND-10: перпендикулярен поверхности, без лимита угла. */
export const DEFAULT_SURFACE_ALIGN: Readonly<SurfaceAlign> = Object.freeze({ factor: 1 });

/**
 * Вертикальное смещение инстанса (REND-12): дуга прыжка и снижение при
 * провале. Вертикали в симуляции нет (`locomotion` LOC-5), поэтому числа
 * художественные и живут только здесь. Все поля опциональны, отсутствие
 * означает отсутствие смещения — глобального дефолта у секции намеренно нет:
 * высота прыжка — свойство персонажа, а не мира (в отличие от наклона).
 */
export interface VerticalOffset {
  /** Максимум дуги прыжка в мировых единицах; без него дуги нет. */
  jumpArc?: number;
  /** Скорость снижения при провале, мировых единиц в секунду. */
  fallSpeed?: number;
  /** На сколько инстанс уходит вниз и там останавливается. */
  fallDepth?: number;
}

/**
 * Ярус представления инстанса (`rendering` REND-20), заданный записью явно
 * (ASSET-13). Батчевый — разделяемый батч со скиннингом по запечённым данным;
 * детальный — пер-инстансное поддерево со скелетом.
 */
export type VisualTier = 'batched' | 'detailed';

/**
 * Пороги LOD по умолчанию (ASSET-13, `rendering` REND-22): доля высоты кадра,
 * ниже которой инстанс переходит на следующий уровень цепочки. Это УМОЛЧАНИЕ
 * кода, а не политика: запись, которой числа важны, задаёт свои — художник
 * правит манифест, а не рендер.
 */
export const DEFAULT_LOD_THRESHOLDS: readonly number[] = Object.freeze([0.12, 0.05]);

/**
 * Ярус записи (ASSET-13): явное поле записи → умолчание. Умолчание — батчевый,
 * кроме записей с настроенным процедурным контролем костей (`rendering`
 * REND-5): им нужен настоящий скелет, и батчевого яруса они не переживут.
 *
 * Один ответ на весь репозиторий: выбор яруса не должен становиться решением
 * каждого потребителя — иначе рендер и редактор разошлись бы в том, что автор
 * увидит в кадре.
 */
export function resolveVisualTier(visual: EntityVisual | undefined): VisualTier {
  if (visual?.tier !== undefined) return visual.tier;
  return visual?.boneControls === undefined ? 'batched' : 'detailed';
}

/** Пороги LOD записи: свои → умолчание кода (ASSET-13). */
export function resolveLodThresholds(visual: EntityVisual | undefined): readonly number[] {
  return visual?.lodThresholds ?? DEFAULT_LOD_THRESHOLDS;
}

/** Параметры наклона записи: свои → дефолт манифеста → дефолт спеки (ASSET-6). */
export function resolveSurfaceAlign(
  manifest: Pick<VisualManifest, 'surfaceAlign'>,
  visual: EntityVisual | undefined,
): SurfaceAlign {
  return visual?.surfaceAlign ?? manifest.surfaceAlign ?? DEFAULT_SURFACE_ALIGN;
}

export interface EntityVisual {
  /** Asset id модели. */
  model: string;
  /** Мировая высота юнита; по умолчанию 1. */
  scale?: number;
  /**
   * Куда смотрит МОДЕЛЬ в канонических осях модуля — угол в градусах против
   * часовой стрелки от `+X` (REND-13). Это описание самой модели, а не поправка
   * к курсу: поправку рендер выводит сам.
   *
   * Перёд — свойство авторинга модели, а не системы координат: канонические оси
   * (ASSET-5) фиксируют, где верх и какова единица длины, но не то, куда
   * повёрнуто лицо, и вывести это из файла нельзя. Поэтому значение живёт в
   * записи, а не одним числом на всех: модели разных форматов с разным передом
   * сосуществуют в одной сцене.
   *
   * Примеры: у моделей MDX лицо вдоль `+X` — это `0` (и умолчание при
   * отсутствии поля); у glTF-модели, чьё лицо смотрит вдоль `−Y`, это `-90`.
   */
  facingDeg?: number;
  defaultSkin?: string;
  /** Имя скина → (номер textureSlot как строка → asset id текстуры). */
  skins?: Record<string, Record<string, string>>;
  /** Состояние рендера ('idle', 'move', 'dodge', 'roll', 'jump', 'fall') → подстрока имени клипа; имя события → подстрока имени клипа (REND-4). */
  animations?: { states?: Record<string, string>; events?: Record<string, string> };
  /** Роль ('torso', 'head') → параметры процедурного контроля кости (REND-5). */
  boneControls?: Record<string, { bone: string; maxYawDeg: number; smoothing: number }>;
  /** Индексы частей модели (`NormalizedMesh.partId`), исключаемых из рендера. */
  hiddenParts?: number[];
  /** Наклон по нормали визуальной поверхности; без него — дефолт манифеста (REND-10). */
  surfaceAlign?: SurfaceAlign;
  /** Дуга прыжка и снижение при провале (REND-12); без секции — смещения нет. */
  verticalOffset?: VerticalOffset;
  /**
   * Ярус представления инстанса (ASSET-13, `rendering` REND-20). Без поля —
   * умолчание `resolveVisualTier`: батчевый, кроме записей с `boneControls`.
   * Поле — политика вида: художник переводит штучную крупную модель в детальный
   * ярус, не правя код рендера.
   */
  tier?: VisualTier;
  /**
   * Пороги переключения LOD-цепочки (ASSET-13, `rendering` REND-22): доли
   * высоты кадра, строго убывающие. Без поля — умолчания
   * `DEFAULT_LOD_THRESHOLDS`; модель без цепочки уровней порогов не замечает.
   */
  lodThresholds?: number[];
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Ругаемся на неизвестные поля: в data-driven документе это почти всегда опечатка. */
function checkUnknownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      errors.push(`${path}.${key}: неизвестное поле (допустимы: ${known.join(', ')})`);
    }
  }
}

/** Запись «строка → строка» с непустыми значениями. */
function validateStringMap(v: unknown, path: string, what: string, errors: string[]): void {
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
function validateSurfaceAlign(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { factor, maxAngleDeg? }, получено ${typeName(v)}`);
    return;
  }
  checkUnknownKeys(v, ['factor', 'maxAngleDeg'], path, errors);
  if (!isFiniteNumber(v.factor) || v.factor < 0 || v.factor > 1) {
    errors.push(`${path}.factor: обязательное поле — число в [0..1], получено ${typeName(v.factor)}`);
  }
  if ('maxAngleDeg' in v && (!isFiniteNumber(v.maxAngleDeg) || v.maxAngleDeg < 0)) {
    errors.push(`${path}.maxAngleDeg: ожидалось неотрицательное число градусов`);
  }
}

/** `verticalOffset` записи: все поля опциональны и неотрицательны (REND-12). */
function validateVerticalOffset(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(
      `${path}: ожидался объект { jumpArc?, fallSpeed?, fallDepth? }, получено ${typeName(v)}`,
    );
    return;
  }
  const fields = ['jumpArc', 'fallSpeed', 'fallDepth'] as const;
  checkUnknownKeys(v, fields, path, errors);
  for (const field of fields) {
    const value = v[field];
    if (field in v && (!isFiniteNumber(value) || value < 0)) {
      errors.push(`${path}.${field}: ожидалось неотрицательное число мировых единиц`);
    }
  }
}

/** Ярусы, которые запись вправе назвать (ASSET-13); перечень закрыт рендером. */
const VISUAL_TIERS: readonly VisualTier[] = ['batched', 'detailed'];

/**
 * `lodThresholds` записи (ASSET-13): доли высоты кадра в `(0..1]`, строго
 * убывающие. Строгое убывание — не придирка: порог, не меньший предыдущего,
 * означает уровень, который не выбирается никогда, и молча пропасть такая
 * запись не должна.
 */
function validateLodThresholds(v: unknown, path: string, errors: string[]): void {
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

function validateEntity(entity: unknown, path: string, errors: string[]): void {
  if (!isRecord(entity)) {
    errors.push(`${path}: ожидался объект визуала, получено ${typeName(entity)}`);
    return;
  }
  checkUnknownKeys(
    entity,
    [
      'model',
      'scale',
      'facingDeg',
      'defaultSkin',
      'skins',
      'animations',
      'boneControls',
      'hiddenParts',
      'surfaceAlign',
      'verticalOffset',
      'tier',
      'lodThresholds',
    ],
    path,
    errors,
  );

  if ('surfaceAlign' in entity) {
    validateSurfaceAlign(entity.surfaceAlign, `${path}.surfaceAlign`, errors);
  }

  // Параметры батчевой отрисовки (ASSET-13): действуют одинаково на оба
  // раздела манифеста — запись decoration задаёт их так же, как запись
  // сущности, и валидируются они тем же проходом.
  if ('tier' in entity && !VISUAL_TIERS.includes(entity.tier as VisualTier)) {
    errors.push(
      `${path}.tier: ожидался ярус представления (${VISUAL_TIERS.join(' | ')}), получено ${typeName(entity.tier)}`,
    );
  }

  if ('lodThresholds' in entity) {
    validateLodThresholds(entity.lodThresholds, `${path}.lodThresholds`, errors);
  }

  if ('verticalOffset' in entity) {
    validateVerticalOffset(entity.verticalOffset, `${path}.verticalOffset`, errors);
  }

  if (typeof entity.model !== 'string' || entity.model.length === 0) {
    errors.push(`${path}.model: обязательное поле — непустая строка (asset id модели)`);
  }

  if ('scale' in entity && (!isFiniteNumber(entity.scale) || entity.scale <= 0)) {
    errors.push(`${path}.scale: ожидалось положительное число, получено ${typeName(entity.scale)}`);
  }

  // Диапазон не ограничиваем: угол заворачивается, и «-90» и «270» одинаково
  // законны — требовать канонической записи значило бы придираться к автору.
  if ('facingDeg' in entity && !isFiniteNumber(entity.facingDeg)) {
    errors.push(
      `${path}.facingDeg: ожидался угол переда модели в градусах (число), получено ${typeName(entity.facingDeg)}`,
    );
  }

  const skins = entity.skins;
  if ('skins' in entity) {
    if (!isRecord(skins)) {
      errors.push(`${path}.skins: ожидался объект «имя скина → подмены слотов», получено ${typeName(skins)}`);
    } else {
      for (const [skinName, slots] of Object.entries(skins)) {
        const skinPath = `${path}.skins.${skinName}`;
        if (!isRecord(slots)) {
          errors.push(`${skinPath}: ожидался объект «номер textureSlot → asset id текстуры», получено ${typeName(slots)}`);
          continue;
        }
        for (const [slot, tex] of Object.entries(slots)) {
          // eslint-disable-next-line max-depth -- baseline
          if (!/^\d+$/.test(slot)) {
            errors.push(`${skinPath}: ключ "${slot}" не является номером textureSlot`);
          }
          // eslint-disable-next-line max-depth -- baseline
          if (typeof tex !== 'string' || tex.length === 0) {
            errors.push(`${skinPath}.${slot}: ожидался asset id текстуры (непустая строка), получено ${typeName(tex)}`);
          }
        }
      }
    }
  }

  if ('defaultSkin' in entity) {
    if (typeof entity.defaultSkin !== 'string' || entity.defaultSkin.length === 0) {
      errors.push(`${path}.defaultSkin: ожидалась непустая строка, получено ${typeName(entity.defaultSkin)}`);
    } else if (!isRecord(skins) || !(entity.defaultSkin in skins)) {
      errors.push(`${path}.defaultSkin: скин "${entity.defaultSkin}" не описан в ${path}.skins`);
    }
  }

  if ('animations' in entity) {
    const anims = entity.animations;
    if (!isRecord(anims)) {
      errors.push(`${path}.animations: ожидался объект, получено ${typeName(anims)}`);
    } else {
      checkUnknownKeys(anims, ['states', 'events'], `${path}.animations`, errors);
      if ('states' in anims) {
        validateStringMap(anims.states, `${path}.animations.states`, 'состояние → подстрока имени клипа', errors);
      }
      if ('events' in anims) {
        validateStringMap(anims.events, `${path}.animations.events`, 'событие → подстрока имени клипа', errors);
      }
    }
  }

  if ('boneControls' in entity) {
    const controls = entity.boneControls;
    if (!isRecord(controls)) {
      errors.push(`${path}.boneControls: ожидался объект «роль → параметры», получено ${typeName(controls)}`);
    } else {
      for (const [role, control] of Object.entries(controls)) {
        const rolePath = `${path}.boneControls.${role}`;
        if (!isRecord(control)) {
          errors.push(`${rolePath}: ожидался объект { bone, maxYawDeg, smoothing }, получено ${typeName(control)}`);
          continue;
        }
        checkUnknownKeys(control, ['bone', 'maxYawDeg', 'smoothing'], rolePath, errors);
        if (typeof control.bone !== 'string' || control.bone.length === 0) {
          errors.push(`${rolePath}.bone: обязательное поле — имя кости (непустая строка)`);
        }
        if (!isFiniteNumber(control.maxYawDeg) || control.maxYawDeg < 0) {
          errors.push(`${rolePath}.maxYawDeg: ожидалось неотрицательное число градусов`);
        }
        if (!isFiniteNumber(control.smoothing) || control.smoothing < 0) {
          errors.push(`${rolePath}.smoothing: ожидалось неотрицательное число`);
        }
      }
    }
  }

  if ('hiddenParts' in entity) {
    const hidden = entity.hiddenParts;
    if (!Array.isArray(hidden)) {
      errors.push(`${path}.hiddenParts: ожидался массив индексов частей модели, получено ${typeName(hidden)}`);
    } else {
      hidden.forEach((g, i) => {
        if (!Number.isInteger(g) || (g as number) < 0) {
          errors.push(`${path}.hiddenParts[${i}]: ожидался целый индекс части модели >= 0, получено ${typeName(g)}`);
        }
      });
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
function validateCameraEffects(
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
  checkUnknownKeys(section, ['events', 'states'], path, errors);
  for (const table of ['events', 'states'] as const) {
    if (!(table in section)) continue;
    const entries = section[table];
    if (!isRecord(entries)) {
      errors.push(`${path}.${table}: ожидался объект «имя → эффект», получено ${typeName(entries)}`);
      continue;
    }
    for (const [name, def] of Object.entries(entries)) {
      const defPath = `${path}.${table}.${name}`;
      if (!isRecord(def)) {
        errors.push(`${defPath}: ожидался объект { effect, …параметры }, получено ${typeName(def)}`);
        continue;
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
      if (description === undefined || typeof def.effect !== 'string') continue;
      validateEffectAgainstDescription(def, defPath, TABLE_KIND[table], description, errors, warnings);
    }
  }
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

/** Что валидация знает сверх самого документа. */
export interface ValidateManifestOptions {
  /**
   * Машинное описание типов эффектов камеры (`camera` CAM-9). Без него секция
   * эффектов проверяется только структурно: перечня типов у модуля ассетов нет
   * (ASSET-8).
   */
  readonly cameraEffects?: CameraEffectsDescription;
  /**
   * Машинное описание конфига камеры (`camera` CAM-1). Без него секция конфига
   * проверяется только структурно: перечня параметров у модуля ассетов нет
   * (ASSET-10).
   */
  readonly cameraConfig?: CameraConfigDescription;
}

/** Результат валидации: находки двух последствий (ASSET-8). */
export type ManifestValidation =
  | { ok: true; manifest: VisualManifest; warnings: readonly string[] }
  | { ok: false; errors: string[]; warnings: readonly string[] };

/**
 * Валидация документа манифеста (ASSET-6, ASSET-8). Ошибки собираются все
 * разом (не fail-fast), каждая — с путём до поля, чтобы правка JSON не
 * превращалась в угадывание. Успех возвращает документ, типизированный как
 * VisualManifest.
 *
 * Предупреждения — вторая половина ответа и приходят в обеих ветках: «нарушение
 * есть, но документ валиден» иначе не выразить, а нужно это обеим сторонам —
 * загрузчик их логирует и продолжает, редактор превращает в находки важности
 * `warning` (ASSET-8, ED-3).
 */
export function validateManifest(doc: unknown, options: ValidateManifestOptions = {}): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`манифест: ожидался объект, получено ${typeName(doc)}`], warnings };
  }
  checkUnknownKeys(
    doc,
    ['entities', 'decorations', 'surfaceAlign', 'terrain', 'cameraEffects', 'cameraConfig'],
    'манифест',
    errors,
  );
  if (!isRecord(doc.entities)) {
    errors.push(`entities: обязательное поле — объект «prefab → визуал», получено ${typeName(doc.entities)}`);
  } else {
    for (const [name, entity] of Object.entries(doc.entities)) {
      validateEntity(entity, `entities.${name}`, errors);
    }
  }
  // Раздел decoration-видов (ASSET-9): состав записи тот же, что у сущности, —
  // валидируется тем же проходом. Неприменимые к decoration части записи
  // (таблицы клипов, кости, дуга прыжка) ошибкой не считаются: запись одного
  // состава на оба раздела дешевле, чем два состава, — смысла им просто не
  // придаётся (REND-18).
  if ('decorations' in doc) {
    if (!isRecord(doc.decorations)) {
      errors.push(
        `decorations: ожидался объект «ключ вида → визуал», получено ${typeName(doc.decorations)}`,
      );
    } else {
      for (const [name, entry] of Object.entries(doc.decorations)) {
        validateEntity(entry, `decorations.${name}`, errors);
      }
      // Пространство визуальных ключей одно (ASSET-9): имя, занятое в обоих
      // разделах, сделало бы разрешение ключа зависящим от порядка просмотра.
      if (isRecord(doc.entities)) {
        for (const name of Object.keys(doc.decorations)) {
          // eslint-disable-next-line max-depth -- baseline
          if (name in doc.entities) {
            errors.push(
              `decorations.${name}: имя занято записью сущности — ключи разделов лежат в одном пространстве (ASSET-9)`,
            );
          }
        }
      }
    }
  }
  if ('cameraEffects' in doc) {
    validateCameraEffects(doc.cameraEffects, errors, warnings, options.cameraEffects);
  }
  if ('cameraConfig' in doc) {
    validateCameraConfig(doc.cameraConfig, errors, warnings, options.cameraConfig);
  }
  if ('surfaceAlign' in doc) {
    validateSurfaceAlign(doc.surfaceAlign, 'surfaceAlign', errors);
  }
  if ('terrain' in doc) {
    if (!isRecord(doc.terrain)) {
      errors.push(`terrain: ожидался объект, получено ${typeName(doc.terrain)}`);
    } else {
      checkUnknownKeys(doc.terrain, ['curvatureMap'], 'terrain', errors);
      if (
        'curvatureMap' in doc.terrain &&
        (typeof doc.terrain.curvatureMap !== 'string' || doc.terrain.curvatureMap.length === 0)
      ) {
        errors.push(
          `terrain.curvatureMap: ожидался asset id карты кривизны (непустая строка), получено ${typeName(doc.terrain.curvatureMap)}`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, manifest: doc as unknown as VisualManifest, warnings };
}
