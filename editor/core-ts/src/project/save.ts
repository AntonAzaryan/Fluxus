/**
 * Канонический round-trip сохранения (ED-21).
 *
 * Что здесь выполняется и чем:
 *
 * - **«Открыл — сохранил» без правок не пишет ничего.** Сохранение берёт ровно
 *   те документы, у которых сессия видит несохранённые правки
 *   (`dirtyDocumentIds`), и «сохранить всё» на нетронутом проекте не касается
 *   диска вовсе. Пустой дифф получается не совпадением байтов, а отсутствием
 *   записи.
 * - **Правка одного значения меняет только связанные строки.** Байты производит
 *   сериализатор ядра (`canonical.ts`), а документ — то же JSON-значение, что
 *   было прочитано, с заменённым местом: слой документа копирует хребет до
 *   правки и сохраняет порядок ключей. Ни переупорядочивания, ни нормализации
 *   чисел по дороге не происходит.
 * - **Порядок записей списков переживает сохранение.** Здесь для этого не
 *   делается ничего — и это то самое «ничего», которого требуют ED-21 и SER-8:
 *   сортировка расстановки переставила бы выданные ID, то есть изменила бы
 *   `worldInit` документа, который автор в остальном не правил.
 * - **Согласованность групп.** Перед записью считается состояние дерева «после
 *   сохранения» и сверяется с состоянием «до»: сохранение отвергается, если
 *   вносит расхождение, и не отвергается из-за расхождения, которое уже лежит на
 *   диске (его дело — валидация, ED-8). Плюс правило, не зависящее от формата
 *   документов: правки членов одной группы уходят на диск одной записью.
 *
 * Атомарности записи файлов здесь нет и быть не может: у веба нет транзакции над
 * деревом. Поэтому порядок такой — сначала полная проверка, потом запись;
 * сорванная посреди записи среда оставит частично записанный проект, и это
 * свойство среды, а не выбор редактора.
 */
import type { EditorSession } from '../document/session.js';
import type { JsonValue } from '../document/json.js';
import type { DocumentId } from '../document/types.js';
import type { ContentTreeHost } from '../host/index.js';
import { decodeDocument, encodeDocument } from './canonical.js';
import {
  issueKey,
  type ConsistencyIssue,
  type ConsistencyRule,
  type DocumentGroup,
  type ProjectView,
} from './consistency.js';

export const GROUP_WRITE_RULE_ID = 'save.group.writeTogether';

/** Расхождение с признаком «вносится этим сохранением». Блокирует только внесённое. */
export interface SaveIssue extends ConsistencyIssue {
  readonly blocking: boolean;
}

export interface SaveRequest {
  readonly session: EditorSession;
  readonly host: ContentTreeHost;
  /**
   * Что сохранять. По умолчанию — все документы с правками. Названные без
   * правок в запись не попадают: ED-21 требует, чтобы сохранение затрагивало
   * только документы, в которых есть правки.
   */
  readonly documentIds?: readonly DocumentId[];
  /** Группы документов, чьи правки обязаны уйти на диск одной записью. */
  readonly groups?: readonly DocumentGroup[];
  /** Правила согласованности состояния на диске. */
  readonly rules?: readonly ConsistencyRule[];
}

export interface SaveResult {
  /**
   * Отказ: сохранение внесло бы расхождение (ED-21) и не записало ничего.
   * Отличается от «записывать было нечего» — там `refused` ложно, а `written`
   * пуст.
   */
  readonly refused: boolean;
  readonly written: readonly DocumentId[];
  /** Названные к сохранению, но без правок. */
  readonly unchanged: readonly DocumentId[];
  readonly issues: readonly SaveIssue[];
}

/** Взгляд на дерево по карте «документ → значение»; отсутствующий документ — `undefined`. */
function viewOf(values: ReadonlyMap<DocumentId, JsonValue>): ProjectView {
  return {
    documentIds: [...values.keys()],
    value: (id) => values.get(id),
  };
}

function runRules(rules: readonly ConsistencyRule[], view: ProjectView): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  for (const rule of rules) issues.push(...rule.check(view));
  return issues;
}

/**
 * Состояние документа на диске. Открытый и не записываемый этим сохранением
 * документ берётся именно с диска, а не из сессии: на диске после сохранения
 * останется он, а не то, что автор набрал и не сохранил.
 */
async function onDiskValue(host: ContentTreeHost, id: DocumentId): Promise<JsonValue | undefined> {
  try {
    return decodeDocument(await host.read(id));
  } catch {
    // Отсутствующий или неразбираемый файл — это «на диске такого документа
    // нет». Правило увидит `undefined` и назовёт расхождение само, если оно из
    // этого следует; решать за правило здесь нечего.
    return undefined;
  }
}

export async function saveDocuments(request: SaveRequest): Promise<SaveResult> {
  const { session, host } = request;
  const groups = request.groups ?? [];
  const rules = request.rules ?? [];

  const dirty = new Set(session.dirtyDocumentIds());
  const requested = request.documentIds;
  const unchanged = requested === undefined ? [] : requested.filter((id) => !dirty.has(id));
  const writeSet = new Set(requested === undefined ? [...dirty] : requested.filter((id) => dirty.has(id)));

  // Порядок записи — порядок открытия документов в сессии: детерминированный и
  // не зависящий от того, в каком порядке вызывающий перечислил документы.
  const order = session.documentIds().filter((id) => writeSet.has(id));

  const issues: SaveIssue[] = [];

  // Правило, не зависящее от формата документов: правки членов одной группы
  // уходят на диск вместе. Именно оно распространяется на документ, чей формат
  // ещё не нормирован.
  for (const group of groups) {
    const dirtyMembers = group.members.filter((id) => dirty.has(id));
    const left = dirtyMembers.filter((id) => !writeSet.has(id));
    if (left.length === 0) continue;
    if (!group.members.some((id) => writeSet.has(id))) continue;
    for (const id of left) {
      issues.push({
        ruleId: GROUP_WRITE_RULE_ID,
        messageKey: 'save.issue.groupMemberLeftUnsaved',
        documentId: id,
        detail: { group: group.id },
        blocking: true,
      });
    }
  }

  if (rules.length > 0) {
    const touched = new Set<DocumentId>();
    for (const group of groups) for (const id of group.members) touched.add(id);
    for (const id of writeSet) touched.add(id);

    const before = new Map<DocumentId, JsonValue>();
    const after = new Map<DocumentId, JsonValue>();
    for (const id of touched) {
      const disk = await onDiskValue(host, id);
      if (disk !== undefined) before.set(id, disk);
      const next = writeSet.has(id) ? session.documentValue(id) : disk;
      if (next !== undefined) after.set(id, next);
    }

    const known = new Set(runRules(rules, viewOf(before)).map(issueKey));
    for (const issue of runRules(rules, viewOf(after))) {
      // Внесённое этим сохранением блокирует запись (ED-21); лежавшее на диске
      // до него — предмет валидации (ED-8), а не повод не дать сохранить.
      issues.push({ ...issue, blocking: !known.has(issueKey(issue)) });
    }
  }

  if (issues.some((issue) => issue.blocking)) {
    return { refused: true, written: [], unchanged, issues };
  }

  const written: DocumentId[] = [];
  for (const id of order) {
    await host.write(id, encodeDocument(session.documentValue(id)));
    session.markSaved(id);
    written.push(id);
  }

  return { refused: false, written, unchanged, issues };
}
