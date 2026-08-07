/**
 * Слой строковых ресурсов редактора: локали (ED-27) и описания полей (ED-28).
 *
 * Слой headless и ничего не показывает: он отвечает, какой текст показать по
 * ключу и по пути поля в схеме, и умеет отчитаться, где ресурсы и схемы
 * разошлись. Показ, наведение и явный вызов подсказки — за интерфейсом.
 */
export {
  DESCRIPTION_KINDS,
  descriptionKey,
  descriptionKind,
  isDescriptionKey,
  schemaPathOf,
} from './keys.js';
export type { DescriptionKind, SchemaPath } from './keys.js';

export {
  PROJECT_BUNDLE_DIR,
  SHIPPED_LOCALES,
  SOURCE_LOCALE,
  StringResources,
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

export {
  componentDescriptionPaths,
  documentDescriptionPaths,
  dslDescriptionPaths,
  editorDescriptionPaths,
  namedDescriptionPaths,
} from './paths.js';

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
