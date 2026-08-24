/**
 * @contribution Пара ED-19 «prefab + запись манифеста» как одна сущность
 * авторинга — вклад в слой операций (ED-29), а не часть каркаса.
 *
 * ED-19: «Редактор SHALL показывать и править юнита и prop как одну сущность
 * авторинга, хотя физически она расщеплена на два документа (sim-prefab и
 * запись манифеста): создание заводит оба, переименование меняет оба
 * согласованно». Транзакция сессии умеет трогать несколько документов и
 * складывать их в ОДНУ запись истории (ED-18), поэтому пара — не «две операции
 * подряд», а одна: отмена возвращает обе половины разом.
 *
 * Операций три, и удаление среди них не по букве ED-19, а по его же сценарию
 * «Удалён префаб, оставшийся в расстановке»: без удаления сценарий недостижим.
 *
 * ## Чего эти операции не проверяют
 *
 * Содержимого. Рассинхронизацию пары называют правила `editor.visualForPrefab`
 * и `editor.prefabForVisual`, повисшую запись расстановки —
 * `editor.placementPrefab` (`validation/crossDocument.ts`). Инструмент не
 * допускает нарушения, правило его называет; второго описания того же
 * нарушения не заводится (ED-30, ED-1). Проверяются здесь только параметры:
 * пустое имя, занятое имя, отсутствующая половина.
 *
 * ## Адреса ссылок — параметр, а не знание операции
 *
 * Имя prefab'а называют четыре места: сама запись `prefabs[].name`, ключ
 * `entities` манифеста (ASSET-6), `initial[].prefab` расстановки (SER-8) и
 * литерал `prefab` действия `spawnEntity` внутри JSON-систем (ACT-1).
 * Переименование, тронувшее только пару, оставило бы автору полный экран
 * находок после каждого действия — то есть создавало бы ту самую
 * рассинхронизацию, ради недопущения которой оно и заводится.
 *
 * Поэтому список мест приходит параметром — тем же приёмом, каким `binding`
 * приходит в операции расстановки, а `DocumentSite` — в междокументные правила
 * (ED-25): раскладку проекта знает тот, кто собирает редактор. Документы, не
 * открытые сессией, не трогаются, и это видимое состояние: правило
 * `editor.placementPrefab` назовёт их, когда они откроются. Молчаливого
 * расхождения не возникает.
 *
 * ## Почему ключ манифеста переименовывается, а не пересоздаётся
 *
 * Ключи документов редактора не сортируются намеренно (`project/canonical.ts`),
 * поэтому `removeValue(old) + setValue(new)` перенесло бы запись в конец
 * `entities` и дало бы дифф на два блока вместо одного (ED-21). Позицию
 * сохраняет `renameKeyInObject` — та же функция, на которой стоит базовая
 * операция `document.renameKey`; второй реализации сохранения позиции здесь
 * нет.
 */
import {
  OperationError,
  getAtPath,
  isJsonArray,
  isJsonObject,
  pathStartsWith,
  renameKeyInObject,
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
import { PREFAB_COMPONENTS_KEY } from './objectsPrefabs.js';

/** Идентификаторы операций пары (ED-19). */
export const PAIR_OPERATIONS = {
  create: 'objects.prefab.create',
  rename: 'objects.prefab.rename',
  delete: 'objects.prefab.delete',
} as const;

/** Где в манифесте визуалов лежат записи сим-сущностей (ASSET-6). */
export const MANIFEST_ENTITIES: JsonPath = Object.freeze(['entities']);

/**
 * Место, называющее имя prefab'а вне самой пары. Форма одна на оба известных
 * случая, и различает их `action`:
 *
 * - его нет — ссылка лежит полем записи списка (`initial[].prefab`, SER-8);
 * - он назван — ссылка лежит аргументом действия DSL где-то внутри записи
 *   (`spawnEntity.prefab` внутри тела JSON-системы, ACT-1, SYS-1). Обход тела
 *   идёт по имени действия, а не по угадыванию имён: `spawnEntity` — имя из
 *   закрытого набора ядра, и приносит его сборка.
 */
export interface PrefabReferenceSite {
  readonly document: DocumentId;
  /** Путь до списка записей, в которых ищется ссылка. */
  readonly list: JsonPath;
  /** Ключ, под которым лежит имя prefab'а. */
  readonly field: string;
  /** Имя действия-носителя; нет — ссылка лежит прямо полем записи. */
  readonly action?: string;
}

/**
 * Адреса ссылок как значение параметра. Значения параметров — JSON и только
 * JSON (ED-29: вызов без интерфейса приходит из чужих рук), поэтому перекладка
 * явная, а не приведение типа.
 */
export function prefabReferences(sites: readonly PrefabReferenceSite[]): OperationParams {
  if (sites.length === 0) return {};
  return {
    references: sites.map(
      (site): JsonObject => ({
        document: site.document,
        list: [...site.list],
        field: site.field,
        ...(site.action === undefined ? {} : { action: site.action }),
      }),
    ),
  };
}

const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};
const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'ui.operation.param.list' };
const RECORD: OperationParamSpec = {
  type: 'descriptor',
  descriptionKey: 'ui.operation.param.record',
};
const PREFAB_NAME: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.prefabName',
};
const RENAME_TO: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.to' };
const VISUALS: OperationParamSpec = {
  type: 'document',
  optional: true,
  descriptionKey: 'ui.operation.param.visuals',
};
const MODEL: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.assetId' };
const REFERENCES: OperationParamSpec = {
  type: 'json',
  optional: true,
  descriptionKey: 'ui.operation.param.references',
};

/*
 * Читатели — приведение типа, а не вторая проверка: схему параметров уже сверил
 * слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams): DocumentId => params.document as DocumentId;
const asList = (params: OperationParams): JsonPath => (params.list ?? []) as JsonPath;
const asRecord = (params: OperationParams): string => params.record as string;
const asString = (params: OperationParams, name: string): string => params[name] as string;

/** Документ манифеста из параметра; `null` — половины пары в этом вызове нет. */
function visualsOf(params: OperationParams): DocumentId | null {
  const raw = params.visuals;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function requireName(operationId: string, param: string, value: string): string {
  if (value.trim() === '') {
    throw new OperationError(operationId, `параметр "${param}": имя prefab'а пусто`, {
      param,
      received: value,
    });
  }
  return value;
}

/** Открыт ли документ этой сессией. Неоткрытый не трогается — это решение 7а. */
function isOpen(ctx: OperationContext, documentId: DocumentId): boolean {
  return ctx.documentIds.includes(documentId);
}

/**
 * Запись по пути с учётом того, что путь может вести внутрь отслеживаемого
 * списка. Записи такого списка адресуются дескриптором, а не индексом (ED-29:
 * путь с индексом ломается от удаления соседа), и поверхность операции прямую
 * запись туда не пускает вовсе. Одна функция вместо двух веток у каждого
 * вызывающего: раскладка списков — свойство документа, а не операции, и
 * `initial` бывает отслеживаемым в собранном редакторе и обычным полем в
 * headless-вызове (ED-29 требует, чтобы работали оба).
 */
function writeInto(
  ctx: OperationContext,
  documentId: DocumentId,
  path: JsonPath,
  value: JsonValue,
): void {
  for (const list of ctx.lists(documentId)) {
    if (path.length <= list.length || !pathStartsWith(path, list)) continue;
    const index = path[list.length];
    if (typeof index !== 'number') continue;
    const descriptor = ctx.records(documentId, list)[index];
    if (descriptor === undefined) continue;
    ctx.setRecordValue(documentId, descriptor, path.slice(list.length + 1), value);
    return;
  }
  ctx.setValue(documentId, path, value);
}

/** Пути узлов внутри записи, у которых названное действие ссылается на это имя. */
function actionHits(
  node: JsonValue | undefined,
  action: string,
  field: string,
  from: string,
  prefix: readonly (string | number)[],
  out: JsonPath[],
): void {
  if (isJsonArray(node)) {
    node.forEach((item, index) => {
      actionHits(item, action, field, from, [...prefix, index], out);
    });
    return;
  }
  if (!isJsonObject(node)) return;
  const carrier = node[action];
  if (isJsonObject(carrier) && carrier[field] === from) out.push([...prefix, action, field]);
  for (const [key, child] of Object.entries(node)) {
    actionHits(child, action, field, from, [...prefix, key], out);
  }
}

/** Одно место ссылок, разобранное из параметра. `null` — запись не того вида. */
function siteOf(value: JsonValue): PrefabReferenceSite | null {
  if (!isJsonObject(value)) return null;
  const document = value.document;
  const list = value.list;
  const field = value.field;
  const action = value.action;
  if (typeof document !== 'string' || !isJsonArray(list) || typeof field !== 'string') return null;
  const path = list.filter(
    (step): step is string | number => typeof step === 'string' || typeof step === 'number',
  );
  return {
    document,
    list: path,
    field,
    ...(typeof action === 'string' ? { action } : {}),
  };
}

/**
 * Переписывает ссылки на имя во всех названных местах. Возвращает число
 * переписанных мест — им операция и отчитывается вызывающему: «сколько ссылок
 * поехало» видно автору, а не выводится им из диффа.
 */
function rewriteReferences(
  operationId: string,
  ctx: OperationContext,
  params: OperationParams,
  from: string,
  to: string,
): number {
  const raw = params.references;
  if (raw === undefined || raw === null) return 0;
  if (!isJsonArray(raw)) {
    throw new OperationError(operationId, 'параметр "references": ожидался список адресов', {
      param: 'references',
      received: raw,
    });
  }
  let rewritten = 0;
  for (const entry of raw) {
    const site = siteOf(entry);
    if (site === null) {
      throw new OperationError(
        operationId,
        'параметр "references": в адресе нужны непустые document, list и field',
        { param: 'references', received: entry },
      );
    }
    // Неоткрытый документ не трогается: расхождение с ним увидит правило
    // валидации при открытии, а править закрытый файл операция не умеет вовсе.
    if (!isOpen(ctx, site.document)) continue;
    const list = ctx.readAt(site.document, site.list);
    if (!isJsonArray(list)) continue;
    list.forEach((record, index) => {
      if (site.action === undefined) {
        if (isJsonObject(record) && record[site.field] === from) {
          writeInto(ctx, site.document, [...site.list, index, site.field], to);
          rewritten += 1;
        }
        return;
      }
      const hits: JsonPath[] = [];
      actionHits(record, site.action, site.field, from, [], hits);
      for (const hit of hits) {
        writeInto(ctx, site.document, [...site.list, index, ...hit], to);
        rewritten += 1;
      }
    });
  }
  return rewritten;
}

/** Имя записи prefab'а по её дескриптору; отказ — если имени в записи нет. */
function nameOfRecord(operationId: string, ctx: OperationContext, document: DocumentId, record: string): string {
  const where = ctx.locate(document, record);
  const name = ctx.readAt(document, [...where.path, 'name']);
  if (typeof name !== 'string' || name === '') {
    throw new OperationError(operationId, 'у записи prefab\'а нет имени — переименовывать нечего', {
      param: 'record',
      received: record,
    });
  }
  return name;
}

/**
 * Создание юнита (ED-19): prefab в конфиге сцены и запись манифеста с моделью —
 * одним вызовом, одной записью истории, по двум документам. Отмена возвращает
 * обе половины.
 *
 * Состав prefab'а пуст: чем юнит будет, автор говорит следующими действиями
 * (ED-7). Модель приходит параметром — выбирает её просмотрщик ассетов (ED-20),
 * и своего способа назвать модель у этой операции нет.
 */
export const createPrefabPairOperation: AuthoringOperation = {
  id: PAIR_OPERATIONS.create,
  descriptionKey: 'ui.operation.objects.prefab.create',
  params: { document: DOCUMENT, list: LIST, name: PREFAB_NAME, visuals: VISUALS, model: MODEL },
  apply(ctx, params) {
    const id = PAIR_OPERATIONS.create;
    const document = asDocument(params);
    const name = requireName(id, 'name', asString(params, 'name'));
    const model = asString(params, 'model');
    if (model.trim() === '') {
      throw new OperationError(id, 'параметр "model": запись манифеста без модели не бывает (ASSET-6)', {
        param: 'model',
        received: model,
      });
    }
    const visuals = visualsOf(params);
    if (visuals === null || !isOpen(ctx, visuals)) {
      // Вторая половина обязательна: «создание заводит оба» (ED-19), и завести
      // половину пары значило бы создать ту самую рассинхронизацию, которую
      // операция и не допускает.
      throw new OperationError(id, 'параметр "visuals": манифест визуалов не открыт — вторую половину пары завести негде', {
        param: 'visuals',
        received: visuals,
      });
    }
    const entities = ctx.readAt(visuals, MANIFEST_ENTITIES);
    if (isJsonObject(entities) && Object.hasOwn(entities, name)) {
      throw new OperationError(id, `запись манифеста "${name}" уже есть`, {
        param: 'name',
        received: name,
      });
    }
    const descriptor = ctx.appendRecord(document, asList(params), {
      name,
      [PREFAB_COMPONENTS_KEY]: {},
    });
    ctx.setValue(visuals, [...MANIFEST_ENTITIES, name], { model });
    // Дескриптор дописанной записи — им вызывающий её и выделяет (ED-17).
    return descriptor;
  },
};

/**
 * Переименование юнита (ED-19): имя записи prefab'а, ключ записи манифеста на
 * прежней позиции и ссылки по адресам-параметрам — одним вызовом.
 *
 * Отсутствующая половина не отказ: пара могла разойтись до этой правки, и
 * запрещать переименование за чужое нарушение значило бы не дать автору его
 * исправить. Правило валидации о ней уже говорит (ED-8).
 */
export const renamePrefabPairOperation: AuthoringOperation = {
  id: PAIR_OPERATIONS.rename,
  descriptionKey: 'ui.operation.objects.prefab.rename',
  params: { document: DOCUMENT, record: RECORD, to: RENAME_TO, visuals: VISUALS, references: REFERENCES },
  apply(ctx, params) {
    const id = PAIR_OPERATIONS.rename;
    const document = asDocument(params);
    const record = asRecord(params);
    const to = requireName(id, 'to', asString(params, 'to'));
    const from = nameOfRecord(id, ctx, document, record);
    if (from === to) {
      throw new OperationError(id, `параметр "to": prefab уже называется "${to}"`, {
        param: 'to',
        received: to,
      });
    }
    const visuals = visualsOf(params);
    const entities = visuals !== null && isOpen(ctx, visuals) ? ctx.readAt(visuals, MANIFEST_ENTITIES) : undefined;
    // Проверки — до первой записи: отказ обязан оставить оба документа
    // нетронутыми, и «половина переименования» состоянием не бывает.
    if (isJsonObject(entities) && Object.hasOwn(entities, to)) {
      throw new OperationError(id, `запись манифеста "${to}" уже занята`, {
        param: 'to',
        received: to,
      });
    }
    ctx.setRecordValue(document, record, ['name'], to);
    if (isJsonObject(entities) && Object.hasOwn(entities, from) && visuals !== null) {
      // Позиция ключа сохраняется — иначе дифф пары читался бы как два блока
      // правок вместо одного (ED-21).
      ctx.setValue(visuals, MANIFEST_ENTITIES, renameKeyInObject(entities, from, to));
    }
    return rewriteReferences(id, ctx, params, from, to);
  },
};

/**
 * Удаление юнита (ED-19, сценарий «Удалён префаб, оставшийся в расстановке»):
 * обе половины пары одним вызовом.
 *
 * Записи расстановки при этом НЕ трогаются, и это норма, а не пробел: сценарий
 * требует, чтобы повисшая ссылка подсвечивалась валидацией, — то есть чтобы она
 * существовала. Молча вычистить её значило бы удалить работу автора без его
 * ведома, а решение «удалить размещения или переназначить их» принадлежит ему.
 */
export const deletePrefabPairOperation: AuthoringOperation = {
  id: PAIR_OPERATIONS.delete,
  descriptionKey: 'ui.operation.objects.prefab.delete',
  params: { document: DOCUMENT, record: RECORD, visuals: VISUALS },
  apply(ctx, params) {
    const id = PAIR_OPERATIONS.delete;
    const document = asDocument(params);
    const record = asRecord(params);
    const name = nameOfRecord(id, ctx, document, record);
    const visuals = visualsOf(params);
    ctx.removeRecord(document, record);
    if (visuals !== null && isOpen(ctx, visuals)) {
      const entities = ctx.readAt(visuals, MANIFEST_ENTITIES);
      if (isJsonObject(entities) && Object.hasOwn(entities, name)) {
        ctx.removeValue(visuals, [...MANIFEST_ENTITIES, name]);
      }
    }
    return undefined;
  },
};

export const PAIR_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  createPrefabPairOperation,
  renamePrefabPairOperation,
  deletePrefabPairOperation,
]);

/** Ключи записей манифеста — вторая половина пары так, как её видит область. */
export function manifestEntryNames(visuals: JsonValue | undefined): readonly string[] {
  const entities = getAtPath(visuals ?? null, MANIFEST_ENTITIES);
  return isJsonObject(entities) ? Object.keys(entities) : [];
}

/**
 * Регистрация вкладом (ED-25): набор операций приносит тот, кто собирает
 * редактор, — базовые операции ядра редактора при этом не правятся.
 */
export function registerPairOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of PAIR_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}
