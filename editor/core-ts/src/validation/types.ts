/**
 * Форма результата валидации (ED-30) и форма правила (ED-8, ED-25).
 *
 * Требование ED-30 читается буквально: результат называет правило, путь в
 * документе, полученное значение и ожидание — «адресуемо, а не только
 * подсвечено в интерфейсе». Отсюда всё устройство этого файла:
 *
 * - Находка — данные, а не строка. Строка описывает нарушение только тому, кто
 *   её читает; цикл «правка → валидация → исправление» без человека выполним
 *   лишь по разобранным полям.
 * - Текста причины в находке нет — есть ключ строкового ресурса и параметры
 *   подстановки (ED-27, ED-28). Английская фраза, зашитая в результат, была бы
 *   вторым набором формулировок мимо бандлов, и на русской локали автор увидел
 *   бы её же.
 * - Ожидание — размеченное объединение, а не свободный текст: «одно из»,
 *   «диапазон», «ссылка на существующее», «должно быть/не быть» и, отдельным
 *   случаем, «валидатор отверг». Последний нужен честно: часть проверок ядра
 *   устроена «бросить на первом нарушении», и точнее, чем «вот кто отверг и вот
 *   его сообщение», из них не вытянуть, не переписав правило у себя (ED-1).
 *
 * Доменных имён редактируемого здесь нет: правило — вклад (ED-25), и что
 * именно оно проверяет, знает вклад, а не эта форма.
 */
import type {
  DocumentId,
  DocumentKind,
  DocumentPathRef,
  EditorDocument,
  JsonPath,
  JsonValue,
} from '../document/index.js';
import type { ValidationRuleContribution } from '../registry/index.js';

/**
 * Различаются два состояния, потому что их различает автор: ошибка — то, что
 * ядро или загрузчик отвергнут, предупреждение — то, что они переживут
 * (пропуск записи, игнор несовпадения). Оттенком они не различаются нигде —
 * ED-22 требует иконку, положение и текст причины, и текст причины у находки
 * есть ключом.
 */
export type ValidationSeverity = 'error' | 'warning';

/** Параметры подстановки в текст причины. Только скаляры: подставляется строка. */
export type ReasonParams = Readonly<Record<string, string | number | boolean>>;

/** Значение обязано быть одним из перечисленных. */
export interface ExpectedOneOf {
  readonly kind: 'oneOf';
  readonly values: readonly JsonValue[];
}

/** Число в границах; `integer` — требование целости, а не форма записи. */
export interface ExpectedRange {
  readonly kind: 'range';
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

/**
 * Значение обязано называть существующее. `targets` — места, где перечислено
 * существующее: внешний потребитель чинит нарушение с любой стороны — правит
 * ссылку или заводит недостающее по указанному адресу. `known` — то, что там
 * сейчас есть, отсортировано.
 */
export interface ExpectedReference {
  readonly kind: 'reference';
  readonly targets: readonly DocumentPathRef[];
  readonly known: readonly string[];
}

/** Место обязано существовать (`present: true`) или отсутствовать. */
export interface ExpectedPresence {
  readonly kind: 'presence';
  readonly present: boolean;
}

/**
 * Валидатор отверг значение целиком. `by` — кто именно (`пакет:функция`),
 * `detail` — его сообщение дословно.
 *
 * Случай существует не от лени: `loadScene`, `createTerrainGrid` и
 * `validateSystem` бросают на первом нарушении и адреса в документе не
 * возвращают. Разобрать их прозу на путь означало бы держать у себя знание о
 * формулировках чужого модуля и расходиться с ним молча при первой же правке
 * текста — то самое второе описание правила, которое запрещает ED-1. Поэтому
 * ожидание честно говорит «этот валидатор отверг это значение», а сообщение
 * доезжает до потребителя дословно.
 */
export interface ExpectedAcceptance {
  readonly kind: 'accepted';
  readonly by: string;
  readonly detail: string;
}

export type ValidationExpectation =
  | ExpectedOneOf
  | ExpectedRange
  | ExpectedReference
  | ExpectedPresence
  | ExpectedAcceptance;

/** Структурный результат одной проверки (ED-30). */
export interface ValidationIssue {
  /** id вклада-правила: по нему находка сопоставляется с реестром (ED-25). */
  readonly ruleId: string;
  readonly severity: ValidationSeverity;
  readonly documentId: DocumentId;
  /** Путь в документе. Пустой — сам документ: не всякое нарушение адресуемо глубже. */
  readonly path: JsonPath;
  /** Значение по этому пути на момент проверки; `undefined` — места нет. */
  readonly received: JsonValue | undefined;
  readonly expected: ValidationExpectation;
  /** Ключ строкового ресурса причины (ED-27, ED-28). Текста в находке нет. */
  readonly reasonKey: string;
  readonly reasonParams: ReasonParams;
}

/**
 * То, что сообщает правило. Правило не заполняет ни `ruleId`, ни ключ ресурса:
 * и то и другое выводится из самого правила и кода причины, и второй точки
 * вывода ключа в пакете быть не должно (ED-28).
 */
export interface Finding {
  /** Документ находки; по умолчанию — тот, на котором правило запущено. */
  readonly documentId?: DocumentId;
  readonly path: JsonPath;
  /** По умолчанию читается из документа по указанному пути. */
  readonly received?: JsonValue;
  readonly expected: ValidationExpectation;
  /** Код причины внутри правила: из пары «правило + код» получается ключ ресурса. */
  readonly code: string;
  readonly params?: ReasonParams;
  /** По умолчанию — важность правила, по умолчанию правила — `error`. */
  readonly severity?: ValidationSeverity;
}

/**
 * Поверхность одного прогона правила. Через неё же идут все чтения чужих
 * документов — прогон запоминает прочитанное и по нему решает, можно ли в
 * следующий раз переиспользовать найденное (ED-8 требует валидации в реальном
 * времени, то есть на каждую правку).
 */
export interface ValidationRun {
  /** Документ, на котором запущено правило. */
  readonly document: EditorDocument;
  /** Открытые документы указанного вида, в порядке источника. */
  documentsOfKind(kind: DocumentKind): readonly EditorDocument[];
  /** Значение открытого документа; `undefined` — документ не открыт. */
  valueOf(id: DocumentId): JsonValue | undefined;
  /**
   * Производное, общее для одного прогона: поднятый ядром мир нужен и правилу
   * документа, и правилам, которые этим миром проверяются. Живёт ровно один
   * прогон — производное, пережившее правку, было бы вторым состоянием рядом с
   * документом.
   */
  derive<T>(key: string, build: () => T): T;
  report(finding: Finding): void;
}

/**
 * Правило валидации — вклад (ED-25): добавление правила есть регистрация, а не
 * правка каркаса. `appliesTo` наследуется от вклада и перечисляет виды
 * редактируемого, на которых правило запускается.
 */
export interface ValidationRule extends ValidationRuleContribution {
  /** Важность находок правила по умолчанию; сама находка может её переопределить. */
  readonly severity?: ValidationSeverity;
  check(run: ValidationRun): void;
}

/**
 * Источник документов для прогона. Уже открытая сессия подходит сюда как есть,
 * но валидатор не требует именно её: набор документов на диске проверяется тем
 * же прогоном, что и набор в редакторе (ED-30 — цикл выполним без интерфейса).
 */
export interface ValidationSource {
  documentIds(): readonly DocumentId[];
  document(id: DocumentId): EditorDocument;
}

/**
 * Результат прогона: находки и способы спросить о них по адресу. Индексы — то,
 * ради чего результат существует как объект, а не как список: и навигатор, и
 * инспектор спрашивают «что не так вот здесь», а не перебирают всё (ED-22).
 */
export interface ValidationReport {
  /** Все находки в устойчивом порядке: документ, путь, правило. */
  readonly issues: readonly ValidationIssue[];
  /** Нет ни одной находки важности `error`. Предупреждения `ok` не отменяют. */
  readonly ok: boolean;
  forDocument(documentId: DocumentId): readonly ValidationIssue[];
  /** Находки ровно по этому пути — то, что показывает поле инспектора. */
  at(documentId: DocumentId, path: JsonPath): readonly ValidationIssue[];
  /** Находки по этому пути и глубже — то, что показывает узел навигатора. */
  under(documentId: DocumentId, path: JsonPath): readonly ValidationIssue[];
  /** Худшая важность в документе или под путём; `undefined` — находок нет. */
  severityOf(documentId: DocumentId, path?: JsonPath): ValidationSeverity | undefined;
}
