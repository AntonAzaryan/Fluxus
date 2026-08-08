/**
 * Что такое «редактируемое» для слоя операций. Ни одного доменного имени здесь
 * нет намеренно (ED-25): каркас знает документ, его вид и его значение, а что
 * такое террейн, префаб или манифест — знают вклады.
 */
import type { JsonPath, JsonValue } from './json.js';

/**
 * Идентификатор документа — путь от корня дерева контента, то есть ID ассета
 * (ASSET-2). Своей нумерации редактор не заводит: документ на диске уже назван,
 * и второе имя разъехалось бы с первым при первом же переименовании.
 */
export type DocumentId = string;

/**
 * Вид документа — строка вклада («scene», «terrain», …). Каркас её не
 * разбирает и по ней не ветвится: она нужна тем, кто регистрирует области,
 * инспекторы и правила валидации (ED-25).
 */
export type DocumentKind = string;

export interface EditorDocument {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  /** Заморожено вглубь: правка мимо слоя операций невозможна физически (ED-29). */
  readonly value: JsonValue;
  /** Есть ли правки, не дошедшие до диска (ED-21: сохранение трогает только их). */
  readonly dirty: boolean;
  /** Списки, записи которых адресуются сессионными дескрипторами. */
  readonly lists: readonly JsonPath[];
}

export interface OpenDocumentInput {
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  /** Значение как оно прочитано с диска. Сессия копирует его и замораживает копию. */
  readonly value: JsonValue;
  /**
   * Пути списков, записи которых получают сессионные дескрипторы: для конфига
   * сцены это `['initial']` (SER-7, SER-8). Список приносит открывающий, а не
   * каркас: имя `initial` — доменное знание (ED-25).
   */
  readonly lists?: readonly JsonPath[];
}

/** Тронутое место: документ и путь в нём. Из этого строится оповещение вьюпорта (ED-15). */
export interface DocumentPathRef {
  readonly documentId: DocumentId;
  readonly path: JsonPath;
}
