/**
 * Сессия редактора — открытые документы, их состояние «есть несохранённые
 * правки» и одна на всех история операций (ED-23).
 *
 * Здесь же выполняется главное требование слоя: править документ можно только
 * зарегистрированной операцией (ED-29). Выполняется структурно, а не запретом
 * в документации:
 *
 * 1. Наружу сессия отдаёт замороженное вглубь значение. Мутировать его нечем.
 * 2. Значение, переданное при открытии, копируется — иначе документ правился
 *    бы через ссылку, оставшуюся у открывающего.
 * 3. Мутирующего метода в поверхности сессии нет вовсе. Есть
 *    `applyOperation(id, params)` и `beginOperation(id, params)`, то есть
 *    «примени вот эту операцию», а не «вот тебе изменяемый документ».
 * 4. Поверхность правки (`OperationContext`) существует только внутри вызова
 *    `apply` конкретной операции и после возврата из него бросает на любой
 *    метод. Припрятать её и написать позже — мимо истории — нельзя.
 *
 * Отсюда же вытекает, что набор операций без интерфейса и из интерфейса — один
 * и тот же: это один и тот же реестр, и второго пути правки просто не
 * существует, а не «не рекомендуется».
 *
 * Границей операции служит взаимодействие, а не событие ввода (ED-18: мазок
 * кисти — одна операция). Механизм — транзакция: `beginOperation` открывает,
 * `extend` продолжает тем же `apply` с новыми параметрами, `commit` кладёт в
 * историю одну запись, `cancel` возвращает документы к состоянию до начала.
 * Прежние значения при этом берутся с первого касания места, а не с
 * последнего: двадцать клеток мазка вернутся к тем уровням, что были до
 * нажатия, а не к промежуточным.
 */
import {
  DescriptorMinter,
  locateDescriptor,
  type DescriptorId,
  type DescriptorLocation,
  type DescriptorTable,
} from './descriptors.js';
import {
  OperationHistory,
  type DocumentChange,
  type HistoryEntry,
  type HistorySnapshot,
} from './history.js';
import {
  getAtPath,
  cloneFrozen,
  isJsonArray,
  pathKey,
  pathStartsWith,
  formatPath,
  removeAtPath,
  setAtPath,
  type JsonPath,
  type JsonValue,
} from './json.js';
import type { DocumentId, DocumentKind, DocumentPathRef, EditorDocument, OpenDocumentInput } from './types.js';
import { checkParams } from '../operations/params.js';
import { createOperationRegistry, type OperationRegistry } from '../operations/registry.js';
import {
  OperationError,
  type AuthoringOperation,
  type OperationContext,
  type OperationParams,
} from '../operations/types.js';

export interface EditorSessionOptions {
  /**
   * Реестр операций. Передаётся снаружи, потому что регистрируют вклады
   * (ED-25), а сессия только исполняет зарегистрированное.
   */
  readonly operations?: OperationRegistry;
  /** Ограничение глубины истории (ED-18); отбрасываются старейшие операции. */
  readonly historyDepth?: number;
}

/** Результат применения операции. */
export interface OperationOutcome {
  readonly operationId: string;
  /** Что вернула операция: например, дескриптор дописанной записи. */
  readonly result: JsonValue | undefined;
  readonly documentIds: readonly DocumentId[];
  /**
   * Попала ли операция в историю. Операция, не изменившая ни одного документа,
   * записи не оставляет: undo, который ничего не делает, хуже его отсутствия —
   * автор нажимает второй раз и отменяет не то.
   */
  readonly recorded: boolean;
}

/**
 * Транзакция — одно взаимодействие: от нажатия до отпускания, от фокуса до
 * подтверждения. За её пределами операций не создаётся.
 */
export interface OperationTransaction {
  readonly operationId: string;
  readonly open: boolean;
  /** Продолжает то же взаимодействие: тот же `apply` с новыми параметрами. */
  extend(params?: OperationParams): JsonValue | undefined;
  /** Закрывает взаимодействие одной записью истории; отдаёт результат последнего применения. */
  commit(): OperationOutcome;
  /** Возвращает документы к состоянию до `beginOperation`; в историю ничего не кладётся. */
  cancel(): void;
}

export type SessionEventKind = 'opened' | 'closed' | 'applied' | 'undone' | 'redone' | 'cancelled' | 'saved';

/** Оповещение для вьюпорта и панелей (ED-15: изображение обновляется не позже следующего кадра). */
export interface SessionEvent {
  readonly kind: SessionEventKind;
  readonly operationId?: string;
  readonly documentIds: readonly DocumentId[];
  readonly paths: readonly DocumentPathRef[];
}

export interface EditorSession {
  /** Тот же реестр, из которого строится интерфейс и машинный каталог (ED-29, ED-30). */
  readonly operations: OperationRegistry;
  openDocument(input: OpenDocumentInput): EditorDocument;
  closeDocument(id: DocumentId): void;
  isOpen(id: DocumentId): boolean;
  documentIds(): readonly DocumentId[];
  document(id: DocumentId): EditorDocument;
  documentValue(id: DocumentId): JsonValue;
  /** Документы с несохранёнными правками — ровно те, которых касается сохранение (ED-21). */
  dirtyDocumentIds(): readonly DocumentId[];
  markSaved(id: DocumentId): void;
  descriptors(id: DocumentId, list: JsonPath): readonly DescriptorId[];
  resolveDescriptor(id: DocumentId, descriptor: string): DescriptorLocation | undefined;
  applyOperation(operationId: string, params?: OperationParams): OperationOutcome;
  beginOperation(operationId: string, params?: OperationParams): OperationTransaction;
  /** Идёт ли взаимодействие: пока идёт, второй операции не начать. */
  readonly pending: boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
  history(): HistorySnapshot;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

interface DocumentRecord {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly lists: readonly JsonPath[];
  value: JsonValue;
  /** Значение на момент открытия или последнего сохранения — для `dirty` (ED-21). */
  saved: JsonValue;
  descriptors: DescriptorTable;
}

interface PendingDocument {
  readonly record: DocumentRecord;
  readonly before: JsonValue;
  readonly descriptorsBefore: DescriptorTable;
  readonly paths: JsonPath[];
  readonly seen: Set<string>;
}

export function createEditorSession(options: EditorSessionOptions = {}): EditorSession {
  const registry = options.operations ?? createOperationRegistry();
  const history = new OperationHistory(options.historyDepth);
  const minter = new DescriptorMinter();
  const documents = new Map<DocumentId, DocumentRecord>();
  const listeners = new Set<(event: SessionEvent) => void>();
  let transaction: Transaction | undefined;

  const requireDocument = (id: DocumentId): DocumentRecord => {
    const record = documents.get(id);
    if (record === undefined) throw new Error(`документ "${id}" не открыт`);
    return record;
  };

  const emit = (event: SessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const view = (record: DocumentRecord): EditorDocument => ({
    id: record.id,
    kind: record.kind,
    value: record.value,
    dirty: record.value !== record.saved,
    lists: record.lists,
  });

  /** Таблица дескрипторов на момент открытия: по одному на существующую запись. */
  const initialTable = (value: JsonValue, lists: readonly JsonPath[]): DescriptorTable => {
    const table = new Map<string, readonly DescriptorId[]>();
    for (const list of lists) {
      const node = getAtPath(value, list);
      table.set(pathKey(list), minter.mintFor(isJsonArray(node) ? node.length : 0));
    }
    return table;
  };

  /**
   * Транзакция накапливает касания и решает, что попадёт в историю. Класс, а не
   * замыкание: у неё есть состояние «открыта», от которого зависит поведение
   * поверхности правки, и прятать его в переменную модуля было бы хуже видно.
   */
  class Transaction implements OperationTransaction {
    readonly operationId: string;
    readonly #operation: AuthoringOperation;
    readonly #touched = new Map<DocumentId, PendingDocument>();
    #params: JsonValue = null;
    #result: JsonValue | undefined;
    #open = true;

    constructor(operation: AuthoringOperation) {
      this.#operation = operation;
      this.operationId = operation.id;
    }

    get open(): boolean {
      return this.#open;
    }

    touch(id: DocumentId): PendingDocument {
      const record = requireDocument(id);
      let pending = this.#touched.get(id);
      if (pending === undefined) {
        pending = {
          record,
          before: record.value,
          descriptorsBefore: record.descriptors,
          paths: [],
          seen: new Set<string>(),
        };
        this.#touched.set(id, pending);
      }
      return pending;
    }

    mark(pending: PendingDocument, path: JsonPath): void {
      const key = pathKey(path);
      if (pending.seen.has(key)) return;
      pending.seen.add(key);
      pending.paths.push(path);
    }

    run(params: OperationParams): JsonValue | undefined {
      checkParams(this.#operation, params);
      // Параметры запоминаются копией: история показывает, чем была операция,
      // и вызывающий не должен уметь переписать это задним числом.
      this.#params = cloneFrozen(params);
      const ctx = new Context(this);
      try {
        // Результат последнего применения — результат взаимодействия: мазок
        // отдаёт то, чем он кончился, а не то, чем начался.
        this.#result = this.#operation.apply(ctx, params) ?? undefined;
        return this.#result;
      } finally {
        // Контекст закрывается сразу после возврата из `apply`: операция,
        // сохранившая его в замыкании, ничего им не сделает.
        ctx.close();
      }
    }

    extend(params: OperationParams = {}): JsonValue | undefined {
      this.#assertOpen();
      return this.run(params);
    }

    commit(): OperationOutcome {
      this.#assertOpen();
      this.#open = false;
      transaction = undefined;
      const changes: DocumentChange[] = [];
      for (const pending of this.#touched.values()) {
        const changed =
          pending.record.value !== pending.before || pending.record.descriptors !== pending.descriptorsBefore;
        if (!changed) continue;
        changes.push({
          documentId: pending.record.id,
          before: pending.before,
          after: pending.record.value,
          descriptorsBefore: pending.descriptorsBefore,
          descriptorsAfter: pending.record.descriptors,
          paths: Object.freeze([...pending.paths]),
        });
      }
      if (changes.length === 0) {
        return { operationId: this.operationId, result: this.#result, documentIds: [], recorded: false };
      }
      const entry: HistoryEntry = {
        operationId: this.operationId,
        params: this.#params,
        changes: Object.freeze(changes),
      };
      history.push(entry);
      const documentIds = changes.map((change) => change.documentId);
      emit({ kind: 'applied', operationId: this.operationId, documentIds, paths: pathRefs(changes) });
      return { operationId: this.operationId, result: this.#result, documentIds, recorded: true };
    }

    cancel(): void {
      this.#assertOpen();
      this.#open = false;
      transaction = undefined;
      const documentIds: DocumentId[] = [];
      const paths: DocumentPathRef[] = [];
      for (const pending of this.#touched.values()) {
        if (pending.record.value === pending.before && pending.record.descriptors === pending.descriptorsBefore) {
          continue;
        }
        pending.record.value = pending.before;
        pending.record.descriptors = pending.descriptorsBefore;
        documentIds.push(pending.record.id);
        for (const path of pending.paths) paths.push({ documentId: pending.record.id, path });
      }
      if (documentIds.length > 0) {
        emit({ kind: 'cancelled', operationId: this.operationId, documentIds, paths });
      }
    }

    #assertOpen(): void {
      if (!this.#open) throw new OperationError(this.operationId, 'взаимодействие уже закрыто');
    }
  }

  /**
   * Поверхность правки одной операции. Все записи идут через неё, и она же
   * запоминает прежние значения — то есть «обратная» половина пары из ED-29
   * получается сама, а не пишется каждой операцией заново.
   */
  class Context implements OperationContext {
    readonly #tx: Transaction;
    #live = true;

    constructor(tx: Transaction) {
      this.#tx = tx;
    }

    close(): void {
      this.#live = false;
    }

    get documentIds(): readonly DocumentId[] {
      this.#assertLive();
      return [...documents.keys()];
    }

    kindOf(id: DocumentId): DocumentKind {
      this.#assertLive();
      return requireDocument(id).kind;
    }

    read(id: DocumentId): JsonValue {
      this.#assertLive();
      return requireDocument(id).value;
    }

    readAt(id: DocumentId, path: JsonPath): JsonValue | undefined {
      this.#assertLive();
      return getAtPath(requireDocument(id).value, path);
    }

    lists(id: DocumentId): readonly JsonPath[] {
      this.#assertLive();
      return requireDocument(id).lists;
    }

    records(id: DocumentId, list: JsonPath): readonly DescriptorId[] {
      this.#assertLive();
      const record = requireDocument(id);
      const ids = record.descriptors.get(pathKey(list));
      if (ids === undefined) {
        throw new OperationError(this.#tx.operationId, `список ${formatPath(list)} документа "${id}" не отслеживается`);
      }
      return ids;
    }

    locate(id: DocumentId, descriptor: string): DescriptorLocation {
      this.#assertLive();
      const record = requireDocument(id);
      const found = locateDescriptor(record.descriptors, record.lists, descriptor);
      if (found === undefined) {
        throw new OperationError(this.#tx.operationId, `запись "${descriptor}" не найдена в документе "${id}"`, {
          received: descriptor,
        });
      }
      return found;
    }

    setValue(id: DocumentId, path: JsonPath, value: JsonValue): void {
      this.#assertLive();
      const pending = this.#tx.touch(id);
      this.#guard(pending.record, path);
      this.#write(pending, path, value);
    }

    removeValue(id: DocumentId, path: JsonPath): void {
      this.#assertLive();
      const pending = this.#tx.touch(id);
      this.#guard(pending.record, path);
      this.#erase(pending, path);
    }

    setRecordValue(id: DocumentId, descriptor: string, path: JsonPath, value: JsonValue): void {
      this.#assertLive();
      const where = this.locate(id, descriptor);
      const pending = this.#tx.touch(id);
      this.#write(pending, [...where.path, ...path], value);
    }

    removeRecordValue(id: DocumentId, descriptor: string, path: JsonPath): void {
      this.#assertLive();
      const where = this.locate(id, descriptor);
      const pending = this.#tx.touch(id);
      this.#erase(pending, [...where.path, ...path]);
    }

    appendRecord(id: DocumentId, list: JsonPath, item: JsonValue): DescriptorId {
      this.#assertLive();
      const existing = this.records(id, list);
      const pending = this.#tx.touch(id);
      // Строго в конец (SER-8, ED-16): вставка в середину сдвинула бы выданные
      // ID всего, что за ней, то есть изменила бы `worldInit` сцены там, где
      // автор поставил один объект.
      const at: JsonPath = [...list, existing.length];
      this.#write(pending, at, item);
      const descriptor = minter.mint();
      this.#setDescriptors(pending, list, [...existing, descriptor]);
      return descriptor;
    }

    removeRecord(id: DocumentId, descriptor: string): void {
      this.#assertLive();
      const where = this.locate(id, descriptor);
      const existing = this.records(id, where.list);
      const pending = this.#tx.touch(id);
      this.#erase(pending, where.path);
      this.#setDescriptors(pending, where.list, [
        ...existing.slice(0, where.index),
        ...existing.slice(where.index + 1),
      ]);
    }

    /**
     * Отслеживаемый список целиком и его записи по индексу закрыты для прямой
     * записи: у записей есть дескрипторы, и путь с индексом ломается от
     * удаления соседа (ED-29). Ветка проверяется в обе стороны — запись в
     * предка списка заменила бы список так же незаметно.
     */
    #guard(record: DocumentRecord, path: JsonPath): void {
      for (const list of record.lists) {
        if (pathStartsWith(path, list) || pathStartsWith(list, path)) {
          throw new OperationError(
            this.#tx.operationId,
            `${formatPath(path)}: записи списка ${formatPath(list)} адресуются дескриптором, а не путём`,
          );
        }
      }
    }

    #write(pending: PendingDocument, path: JsonPath, value: JsonValue): void {
      // Запись того же значения правкой не считается: иначе «поле потрогали и
      // вернули как было» помечало бы документ несохранённым (ED-21).
      if (Object.is(getAtPath(pending.record.value, path), value)) return;
      pending.record.value = setAtPath(pending.record.value, path, value);
      this.#tx.mark(pending, path);
    }

    #erase(pending: PendingDocument, path: JsonPath): void {
      const next = removeAtPath(pending.record.value, path);
      if (next === pending.record.value) return;
      pending.record.value = next;
      this.#tx.mark(pending, path);
    }

    #setDescriptors(pending: PendingDocument, list: JsonPath, ids: readonly DescriptorId[]): void {
      const table = new Map(pending.record.descriptors);
      table.set(pathKey(list), Object.freeze([...ids]));
      pending.record.descriptors = table;
    }

    #assertLive(): void {
      if (!this.#live) {
        throw new OperationError(this.#tx.operationId, 'поверхность правки действительна только внутри `apply`');
      }
    }
  }

  const start = (operationId: string, params: OperationParams): Transaction => {
    if (transaction !== undefined) {
      throw new OperationError(operationId, `взаимодействие "${transaction.operationId}" ещё не закрыто`);
    }
    const operation = registry.get(operationId);
    if (operation === undefined) {
      throw new Error(`операция "${operationId}" не зарегистрирована (ED-29: правка только операцией)`);
    }
    const tx = new Transaction(operation);
    transaction = tx;
    try {
      tx.run(params);
      return tx;
    } catch (error) {
      // Упавшая операция не оставляет полуправки: то, что она успела записать,
      // откатывается тем же механизмом, что и отменённое взаимодействие.
      tx.cancel();
      throw error;
    }
  };

  const restore = (entry: HistoryEntry, direction: 'undo' | 'redo'): void => {
    for (const change of direction === 'undo' ? [...entry.changes].reverse() : entry.changes) {
      const record = documents.get(change.documentId);
      if (record === undefined) continue;
      record.value = direction === 'undo' ? change.before : change.after;
      record.descriptors = direction === 'undo' ? change.descriptorsBefore : change.descriptorsAfter;
    }
    emit({
      kind: direction === 'undo' ? 'undone' : 'redone',
      operationId: entry.operationId,
      documentIds: entry.changes.map((change) => change.documentId),
      paths: pathRefs(entry.changes),
    });
  };

  return {
    operations: registry,

    openDocument(input) {
      if (documents.has(input.id)) throw new Error(`документ "${input.id}" уже открыт`);
      const value = cloneFrozen(input.value);
      const lists = Object.freeze((input.lists ?? []).map((list) => Object.freeze([...list])));
      const record: DocumentRecord = {
        id: input.id,
        kind: input.kind,
        lists,
        value,
        saved: value,
        descriptors: initialTable(value, lists),
      };
      documents.set(input.id, record);
      emit({ kind: 'opened', documentIds: [input.id], paths: [] });
      return view(record);
    },

    closeDocument(id) {
      const record = requireDocument(id);
      if (transaction !== undefined) throw new Error('закрыть документ во время взаимодействия нельзя');
      // История покрывает сессию (ED-18). Закрыть документ, о котором в ней
      // есть записи, значило бы оставить в истории дыру: undo привёл бы
      // остальные документы в состояние, которого вместе с закрытым не было.
      if (history.references(id)) throw new Error(`документ "${id}" упомянут в истории операций`);
      if (record.value !== record.saved) throw new Error(`документ "${id}" не сохранён`);
      documents.delete(id);
      emit({ kind: 'closed', documentIds: [id], paths: [] });
    },

    isOpen: (id) => documents.has(id),
    documentIds: () => [...documents.keys()],
    document: (id) => view(requireDocument(id)),
    documentValue: (id) => requireDocument(id).value,

    dirtyDocumentIds: () =>
      [...documents.values()].filter((record) => record.value !== record.saved).map((record) => record.id),

    markSaved(id) {
      const record = requireDocument(id);
      record.saved = record.value;
      emit({ kind: 'saved', documentIds: [id], paths: [] });
    },

    descriptors(id, list) {
      const record = requireDocument(id);
      return record.descriptors.get(pathKey(list)) ?? Object.freeze([]);
    },

    resolveDescriptor(id, descriptor) {
      const record = requireDocument(id);
      return locateDescriptor(record.descriptors, record.lists, descriptor);
    },

    applyOperation(operationId, params = {}) {
      // Одношаговый вызов — то же взаимодействие, просто из одного применения:
      // открыть и закрыть его сразу, а не завести второй путь исполнения.
      return start(operationId, params).commit();
    },

    beginOperation(operationId, params = {}) {
      return start(operationId, params);
    },

    get pending() {
      return transaction !== undefined;
    },

    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),

    undo() {
      if (transaction !== undefined) throw new Error('undo во время взаимодействия недоступен');
      const entry = history.takeUndo();
      if (entry === undefined) return false;
      restore(entry, 'undo');
      return true;
    },

    redo() {
      if (transaction !== undefined) throw new Error('redo во время взаимодействия недоступен');
      const entry = history.takeRedo();
      if (entry === undefined) return false;
      restore(entry, 'redo');
      return true;
    },

    history: () => history.snapshot(),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function pathRefs(changes: readonly DocumentChange[]): readonly DocumentPathRef[] {
  const refs: DocumentPathRef[] = [];
  for (const change of changes) {
    for (const path of change.paths) refs.push({ documentId: change.documentId, path });
  }
  return refs;
}
