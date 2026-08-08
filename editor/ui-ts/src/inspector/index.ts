/**
 * Инспектор, собираемый из схемы редактируемого (ED-24), и реестр редакторов
 * поля (ED-25).
 *
 * Наружу выходит форма, в которой вклад приносит прочитанное из реестра схем,
 * сам инспектор и реестр редакторов поля. Что именно лежит в схеме — здесь не
 * знают и знать не могут: доменное знание живёт во вкладе.
 */
export {
  BUILTIN_FIELD_EDITORS,
  createFieldEditorRegistry,
  defaultFieldEditors,
  editorFor,
  registerFieldEditors,
} from './editors.js';
export type { FieldEditor, FieldEditorContext } from './editors.js';
export { inspectorPanel, issueState } from './inspector.js';
export type { InspectorSpec } from './inspector.js';
export { RECORD_VALUE_OPERATION, VALUE_OPERATION } from './schema.js';
export type {
  FieldGroup,
  InspectorSubject,
  SchemaField,
  SubjectAddress,
} from './schema.js';
