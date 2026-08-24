/**
 * Инспектор выбранного — третья зона скелета (ED-24), собранная из схемы
 * редактируемого и ни из чего больше.
 *
 * Что здесь происходит и почему именно здесь:
 *
 * - **набор строк** — обход `InspectorSubject`, который принёс вклад, прочитав
 *   реестр схем. Ни одного имени поля в этом файле нет: поле, добавленное в
 *   схему, появляется строкой без правки кода редактора (ED-24, ED-2);
 * - **контрол строки** — из реестра редакторов поля по типу поля (ED-25).
 *   Типа, на который вклада нет, инспектор не прячет и не выдумывает ему
 *   контрол: поле показано со своим типом и недоступно правке — «появляется в
 *   инспекторе со своим типом» выполняется и до того, как для типа написан
 *   редактор;
 * - **подсказка** — ключ вычисляется из пути поля в схеме одной функцией слоя
 *   ресурсов (`descriptionKey`), а разрешается цепочкой «локаль → `en` → сам
 *   ключ» (ED-28). Пустой подсказки не бывает: показ ключа и есть видимый
 *   признак отсутствия ресурса;
 * - **находка валидации** — из структурного отчёта по адресу места
 *   (`report.at`, ED-8, ED-30). Иконку, положение и текст причины ставит один
 *   вызов `withValidation` внутри контрола, поэтому «покрасить и не объяснить»
 *   здесь невозможно (ED-22);
 * - **правка** — зарегистрированной операцией и только ею (ED-29). Прямой
 *   записи в документ у инспектора нет: сессия отдаёт значение замороженным.
 *
 * Границей операции служит подтверждение ввода, а не нажатие клавиши (W1-3):
 * контролы отдают значение по `change`, и от фокуса до подтверждения выходит
 * одна операция и одна запись истории (ED-18).
 */
import {
  descriptionKey,
  getAtPath,
  type EditorSession,
  type JsonPath,
  type JsonValue,
  type StringResources,
  type ValidationIssue,
  type ValidationReport,
} from '@fluxus/editor-core';
import { children, documentValue, el, issueText, resourceText, type UiNode } from '../dom/node.js';
import { statusChip } from '../widgets/chip.js';
import { textField } from '../widgets/field.js';
import { fieldTable, type FieldGroupSpec, type FieldRowSpec } from '../widgets/fieldTable.js';
import type { ValidationState } from '../widgets/validation.js';
import { editorFor, type FieldEditor, type FieldEditorContext } from './editors.js';
import {
  RECORD_VALUE_OPERATION,
  VALUE_OPERATION,
  type InspectorSubject,
  type SchemaField,
  type SubjectAddress,
} from './schema.js';
import type { ContributionReader } from '@fluxus/editor-core';

export interface InspectorSpec {
  readonly resources: StringResources;
  readonly session: EditorSession;
  /** Реестр редакторов поля (ED-25) — один на редактор, а не свой у области. */
  readonly fieldEditors: ContributionReader<FieldEditor>;
  /** Что показывать; `null` — ничего не выбрано. */
  readonly subject: InspectorSubject | null;
  /** Последний отчёт валидации (ED-8); `null` — прогонов ещё не было. */
  readonly report?: ValidationReport | null;
  /** Правка недоступна целиком: превью запрещает операции авторинга (ED-9, ED-26). */
  readonly disabled?: boolean;
  /** Куда уходит причина отказавшей операции (ED-8); нет — отказ поднимается вызывающему. */
  readonly onFailure?: (reason: string) => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Корень субъекта в документе: у записи он свой и едет вместе с ней (ED-29). */
function rootOf(session: EditorSession, address: SubjectAddress): JsonPath | null {
  if (address.record === undefined) return address.root ?? [];
  const located = session.resolveDescriptor(address.documentId, address.record);
  // Запись удалили, пока она была выбрана: показывать её поля больше нечем, и
  // выдумывать им адрес — значит писать правку в чужое место.
  return located?.path ?? null;
}

/**
 * Состояние строки по находкам отчёта (ED-8, ED-22): иконку, положение и текст
 * причины ставит один вызов `withValidation`, а сюда приходит только то, из чего
 * он их берёт. Функция общая для инспектора и навигатора: строка дерева
 * показывает нарушение тем же способом, что строка полей, и второго перевода
 * находки в состояние в пакете нет.
 *
 * Находок по одному месту бывает несколько, а признак у строки один: берётся
 * худшая по важности — ошибка важнее предупреждения, потому что её ядро
 * отвергнет, а предупреждение переживёт.
 */
export function issueState(
  resources: StringResources,
  issues: readonly ValidationIssue[],
): ValidationState | undefined {
  const issue = issues.find((candidate) => candidate.severity === 'error') ?? issues[0];
  if (issue === undefined) return undefined;
  return { severity: issue.severity, reason: issueText(resources, issue) };
}

function validationOf(
  spec: InspectorSpec,
  documentId: string,
  path: JsonPath,
): ValidationState | undefined {
  const report = spec.report ?? null;
  return report === null ? undefined : issueState(spec.resources, report.at(documentId, path));
}

/** Строка поля, которому не нашлось редактора: значение видно, правка — нет. */
function rawControl(context: FieldEditorContext): UiNode {
  return textField({
    label: context.label,
    value: documentValue(context.value === undefined ? '' : JSON.stringify(context.value)),
    readOnly: true,
    ...(context.validation === undefined ? {} : { validation: context.validation }),
  });
}

function fieldRowOf(
  spec: InspectorSpec,
  address: SubjectAddress,
  root: JsonPath,
  field: SchemaField,
): FieldRowSpec {
  const { session, resources } = spec;
  const path: JsonPath = [...root, ...field.path];
  const value = getAtPath(session.documentValue(address.documentId), path);
  const writable =
    spec.disabled !== true &&
    field.readOnly !== true &&
    session.operations.has(address.record === undefined ? VALUE_OPERATION : RECORD_VALUE_OPERATION);
  const validation = validationOf(spec, address.documentId, path);
  const label = documentValue(field.name);

  const context: FieldEditorContext = {
    resources,
    field,
    value,
    label,
    disabled: !writable,
    ...(validation === undefined ? {} : { validation }),
    commit: (next: JsonValue) => {
      try {
        // Единственный путь правки — зарегистрированная операция (ED-29).
        // Запись внутри отслеживаемого списка адресуется дескриптором: путь с
        // индексом сломался бы от удаления соседней записи.
        if (address.record === undefined) {
          session.applyOperation(VALUE_OPERATION, {
            document: address.documentId,
            path: [...path],
            value: next,
          });
        } else {
          session.applyOperation(RECORD_VALUE_OPERATION, {
            document: address.documentId,
            record: address.record,
            path: [...field.path],
            value: next,
          });
        }
      } catch (error) {
        // Отказ операции — структурный (ED-30), и молчать о нём нельзя: автор
        // видел бы, как значение возвращается к прежнему, без причины.
        if (spec.onFailure === undefined) throw error;
        spec.onFailure(message(error));
      }
    },
  };

  const editor = editorFor(spec.fieldEditors, field.type);
  return {
    label,
    control: editor === undefined ? rawControl(context) : editor.render(context),
    // Ключ описания вычисляется из пути поля в схеме, а цепочка «локаль → `en`
    // → сам ключ» живёт в слое ресурсов (ED-28). Таблицы соответствий здесь нет
    // и завести её негде: ключ не хранится, а считается.
    hint: resourceText(resources, descriptionKey(field.description)),
    // Признак типа — данные схемы, а не подпись интерфейса: он не локализуется.
    note: documentValue(field.type),
  };
}

/**
 * Инспектор целиком: заголовок зоны, подпись выбранного и таблица его полей.
 * Собирается каркасом, а не областью, потому что ED-24 требует одинакового
 * места и одинакового устройства инспектора во всех областях.
 */
export function inspectorPanel(spec: InspectorSpec): UiNode {
  const { resources, subject } = spec;
  const root = subject === null ? null : rootOf(spec.session, subject.address);

  const groups: FieldGroupSpec[] =
    subject === null || root === null
      ? []
      : subject.groups.map((group) => ({
          label: documentValue(group.name),
          rows: group.fields.map((field) => fieldRowOf(spec, subject.address, root, field)),
        }));

  const rows = groups.reduce((total, group) => total + group.rows.length, 0);
  return el('div', {
    children: children(
      el('div', {
        classes: ['fx-section'],
        children: children(
          el('span', { text: resourceText(resources, 'ui.inspector.title') }),
          subject?.title === undefined
            ? undefined
            : el('span', {
                classes: ['fx-row__trailing'],
                children: [statusChip({ label: subject.title })],
              }),
        ),
      }),
      rows === 0
        ? el('div', { classes: ['fx-row'], text: resourceText(resources, 'ui.inspector.empty') })
        : fieldTable({ label: resourceText(resources, 'ui.inspector.fields'), groups }),
    ),
  });
}
