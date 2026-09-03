/**
 * @contribution Операции над секциями VFX манифеста визуалов — транзиентными
 * эффектами (`assets` ASSET-6, `rendering` REND-23) и эмиттерами частиц
 * (ASSET-14, REND-24). Вклад в слой операций авторинга (ED-29), а не часть
 * каркаса.
 *
 * ED-14 требует правимости манифеста без ручного редактирования JSON, ED-29 —
 * чтобы всякая правка шла зарегистрированной операцией. Секции эффектов камеры
 * такие операции уже получили (`assetCameraEffects.ts`); эти две — те же самые
 * действия автора над двумя другими секциями того же документа.
 *
 * ## Отдельным модулем, а регистрацией — с визуалами
 *
 * Отдельным — потому что `assetVisuals.ts` про ЗАПИСЬ сущности, а здесь три
 * таблицы источников и список изображений внутри каждой: другое доменное
 * знание, и мешать их в одном модуле незачем. Регистрируются же они вместе с
 * визуальными (`VISUALS_AUTHORING_OPERATIONS`), а не своей функцией: своя
 * понадобилась эффектам камеры ради ПАРАМЕТРА — машинного описания типов
 * (CAM-9), которое приносит сборка. Здесь такого параметра нет, и вторая точка
 * регистрации была бы вторым местом, где о наборе операций можно забыть.
 *
 * ## Перечня примитивов и полей записи здесь нет
 *
 * Ни в каком виде — по тем же основаниям, по каким его нет у валидации
 * манифеста: имена примитивов принадлежат РЕНДЕРУ (REND-23), а состав полей
 * записи — модулю ассетов (ASSET-6). Операция пишет, что ей сказали, и
 * спрашивает о РАЗНИЦЕ владельца (`validateManifest`) — тем же вызовом, которым
 * манифест проверяется на загрузке и в реальном времени (ED-8). Свой перечень
 * разошёлся бы с чужим молча, и ровно это ED-14 запрещает прямым текстом.
 *
 * ## Список изображений одного источника
 *
 * Источник (визуальный тип, состояние, событие) несёт ОДНО изображение либо их
 * список (REND-23): шар снаряда и его след — две записи одного типа. Обе формы
 * законны, и операции работают с обеими: `addImage` превращает одиночную запись
 * в список, дописывая вторую, а `setField` адресует запись номером, когда их
 * несколько. Обратного превращения («список из одного схлопнуть в запись») нет
 * намеренно: форма документа — решение автора, а не побочный эффект удаления.
 *
 * ## Чего здесь нет: операции удаления
 *
 * Удаление привязки и удаление изображения своей операции не получают —
 * `document.removeValue` делает ровно это (тот же ответ, что у соседей).
 */
import {
  OperationError,
  isJsonArray,
  isJsonObject,
  normalizeContentPath,
  type AuthoringOperation,
  type DocumentId,
  type JsonPath,
  type JsonValue,
  type OperationContext,
  type OperationParamSpec,
} from '@fluxus/editor-core';
import { validateManifest } from '@fluxus/assets';
import { ASSET_ID, DOCUMENT, asDocument, asString } from './operationParams.js';
import { reasonOf } from '../reason.js';

/** Идентификаторы операций над секциями VFX. */
export const VFX_OPERATIONS = {
  addImage: 'visuals.effects.addImage',
  setField: 'visuals.effects.setField',
  setEmitter: 'visuals.particles.setEmitter',
} as const;

/** Где в манифесте лежат секции VFX (ASSET-6, ASSET-14) — доменное знание вклада. */
const EFFECTS_SECTION = 'effects';
const PARTICLES_SECTION = 'particles';

/**
 * Таблицы источников — одни и те же у обеих секций (REND-23, REND-24):
 * визуальный тип сущности, её доставленное состояние, событие тика.
 */
const VFX_TABLES: readonly string[] = Object.freeze(['byKind', 'byState', 'byEvent']);

/** Поля записи эмиттера (ASSET-14): их пишет операция привязки целиком. */
const EFFECT_KEY = 'effect';
const SOCKET_KEY = 'socket';
const SCALE_KEY = 'scale';

const TABLE: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.vfxTable' };
const SOURCE: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.vfxSource',
};
const PRIMITIVE: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.primitive',
};
const COLOR: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.color' };
const FIELD: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.effectField' };
const FIELD_VALUE: OperationParamSpec = {
  type: 'json',
  descriptionKey: 'ui.operation.param.effectValue',
};
const IMAGE_INDEX: OperationParamSpec = {
  type: 'number',
  optional: true,
  descriptionKey: 'ui.operation.param.imageIndex',
};
const RADIUS: OperationParamSpec = {
  type: 'number',
  optional: true,
  descriptionKey: 'ui.operation.param.effectRadius',
};
const WIDTH: OperationParamSpec = {
  type: 'number',
  optional: true,
  descriptionKey: 'ui.operation.param.effectWidth',
};
const SOCKET: OperationParamSpec = {
  type: 'string',
  optional: true,
  descriptionKey: 'ui.operation.param.socket',
};
const SCALE: OperationParamSpec = {
  type: 'number',
  optional: true,
  descriptionKey: 'ui.operation.param.scale',
};

/** Путь источника внутри документа манифеста. */
function sourcePath(section: string, table: string, name: string, ...rest: readonly string[]): JsonPath {
  return [section, table, name, ...rest];
}

/** Таблица источников обязана быть одной из трёх (REND-23, REND-24). */
function requireTable(operationId: string, table: string): string {
  if (!VFX_TABLES.includes(table)) {
    throw new OperationError(
      operationId,
      `параметр "table": таблицы "${table}" в секции нет (допустимы: ${VFX_TABLES.join(', ')})`,
      { param: 'table', received: table },
    );
  }
  return table;
}

function requireName(operationId: string, name: string): string {
  if (name === '') {
    throw new OperationError(operationId, 'параметр "name": имя источника пусто', {
      param: 'name',
      received: name,
    });
  }
  return name;
}

/**
 * Ошибки источника глазами его владельца: источник оборачивается в манифест из
 * него одного. Тот же `validateManifest`, что проверяет документ на загрузке —
 * второй реализации правила с источником истины не заводится (ED-1, CORE-3).
 */
function sourceErrors(
  section: string,
  table: string,
  name: string,
  value: JsonValue | undefined,
): readonly string[] {
  const checked = validateManifest({
    entities: {},
    [section]: { [table]: { [name]: value ?? null } },
  });
  return checked.ok ? [] : checked.errors;
}

/**
 * Правленый источник проверяет владелец, а не операция, и спрашивают его о
 * РАЗНИЦЕ: сломанное до операции показывает валидация документа (ED-8), и
 * отказывать правке за чужое нарушение значило бы не дать автору его починить.
 * Полуправок отказ не оставляет — записанное упавшей операцией откатывает слой
 * операций (ED-29).
 */
function checkSource(
  operationId: string,
  ctx: OperationContext,
  document: DocumentId,
  section: string,
  table: string,
  name: string,
  before: JsonValue | undefined,
  details: { param: string; received: JsonValue },
): void {
  const known = new Set(sourceErrors(section, table, name, before));
  const introduced = sourceErrors(
    section,
    table,
    name,
    ctx.readAt(document, sourcePath(section, table, name)),
  ).filter((error) => !known.has(error));
  if (introduced.length > 0) throw new OperationError(operationId, introduced.join('; '), details);
}

/**
 * Номер изображения внутри источника; путь без номера — источник целиком.
 * Номер идёт шагом-ЧИСЛОМ: список в документе есть список, и адресовать его
 * строкой значило бы завести у массива поле с именем цифры.
 */
function imagePath(
  table: string,
  name: string,
  index: number | undefined,
  ...rest: readonly string[]
): JsonPath {
  const path = sourcePath(EFFECTS_SECTION, table, name);
  return index === undefined ? [...path, ...rest] : [...path, index, ...rest];
}

/**
 * Новое изображение источника (ED-14, REND-23). Источника ещё нет — записывает
 * одиночную запись; есть одиночная — превращает её в список из двух; есть
 * список — дописывает в конец. Возвращает номер записи в источнике, чтобы
 * вызывающему было чем адресовать только что созданное (ED-29).
 *
 * Чисел сверх названных операция не подставляет: умолчания знает рендер
 * (REND-23), а записанное умолчание раздувает дифф (ED-21) и врёт, когда
 * умолчание в коде поменяют. Радиус и ширина потому необязательны: какое из
 * двух чисел обязательно этому примитиву, отвечает владелец формата (ASSET-6),
 * и его отказ автор увидит целиком.
 */
const addEffectImageOperation: AuthoringOperation = {
  id: VFX_OPERATIONS.addImage,
  descriptionKey: 'ui.operation.visuals.effects.addImage',
  params: {
    document: DOCUMENT,
    table: TABLE,
    name: SOURCE,
    primitive: PRIMITIVE,
    color: COLOR,
    radius: RADIUS,
    width: WIDTH,
  },
  apply(ctx, params) {
    const id = VFX_OPERATIONS.addImage;
    const document = asDocument(params);
    const table = requireTable(id, asString(params, 'table'));
    const name = requireName(id, asString(params, 'name'));
    const primitive = asString(params, 'primitive');
    if (primitive === '') {
      throw new OperationError(id, 'параметр "primitive": имя примитива пусто', {
        param: 'primitive',
        received: primitive,
      });
    }
    const record: Record<string, JsonValue> = { primitive, color: asString(params, 'color') };
    if (typeof params.radius === 'number') record.radius = params.radius;
    if (typeof params.width === 'number') record.width = params.width;
    const path = sourcePath(EFFECTS_SECTION, table, name);
    const before = ctx.readAt(document, path);
    let index: number;
    if (before === undefined) {
      ctx.setValue(document, path, record);
      index = 0;
    } else if (isJsonArray(before)) {
      index = before.length;
      ctx.setValue(document, [...path, index], record);
    } else {
      // Одиночная запись становится списком из двух: обе формы законны, и
      // выбирать между ними автор не обязан (REND-23).
      ctx.setValue(document, path, [before, record]);
      index = 1;
    }
    checkSource(id, ctx, document, EFFECTS_SECTION, table, name, before, {
      param: 'primitive',
      received: primitive,
    });
    return index;
  },
};

/**
 * Одно поле изображения (ED-14, REND-23): цвет, радиус, длительность, окно
 * стата целиком. `null` СНИМАЕТ поле, а не пишет пустое значение: без снятия
 * автор чистил бы документ руками, чего ED-14 не допускает.
 *
 * Имя поля не сверяется с перечнем — перечень принадлежит модулю ассетов
 * (ASSET-6), и о неизвестном ключе скажет он же, отказом операции.
 */
const setEffectFieldOperation: AuthoringOperation = {
  id: VFX_OPERATIONS.setField,
  descriptionKey: 'ui.operation.visuals.effects.setField',
  params: {
    document: DOCUMENT,
    table: TABLE,
    name: SOURCE,
    field: FIELD,
    value: FIELD_VALUE,
    index: IMAGE_INDEX,
  },
  apply(ctx, params) {
    const id = VFX_OPERATIONS.setField;
    const document = asDocument(params);
    const table = requireTable(id, asString(params, 'table'));
    const name = requireName(id, asString(params, 'name'));
    const field = asString(params, 'field');
    if (field === '') {
      throw new OperationError(id, 'параметр "field": имя поля записи пусто', {
        param: 'field',
        received: field,
      });
    }
    const index = typeof params.index === 'number' ? params.index : undefined;
    const before = ctx.readAt(document, sourcePath(EFFECTS_SECTION, table, name));
    if (!isJsonObject(ctx.readAt(document, imagePath(table, name, index)))) {
      throw new OperationError(
        id,
        `изображения${index === undefined ? '' : ` №${String(index)}`} у источника "${name}" в таблице "${table}" нет — полю негде лежать`,
        { param: 'name', received: name },
      );
    }
    // Отсутствие и `null` для этого параметра — одно и то же действие: снять
    // поле. Схема требует его непременно, и разводить их здесь нечего.
    const value: JsonValue = params.value ?? null;
    const path = imagePath(table, name, index, field);
    if (value === null) {
      if (ctx.readAt(document, path) !== undefined) ctx.removeValue(document, path);
      return undefined;
    }
    ctx.setValue(document, path, value);
    checkSource(id, ctx, document, EFFECTS_SECTION, table, name, before, {
      param: 'value',
      received: value,
    });
    return undefined;
  },
};

/**
 * Привязка источника к эмиттерному ассету (ED-14, ED-20, ASSET-14). Пишет
 * запись ЦЕЛИКОМ, а не по полю: `effect` в ней обязателен, и операция «записать
 * только сокет» оставила бы в документе заведомо невалидную запись.
 *
 * ID ассета проверяется здесь же (ASSET-2): «в запись попадает ID ассета»
 * (ED-20) обязано выполняться и на пути без интерфейса. Отсутствующие сокет и
 * масштаб — снятие полей, а не пустая строка с нулём: у эмиттера без сокета
 * поза сущности, и это законная запись.
 */
const setParticleEmitterOperation: AuthoringOperation = {
  id: VFX_OPERATIONS.setEmitter,
  descriptionKey: 'ui.operation.visuals.particles.setEmitter',
  params: {
    document: DOCUMENT,
    table: TABLE,
    name: SOURCE,
    asset: ASSET_ID,
    socket: SOCKET,
    scale: SCALE,
  },
  apply(ctx, params) {
    const id = VFX_OPERATIONS.setEmitter;
    const document = asDocument(params);
    const table = requireTable(id, asString(params, 'table'));
    const name = requireName(id, asString(params, 'name'));
    const asset = requireAssetId(id, asString(params, 'asset'));
    const socket = typeof params.socket === 'string' ? params.socket : undefined;
    const scale = typeof params.scale === 'number' ? params.scale : undefined;
    const path = sourcePath(PARTICLES_SECTION, table, name);
    const before = ctx.readAt(document, path);
    ctx.setValue(document, path, {
      [EFFECT_KEY]: asset,
      ...(socket === undefined ? {} : { [SOCKET_KEY]: socket }),
      ...(scale === undefined ? {} : { [SCALE_KEY]: scale }),
    });
    checkSource(id, ctx, document, PARTICLES_SECTION, table, name, before, {
      param: 'asset',
      received: asset,
    });
    return undefined;
  },
};

/**
 * ID эмиттерного ассета — путь от корня дерева контента и ничего кроме
 * (ASSET-2). Проверка тут же, а не в интерфейсе: операция исполнима и без него
 * (ED-29), и «в запись попадает ID ассета» (ED-20) обязано выполняться на обоих
 * путях. Нормализацию пути знает ядро редактора — своей копии её здесь нет.
 */
function requireAssetId(operationId: string, raw: string): string {
  const fail = (reason: string): never => {
    throw new OperationError(operationId, `параметр "asset": ${reason}`, {
      param: 'asset',
      received: raw,
    });
  };
  if (raw === '') fail('ID эмиттерного ассета пуст');
  let normalized: string;
  try {
    normalized = normalizeContentPath(raw);
  } catch (error) {
    return fail(reasonOf(error));
  }
  if (normalized !== raw) fail(`ID ассета — путь от корня дерева контента (ASSET-2), а не "${raw}"`);
  return normalized;
}

/** Набор операций секций VFX — по одной на действие автора (ED-29). */
export const VFX_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  addEffectImageOperation,
  setEffectFieldOperation,
  setParticleEmitterOperation,
]);

/** Имена источников таблицы в порядке документа — из них автор и выбирает. */
export function vfxSourceNames(
  value: JsonValue | undefined,
  section: string,
  table: string,
): readonly string[] {
  if (!isJsonObject(value)) return [];
  const found = value[section];
  if (!isJsonObject(found)) return [];
  const entries = found[table];
  return isJsonObject(entries) ? Object.keys(entries) : [];
}

/**
 * Изображения источника СПИСКОМ — одиночная запись приходит списком из одной
 * (REND-23): интерфейсу таблицы различать две формы незачем, а операциям —
 * есть, и различают их они.
 */
export function effectImages(
  value: JsonValue | undefined,
  table: string,
  name: string,
): readonly Readonly<Record<string, JsonValue>>[] {
  const source = sourceValue(value, EFFECTS_SECTION, table, name);
  if (isJsonArray(source)) return source.filter(isJsonObject);
  return isJsonObject(source) ? [source] : [];
}

/** Запись эмиттера источника; `null` — привязки нет или она не объект. */
export function emitterOf(
  value: JsonValue | undefined,
  table: string,
  name: string,
): Readonly<Record<string, JsonValue>> | null {
  const source = sourceValue(value, PARTICLES_SECTION, table, name);
  return isJsonObject(source) ? source : null;
}

function sourceValue(
  value: JsonValue | undefined,
  section: string,
  table: string,
  name: string,
): JsonValue | undefined {
  if (!isJsonObject(value)) return undefined;
  const found = value[section];
  if (!isJsonObject(found)) return undefined;
  const entries = found[table];
  return isJsonObject(entries) ? entries[name] : undefined;
}
