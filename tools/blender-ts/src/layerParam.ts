/**
 * Слой как ПАРАМЕТР операции импорта: сборка параметра из посчитанного слоя и
 * его разбор обратно.
 *
 * Отдельный модуль, потому что это одна граница, а не две: значения параметров
 * — JSON и только JSON (ED-29: вызов без интерфейса приходит из чужих рук), и
 * обе стороны этой границы обязаны знать об одном и том же составе. Разъедься
 * они — сборка писала бы ключ, которого разбор не читает, и «импорт прошёл»
 * означало бы «слот потерялся». Запись же в документы — дело `operation.ts`, и
 * об этом модуле она знает ровно столько, сколько знает о форме параметра.
 *
 * Перечень слотов здесь закрыт: ключ, которого операция не пишет, — ОТКАЗ, а не
 * молчаливый пропуск (BLND-2).
 */
import {
  OperationError,
  isJsonArray,
  isJsonObject,
  type DocumentId,
  type JsonObject,
  type JsonPath,
  type JsonValue,
  type OperationParams,
} from '@fluxus/editor-core';
import { hasErrors, type Finding, type SpatialLayer } from './layer.js';

/** Имена карт внутри ассетов — поля формата (TERR-3, ASSET-7), а не выдумка операции. */
export const LEVEL_MAP = 'levels';
export const FLAG_MAP = 'flags';
export const OFFSET_MAP = 'rows';

/** Ключи слоя, которые операция умеет писать. Перечень закрыт: ключ вне его — отказ. */
const KNOWN_SLOTS: readonly string[] = Object.freeze([
  'initial',
  'decorations',
  'terrain',
  'curvature',
  'findings',
]);

/**
 * Слой как параметр операции. Значения параметров — JSON и только JSON (ED-29:
 * вызов без интерфейса приходит из чужих рук), поэтому перекладка явная, а не
 * приведение типа: `Finding` — интерфейс, а не запись JSON, и совпадение их
 * форм сегодня ничего не обещает завтра.
 */
export function spatialLayerParam(layer: SpatialLayer): JsonValue {
  const terrain = layer.terrain;
  const curvature = layer.curvature;
  return {
    initial: layer.initial.map((record) => record as JsonValue),
    decorations: layer.decorations.map((record) => record as JsonValue),
    // Слота, которого источник не дал, в параметре нет вовсе: ассет тогда не
    // переписывается (BLND-2), и пустой слот сказал бы обратное.
    ...(terrain === undefined ? {} : { terrain: { levels: [...terrain.levels], flags: [...terrain.flags] } }),
    ...(curvature === undefined
      ? {}
      : { curvature: { width: curvature.width, height: curvature.height, rows: [...curvature.rows] } }),
    findings: layer.findings.map(
      (finding): JsonValue => ({
        severity: finding.severity,
        object: finding.object,
        message: finding.message,
      }),
    ),
  };
}

/** Параметры вызова операции целиком — чтобы обе стороны BLND-5 собирали их одинаково. */
export function importParams(input: {
  readonly scene: DocumentId;
  readonly presentation?: DocumentId;
  /** Документ карты кривизны (ASSET-7); его адрес называет манифест. */
  readonly curvature?: DocumentId | null;
  readonly layer: SpatialLayer;
  readonly initialPath?: JsonPath;
  readonly decorationsPath?: JsonPath;
  readonly terrainPath?: JsonPath;
}): OperationParams {
  return {
    scene: input.scene,
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    ...(input.curvature === undefined || input.curvature === null ? {} : { curvature: input.curvature }),
    layer: spatialLayerParam(input.layer),
    ...(input.initialPath === undefined ? {} : { initialPath: [...input.initialPath] }),
    ...(input.decorationsPath === undefined ? {} : { decorationsPath: [...input.decorationsPath] }),
    ...(input.terrainPath === undefined ? {} : { terrainPath: [...input.terrainPath] }),
  };
}

export function readRecords(id: string, layer: JsonObject, slot: string): readonly JsonObject[] {
  const value = layer[slot];
  if (value === undefined) return [];
  if (!isJsonArray(value)) {
    throw new OperationError(id, `параметр "layer": "${slot}" — список записей`, {
      param: 'layer',
      received: value,
    });
  }
  return value.map((record, index) => {
    if (!isJsonObject(record)) {
      throw new OperationError(id, `параметр "layer": запись ${slot}[${index}] — объект`, {
        param: 'layer',
        received: record,
      });
    }
    return record;
  });
}

/**
 * Находки слоя из параметра. Читаются целиком, а не «есть ли ошибки»: отказ
 * обязан назвать объект Blender, который автор видит в outliner (BLND-6), — путь
 * в документе этого не заменяет, а у отвергнутого импорта пути ещё и нет.
 */
export function readFindings(id: string, layer: JsonObject): readonly Finding[] {
  const value = layer.findings;
  if (value === undefined) return [];
  if (!isJsonArray(value)) {
    throw new OperationError(id, 'параметр "layer": "findings" — список находок', {
      param: 'layer',
      received: value,
    });
  }
  return value.map((entry): Finding => {
    const severity = isJsonObject(entry) ? entry.severity : undefined;
    const object = isJsonObject(entry) ? entry.object : undefined;
    const message = isJsonObject(entry) ? entry.message : undefined;
    if ((severity !== 'error' && severity !== 'warning') || typeof object !== 'string' || typeof message !== 'string') {
      throw new OperationError(id, 'параметр "layer": находка — severity, object и message', {
        param: 'layer',
        received: entry,
      });
    }
    return { severity, object, message };
  });
}

/** Карта ассета террейна — массив строк, по одной на ряд сетки (TERR-3). */
function readMap(id: string, slot: JsonObject, where: string, key: string): readonly string[] {
  const value = slot[key];
  if (!isJsonArray(value) || !value.every((row): row is string => typeof row === 'string')) {
    throw new OperationError(id, `параметр "layer": "${where}.${key}" — карта строками, по одной на ряд`, {
      param: 'layer',
      received: value ?? null,
    });
  }
  return value;
}

/** Карта кривизны — числовые ряды узлов (ASSET-7): целые множители решётки. */
function readNodeRows(
  id: string,
  slot: JsonObject,
  where: string,
  key: string,
): readonly (readonly number[])[] {
  const value = slot[key];
  if (
    !isJsonArray(value) ||
    !value.every(
      (row): row is number[] =>
        Array.isArray(row) && row.every((node) => typeof node === 'number' && Number.isSafeInteger(node)),
    )
  ) {
    throw new OperationError(
      id,
      `параметр "layer": "${where}.${key}" — числовые ряды узлов, по одному на узловую линию`,
      { param: 'layer', received: value ?? null },
    );
  }
  return value;
}

function readNumber(id: string, slot: JsonObject, where: string, key: string): number {
  const value = slot[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new OperationError(id, `параметр "layer": "${where}.${key}" — целое число`, {
      param: 'layer',
      received: value ?? null,
    });
  }
  return value;
}

function readSlotObject(id: string, layer: JsonObject, slot: string): JsonObject | null {
  const value = layer[slot];
  if (value === undefined) return null;
  if (!isJsonObject(value)) {
    throw new OperationError(id, `параметр "layer": слот "${slot}" — объект`, {
      param: 'layer',
      received: value,
    });
  }
  return value;
}

/** Адрес находки — имя объекта Blender; пустое имя значит «находка не об объекте». */
function addressed(finding: Finding): string {
  return finding.object === '' ? finding.message : `${finding.object}: ${finding.message}`;
}

/** Карты ассета террейна из слоя — то единственное, что импорт в нём пишет (BLND-9). */
export interface TerrainSlot {
  readonly levels: readonly string[];
  readonly flags: readonly string[];
}

/** Карта кривизны из слоя: у неё производен весь документ (BLND-2, ASSET-7). */
export interface CurvatureSlot {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly (readonly number[])[];
}

/**
 * Перечень слотов закрыт: ключ слоя, которого операция не пишет, — ОТКАЗ, а не
 * молчаливый пропуск (см. шапку модуля, BLND-2).
 */
export function assertKnownSlots(id: string, layer: JsonObject): void {
  for (const slot of Object.keys(layer)) {
    if (KNOWN_SLOTS.includes(slot)) continue;
    throw new OperationError(
      id,
      `параметр "layer": слот "${slot}" этой операцией не пишется — молча пропустить его нельзя (BLND-2)`,
      { param: 'layer', received: slot },
    );
  }
}

/** Слот террейна из параметра; `null` — источник его не дал, ассет не тронут (BLND-2). */
export function readTerrainSlot(id: string, layer: JsonObject): TerrainSlot | null {
  const slot = readSlotObject(id, layer, 'terrain');
  if (slot === null) return null;
  return {
    levels: readMap(id, slot, 'terrain', LEVEL_MAP),
    flags: readMap(id, slot, 'terrain', FLAG_MAP),
  };
}

/** Слот кривизны из параметра; `null` — источник его не дал (BLND-2). */
export function readCurvatureSlot(id: string, layer: JsonObject): CurvatureSlot | null {
  const slot = readSlotObject(id, layer, 'curvature');
  if (slot === null) return null;
  return {
    width: readNumber(id, slot, 'curvature', 'width'),
    height: readNumber(id, slot, 'curvature', 'height'),
    rows: readNodeRows(id, slot, 'curvature', OFFSET_MAP),
  };
}

/** Находки важности «ошибка» отвергают импорт целиком, до первой записи (BLND-6). */
export function assertLayerAccepted(id: string, findings: readonly Finding[]): void {
  if (!hasErrors(findings)) return;
  const errors = findings.filter((finding) => finding.severity === 'error');
  throw new OperationError(
    id,
    `источник не прошёл проверку, на диск не записано ничего (BLND-6): ${errors.map(addressed).join('; ')}`,
    { param: 'layer' },
  );
}
