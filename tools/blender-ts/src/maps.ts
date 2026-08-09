/**
 * Клеточные слои источника: карты ассета террейна (BLND-9) и карта кривизны
 * (BLND-10). Считаются здесь, в память; пишет их та же операция авторинга, что
 * и расстановку (BLND-5) — второго пути записи у конвейера нет.
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
 * Алфавит карты кривизны принадлежит модулю ассетов, и обратная таблица
 * выводится обходом его же разбора `curvatureOffsetOf` (ASSET-7) — тем же
 * приёмом и по той же причине, что у кисти ED-11 (`editor/ui-ts`,
 * `areas/sceneTerrain.ts`): у алфавита один владелец, а таблица рядом с ним
 * разошлась бы молча. Проверка получившейся карты — `validateCurvatureMap`, тот
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
 * ## Кривизна: кламп вместо отказа
 *
 * Слой presentation: цена ошибки — вид, а не симуляция, и отказ запер бы автора
 * там, где симуляции ничто не грозит. Поэтому значение за пределами амплитуды
 * приводится к крайней ступени алфавита с ПРЕДУПРЕЖДЕНИЕМ и адресом клетки
 * (BLND-10) — симметрия с политикой заглушек ASSET-4/PRES-2.
 */
import {
  TERRAIN_LEVEL_MAX,
  createTerrainGrid,
  fixed,
  terrainFlagChar,
  terrainLevelChar,
  type TerrainDef,
} from '@game-mvp/core';
import { CURVATURE_SCALE, curvatureOffsetOf, validateCurvatureMap } from '@game-mvp/assets';
import {
  HEIGHT_EPSILON,
  NOFLOOR_CHANNEL,
  formatHeight,
  RAMP_CHANNEL,
  readCellGrid,
  type CellGrid,
  type CellGridSpec,
} from './cells.js';
import type { GltfDocument } from './gltf.js';
import { compareObjectNames } from './layer.js';
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

/**
 * Смещение → символ карты кривизны (ASSET-7). Таблица ВЫВЕДЕНА из разбора
 * владельца алфавита, а не записана рядом с ним: печатаемый ASCII — то
 * множество, из которого алфавит вообще выбирается, и обход его через
 * `curvatureOffsetOf` даёт ровно обратное отображение.
 */
const CURVATURE_CHARS: ReadonlyMap<number, string> = (() => {
  const chars = new Map<number, string>();
  for (let code = 0x21; code <= 0x7e; code++) {
    const char = String.fromCharCode(code);
    const offset = curvatureOffsetOf(char);
    if (offset !== null && !chars.has(offset)) chars.set(offset, char);
  }
  return chars;
})();

/** Амплитуда карты — то, что выразимо алфавитом, и ничего сверх него. */
export const MIN_CURVATURE_OFFSET = Math.min(...CURVATURE_CHARS.keys());
export const MAX_CURVATURE_OFFSET = Math.max(...CURVATURE_CHARS.keys());

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

function warning(sink: Sink, object: string, message: string): void {
  sink.findings.push({ severity: 'warning', object, message });
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

/** Ряды карты кривизны из клеточных данных: квантование и кламп (BLND-10). */
function curvatureRowsOf(sink: Sink, object: SourceObject, grid: CellGrid): readonly string[] | null {
  const rows: string[] = [];
  let failed = false;
  for (let y = 0; y < grid.height; y++) {
    let row = '';
    for (let x = 0; x < grid.width; x++) {
      const value = grid.heights[y * grid.width + x]! / LEVEL_UNIT;
      if (!Number.isFinite(value)) {
        // Кламп применим к числу; «не число» клампить не к чему, и это ошибка
        // разбора источника, а не выход за амплитуду (BLND-10).
        error(sink, object.name, `клетка (${x}, ${y}): смещение не является конечным числом`);
        failed = true;
        continue;
      }
      // Симметрично для выпуклости и вогнутости: `Math.round` половину тянет к
      // плюс бесконечности, и ступень −0.5 ушла бы не туда, куда +0.5.
      const scaled = value * CURVATURE_SCALE;
      const exact = Math.sign(scaled) * Math.round(Math.abs(scaled));
      const offset = Math.min(MAX_CURVATURE_OFFSET, Math.max(MIN_CURVATURE_OFFSET, exact));
      if (offset !== exact) {
        warning(
          sink,
          object.name,
          `клетка (${x}, ${y}): смещение ${formatHeight(value)} шага высоты вне амплитуды алфавита ` +
            `[${MIN_CURVATURE_OFFSET}/${CURVATURE_SCALE}, ${MAX_CURVATURE_OFFSET}/${CURVATURE_SCALE}] — ` +
            `записана крайняя ступень (BLND-10)`,
        );
      }
      const char = CURVATURE_CHARS.get(offset);
      if (char === undefined) {
        error(sink, object.name, `клетка (${x}, ${y}): ступень ${offset} не выражается алфавитом карты (ASSET-7)`);
        failed = true;
        continue;
      }
      row += char;
    }
    rows.push(row);
  }
  return failed ? null : rows;
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
      const read = readCellGrid(document, curvatureObject, spec);
      for (const message of read.errors) error(sink, curvatureObject.name, message);
      if (read.grid !== null) {
        const rows = curvatureRowsOf(sink, curvatureObject, read.grid);
        if (rows !== null) {
          const map: CurvatureMap = { width: spec.width, height: spec.height, rows };
          // Та же проверка, что стоит правилом на документе кривизны (ASSET-7).
          const checked = validateCurvatureMap({ width: map.width, height: map.height, rows: [...rows] });
          if (checked.ok) curvature = map;
          else {
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
