/**
 * Перечитывание документов, изменившихся в дереве контента извне (ED-12), и
 * переподача их кадру существующими каналами.
 *
 * ## Зачем это здесь
 *
 * Конвейер Blender пишет производный пространственный слой сцены командой
 * импорта (`blender-pipeline` BLND-2), а не редактором, и цикл hot-reload
 * BLND-12 требует, чтобы открытый кадр показал правку без перезапуска. Канал
 * «документы изменились» у среды уже есть и заводился не ради Blender: за
 * деревом смотрит dev-сервер (`contentEndpoint.ts`), вкладка узнаёт об этом
 * сокетом, а веб-хост объявляет это наблюдателям шва (`src/host/web.ts`, ED-12).
 * Второго канала — своего сокета у watch-процесса — поэтому не заводится
 * (design, решение 12): инструмент авторинга пишет файл, а «файл изменился»
 * рассказывает тот, у кого дерево есть.
 *
 * Чего у канала не было — потребителя. Этот модуль и есть недостающее звено:
 * он перечитывает изменившийся документ В СЕССИЮ, а дальше работают те же
 * каналы, которыми едет всякая правка редактора, — область сцены пересчитывает
 * кадр на событие сессии и переподаёт его вьюпорту (`rendering` REND-11,
 * REND-14, REND-17, REND-18, `camera` CAM-7). Своей подачи рендеру здесь нет
 * ни строки: она была бы вторым путём к кадру.
 *
 * ## Чего он НЕ делает и почему
 *
 * Перечитывание — это подмена значения документа целиком, то есть потеря
 * всего, что автор в нём сделал в этой сессии. Поэтому три случая честно
 * остаются нетронутыми, и каждый называет причину, а не молчит:
 *
 * - **`dirty`** — в документе есть несохранённые правки. Подхватить чужую
 *   версию значило бы стереть работу автора без единого следа; ED-21 требует
 *   обратного отношения к несохранённому.
 * - **`history`** — документ упомянут в истории операций (ED-18). Сессия сама
 *   запрещает закрывать такой документ, и запрет этот по существу: undo после
 *   подмены привёл бы остальные документы в состояние, которого вместе с
 *   подменённым не было ни разу.
 * - **`busy`** — идёт незакрытое взаимодействие (мазок кисти, перетаскивание).
 *
 * Расхождение документов с источником при этом не пропадает и не остаётся
 * незамеченным: его подсвечивает правило синхронизации `blender.spatialLayerSync`
 * на общих основаниях (BLND-2, ED-8) — предупреждением с адресом, а не тихой
 * перезаписью.
 *
 * Совпавший байт-в-байт документ не перечитывается вовсе: собственная запись
 * редактора возвращается тем же каналом (`web.ts` объявляет и свои записи), и
 * подмена значения на равное ему пересоздала бы дескрипторы записей, то есть
 * все инстансы кадра — ровно то мигание, которого REND-11 и REND-17 требуют
 * избегать.
 */
import {
  encodeDocument,
  readDocument,
  type ContentTreeHost,
  type DocumentId,
  type EditorSession,
} from '@fluxus/editor-core';

/** Почему документ остался прежним, хотя в дереве он изменился. */
export type RefreshKeptReason = 'dirty' | 'history' | 'busy';

export type RefreshOutcome =
  /** Значение документа заменено прочитанным из дерева; кадр пересчитается сам. */
  | { readonly kind: 'reloaded'; readonly id: DocumentId }
  /** Читать было нечего: документ не открыт или его байты совпали с текущими. */
  | { readonly kind: 'unchanged'; readonly id: DocumentId }
  /** Документ намеренно оставлен прежним — см. шапку модуля. */
  | { readonly kind: 'kept'; readonly id: DocumentId; readonly reason: RefreshKeptReason }
  /** Прочитать не удалось: файл исчез, не разбирается, среда отказала. */
  | { readonly kind: 'failed'; readonly id: DocumentId; readonly reason: string };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

/**
 * Перечитывает один открытый документ из дерева. Не бросает: внешнее изменение
 * — не отказ операции автора, и уронить им редактор нельзя.
 *
 * Подмена значения — это `closeDocument` + `openDocument` с прежними видом и
 * списками: третьего способа поменять значение документа целиком у сессии нет
 * и заводиться не должен (ED-29 — правка идёт слоем операций, а это не правка,
 * а другой документ на том же месте). Между закрытием и открытием нет ни
 * одного `await`: подписчик сессии, увидевший «закрыт», обязан дождаться
 * «открыт» в том же кадре, а не рисовать по половине проекта.
 */
export async function refreshDocument(
  session: EditorSession,
  host: ContentTreeHost,
  id: DocumentId,
): Promise<RefreshOutcome> {
  // Документ не открыт — значит, это не документ проекта, а сосед по дереву:
  // модели и текстуры обновляет модуль ассетов своим наблюдением (ASSET-4).
  if (!session.isOpen(id)) return { kind: 'unchanged', id };

  let value;
  try {
    value = (await readDocument(host, id)).value;
  } catch (error) {
    return { kind: 'failed', id, reason: message(error) };
  }
  // За время чтения документ мог закрыться (переоткрытие проекта, ED-24).
  if (!session.isOpen(id)) return { kind: 'unchanged', id };

  const open = session.document(id);
  if (sameBytes(encodeDocument(open.value), encodeDocument(value))) {
    return { kind: 'unchanged', id };
  }
  if (open.dirty) return { kind: 'kept', id, reason: 'dirty' };
  if (session.pending) return { kind: 'kept', id, reason: 'busy' };

  const lists = [...open.lists];
  try {
    session.closeDocument(id);
  } catch {
    // Единственная причина, по которой закрытие отказывает у чистого документа
    // вне взаимодействия, — упоминание в истории операций (ED-18).
    return { kind: 'kept', id, reason: 'history' };
  }
  session.openDocument(
    lists.length === 0
      ? { id, kind: open.kind, value }
      : { id, kind: open.kind, value, lists },
  );
  return { kind: 'reloaded', id };
}

export interface ExternalRefreshOptions {
  readonly session: EditorSession;
  readonly host: ContentTreeHost;
  /** Чем кончилось перечитывание. Показывать ли это автору — дело сборки (ED-27). */
  readonly report?: (outcome: RefreshOutcome) => void;
}

/**
 * Подписка на изменения дерева извне (ED-12). Возвращает отписку.
 *
 * Удаление файла документа не перечитывается: открытый документ остаётся тем,
 * что видит автор, — иначе исчезнувший на секунду файл (перезапись через
 * временный файл — обычная практика писателей) очищал бы кадр.
 */
export function watchExternalDocuments(options: ExternalRefreshOptions): () => void {
  const { session, host, report } = options;
  return host.watch((change) => {
    if (change.kind === 'removed') return;
    void refreshDocument(session, host, change.path).then((outcome) => {
      report?.(outcome);
    });
  });
}
