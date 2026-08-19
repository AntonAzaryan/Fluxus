/**
 * Парный presentation-документ сцены (`presentation-scene` PRES-1..3): то, что
 * видно на арене, но не существует для симуляции, — decorations (`editor`
 * ED-19).
 *
 * Документ — presentation-ассет наравне с манифестом и картой кривизны
 * (ASSET-1): грузится этим модулем через реестр загрузчиков (ASSET-3),
 * идентифицируется путём в дереве контента (ASSET-2) и через загрузчик конфига
 * сцены (SER-7) не проходит. Канала влияния на симуляцию у него нет по
 * построению, а не по дисциплине вызывающего (PRES-4).
 *
 * ## Парность именем, а не ссылкой
 *
 * Документ лежит рядом с конфигом сцены и называется базовым именем файла сцены
 * (часть до первой точки) плюс `.presentation.json`. Ссылок между документами
 * пары нет ни в одну сторону: правило имени даёт «ровно одна сцена у документа
 * и ровно один документ у сцены» по построению, а поле-ссылка допускало бы и
 * два документа на сцену, и две сцены на документ (PRES-1). Правило живёт здесь
 * одной функцией на все пакеты — редактору и рантайму нужен один и тот же
 * ответ.
 *
 * ## Величины — десятичные, и это не упущение
 *
 * Fixed-point (`fixed-point-math` FP-1) — дисциплина симуляции, а симуляции за
 * этим документом нет: обратной конверсии float → fixed в потоке рендера не
 * существует (`rendering` REND-1), и хранить Q16.16 значило бы конвертировать
 * его в точке приёма ради величины, которой во float достаточно (PRES-3).
 *
 * Квантование при этом обязательно — иначе перетаскивание мышью пишет разряды,
 * не воспроизводимые повторным жестом, и дифф правки перестаёт быть читаемым.
 * Шаг десятичный (`DECORATION_POSITION_STEP`, `DECORATION_YAW_STEP`), квантует
 * инструмент авторинга ВЫЗОВОМ отсюда (`quantizeDecoration*`), а не своим
 * округлением: шаг — свойство формата, и второго его определения быть не
 * должно. Квантуется записываемое, а не прочитанное: файл, написанный руками с
 * большей точностью, переживает «открыл — сохранил» байт-в-байт (`editor`
 * ED-21), поэтому валидация проверяет конечность числа и положительность
 * масштаба, а не кратность шагу.
 */

/** Запись размещения decoration (PRES-2). Состав закрыт. */
export interface DecorationRecord {
  /** Ключ записи манифеста визуалов — любого из двух его разделов (ASSET-9). */
  readonly visual: string;
  /** Позиция в мировых единицах, десятичным числом. */
  readonly x: number;
  readonly y: number;
  /** Курс долей оборота; нет — 0. */
  readonly yaw?: number;
  /** Положительный множитель поверх масштаба записи вида; нет — 1. */
  readonly scale?: number;
  /** Имя скина записи вида (`rendering` REND-6); нет — скин записи. */
  readonly skin?: string;
  /**
   * Поверхность меша модели этого вида входит в единое поле высот визуальной
   * поверхности рендера (`rendering` REND-9); нет — false, и отсутствие с
   * явным false неразличимы (PRES-2). Поле presentation-слоя, а не геймплейное:
   * запрет влияния на симуляцию действует на него по PRES-4.
   */
  readonly walkable?: boolean;
}

/**
 * Секция `fog` — конфигурация рендера тумана войны (PRES-2, `fog-of-war`
 * FOW-10). Все поля необязательны: отсутствие поля или секции целиком означает
 * документированные значения по умолчанию, и они живут у подсистемы тумана
 * (`render-ts`), а не здесь — валидация проверяет форму, а не политику картинки.
 * На симуляцию секция не влияет ни байтом: presentation-данные под инвариантом
 * PRES-4 наравне с записями decoration.
 */
export interface PresentationFog {
  /** Сила затемнения зоны вне видимости, доля [0, 1] (FOW-7). */
  readonly strength?: number;
  /** Цвет/тон тумана — `#rrggbb`. */
  readonly color?: string;
  /** Ширина градиента края видимой области в мировых единицах (FOW-7). */
  readonly edgeWidth?: number;
  /** Коэффициент консервативности reveal-круга, доля (0, 1] (FOW-9). */
  readonly conservatism?: number;
  /** Разрешение маски видимости — текселей на мировую единицу (FOW-10). */
  readonly resolution?: number;
  /** Длительность fade «ушла в туман ≠ умерла», секунды (FOW-8). */
  readonly fadeSeconds?: number;
  /** Время рассеивания тумана — сходимость показанной маски, секунды; 0 — мгновенно (FOW-7). */
  readonly dissolveSeconds?: number;
}

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
 * Секция `lighting` — конфигурация освещения сцены (PRES-2). Как и секция `fog`,
 * все поля необязательны, состав закрыт, а политику картинки — сами умолчания —
 * держит подсистема рендера, не этот модуль: здесь проверяется форма данных.
 * На симуляцию секция не влияет ни байтом (PRES-4).
 */
export interface PresentationLighting {
  readonly ambient?: PresentationAmbientLight;
  readonly directional?: PresentationDirectionalLight;
  readonly shadows?: PresentationShadows;
}

/**
 * Документ целиком (PRES-2): упорядоченный список записей `decorations` —
 * отсутствующий и пустой неразличимы, и то и другое означает слой без
 * декораций — плюс необязательные секции `fog` (FOW-10) и `lighting`; их
 * отсутствие — значения по умолчанию.
 */
export interface PresentationScene {
  readonly decorations: readonly DecorationRecord[];
  readonly fog?: PresentationFog;
  readonly lighting?: PresentationLighting;
}

/** Шаг квантования позиции и масштаба — 10⁻³ мировой единицы (PRES-3). */
export const DECORATION_POSITION_STEP = 1e-3;

/** Шаг квантования курса — 10⁻⁴ оборота (PRES-3). */
export const DECORATION_YAW_STEP = 1e-4;

/** Суффикс имени парного документа (PRES-1). */
export const PRESENTATION_SUFFIX = '.presentation.json';

/**
 * Обратные величины шагов — число шагов в мировой единице и в обороте. Именно
 * они, а не сами шаги, участвуют в арифметике квантования: шаг — отрицательная
 * степень десяти и в double точно не представим, поэтому `Math.round(v / 1e-3)
 * * 1e-3` даёт `0.12350000000000001` там, где `Math.round(v * 1000) / 1000`
 * даёт `0.1235`. Дифф правки — главное, что автор видит при ревью контента
 * (PRES-3), и хвост из шестнадцати разрядов делает его нечитаемым.
 */
const POSITION_STEPS_PER_UNIT = 1e3;
const YAW_STEPS_PER_TURN = 1e4;

/**
 * Квантование к десятичному шагу. Округление к ближайшему, а не усечение:
 * усечение смещало бы величину систематически в одну сторону, и «подвинул и
 * вернул» давало бы непустой дифф — ровно то, ради чего квантование заведено.
 */
function quantizeTo(value: number, stepsPerUnit: number): number | null {
  if (!Number.isFinite(value)) return null;
  const steps = Math.round(value * stepsPerUnit);
  if (!Number.isFinite(steps)) return null;
  const quantized = steps / stepsPerUnit;
  // `-0` — законное значение double и невидимое отличие от нуля в JSON (`-0`
  // печатается как `0`), но сравнение значений его различает: правка, сменившая
  // знак нуля, помечала бы документ несохранённым ни от чего.
  return quantized === 0 ? 0 : quantized;
}

/** Позиция и масштаб — к шагу 10⁻³ (PRES-3); `null` — величина не представима. */
export function quantizeDecorationLength(value: number): number | null {
  return quantizeTo(value, POSITION_STEPS_PER_UNIT);
}

/** Курс — к шагу 10⁻⁴ оборота (PRES-3); `null` — величина не представима. */
export function quantizeDecorationYaw(value: number): number | null {
  return quantizeTo(value, YAW_STEPS_PER_TURN);
}

/**
 * Парный документ сцены по её пути (PRES-1). Базовое имя — часть до ПЕРВОЙ
 * точки: у `duel.scene.json` это `duel`, поэтому парный документ —
 * `duel.presentation.json`, а не `duel.scene.presentation.json`. Путь считается
 * от корня дерева контента (ASSET-2, `game-content` CONT-2), и каталог у пары
 * общий: перенос обоих файлов пару сохраняет и ни байта внутри не трогает
 * (CONT-5).
 */
export function presentationPathOf(scenePath: string): string {
  const slash = scenePath.lastIndexOf('/');
  const directory = slash < 0 ? '' : scenePath.slice(0, slash + 1);
  const file = slash < 0 ? scenePath : scenePath.slice(slash + 1);
  const dot = file.indexOf('.');
  const base = dot < 0 ? file : file.slice(0, dot);
  return `${directory}${base}${PRESENTATION_SUFFIX}`;
}

/** Сам ли это парный документ: у него пары нет, и искать её у него не нужно. */
export function isPresentationPath(path: string): boolean {
  return path.endsWith(PRESENTATION_SUFFIX);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Состав закрыт (PRES-2): ключ, которого формат не знает, — ошибка, а не игнор. */
const DOCUMENT_KEYS: readonly string[] = ['decorations', 'fog', 'lighting'];
const RECORD_KEYS: readonly string[] = ['visual', 'x', 'y', 'yaw', 'scale', 'skin', 'walkable'];
const FOG_KEYS: readonly string[] = [
  'strength',
  'color',
  'edgeWidth',
  'conservatism',
  'resolution',
  'fadeSeconds',
  'dissolveSeconds',
];

/**
 * Цвет в документе — `#rrggbb`: одна форма записи на все секции, чтобы дифф
 * правки не гадал о синонимах и чтобы тон тумана и тон света читались одинаково.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Валидация секции `fog` (PRES-2, `fog-of-war` FOW-10): состав закрыт,
 * неизвестный ключ и значение не той формы отвергаются адресно, а не
 * игнорируются молча — по общему правилу документа. Диапазоны здесь — форма
 * данных, а не политика картинки: доля вне [0, 1] и неположительное разрешение
 * не имеют прочтения ни при каких дефолтах подсистемы.
 */
function validateFog(section: unknown, errors: string[]): void {
  if (!isRecord(section)) {
    errors.push(`fog: ожидался объект секции конфигурации тумана (FOW-10), получено ${typeName(section)}`);
    return;
  }
  for (const key of Object.keys(section)) {
    if (FOG_KEYS.includes(key)) continue;
    errors.push(`fog.${key}: неизвестное поле (допустимы: ${FOG_KEYS.join(', ')})`);
  }
  if ('strength' in section) {
    const value = section.strength;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`fog.strength: ожидалась доля затемнения из [0, 1], получено ${typeName(value)}`);
    }
  }
  if ('conservatism' in section) {
    const value = section.conservatism;
    // Ноль стянул бы reveal в точку, больше единицы — визуал щедрее геймплея,
    // то есть противоположность консервативности (FOW-9).
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
      errors.push(`fog.conservatism: ожидалась доля из (0, 1] (FOW-9), получено ${typeName(value)}`);
    }
  }
  if ('color' in section && (typeof section.color !== 'string' || !HEX_COLOR_RE.test(section.color))) {
    errors.push(`fog.color: ожидался цвет формы "#rrggbb", получено ${typeName(section.color)}`);
  }
  if (
    'edgeWidth' in section &&
    (typeof section.edgeWidth !== 'number' || !Number.isFinite(section.edgeWidth) || section.edgeWidth < 0)
  ) {
    errors.push(
      `fog.edgeWidth: ожидалась неотрицательная ширина градиента в мировых единицах, получено ${typeName(section.edgeWidth)}`,
    );
  }
  if (
    'resolution' in section &&
    (typeof section.resolution !== 'number' ||
      !Number.isFinite(section.resolution) ||
      section.resolution <= 0)
  ) {
    errors.push(
      `fog.resolution: ожидалось положительное число текселей на мировую единицу, получено ${typeName(section.resolution)}`,
    );
  }
  if (
    'fadeSeconds' in section &&
    (typeof section.fadeSeconds !== 'number' ||
      !Number.isFinite(section.fadeSeconds) ||
      section.fadeSeconds < 0)
  ) {
    errors.push(
      `fog.fadeSeconds: ожидалась неотрицательная длительность в секундах (FOW-8), получено ${typeName(section.fadeSeconds)}`,
    );
  }
  if (
    'dissolveSeconds' in section &&
    (typeof section.dissolveSeconds !== 'number' ||
      !Number.isFinite(section.dissolveSeconds) ||
      section.dissolveSeconds < 0)
  ) {
    errors.push(
      `fog.dissolveSeconds: ожидалось неотрицательное время рассеивания в секундах (FOW-7), получено ${typeName(section.dissolveSeconds)}`,
    );
  }
}

// ------------------------------------------------------- секция `lighting`

/**
 * Состав секции освещения и её подсекций — закрыт (PRES-2). Перечни лежат
 * рядом, потому что читаются они вместе: неизвестный ключ отвергается адресно и
 * называет допустимые соседи того же уровня, а не всего документа.
 */
const LIGHTING_KEYS: readonly string[] = ['ambient', 'directional', 'shadows'];
const AMBIENT_KEYS: readonly string[] = ['color', 'intensity'];
const DIRECTIONAL_KEYS: readonly string[] = ['color', 'intensity', 'direction'];
const DIRECTION_KEYS: readonly string[] = ['x', 'y', 'z'];
const SHADOW_KEYS: readonly string[] = ['mode', 'mapSize', 'staticShare'];

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

/** Рассеянный свет: тон и интенсивность (PRES-2). */
function validateAmbientLight(node: Record<string, unknown>, errors: string[]): void {
  const path = 'lighting.ambient';
  closedKeys(node, path, AMBIENT_KEYS, errors);
  colorField(node, path, errors);
  numberField(node, path, 'intensity', { what: 'неотрицательное число интенсивности', min: 0 }, errors);
}

/** Направленный источник: тон, интенсивность и направление (PRES-2). */
function validateDirectionalLight(node: Record<string, unknown>, errors: string[]): void {
  const path = 'lighting.directional';
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
 * Валидация секции `lighting` (PRES-2): состав закрыт на каждом уровне,
 * неизвестный ключ и значение не той формы отвергаются адресно — по общему
 * правилу документа. Семантику значений нормирует `rendering`, здесь только
 * форма: сами умолчания живут у подсистемы освещения рендера.
 */
function validateLighting(section: unknown, errors: string[]): void {
  const root = subsection(section, 'lighting', errors);
  if (root === null) return;
  closedKeys(root, 'lighting', LIGHTING_KEYS, errors);
  if ('ambient' in root) {
    const ambient = subsection(root.ambient, 'lighting.ambient', errors);
    if (ambient !== null) validateAmbientLight(ambient, errors);
  }
  if ('directional' in root) {
    const directional = subsection(root.directional, 'lighting.directional', errors);
    if (directional !== null) validateDirectionalLight(directional, errors);
  }
  if ('shadows' in root) {
    const shadows = subsection(root.shadows, 'lighting.shadows', errors);
    if (shadows !== null) validateShadows(shadows, errors);
  }
}

function validateRecord(entry: unknown, path: string, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push(`${path}: ожидался объект записи decoration, получено ${typeName(entry)}`);
    return;
  }
  for (const key of Object.keys(entry)) {
    if (RECORD_KEYS.includes(key)) continue;
    // Сим-поля названы отдельно: `prefab` и переопределения компонентов в
    // записи — не опечатка, а первый шаг к геймплейному влиянию в слое,
    // который его не допускает (PRES-2, ED-19).
    const simField = key === 'prefab' || key === 'overrides';
    errors.push(
      simField
        ? `${path}.${key}: сим-поля в записи decoration нет и быть не может — сим-стороны у неё нет вовсе (PRES-2, ED-19)`
        : `${path}.${key}: неизвестное поле (допустимы: ${RECORD_KEYS.join(', ')})`,
    );
  }

  if (typeof entry.visual !== 'string' || entry.visual.length === 0) {
    errors.push(
      `${path}.visual: обязательное поле — ключ записи манифеста визуалов (непустая строка), получено ${typeName(entry.visual)}`,
    );
  }
  for (const axis of ['x', 'y'] as const) {
    const value = entry[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(
        `${path}.${axis}: обязательное поле — конечное число мировых единиц, получено ${typeName(value)}`,
      );
    }
  }
  if ('yaw' in entry && (typeof entry.yaw !== 'number' || !Number.isFinite(entry.yaw))) {
    errors.push(`${path}.yaw: ожидался курс долей оборота (конечное число), получено ${typeName(entry.yaw)}`);
  }
  if ('scale' in entry) {
    const scale = entry.scale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
      errors.push(`${path}.scale: ожидалось положительное конечное число, получено ${typeName(scale)}`);
    }
  }
  if ('skin' in entry && (typeof entry.skin !== 'string' || entry.skin.length === 0)) {
    errors.push(`${path}.skin: ожидалось имя скина (непустая строка), получено ${typeName(entry.skin)}`);
  }
  // Небулево значение — адресный отказ (PRES-2): «правдоподобные» 0/1 и "yes"
  // не принимаются, потому что отсутствие и false неразличимы, и любое третье
  // прочтение поля молча меняло бы форму визуальной поверхности (REND-9).
  if ('walkable' in entry && typeof entry.walkable !== 'boolean') {
    errors.push(
      `${path}.walkable: ожидался булев флаг walkable-поверхности (true либо false), получено ${typeName(entry.walkable)}`,
    );
  }
}

/**
 * Валидация парного документа (PRES-2, PRES-3). Ошибки собираются все разом и
 * каждая адресует ЗАПИСЬ индексом, а не документ целиком: правка JSON не должна
 * превращаться в угадывание, какая из сорока декораций сломана.
 */
export function validatePresentationScene(
  doc: unknown,
): { ok: true; scene: PresentationScene } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`presentation-документ: ожидался объект, получено ${typeName(doc)}`] };
  }
  for (const key of Object.keys(doc)) {
    if (!DOCUMENT_KEYS.includes(key)) {
      errors.push(`${key}: неизвестное поле (допустимо: ${DOCUMENT_KEYS.join(', ')})`);
    }
  }
  const list = doc.decorations;
  if (list !== undefined && !Array.isArray(list)) {
    errors.push(`decorations: ожидался список записей размещения, получено ${typeName(list)}`);
  } else if (Array.isArray(list)) {
    list.forEach((entry, index) => { validateRecord(entry, `decorations[${index}]`, errors); });
  }
  // Отсутствующая секция `fog` — значения по умолчанию у подсистемы (FOW-10),
  // и наружу она в этом случае не выходит вовсе: `undefined`, а не пустой объект.
  if (doc.fog !== undefined) validateFog(doc.fog, errors);
  // Секция `lighting` — тем же порядком и по тому же основанию: её умолчания
  // держит подсистема освещения рендера.
  if (doc.lighting !== undefined) validateLighting(doc.lighting, errors);
  if (errors.length > 0) return { ok: false, errors };
  // Отсутствующий и пустой список неразличимы (PRES-2): наружу и то и другое
  // выходит пустым списком, и потребителю не приходится различать их самому.
  return {
    ok: true,
    scene: {
      decorations: Array.isArray(list) ? (list as DecorationRecord[]) : [],
      ...(doc.fog === undefined ? {} : { fog: doc.fog as PresentationFog }),
      ...(doc.lighting === undefined ? {} : { lighting: doc.lighting as PresentationLighting }),
    },
  };
}
