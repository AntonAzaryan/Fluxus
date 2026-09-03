/**
 * Карта раскраски клеток из клеточного канала источника (BLND-14): ряды слотов,
 * проверка тем же валидатором, что стоит правилом на документе (`assets`
 * ASSET-15), и отказ при неадресованном манифестом документе.
 *
 * Отдельно от `maps.ts`, потому что там — уровни, флаги, кривизна и скалпт, то
 * есть РЕЛЬЕФ, а раскраска ездит по тем же клеткам, но описывает покрытие. Сток
 * находок (`Sink`, `error`) живёт здесь же: его делят оба модуля, и второй его
 * копии заводить нельзя.
 */
import { TERRAIN_PAINT_MAX_SLOT, validateTerrainPaint } from '@fluxus/assets';
import { HEIGHT_EPSILON, PAINT_CHANNEL, formatHeight, type CellGrid, type CellGridSpec } from './cells.js';
import type { CellLayerContext, Finding, PaintMap } from './layer.js';
import type { SourceObject } from './normalize.js';

/** Накопитель находок импорта: ошибки собираются все до одной (BLND-6). */
export interface Sink {
  readonly findings: Finding[];
}

/** Находка уровня «ошибка» с адресом объекта источника. */
export function error(sink: Sink, object: string, message: string): void {
  sink.findings.push({ severity: 'error', object, message });
}

/**
 * Ряды карты раскраски из клеточного канала (BLND-14): значение канала — целый
 * индекс слота tileset'а. Ни округления, ни клампа: значение между индексами и
 * индекс вне алфавита карты — ошибка с адресом клетки, ровно тем же правилом,
 * каким высота, не разрешающаяся в целый уровень, отказывает у BLND-9.
 */
function paintRowsOf(
  sink: Sink,
  object: SourceObject,
  grid: CellGrid,
  values: readonly number[],
): readonly string[] | null {
  const rows: string[] = [];
  let failed = false;
  for (let y = 0; y < grid.height; y++) {
    let row = '';
    for (let x = 0; x < grid.width; x++) {
      const raw = values[y * grid.width + x] ?? 0;
      const slot = Math.round(raw);
      if (!Number.isFinite(raw) || Math.abs(raw - slot) > HEIGHT_EPSILON) {
        error(
          sink,
          object.name,
          `клетка (${x}, ${y}): значение раскраски ${formatHeight(raw)} не разрешается в целый индекс слота — ` +
            `округлять за автора импорт не вправе (BLND-14)`,
        );
        failed = true;
        continue;
      }
      if (slot < 0 || slot > TERRAIN_PAINT_MAX_SLOT) {
        error(
          sink,
          object.name,
          `клетка (${x}, ${y}): слот ${slot} вне алфавита карты раскраски [0, ${TERRAIN_PAINT_MAX_SLOT}] (ASSET-15)`,
        );
        failed = true;
        continue;
      }
      row += String(slot);
    }
    rows.push(row);
  }
  return failed ? null : rows;
}

/**
 * Карта раскраски из посчитанных рядов, проверенная тем же вызовом, что стоит
 * правилом на документе раскраски (ASSET-15). `null` — карта отвергнута.
 */
function checkedPaintMap(
  sink: Sink,
  object: SourceObject,
  spec: CellGridSpec,
  rows: readonly string[],
): PaintMap | null {
  const checked = validateTerrainPaint({ width: spec.width, height: spec.height, rows: [...rows] });
  if (checked.ok) return { width: spec.width, height: spec.height, rows };
  for (const message of checked.errors) {
    error(sink, object.name, `карта раскраски отвергнута проверкой (validateTerrainPaint): ${message}`);
  }
  return null;
}

/**
 * Манифест визуалов не адресует документ карты раскраски: переписывать нечего.
 * Молчаливый пропуск означал бы «импорт прошёл» при непринятой раскраске — тот
 * же довод, что у карты кривизны (BLND-14).
 */
function reportMissingPaintDocument(sink: Sink, object: SourceObject): void {
  error(
    sink,
    object.name,
    'манифест визуалов не адресует карту раскраски ("terrain.paintMap", ASSET-15): переписывать нечего',
  );
}

/**
 * Карта раскраски из того же grid-объекта (BLND-14): канал раскраски едет
 * рядом с рампой и полом, потому что красится та же клетка. Канала в экспорте
 * нет — раскраски у источника нет вовсе, и документ не переписывается (BLND-2:
 * отсутствие слоя значит «источник его не даёт»).
 */
export function gridPaintMap(
  sink: Sink,
  object: SourceObject,
  grid: CellGrid,
  spec: CellGridSpec,
  context: CellLayerContext,
): PaintMap | undefined {
  // Канала в экспорте не было вовсе — раскраски у источника нет, и документ не
  // переписывается (BLND-2): нули отсутствующего канала неотличимы от
  // нарисованных, поэтому спрашивается наличие, а не значения.
  if (!grid.present.has(PAINT_CHANNEL)) return undefined;
  const values = grid.channels[PAINT_CHANNEL] ?? [];
  if (context.paintMap == null) {
    reportMissingPaintDocument(sink, object);
    return undefined;
  }
  const rows = paintRowsOf(sink, object, grid, values);
  if (rows === null) return undefined;
  return checkedPaintMap(sink, object, spec, rows) ?? undefined;
}
