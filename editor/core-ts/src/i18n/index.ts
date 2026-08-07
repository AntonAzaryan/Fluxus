/**
 * Слой строковых ресурсов редактора: локали (ED-27) и описания полей (ED-28).
 *
 * Слой headless и ничего не показывает: он отвечает, какой текст показать по
 * ключу и по пути поля в схеме, и умеет отчитаться, где ресурсы и схемы
 * разошлись. Показ, наведение и явный вызов подсказки — за интерфейсом.
 */
export { descriptionKey, keyKind, schemaPathOf } from './keys.js';
export type { DescriptionKind, SchemaPath } from './keys.js';

export {
  PROJECT_BUNDLE_DIR,
  SHIPPED_LOCALES,
  SOURCE_LOCALE,
  StringResources,
  catalogDescriptions,
  projectBundlePath,
} from './resources.js';
export type {
  DescriptionSource,
  Hint,
  LocaleBundle,
  LocaleBundles,
  LocaleId,
  ResourceHit,
  StringResourcesInit,
  TextSource,
} from './resources.js';

// Источники путей вносят доменные имена — это вклад, а не каркас (ED-25), и
// перечисление их здесь поимённо втащило бы те же имена в барель слоя.
export * from './paths.js';

export { isReportEmpty, reportResources } from './report.js';
export type { ResourceReport } from './report.js';

export {
  confirmTranslations,
  fingerprint,
  fingerprintFileContent,
  translationStatus,
} from './fingerprints.js';
export type { FingerprintEntry, FingerprintFile, TranslationStatus } from './fingerprints.js';

export { EDITOR_BUNDLES, EDITOR_FINGERPRINTS } from './editorBundles.js';
