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
 *
 * ## Секции `lighting`, `postprocess` и `water` — рядом, отдельными модулями
 *
 * Состав и валидация секции освещения (REND-29, REND-32) живут в
 * `presentationLighting.ts`, секции пост-обработки кадра (REND-34) — в
 * `presentationPostprocess.ts`, секции воды (REND-35, REND-36) — в
 * `presentationWater.ts`: это самостоятельные форматы со своими уровнями
 * вложенности и своими адресами находок, и читаются они отдельно от документа,
 * который их несёт. Сюда каждый входит одним полем и одним вызовом.
 */
import { validateLighting, type PresentationLighting } from './presentationLighting.js';
import { HEX_COLOR_RE, closedKeys, isRecord, typeName } from './validation.js';
import {
  validatePostprocess,
  type PresentationPostprocess,
} from './presentationPostprocess.js';
import {
  validateWater,
  type PresentationWater,
  type WaterGridExtent,
} from './presentationWater.js';

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
 * Секция `stealth` — подача стелс-состояний (PRES-2, `fog-of-war` FOW-13):
 * непрозрачность своего юнита под стелсом и чужого под невскрытым мягким
 * каналом (силуэт-плейсхолдер до шейдера преломления). Все поля необязательны:
 * умолчания живут у потребителя подачи, а не здесь — как у секции `fog`.
 * На симуляцию секция не влияет ни байтом (PRES-4): вскрытость и доставку
 * решают маски симуляции, картинка их только показывает.
 */
export interface PresentationStealth {
  /** Непрозрачность своего юнита под активным стелсом, доля [0, 1] (FOW-13). */
  readonly allyOpacity?: number;
  /** Непрозрачность чужого невскрытого мягкого стелса, доля [0, 1] (FOW-13). */
  readonly enemyOpacity?: number;
}

/**
 * Документ целиком (PRES-2): упорядоченный список записей `decorations` —
 * отсутствующий и пустой неразличимы, и то и другое означает слой без
 * декораций — плюс необязательные секции `fog` (FOW-10), `stealth` (FOW-13),
 * `lighting` (REND-29), `postprocess` (REND-34) и `water` (REND-35); их
 * отсутствие — значения по умолчанию, а отсутствие `water` — сцена без воды.
 */
export interface PresentationScene {
  readonly decorations: readonly DecorationRecord[];
  readonly fog?: PresentationFog;
  readonly stealth?: PresentationStealth;
  readonly lighting?: PresentationLighting;
  readonly postprocess?: PresentationPostprocess;
  readonly water?: PresentationWater;
}

/**
 * Что вызывающий знает о сцене, которой принадлежит документ (PRES-1). Пока
 * поле одно — сетка террейна: клеточная карта секции `water` адресует её клетки
 * (REND-35), и без сетки секцию не к чему привязать.
 *
 * Контекст необязателен, и это не послабление: загрузчик ассета держит ОДИН
 * документ и о парном конфиге сцены не знает (ASSET-3), поэтому размеры карты
 * проверяет тот, у кого сетка есть, — редактор и сборка сцены. Проверки,
 * которым сетка не нужна (алфавит, прямоугольность, разрешимость индексов),
 * идут в обоих случаях.
 */
export interface PresentationSceneContext {
  /** Сетка террейна сцены; `null` — террейна у сцены нет; нет поля — неизвестно. */
  readonly terrain?: WaterGridExtent | null;
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

/** Состав закрыт (PRES-2): ключ, которого формат не знает, — ошибка, а не игнор. */
const DOCUMENT_KEYS: readonly string[] = [
  'decorations',
  'fog',
  'stealth',
  'lighting',
  'postprocess',
  'water',
];
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
 * Числовые поля секции `fog` в порядке находок: границы и ТЕКСТ ожидания. Текст
 * лежит рядом с границей, а не собирается из неё: «доля затемнения» и «время
 * рассеивания» — разные величины, и автору сообщает о них поле, а не диапазон.
 */
const FOG_NUMBERS: readonly {
  readonly key: string;
  readonly expected: string;
  readonly min: number;
  readonly max?: number;
  /** Нижняя граница исключающая: сама она значением не является. */
  readonly exclusiveMin?: boolean;
}[] = [
  { key: 'strength', expected: 'ожидалась доля затемнения из [0, 1]', min: 0, max: 1 },
  // Ноль стянул бы reveal в точку, больше единицы — визуал щедрее геймплея,
  // то есть противоположность консервативности (FOW-9).
  {
    key: 'conservatism',
    expected: 'ожидалась доля из (0, 1] (FOW-9)',
    min: 0,
    max: 1,
    exclusiveMin: true,
  },
  {
    key: 'edgeWidth',
    expected: 'ожидалась неотрицательная ширина градиента в мировых единицах',
    min: 0,
  },
  {
    key: 'resolution',
    expected: 'ожидалось положительное число текселей на мировую единицу',
    min: 0,
    exclusiveMin: true,
  },
  {
    key: 'fadeSeconds',
    expected: 'ожидалась неотрицательная длительность в секундах (FOW-8)',
    min: 0,
  },
  {
    key: 'dissolveSeconds',
    expected: 'ожидалось неотрицательное время рассеивания в секундах (FOW-7)',
    min: 0,
  },
];

/** Числовые поля секции `stealth` (FOW-13): обе величины — доли непрозрачности. */
const STEALTH_NUMBERS: typeof FOG_NUMBERS = [
  { key: 'allyOpacity', expected: 'ожидалась доля непрозрачности из [0, 1] (FOW-13)', min: 0, max: 1 },
  { key: 'enemyOpacity', expected: 'ожидалась доля непрозрачности из [0, 1] (FOW-13)', min: 0, max: 1 },
];

/** Значение вне объявленных границы и формы — то, о чём говорит находка поля. */
function fogNumberBad(value: unknown, spec: (typeof FOG_NUMBERS)[number]): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return true;
  if (spec.exclusiveMin === true ? value <= spec.min : value < spec.min) return true;
  return spec.max !== undefined && value > spec.max;
}

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
  closedKeys(section, 'fog', FOG_KEYS, errors);
  for (const spec of FOG_NUMBERS) {
    if (!(spec.key in section)) continue;
    const value = section[spec.key];
    if (fogNumberBad(value, spec)) {
      errors.push(`fog.${spec.key}: ${spec.expected}, получено ${typeName(value)}`);
    }
  }
  if ('color' in section && (typeof section.color !== 'string' || !HEX_COLOR_RE.test(section.color))) {
    errors.push(`fog.color: ожидался цвет формы "#rrggbb", получено ${typeName(section.color)}`);
  }
}

/**
 * Валидация секции `stealth` (PRES-2, `fog-of-war` FOW-13): тем же порядком,
 * что `fog`, — состав закрыт, неизвестный ключ и значение не той формы
 * отвергаются адресно.
 */
function validateStealth(section: unknown, errors: string[]): void {
  if (!isRecord(section)) {
    errors.push(`stealth: ожидался объект секции подачи стелса (FOW-13), получено ${typeName(section)}`);
    return;
  }
  closedKeys(section, 'stealth', STEALTH_NUMBERS.map((spec) => spec.key), errors);
  for (const spec of STEALTH_NUMBERS) {
    if (!(spec.key in section)) continue;
    const value = section[spec.key];
    if (fogNumberBad(value, spec)) {
      errors.push(`stealth.${spec.key}: ${spec.expected}, получено ${typeName(value)}`);
    }
  }
}

/**
 * Состав записи закрыт (PRES-2). Сим-поля названы отдельно: `prefab` и
 * переопределения компонентов в записи — не опечатка, а первый шаг к
 * геймплейному влиянию в слое, который его не допускает (PRES-2, ED-19).
 */
function checkRecordKeys(entry: Record<string, unknown>, path: string, errors: string[]): void {
  for (const key of Object.keys(entry)) {
    if (RECORD_KEYS.includes(key)) continue;
    const simField = key === 'prefab' || key === 'overrides';
    errors.push(
      simField
        ? `${path}.${key}: сим-поля в записи decoration нет и быть не может — сим-стороны у неё нет вовсе (PRES-2, ED-19)`
        : `${path}.${key}: неизвестное поле (допустимы: ${RECORD_KEYS.join(', ')})`,
    );
  }
}

/** Обязательная часть записи: вид из манифеста и место на плоскости (PRES-2). */
function checkRecordPlacement(
  entry: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
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
}

/** Необязательная часть записи: курс, масштаб, скин и walkable-флаг (PRES-2). */
function checkRecordOptions(entry: Record<string, unknown>, path: string, errors: string[]): void {
  if ('yaw' in entry && (typeof entry.yaw !== 'number' || !Number.isFinite(entry.yaw))) {
    errors.push(`${path}.yaw: ожидался курс долей оборота (конечное число), получено ${typeName(entry.yaw)}`);
  }
  const scale = entry.scale;
  if ('scale' in entry && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) {
    errors.push(`${path}.scale: ожидалось положительное конечное число, получено ${typeName(scale)}`);
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

/** Запись размещения decoration (PRES-2): состав, обязательное и необязательное. */
function validateRecord(entry: unknown, path: string, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push(`${path}: ожидался объект записи decoration, получено ${typeName(entry)}`);
    return;
  }
  checkRecordKeys(entry, path, errors);
  checkRecordPlacement(entry, path, errors);
  checkRecordOptions(entry, path, errors);
}

/**
 * Список размещений (PRES-2): ненаписанный и пустой неразличимы, а не-список —
 * адресный отказ. Каждая находка адресует ЗАПИСЬ индексом, а не список целиком.
 */
function validateDecorations(list: unknown, errors: string[]): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    errors.push(`decorations: ожидался список записей размещения, получено ${typeName(list)}`);
    return;
  }
  list.forEach((entry: unknown, index: number) => {
    validateRecord(entry, `decorations[${index}]`, errors);
  });
}

/**
 * Валидация парного документа (PRES-2, PRES-3). Ошибки собираются все разом и
 * каждая адресует ЗАПИСЬ индексом, а не документ целиком: правка JSON не должна
 * превращаться в угадывание, какая из сорока декораций сломана.
 */
export function validatePresentationScene(
  doc: unknown,
  context: PresentationSceneContext = {},
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
  validateDecorations(list, errors);
  validateSections(doc, context, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scene: sceneOf(doc, list) };
}

/**
 * Секции документа. Отсутствующая секция — значения по умолчанию у своей
 * подсистемы, и наружу она в этом случае не выходит вовсе: `undefined`, а не
 * пустой объект (FOW-10 у тумана, PRES-2 у остальных).
 */
function validateSections(
  doc: Record<string, unknown>,
  context: PresentationSceneContext,
  errors: string[],
): void {
  if (doc.fog !== undefined) validateFog(doc.fog, errors);
  // Секция `stealth` (FOW-13) — тем же порядком: её умолчания держит потребитель подачи.
  if (doc.stealth !== undefined) validateStealth(doc.stealth, errors);
  // Секция `lighting` — тем же порядком и по тому же основанию: её умолчания
  // держит подсистема освещения рендера.
  if (doc.lighting !== undefined) validateLighting(doc.lighting, errors);
  // Секция `postprocess` (REND-34) — тем же порядком: её умолчания держит
  // подсистема пост-обработки, и они воспроизводят сегодняшний кадр.
  if (doc.postprocess !== undefined) validatePostprocess(doc.postprocess, errors);
  // Секция `water` (REND-35) — тем же порядком, но с одним отличием: её
  // клеточная карта адресует клетки сетки террейна, поэтому валидация получает
  // сетку контекстом. Нет контекста — сетка вызывающему неизвестна, и размеры
  // карты не проверяются; `terrain: null` — террейна у сцены нет, и секция
  // отвергается целиком.
  if (doc.water !== undefined) {
    validateWater(doc.water, errors, 'terrain' in context ? (context.terrain ?? null) : undefined);
  }
}

/**
 * Разобранный документ наружу. Отсутствующий и пустой список размещений
 * неразличимы (PRES-2): наружу и то и другое выходит пустым списком, и
 * потребителю не приходится различать их самому.
 */
function sceneOf(doc: Record<string, unknown>, list: unknown): PresentationScene {
  return {
    decorations: Array.isArray(list) ? (list as DecorationRecord[]) : [],
    ...(doc.fog === undefined ? {} : { fog: doc.fog as PresentationFog }),
    ...(doc.stealth === undefined ? {} : { stealth: doc.stealth as PresentationStealth }),
    ...(doc.lighting === undefined ? {} : { lighting: doc.lighting as PresentationLighting }),
    ...(doc.postprocess === undefined
      ? {}
      : { postprocess: doc.postprocess as PresentationPostprocess }),
    ...(doc.water === undefined ? {} : { water: doc.water as PresentationWater }),
  };
}
