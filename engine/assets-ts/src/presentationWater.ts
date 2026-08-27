/**
 * Секция `water` парного presentation-документа (`presentation-scene` PRES-2,
 * `rendering` REND-35, REND-36) — её состав и её валидация.
 *
 * Живёт отдельно от документа (`presentation.ts`) по тому же основанию, по
 * какому отдельно живут секции `lighting` и `postprocess`: это самостоятельный
 * формат со своими уровнями вложенности и своими адресами находок, читается и
 * правится он сам по себе, а в документ входит одним полем и одним вызовом.
 *
 * Границы те же: здесь проверяется ФОРМА данных, а политика картинки — сами
 * умолчания, формулы глубинного цвета, число октав шума — живёт у подсистемы
 * воды рендера (`render-ts`, `water/config.ts`). На симуляцию секция не влияет
 * ни байтом (PRES-4) — наравне с записями decoration и остальными секциями.
 *
 * ## Почему карта одна, а тел список
 *
 * Клеточная карта `cells` адресует клетки сетки террейна (REND-35), как карта
 * уровней (TERR-3): ряд на ряд сетки, символ на клетку. Тела по построению не
 * пересекаются — клетка принадлежит ровно одному, — поэтому карта одна на
 * сцену, а не карта на тело: так водоёмы читаются глазами прямо в документе.
 * Десяти тел на сцену достаточно, отсюда и алфавит `0`–`9`.
 *
 * ## Урез — в шкале уровней, а не в мировой высоте
 *
 * `surfaceLevel` — десятичное число В ШКАЛЕ УРОВНЕЙ террейна (REND-35):
 * абсолютной высоты документ не несёт, в мировую её переводит рендер своим
 * шагом высоты (REND-7). Смена шага масштабирует воду вместе с террейном, и
 * документ от этого не правится.
 */
import {
  closedKeys,
  namedColorField,
  numberField,
  subsection,
  typeName,
} from './presentationFields.js';

/**
 * Полоса пены у берега (REND-35). Ширина меряется ГЛУБИНОЙ в шкале уровней:
 * пена живёт там, где воды меньше `width`, — то есть следует линии берега, а не
 * границе клеток карты.
 */
export interface PresentationWaterFoam {
  /** Глубина, на которой пена гаснет, в шкале уровней; неотрицательная. */
  readonly width?: number;
  /** Цвет пены — `#rrggbb`. */
  readonly color?: string;
  /**
   * Жёсткость кромки, доля [0, 1]: 0 — мягкий градиент (semi-realistic), 1 —
   * жёсткий cutoff (stylized, умолчание демо).
   */
  readonly hardness?: number;
}

/**
 * Источник мелкой детали поверхности (REND-35). `procedural` — шум, считаемый
 * в шейдере, не требующий НИ ОДНОГО текстурного ассета (умолчание);
 * `textured` — tileable-текстуры дерева контента по ID (`assets` ASSET-2).
 */
export type PresentationWaterDetailSource = 'procedural' | 'textured';

/** Единственный перечень источников: по нему строится и проверка, и текст отказа. */
export const PRESENTATION_WATER_DETAIL_SOURCES: readonly PresentationWaterDetailSource[] =
  Object.freeze(['procedural', 'textured']);

/**
 * Блок `detail` — откуда берётся мелкая деталь и какая она (REND-35).
 * Наблюдаемое поведение воды помимо самой детали — глубинный цвет, берег, пена,
 * рябь — от источника не зависит: и то и другое ядро материала считает одинаково.
 */
export interface PresentationWaterDetail {
  /** Источник детали; нет — `procedural`. */
  readonly source?: PresentationWaterDetailSource;
  /** Слоёв детали (октав шума либо семплов нормалей), целое положительное. */
  readonly layers?: number;
  /** Мировых единиц на период детали, положительное. */
  readonly scale?: number;
  /** Скорость сноса детали, мировых единиц в секунду, неотрицательная. */
  readonly speed?: number;
  /** Сила возмущения нормали, неотрицательная. */
  readonly strength?: number;
  /** ID tileable-карты нормалей (ASSET-2); действует только у `textured`. */
  readonly normalMap?: string;
  /** ID tileable-текстуры шума пены (ASSET-2); действует только у `textured`. */
  readonly foamNoise?: string;
  /** ID tileable-flow map (ASSET-2); действует только у `textured`. */
  readonly flowMap?: string;
}

/**
 * Блок `ripples` — рябь от движущихся сущностей (REND-36). Величины авторские,
 * а действующий предел источников — под потолком пресета качества (QUAL-1).
 */
export interface PresentationWaterRipples {
  /** Предел одновременных источников, целое из [0, 16]; 0 — ряби нет. */
  readonly sources?: number;
  /** Длина волны кольца, мировые единицы, положительная. */
  readonly wavelength?: number;
  /** Скорость расхождения кольца, мировых единиц в секунду, неотрицательная. */
  readonly speed?: number;
  /** Амплитуда возмущения нормали, неотрицательная. */
  readonly amplitude?: number;
  /** За сколько секунд кольцо затухает, положительное. */
  readonly decaySeconds?: number;
  /**
   * Порог скорости источника — мировых единиц ЗА ТИК, неотрицательный: медленнее
   * него сущность ряби не поднимает. За тик, а не в секунду, потому что
   * presentation-состояние даёт две позиции соседних тиков (REND-2), и второй
   * величины у рендера нет.
   */
  readonly minSpeed?: number;
}

/**
 * Запись тела воды (REND-35). Состав закрыт: `surfaceLevel`, `shallowColor` и
 * `deepColor` обязательны, остальное — документированные умолчания подсистемы.
 */
export interface PresentationWaterBody {
  /** Урез в шкале уровней террейна; допустимы отрицательные и дробные. */
  readonly surfaceLevel: number;
  /** Цвет мелкой воды — `#rrggbb`. */
  readonly shallowColor: string;
  /** Цвет глубокой воды — `#rrggbb`. */
  readonly deepColor: string;
  /** Глубина полного цвета в шкале уровней, положительная. */
  readonly maxDepth?: number;
  /** Число цветовых бэндов, целое неотрицательное; 0 — плавный градиент. */
  readonly banding?: number;
  readonly foam?: PresentationWaterFoam;
  readonly detail?: PresentationWaterDetail;
  readonly ripples?: PresentationWaterRipples;
}

/**
 * Секция `water` целиком (PRES-2, REND-35): клеточная карта и список тел.
 * Отсутствие секции — сцена без воды, а не пустая карта.
 */
export interface PresentationWater {
  /**
   * Ряды размером с сетку террейна: `.` — клетка без воды, цифра `0`–`9` —
   * индекс тела в `bodies`. Ряды MUST NOT дополняться умолчанием (REND-35).
   */
  readonly cells: readonly string[];
  readonly bodies: readonly PresentationWaterBody[];
}

/** Сетка террейна сцены глазами валидации секции: только размеры карты. */
export interface WaterGridExtent {
  readonly width: number;
  readonly height: number;
}

const WATER_KEYS: readonly string[] = ['cells', 'bodies'];
const BODY_KEYS: readonly string[] = [
  'surfaceLevel',
  'shallowColor',
  'deepColor',
  'maxDepth',
  'banding',
  'foam',
  'detail',
  'ripples',
];
const FOAM_KEYS: readonly string[] = ['width', 'color', 'hardness'];
const DETAIL_KEYS: readonly string[] = [
  'source',
  'layers',
  'scale',
  'speed',
  'strength',
  'normalMap',
  'foamNoise',
  'flowMap',
];
const RIPPLES_KEYS: readonly string[] = [
  'sources',
  'wavelength',
  'speed',
  'amplitude',
  'decaySeconds',
  'minSpeed',
];

/** Символ «воды здесь нет» — тот же смысл, что у пустой клетки карты уровней. */
export const WATER_EMPTY_CELL = '.';

/**
 * Верхний предел одновременных источников ряби (REND-36, design D5): шестнадцать
 * векторов укладываются в гарантированные WebGL2 фрагментные uniform-векторы с
 * запасом. Число живёт здесь, потому что его печатает отказ валидации, и второго
 * его определения быть не должно — подсистема рендера читает его отсюда же.
 */
export const WATER_MAX_RIPPLE_SOURCES = 16;

/** Тело по символу карты; `null` — символ вне алфавита. */
function bodyIndexOf(symbol: string): number | null {
  if (symbol === WATER_EMPTY_CELL) return -1;
  const code = symbol.codePointAt(0);
  if (code === undefined || code < 0x30 || code > 0x39) return null;
  return code - 0x30;
}

/**
 * Клеточная карта (REND-35): число рядов и длина ряда — размеры сетки террейна,
 * символ — из алфавита, индекс — разрешается в тело. Каждая находка адресует
 * КЛЕТКУ, а не карту: правка водоёма не должна превращаться в поиск, какая из
 * двух тысяч клеток сломана.
 *
 * Сетка приходит параметром и может отсутствовать: загрузчик ассетов держит
 * один документ и о парном конфиге сцены не знает (ASSET-3). Без сетки
 * проверяется прямоугольность карты — что все ряды одной длины, — а совпадение
 * с сеткой проверяет тот, у кого сетка есть.
 */
function validateCells(
  section: Record<string, unknown>,
  bodies: number,
  grid: WaterGridExtent | undefined,
  errors: string[],
): void {
  const rows = section.cells;
  if (!Array.isArray(rows)) {
    errors.push(
      `water.cells: ожидался список текстовых рядов клеточной карты (REND-35), получено ${typeName(rows)}`,
    );
    return;
  }
  if (grid !== undefined && rows.length !== grid.height) {
    errors.push(
      `water.cells: ожидалось ${grid.height} рядов по высоте сетки террейна, получено ${rows.length}`,
    );
  }
  const width = grid?.width ?? (typeof rows[0] === 'string' ? rows[0].length : 0);
  rows.forEach((row: unknown, y: number) => {
    if (typeof row !== 'string') {
      errors.push(`water.cells[${y}]: ожидался ряд клеточной карты строкой, получено ${typeName(row)}`);
      return;
    }
    if (row.length !== width) {
      // Ряд другой длины отвергается, а не дополняется умолчанием (REND-35):
      // «дополнить» значило бы придумать за автора, где кончается водоём.
      errors.push(
        `water.cells[${y}]: ожидался ряд длиной ${width} символов, получено ${row.length} — ряды не дополняются умолчанием (REND-35)`,
      );
      return;
    }
    validateRowSymbols(row, y, bodies, errors);
  });
}

/** Символы одного ряда: алфавит и разрешимость индекса — с адресом клетки. */
function validateRowSymbols(row: string, y: number, bodies: number, errors: string[]): void {
  for (let x = 0; x < row.length; x++) {
    const symbol = row[x]!;
    const index = bodyIndexOf(symbol);
    if (index === null) {
      errors.push(
        `water.cells[${y}][${x}]: символ "${symbol}" вне алфавита карты воды (допустимы "${WATER_EMPTY_CELL}" и цифры 0–9)`,
      );
      continue;
    }
    if (index >= bodies) {
      errors.push(
        `water.cells[${y}][${x}]: индекс тела ${index} не разрешается — в bodies ${bodies} записей (REND-35)`,
      );
    }
  }
}

/** Блок `foam` — полоса пены у берега (REND-35). */
function validateFoam(node: Record<string, unknown>, path: string, errors: string[]): void {
  closedKeys(node, path, FOAM_KEYS, errors);
  numberField(node, path, 'width', { what: 'неотрицательная ширина полосы пены в шкале уровней', min: 0 }, errors);
  namedColorField(node, path, 'color', errors);
  numberField(node, path, 'hardness', { what: 'жёсткость кромки пены — доля из [0, 1]', min: 0, max: 1 }, errors);
}

/** Блок `detail` — источник и параметры мелкой детали (REND-35). */
function validateDetail(node: Record<string, unknown>, path: string, errors: string[]): void {
  closedKeys(node, path, DETAIL_KEYS, errors);
  if (
    'source' in node &&
    !PRESENTATION_WATER_DETAIL_SOURCES.includes(node.source as PresentationWaterDetailSource)
  ) {
    errors.push(
      `${path}.source: ожидался источник детали из ${PRESENTATION_WATER_DETAIL_SOURCES.join(' | ')}, получено ${typeName(node.source)}`,
    );
  }
  numberField(
    node,
    path,
    'layers',
    { what: 'целое положительное число слоёв детали', min: 1, integer: true },
    errors,
  );
  numberField(node, path, 'scale', { what: 'положительный размер детали в мировых единицах', min: 0, exclusive: true }, errors);
  numberField(node, path, 'speed', { what: 'неотрицательная скорость сноса детали', min: 0 }, errors);
  numberField(node, path, 'strength', { what: 'неотрицательная сила возмущения нормали', min: 0 }, errors);
  // ID ассетов существованием здесь не проверяются: дерева контента этот модуль
  // не видит, а недоступная текстура — procedural-фолбэк и предупреждение
  // (REND-35), по образцу LUT (REND-34).
  for (const key of ['normalMap', 'foamNoise', 'flowMap'] as const) {
    if (!(key in node)) continue;
    const value = node[key];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${path}.${key}: ожидался ID ассета текстуры (непустая строка), получено ${typeName(value)}`);
    }
  }
}

/** Блок `ripples` — рябь от движущихся сущностей (REND-36). */
function validateRipples(node: Record<string, unknown>, path: string, errors: string[]): void {
  closedKeys(node, path, RIPPLES_KEYS, errors);
  numberField(
    node,
    path,
    'sources',
    {
      what: `целое число источников ряби из [0, ${WATER_MAX_RIPPLE_SOURCES}] (0 — ряби нет)`,
      min: 0,
      max: WATER_MAX_RIPPLE_SOURCES,
      integer: true,
    },
    errors,
  );
  numberField(node, path, 'wavelength', { what: 'положительная длина волны в мировых единицах', min: 0, exclusive: true }, errors);
  numberField(node, path, 'speed', { what: 'неотрицательная скорость расхождения кольца', min: 0 }, errors);
  numberField(node, path, 'amplitude', { what: 'неотрицательная амплитуда ряби', min: 0 }, errors);
  numberField(node, path, 'decaySeconds', { what: 'положительное время затухания кольца в секундах', min: 0, exclusive: true }, errors);
  numberField(node, path, 'minSpeed', { what: 'неотрицательный порог скорости источника, мировых единиц за тик', min: 0 }, errors);
}

/** Обязательный цвет записи тела: отсутствие — такая же находка, как не тот тип. */
function requiredColor(node: Record<string, unknown>, path: string, key: string, errors: string[]): void {
  if (!(key in node)) {
    errors.push(`${path}.${key}: обязательное поле — цвет формы "#rrggbb" (REND-35)`);
    return;
  }
  namedColorField(node, path, key, errors);
}

/** Одна запись тела воды (REND-35): состав закрыт, обязательное — обязательно. */
function validateBody(entry: unknown, path: string, errors: string[]): void {
  const node = subsection(entry, path, errors);
  if (node === null) return;
  closedKeys(node, path, BODY_KEYS, errors);
  const level = node.surfaceLevel;
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    // Отрицательный и дробный урез законны (REND-35): вода живёт в лощине ниже
    // пола своего уровня, и запретить знак значило бы запретить лощину.
    errors.push(
      `${path}.surfaceLevel: обязательное поле — урез конечным числом в шкале уровней террейна, получено ${typeName(level)}`,
    );
  }
  requiredColor(node, path, 'shallowColor', errors);
  requiredColor(node, path, 'deepColor', errors);
  numberField(node, path, 'maxDepth', { what: 'положительная глубина полного цвета в шкале уровней', min: 0, exclusive: true }, errors);
  numberField(node, path, 'banding', { what: 'целое неотрицательное число цветовых бэндов (0 — плавный градиент)', min: 0, integer: true }, errors);
  for (const [key, check] of [
    ['foam', validateFoam],
    ['detail', validateDetail],
    ['ripples', validateRipples],
  ] as const) {
    if (!(key in node)) continue;
    const block = subsection(node[key], `${path}.${key}`, errors);
    if (block !== null) check(block, `${path}.${key}`, errors);
  }
}

/**
 * Валидация секции `water` (PRES-2, REND-35): состав закрыт на каждом уровне,
 * неизвестный ключ и значение не той формы отвергаются адресно — по общему
 * правилу документа. Семантику значений нормирует `rendering` REND-35, здесь
 * только форма: сами умолчания живут у подсистемы воды рендера.
 *
 * `grid` — сетка террейна сцены (REND-35): `null` означает «террейна у сцены
 * нет», и секция отвергается целиком — карта адресует клетки его сетки, и без
 * сетки её не к чему привязать. `undefined` — сетка вызывающему неизвестна
 * (загрузчик ассета держит один документ, ASSET-3), и размеры карты не
 * проверяются; её прямоугольность проверяется всегда.
 */
export function validateWater(
  section: unknown,
  errors: string[],
  grid?: WaterGridExtent | null,
): void {
  if (grid === null) {
    errors.push(
      'water: секция воды у сцены без террейна — клеточная карта адресует клетки его сетки, и привязать её не к чему (REND-35)',
    );
    return;
  }
  const root = subsection(section, 'water', errors);
  if (root === null) return;
  closedKeys(root, 'water', WATER_KEYS, errors);
  const bodies = root.bodies;
  if (!Array.isArray(bodies)) {
    errors.push(`water.bodies: ожидался список записей тел воды (REND-35), получено ${typeName(bodies)}`);
  } else {
    bodies.forEach((entry: unknown, index: number) => {
      validateBody(entry, `water.bodies[${index}]`, errors);
    });
  }
  validateCells(root, Array.isArray(bodies) ? bodies.length : 0, grid ?? undefined, errors);
}
