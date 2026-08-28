/**
 * Таблица цветокоррекции кадра (`rendering` REND-34) — presentation-ассет вида
 * `lut`: трёхмерная решётка «цвет кадра → цвет кадра», которой рендер задаёт
 * единый look. Формат файла — `.cube` (Adobe Cube LUT), самый распространённый
 * выход цветокоррекционных пакетов; парсер здесь, потому что модуль ассетов
 * рендер-агностичен (ASSET-5) и таблица обязана разбираться headless в Node.
 *
 * Что модуль отдаёт — ДАННЫЕ: сторона решётки и плоский `Float32Array` из
 * `size³` троек RGB. Ни `Data3DTexture`, ни какого-либо другого GPU-объекта
 * здесь нет и быть не может: их строит потребитель (`render-ts`) из этих же
 * разделяемых данных (ASSET-5).
 *
 * Порядок значений — тот же, что в файле и что ждёт трёхмерная текстура: первым
 * меняется красный, последним синий; индекс тройки `(b * size + g) * size + r`.
 *
 * На симуляцию таблица не влияет ни байтом (ASSET-1, PRES-4): это цвет кадра.
 */

/**
 * Загруженная таблица цвета: сторона решётки и её значения. Иммутабельна и
 * разделяется всеми потребителями (ASSET-5) — копий на инстанс не бывает.
 */
export interface ColorLut {
  /** Сторона решётки: значений в таблице `size³`, троек чисел — столько же. */
  readonly size: number;
  /** `size³ × 3` компонент RGB подряд; красный меняется первым. */
  readonly data: Float32Array;
}

/**
 * Границы стороны решётки. Нижняя — двойка: решётка из одного узла не таблица,
 * а один цвет. Верхняя — 64: это `64³ × 3` чисел, около 3 МиБ текста в дереве
 * контента и мегабайт в текстуре, и выше неё выигрыш в точности зрительно уже
 * не читается, а файл и загрузка растут кубом. Значение вне границ — адресный
 * отказ, а не молчаливое усечение: усечь решётку значит нарисовать не тот цвет,
 * который автор сохранил.
 */
export const MIN_LUT_SIZE = 2;
export const MAX_LUT_SIZE = 64;

/** Ключевые слова заголовка `.cube`, которые формат знает. */
const KEYWORDS = ['TITLE', 'LUT_3D_SIZE', 'LUT_1D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX'];

/** Компонент домена — число; иначе строка заголовка не разбирается. */
function domainOf(parts: readonly string[]): readonly number[] | null {
  if (parts.length !== 4) return null;
  const values = parts.slice(1).map((part) => Number(part));
  return values.every((value) => Number.isFinite(value)) ? values : null;
}

/**
 * Состояние разбора между строками: объявленная сторона решётки (0 — ещё не
 * объявлена) и накопленные компоненты значений в порядке файла.
 */
interface CubeParse {
  size: number;
  readonly values: number[];
}

/**
 * Домен принимается только единичный (`0 0 0` … `1 1 1`) — умолчание формата:
 * иной домен требует своей нормировки перед выборкой, которой у потребителя
 * нет, и принять его молча значило бы соврать о цвете кадра.
 */
function checkDomainLine(
  head: 'DOMAIN_MIN' | 'DOMAIN_MAX',
  parts: readonly string[],
  line: string,
  at: number,
  errors: string[],
): void {
  const domain = domainOf(parts);
  const expected = head === 'DOMAIN_MIN' ? 0 : 1;
  if (domain === null || domain.some((value) => value !== expected)) {
    errors.push(
      `строка ${at}: ${head} поддерживается только единичный (${expected} ${expected} ${expected}), получено "${line}"`,
    );
  }
}

/** Сторона решётки: целое из границ формата и объявленное ровно один раз. */
function readSizeLine(
  parts: readonly string[],
  at: number,
  state: CubeParse,
  errors: string[],
): void {
  const declared = Number(parts[1]);
  if (!Number.isInteger(declared) || declared < MIN_LUT_SIZE || declared > MAX_LUT_SIZE) {
    errors.push(
      `строка ${at}: LUT_3D_SIZE — целое из [${MIN_LUT_SIZE}, ${MAX_LUT_SIZE}], получено "${parts[1] ?? ''}"`,
    );
    return;
  }
  if (state.size !== 0) {
    errors.push(`строка ${at}: LUT_3D_SIZE объявлен второй раз — таблица одна`);
    return;
  }
  state.size = declared;
}

/**
 * Строка заголовка (`KEYWORDS`). Одномерная таблица — это кривая на канал,
 * другой механизм и другая выборка, и молча подставить вместо неё трёхмерную
 * значило бы нарисовать не то, что в файле.
 */
function readHeaderLine(
  head: string,
  parts: readonly string[],
  line: string,
  at: number,
  state: CubeParse,
  errors: string[],
): void {
  if (head === 'LUT_1D_SIZE') {
    errors.push(
      `строка ${at}: одномерная таблица (LUT_1D_SIZE) не поддерживается — нужна трёхмерная (LUT_3D_SIZE)`,
    );
    return;
  }
  if (head === 'TITLE') return;
  if (head === 'DOMAIN_MIN' || head === 'DOMAIN_MAX') {
    checkDomainLine(head, parts, line, at, errors);
    return;
  }
  readSizeLine(parts, at, state, errors);
}

/** Строка данных: тройка конечных чисел RGB в порядке файла. */
function readTripleLine(
  parts: readonly string[],
  line: string,
  at: number,
  values: number[],
  errors: string[],
): void {
  if (parts.length !== 3) {
    errors.push(`строка ${at}: ожидалась тройка RGB, получено "${line}"`);
    return;
  }
  const rgb = parts.map((part) => Number(part));
  if (rgb.some((value) => !Number.isFinite(value))) {
    errors.push(`строка ${at}: компоненты RGB — конечные числа, получено "${line}"`);
    return;
  }
  values.push(...rgb);
}

/**
 * Разбор `.cube` в таблицу цвета (REND-34). Ошибки собираются все разом и
 * называют НОМЕР СТРОКИ файла: таблица правится в редакторе цвета, и «файл
 * невалиден» без адреса не сказало бы автору ничего.
 *
 * Поддерживается только трёхмерная таблица, и только единичный домен формата —
 * основания у обоих ограничений названы на самих проверках.
 */
export function parseCubeLut(
  text: string,
): { ok: true; lut: ColorLut } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const state: CubeParse = { size: 0, values: [] };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    // Пустая строка и комментарий `#` — законная часть файла: экспортёры пишут
    // и то и другое.
    if (line.length === 0 || line.startsWith('#')) continue;
    const at = index + 1;
    const parts = line.split(/\s+/);
    const head = (parts[0] ?? '').toUpperCase();
    if (KEYWORDS.includes(head)) readHeaderLine(head, parts, line, at, state, errors);
    else readTripleLine(parts, line, at, state.values, errors);
  }
  const { size, values } = state;
  if (size === 0) errors.push('LUT_3D_SIZE: обязательное поле — стороны решётки в файле нет');
  const expected = size * size * size * 3;
  if (size !== 0 && values.length !== expected) {
    errors.push(
      `значений ${values.length / 3} троек — решётке ${size}³ нужно ровно ${expected / 3}: файл обрезан либо сторона объявлена не та`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, lut: Object.freeze({ size, data: Float32Array.from(values) }) };
}
