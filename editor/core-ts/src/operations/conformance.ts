/**
 * Проверка, которой ED-29 держится на практике: «применить операцию, отменить,
 * сравнить документ с исходным» проходит для каждой зарегистрированной
 * операции. Инструмент, пишущий в документ напрямую, в этот перечень просто не
 * попадает — и отсутствие в перечне и есть его обнаружение.
 *
 * Проверка живёт в `src`, а не в тесте, по двум причинам. Первая: она нужна не
 * только этому пакету — операции регистрируют вклады, в том числе из пакета
 * интерфейса, и своя копия проверки у каждого была бы вторым описанием того же
 * свойства. Вторая: результат структурный (ED-30) — документ, шаг и обе формы,
 * — то есть годится не только для красной строки в отчёте vitest.
 *
 * Сравнение идёт байтами сериализатора ядра (`jsonSerializer`), а не своим
 * обходом: канонический вид документа — правило ядра, и вторая его реализация
 * в редакторе запрещена (ED-1, ED-21). Побайтовое равенство здесь означает
 * ровно то же, что пустой дифф файла после «открыл — сохранил».
 */
import { jsonSerializer } from '@fluxus/core';
import type { EditorSession } from '../document/session.js';
import type { DocumentId } from '../document/types.js';
import { pathKey } from '../document/json.js';
import type { OperationParams } from './types.js';

export interface RoundTripFinding {
  readonly documentId: DocumentId;
  /** На каком шаге разошлось: после отмены или после повтора. */
  readonly stage: 'apply' | 'undo' | 'redo';
  /** Что сравнивается: содержимое документа или таблица его дескрипторов. */
  readonly subject: 'value' | 'descriptors';
  readonly expected: string;
  readonly actual: string;
}

export interface RoundTripResult {
  readonly operationId: string;
  readonly ok: boolean;
  /** Оставила ли операция запись в истории. Операция, ничего не изменившая, не оставляет. */
  readonly recorded: boolean;
  readonly findings: readonly RoundTripFinding[];
}

interface StateSnapshot {
  readonly values: ReadonlyMap<DocumentId, string>;
  readonly descriptors: ReadonlyMap<DocumentId, string>;
}

const decoder = new TextDecoder();

function snapshot(session: EditorSession): StateSnapshot {
  const values = new Map<DocumentId, string>();
  const descriptors = new Map<DocumentId, string>();
  for (const id of session.documentIds()) {
    const document = session.document(id);
    values.set(id, decoder.decode(jsonSerializer.encode(document.value)));
    descriptors.set(
      id,
      document.lists
        .map((list) => `${pathKey(list)}=${session.descriptors(id, list).join(',')}`)
        .join(';'),
    );
  }
  return { values, descriptors };
}

function compare(
  expected: StateSnapshot,
  actual: StateSnapshot,
  stage: RoundTripFinding['stage'],
  findings: RoundTripFinding[],
): void {
  const ids = new Set([...expected.values.keys(), ...actual.values.keys()]);
  for (const documentId of ids) {
    const wantValue = expected.values.get(documentId) ?? '<документ не открыт>';
    const gotValue = actual.values.get(documentId) ?? '<документ не открыт>';
    if (wantValue !== gotValue) {
      findings.push({ documentId, stage, subject: 'value', expected: wantValue, actual: gotValue });
    }
    const wantIds = expected.descriptors.get(documentId) ?? '';
    const gotIds = actual.descriptors.get(documentId) ?? '';
    if (wantIds !== gotIds) {
      findings.push({ documentId, stage, subject: 'descriptors', expected: wantIds, actual: gotIds });
    }
  }
}

/**
 * Применяет операцию, отменяет, повторяет и снова отменяет, сверяя состояние на
 * каждом шаге. Повтор входит в проверку не для полноты: ED-18 требует, чтобы
 * redo возвращал ровно то состояние, которое операция и произвела.
 *
 * Сессия остаётся с отменённой операцией: повтор доступен, история не пуста.
 */
export function runOperationRoundTrip(
  session: EditorSession,
  operationId: string,
  params: OperationParams = {},
): RoundTripResult {
  const before = snapshot(session);
  const findings: RoundTripFinding[] = [];
  const outcome = session.applyOperation(operationId, params);
  const after = snapshot(session);

  if (!outcome.recorded) {
    // Операция, не попавшая в историю, обязана быть операцией, ничего не
    // изменившей: иначе её правку нечем отменить, а это и есть выпадение из
    // истории, которого ED-29 не допускает.
    compare(before, after, 'apply', findings);
    return { operationId, ok: findings.length === 0, recorded: false, findings };
  }

  session.undo();
  compare(before, snapshot(session), 'undo', findings);
  session.redo();
  compare(after, snapshot(session), 'redo', findings);
  session.undo();
  compare(before, snapshot(session), 'undo', findings);

  return { operationId, ok: findings.length === 0, recorded: true, findings };
}
