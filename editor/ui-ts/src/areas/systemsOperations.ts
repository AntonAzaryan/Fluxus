/**
 * @contribution Операции над системами (ED-4, ED-29) — вклад в слой операций, а
 * не часть каркаса.
 *
 * Своих операций здесь ровно три, и каждая существует потому, что базовым
 * набором её не выразить. Всё остальное правится базовыми операциями, названными
 * в `SYSTEM_OPERATIONS` по именам: доменная обёртка над `document.list.setValue`
 * отличалась бы от него только именем в машинном каталоге (ED-30).
 *
 * - `systems.system.create` — дописывает запись со свободным местом в тике.
 *   Свободным, а не нулевым: равные `order` ядро отвергает (DET-9), и новая
 *   система, севшая на занятое место, ломала бы сцену в момент своего появления.
 *   Это аффорданс, а не вердикт: судит по-прежнему `loadScene`, а операция лишь
 *   не предлагает автору заведомо отвергаемое (решение 5 design'а).
 * - `systems.node.append` — дописывает узел в КОНЕЦ списка внутри записи.
 *   Базовым `document.list.setValue` это выражается только индексом, а индекс
 *   вызывающий узнаёт чтением документа: инструкция «в конец `do`» полна сама
 *   по себе, а «в `do[3]`» верна лишь при той длине списка, которую вызывающий
 *   видел. ED-29 требует, чтобы операции были исполнимы без интерфейса, — значит
 *   их параметры не должны зависеть от того, что вызывающий успел прочитать.
 * - `systems.trigger.setSource` — меняет источник срабатывания триггера (ED-4),
 *   НЕ теряя собранное тело. Одно действие автора — одна запись истории
 *   (ED-18), поэтому переноса тела двумя базовыми правками здесь нет.
 *
 * Чего эти операции не проверяют: собранного. Имя действия, состав аргументов,
 * связанность переменных и типы значений — дело `validateSystem` (SYS-3),
 * приходящее находкой на записи системы (ED-8, правило `core.system`). Второго
 * описания тех же правил в редакторе нет и быть не должно (ED-1, ED-30).
 */
import {
  OperationError,
  isJsonArray,
  isJsonObject,
  type AuthoringOperation,
  type DocumentId,
  type JsonPath,
  type JsonValue,
  type OperationContext,
  type OperationParams,
  type OperationParamSpec,
  type OperationRegistry,
} from '@fluxus/editor-core';
import {
  BODY_KEY,
  EVENT_ACTION,
  NAME_KEY,
  ORDER_KEY,
  QUERY_KEY,
  triggerOf,
  type TriggerSource,
} from './systemsDocuments.js';

/**
 * Имена операций области. Перестановки систем среди них нет и не заводится:
 * место в тике задаёт поле `order` (SYS-2), а не позиция в списке, — и порядок
 * записей документа остаётся тем, в каком их писал автор (ED-21).
 */
export const SYSTEM_OPERATIONS = {
  create: 'systems.system.create',
  append: 'systems.node.append',
  source: 'systems.trigger.setSource',
  /** Правка места внутри записи — базовая операция (ED-30). */
  setValue: 'document.list.setValue',
  /** Снятие места внутри записи; у списка это вырезание узла со сдвигом соседей. */
  removeValue: 'document.list.removeValue',
  /** Снятие самой системы: это умеет базовый набор. */
  remove: 'document.list.remove',
} as const;

const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};
const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'ui.operation.param.list' };
const RECORD: OperationParamSpec = {
  type: 'descriptor',
  descriptionKey: 'ui.operation.param.record',
};
const SYSTEM_NAME: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.systemName',
};
const NODE_PATH: OperationParamSpec = { type: 'path', descriptionKey: 'ui.operation.param.path' };
const NODE: OperationParamSpec = { type: 'json', descriptionKey: 'ui.operation.param.node' };
const SOURCE: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.source' };
const EVENT_TYPE: OperationParamSpec = {
  type: 'string',
  optional: true,
  descriptionKey: 'ui.operation.param.eventType',
};

/*
 * Читатели — приведение типа, а не вторая проверка: схему параметров уже сверил
 * слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams): DocumentId => params.document as DocumentId;
const asList = (params: OperationParams): JsonPath => (params.list ?? []) as JsonPath;
const asRecord = (params: OperationParams): string => params.record as string;
const asPath = (params: OperationParams): JsonPath => (params.path ?? []) as JsonPath;
const asString = (params: OperationParams, name: string): string => params[name] as string;

/** Все источники ED-4: перечень нужен операции, чтобы отвергнуть чужое слово. */
const SOURCES: readonly TriggerSource[] = Object.freeze(['tick', 'query', 'event']);

/**
 * Свободное место в тике: следующее за наибольшим занятым (SYS-2, DET-9).
 * Отсчёт с нуля, если систем ещё нет.
 */
function freeOrder(list: JsonValue | undefined): number {
  if (!isJsonArray(list)) return 0;
  let top: number | null = null;
  for (const entry of list) {
    const order = isJsonObject(entry) ? entry[ORDER_KEY] : undefined;
    if (typeof order !== 'number' || !Number.isInteger(order)) continue;
    if (top === null || order > top) top = order;
  }
  return top === null ? 0 : top + 1;
}

/**
 * Новая система (ED-4). Тело пусто: чем триггер будет, автор говорит
 * следующими действиями. Пустое тело ядро принимает (`bodyOf` от пустого списка
 * — пустой список), и до первого блока система просто ничего не делает.
 */
const createSystemOperation: AuthoringOperation = {
  id: SYSTEM_OPERATIONS.create,
  descriptionKey: 'ui.operation.systems.system.create',
  params: { document: DOCUMENT, list: LIST, name: SYSTEM_NAME },
  apply(ctx, params) {
    const id = SYSTEM_OPERATIONS.create;
    const document = asDocument(params);
    const list = asList(params);
    const name = asString(params, 'name');
    if (name.trim() === '') {
      throw new OperationError(id, 'параметр "name": имя системы пусто', {
        param: 'name',
        received: name,
      });
    }
    return ctx.appendRecord(document, list, {
      [NAME_KEY]: name,
      [ORDER_KEY]: freeOrder(ctx.readAt(document, list)),
      [BODY_KEY]: [],
    });
  },
};

/** Список по пути внутри записи; `undefined` — места ещё нет, список пуст. */
function listAt(
  operationId: string,
  ctx: OperationContext,
  document: DocumentId,
  record: string,
  path: JsonPath,
): readonly JsonValue[] {
  const where = ctx.locate(document, record);
  const node = ctx.readAt(document, [...where.path, ...path]);
  if (node === undefined) return [];
  if (!isJsonArray(node)) {
    throw new OperationError(operationId, 'по этому пути записи лежит не список', {
      param: 'path',
      received: [...path],
    });
  }
  return node;
}

/**
 * Узел в конец списка внутри записи (ED-5). Возвращает индекс дописанного —
 * им вызывающий раскрывает поставленный блок, не пересчитывая длину списка.
 */
const appendNodeOperation: AuthoringOperation = {
  id: SYSTEM_OPERATIONS.append,
  descriptionKey: 'ui.operation.systems.node.append',
  params: { document: DOCUMENT, record: RECORD, path: NODE_PATH, node: NODE },
  apply(ctx, params) {
    const id = SYSTEM_OPERATIONS.append;
    const document = asDocument(params);
    const record = asRecord(params);
    const path = asPath(params);
    if (path.length === 0) {
      throw new OperationError(id, 'параметр "path": пустой путь адресует саму запись, а не список в ней', {
        param: 'path',
        received: [],
      });
    }
    const index = listAt(id, ctx, document, record, path).length;
    ctx.setRecordValue(document, record, [...path, index], params.node ?? null);
    return index;
  },
};

/**
 * Источник срабатывания триггера (ED-4) — с сохранением собранного тела.
 *
 * Формы три, и перенос между ними механический:
 *
 * - в событие — тело системы уезжает в `do` действия `forEachEvent`, а сам он
 *   становится единственным действием системы;
 * - из события — тело события возвращается на место действия, а соседи по
 *   списку остаются на своих местах;
 * - запрос и событие взаимно исключают друг друга: система с обоими сразу
 *   означала бы два источника у одного триггера, а ED-4 знает один.
 *
 * Пустой запрос `{}` и пустой тип события — законные незаполненные блоки: их
 * заполняет автор следующим действием, и до тех пор о них говорит валидация, а
 * не операция (ED-8).
 */
const setTriggerSourceOperation: AuthoringOperation = {
  id: SYSTEM_OPERATIONS.source,
  descriptionKey: 'ui.operation.systems.trigger.setSource',
  params: { document: DOCUMENT, record: RECORD, source: SOURCE, type: EVENT_TYPE },
  apply(ctx, params) {
    const id = SYSTEM_OPERATIONS.source;
    const document = asDocument(params);
    const record = asRecord(params);
    const source = asString(params, 'source') as TriggerSource;
    if (!SOURCES.includes(source)) {
      throw new OperationError(id, `параметр "source": источника "${source}" у триггера не бывает`, {
        param: 'source',
        received: source,
      });
    }
    const where = ctx.locate(document, record);
    const system = ctx.readAt(document, where.path);
    const trigger = triggerOf(system);
    if (trigger.source === source) {
      throw new OperationError(id, `параметр "source": триггер уже срабатывает так ("${source}")`, {
        param: 'source',
        received: source,
      });
    }
    const body = ctx.readAt(document, [...where.path, ...trigger.bodyPath]);
    const inner: readonly JsonValue[] = isJsonArray(body) ? body : [];
    const outer = ctx.readAt(document, [...where.path, BODY_KEY]);
    const around: readonly JsonValue[] = isJsonArray(outer) ? outer : [];

    if (source === 'event') {
      const type = params.type;
      ctx.setRecordValue(document, record, [BODY_KEY], [
        {
          [EVENT_ACTION]: {
            type: typeof type === 'string' ? type : '',
            [BODY_KEY]: [...inner],
          },
        },
      ]);
      if (isJsonObject(system) && system[QUERY_KEY] !== undefined) {
        ctx.removeRecordValue(document, record, [QUERY_KEY]);
      }
      return undefined;
    }

    // Из события: тело события встаёт на место самого действия, соседи по
    // списку остаются там же — автор писал их рядом, а не внутри.
    if (trigger.eventIndex !== null) {
      const at = trigger.eventIndex;
      ctx.setRecordValue(document, record, [BODY_KEY], [
        ...around.slice(0, at),
        ...inner,
        ...around.slice(at + 1),
      ]);
    }
    if (source === 'query') {
      const existing = isJsonObject(system) ? system[QUERY_KEY] : undefined;
      ctx.setRecordValue(document, record, [QUERY_KEY], existing ?? {});
    } else if (isJsonObject(system) && system[QUERY_KEY] !== undefined) {
      ctx.removeRecordValue(document, record, [QUERY_KEY]);
    }
    return undefined;
  },
};

export const SYSTEM_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  createSystemOperation,
  appendNodeOperation,
  setTriggerSourceOperation,
]);

/** Регистрация вкладом (ED-25): набор приносит тот, кто собирает редактор. */
export function registerSystemOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of SYSTEM_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}
