/**
 * Операция авторинга (ED-29) — единственный способ изменить редактируемый
 * документ. Форма принята в `editor-ui-shell/design.md`, раздел «Операция
 * авторинга: применение и обратное значение»: операция — это `id`, параметры
 * со схемой и пара «применить / откатить».
 *
 * Откат здесь не функция операции, и это принципиально. Пара выглядит так:
 * `apply` пишет через `OperationContext`, а контекст запоминает прежние
 * значения затронутых мест; откат — восстановление запомненного. Обратное
 * вычисление (снять с клетки то, что кисть на неё положила; вычесть дельту из
 * поля с производными) было бы вторым источником правды о том, что операция
 * сделала, и расходилось бы с первым молча.
 *
 * Из этого же следует, почему обратной функции нет в типе: её негде было бы
 * проверить. Проверка ED-29 — «применить, отменить, сравнить документ с
 * исходным» — универсальна ровно потому, что откат один на все операции
 * (`operations/conformance.ts`).
 */
import type { DescriptorId, DescriptorLocation } from '../document/descriptors.js';
import type { JsonPath, JsonValue } from '../document/json.js';
import type { DocumentId, DocumentKind } from '../document/types.js';

/**
 * Тип параметра. Набор закрыт: он же — словарь машинного каталога (ED-30), и
 * каждый новый тип обязан что-то значить для внешнего потребителя, а не быть
 * синонимом уже имеющегося.
 *
 * - `document` — идентификатор открытого документа;
 * - `path` — путь в документе, список шагов (`JsonPath`);
 * - `descriptor` — сессионный дескриптор записи (см. `SESSION_SCOPED_TYPES`);
 * - `json` — произвольное значение, вплоть до целого поддерева;
 * - `string` / `number` / `boolean` — скаляры.
 */
export const OPERATION_PARAM_TYPES = [
  'document',
  'path',
  'descriptor',
  'json',
  'string',
  'number',
  'boolean',
] as const;

export type OperationParamType = (typeof OPERATION_PARAM_TYPES)[number];

/**
 * Типы, значения которых живут только в текущей сессии. Каталог ED-30 обязан
 * объявлять это явно: ссылка, сохранённая между сессиями, недействительна.
 * Множество, а не проверка на равенство в одном месте, — чтобы следующий
 * сессионный тип попадал в каталог тем же способом, а не вторым условием.
 */
export const SESSION_SCOPED_TYPES: ReadonlySet<OperationParamType> = new Set<OperationParamType>([
  'descriptor',
]);

export interface OperationParamSpec {
  readonly type: OperationParamType;
  /** Необязательный параметр может отсутствовать; `null` от отсутствия отличается. */
  readonly optional?: boolean;
  /**
   * Ключ строкового ресурса описания (ED-28). Текст в схеме не хранится: в
   * каталоге ED-30 описаниями служат те же строки, что видит человек, и
   * второго набора формулировок «для машины» не заводится.
   */
  readonly descriptionKey: string;
}

/** Значения параметров приходят как JSON: снаружи интерфейса иначе и не бывает (ED-29). */
export type OperationParams = Readonly<Record<string, JsonValue>>;

/**
 * Поверхность правки, выданная операции на время её применения. Живёт ровно
 * столько, сколько идёт транзакция: после `commit`/`cancel` любой её метод
 * бросает. Иначе операция могла бы припрятать контекст и написать в документ
 * позже — мимо истории, то есть мимо ED-29.
 */
export interface OperationContext {
  readonly documentIds: readonly DocumentId[];
  kindOf(documentId: DocumentId): DocumentKind;
  /** Текущее значение документа — с учётом того, что операция уже записала. */
  read(documentId: DocumentId): JsonValue;
  readAt(documentId: DocumentId, path: JsonPath): JsonValue | undefined;
  /** Пути отслеживаемых списков документа. */
  lists(documentId: DocumentId): readonly JsonPath[];
  /** Дескрипторы записей списка, в порядке записей. */
  records(documentId: DocumentId, list: JsonPath): readonly DescriptorId[];
  /** Где сейчас запись. Бросает, если дескриптор не из этой сессии или уже удалён. */
  locate(documentId: DocumentId, descriptor: string): DescriptorLocation;
  /**
   * Пишет в документ. Внутрь отслеживаемого списка этот метод не пускает — там
   * работают `setRecordValue`/`removeRecordValue`, адресующие дескриптором.
   * Запрет структурный, а не по договорённости: путь с индексом записи
   * ломается от удаления соседа, и операция, собранная по прочитанному списку,
   * попала бы не туда (ED-29).
   */
  setValue(documentId: DocumentId, path: JsonPath, value: JsonValue): void;
  removeValue(documentId: DocumentId, path: JsonPath): void;
  /** Правка внутри записи: путь отсчитывается от самой записи, а не от корня. */
  setRecordValue(documentId: DocumentId, descriptor: string, path: JsonPath, value: JsonValue): void;
  removeRecordValue(documentId: DocumentId, descriptor: string, path: JsonPath): void;
  /**
   * Дописывает запись в конец отслеживаемого списка и выдаёт ей дескриптор.
   * Только в конец: порядок записей расстановки нормативен, он задаёт выданные
   * ID, и вставка в середину сдвинула бы ID всего, что за ней (SER-8, ED-16).
   */
  appendRecord(documentId: DocumentId, list: JsonPath, item: JsonValue): DescriptorId;
  /** Удаляет запись. Сдвиг индексов следующих нормирован и дефектом не является (ED-16). */
  removeRecord(documentId: DocumentId, descriptor: string): void;
}

export interface AuthoringOperation {
  /** Устойчивый идентификатор: по нему операция вызывается и из интерфейса, и снаружи. */
  readonly id: string;
  /** Ключ строкового ресурса описания операции (ED-28, ED-30). */
  readonly descriptionKey: string;
  readonly params: Readonly<Record<string, OperationParamSpec>>;
  /**
   * Возвращённое значение попадает в результат вызова: дописавшая запись
   * операция отдаёт её дескриптор, иначе вызывающему неоткуда узнать адрес
   * только что созданного.
   */
  readonly apply: (ctx: OperationContext, params: OperationParams) => JsonValue | undefined;
}

/**
 * Отказ операции — структурный, а не только текстовый (ED-30): правило, место
 * и полученное значение адресуемы. Тем же типом отвечает и проверка параметров:
 * внешний потребитель, вызвавший операцию без интерфейса, обязан получить не
 * меньше, чем автор в диалоге.
 */
export class OperationError extends Error {
  readonly operationId: string;
  readonly param?: string;
  readonly received?: JsonValue;

  constructor(operationId: string, message: string, details?: { param?: string; received?: JsonValue }) {
    super(`операция "${operationId}": ${message}`);
    this.name = 'OperationError';
    this.operationId = operationId;
    if (details?.param !== undefined) this.param = details.param;
    if (details?.received !== undefined) this.received = details.received;
  }
}
