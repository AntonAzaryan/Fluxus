/**
 * Раскраска клеток террейна (ASSET-15): presentation-ассет — клеточная карта,
 * называющая для каждой клетки слот tileset'а. Пара к карте кривизны
 * (`curvature.ts`): та несёт узловые смещения высоты, эта — поклеточный слот
 * покрытия; обе адресуются разделом `terrain` манифеста визуалов (ASSET-6) и
 * обе обязаны совпасть с сеткой террейна сцены (TERR-2). Проверка совпадения —
 * на потребителе, у которого есть обе (несовпадение — предупреждение и рендер
 * без текстурирования, не ошибка).
 *
 * ## Символ, а не веса
 *
 * В документе ОДИН слот на клетку, а смешивание на границах выводит рендер по
 * вершинам (REND-39): веса в документе сделали бы дифф нечитаемым, а импорт —
 * обязанным обещать детерминизм на округлении float (BLND-4). Ряды строками —
 * тот же формат, что у карт уровней и видов клеток (TERR-3) и у карты воды
 * (REND-35): арена читается глазами прямо в дифсе.
 *
 * ## Алфавит шире предела рендера — намеренно
 *
 * Цифра `0`–`9` — десять выразимых слотов; сколько из них смешивает сегодняшний
 * рендер, решает REND-39 (четыре — граница числа клеток, сходящихся в узле).
 * Валидация про tileset не знает и знать не должна: слот за пределом
 * объявленных разбирает ПОТРЕБИТЕЛЬ, у которого есть обе стороны, — тем же
 * приёмом, каким формат кривизны не ограничивает амплитуду (ASSET-7).
 *
 * Правка карты не меняет `worldInit`, снапшоты и golden-файлы: ассет живёт в
 * модуле presentation-ассетов и в симуляцию не ходит (ASSET-1).
 */
import { isRecord, typeName } from './validation.js';

/**
 * Индексы слотов по клеткам, row-major: адрес клетки `y * width + x`.
 * Uint8Array — алфавит документа десятизначный, и байта на клетку хватает с
 * запасом; массив плотный, потому что плотна и сама сетка.
 */
export interface TerrainPaintMap {
  readonly width: number;
  readonly height: number;
  readonly slots: Uint8Array;
}

/** Поля документа карты — они же перечень допустимых ключей (ASSET-15). */
const PAINT_KEYS: readonly string[] = ['width', 'height', 'rows'];

/** Наибольший индекс слота, выразимый алфавитом документа. */
export const TERRAIN_PAINT_MAX_SLOT = 9;

/** Символ клетки в индекс слота; `-1` — символ вне алфавита. */
function slotOfChar(char: string): number {
  const code = char.charCodeAt(0);
  return code >= 0x30 && code <= 0x39 ? code - 0x30 : -1;
}

/** Разобранная шапка документа: размеры сетки и ряды как они написаны. */
interface PaintShape {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
}

/** Размеры сетки и форма рядов; о символах здесь ещё не судят. */
function readPaintShape(record: Record<string, unknown>, errors: string[]): PaintShape | null {
  for (const key of Object.keys(record)) {
    if (!PAINT_KEYS.includes(key)) {
      errors.push(`${key}: неизвестное поле (допустимы: ${PAINT_KEYS.join(', ')})`);
    }
  }
  const width = record.width;
  const height = record.height;
  if (!Number.isInteger(width) || (width as number) <= 0) {
    errors.push(`width: ожидалось целое > 0, получено ${typeName(width)}`);
  }
  if (!Number.isInteger(height) || (height as number) <= 0) {
    errors.push(`height: ожидалось целое > 0, получено ${typeName(height)}`);
  }
  const rows = record.rows;
  if (!Array.isArray(rows) || !rows.every((row): row is string => typeof row === 'string')) {
    errors.push(`rows: ожидался массив текстовых рядов раскраски, получено ${typeName(rows)}`);
  }
  if (errors.length > 0) return null;
  return { width: width as number, height: height as number, rows: rows as string[] };
}

/** Клетки одного ряда в `slots`; рваный ряд отвергается целиком. */
function readPaintRow(row: string, y: number, width: number, slots: Uint8Array, errors: string[]): void {
  if (row.length !== width) {
    // Рваная сетка отвергается, а не достраивается (TERR-3 — тот же принцип).
    errors.push(`rows[${y}]: клеток ${row.length}, а width = ${width}`);
    return;
  }
  for (let x = 0; x < width; x++) {
    const slot = slotOfChar(row[x]!);
    if (slot < 0) {
      errors.push(
        `rows[${y}], клетка ${x}: символ "${row[x]!}" вне алфавита — ожидалась цифра 0-${TERRAIN_PAINT_MAX_SLOT} ` +
          `(индекс слота tileset'а)`,
      );
      continue;
    }
    slots[y * width + x] = slot;
  }
}

/**
 * Валидация документа карты раскраски (ASSET-15). Ошибки собираются все разом,
 * каждая с адресом ряда/клетки — правка руками не должна быть угадыванием.
 */
export function validateTerrainPaint(
  doc: unknown,
): { ok: true; map: TerrainPaintMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`ожидался объект документа карты раскраски, получено ${typeName(doc)}`] };
  }
  const shape = readPaintShape(doc, errors);
  if (shape === null) return { ok: false, errors };
  if (shape.rows.length !== shape.height) {
    errors.push(`rows: рядов ${shape.rows.length}, а height = ${shape.height}`);
    return { ok: false, errors };
  }
  const slots = new Uint8Array(shape.width * shape.height);
  for (let y = 0; y < shape.height; y++) {
    readPaintRow(shape.rows[y]!, y, shape.width, slots, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map: { width: shape.width, height: shape.height, slots } };
}
