/**
 * Журнал боя (DIAG-10) — производная проекция трейса: читаемая
 * последовательность боевых фактов прогона сценария (CLI-7) или матча (DIAG-8).
 *
 * Вход — сохранённый ФАЙЛ трейса, и только он. Второго пути извлечения фактов
 * (наблюдателя над отчётом о тике, OBS-2) здесь нет намеренно: у наблюдателя
 * нет ни сквозного порядка `seq`, ни авторства системы (DIAG-2, DIAG-5), и
 * вторая выборка тех же фактов расходилась бы с первой молча. Разбор по файлу
 * вдобавок работает там, где прогона уже нет, — на трейсе, приехавшем с чужой
 * машины.
 *
 * Игровых событий этот модуль не знает НИ ОДНОГО: что считать попаданием, а что
 * смертью, говорит словарь-документ (DIAG-10). Отсюда и место словаря — сборка
 * игры, а не константы инструмента: новый эффект добавляется строкой документа,
 * а не правкой кода.
 *
 * Из `src/index.ts` модуль не экспортируется (CLI-8): отладочный инструмент в
 * публичной поверхности ядра не нужен — `bin/journal.mjs` импортирует его
 * напрямую, ровно как `bin/sim.mjs` импортирует `scenario.ts`. Зависимостей у
 * модуля ноль (CORE-1), из платформы не используется ничего.
 */
import { canonicalJson } from './canonicalJson.js';
import type { DiagnosticRecord } from '../types.js';

/**
 * Служебные семантические коды инструмента. Знак `$` отделяет их от кодов
 * словаря — набор кодов принадлежит игре (DIAG-10), и столкнуться с ней
 * инструмент не вправе. Тот же приём, что у служебных событий контента
 * (`$rewind/request`).
 */
export const JOURNAL_UNKNOWN = '$unknown';
export const JOURNAL_INVARIANT = '$invariant';
export const JOURNAL_ASSERT = '$assert';

/**
 * Имя параметра, под которым в журнал уезжает свободный текст записи (DIAG-2).
 * Со знаком `$` по той же причине, что и коды выше: `data` записи — скаляры
 * прогона, и поле `message` в них законно. Без разделения текст инструмента
 * затирал бы значение прогона — то есть терял бы данные ровно там, где журнал
 * обязан их сохранять («молча потерянное поле хуже лишнего»).
 */
export const JOURNAL_MESSAGE = '$message';

/**
 * Семантика одного типа события: код факта и роли. Роль — ИМЯ ПОЛЯ события,
 * а не значение: журнал ничего не додумывает, и событие, не назвавшее источник
 * урона, даёт запись без актора (DIAG-10).
 */
export interface JournalEventSemantics {
  /** Семантический код факта — политика игры, инструменту неизвестная. */
  readonly kind: string;
  /** Поле события, которое является актором. */
  readonly actor?: string;
  /** Поле события, которое является целью. */
  readonly target?: string;
}

/** Словарь журнала — документ игры (DIAG-10), а не константы инструмента. */
export interface JournalDictionary {
  readonly events: Readonly<Record<string, JournalEventSemantics>>;
}

/**
 * Запись журнала. Машинная форма первична (DIAG-10): одна запись — одна
 * самостоятельная строка, значения полей события идут как есть, целыми Q16.16
 * (FP-1). Пересчёт в десятичную дробь — дело человеческой формы: здесь он
 * потерял бы точность и завёл вопрос о правилах округления там, где вопроса нет.
 */
export interface JournalEntry {
  readonly tick: number;
  /** Порядок внутри тика — сквозной номер записи трейса (DIAG-2). */
  readonly seq: number;
  /** Семантический код факта: из словаря либо служебный. */
  readonly kind: string;
  /** Тип события либо код записи диагностики (DIAG-2). */
  readonly type: string;
  /** Система, в границах которой возник факт (DIAG-2); вне систем отсутствует. */
  readonly system?: string;
  readonly actor?: number;
  readonly target?: number;
  /** Поля, не занятые ролями, целиком: молча потерянное поле хуже лишнего. */
  readonly params: Readonly<Record<string, number | string>>;
  /** Ветвь истории (DIAG-9); есть, только если трейс несёт отметки хоста. */
  readonly branch?: string;
}

export interface JournalResult {
  readonly entries: readonly JournalEntry[];
  /**
   * Типы событий, которых в словаре не нашлось (DIAG-10). Список называется
   * отчётом прогона, а не отказом: незнакомый тип означает, что словарь отстал
   * от контента, а не что бой не состоялся.
   */
  readonly unknownTypes: readonly string[];
  /**
   * Строки, которые не разобрались как JSON. Обрыв прогона жёсткой границей
   * (FP-4) оставляет усечённый хвост — читать из-за него нечего перестаёт
   * только он один (CLI-7).
   */
  readonly malformedLines: number;
}

/** Признак строки-отметки хоста (DIAG-9): у записи DIAG-2 такого поля нет. */
const MARK_FIELD = 'mark';

type MarkKind = 'live' | 'replayBegin' | 'replayEnd';

interface JournalMarkLine {
  readonly mark: MarkKind;
  readonly epoch: number;
  readonly tick: number;
}

/**
 * Разбор документа-словаря. Проверка, а не доверие: словарь правится руками, и
 * опечатка в имени роли иначе тихо превратилась бы в факт без цели.
 */
export function parseJournalDictionary(value: unknown, where: string): JournalDictionary {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${where}: словарь журнала — объект с полем "events"`);
  }
  const events = (value as { events?: unknown }).events;
  if (typeof events !== 'object' || events === null) {
    throw new Error(`${where}: у словаря журнала нет объекта "events"`);
  }
  const parsed: Record<string, JournalEventSemantics> = {};
  const table = events as Record<string, unknown>;
  // Ключи по алфавиту: словарь — вход чистой функции (DIAG-10), и порядок его
  // разбора не должен зависеть от порядка полей в файле.
  for (const type of Object.keys(table).sort()) {
    const raw = table[type];
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`${where}: семантика события "${type}" — объект`);
    }
    const semantics = raw as { kind?: unknown; actor?: unknown; target?: unknown };
    if (typeof semantics.kind !== 'string' || semantics.kind === '') {
      throw new Error(`${where}: у события "${type}" нет непустого "kind" — семантического кода факта`);
    }
    if (semantics.actor !== undefined && typeof semantics.actor !== 'string') {
      throw new Error(`${where}: роль "actor" события "${type}" — имя поля события, то есть строка`);
    }
    if (semantics.target !== undefined && typeof semantics.target !== 'string') {
      throw new Error(`${where}: роль "target" события "${type}" — имя поля события, то есть строка`);
    }
    parsed[type] = {
      kind: semantics.kind,
      ...(semantics.actor !== undefined ? { actor: semantics.actor } : {}),
      ...(semantics.target !== undefined ? { target: semantics.target } : {}),
    };
  }
  return { events: parsed };
}

/** Ветвь истории по последней встреченной отметке (DIAG-9). */
function branchOf(mark: JournalMarkLine): string {
  return mark.mark === 'replayBegin' ? `${mark.epoch}:replay` : `${mark.epoch}`;
}

function asMark(value: Record<string, unknown>): JournalMarkLine | undefined {
  const mark = value[MARK_FIELD];
  const epoch = value.epoch;
  const tick = value.tick;
  if (mark !== 'live' && mark !== 'replayBegin' && mark !== 'replayEnd') return undefined;
  if (typeof epoch !== 'number' || typeof tick !== 'number') return undefined;
  return { mark, epoch, tick };
}

/**
 * Запись диагностики → запись журнала. Факты журнала — события (DIAG-5) и
 * нарушенные инварианты (FP-4); границы систем, поток команд и сводка стоимости
 * боевыми фактами не являются и в журнал не идут.
 */
function entryOf(
  record: DiagnosticRecord,
  dictionary: JournalDictionary | undefined,
  branch: string | undefined,
  unknown: Set<string>,
): JournalEntry | undefined {
  const common = {
    tick: record.tick,
    seq: record.seq,
    ...(record.system !== undefined ? { system: record.system } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };

  // Нарушенные инварианты попадают в журнал БЕЗ словаря вовсе (DIAG-10): тот,
  // кто читает журнал боя, обязан увидеть дефект прогона там же, где видит
  // смерти и попадания, а не во втором файле.
  if (record.kind === 'invariant' || record.kind === 'assert') {
    return {
      ...common,
      kind: record.kind === 'invariant' ? JOURNAL_INVARIANT : JOURNAL_ASSERT,
      type: record.code,
      params: {
        ...(record.data ?? {}),
        // Текст свободен и частью API не является (DIAG-2), но локализует
        // дефект — поэтому он параметр, а не идентификатор факта. Имя со знаком
        // `$`: одноимённое поле `data` записи — данные прогона, и затирать их
        // текстом инструмента нельзя.
        ...(record.message !== undefined ? { [JOURNAL_MESSAGE]: record.message } : {}),
      },
    };
  }

  if (record.kind !== 'event') return undefined;

  const data = record.data ?? {};
  const type = data.type;
  // Тип события кладёт сама шина рядом с числовыми полями (`ecs/events.ts`).
  // Записи `event` без него не бывает; если она пришла — это чужой формат, и
  // додумывать за него нечего.
  if (typeof type !== 'string') return undefined;

  const semantics = dictionary?.events[type];
  if (semantics === undefined) unknown.add(type);

  const actorField = semantics?.actor;
  const targetField = semantics?.target;
  const actor = actorField === undefined ? undefined : data[actorField];
  const target = targetField === undefined ? undefined : data[targetField];

  const params: Record<string, number | string> = {};
  for (const key of Object.keys(data).sort()) {
    if (key === 'type') continue;
    // Поле, занятое ролью, из параметров уходит — но только если роль
    // действительно нашла значение: словарь, назвавший поле, которого в событии
    // нет, не должен ещё и терять то, что в событии есть.
    if (key === actorField && typeof actor === 'number') continue;
    if (key === targetField && typeof target === 'number') continue;
    params[key] = data[key]!;
  }

  return {
    ...common,
    kind: semantics?.kind ?? JOURNAL_UNKNOWN,
    type,
    ...(typeof actor === 'number' ? { actor } : {}),
    ...(typeof target === 'number' ? { target } : {}),
    params,
  };
}

/**
 * Сборка журнала из построчного трейса (DIAG-10). Чистая функция: один и тот
 * же файл даёт побитово один и тот же журнал.
 */
export function buildJournal(trace: string, dictionary?: JournalDictionary): JournalResult {
  const entries: JournalEntry[] = [];
  const unknown = new Set<string>();
  let malformedLines = 0;
  let branch: string | undefined;

  for (const line of trace.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Усечённый хвост оборванного прогона (CLI-7): читаемым перестаёт быть
      // он один, а не файл целиком.
      malformedLines++;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      malformedLines++;
      continue;
    }
    const value = parsed as Record<string, unknown>;
    // Отметка отличается от записи DIAG-2 по СОБСТВЕННОМУ полю-признаку, а не
    // по содержимому (DIAG-9): читателю не нужно разбирать её, чтобы понять,
    // что это не запись ядра.
    if (MARK_FIELD in value) {
      const mark = asMark(value);
      if (mark === undefined) malformedLines++;
      else branch = branchOf(mark);
      continue;
    }
    const entry = entryOf(value as unknown as DiagnosticRecord, dictionary, branch, unknown);
    if (entry !== undefined) entries.push(entry);
  }

  return { entries, unknownTypes: [...unknown].sort(), malformedLines };
}

/**
 * Машинная форма записи (DIAG-10): ключи каноническим порядком (SER-6), как у
 * строки трейса, — построчное сравнение двух сборок не должно зависеть от
 * порядка вставки полей.
 */
export function journalLine(entry: JournalEntry): string {
  return canonicalJson(entry);
}

export function journalJsonl(entries: readonly JournalEntry[]): string {
  let out = '';
  for (const entry of entries) out += `${journalLine(entry)}\n`;
  return out;
}

/** Колонки человеческой формы — те же поля, без шаблонов на естественном языке. */
const COLUMNS = ['tick', 'seq', 'branch', 'kind', 'type', 'actor', 'target', 'system'] as const;

function cell(entry: JournalEntry, column: (typeof COLUMNS)[number]): string {
  const value = entry[column];
  return value === undefined ? '-' : String(value);
}

function paramsCell(entry: JournalEntry): string {
  const parts: string[] = [];
  for (const key of Object.keys(entry.params).sort()) parts.push(`${key}=${String(entry.params[key])}`);
  return parts.join(' ');
}

/**
 * Человеческая форма (DIAG-10) — отображение тех же полей колонками. Текста на
 * естественном языке здесь нет: шаблон «{актор} ударил {цель} на {урон}»
 * пришлось бы переводить и держать в согласии со словарём, а идентификатором
 * факта он всё равно быть не может (DIAG-2) — им остаются семантический код и
 * тип события.
 */
export function journalText(entries: readonly JournalEntry[]): string {
  const rows: string[][] = [[...COLUMNS, 'params']];
  for (const entry of entries) rows.push([...COLUMNS.map((c) => cell(entry, c)), paramsCell(entry)]);
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i]!.length);
  }
  let out = '';
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < row.length; i++) {
      // Последняя колонка не добивается пробелами: хвост строки из пробелов
      // мешал бы построчному сравнению и никому не помогает.
      cells.push(i === row.length - 1 ? row[i]! : row[i]!.padEnd(widths[i]!));
    }
    out += `${cells.join('  ').trimEnd()}\n`;
  }
  return out;
}
