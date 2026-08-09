/**
 * Карта кривизны террейна (ASSET-7): presentation-ассет per-cell знаковых
 * визуальных смещений высоты поверх ступеней REND-7. Сетка обязана совпадать
 * с сеткой sim-террейна сцены (TERR-2); проверка совпадения — на потребителе,
 * у которого есть обе (несовпадение — предупреждение и игнор, не ошибка).
 *
 * Смещение измеряется в 1/16 шага высоты рендера: максимум 7/16 меньше
 * полушага, поэтому ограничение амплитуды REND-9 обеспечено алфавитом по
 * построению — невалидная амплитуда невыразима.
 *
 * Правка карты не меняет `worldInit`, снапшоты и golden-файлы: ассет живёт
 * в модуле presentation-ассетов и в симуляцию не ходит (ASSET-1).
 */

/** Смещения клеток в 1/16 шага высоты, row-major, диапазон [-7..7]. */
export interface TerrainCurvatureMap {
  readonly width: number;
  readonly height: number;
  readonly offsets: Int8Array;
}

/** Знаменатель шкалы смещений: `offsets[i] / CURVATURE_SCALE` — доля шага высоты. */
export const CURVATURE_SCALE = 16;

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

/**
 * Символ клетки → смещение: `.` — ноль, `1`–`7` — выпуклость (вверх),
 * `a`–`g` — вогнутость (вниз). Null — символ вне алфавита. Верхний регистр
 * невалиден: одна карта не должна иметь двух текстовых представлений (TERR-3
 * — тот же принцип).
 */
export function curvatureOffsetOf(char: string): number | null {
  if (char === '.') return 0;
  const code = char.charCodeAt(0);
  if (code >= 0x31 && code <= 0x37) return code - 0x30; // '1'..'7'
  if (code >= 0x61 && code <= 0x67) return -(code - 0x60); // 'a'..'g'
  return null;
}

/**
 * Валидация документа карты кривизны (ASSET-7). Ошибки собираются все разом,
 * каждая с адресом ряда/клетки — правка руками не должна быть угадыванием.
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
  if (!Array.isArray(rows) || !rows.every((r): r is string => typeof r === 'string')) {
    errors.push(`rows: ожидался массив строк «символ на клетку», получено ${typeName(rows)}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const w = width as number;
  const h = height as number;
  const lines = rows as string[];
  if (lines.length !== h) {
    errors.push(`rows: рядов ${lines.length}, а height = ${h}`);
  }
  const offsets = new Int8Array(w * h);
  for (let y = 0; y < Math.min(lines.length, h); y++) {
    const line = lines[y]!;
    if (line.length !== w) {
      // Рваная сетка отвергается, а не достраивается (TERR-3 — тот же принцип).
      errors.push(`rows[${y}]: длина ${line.length}, а width = ${w}`);
      continue;
    }
    for (let x = 0; x < w; x++) {
      const offset = curvatureOffsetOf(line[x]!);
      if (offset === null) {
        errors.push(
          `rows[${y}], клетка ${x}: символ "${line[x]}" вне алфавита (допустимы ".", "1"-"7", "a"-"g")`,
        );
        continue;
      }
      offsets[y * w + x] = offset;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, map: { width: w, height: h, offsets } };
}
