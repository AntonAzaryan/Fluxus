/**
 * Карта кривизны террейна (ASSET-7): presentation-ассет — heightfield знаковых
 * визуальных смещений высоты по узлам сетки поверх ступеней REND-7. Сетка
 * обязана совпадать с сеткой sim-террейна сцены (TERR-2): узлы — углы клеток,
 * узловая сетка (width+1) × (height+1). Проверка совпадения — на потребителе,
 * у которого есть обе (несовпадение — предупреждение и игнор, не ошибка).
 *
 * Смещение узла — целый множитель решётки 1/32 шага высоты рендера; амплитуда
 * произвольна, читаемость перепадов уровней обеспечивает cliff-кромка
 * (REND-9), а не предел формата. Целые в JSON — детерминизм повторного
 * сохранения и импорта (BLND-4) и построчно читаемый дифф.
 *
 * Правка карты не меняет `worldInit`, снапшоты и golden-файлы: ассет живёт
 * в модуле presentation-ассетов и в симуляцию не ходит (ASSET-1).
 */
import { isRecord, typeName } from './validation.js';

/**
 * Узловые смещения в 1/32 шага высоты, row-major по узлам: индекс узла
 * `ny * (width + 1) + nx`, рядов `height + 1`. `width`/`height` — размеры
 * сетки террейна в клетках. Float64 хранит безопасные целые точно; Int32 был
 * бы молчаливым усечением значений за его диапазоном.
 */
export interface TerrainCurvatureMap {
  readonly width: number;
  readonly height: number;
  readonly offsets: Float64Array;
}

/** Знаменатель решётки смещений: `offsets[i] / CURVATURE_SCALE` — доля шага высоты. */
export const CURVATURE_SCALE = 32;

/** Поля документа карты — они же перечень допустимых ключей (ASSET-7). */
const CURVATURE_KEYS: readonly string[] = ['width', 'height', 'rows'];

/**
 * Разобранная шапка документа: размеры сетки в клетках и ряды узлов как они
 * написаны. `null` — документ до узлов не дочитан, и находки уже собраны.
 */
interface CurvatureShape {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly unknown[][];
}

/** Размеры сетки и форма рядов; о содержимом узлов здесь ещё не судят. */
function readCurvatureShape(record: Record<string, unknown>, errors: string[]): CurvatureShape | null {
  for (const key of Object.keys(record)) {
    if (!CURVATURE_KEYS.includes(key)) {
      errors.push(`${key}: неизвестное поле (допустимы: ${CURVATURE_KEYS.join(', ')})`);
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
  checkCurvatureRowsShape(record.rows, errors);
  if (errors.length > 0) return null;
  return { width: width as number, height: height as number, lines: record.rows as unknown[][] };
}

/** Ряды документа: массив массивов, и ни в коем случае не прежний формат строк. */
function checkCurvatureRowsShape(rows: unknown, errors: string[]): void {
  if (!Array.isArray(rows)) {
    errors.push(`rows: ожидался массив числовых рядов узлов, получено ${typeName(rows)}`);
    return;
  }
  if (rows.some((r) => typeof r === 'string')) {
    // Прежний формат нарочно отвергается адресно: молчаливый ноль спрятал бы
    // непрошедшую миграцию карты.
    errors.push(
      'rows: ряды-строки — прежний per-cell формат (алфавит "."/"1"-"7"/"a"-"g"); ' +
        'теперь карта — числовые ряды узлов (width+1) × (height+1) в 1/32 шага высоты',
    );
    return;
  }
  if (!rows.every((r): r is unknown[] => Array.isArray(r))) {
    errors.push(`rows: ожидался массив числовых рядов узлов, получено ${typeName(rows)}`);
  }
}

/** Узлы одного ряда в `offsets`; рваный ряд отвергается целиком. */
function readCurvatureRow(
  line: readonly unknown[],
  y: number,
  nodesX: number,
  offsets: Float64Array,
  errors: string[],
): void {
  if (line.length !== nodesX) {
    // Рваная сетка отвергается, а не достраивается (TERR-3 — тот же принцип).
    errors.push(`rows[${y}]: узлов ${line.length}, а width + 1 = ${nodesX}`);
    return;
  }
  for (let x = 0; x < nodesX; x++) {
    const value = line[x];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      errors.push(
        `rows[${y}], узел ${x}: ожидался целый множитель 1/${CURVATURE_SCALE} шага высоты, ` +
          `получено ${typeof value === 'number' ? value : typeName(value)}`,
      );
      continue;
    }
    offsets[y * nodesX + x] = value;
  }
}

/**
 * Валидация документа карты кривизны (ASSET-7). Ошибки собираются все разом,
 * каждая с адресом ряда/узла — правка руками не должна быть угадыванием.
 */
export function validateCurvatureMap(
  doc: unknown,
): { ok: true; map: TerrainCurvatureMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`карта кривизны: ожидался объект, получено ${typeName(doc)}`] };
  }
  const shape = readCurvatureShape(doc, errors);
  if (shape === null) return { ok: false, errors };

  const nodesX = shape.width + 1;
  const nodesY = shape.height + 1;
  const lines = shape.lines;
  if (lines.length !== nodesY) {
    errors.push(`rows: рядов ${lines.length}, а узловых рядов height + 1 = ${nodesY}`);
  }
  const offsets = new Float64Array(nodesX * nodesY);
  for (const [y, line] of lines.entries()) {
    if (y >= nodesY) break;
    readCurvatureRow(line, y, nodesX, offsets, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map: { width: shape.width, height: shape.height, offsets } };
}
