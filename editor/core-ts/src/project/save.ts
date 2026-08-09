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
 * - **Согласованность на диске.** Проверяется теми же правилами-вкладами
 *   (ED-25), которыми валидация подсвечивает нарушения при правке: сохранение
 *   не заводит своих правил и своей формы находки — второе описание того же
 *   запрещает ED-30. Прогон идёт по состоянию дерева «после записи» и
 *   сравнивается с прогоном по состоянию «до»; запись отвергает только то, что
 *   вносит само сохранение.
 *
 * ## Две фазы и их разница
 *
 * Правило, отвергающее запись, и правило, красящее маркер, — одно и то же
 * правило; различают их две вещи, обе внутри одного словаря валидации:
 *
 * 1. **Важность.** Запись отвергают только находки важности `error` — то, что
 *    ядро или загрузчик отвергнут. Предупреждение (несовпадение сетки кривизны,
 *    ASSET-7) остаётся видимым состоянием и сохранять не мешает.
 * 2. **Внесено ли оно этой записью.** ED-21 запрещает записать
 *    рассинхронизацию, но не делает редактор строже нормы там, где расхождение
 *    уже лежит на диске: его дело — валидация (ED-8). Отсюда сравнение двух
 *    прогонов по ключу тождества находки (`issueKey`).
 *
 * Правило записи (`GROUP_WRITE_RULE_ID`) — того же вида вклад, но судит оно не
 * дерево, а само сохранение: члены группы с правками обязаны уйти на диск одной
 * записью. Состояния «до» у ещё не сделанной записи не бывает, поэтому
 * сравнение двух прогонов к нему не применяется — и это не исключение из
 * правила, а следствие того, что у этой фазы другой предмет.
 *
 * Какие правила сохранение вправе применить — выбор собирающего редактор, а не
 * этого файла: он передаёт реестр (`rules`), и это тот же реестр, из которого
 * работает валидатор реального времени.
 *
 * Атомарности записи файлов здесь нет и быть не может: у веба нет транзакции над
 * деревом. Поэтому порядок такой — сначала полная проверка, потом запись;
 * сорванная посреди записи среда оставит частично записанный проект, и это
 * свойство среды, а не выбор редактора.
 */
import type { DocumentId, DocumentKind, EditorDocument, EditorSession, JsonValue } from '../document/index.js';
import type { ContentTreeHost } from '../host/index.js';
import { compareIds, type ContributionReader } from '../registry/index.js';
import {
  compareIssues,
  createReport,
  createValidator,
  issueKey,
  ruleDescriptionKey,
  type RuleReasons,
  type ValidationIssue,
  type ValidationReport,
  type ValidationRule,
  type ValidationSource,
} from '../validation/index.js';
import { decodeDocument, encodeDocument } from './canonical.js';

export const GROUP_WRITE_RULE_ID = 'save.group.writeTogether';

/** Код причины единственной находки правила записи. */
const MEMBER_LEFT_UNSAVED = 'memberLeftUnsaved';

/**
 * Правило записи глазами слоя ресурсов (ED-28): id и коды причин без `check`.
 *
 * Само правило строится по составу сохранения и до него не существует, а строки
 * его причин обязаны лежать в бандле всегда — иначе автор увидел бы на отказе
 * сохранения голый ключ. Поэтому объявление отделено от построения, и гейт
 * бандла считает ключи по нему, а не по правилу, которого ещё нет.
 */
export const GROUP_WRITE_REASONS: RuleReasons = Object.freeze({
  id: GROUP_WRITE_RULE_ID,
  reasonCodes: Object.freeze([MEMBER_LEFT_UNSAVED]),
});

/**
 * Документы, чьи правки обязаны уходить на диск одной записью. Понятие
 * каркасное и от формата документов группы не зависит вовсе: тройка ED-19
 * («конфиг сцены + парный presentation-документ + манифест») выражается им без
 * единого доменного имени здесь.
 */
export interface DocumentGroup {
  readonly id: string;
  readonly members: readonly DocumentId[];
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
  /**
   * Реестр правил-вкладов (ED-25), которыми проверяется состояние дерева после
   * записи. Тот же, из которого работает валидатор реального времени: правило
   * пишется один раз и применяется в обеих фазах.
   */
  readonly rules?: ContributionReader<ValidationRule>;
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
  /**
   * Всё найденное по состоянию дерева после записи — отчётом, а не списком:
   * тот же адресуемый результат, что у валидации реального времени (ED-30), и
   * интерфейсу после отказа есть чем расставить маркеры (ED-22).
   */
  readonly report: ValidationReport;
  /** Подмножество, которое вносит это сохранение и которым оно отвергнуто. */
  readonly blocking: readonly ValidationIssue[];
}

/**
 * Правило фазы записи: член группы, чьи правки это сохранение оставило бы на
 * потом. Строится по самому сохранению, а не регистрируется заранее: его вход —
 * состав записи, а не состояние документов.
 *
 * Находка стоит на самом оставленном документе — поэтому правило применимо к
 * видам ровно этих документов и каждый из них проходит через него один раз.
 */
function groupWriteRule(
  left: ReadonlyMap<DocumentId, DocumentGroup>,
  kinds: readonly DocumentKind[],
): ValidationRule {
  return {
    id: GROUP_WRITE_RULE_ID,
    descriptionKey: ruleDescriptionKey(GROUP_WRITE_RULE_ID),
    reasonCodes: GROUP_WRITE_REASONS.reasonCodes,
    appliesTo: kinds,
    check(run) {
      const group = left.get(run.document.id);
      if (group === undefined) return;
      run.report({
        path: [],
        expected: { kind: 'together', members: group.members },
        code: MEMBER_LEFT_UNSAVED,
        params: { group: group.id },
      });
    },
  };
}

/** Правила прогона, не заводя реестра: сохранение никого не регистрирует. */
function readerOf(rules: readonly ValidationRule[]): ContributionReader<ValidationRule> {
  const byId = new Map(rules.map((rule) => [rule.id, rule] as const));
  const all = Object.freeze([...byId.values()].sort((a, b) => compareIds(a.id, b.id)));
  return { get: (id) => byId.get(id), has: (id) => byId.has(id), all: () => all };
}

function sourceOf(documents: readonly EditorDocument[]): ValidationSource {
  const byId = new Map(documents.map((document) => [document.id, document] as const));
  const ids = Object.freeze([...byId.keys()]);
  return {
    documentIds: () => ids,
    document(id) {
      const found = byId.get(id);
      if (found === undefined) throw new Error(`документ "${id}" источнику прогона неизвестен`);
      return found;
    },
  };
}

/**
 * Документ в состоянии дерева, а не сессии: значение приходит с диска, признак
 * несохранённых правок к состоянию диска не относится и потому снят.
 */
function asTreeState(document: EditorDocument, value: JsonValue): EditorDocument {
  return { ...document, value, dirty: false };
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
    // нет». Правило увидит его отсутствие и назовёт расхождение само, если оно
    // из этого следует; решать за правило здесь нечего.
    return undefined;
  }
}

export async function saveDocuments(request: SaveRequest): Promise<SaveResult> {
  const { session, host } = request;
  const groups = request.groups ?? [];
  const rules = request.rules;

  const dirty = new Set(session.dirtyDocumentIds());
  const requested = request.documentIds;
  const unchanged = requested === undefined ? [] : requested.filter((id) => !dirty.has(id));
  const writeSet = new Set(requested === undefined ? [...dirty] : requested.filter((id) => dirty.has(id)));

  // Порядок записи — порядок открытия документов в сессии: детерминированный и
  // не зависящий от того, в каком порядке вызывающий перечислил документы.
  const order = session.documentIds().filter((id) => writeSet.has(id));

  const found: ValidationIssue[] = [];
  const blocking: ValidationIssue[] = [];

  // Фаза записи: члены группы с правками, оставленные несохранёнными. Документ
  // с правками сессией открыт по определению, поэтому вид у него есть.
  const left = new Map<DocumentId, DocumentGroup>();
  for (const group of groups) {
    if (!group.members.some((id) => writeSet.has(id))) continue;
    for (const id of group.members) if (dirty.has(id) && !writeSet.has(id)) left.set(id, group);
  }
  if (left.size > 0) {
    const documents = [...left.keys()].map((id) => session.document(id));
    const kinds = [...new Set(documents.map((document) => document.kind))].sort(compareIds);
    const rule = groupWriteRule(left, kinds);
    for (const issue of createValidator({ rules: readerOf([rule]) }).run(sourceOf(documents)).issues) {
      found.push(issue);
      if (issue.severity === 'error') blocking.push(issue);
    }
  }

  // Фаза дерева: те же правила по состоянию «после записи» против состояния
  // «до неё».
  if (rules !== undefined) {
    const touched = new Set<DocumentId>();
    for (const group of groups) for (const id of group.members) touched.add(id);
    for (const id of writeSet) touched.add(id);

    const before: EditorDocument[] = [];
    const after: EditorDocument[] = [];
    for (const id of touched) {
      // Вид документа приносит тот, кто его открывает (ED-25), и по файлу он не
      // выводится: неоткрытому документу правило сопоставить не с чем.
      if (!session.isOpen(id)) continue;
      const document = session.document(id);
      const disk = await onDiskValue(host, id);
      if (disk !== undefined) before.push(asTreeState(document, disk));
      const next = writeSet.has(id) ? document.value : disk;
      if (next !== undefined) after.push(asTreeState(document, next));
    }

    // Один валидатор на оба прогона: документ, которого запись не касается,
    // приходит в оба одним и тем же значением, и правила о нём исполняются
    // однажды. Валидатор свой, а не тот, что держит редактор: его кэш —
    // состояние сессии, и подмешивать в него состояние диска нельзя (ED-8).
    const validator = createValidator({ rules });
    const known = new Set(validator.run(sourceOf(before)).issues.map(issueKey));
    for (const issue of validator.run(sourceOf(after)).issues) {
      found.push(issue);
      // Внесённое этим сохранением отвергает запись (ED-21); лежавшее на диске
      // до него — предмет валидации (ED-8), а не повод не дать сохранить.
      if (issue.severity === 'error' && !known.has(issueKey(issue))) blocking.push(issue);
    }
  }

  const report = createReport(found);
  if (blocking.length > 0) {
    return {
      refused: true,
      written: [],
      unchanged,
      report,
      blocking: Object.freeze([...blocking].sort(compareIssues)),
    };
  }

  const written: DocumentId[] = [];
  for (const id of order) {
    await host.write(id, encodeDocument(session.documentValue(id)));
    session.markSaved(id);
    written.push(id);
  }

  return { refused: false, written, unchanged, report, blocking: Object.freeze([]) };
}
