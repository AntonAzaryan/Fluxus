/* eslint-disable max-lines -- сессия — одна машина состояний: открытые документы,
   дескрипторы записей, транзакция операции, история и приостановка авторинга
   меняются в одном шаге и держат общие инварианты (ED-18, ED-29). Разложить её
   по модулям можно только опубликовав эти внутренности между ними — то есть
   заведя тот самый второй путь правки, которого здесь нет структурно. */
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
 *
 * Незакрытое взаимодействие оповещает о себе наравне с закрытым (ED-15):
 * каждое применение внутри него объявляется событием, отличным от события
 * записи в историю. Иначе гарантию «не позже следующего кадра» держал бы каждый
 * потребитель сам — сведением состояния на всякий случай перед отрисовкой, — а
 * инструмент, забывший так сделать, показывал бы результат перетаскивания
 * только по отпускании кнопки. Гарантия принадлежит слою, который правит
 * документ, а не тем, кто на него смотрит.
 *
 * По тем же основаниям здесь же живёт приостановка авторинга — «в превью
 * операции авторинга недоступны, превью MUST NOT записывать что-либо в
 * документы» (ED-9). Держать это одной недоступностью элементов интерфейса
 * (ED-26) значит держать запрет на слое, который не пишет: вызов
 * `applyOperation` мимо интерфейса — а ED-29 прямо требует, чтобы операции были
 * исполнимы без него, — прошёл бы в документы посреди прогона. Поэтому запрет
 * стоит там же, где стоит весь остальной запрет писать: в сессии. Интерфейсу
 * остаётся аффорданс (показать недоступным), а не правило.
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
  pathsEqual,
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
  AuthoringSuspendedError,
  OperationError,
  type AuthoringAction,
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
  /**
   * Продолжает то же взаимодействие: тот же `apply` с новыми параметрами.
   * Каждое применение, что-то изменившее, объявляется событием `extended`
   * (ED-15) — ждать закрытия взаимодействия, чтобы показать правку, незачем.
   */
  extend(params?: OperationParams): JsonValue | undefined;
  /** Закрывает взаимодействие одной записью истории; отдаёт результат последнего применения. */
  commit(): OperationOutcome;
  /** Возвращает документы к состоянию до `beginOperation`; в историю ничего не кладётся. */
  cancel(): void;
}

/**
 * Право снять взятую приостановку авторинга (ED-9) — и единственный способ её
 * снять. Метода «возобнови авторинг» у сессии нет намеренно: он был бы именем,
 * которым любой вызывающий отменяет чужой запрет. Назвать чужую приостановку
 * нечем — её значение получил тот, кто её взял, ровно как отписку от событий
 * получает подписавшийся.
 *
 * Приостановок может быть несколько сразу, и они не спорят: каждая — заявка
 * «пока я работаю, писать нельзя», а не владение режимом. Авторинг возвращается,
 * когда снята последняя. Отказывать второму заявителю значило бы, что чужой
 * прогон делает его работу невыполнимой, а ждать в headless-слое нечем.
 */
export interface AuthoringSuspension {
  /** Причина, названная при взятии; она же приходит в отказ. */
  readonly reason: string;
  /** Действует ли ещё именно эта приостановка. */
  readonly active: boolean;
  /** Снимает ровно эту приостановку; повторный вызов ничего не делает. */
  resume(): void;
}

export type SessionEventKind =
  | 'opened'
  | 'closed'
  | 'extended'
  | 'applied'
  | 'undone'
  | 'redone'
  | 'cancelled'
  | 'saved'
  | 'suspended'
  | 'resumed';

/**
 * Оповещение для вьюпорта и панелей (ED-15: изображение обновляется не позже
 * следующего кадра).
 *
 * Провизорное состояние отличается от записанного видом события, а не догадкой
 * потребителя: `extended` — применение внутри незакрытого взаимодействия,
 * которое `cancel` ещё отменит и которого в истории пока нет; `applied` —
 * взаимодействие закрыто и легло в историю одной записью (ED-18). Потребителю,
 * который только перерисовывает, различать их не нужно; тому, кто пишет
 * состояние рядом с документом (метка «сохраняется», отчёт валидации), —
 * нужно, и без вида события он выяснял бы это вторым способом.
 */
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
  /**
   * Приостанавливает авторинг (ED-9): применение операций, начало
   * взаимодействий, отмена и повтор отклоняются `AuthoringSuspendedError`, пока
   * приостановка действует. Причина обязательна и непуста — она и есть то, что
   * узнаёт получивший отказ.
   *
   * Незакрытое взаимодействие приостановки не переживает: оно отменяется здесь
   * же, документы возвращаются к состоянию до его начала, и подписчики узнают об
   * этом обычным `cancelled` (ED-15). Именно здесь, а не у того, кто
   * приостанавливает: «превью MUST NOT записывать что-либо в документы» не может
   * зависеть от того, вспомнил ли вызывающий про открытый мазок.
   *
   * Открытие, закрытие и отметка о сохранении под запрет не попадают: значений
   * документов они не меняют, а запрещена ED-9 именно запись в них. Полный
   * перечень покрытого объявлен каталогом (ED-30).
   */
  suspendAuthoring(reason: string): AuthoringSuspension;
  /** Приостановлен ли авторинг сейчас — тот же вопрос, на который отвечает отказ. */
  readonly authoringSuspended: boolean;
  /**
   * Причины действующих приостановок, в порядке взятия. Читается без попытки
   * что-нибудь написать: внешний потребитель (ED-29, ED-30) вправе узнать
   * состояние, а не выяснять его отказом.
   */
  suspensionReasons(): readonly string[];
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
  // Множество, а не флаг: приостановок бывает несколько сразу, и снимает каждую
  // тот, кто её взял. Порядок вставки сохраняется — причины называются в том
  // порядке, в каком приостановки брались.
  const suspensions = new Set<{ readonly reason: string }>();
  let transaction: Transaction | undefined;

  const reasons = (): readonly string[] => [...suspensions].map((suspension) => suspension.reason);

  /**
   * Единственная точка отказа: всякий вход, меняющий значение документа,
   * проходит через неё. Одна — чтобы «что именно запрещено в приостановке»
   * читалось в одном месте, а не собиралось из четырёх похожих условий.
   */
  const refuseWhenSuspended = (action: AuthoringAction, operationId: string): void => {
    if (suspensions.size === 0) return;
    throw new AuthoringSuspendedError(action, operationId, reasons());
  };

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
    /**
     * Места, тронутые текущим применением, — из них собирается оповещение об
     * открытом взаимодействии. Отдельно от накопленного перечня взаимодействия
     * потому, что накопленный дедуплицирован: место, тронутое повторно
     * (перетаскивание правит одно и то же поле десять раз), в нём уже есть, и
     * событие о втором касании назвало бы пустой перечень — потребитель,
     * читающий именно места, не узнал бы о правке (ED-15).
     */
    readonly #step: DocumentPathRef[] = [];
    readonly #stepSeen = new Set<string>();
    #params: JsonValue = null;
    #result: JsonValue | undefined;
    #open = true;
    /** Закрыто приостановкой авторинга, а не тем, кто взаимодействие вёл (ED-9). */
    #abandoned = false;

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
      // Копия, а не сама ссылка: путь приходит из параметров операции, то есть
      // из чужих рук, и вызывающий, дописавший в свой массив шаг после вызова,
      // переписал бы задним числом запись истории о том, что было тронуто.
      const taken = Object.freeze([...path]);
      if (!pending.seen.has(key)) {
        pending.seen.add(key);
        pending.paths.push(taken);
      }
      // Ключ шага — документ и место: разделителем взят управляющий символ,
      // потому что ID документа — путь в дереве контента (ASSET-2), и обычный
      // разделитель мог бы встретиться в нём самом.
      const stepKey = `${pending.record.id}\u0000${key}`;
      if (this.#stepSeen.has(stepKey)) return;
      this.#stepSeen.add(stepKey);
      this.#step.push({ documentId: pending.record.id, path: taken });
    }

    run(params: OperationParams, announce: boolean): JsonValue | undefined {
      checkParams(this.#operation, params);
      this.#step.length = 0;
      this.#stepSeen.clear();
      // Одно применение — всё или ничего. Упавшая посередине операция иначе
      // оставила бы документ в состоянии, которого не производит ни одна
      // операция целиком, и `commit` записал бы это состояние в историю: undo
      // и redo водили бы по нему как по достижимому (ED-18).
      const undoRun = this.#snapshotOpen();
      const ctx = new Context(this);
      try {
        // Результат последнего применения — результат взаимодействия: мазок
        // отдаёт то, чем он кончился, а не то, чем начался.
        this.#result = this.#operation.apply(ctx, params) ?? undefined;
        // Параметры запоминаются копией и только после успеха: история
        // показывает, чем была операция, вызывающий не должен уметь переписать
        // это задним числом, а отменённое применение записью не было.
        this.#params = cloneFrozen(params);
      } catch (error) {
        undoRun();
        throw error;
      } finally {
        // Контекст закрывается сразу после возврата из `apply`: операция,
        // сохранившая его в замыкании, ничего им не сделает.
        ctx.close();
      }
      // Оповещение — после того, как применение состоялось целиком и поверхность
      // правки закрыта: подписчик видит законченное состояние, а его отказ уже
      // не может откатить правку, о которой ему сообщили.
      if (announce) this.#announce();
      return this.#result;
    }

    /**
     * Событие о применении внутри незакрытого взаимодействия (ED-15). Вид
     * события — не `applied`: в истории записи ещё нет, состояние провизорно и
     * `cancel` его отменит, и потребитель, который на этом различии что-то
     * строит, обязан получать различие, а не выводить его.
     *
     * Применение, ничего не изменившее, события не даёт — по той же причине, по
     * которой не оставляет записи в истории: оповещение «ничего не произошло»
     * стоит потребителю полной перерисовки и не значит ничего.
     */
    #announce(): void {
      if (this.#step.length === 0) return;
      const paths = [...this.#step];
      const documentIds: DocumentId[] = [];
      for (const ref of paths) {
        if (!documentIds.includes(ref.documentId)) documentIds.push(ref.documentId);
      }
      emit({ kind: 'extended', operationId: this.operationId, documentIds, paths });
    }

    /**
     * Снимок состояния до применения — ссылками, а не копиями: значения
     * иммутабельны, поэтому откат одного применения стоит столько же, сколько
     * ссылка на документ. Вместе с документами откатывается и учёт тронутых
     * мест: место, правку которого отменил отказ, не должно числиться тронутым
     * — иначе оповещение (ED-15) назовёт его вместо того, что тронуто на самом
     * деле, а следующее применение промолчит о нём как об уже названном.
     */
    #snapshotOpen(): () => void {
      const taken = [...documents.values()].map((record) => ({
        record,
        value: record.value,
        descriptors: record.descriptors,
      }));
      const marks = [...this.#touched].map(([id, pending]) => ({ id, pending, count: pending.paths.length }));
      return () => {
        for (const { record, value, descriptors } of taken) {
          record.value = value;
          record.descriptors = descriptors;
        }
        this.#touched.clear();
        for (const { id, pending, count } of marks) {
          pending.paths.length = count;
          pending.seen.clear();
          for (const path of pending.paths) pending.seen.add(pathKey(path));
          this.#touched.set(id, pending);
        }
      };
    }

    extend(params: OperationParams = {}): JsonValue | undefined {
      this.#assertOpen();
      return this.run(params, true);
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

    /**
     * Своего вида события отказу не заводится: `cancelled` уже отличается от
     * `applied`, и этого хватает — потребитель узнаёт, что провизорное
     * состояние снято и в историю не легло.
     *
     * Пара с `extended` при этом полная: значение документа правится только
     * заменой на новое, вернуться к той же ссылке оно не может, — поэтому
     * документ, о котором было сказано `extended`, здесь непременно окажется
     * изменённым и будет назван. Молчание отказа означает ровно то, что
     * взаимодействие ничего не изменило и объявлять было нечего.
     */
    /**
     * Отмена, которую делает приостановка авторинга, а не ведущий
     * взаимодействие. Отдельным именем, чтобы отличать её потом: держащий
     * транзакцию о ней не знал, и его собственный `cancel` уже ничего не
     * находит.
     */
    abandon(): void {
      // Отметка ставится ПОСЛЕ отмены, а не до: до неё эта отмена сама
      // отказалась бы — она и есть та отмена, о которой отметка говорит.
      this.cancel();
      this.#abandoned = true;
    }

    cancel(): void {
      // Отмена того, что уже отменила приостановка, — не ошибка: просят ровно
      // того, что произошло, и произошло целиком (правки нет, записи истории
      // нет). Отказ здесь ронял бы обработчик «бросить начатое» у каждого, кто
      // ведёт взаимодействие, — то есть требовал бы от него помнить про чужую
      // приостановку. Отмена после `commit` по-прежнему отказ: там просьба
      // ложна, правка в истории.
      if (this.#abandoned && !this.#open) return;
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
      // Причина закрытия называется, а не сводится к «уже закрыто»: продолжить
      // или закрыть взаимодействие, которое сняла приостановка, пытается тот,
      // кто о ней не знал, и «уже закрыто» не сказало бы ему, чем именно.
      if (this.#abandoned) {
        throw new OperationError(this.operationId, 'взаимодействие снято приостановкой авторинга (ED-9)');
      }
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
      const full: JsonPath = [...where.path, ...path];
      this.#guard(pending.record, full, where.list);
      this.#write(pending, full, value);
    }

    removeRecordValue(id: DocumentId, descriptor: string, path: JsonPath): void {
      this.#assertLive();
      // Пустой путь — это сама запись, а не место внутри неё. Вырезать её здесь
      // значило бы сдвинуть индексы соседей, не тронув таблицу дескрипторов:
      // дескрипторы следующих записей начали бы указывать на чужие, то есть
      // адресация сломалась бы от удаления соседа — ровно то, что ED-29
      // запрещает. Запись убирает `removeRecord`, который правит и таблицу.
      if (path.length === 0) {
        throw new OperationError(
          this.#tx.operationId,
          `запись "${descriptor}": пустой путь адресует саму запись — её убирает удаление записи, а не поля`,
          { received: descriptor },
        );
      }
      const where = this.locate(id, descriptor);
      const pending = this.#tx.touch(id);
      const full: JsonPath = [...where.path, ...path];
      this.#guard(pending.record, full, where.list);
      this.#erase(pending, full);
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
      // Отказ, а не пропуск правки таблицы. Дескриптор и запись — пара по
      // индексу: `locate` берёт индекс из таблицы и им же адресует список. Если
      // по адресу записи в документе ничего нет, пара уже разошлась, и убрать
      // дескриптор молча значило бы сдвинуть на единицу все следующие — под
      // курсором автора оказалась бы соседняя запись (ED-29: адресация не
      // ломается от правки соседей). Убрать вместо этого только дескриптор,
      // оставив список как есть, — то же самое расхождение с другой стороны, а
      // `commit` записал бы его в историю: undo и redo водили бы по состоянию,
      // которого не производит ни одна операция целиком (ED-18). Отказ
      // откатывается тем же механизмом, что всякое упавшее применение, и
      // оставляет документ и таблицу такими, какими они были.
      if (!this.#erase(pending, where.path)) {
        throw new OperationError(
          this.#tx.operationId,
          `запись "${descriptor}": по её адресу ${formatPath(where.path)} в документе "${id}" ничего нет`,
          { received: descriptor },
        );
      }
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
     *
     * `except` — список, внутрь записи которого правка и адресована
     * дескриптором: для него путь с индексом законен, он и получен от
     * дескриптора. Прочие отслеживаемые списки остаются закрыты и на этом пути
     * тоже — список, вложенный в запись другого списка, иначе правился бы
     * индексом в обход собственных дескрипторов.
     */
    #guard(record: DocumentRecord, path: JsonPath, except?: JsonPath): void {
      for (const list of record.lists) {
        if (except !== undefined && pathsEqual(list, except)) continue;
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

    /** `false` — по пути ничего не было, документ той же ссылкой и правкой это не считается. */
    #erase(pending: PendingDocument, path: JsonPath): boolean {
      const next = removeAtPath(pending.record.value, path);
      if (next === pending.record.value) return false;
      pending.record.value = next;
      this.#tx.mark(pending, path);
      return true;
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

  /**
   * `action` различает два входа — одношаговое применение и начало
   * взаимодействия, — и из него же следует, объявлять ли первое применение
   * событием `extended` (ED-15). Одношаговый вызов закрывает взаимодействие тем
   * же вызовом, и наблюдать его промежуточное состояние было некому: событие о
   * нём было бы вторым оповещением об одной и той же правке, то есть лишней
   * перерисовкой у всех подписчиков. Взаимодействие, которое остаётся открытым,
   * объявляет о себе с первого же применения — оно уже видно автору. Тем же
   * различием отказ называет, что именно отклонено (ED-30).
   */
  const start = (
    action: Extract<AuthoringAction, 'apply' | 'begin'>,
    operationId: string,
    params: OperationParams,
  ): Transaction => {
    // Первым делом и до всего прочего: приостановленный авторинг — состояние
    // сессии, а не свойство конкретной операции, и отвечать на «примени» разбором
    // параметров операции, которую всё равно не применят, значит отвечать не то.
    refuseWhenSuspended(action, operationId);
    const announce = action === 'begin';
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
      tx.run(params, announce);
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
      // Закрыть документ, упомянутый в истории, `closeDocument` не даёт, так
      // что сюда попасть нечем. Отказ, а не пропуск: пропустив документ,
      // сессия привела бы остальные в состояние, которого вместе с ним не
      // было ни разу, — то самое недостижимое состояние из ED-18.
      if (record === undefined) {
        throw new Error(
          `${direction}: документ "${change.documentId}" записи истории не открыт`,
        );
      }
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
      // Взаимодействие идёт над тем набором документов, с которым началось:
      // `cancel` возвращает к состоянию до начала, а документ, открытый
      // посередине, возвращать некуда — он остался бы открытым от отменённого.
      if (transaction !== undefined) throw new Error('открыть документ во время взаимодействия нельзя');
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
      // Промежуточное состояние мазка на диск не попадает: отметив его
      // сохранённым, сессия объявила бы диском состояние, которое `cancel`
      // через мгновение отменит, и «сохранение трогает только правленое»
      // (ED-21) перестало бы что-либо значить.
      if (transaction !== undefined) throw new Error('отметить документ сохранённым во время взаимодействия нельзя');
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
      return start('apply', operationId, params).commit();
    },

    beginOperation(operationId, params = {}) {
      return start('begin', operationId, params);
    },

    get pending() {
      return transaction !== undefined;
    },

    get authoringSuspended() {
      return suspensions.size > 0;
    },

    suspensionReasons: () => reasons(),

    suspendAuthoring(reason) {
      if (reason.trim() === '') {
        throw new Error('приостановка авторинга без причины не берётся: отказ назвал бы пустое основание');
      }
      // Взаимодействие снимается ДО того, как приостановка начнёт действовать:
      // снятие возвращает документы к состоянию до его начала, то есть само
      // является правкой, и отказывать ему было бы отказом убрать провизорное
      // состояние — оно тогда пережило бы вход в превью (ED-9, ED-18).
      transaction?.abandon();
      const taken = { reason };
      const first = suspensions.size === 0;
      suspensions.add(taken);
      if (first) emit({ kind: 'suspended', documentIds: [], paths: [] });
      return {
        reason,
        get active() {
          return suspensions.has(taken);
        },
        resume() {
          // Повторный вызов молчит: право снять — своё, и снимать им дважды
          // нечего. Отказ здесь заставлял бы держащего помнить, снимал ли он уже.
          if (!suspensions.delete(taken)) return;
          if (suspensions.size === 0) emit({ kind: 'resumed', documentIds: [], paths: [] });
        },
      };
    },

    // Доступность отвечается тем же слоем, что и отказ: интерфейс спрашивает
    // «можно ли», а не выводит это из своего режима (ED-26 — показать
    // недоступным; ED-9 — почему). Незакрытое взаимодействие в этот ответ не
    // входит: оно принадлежит спрашивающему, он его и ведёт, — а приостановку
    // мог взять кто угодно.
    canUndo: () => suspensions.size === 0 && history.canUndo(),
    canRedo: () => suspensions.size === 0 && history.canRedo(),

    undo() {
      // Отмена и повтор — авторинг наравне с операциями: они меняют значения
      // документов, а «превью MUST NOT записывать что-либо в документы» (ED-9)
      // сказано про запись, а не про её происхождение. Прогон собран из текущего
      // состояния документов (ED-9), и отмена посреди него оставила бы мир
      // прогона описанием документов, которых уже нет.
      refuseWhenSuspended('undo', history.peekUndo()?.operationId ?? '');
      if (transaction !== undefined) throw new Error('undo во время взаимодействия недоступен');
      const entry = history.takeUndo();
      if (entry === undefined) return false;
      restore(entry, 'undo');
      return true;
    },

    redo() {
      refuseWhenSuspended('redo', history.peekRedo()?.operationId ?? '');
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
