/**
 * История операций — одна на сессию (ED-23: «история — одна на сессию, а не
 * своя в каждой области»), и потому она живёт здесь, рядом с документами, а не
 * рядом с каркасом областей.
 *
 * Что хранит запись истории. Не байты файлов и не пересчитанное обратное
 * действие, а прежнее и полученное значение каждого затронутого документа
 * (ED-18: «история — над операциями, а не над байтами файлов»). Значения
 * документов иммутабельны и разделяют нетронутые поддеревья, поэтому пара
 * «до/после» стоит две ссылки, а не две копии: правка одной клетки террейна
 * копирует хребет до клетки, а не карту.
 *
 * Почему прежнее значение — целый корень, а не список «путь → прежнее
 * значение». Это одно и то же: при копировании хребта нетронутые поддеревья
 * остаются теми же объектами, так что восстановление прежнего корня и есть
 * восстановление прежних значений ровно затронутых мест — и ничего сверх них.
 * Список путей запись всё равно хранит, но для оповещения вьюпорта (ED-15), а
 * не для отката.
 *
 * Отсюда же следует свойство ED-18 «undo/redo MUST NOT приводить документы в
 * состояние, недостижимое последовательностью операций авторинга»: и `before`,
 * и `after` — состояния, которые сессия уже проходила, а не вычисленные заново.
 */
import type { DescriptorTable } from './descriptors.js';
import type { JsonPath, JsonValue } from './json.js';
import type { DocumentId, DocumentPathRef } from './types.js';

/** Глубина по умолчанию. Ограничение MAY существовать (ED-18) и отбрасывает старейшее. */
export const DEFAULT_HISTORY_DEPTH = 500;

export interface DocumentChange {
  readonly documentId: DocumentId;
  readonly before: JsonValue;
  readonly after: JsonValue;
  /** Таблицы дескрипторов до и после: адресация обязана переживать undo так же, как значения. */
  readonly descriptorsBefore: DescriptorTable;
  readonly descriptorsAfter: DescriptorTable;
  /** Затронутые места, в порядке первого касания. */
  readonly paths: readonly JsonPath[];
}

export interface HistoryEntry {
  readonly operationId: string;
  readonly params: JsonValue;
  readonly changes: readonly DocumentChange[];
}

/** То, что видно снаружи: чем была операция и что она тронула, без значений. */
export interface HistoryEntryView {
  readonly operationId: string;
  readonly params: JsonValue;
  readonly documentIds: readonly DocumentId[];
  readonly paths: readonly DocumentPathRef[];
}

export interface HistorySnapshot {
  /** От старейшей к ближайшей: ближайшая к отмене — последняя. */
  readonly undo: readonly HistoryEntryView[];
  /** От ближайшей к повтору к дальней. */
  readonly redo: readonly HistoryEntryView[];
  readonly depthLimit: number;
  /** Сколько операций отброшено ограничением глубины — отброшены старейшие (ED-18). */
  readonly dropped: number;
}

export function viewEntry(entry: HistoryEntry): HistoryEntryView {
  const paths: DocumentPathRef[] = [];
  for (const change of entry.changes) {
    for (const path of change.paths) paths.push({ documentId: change.documentId, path });
  }
  return {
    operationId: entry.operationId,
    params: entry.params,
    documentIds: entry.changes.map((change) => change.documentId),
    paths,
  };
}

export class OperationHistory {
  readonly depthLimit: number;
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #dropped = 0;

  constructor(depthLimit: number = DEFAULT_HISTORY_DEPTH) {
    if (!Number.isInteger(depthLimit) || depthLimit < 1) {
      throw new Error('глубина истории — целое число не меньше единицы');
    }
    this.depthLimit = depthLimit;
  }

  push(entry: HistoryEntry): void {
    // Новая операция обрывает ветку повтора: состояние, в которое вёл redo,
    // больше не достижимо последовательностью операций (ED-18).
    this.#redo = [];
    this.#undo.push(entry);
    while (this.#undo.length > this.depthLimit) {
      this.#undo.shift();
      this.#dropped++;
    }
  }

  canUndo(): boolean {
    return this.#undo.length > 0;
  }

  canRedo(): boolean {
    return this.#redo.length > 0;
  }

  takeUndo(): HistoryEntry | undefined {
    const entry = this.#undo.pop();
    if (entry !== undefined) this.#redo.push(entry);
    return entry;
  }

  takeRedo(): HistoryEntry | undefined {
    const entry = this.#redo.pop();
    if (entry !== undefined) this.#undo.push(entry);
    return entry;
  }

  /** Упоминается ли документ хоть в одной записи — обеих веток. */
  references(documentId: DocumentId): boolean {
    const touches = (entry: HistoryEntry): boolean =>
      entry.changes.some((change) => change.documentId === documentId);
    return this.#undo.some(touches) || this.#redo.some(touches);
  }

  snapshot(): HistorySnapshot {
    return {
      undo: this.#undo.map(viewEntry),
      redo: [...this.#redo].reverse().map(viewEntry),
      depthLimit: this.depthLimit,
      dropped: this.#dropped,
    };
  }
}
