/**
 * Открытие документов проекта через хост среды (ED-12). Один шаг: прочитать
 * байты, разобрать, отдать сессии. Отдельный модуль он потому, что это ровно то
 * место, где сходятся два шва — хост и сессия, — и обходить его чтением файла
 * напрямую как раз и запрещено ED-12.
 *
 * Вид документа и пути отслеживаемых списков приносит вызывающий, а не этот
 * модуль: `initial` — доменное знание конфига сцены (SER-7, SER-8), а каркас
 * доменных имён не содержит (ED-25).
 */
import type { EditorSession } from '../document/session.js';
import type { JsonPath, JsonValue } from '../document/json.js';
import type { DocumentId, DocumentKind, EditorDocument } from '../document/types.js';
import type { ContentPath, ContentTreeHost } from '../host/index.js';
import { decodeDocument, isCanonicalDocument } from './canonical.js';

export interface OpenFromHostInput {
  /** Путь документа от корня дерева контента — он же его `DocumentId`. */
  readonly id: DocumentId;
  readonly kind: DocumentKind;
  readonly lists?: readonly JsonPath[];
}

/** Прочитанный документ до открытия: значение и признак канонической формы файла. */
export interface ReadDocument {
  readonly path: ContentPath;
  readonly value: JsonValue;
  /** `false` — файл писал не редактор; первое сохранение переформатирует его (ED-21). */
  readonly canonical: boolean;
}

export async function readDocument(host: ContentTreeHost, path: ContentPath): Promise<ReadDocument> {
  const bytes = new Uint8Array(await host.read(path));
  let value: JsonValue;
  try {
    value = decodeDocument(bytes);
  } catch (error) {
    throw new Error(
      `документ "${path}" не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path, value, canonical: isCanonicalDocument(bytes) };
}

export async function openDocumentFromHost(
  session: EditorSession,
  host: ContentTreeHost,
  input: OpenFromHostInput,
): Promise<EditorDocument> {
  const read = await readDocument(host, input.id);
  return session.openDocument(
    input.lists === undefined
      ? { id: input.id, kind: input.kind, value: read.value }
      : { id: input.id, kind: input.kind, value: read.value, lists: input.lists },
  );
}
