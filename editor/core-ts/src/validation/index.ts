/**
 * Слой валидации (ED-8) и её структурный результат (ED-30).
 *
 * Барель каркасной части перечисляет имена явно, как и остальные барели пакета.
 * Модули вкладов (`engineRules`, `crossDocument`) реэкспортируются целиком, и
 * это не лень: имена их правил доменные («сцена», «манифест», «префаб»), а
 * перечислить их здесь значило бы внести доменные имена в каркас — ровно то,
 * что запрещает третий абзац ED-25. Барель знает, что вклады есть, и не знает,
 * про что они.
 */
export type {
  ExpectedAcceptance,
  ExpectedOneOf,
  ExpectedPresence,
  ExpectedRange,
  ExpectedReference,
  ExpectedTogether,
  Finding,
  ReasonParams,
  ValidationExpectation,
  ValidationIssue,
  ValidationReport,
  ValidationRule,
  ValidationRun,
  ValidationSeverity,
  ValidationSource,
} from './types.js';

export { formatIssue, reasonKey, ruleDescriptionKey, REASON_PREFIX, RULE_DESCRIPTION_PREFIX } from './reasons.js';

export { compareIssues, comparePaths, createReport, issueKey } from './result.js';

export { createValidator, registerValidationRules, RULE_FAILED } from './runner.js';
export type { Validator, ValidatorOptions, ValidationRunStats } from './runner.js';

export { probePath, reportErrorList, reportThrown } from './adapters.js';
export type { AdapterOptions, ErrorListResult } from './adapters.js';

export * from './engineRules.js';
export * from './crossDocument.js';
