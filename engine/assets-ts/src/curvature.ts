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

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

/**
 * Валидация документа карты кривизны (ASSET-7). Ошибки собираются все разом,
 * каждая с адресом ряда/узла — правка руками не должна быть угадыванием.
 */
export function validateCurvatureMap(
  doc: unknown,
): { ok: true; map: TerrainCurvatureMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, errors: [`карта кривизны: ожидался объект, получено ${typeName(doc)}`] };
  }
  const record = doc as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['width', 'height', 'rows'].includes(key)) {
      errors.push(`${key}: неизвестное поле (допустимы: width, height, rows)`);
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
  if (!Array.isArray(rows)) {
    errors.push(`rows: ожидался массив числовых рядов узлов, получено ${typeName(rows)}`);
  } else if (rows.some((r) => typeof r === 'string')) {
    // Прежний формат нарочно отвергается адресно: молчаливый ноль спрятал бы
    // непрошедшую миграцию карты.
    errors.push(
      'rows: ряды-строки — прежний per-cell формат (алфавит "."/"1"-"7"/"a"-"g"); ' +
        'теперь карта — числовые ряды узлов (width+1) × (height+1) в 1/32 шага высоты',
    );
  } else if (!rows.every((r): r is unknown[] => Array.isArray(r))) {
    errors.push(`rows: ожидался массив числовых рядов узлов, получено ${typeName(rows)}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const w = width as number;
  const h = height as number;
  const nodesX = w + 1;
  const nodesY = h + 1;
  const lines = rows as unknown[][];
  if (lines.length !== nodesY) {
    errors.push(`rows: рядов ${lines.length}, а узловых рядов height + 1 = ${nodesY}`);
  }
  const offsets = new Float64Array(nodesX * nodesY);
  for (let y = 0; y < Math.min(lines.length, nodesY); y++) {
    const line = lines[y]!;
    if (line.length !== nodesX) {
      // Рваная сетка отвергается, а не достраивается (TERR-3 — тот же принцип).
      errors.push(`rows[${y}]: узлов ${line.length}, а width + 1 = ${nodesX}`);
      continue;
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
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map: { width: w, height: h, offsets } };
}
