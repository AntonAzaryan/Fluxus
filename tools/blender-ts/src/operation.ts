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
 *
 * ## Что лежит рядом
 *
 * Слой как ПАРАМЕТР — сборка и разбор JSON, перечень слотов и форма карт — в
 * `layerParam.ts`: это одна граница на две стороны (ED-29), и держать её в
 * одном месте важнее, чем держать рядом с записью. Здесь остаётся запись.
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
} from '@fluxus/editor-core';
import {
  FLAG_MAP,
  LEVEL_MAP,
  OFFSET_MAP,
  assertKnownSlots,
  assertLayerAccepted,
  readCurvatureSlot,
  readFindings,
  readRecords,
  readTerrainSlot,
  type CurvatureSlot,
  type TerrainSlot,
} from './layerParam.js';

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
  for (const [y, row] of rows.entries()) {
    const wanted = rowValue(row);
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

  const shared = Math.min(existing.length, records.length);
  for (let index = 0; index < shared; index++) {
    // Индекс меньше длины ОБОИХ списков: и дескриптор, и запись на месте.
    const descriptor = existing[index]!;
    const record = records[index]!;
    const where = ctx.locate(documentId, descriptor);
    if (sameJson(ctx.readAt(documentId, where.path), record)) continue;
    // Путь внутри записи пуст: правится сама запись, а её дескриптор переживает
    // правку — инстанс вьюпорта не пересоздаётся от смены позиции (REND-11).
    ctx.setRecordValue(documentId, descriptor, [], record);
    set++;
  }
  // С хвоста: удаление сдвигает индексы следующих, и снятие с конца оставляет
  // адреса ещё не тронутых записей на месте.
  const dropped = existing.slice(records.length).reverse();
  for (const descriptor of dropped) ctx.removeRecord(documentId, descriptor);
  const added = records.slice(existing.length);
  for (const record of added) ctx.appendRecord(documentId, list, record);
  return { set, appended: added.length, removed: dropped.length };
}

/** Карты ассета террейна — рядами по адресам самого ассета (BLND-9, TERR-3). */
function writeTerrainMaps(
  ctx: OperationContext,
  scene: DocumentId,
  terrainPath: JsonPath,
  terrain: TerrainSlot,
): JsonValue {
  return {
    levels: { ...writeMap(ctx, scene, [...terrainPath, LEVEL_MAP], terrain.levels) },
    flags: { ...writeMap(ctx, scene, [...terrainPath, FLAG_MAP], terrain.flags) },
  };
}

/** Документ карты кривизны: и размеры, и ряды — только при расхождении (ASSET-7). */
function writeCurvatureDocument(
  ctx: OperationContext,
  documentId: DocumentId,
  curvature: CurvatureSlot,
): JsonValue {
  return {
    size:
      writeScalar(ctx, documentId, ['width'], curvature.width) +
      writeScalar(ctx, documentId, ['height'], curvature.height),
    rows: { ...writeMap(ctx, documentId, [OFFSET_MAP], curvature.rows) },
  };
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
    assertKnownSlots(id, layer);

    // Всё, что может отказать, отказывает ДО первой записи (BLND-6).
    const findings = readFindings(id, layer);
    const initial = readRecords(id, layer, 'initial');
    const decorations = readRecords(id, layer, 'decorations');
    const terrain = readTerrainSlot(id, layer);
    const curvature = readCurvatureSlot(id, layer);
    assertLayerAccepted(id, findings);

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
    const terrainChange =
      terrain === null
        ? null
        : writeTerrainMaps(ctx, scene, optionalPath(params, 'terrainPath', DEFAULT_TERRAIN_PATH), terrain);
    const curvatureChange =
      curvature === null || curvatureId === null ? null : writeCurvatureDocument(ctx, curvatureId, curvature);

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
