/**
 * Каноническая форма документа на диске (ED-21). Байты производит сериализатор
 * ядра — `prettyJsonSerializer` (SER-2, SER-3: конфиги идут в JSON). Своей
 * печати JSON у редактора нет и не будет: выход редактора обязан быть теми же
 * байтами, которые пишет и читает ядро (ED-3), а вторая реализация формата
 * разошлась бы с первой молча (ED-1).
 *
 * Ключи здесь не сортируются, и это не упущение. SER-6 — правило о порядке
 * ключей в plain-форме, которую строит ядро; документ редактора строит не ядро,
 * а автор, и ED-21 требует обратного: правка одного значения меняет только
 * связанные с ней строки. Перестановка ключей при сохранении дала бы дифф на
 * весь файл. По той же причине не сортируются и элементы списков — SER-8
 * называет порядок записей расстановки нормативным, потому что он задаёт
 * выданные ID.
 */
import { prettyJsonSerializer } from '@fluxus/core';
import type { JsonValue } from '../document/json.js';

/** Байты документа в канонической форме. */
export function encodeDocument(value: JsonValue): Uint8Array {
  return prettyJsonSerializer.encode(value);
}

/** Разбор прочитанного. Ошибка разбора — брошенное исключение с путём называет вызывающий. */
export function decodeDocument(bytes: ArrayBuffer | Uint8Array): JsonValue {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return prettyJsonSerializer.decode(view) as JsonValue;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Совпадают ли байты файла с канонической формой его же содержимого. Ответ
 * «нет» означает, что документ писал не редактор: файл, набранный руками,
 * канонической формы не обязан иметь, и первое сохранение его переформатирует.
 * Требование ED-21 о пустом диффе говорит именно о документе, «записанном
 * редактором», — знать, в этом ли состоянии файл, обязан интерфейс, иначе автор
 * получит большой дифф без объяснения.
 */
export function isCanonicalDocument(bytes: ArrayBuffer | Uint8Array): boolean {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return sameBytes(view, encodeDocument(decodeDocument(view)));
}

/** Каноническая форма прочитанных байтов — разбор и обратная печать одним шагом. */
export function canonicalizeDocument(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return encodeDocument(decodeDocument(bytes));
}
