/**
 * Клеточные и узловые слои источника: карты ассета террейна (BLND-9) и карта
 * кривизны (BLND-10). Считаются здесь, в память; пишет их та же операция
 * авторинга, что и расстановку (BLND-5) — второго пути записи у конвейера нет.
 *
 * ## Ни одного своего правила формата
 *
 * Символ уровня и символ вида клетки — запись ЯДРА (`terrainLevelChar`,
 * `terrainFlagChar`, TERR-3), диапазон уровней — его же `TERRAIN_LEVEL_MAX`.
 * Проверка получившегося ассета — `createTerrainGrid`, тот самый вызов, которым
 * ассет проверяет правило редактора у кисти ED-10: диапазоны, алфавиты, форма
 * сетки и ширина рампы (TERR-7) приходят из него, а не из второй реализации
 * рядом (BLND-9 «те же правила и та же реализация», ED-1, CORE-3).
 *
 * Решётка карты кривизны (`1/CURVATURE_SCALE` шага высоты) принадлежит модулю
 * ассетов (ASSET-7). Проверка получившейся карты — `validateCurvatureMap`, тот
 * же вызов, что стоит правилом на документе кривизны.
 *
 * ## Дискретность уровней: отказ вместо округления
 *
 * Высота клетки — целое число уровней по построению (кисть аддона ходит целыми
 * шагами). Высота, не разрешающаяся в целый уровень, — ОШИБКА с адресом клетки,
 * а не округление (BLND-9, design 7): округляя за автора, импорт сделал бы
 * `worldInit` функцией от микро-правок скульпта у границы кванта. Допуск
 * `readCellGrid` — про шум float32 экспорта, а не про свободу автора: клетка на
 * высоте 1.4 отказывает, клетка на 1.0000001 — нет.
 *
 * ## Кривизна: произвольная амплитуда, квантование к решётке
 *
 * Слой presentation: скульпт свободен, вершины curvature-объекта — узлы сетки
 * (углы клеток), значение узла квантуется к решётке `1/CURVATURE_SCALE` шага и
 * переносится как есть — клампа и предупреждения об амплитуде нет (BLND-10):
 * читаемость перепадов уровней в кадре держит cliff-кромка (REND-9), а не
 * ограничение конвейера. Ошибка представления (не конечное число, вне
 * безопасного целого диапазона) — отказ с адресом узла (BLND-6).
 */
import {
  TERRAIN_LEVEL_MAX,
  createTerrainGrid,
  fixed,
  terrainFlagChar,
  terrainLevelChar,
  type TerrainDef,
  type TerrainGrid,
} from '@fluxus/core';
import { CURVATURE_SCALE, validateCurvatureMap } from '@fluxus/assets';
import {
  HEIGHT_EPSILON,
  NOFLOOR_CHANNEL,
  formatHeight,
  RAMP_CHANNEL,
  readCellGrid,
  readNodeGrid,
  type CellGrid,
  type CellGridSpec,
  type NodeGrid,
} from './cells.js';
import type { GltfDocument } from './gltf.js';
import { byObjectName } from './layer.js';
import {
  buildSculptSampler,
  cliffJumpOf,
  deriveSculptCells,
  nodeBaseLevels,
  sampleNodeHeight,
  sculptObjectsOf,
  type SculptSampler,
} from './sculpt.js';
import type {
  CellLayerContext,
  CurvatureMap,
  Finding,
  SpatialLayer,
  TargetTerrain,
  TerrainMaps,
} from './layer.js';
import { hasSingleSemantic, type SemanticKind, type SourceObject } from './normalize.js';

/**
 * Один уровень террейна — одна мировая единица высоты в источнике. Конвенция
 * конвейера (`CONVENTIONS.md`), парная `LEVEL_UNIT` аддона: у симуляции высота
 * уровня безразмерна, поэтому её единицу назначает тот, кто переводит скульпт в
 * уровни, — и назначает один раз, в одном месте, на обе стороны.
 */
export const LEVEL_UNIT = 1;

/** Клеточные слои источника: то, что импорт перепишет в ассетах. */
export interface CellLayer {
  readonly terrain?: TerrainMaps;
  readonly curvature?: CurvatureMap;
  readonly findings: readonly Finding[];
}

interface Sink {
  readonly findings: Finding[];
}

function error(sink: Sink, object: string, message: string): void {
  sink.findings.push({ severity: 'error', object, message });
}

/**
 * Единственный объект источника с этой семантикой. Двух не бывает: сцена одна,
 * ассет террейна у неё один, и выбирать между двумя сетками импорт не вправе.
 * Порядок обхода — по имени (BLND-4), чтобы сообщение не зависело от порядка
 * узлов glTF.
 */
function singleObject(sink: Sink, objects: readonly SourceObject[], kind: SemanticKind): SourceObject | null {
  const found = objects.filter((object) => hasSingleSemantic(object, kind)).sort(byObjectName);
  const first = found[0];
  if (first === undefined) return null;
  for (const extra of found.slice(1)) {
    error(
      sink,
      extra.name,
      `объектов со свойством "${kind}" в источнике несколько (${found.map((o) => o.name).join(', ')}) — ` +
        `сетка у сцены одна (BLND-9, BLND-10)`,
    );
  }
  return found.length === 1 ? first : null;
}

/** Сетка чтения по ассету цели: `tileSize` Q16.16 → мировые единицы (FP-1). */
function specOf(terrain: TargetTerrain): CellGridSpec {
  return { width: terrain.width, height: terrain.height, cellSize: fixed.toFloat(terrain.tileSize) };
}

/** Символ уровня клетки (TERR-3); `null` — высота его не даёт, находка записана. */
function levelCharOf(sink: Sink, object: SourceObject, x: number, y: number, height: number): string | null {
  const raw = height / LEVEL_UNIT;
  const level = Math.round(raw);
  if (Math.abs(raw - level) > HEIGHT_EPSILON) {
    // Ни округления, ни подгонки: высота между уровнями — ошибка (BLND-9).
    error(
      sink,
      object.name,
      `клетка (${x}, ${y}): высота ${formatHeight(height)} не разрешается в целый уровень — ` +
        `округлять за автора импорт не вправе (BLND-9)`,
    );
    return null;
  }
  const levelChar = terrainLevelChar(level);
  if (levelChar === null) {
    error(sink, object.name, `клетка (${x}, ${y}): уровень ${level} вне диапазона [0, ${TERRAIN_LEVEL_MAX}] (TERR-3)`);
    return null;
  }
  return levelChar;
}

/** Символ вида клетки (TERR-3); `null` — вид его не даёт, находка записана. */
function flagCharOf(
  sink: Sink,
  object: SourceObject,
  x: number,
  y: number,
  ramp: boolean,
  hollow: boolean,
): string | null {
  if (ramp && hollow) {
    // Один символ описывает клетку целиком (TERR-3): комбинаций в модели
    // нет, и выбрать за автора один из двух признаков импорт не вправе.
    error(sink, object.name, `клетка (${x}, ${y}): помечена и рампой, и снятым полом — вид клетки один (TERR-3)`);
    return null;
  }
  const flagChar = terrainFlagChar(ramp ? 'ramp' : hollow ? 'noFloor' : 'plain');
  if (flagChar === null) {
    error(sink, object.name, `клетка (${x}, ${y}): вид клетки не выражается алфавитом карты (TERR-3)`);
    return null;
  }
  return flagChar;
}

/** Карты террейна из клеточных данных (BLND-9, TERR-3). */
function terrainMapsOf(sink: Sink, object: SourceObject, grid: CellGrid): TerrainMaps | null {
  const ramps = grid.channels[RAMP_CHANNEL] ?? [];
  const noFloor = grid.channels[NOFLOOR_CHANNEL] ?? [];
  const levels: string[] = [];
  const flags: string[] = [];
  let failed = false;

  for (let y = 0; y < grid.height; y++) {
    let levelRow = '';
    let flagRow = '';
    for (let x = 0; x < grid.width; x++) {
      // Сетка плотная по построению читателя: значение есть у каждой клетки.
      const at = y * grid.width + x;
      const levelChar = levelCharOf(sink, object, x, y, grid.heights[at]!);
      if (levelChar === null) {
        failed = true;
        continue;
      }
      const flagChar = flagCharOf(sink, object, x, y, (ramps[at] ?? 0) !== 0, (noFloor[at] ?? 0) !== 0);
      if (flagChar === null) {
        failed = true;
        continue;
      }
      levelRow += levelChar;
      flagRow += flagChar;
    }
    levels.push(levelRow);
    flags.push(flagRow);
  }
  return failed ? null : { levels, flags };
}

/** Ряды карты кривизны из узловых данных: квантование к решётке 1/32 (BLND-10). */
function curvatureRowsOf(
  sink: Sink,
  object: SourceObject,
  grid: NodeGrid,
): readonly (readonly number[])[] | null {
  const nodesX = grid.width + 1;
  const nodesY = grid.height + 1;
  const rows: number[][] = [];
  let failed = false;
  for (let y = 0; y < nodesY; y++) {
    const row: number[] = [];
    for (let x = 0; x < nodesX; x++) {
      const value = grid.heights[y * nodesX + x]! / LEVEL_UNIT;
      if (!Number.isFinite(value)) {
        error(sink, object.name, `узел (${x}, ${y}): смещение не является конечным числом`);
        failed = true;
        continue;
      }
      // Симметрично для выпуклости и вогнутости: `Math.round` половину тянет к
      // плюс бесконечности, и ступень −0.5 ушла бы не туда, куда +0.5.
      const scaled = value * CURVATURE_SCALE;
      const offset = Math.sign(scaled) * Math.round(Math.abs(scaled));
      if (!Number.isSafeInteger(offset)) {
        // Амплитуда произвольна, но представление — целое JSON: за его пределом
        // отказ, а не молчаливое приведение (BLND-4, BLND-6).
        error(
          sink,
          object.name,
          `узел (${x}, ${y}): смещение ${formatHeight(value)} шага высоты не выражается ` +
            `целым множителем 1/${CURVATURE_SCALE} (ASSET-7)`,
        );
        failed = true;
        continue;
      }
      // -0 нормализуется в 0: у карты одно представление нуля (BLND-4).
      row.push(offset === 0 ? 0 : offset);
    }
    rows.push(row);
  }
  return failed ? null : rows;
}

/**
 * Ассет террейна из посчитанных карт, проверенный ЯДРОМ — тем же вызовом,
 * которым ассет проверяет правило редактора у кисти ED-10: диапазон уровней и
 * авто-рампа шириной в одну клетку отказывают здесь ровно потому, что отказали
 * бы там (BLND-9, TERR-3, TERR-7). Источник правды один — и у grid-пути, и у
 * скалпта. `null` — ядро ассет отвергло, находка записана.
 */
function checkedTerrainGrid(
  sink: Sink,
  object: SourceObject,
  target: TargetTerrain,
  maps: TerrainMaps,
): TerrainGrid | null {
  const def: TerrainDef = { ...target, levels: [...maps.levels], flags: [...maps.flags] };
  try {
    return createTerrainGrid(def);
  } catch (rejected) {
    error(
      sink,
      object.name,
      `ассет террейна отвергнут проверкой ядра (createTerrainGrid): ${
        rejected instanceof Error ? rejected.message : String(rejected)
      }`,
    );
    return null;
  }
}

/**
 * Карта кривизны из посчитанных рядов, проверенная тем же вызовом, что стоит
 * правилом на документе кривизны (ASSET-7). `null` — карта отвергнута.
 */
function checkedCurvatureMap(
  sink: Sink,
  object: SourceObject,
  spec: CellGridSpec,
  rows: readonly (readonly number[])[],
): CurvatureMap | null {
  const checked = validateCurvatureMap({
    width: spec.width,
    height: spec.height,
    rows: rows.map((row) => [...row]),
  });
  if (checked.ok) return { width: spec.width, height: spec.height, rows };
  for (const message of checked.errors) {
    error(sink, object.name, `карта кривизны отвергнута проверкой (validateCurvatureMap): ${message}`);
  }
  return null;
}

/**
 * Манифест визуалов не адресует документ карты кривизны: переписывать нечего.
 * Молчаливый пропуск означал бы «импорт прошёл» при неимпортированной кривизне;
 * чинится это правкой манифеста (`terrain.curvatureMap`, ASSET-7).
 */
function reportMissingCurvatureDocument(sink: Sink, object: SourceObject): void {
  error(
    sink,
    object.name,
    'манифест визуалов не адресует карту кривизны ("terrain.curvatureMap", ASSET-7): переписывать нечего',
  );
}

/**
 * У слоя один источник: grid-объект рядом со скалптом — ошибка, а не тихий
 * приоритет (BLND-13). Ошибка стоит на grid-объекте: выбор за автором.
 */
function reportGridsWithSculpt(sink: Sink, terrain: SourceObject | null, curvature: SourceObject | null): void {
  for (const [kind, grid] of [
    ['terrain', terrain],
    ['curvature', curvature],
  ] as const) {
    if (grid === null) continue;
    error(sink, grid.name, `grid-объект "${kind}" вместе со sculpt-поверхностью: у слоя один источник (BLND-13)`);
  }
}

/**
 * Сетка у обоих grid-объектов одна и берётся у ассета террейна сцены (TERR-2,
 * ASSET-7): без него сверять источник не с чем, а выдумать сетку из самого
 * источника значило бы дать ему право менять размеры арены (BLND-9).
 */
function reportMissingTargetTerrain(sink: Sink, objects: readonly (SourceObject | null)[]): void {
  for (const object of objects) {
    if (object === null) continue;
    error(
      sink,
      object.name,
      'в конфиге сцены нет ассета террейна: сетки, с которой обязан совпасть grid-объект, не существует (TERR-2)',
    );
  }
}

/**
 * Уровни, пол и рампы объединения скалпта — в карты террейна (BLND-13). Перевод
 * чисел в символы тот же, что у grid-пути (`terrainMapsOf`): sculpt меняет
 * источник высот, а не формат и не правила.
 */
function sculptTerrainMaps(
  sink: Sink,
  anchor: SourceObject,
  sampler: SculptSampler,
  spec: CellGridSpec,
  cliffJump: number,
): TerrainMaps | null {
  const cells = deriveSculptCells(sampler, spec, cliffJump, TERRAIN_LEVEL_MAX, LEVEL_UNIT);
  for (const cell of cells.outOfRange) {
    // Отказ называет клетку и СЫРУЮ высоту (BLND-13): квантованный уровень
    // автору ни о чём — править он будет высоту скалпта.
    error(
      sink,
      anchor.name,
      `клетка (${cell.x}, ${cell.y}): высота ${formatHeight(cell.height)} даёт уровень вне диапазона ` +
        `[0, ${TERRAIN_LEVEL_MAX}] (TERR-3) — клампа за автора нет (BLND-13)`,
    );
  }
  if (cells.outOfRange.length > 0) return null;
  const grid: CellGrid = {
    width: spec.width,
    height: spec.height,
    heights: cells.heights,
    channels: { [RAMP_CHANNEL]: cells.ramps, [NOFLOOR_CHANNEL]: cells.noFloor },
  };
  return terrainMapsOf(sink, anchor, grid);
}

/**
 * Остаток кривизны: скалпт минус узловая высота ступенчатой террейн-формы по
 * правилу углов рендера (BLND-13, design 3). Узел без геометрии — ноль:
 * кривизна принадлежит полу, которого здесь нет.
 */
function sculptCurvatureHeights(sampler: SculptSampler, spec: CellGridSpec, terrainGrid: TerrainGrid): number[] {
  const bases = nodeBaseLevels(terrainGrid);
  const nodesX = spec.width + 1;
  const nodesY = spec.height + 1;
  const residuals = new Array<number>(nodesX * nodesY).fill(0);
  for (let nodeY = 0; nodeY < nodesY; nodeY++) {
    for (let nodeX = 0; nodeX < nodesX; nodeX++) {
      const sampled = sampleNodeHeight(sampler, spec, nodeX, nodeY);
      if (sampled === null) continue;
      residuals[nodeY * nodesX + nodeX] = sampled - bases[nodeY * nodesX + nodeX]! * LEVEL_UNIT;
    }
  }
  return residuals;
}

/**
 * Клеточные слои из скалпт-поверхности (BLND-13): объединение sculpt-мешей
 * дискретизируется в ОБА слоя — карты террейна и карту кривизны. Перевод чисел
 * в символы и валидация — те же вызовы, что у grid-пути (`terrainMapsOf`,
 * `checkedTerrainGrid`, `curvatureRowsOf`, `checkedCurvatureMap`): sculpt меняет
 * источник высот, а не формат и не правила.
 */
function sculptCellLayer(
  sink: Sink,
  document: GltfDocument,
  sculptObjects: readonly SourceObject[],
  anchor: SourceObject,
  terrainObject: SourceObject | null,
  curvatureObject: SourceObject | null,
  target: TargetTerrain | null,
  context: CellLayerContext,
): CellLayer {
  reportGridsWithSculpt(sink, terrainObject, curvatureObject);
  if (target === null) {
    error(
      sink,
      anchor.name,
      'в конфиге сцены нет ассета террейна: сетки, по которой дискретизируется скалпт, не существует (TERR-2)',
    );
    return { findings: sink.findings };
  }
  if (context.curvatureMap == null) {
    // Скалпт переписывает ОБА слоя: молчаливый пропуск кривизны означал бы
    // «импорт прошёл» при потерянном рельефе (тот же довод, что у grid-пути).
    reportMissingCurvatureDocument(sink, anchor);
  }
  const jump = cliffJumpOf(sculptObjects);
  for (const found of jump.errors) error(sink, found.object, found.message);
  const spec = specOf(target);
  const read = buildSculptSampler(document, sculptObjects, spec);
  for (const found of read.errors) error(sink, found.object, found.message);
  if (read.sampler === null || sink.findings.some((finding) => finding.severity === 'error')) {
    return { findings: sink.findings };
  }

  const maps = sculptTerrainMaps(sink, anchor, read.sampler, spec, jump.value);
  if (maps === null) return { findings: sink.findings };
  const terrainGrid = checkedTerrainGrid(sink, anchor, target, maps);
  if (terrainGrid === null) return { findings: sink.findings };

  const heights = sculptCurvatureHeights(read.sampler, spec, terrainGrid);
  const rows = curvatureRowsOf(sink, anchor, { width: spec.width, height: spec.height, heights });
  if (rows === null) return { terrain: maps, findings: sink.findings };
  const map = checkedCurvatureMap(sink, anchor, spec, rows);
  if (map === null) return { terrain: maps, findings: sink.findings };
  return { terrain: maps, curvature: map, findings: sink.findings };
}

/** Карты террейна из grid-объекта (BLND-9): чтение сетки, символы, проверка ядра. */
function gridTerrainMaps(
  sink: Sink,
  document: GltfDocument,
  object: SourceObject,
  spec: CellGridSpec,
  target: TargetTerrain,
): TerrainMaps | undefined {
  const read = readCellGrid(document, object, spec, [RAMP_CHANNEL, NOFLOOR_CHANNEL]);
  for (const message of read.errors) error(sink, object.name, message);
  if (read.grid === null) return undefined;
  const maps = terrainMapsOf(sink, object, read.grid);
  if (maps === null) return undefined;
  return checkedTerrainGrid(sink, object, target, maps) === null ? undefined : maps;
}

/** Карта кривизны из grid-объекта (BLND-10): узловая сетка, квантование, проверка. */
function gridCurvatureMap(
  sink: Sink,
  document: GltfDocument,
  object: SourceObject,
  spec: CellGridSpec,
  context: CellLayerContext,
): CurvatureMap | undefined {
  if (context.curvatureMap == null) {
    reportMissingCurvatureDocument(sink, object);
    return undefined;
  }
  const read = readNodeGrid(document, object, spec);
  for (const message of read.errors) error(sink, object.name, message);
  if (read.grid === null) return undefined;
  const rows = curvatureRowsOf(sink, object, read.grid);
  if (rows === null) return undefined;
  // `null` проверки и `undefined` слота значат одно: карты в слое не будет.
  return checkedCurvatureMap(sink, object, spec, rows) ?? undefined;
}

/**
 * Клеточные слои источника целиком. Ошибки собираются все до одной и
 * возвращаются вместе со слоями: решение «писать или не писать» принимает
 * вызывающий (BLND-6).
 */
export function generateCellLayer(
  document: GltfDocument,
  objects: readonly SourceObject[],
  context: CellLayerContext,
): CellLayer {
  const sink: Sink = { findings: [] };
  const target = context.terrain ?? null;

  const terrainObject = singleObject(sink, objects, 'terrain');
  const curvatureObject = singleObject(sink, objects, 'curvature');
  const sculptObjects = sculptObjectsOf(objects);
  const anchor = sculptObjects[0];
  if (anchor !== undefined) {
    return sculptCellLayer(sink, document, sculptObjects, anchor, terrainObject, curvatureObject, target, context);
  }
  if (terrainObject === null && curvatureObject === null) return { findings: sink.findings };

  if (target === null) {
    reportMissingTargetTerrain(sink, [terrainObject, curvatureObject]);
    return { findings: sink.findings };
  }

  const spec = specOf(target);
  const terrain =
    terrainObject === null ? undefined : gridTerrainMaps(sink, document, terrainObject, spec, target);
  const curvature =
    curvatureObject === null ? undefined : gridCurvatureMap(sink, document, curvatureObject, spec, context);

  return {
    ...(terrain === undefined ? {} : { terrain }),
    ...(curvature === undefined ? {} : { curvature }),
    findings: sink.findings,
  };
}

/**
 * Слой размещений и клеточные слои — один целевой слой одной операции: BLND-6
 * требует атомарности ПО ВСЕМ производным данным, и раздельные вызовы оставили
 * бы на диске половину импорта. Находки складываются в том же порядке, в каком
 * считались: сперва размещения, затем клетки.
 */
export function withCellLayer(layer: SpatialLayer, cells: CellLayer): SpatialLayer {
  return {
    ...layer,
    ...(cells.terrain === undefined ? {} : { terrain: cells.terrain }),
    ...(cells.curvature === undefined ? {} : { curvature: cells.curvature }),
    findings: [...layer.findings, ...cells.findings],
  };
}
