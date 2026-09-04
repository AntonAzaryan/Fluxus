/**
 * Карта раскраски клеток из канала источника (BLND-14): ряды слотов, проверка
 * тем же валидатором, что стоит правилом на документе (`assets` ASSET-15), и
 * отказ при неадресованном манифестом документе.
 *
 * Источников слота два, и правила формата у них общие: клеточный канал
 * grid-объекта (`gridPaintMap` — значение клетки есть единогласие её вершин) и
 * выборка скалпт-поверхности в центре клетки (`sculptPaintMap` — значение
 * берётся у геометрии верхнего пересечения, единогласие переносится на грань).
 * Перевод значения в слот и валидация карты у обоих ОДНИ.
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
import { spreadFromFloor } from './sculpt.js';
import type { SculptHit, SculptSampler } from './sculptSampler.js';

/** Накопитель находок импорта: ошибки собираются все до одной (BLND-6). */
export interface Sink {
  readonly findings: Finding[];
}

/** Находка уровня «ошибка» с адресом объекта источника. */
export function error(sink: Sink, object: string, message: string): void {
  sink.findings.push({ severity: 'error', object, message });
}

/**
 * Значение канала — в целый индекс слота tileset'а; `null` — не разрешается, и
 * находка с адресом клетки записана. Ни округления, ни клампа: значение между
 * индексами и индекс вне алфавита карты — ошибка, ровно тем же правилом, каким
 * высота, не разрешающаяся в целый уровень, отказывает у BLND-9.
 *
 * Правило одно на оба источника слота: расхождение перевода у grid-объекта и у
 * скалпта означало бы два формата карты вместо одного (BLND-14).
 */
function slotOf(sink: Sink, object: string, x: number, y: number, raw: number): number | null {
  const slot = Math.round(raw);
  if (!Number.isFinite(raw) || Math.abs(raw - slot) > HEIGHT_EPSILON) {
    error(
      sink,
      object,
      `клетка (${x}, ${y}): значение раскраски ${formatHeight(raw)} не разрешается в целый индекс слота — ` +
        `округлять за автора импорт не вправе (BLND-14)`,
    );
    return null;
  }
  if (slot < 0 || slot > TERRAIN_PAINT_MAX_SLOT) {
    error(
      sink,
      object,
      `клетка (${x}, ${y}): слот ${slot} вне алфавита карты раскраски [0, ${TERRAIN_PAINT_MAX_SLOT}] (ASSET-15)`,
    );
    return null;
  }
  return slot;
}

/** Ряды карты из посчитанных слотов; незаполненная клетка — слот `0`. */
function rowsOfSlots(
  slots: readonly (number | null)[],
  spec: { readonly width: number; readonly height: number },
): readonly string[] {
  const rows: string[] = [];
  for (let y = 0; y < spec.height; y++) {
    let row = '';
    for (let x = 0; x < spec.width; x++) row += String(slots[y * spec.width + x] ?? 0);
    rows.push(row);
  }
  return rows;
}

/**
 * Ряды карты раскраски из клеточного канала grid-объекта (BLND-14): значение
 * клетки — единогласие её вершин, обеспеченное чтением сетки (`cells.ts`).
 */
function paintRowsOf(
  sink: Sink,
  object: SourceObject,
  grid: CellGrid,
  values: readonly number[],
): readonly string[] | null {
  const slots = new Array<number | null>(grid.width * grid.height).fill(null);
  let failed = false;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const at = y * grid.width + x;
      const slot = slotOf(sink, object.name, x, y, values[at] ?? 0);
      if (slot === null) failed = true;
      else slots[at] = slot;
    }
  }
  return failed ? null : rowsOfSlots(slots, grid);
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

/**
 * Слот клетки по её верхнему пересечению; `null` — данных нет, и находка с
 * адресом клетки и именем объекта записана (BLND-14).
 *
 * Расхождение вершин попавшей грани — отказ, а не голосование. Геометрия БЕЗ
 * канала под пересечением — тоже отказ: нули отсутствующего канала неотличимы
 * от нарисованных, и докрасить за автора импорт не вправе.
 */
function sculptSlotOf(sink: Sink, hit: SculptHit, x: number, y: number): number | null {
  if (hit.paintSplit) {
    error(
      sink,
      hit.object,
      `клетка (${x}, ${y}): вершины грани, давшей верхнее пересечение, несут разные значения канала ` +
        `раскраски — усреднять и голосовать импорт не вправе (BLND-14)`,
    );
    return null;
  }
  if (hit.paint === null) {
    error(
      sink,
      hit.object,
      `клетка (${x}, ${y}): верхнее пересечение легло на геометрию без канала "${PAINT_CHANNEL}", ` +
        `а раскраску источник даёт — докрасить за автора импорт не вправе (BLND-14)`,
    );
    return null;
  }
  return slotOf(sink, hit.object, x, y, hit.paint);
}

/**
 * Слоты клеток из выборок скалпта в их центрах; `null` в слоте — дыра, её слот
 * придёт волной. Отказ хотя бы одной клетки даёт `null` целиком.
 */
function sculptSlots(sink: Sink, sampler: SculptSampler, spec: CellGridSpec): (number | null)[] | null {
  const slots = new Array<number | null>(spec.width * spec.height).fill(null);
  let failed = false;
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const hit = sampler.topAt((x + 0.5) * spec.cellSize, (y + 0.5) * spec.cellSize);
      // Пересечения нет — клетка без пола (BLND-13): её слот берётся волной.
      if (hit === null) continue;
      const slot = sculptSlotOf(sink, hit, x, y);
      if (slot === null) failed = true;
      else slots[y * spec.width + x] = slot;
    }
  }
  return failed ? null : slots;
}

/**
 * Карта раскраски из скалпт-поверхности (BLND-14): слот клетки сэмплируется в
 * её центре тем же верхним пересечением, каким BLND-13 берёт там высоту.
 *
 * Канала нет ни у одного объекта объединения — раскраски источник не даёт
 * вовсе, и документ не переписывается (BLND-2); находки при этом нет, ровно
 * как у grid-пути с необъявленным каналом.
 *
 * Клетка без пола получает слот ТОЙ ЖЕ волной, какой BLND-13 берёт её уровень:
 * своего слота у дыры нет, а нулевой противоречил бы ASSET-15 — вернувшийся
 * правкой документа пол (ED-9) обязан вернуться прежним слотом.
 */
export function sculptPaintMap(
  sink: Sink,
  anchor: SourceObject,
  sampler: SculptSampler,
  spec: CellGridSpec,
  context: CellLayerContext,
): PaintMap | undefined {
  if (!sampler.painted) return undefined;
  if (context.paintMap == null) {
    reportMissingPaintDocument(sink, anchor);
    return undefined;
  }
  const slots = sculptSlots(sink, sampler, spec);
  if (slots === null) return undefined;
  // Волна идёт по клеткам без слота, а таких после `sculptSlots` ровно дыры:
  // клетка с отказом сюда не доходит вовсе.
  spreadFromFloor(spec, slots, () => true);
  return checkedPaintMap(sink, anchor, spec, rowsOfSlots(slots, spec)) ?? undefined;
}
