/**
 * Редактор поля инспектора — один из пяти видов вклада ED-25: «новый тип поля
 * в схемах → для него регистрируется редактор поля, и он подхватывается
 * инспектором во всех областях сразу».
 *
 * «Во всех областях сразу» держится не договорённостью, а тем, что реестр один
 * на редактор и приходит областям от каркаса: область не заводит своих
 * контролов по типу поля и не имеет способа их завести — она отдаёт инспектору
 * набор полей, а чем поле рисуется, решает реестр (`inspector.ts`).
 *
 * Набор, который редактор везёт с собой, покрывает типы полей схем ядра
 * (`FIELD_TYPES` — `i32` и `fixed`) и скаляры JSON, которыми описаны поля
 * форматов документов (SER-5). Это умолчания сборки, а не привилегированные
 * знания каркаса: любой из них перекрывается `override` того же реестра.
 *
 * Почему значение уходит наружу разобранным, а не строкой: разбор — свойство
 * типа поля, и он обязан жить там же, где показ. Инспектор, разбирающий ввод
 * сам, знал бы про типы полей, то есть был бы тем самым захардкоженным списком,
 * который запрещает ED-24.
 *
 * Граница операции — взаимодействие, а не событие ввода (ED-18, решение W1-3):
 * контролы отдают значение по `change`, то есть от фокуса до подтверждения
 * получается одна правка и одна запись истории. Ввод, который не разбирается в
 * значение своего типа, не записывается вовсе: поле возвращается к тому, что
 * лежит в документе, — записать «почти число» значило бы положить в документ
 * то, чего схема не допускает (ED-3).
 */
import { fixed } from '@game-mvp/core';
import {
  ContributionRegistry,
  type ContributionReader,
  type FieldEditorContribution,
  type JsonValue,
  type StringResources,
} from '@game-mvp/editor-core';
import { documentValue, type UiNode, type UiText } from '../dom/node.js';
import { numberField, select, textField, toggle } from '../widgets/field.js';
import type { ValidationState } from '../widgets/validation.js';
import type { SchemaField } from './schema.js';

/** Что редактор поля получает на отрисовку одной строки инспектора. */
export interface FieldEditorContext {
  readonly resources: StringResources;
  readonly field: SchemaField;
  /** Значение места в документе; `undefined` — места нет (поле не переопределено). */
  readonly value: JsonValue | undefined;
  /** Подпись контрола для доступности: имя поля, а не подпись интерфейса (ED-27). */
  readonly label: UiText;
  /** Правка недоступна: превью (ED-9), производное поле или отсутствующая операция. */
  readonly disabled: boolean;
  /** Находка валидации по этому месту (ED-8, ED-22); `undefined` — нарушений нет. */
  readonly validation?: ValidationState;
  /** Записать значение. Внутри — зарегистрированная операция и ничего больше (ED-29). */
  commit(next: JsonValue): void;
}

/** Вклад «редактор поля инспектора» (ED-25), ключуемый типом поля схемы. */
export interface FieldEditor extends FieldEditorContribution {
  render(context: FieldEditorContext): UiNode;
}

/** Реестр редакторов поля: тип поля занимается единолично (ED-25). */
export function createFieldEditorRegistry(): ContributionRegistry<FieldEditor> {
  return new ContributionRegistry<FieldEditor>({
    kind: 'field',
    claimName: 'тип поля',
    claimOf: (editor) => editor.fieldType,
  });
}

/**
 * Строка значения. Скаляр показывается собой, поддерево — своим JSON: строка
 * `[object Object]` в поле инспектора не значит ничего, а видеть, что по адресу
 * лежит не скаляр, автору надо.
 */
function valueString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Текст значения: содержимое документа, а не подпись интерфейса (ED-27). */
function valueText(value: JsonValue | undefined): UiText {
  return documentValue(valueString(value));
}

/**
 * Поле с перечисленными схемой значениями показывается выбором из них, каким бы
 * ни был его тип: «допустимые значения берутся из реестра схем» (ED-24), и
 * набранное руками значение вне набора было бы отвергнуто ядром (ED-3).
 */
function options(context: FieldEditorContext, parse: (raw: string) => JsonValue): UiNode {
  const values = context.field.values ?? [];
  return select({
    label: context.label,
    value: valueString(context.value),
    options: values.map((value) => ({ value: valueString(value), label: valueText(value) })),
    disabled: context.disabled,
    ...(context.validation === undefined ? {} : { validation: context.validation }),
    onSelect: (raw) => {
      context.commit(parse(raw));
    },
  });
}

/** Общая часть числовых редакторов: разбор, отказ от записи мусора, показ. */
function numeric(
  context: FieldEditorContext,
  show: (value: JsonValue | undefined) => UiText,
  parse: (raw: string) => number | undefined,
): UiNode {
  const commit = (raw: string): void => {
    const parsed = parse(raw);
    if (parsed !== undefined) context.commit(parsed);
  };
  if (context.field.values !== undefined) {
    return options(context, (raw) => parse(raw) ?? 0);
  }
  return numberField({
    label: context.label,
    value: show(context.value),
    readOnly: context.disabled,
    ...(context.validation === undefined ? {} : { validation: context.validation }),
    onCommit: commit,
  });
}

/** Целое: пустой ввод и дробь значением поля `i32` не являются (SER-5). */
function integerOf(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function numberOf(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Q16.16 показывается десятичной дробью, а в документ уходит целым числом
 * квантов — тем же, что лежит в файле. Перевод делает ядро (`fixed`), и второй
 * его реализации редактор не заводит (ED-1, CORE-3): автор правит величину, а
 * не её машинное представление, но документ получает ровно то, что ядро в нём
 * ожидает (FP-1).
 */
const fixedEditor: FieldEditor = {
  id: 'field.fixed',
  fieldType: 'fixed',
  descriptionKey: 'ui.field.fixed.description',
  render: (context) =>
    numeric(
      context,
      (value) => documentValue(typeof value === 'number' ? String(fixed.toFloat(value)) : ''),
      (raw) => {
        const parsed = numberOf(raw);
        return parsed === undefined ? undefined : fixed.fromFloat(parsed);
      },
    ),
};

const integerEditor: FieldEditor = {
  id: 'field.i32',
  fieldType: 'i32',
  descriptionKey: 'ui.field.i32.description',
  render: (context) => numeric(context, valueText, integerOf),
};

const numberEditor: FieldEditor = {
  id: 'field.number',
  fieldType: 'number',
  descriptionKey: 'ui.field.number.description',
  render: (context) => numeric(context, valueText, numberOf),
};

const integerJsonEditor: FieldEditor = {
  id: 'field.integer',
  fieldType: 'integer',
  descriptionKey: 'ui.field.integer.description',
  render: (context) => numeric(context, valueText, integerOf),
};

const stringEditor: FieldEditor = {
  id: 'field.string',
  fieldType: 'string',
  descriptionKey: 'ui.field.string.description',
  render: (context) =>
    context.field.values !== undefined
      ? options(context, (raw) => raw)
      : textField({
          label: context.label,
          value: valueText(context.value),
          readOnly: context.disabled,
          ...(context.validation === undefined ? {} : { validation: context.validation }),
          onCommit: (raw) => {
            context.commit(raw);
          },
        }),
};

/**
 * Булево — переключатель: у него, единственного из скаляров, положение
 * бегунка несёт значение само по себе, без чтения текста.
 */
const booleanEditor: FieldEditor = {
  id: 'field.boolean',
  fieldType: 'boolean',
  descriptionKey: 'ui.field.boolean.description',
  render: (context) =>
    toggle({
      label: context.label,
      on: context.value === true,
      disabled: context.disabled,
      ...(context.validation === undefined ? {} : { validation: context.validation }),
      onChange: (next) => {
        context.commit(next);
      },
    }),
};

export const BUILTIN_FIELD_EDITORS: readonly FieldEditor[] = Object.freeze([
  fixedEditor,
  integerEditor,
  integerJsonEditor,
  numberEditor,
  stringEditor,
  booleanEditor,
]);

export function registerFieldEditors(
  registry: ContributionRegistry<FieldEditor>,
  editors: readonly FieldEditor[] = BUILTIN_FIELD_EDITORS,
): ContributionRegistry<FieldEditor> {
  for (const editor of editors) registry.register(editor);
  return registry;
}

/** Реестр с набором по умолчанию — то, чем каркас обходится без сборки. */
export function defaultFieldEditors(): ContributionReader<FieldEditor> {
  return registerFieldEditors(createFieldEditorRegistry());
}

/** Редактор для типа поля; `undefined` — вклада на этот тип не зарегистрировано. */
export function editorFor(
  registry: ContributionReader<FieldEditor>,
  type: string,
): FieldEditor | undefined {
  return registry.all().find((editor) => editor.fieldType === type);
}
