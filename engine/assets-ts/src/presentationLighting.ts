/**
 * Секция `lighting` парного presentation-документа (`presentation-scene` PRES-2,
 * `rendering` REND-29) — её состав и её валидация.
 *
 * Живёт отдельно от документа (`presentation.ts`) по размеру и по предмету:
 * документ описывает СЛОЙ сцены (записи decoration, секции и правила имени
 * пары), а здесь — один самостоятельный формат со своими уровнями вложенности,
 * подсекцией цикла времени суток (REND-32) и своими адресами находок. Читаются
 * они по отдельности, и правятся по отдельности тоже.
 *
 * Границы те же, что у всего документа: здесь проверяется ФОРМА данных, а
 * политика картинки — сами умолчания, смысл интерполяции, длина перехода по
 * умолчанию — живёт у подсистемы освещения рендера (`render-ts`,
 * `lighting/config.ts`). На симуляцию секция не влияет ни байтом (PRES-4).
 */

/** Ответ «получено что-то не то» — тем же словарём, что у остального формата. */
function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Цвет в документе — `#rrggbb`: одна форма записи на все секции, чтобы дифф
 * правки не гадал о синонимах и чтобы тон тумана и тон света читались одинаково.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Рассеянный свет сцены — половина секции `lighting` (PRES-2). Поля
 * необязательны: отсутствие — документированное умолчание подсистемы освещения
 * (`render-ts`, `lighting/config.ts`), а не ноль.
 */
export interface PresentationAmbientLight {
  /** Тон рассеянного света — `#rrggbb`. */
  readonly color?: string;
  /** Интенсивность, неотрицательная. */
  readonly intensity?: number;
}

/**
 * Направление направленного источника — откуда он светит: смещение позиции
 * источника от цели в мировых единицах. Не единичный вектор: нормирует его
 * рендер, а автор пишет удобные ему числа.
 */
export interface PresentationLightDirection {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

/** Направленный источник сцены — вторая половина секции `lighting` (PRES-2). */
export interface PresentationDirectionalLight {
  readonly color?: string;
  readonly intensity?: number;
  readonly direction?: PresentationLightDirection;
}

/**
 * Режим теней сцены, по возрастанию стоимости: теней нет; статика в кэшированной
 * карте, динамика в покадровой; все кастеры покадрово. Порядок значений
 * нормативен — по нему считается потолок пресета качества (QUAL-1).
 */
export type PresentationShadowMode = 'none' | 'hybrid' | 'full';

/** Значения режима в порядке возрастания стоимости — единственный их перечень. */
export const PRESENTATION_SHADOW_MODES: readonly PresentationShadowMode[] = Object.freeze([
  'none',
  'hybrid',
  'full',
]);

/** Параметры теней секции `lighting` (PRES-2). */
export interface PresentationShadows {
  /** Режим теней; нет — `none` (тени выключены). */
  readonly mode?: PresentationShadowMode;
  /** Сторона карты теней в текселях, целая и положительная. */
  readonly mapSize?: number;
  /**
   * Доля интенсивности направленного источника, отданная кэшированной карте
   * статики в режиме `hybrid`, [0, 1]; остальное достаётся покадровой карте.
   * В режимах `none` и `full` источник один, и доля смысла не имеет.
   */
  readonly staticShare?: number;
}

/**
 * Фаза цикла времени суток (`rendering` REND-32): длительность и значения света
 * того же состава, что статическая часть секции. Дыры фазы закрываются
 * статической частью секции, а её дыры — умолчаниями подсистемы (REND-29): те же
 * правила, что у всего документа (PRES-2). Параметров теней в фазе нет и быть не
 * может — режим, сторона карты и доля статики принадлежат секции целиком.
 */
export interface PresentationLightingPhase {
  /**
   * Авторское имя фазы («утро», «ночь») — для читаемости документа и отладки.
   * Словаря имён у механизма MUST NOT существовать (REND-32): какие фазы есть и
   * как они называются, решает автор сцены.
   */
  readonly name?: string;
  /** Длительность фазы в секундах, положительная. */
  readonly seconds: number;
  readonly ambient?: PresentationAmbientLight;
  readonly directional?: PresentationDirectionalLight;
}

/**
 * Подсекция `cycle` секции `lighting` (REND-32): упорядоченный список из не
 * менее чем двух фаз и общая длительность перехода между ними. Исполняет цикл
 * подсистема освещения рендера, здесь — только форма данных: и длительность
 * перехода по умолчанию, и смысл интерполяции живут у неё.
 */
export interface PresentationLightingCycle {
  /** Длительность кроссфейда на границе фаз, секунды; нет — умолчание подсистемы. */
  readonly transitionSeconds?: number;
  /** Фазы по кругу; не менее двух — одной фазе чередоваться не с чем. */
  readonly phases: readonly PresentationLightingPhase[];
}

/**
 * Секция `lighting` — конфигурация освещения сцены (PRES-2, `rendering` REND-29). Как и секция `fog`,
 * все поля необязательны, состав закрыт, а политику картинки — сами умолчания —
 * держит подсистема рендера, не этот модуль: здесь проверяется форма данных.
 * На симуляцию секция не влияет ни байтом (PRES-4), и подсекция цикла (REND-32)
 * действует под тем же инвариантом наравне со статической частью.
 */
export interface PresentationLighting {
  readonly ambient?: PresentationAmbientLight;
  readonly directional?: PresentationDirectionalLight;
  readonly shadows?: PresentationShadows;
  readonly cycle?: PresentationLightingCycle;
}

/**
 * Состав секции освещения и её подсекций — закрыт (PRES-2). Перечни лежат
 * рядом, потому что читаются они вместе: неизвестный ключ отвергается адресно и
 * называет допустимые соседи того же уровня, а не всего документа.
 */
const LIGHTING_KEYS: readonly string[] = ['ambient', 'directional', 'shadows', 'cycle'];
const AMBIENT_KEYS: readonly string[] = ['color', 'intensity'];
const DIRECTIONAL_KEYS: readonly string[] = ['color', 'intensity', 'direction'];
const DIRECTION_KEYS: readonly string[] = ['x', 'y', 'z'];
const SHADOW_KEYS: readonly string[] = ['mode', 'mapSize', 'staticShare'];
const CYCLE_KEYS: readonly string[] = ['transitionSeconds', 'phases'];
const PHASE_KEYS: readonly string[] = ['name', 'seconds', 'ambient', 'directional'];

/** Минимум фаз в цикле (REND-32): одной фазе чередоваться не с чем. */
const MIN_CYCLE_PHASES = 2;

/**
 * Подсекция по адресу: не объект — адресный отказ и `null`, дальше разбирать
 * нечего. Отсутствие подсекции — умолчания подсистемы, а не ошибка, поэтому
 * `undefined` сюда не доходит: его отсеивает вызывающий.
 */
function subsection(value: unknown, path: string, errors: string[]): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  errors.push(`${path}: ожидался объект секции, получено ${typeName(value)}`);
  return null;
}

/** Ключ, которого формат не знает, — ошибка с перечнем допустимых соседей (PRES-2). */
function closedKeys(
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
interface NumberRange {
  readonly what: string;
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

/**
 * Числовое поле подсекции. Отсутствие — умолчание подсистемы (PRES-2), а
 * диапазон здесь — форма данных, а не политика картинки: отрицательная
 * интенсивность и нулевая карта теней не имеют прочтения ни при каких
 * умолчаниях.
 */
function numberField(
  node: Record<string, unknown>,
  path: string,
  key: string,
  range: NumberRange,
  errors: string[],
): void {
  if (!(key in node)) return;
  const value = node[key];
  const bad =
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (range.integer === true && !Number.isInteger(value)) ||
    (range.min !== undefined && value < range.min) ||
    (range.max !== undefined && value > range.max);
  if (bad) errors.push(`${path}.${key}: ожидалось ${range.what}, получено ${typeName(value)}`);
}

/** Тон источника — та же форма `#rrggbb`, что у тона тумана. */
function colorField(node: Record<string, unknown>, path: string, errors: string[]): void {
  if (!('color' in node)) return;
  const value = node.color;
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) {
    errors.push(`${path}.color: ожидался цвет формы "#rrggbb", получено ${typeName(value)}`);
  }
}

/**
 * Рассеянный свет: тон и интенсивность (PRES-2). Адрес приходит параметром —
 * тот же состав описывает и статическую часть секции, и фазу цикла (REND-32), а
 * находка обязана называть адрес того уровня, на котором она нашлась.
 */
function validateAmbientLight(node: Record<string, unknown>, path: string, errors: string[]): void {
  closedKeys(node, path, AMBIENT_KEYS, errors);
  colorField(node, path, errors);
  numberField(node, path, 'intensity', { what: 'неотрицательное число интенсивности', min: 0 }, errors);
}

/** Направленный источник: тон, интенсивность и направление (PRES-2). */
function validateDirectionalLight(
  node: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  closedKeys(node, path, DIRECTIONAL_KEYS, errors);
  colorField(node, path, errors);
  numberField(node, path, 'intensity', { what: 'неотрицательное число интенсивности', min: 0 }, errors);
  if (!('direction' in node)) return;
  const axes = `${path}.direction`;
  const direction = subsection(node.direction, axes, errors);
  if (direction === null) return;
  closedKeys(direction, axes, DIRECTION_KEYS, errors);
  const range: NumberRange = { what: 'конечное число мировых единиц' };
  for (const axis of DIRECTION_KEYS) numberField(direction, axes, axis, range, errors);
}

/** Параметры теней: режим, сторона карты и доля интенсивности статики (PRES-2). */
function validateShadows(node: Record<string, unknown>, errors: string[]): void {
  const path = 'lighting.shadows';
  closedKeys(node, path, SHADOW_KEYS, errors);
  if ('mode' in node && !PRESENTATION_SHADOW_MODES.includes(node.mode as PresentationShadowMode)) {
    errors.push(
      `${path}.mode: ожидался режим теней из ${PRESENTATION_SHADOW_MODES.join(' | ')}, получено ${typeName(node.mode)}`,
    );
  }
  numberField(
    node,
    path,
    'mapSize',
    { what: 'целое положительное число текселей — сторона карты теней', min: 1, integer: true },
    errors,
  );
  numberField(
    node,
    path,
    'staticShare',
    { what: 'число из [0, 1] — доля интенсивности', min: 0, max: 1 },
    errors,
  );
}

/**
 * Фаза цикла (REND-32): длительность и значения света того же состава, что
 * статическая часть секции. Теневые поля названы в отказе поимённо — это не
 * опечатка, а попытка водить по кругу то, что принадлежит секции целиком:
 * смена режима или стороны карты пересобирает программы материалов, и кадром
 * такое не бывает.
 */
function validateCyclePhase(node: Record<string, unknown>, path: string, errors: string[]): void {
  for (const key of Object.keys(node)) {
    if (PHASE_KEYS.includes(key)) continue;
    const shadowField = key === 'shadows' || SHADOW_KEYS.includes(key);
    errors.push(
      shadowField
        ? `${path}.${key}: параметров теней в фазе цикла нет и быть не может — режим, сторона карты и доля статики принадлежат секции целиком (REND-32, REND-30)`
        : `${path}.${key}: неизвестное поле (допустимы: ${PHASE_KEYS.join(', ')})`,
    );
  }
  if ('name' in node && (typeof node.name !== 'string' || node.name.length === 0)) {
    errors.push(
      `${path}.name: ожидалось имя фазы (непустая строка), получено ${typeName(node.name)}`,
    );
  }
  // Длительность обязательна и положительна: фаза нулевой длины — не фаза, и
  // прочтения у неё нет ни при каких умолчаниях подсистемы (REND-32).
  const seconds = node.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    errors.push(
      `${path}.seconds: обязательное поле — положительная длительность фазы в секундах, получено ${typeName(seconds)}`,
    );
  }
  if ('ambient' in node) {
    const ambient = subsection(node.ambient, `${path}.ambient`, errors);
    if (ambient !== null) validateAmbientLight(ambient, `${path}.ambient`, errors);
  }
  if ('directional' in node) {
    const directional = subsection(node.directional, `${path}.directional`, errors);
    if (directional !== null) validateDirectionalLight(directional, `${path}.directional`, errors);
  }
}

/**
 * Подсекция цикла времени суток (REND-32): состав закрыт, список фаз — не
 * короче двух, каждая находка адресует ФАЗУ индексом, а не подсекцию целиком —
 * по тому же основанию, по какому его адресуют записи decoration.
 */
function validateLightingCycle(node: Record<string, unknown>, errors: string[]): void {
  const path = 'lighting.cycle';
  closedKeys(node, path, CYCLE_KEYS, errors);
  numberField(
    node,
    path,
    'transitionSeconds',
    { what: 'неотрицательное число секунд — длительность перехода между фазами', min: 0 },
    errors,
  );
  const phases = node.phases;
  if (!Array.isArray(phases)) {
    errors.push(
      `${path}.phases: обязательное поле — список фаз цикла (не менее ${MIN_CYCLE_PHASES}), получено ${typeName(phases)}`,
    );
    return;
  }
  if (phases.length < MIN_CYCLE_PHASES) {
    errors.push(
      `${path}.phases: фаз ${phases.length} — циклу нужно не менее ${MIN_CYCLE_PHASES}: чередовать одну фазу не с чем (REND-32)`,
    );
  }
  phases.forEach((phase, index) => {
    const at = `${path}.phases[${index}]`;
    if (!isRecord(phase)) {
      errors.push(`${at}: ожидался объект фазы цикла, получено ${typeName(phase)}`);
      return;
    }
    validateCyclePhase(phase, at, errors);
  });
}

/**
 * Валидация секции `lighting` (PRES-2): состав закрыт на каждом уровне,
 * неизвестный ключ и значение не той формы отвергаются адресно — по общему
 * правилу документа. Семантику значений нормирует `rendering`, здесь только
 * форма: сами умолчания живут у подсистемы освещения рендера.
 */
export function validateLighting(section: unknown, errors: string[]): void {
  const root = subsection(section, 'lighting', errors);
  if (root === null) return;
  closedKeys(root, 'lighting', LIGHTING_KEYS, errors);
  if ('ambient' in root) {
    const ambient = subsection(root.ambient, 'lighting.ambient', errors);
    if (ambient !== null) validateAmbientLight(ambient, 'lighting.ambient', errors);
  }
  if ('directional' in root) {
    const directional = subsection(root.directional, 'lighting.directional', errors);
    if (directional !== null) validateDirectionalLight(directional, 'lighting.directional', errors);
  }
  if ('shadows' in root) {
    const shadows = subsection(root.shadows, 'lighting.shadows', errors);
    if (shadows !== null) validateShadows(shadows, errors);
  }
  if ('cycle' in root) {
    const cycle = subsection(root.cycle, 'lighting.cycle', errors);
    if (cycle !== null) validateLightingCycle(cycle, errors);
  }
}
