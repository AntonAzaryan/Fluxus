/**
 * Реестры вкладов (ED-25) и машинный каталог (ED-30) — поверхность каталога
 * пакета для того, кто собирает редактор.
 */
export {
  ContributionRegistry,
  compareIds,
  type Contribution,
  type ContributionKind,
  type ContributionReader,
  type ContributionRegistryOptions,
} from './contribution.js';
export {
  type EditableTypeDescriptor,
  type FieldEditorContribution,
  type PaletteCommandContribution,
  type ValidationRuleContribution,
  type ViewportToolContribution,
  type WorkspaceAreaContribution,
} from './kinds.js';
export { createEditorContributions, type EditorContributions } from './contributions.js';
export { type DescriptionResolver } from './descriptions.js';
export {
  buildEditorCatalog,
  type CatalogArea,
  type CatalogEditableType,
  type CatalogOperation,
  type CatalogParameter,
  type CatalogSources,
  type CatalogValidationRule,
  type ContributionCatalogSource,
  type EditorCatalog,
  type OperationCatalogSource,
} from './catalog.js';
