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
import { compareObjectNames } from './layer.js';
import {
  buildSculptSampler,
  cliffJumpOf,
  deriveSculptCells,
  nodeBaseLevels,
  sampleNodeHeight,
  sculptObjectsOf,
} from './sculpt.js';
import type {
  CellLayerContext,
  CurvatureMap,
  Finding,
  SpatialLayer,
  TerrainMaps,
} from './layer.js';
import type { SourceObject } from './normalize.js';

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
function singleObject(sink: Sink, objects: readonly SourceObject[], kind: string): SourceObject | null {
  const found = objects
    .filter((object) => object.semantics.length === 1 && object.semantics[0] === kind)
    .sort((a, b) => compareObjectNames(a.name, b.name));
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
function specOf(terrain: { readonly width: number; readonly height: number; readonly tileSize: number }): CellGridSpec {
  return { width: terrain.width, height: terrain.height, cellSize: fixed.toFloat(terrain.tileSize) };
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
      const at = y * grid.width + x;
      const raw = grid.heights[at]! / LEVEL_UNIT;
      const level = Math.round(raw);
      if (Math.abs(raw - level) > HEIGHT_EPSILON) {
        // Ни округления, ни подгонки: высота между уровнями — ошибка (BLND-9).
        error(
          sink,
          object.name,
          `клетка (${x}, ${y}): высота ${formatHeight(grid.heights[at]!)} не разрешается в целый уровень — ` +
            `округлять за автора импорт не вправе (BLND-9)`,
        );
        failed = true;
        continue;
      }
      const levelChar = terrainLevelChar(level);
      if (levelChar === null) {
        error(
          sink,
          object.name,
          `клетка (${x}, ${y}): уровень ${level} вне диапазона [0, ${TERRAIN_LEVEL_MAX}] (TERR-3)`,
        );
        failed = true;
        continue;
      }
      const ramp = (ramps[at] ?? 0) !== 0;
      const hollow = (noFloor[at] ?? 0) !== 0;
      if (ramp && hollow) {
        // Один символ описывает клетку целиком (TERR-3): комбинаций в модели
        // нет, и выбрать за автора один из двух признаков импорт не вправе.
        error(
          sink,
          object.name,
          `клетка (${x}, ${y}): помечена и рампой, и снятым полом — вид клетки один (TERR-3)`,
        );
        failed = true;
        continue;
      }
      const flagChar = terrainFlagChar(ramp ? 'ramp' : hollow ? 'noFloor' : 'plain');
      if (flagChar === null) {
        error(sink, object.name, `клетка (${x}, ${y}): вид клетки не выражается алфавитом карты (TERR-3)`);
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
 * Клеточные слои из скалпт-поверхности (BLND-13): объединение sculpt-мешей
 * дискретизируется в ОБА слоя — карты террейна и карту кривизны. Перевод чисел
 * в символы и валидация — те же вызовы, что у grid-пути (`terrainMapsOf`,
 * `createTerrainGrid`, `curvatureRowsOf`, `validateCurvatureMap`): sculpt меняет
 * источник высот, а не формат и не правила.
 */
function sculptCellLayer(
  sink: Sink,
  document: GltfDocument,
  sculptObjects: readonly SourceObject[],
  terrainObject: SourceObject | null,
  curvatureObject: SourceObject | null,
  target: { readonly width: number; readonly height: number; readonly tileSize: number } | null,
  context: CellLayerContext,
): CellLayer {
  // У слоя один источник: grid-объект рядом со скалптом — ошибка, а не тихий
  // приоритет (BLND-13). Ошибка стоит на grid-объекте: выбор за автором.
  for (const grid of [terrainObject, curvatureObject]) {
    if (grid === null) continue;
    error(
      sink,
      grid.name,
      `grid-объект "${grid.semantics[0]}" вместе со sculpt-поверхностью: у слоя один источник (BLND-13)`,
    );
  }
  const anchor = sculptObjects[0]!;
  if (target === null) {
    error(
      sink,
      anchor.name,
      'в конфиге сцены нет ассета террейна: сетки, по которой дискретизируется скалпт, не существует (TERR-2)',
    );
    return { findings: sink.findings };
  }
  if (context.curvatureMap === null || context.curvatureMap === undefined) {
    // Скалпт переписывает ОБА слоя: молчаливый пропуск кривизны означал бы
    // «импорт прошёл» при потерянном рельефе (тот же довод, что у grid-пути).
    error(
      sink,
      anchor.name,
      'манифест визуалов не адресует карту кривизны ("terrain.curvatureMap", ASSET-7): переписывать нечего',
    );
  }
  const jump = cliffJumpOf(sculptObjects);
  for (const found of jump.errors) error(sink, found.object, found.message);
  const spec = specOf(target);
  const read = buildSculptSampler(document, sculptObjects, spec);
  for (const found of read.errors) error(sink, found.object, found.message);
  if (read.sampler === null || sink.findings.some((finding) => finding.severity === 'error')) {
    return { findings: sink.findings };
  }

  const cells = deriveSculptCells(read.sampler, spec, jump.value, TERRAIN_LEVEL_MAX, LEVEL_UNIT);
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
  if (cells.outOfRange.length > 0) return { findings: sink.findings };
  const grid: CellGrid = {
    width: spec.width,
    height: spec.height,
    heights: cells.heights,
    channels: { [RAMP_CHANNEL]: cells.ramps, [NOFLOOR_CHANNEL]: cells.noFloor },
  };
  const maps = terrainMapsOf(sink, anchor, grid);
  if (maps === null) return { findings: sink.findings };
  const def: TerrainDef = { ...target, levels: [...maps.levels], flags: [...maps.flags] };
  let terrainGrid;
  try {
    terrainGrid = createTerrainGrid(def);
  } catch (rejected) {
    // Та же проверка ядра, что у grid-пути: авто-рампа шириной в одну клетку
    // (узкий склон скалпта) отказывает здесь ровно потому, что отказала бы там
    // (TERR-7) — чинится формой скалпта, источник правды один.
    error(
      sink,
      anchor.name,
      `ассет террейна отвергнут проверкой ядра (createTerrainGrid): ${
        rejected instanceof Error ? rejected.message : String(rejected)
      }`,
    );
    return { findings: sink.findings };
  }

  // Остаток кривизны: скалпт минус узловая высота ступенчатой террейн-формы по
  // правилу углов рендера (BLND-13, design 3). Узел без геометрии — ноль:
  // кривизна принадлежит полу, которого здесь нет.
  const bases = nodeBaseLevels(terrainGrid);
  const nodesX = spec.width + 1;
  const nodesY = spec.height + 1;
  const residuals = new Array<number>(nodesX * nodesY).fill(0);
  for (let nodeY = 0; nodeY < nodesY; nodeY++) {
    for (let nodeX = 0; nodeX < nodesX; nodeX++) {
      const sampled = sampleNodeHeight(read.sampler, spec, nodeX, nodeY);
      if (sampled === null) continue;
      residuals[nodeY * nodesX + nodeX] = sampled - bases[nodeY * nodesX + nodeX]! * LEVEL_UNIT;
    }
  }
  const rows = curvatureRowsOf(sink, anchor, { width: spec.width, height: spec.height, heights: residuals });
  if (rows === null) return { terrain: maps, findings: sink.findings };
  const map: CurvatureMap = { width: spec.width, height: spec.height, rows };
  const checked = validateCurvatureMap({ width: map.width, height: map.height, rows: rows.map((row) => [...row]) });
  if (!checked.ok) {
    for (const message of checked.errors) {
      error(sink, anchor.name, `карта кривизны отвергнута проверкой (validateCurvatureMap): ${message}`);
    }
    return { terrain: maps, findings: sink.findings };
  }
  return { terrain: maps, curvature: map, findings: sink.findings };
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
  if (sculptObjects.length > 0) {
    return sculptCellLayer(sink, document, sculptObjects, terrainObject, curvatureObject, target, context);
  }
  if (terrainObject === null && curvatureObject === null) return { findings: sink.findings };

  // Сетка у обоих объектов одна и берётся у ассета террейна сцены (TERR-2,
  // ASSET-7): без него сверять источник не с чем, а выдумать сетку из самого
  // источника значило бы дать ему право менять размеры арены (BLND-9).
  if (target === null) {
    for (const object of [terrainObject, curvatureObject]) {
      if (object === null) continue;
      error(
        sink,
        object.name,
        'в конфиге сцены нет ассета террейна: сетки, с которой обязан совпасть grid-объект, не существует (TERR-2)',
      );
    }
    return { findings: sink.findings };
  }

  const spec = specOf(target);
  let terrain: TerrainMaps | undefined;
  let curvature: CurvatureMap | undefined;

  if (terrainObject !== null) {
    const read = readCellGrid(document, terrainObject, spec, [RAMP_CHANNEL, NOFLOOR_CHANNEL]);
    for (const message of read.errors) error(sink, terrainObject.name, message);
    if (read.grid !== null) {
      const maps = terrainMapsOf(sink, terrainObject, read.grid);
      if (maps !== null) {
        // Валидация — тем же вызовом, которым ассет проверяет правило редактора
        // у кисти ED-10: рампа в одну клетку и диапазон уровней отказывают здесь
        // ровно потому, что отказывают там (BLND-9, TERR-3, TERR-7).
        const def: TerrainDef = { ...target, levels: [...maps.levels], flags: [...maps.flags] };
        try {
          createTerrainGrid(def);
          terrain = maps;
        } catch (rejected) {
          error(
            sink,
            terrainObject.name,
            `ассет террейна отвергнут проверкой ядра (createTerrainGrid): ${
              rejected instanceof Error ? rejected.message : String(rejected)
            }`,
          );
        }
      }
    }
  }

  if (curvatureObject !== null) {
    if (context.curvatureMap === null || context.curvatureMap === undefined) {
      // Молчаливый пропуск означал бы «импорт прошёл» при неимпортированной
      // кривизне; чинится это правкой манифеста (`terrain.curvatureMap`).
      error(
        sink,
        curvatureObject.name,
        'манифест визуалов не адресует карту кривизны ("terrain.curvatureMap", ASSET-7): переписывать нечего',
      );
    } else {
      const read = readNodeGrid(document, curvatureObject, spec);
      for (const message of read.errors) error(sink, curvatureObject.name, message);
      if (read.grid !== null) {
        const rows = curvatureRowsOf(sink, curvatureObject, read.grid);
        if (rows !== null) {
          const map: CurvatureMap = { width: spec.width, height: spec.height, rows };
          // Та же проверка, что стоит правилом на документе кривизны (ASSET-7).
          const checked = validateCurvatureMap({
            width: map.width,
            height: map.height,
            rows: rows.map((row) => [...row]),
          });
          // eslint-disable-next-line max-depth -- baseline
          if (checked.ok) curvature = map;
          else {
            // eslint-disable-next-line max-depth -- baseline
            for (const message of checked.errors) {
              error(sink, curvatureObject.name, `карта кривизны отвергнута проверкой (validateCurvatureMap): ${message}`);
            }
          }
        }
      }
    }
  }

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
