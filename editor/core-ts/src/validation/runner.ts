/**
 * Прогон правил по открытым документам (ED-8: валидация в реальном времени).
 *
 * «В реальном времени» здесь означает буквально «на каждую правку», и цена
 * этого — единственное, что определяет устройство файла. Правила дорогие:
 * проверить документ значит спросить ядро, а спросить ядро значит поднять мир
 * (ED-1 не оставляет выбора — своей копии правила у редактора быть не должно).
 * Поэтому прогон не столько исполняет правила, сколько решает, какие из них
 * исполнять не надо.
 *
 * Решение опирается на устройство документа, а не на догадки о том, что
 * изменилось: значение документа заморожено вглубь и при правке заменяется
 * новым корнем целиком, поэтому сравнение ссылок — точный признак «этот
 * документ тот же». Прогон запоминает, что правило прочитало (свой документ,
 * чужие значения, состав документов запрошенного вида), и переиспользует
 * прежние находки, пока всё прочитанное совпадает по ссылке. Правило, читавшее
 * один документ, не перезапускается от правки соседнего.
 *
 * Кэш по «прочитанному», а не по «своему документу», нужен из-за
 * междокументных правил: у них вход — пара документов, и признак «мой документ
 * не менялся» для них неверен.
 *
 * Производное на прогон (`derive`) живёт ровно один прогон. Пережившее правку
 * производное было бы вторым состоянием рядом с документом — тем же дефектом,
 * от которого документ защищён заморозкой.
 */
import { getAtPath, type JsonValue } from '../document/index.js';
import type { DocumentId, DocumentKind, EditorDocument } from '../document/index.js';
import type { ContributionReader } from '../registry/index.js';
import { reasonKey } from './reasons.js';
import { createReport } from './result.js';
import type {
  Finding,
  ValidationIssue,
  ValidationReport,
  ValidationRule,
  ValidationRun,
  ValidationSource,
} from './types.js';

export interface ValidatorOptions {
  /** Реестр правил-вкладов (ED-25): порядок перечисления от порядка регистрации не зависит. */
  readonly rules: ContributionReader<ValidationRule>;
}

/** Чем прогон отчитывается о себе: сколько правил исполнено, сколько переиспользовано. */
export interface ValidationRunStats {
  readonly executed: number;
  readonly reused: number;
}

export interface Validator {
  /** Прогон по всем документам источника. */
  run(source: ValidationSource): ValidationReport;
  /** Забыть запомненное: весь кэш или один документ. */
  invalidate(documentId?: DocumentId): void;
  /** Статистика последнего прогона — то, чем «в реальном времени» проверяемо. */
  readonly lastRun: ValidationRunStats;
}

interface CacheEntry {
  /** Документ, на котором правило было запущено: по нему запись и живёт. */
  readonly anchor: DocumentId;
  readonly issues: readonly ValidationIssue[];
  /** Прочитанные значения по ссылке: `undefined` — документ не был открыт. */
  readonly reads: ReadonlyMap<DocumentId, JsonValue | undefined>;
  /** Состав документов вида на момент прогона — подпись из их id. */
  readonly kinds: ReadonlyMap<DocumentKind, string>;
}

const NOTHING: ValidationRunStats = { executed: 0, reused: 0 };

/** Код причины «правило упало само»: у каждого правила он один и тот же. */
export const RULE_FAILED = 'ruleFailed';

/** Разделитель ключа кэша: в id правила и id документа нулевого символа нет. */
const KEY_SEPARATOR = '\u0000';

/**
 * Регистрация правил в реестре вкладов (ED-25) — та же идиома, что у базовых
 * операций: набор правил приносит тот, кто собирает редактор, а не каркас.
 */
export function registerValidationRules(
  registry: { register(rule: ValidationRule): void },
  rules: Iterable<ValidationRule>,
): void {
  for (const rule of rules) registry.register(rule);
}

export function createValidator(options: ValidatorOptions): Validator {
  const cache = new Map<string, CacheEntry>();
  let lastRun: ValidationRunStats = NOTHING;

  const cacheKey = (ruleId: string, documentId: DocumentId): string => `${ruleId}${KEY_SEPARATOR}${documentId}`;

  return {
    get lastRun() {
      return lastRun;
    },

    invalidate(documentId) {
      if (documentId === undefined) {
        cache.clear();
        return;
      }
      // Правило могло читать этот документ, оставаясь на другом, — снимается
      // всё, что его касалось, а не только записи с ним в ключе.
      for (const [key, entry] of cache) {
        if (entry.reads.has(documentId)) cache.delete(key);
      }
    },

    run(source) {
      const open = new Map<DocumentId, EditorDocument>();
      for (const id of source.documentIds()) open.set(id, source.document(id));
      const derived = new Map<string, unknown>();
      const issues: ValidationIssue[] = [];
      let executed = 0;
      let reused = 0;

      const signatureOf = (kind: DocumentKind): string => {
        const ids: string[] = [];
        for (const document of open.values()) if (document.kind === kind) ids.push(document.id);
        return ids.join(KEY_SEPARATOR);
      };

      const stillValid = (entry: CacheEntry): boolean => {
        for (const [id, value] of entry.reads) {
          if (open.get(id)?.value !== value) return false;
        }
        for (const [kind, signature] of entry.kinds) {
          if (signatureOf(kind) !== signature) return false;
        }
        return true;
      };

      for (const document of open.values()) {
        for (const rule of options.rules.all()) {
          if (!rule.appliesTo.includes(document.kind)) continue;
          const key = cacheKey(rule.id, document.id);
          const cached = cache.get(key);
          if (cached !== undefined && stillValid(cached)) {
            issues.push(...cached.issues);
            reused++;
            continue;
          }
          const entry = execute(rule, document, open, derived, signatureOf);
          cache.set(key, entry);
          issues.push(...entry.issues);
          executed++;
        }
      }

      // Записи закрытых документов не переживают прогон: сессия закрывает
      // документ только сохранённым и не упомянутым в истории, и открыть его
      // заново — это уже другое содержимое.
      for (const [key, entry] of cache) {
        if (!open.has(entry.anchor)) cache.delete(key);
      }

      lastRun = { executed, reused };
      return createReport(issues);
    },
  };
}

function execute(
  rule: ValidationRule,
  document: EditorDocument,
  open: ReadonlyMap<DocumentId, EditorDocument>,
  derived: Map<string, unknown>,
  signatureOf: (kind: DocumentKind) => string,
): CacheEntry {
  const reads = new Map<DocumentId, JsonValue | undefined>();
  const kinds = new Map<DocumentKind, string>();
  const issues: ValidationIssue[] = [];
  const severity = rule.severity ?? 'error';

  const read = (id: DocumentId): JsonValue | undefined => {
    const value = open.get(id)?.value;
    reads.set(id, value);
    return value;
  };
  read(document.id);

  const run: ValidationRun = {
    document,
    documentsOfKind(kind) {
      kinds.set(kind, signatureOf(kind));
      const found: EditorDocument[] = [];
      for (const candidate of open.values()) {
        if (candidate.kind !== kind) continue;
        read(candidate.id);
        found.push(candidate);
      }
      return found;
    },
    valueOf: read,
    derive<T>(key: string, build: () => T): T {
      if (derived.has(key)) return derived.get(key) as T;
      const value = build();
      derived.set(key, value);
      return value;
    },
    report(finding: Finding) {
      const documentId = finding.documentId ?? document.id;
      const value = read(documentId);
      issues.push({
        ruleId: rule.id,
        severity: finding.severity ?? severity,
        documentId,
        path: Object.freeze([...finding.path]),
        received:
          finding.received !== undefined
            ? finding.received
            : value === undefined
              ? undefined
              : getAtPath(value, finding.path),
        expected: finding.expected,
        reasonKey: reasonKey(rule.id, finding.code),
        reasonParams: Object.freeze({ ...finding.params }),
      });
    },
  };

  try {
    rule.check(run);
  } catch (error) {
    // Упавшее правило не роняет прогон: валидация идёт на каждую правку, и
    // редактор, слепнущий от одного плохого вклада, хуже редактора с одной
    // непроверенной находкой. Падение при этом видно — оно становится находкой
    // самого правила, а не молчанием.
    issues.push({
      ruleId: rule.id,
      severity: 'error',
      documentId: document.id,
      path: Object.freeze([]),
      received: undefined,
      expected: {
        kind: 'accepted',
        by: rule.id,
        detail: error instanceof Error ? error.message : String(error),
      },
      reasonKey: reasonKey(rule.id, RULE_FAILED),
      reasonParams: Object.freeze({ rule: rule.id }),
    });
  }

  return { anchor: document.id, issues: Object.freeze(issues), reads, kinds };
}
