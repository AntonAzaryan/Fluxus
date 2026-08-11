/**
 * Операция импорта пространственного слоя — единственный путь, которым конвейер
 * пишет в документы (BLND-5, ED-29).
 *
 * Своих сериализации, правил порядка и записи у импортёра нет: он подаёт
 * посчитанный слой (`generateSpatialLayer`) зарегистрированной операции
 * авторинга, а та правит документы поверхностью сессии. Отсюда бесплатно
 * получаются канонические байты (ED-21), обратимость и история (ED-18) и
 * видимость в машинном каталоге (ED-30) — и отсюда же «командная строка и
 * редактор исполняют одно и то же» (BLND-5): операция одна, различаются только
 * хосты среды (ED-12).
 *
 * ## Что операция пишет и чего не трогает
 *
 * Производные данные (BLND-2) и ничего кроме них: записи `initial` конфига
 * сцены (SER-8), записи `decorations` парного документа (PRES-2), карты ассета
 * террейна (BLND-9) и карта кривизны (BLND-10). Прочие поля этих документов,
 * порядок их ключей и все остальные документы дерева остаются байт-в-байт
 * прежними — операция их не читает и не пишет, а сохранение канонично и ключей
 * не переставляет (ED-21).
 *
 * Перечень слотов закрыт: ключ слоя, которого операция не пишет, — ОТКАЗ, а не
 * молчаливый пропуск. Молчаливый пропуск означал бы, что вызывающий, подавший
 * карту старой операции, получил бы «импорт прошёл» и не получил бы карты.
 *
 * Слот, которого в слое НЕТ, — другое дело: источник без terrain-объекта не
 * даёт слота террейна, и ассет остаётся за редактором и руками, не тронутый ни
 * байтом (BLND-2). Отсутствие слота и пустой слот поэтому различимы.
 *
 * ## Что именно переписывается в ассете террейна
 *
 * Карты уровней и вида клеток, и только они (BLND-9). Размеры сетки и
 * `tileSize` — цель, а не производное: их задаёт автор ассета, и совпадение с
 * ними grid-объекта проверяет генерация слоя ДО вызова операции. У карты
 * кривизны производен весь документ (BLND-2), поэтому её размеры операция
 * пишет — но, как и ряды, только если они разошлись.
 *
 * ## Почему запись — не «стереть список и написать заново»
 *
 * Слой переписывается целиком (BLND-2), но переписать целиком и ТРОНУТЬ ВСЁ —
 * разные вещи. Записи сравниваются позиционно, и в документ уходит только то,
 * что действительно разошлось: неизменный источник не даёт ни одной правки, то
 * есть документ не становится изменённым, сохранение его не касается вовсе и
 * дифф пуст по построению, а не по совпадению байтов (BLND-4, ED-21).
 * Перемещение одного объекта меняет одну запись — и в истории (ED-18), и в
 * диффе видно ровно его.
 *
 * Позиционно — потому что связи «запись документа ↔ объект Blender» в документе
 * нет: имя объекта в записи не хранится (состав записи закрыт — SER-8, PRES-2),
 * а порядок записей есть детерминированная функция имён (BLND-4). Позиция
 * записи и есть её адрес.
 *
 * ## Атомарность
 *
 * Находки важности «ошибка» проверяются ДО первой записи и отвергают импорт
 * целиком (BLND-6): половины импортированного слоя не бывает. Сессия страхует
 * то же самое со своей стороны — упавшее применение откатывается целиком, — но
 * операция, целостность которой держится на чужом откате, целостна лишь до
 * первого вызывающего, который его не сделает.
 */
import {
  OperationError,
  isJsonArray,
  isJsonObject,
  type AuthoringOperation,
  type DocumentId,
  type JsonObject,
  type JsonPath,
  type JsonValue,
  type OperationContext,
  type OperationParams,
  type OperationParamSpec,
  type OperationRegistry,
} from '@game-mvp/editor-core';
import { hasErrors, type Finding, type SpatialLayer } from './layer.js';

/** Идентификатор операции: по нему её зовут и из редактора, и из командной строки. */
export const IMPORT_SPATIAL_LAYER = 'blender.importSpatialLayer';

/** Где лежит расстановка в конфиге сцены (SER-8) — умолчание, а не знание операции. */
export const DEFAULT_INITIAL_PATH: JsonPath = Object.freeze(['initial']);

/** Где лежат decorations в парном документе (PRES-2). */
export const DEFAULT_DECORATIONS_PATH: JsonPath = Object.freeze(['decorations']);

/**
 * Где лежит ассет террейна (TERR-2). Умолчание — поле конфига сцены: так лежит
 * террейн `duel` и так его адресуют правила редактора. Отдельным документом он
 * лежать вправе, и тогда адрес приносит вызывающий (ED-25).
 */
export const DEFAULT_TERRAIN_PATH: JsonPath = Object.freeze(['terrain']);

/** Имена карт внутри ассетов — поля формата (TERR-3, ASSET-7), а не выдумка операции. */
const LEVEL_MAP = 'levels';
const FLAG_MAP = 'flags';
const OFFSET_MAP = 'rows';

/** Ключи слоя, которые операция умеет писать. Перечень закрыт: ключ вне его — отказ. */
const KNOWN_SLOTS: readonly string[] = Object.freeze([
  'initial',
  'decorations',
  'terrain',
  'curvature',
  'findings',
]);

const SCENE: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'blender.operation.param.scene',
};
const PRESENTATION: OperationParamSpec = {
  type: 'document',
  optional: true,
  descriptionKey: 'blender.operation.param.presentation',
};
const LAYER: OperationParamSpec = {
  type: 'json',
  descriptionKey: 'blender.operation.param.layer',
};
const INITIAL_PATH: OperationParamSpec = {
  type: 'path',
  optional: true,
  descriptionKey: 'blender.operation.param.initialPath',
};
const DECORATIONS_PATH: OperationParamSpec = {
  type: 'path',
  optional: true,
  descriptionKey: 'blender.operation.param.decorationsPath',
};
const TERRAIN_PATH: OperationParamSpec = {
  type: 'path',
  optional: true,
  descriptionKey: 'blender.operation.param.terrainPath',
};
const CURVATURE: OperationParamSpec = {
  type: 'document',
  optional: true,
  descriptionKey: 'blender.operation.param.curvature',
};

/** Сколько записей слота операция тронула — то, из чего вызывающий строит отчёт. */
export interface SlotChange {
  readonly set: number;
  readonly appended: number;
  readonly removed: number;
}

const NOTHING: SlotChange = Object.freeze({ set: 0, appended: 0, removed: 0 });

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

/** Равенство значений JSON: правка, ничего не меняющая, правкой быть не должна. */
function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (isJsonArray(a) && isJsonArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    // Порядок ключей записи задаёт тот, кто её строит (ED-21), но РАЗНЫЙ порядок
    // при одинаковом составе — разные байты документа, и правку он требует.
    return keys.every((key, index) => Object.keys(b)[index] === key && sameJson(a[key], b[key]));
  }
  return false;
}

function readRecords(id: string, layer: JsonObject, slot: string): readonly JsonObject[] {
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
function readFindings(id: string, layer: JsonObject): readonly Finding[] {
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

/**
 * Переписывает карту ассета РЯДАМИ, а не целиком: ряд и есть единица формата
 * (TERR-3, ASSET-7), и мазок по одной полосе обязан оставить в диффе одну
 * строку, а не весь файл (ED-21) — тем же правилом живёт кисть ED-10. Карты
 * другой формы (нет вовсе, другой длины) переписываются целиком: рядов, которых
 * нет, адресовать нечем.
 */
function writeMap(
  ctx: OperationContext,
  documentId: DocumentId,
  path: JsonPath,
  rows: readonly (string | readonly number[])[],
): SlotChange {
  const rowValue = (row: string | readonly number[]): JsonValue =>
    typeof row === 'string' ? row : [...row];
  const existing = ctx.readAt(documentId, path);
  if (!isJsonArray(existing) || existing.length !== rows.length) {
    const wanted = rows.map(rowValue);
    if (sameJson(existing, wanted)) return NOTHING;
    ctx.setValue(documentId, path, wanted);
    return { set: rows.length, appended: 0, removed: 0 };
  }
  let set = 0;
  for (let y = 0; y < rows.length; y++) {
    const wanted = rowValue(rows[y]!);
    if (sameJson(existing[y] ?? null, wanted)) continue;
    ctx.setValue(documentId, [...path, y], wanted);
    set++;
  }
  return { set, appended: 0, removed: 0 };
}

/** Скалярное поле документа — правка только при расхождении (BLND-4). */
function writeScalar(ctx: OperationContext, documentId: DocumentId, path: JsonPath, value: JsonValue): number {
  if (sameJson(ctx.readAt(documentId, path), value)) return 0;
  ctx.setValue(documentId, path, value);
  return 1;
}

/** Адрес находки — имя объекта Blender; пустое имя значит «находка не об объекте». */
function addressed(finding: Finding): string {
  return finding.object === '' ? finding.message : `${finding.object}: ${finding.message}`;
}

/**
 * Переписывает записи одного слота. Возвращает то, что тронуто, — по этому
 * счёту вызывающий и отличает «импорт ничего не изменил» от «импорт прошёл».
 */
function writeSlot(
  ctx: OperationContext,
  documentId: DocumentId,
  list: JsonPath,
  records: readonly JsonObject[],
): SlotChange {
  const existing = ctx.records(documentId, list);
  let set = 0;
  let removed = 0;
  let appended = 0;

  const shared = Math.min(existing.length, records.length);
  for (let index = 0; index < shared; index++) {
    const descriptor = existing[index]!;
    const where = ctx.locate(documentId, descriptor);
    if (sameJson(ctx.readAt(documentId, where.path), records[index])) continue;
    // Путь внутри записи пуст: правится сама запись, а её дескриптор переживает
    // правку — инстанс вьюпорта не пересоздаётся от смены позиции (REND-11).
    ctx.setRecordValue(documentId, descriptor, [], records[index]!);
    set++;
  }
  // С хвоста: удаление сдвигает индексы следующих, и снятие с конца оставляет
  // адреса ещё не тронутых записей на месте.
  for (let index = existing.length - 1; index >= records.length; index--) {
    ctx.removeRecord(documentId, existing[index]!);
    removed++;
  }
  for (let index = existing.length; index < records.length; index++) {
    ctx.appendRecord(documentId, list, records[index]!);
    appended++;
  }
  return { set, appended, removed };
}

/*
 * Читатели ниже — приведение типа, а не вторая проверка: схему параметров уже
 * сверил слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams, name: string): DocumentId => params[name] as DocumentId;

function optionalPath(params: OperationParams, name: string, fallback: JsonPath): JsonPath {
  const value = params[name];
  return value === undefined ? fallback : (value as JsonPath);
}

/**
 * Импорт пространственного слоя сцены из источника Blender (BLND-1, BLND-2).
 * Обратима на общих основаниях (ED-18): пишет она только поверхностью сессии, и
 * прежние значения запоминает та же сессия — своей обратной функции у операции
 * нет и быть не должно (ED-29).
 */
export const importSpatialLayerOperation: AuthoringOperation = {
  id: IMPORT_SPATIAL_LAYER,
  descriptionKey: 'blender.operation.importSpatialLayer',
  params: {
    scene: SCENE,
    presentation: PRESENTATION,
    curvature: CURVATURE,
    layer: LAYER,
    initialPath: INITIAL_PATH,
    decorationsPath: DECORATIONS_PATH,
    terrainPath: TERRAIN_PATH,
  },
  apply(ctx, params) {
    const id = IMPORT_SPATIAL_LAYER;
    const layer = params.layer;
    if (!isJsonObject(layer)) {
      throw new OperationError(id, 'параметр "layer": ожидался целевой слой объектом', {
        param: 'layer',
        received: layer ?? null,
      });
    }
    for (const slot of Object.keys(layer)) {
      if (KNOWN_SLOTS.includes(slot)) continue;
      throw new OperationError(
        id,
        `параметр "layer": слот "${slot}" этой операцией не пишется — молча пропустить его нельзя (BLND-2)`,
        { param: 'layer', received: slot },
      );
    }

    // Всё, что может отказать, отказывает ДО первой записи (BLND-6).
    const findings = readFindings(id, layer);
    const initial = readRecords(id, layer, 'initial');
    const decorations = readRecords(id, layer, 'decorations');
    const terrainSlot = readSlotObject(id, layer, 'terrain');
    const terrain =
      terrainSlot === null
        ? null
        : {
            levels: readMap(id, terrainSlot, 'terrain', LEVEL_MAP),
            flags: readMap(id, terrainSlot, 'terrain', FLAG_MAP),
          };
    const curvatureSlot = readSlotObject(id, layer, 'curvature');
    const curvature =
      curvatureSlot === null
        ? null
        : {
            width: readNumber(id, curvatureSlot, 'curvature', 'width'),
            height: readNumber(id, curvatureSlot, 'curvature', 'height'),
            rows: readNodeRows(id, curvatureSlot, 'curvature', OFFSET_MAP),
          };
    if (hasErrors(findings)) {
      const errors = findings.filter((finding) => finding.severity === 'error');
      throw new OperationError(
        id,
        `источник не прошёл проверку, на диск не записано ничего (BLND-6): ${errors.map(addressed).join('; ')}`,
        { param: 'layer' },
      );
    }

    const scene = asDocument(params, 'scene');
    const presentation = params.presentation === undefined ? null : asDocument(params, 'presentation');
    if (presentation === null && decorations.length > 0) {
      throw new OperationError(
        id,
        'слой содержит decorations, а парный presentation-документ не назван (PRES-1, PRES-2)',
        { param: 'presentation' },
      );
    }
    const curvatureId = params.curvature === undefined ? null : asDocument(params, 'curvature');
    if (curvatureId === null && curvature !== null) {
      // Молчаливый пропуск карты — то же самое, что молчаливый пропуск слота:
      // вызывающий получил бы «импорт прошёл» и не получил бы кривизны (ASSET-7).
      throw new OperationError(
        id,
        'слой содержит карту кривизны, а документ карты не назван (ASSET-7 — его адресует манифест)',
        { param: 'curvature' },
      );
    }

    const initialChange = writeSlot(
      ctx,
      scene,
      optionalPath(params, 'initialPath', DEFAULT_INITIAL_PATH),
      initial,
    );
    // Парного документа нет и записей нет — писать нечего и снимать нечего:
    // сцена без декораций законна (PRES-1). Названный документ переписывается
    // всегда, в том числе в пустоту: источник, из которого декорации убрали,
    // обязан их убрать и из документа.
    const decorationChange =
      presentation === null
        ? NOTHING
        : writeSlot(
            ctx,
            presentation,
            optionalPath(params, 'decorationsPath', DEFAULT_DECORATIONS_PATH),
            decorations,
          );

    // Ассеты — той же записью и в том же вызове: атомарность BLND-6 распространена
    // на все производные данные, и «расстановка записана, террейн нет» не бывает.
    const terrainPath = optionalPath(params, 'terrainPath', DEFAULT_TERRAIN_PATH);
    const terrainChange =
      terrain === null
        ? null
        : {
            levels: { ...writeMap(ctx, scene, [...terrainPath, LEVEL_MAP], terrain.levels) },
            flags: { ...writeMap(ctx, scene, [...terrainPath, FLAG_MAP], terrain.flags) },
          };
    const curvatureChange =
      curvature === null || curvatureId === null
        ? null
        : {
            size:
              writeScalar(ctx, curvatureId, ['width'], curvature.width) +
              writeScalar(ctx, curvatureId, ['height'], curvature.height),
            rows: { ...writeMap(ctx, curvatureId, [OFFSET_MAP], curvature.rows) },
          };

    return {
      initial: { ...initialChange },
      decorations: { ...decorationChange },
      // Слот, которого источник не дал, в отчёте не появляется: ассет не тронут
      // вовсе, и нулевой счёт правок сказал бы «переписан без изменений».
      ...(terrainChange === null ? {} : { terrain: terrainChange }),
      ...(curvatureChange === null ? {} : { curvature: curvatureChange }),
    };
  },
};

/** Вклад пакета в реестр операций (ED-25): регистрируют — снаружи, знает о нём — реестр. */
export function registerBlenderOperations(registry: OperationRegistry): OperationRegistry {
  registry.register(importSpatialLayerOperation);
  return registry;
}
