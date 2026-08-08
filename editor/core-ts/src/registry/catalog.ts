/**
 * Машинное само-описание редактора (ED-30): каталог операций авторинга с
 * параметрами, набор рабочих областей, набор типов редактируемого и правила
 * валидации, которыми эти типы проверяются.
 *
 * Каталог собирается из тех же реестров (ED-25), из которых строится интерфейс,
 * и собирается в момент запроса. Хранимого каталога нет намеренно: хранимый —
 * это второе описание, расходящееся с первым, ровно как ручная таблица ключей,
 * которую запрещает ED-28. По той же причине здесь нет ни одной формулировки
 * описания: тексты приходят из строковых ресурсов через `DescriptionResolver`,
 * а ключи — от самих вкладов и операций.
 *
 * Реестр операций каталогу не принадлежит — он живёт в слое операций
 * (`../operations/`), и его само-описание строит он же (`describeOperations`).
 * Каталог берёт это описание типом, а не своей похожей формой: одинаковая по
 * составу пара интерфейсов — второе описание операции, расходящееся с первым
 * там, где о нём забыли, ровно как отдельно поддерживаемый файл каталога.
 */
import type { OperationDescription, OperationParamDescription } from '../operations/registry.js';
import type { ContributionReader } from './contribution.js';
import { compareIds } from './contribution.js';
import type { DescriptionResolver } from './descriptions.js';
import type {
  ValidationRuleContribution,
  ViewportToolContribution,
  WorkspaceAreaContribution,
} from './kinds.js';

/**
 * Источник операций: функция, а не готовый список. Каталог строится в момент
 * запроса, и список, переданный значением, был бы снимком — тем самым вторым
 * описанием, только с коротким сроком жизни.
 */
export type OperationCatalogSource = () => readonly OperationDescription[];

/**
 * Реестры, из которых собирается каталог. Тип — на чтение и по минимуму: набор
 * реестров редактора (`EditorContributions`) подходит сюда как есть, но каталог
 * не требует именно его.
 */
export interface ContributionCatalogSource {
  readonly areas: ContributionReader<WorkspaceAreaContribution>;
  readonly viewportTools: ContributionReader<ViewportToolContribution>;
  readonly validationRules: ContributionReader<ValidationRuleContribution>;
}

export interface CatalogSources {
  readonly contributions: ContributionCatalogSource;
  readonly operations: OperationCatalogSource;
  /** Резолвер бандла `en` (ED-28): те же строки, что видит человек. */
  readonly descriptions: DescriptionResolver;
}

/**
 * Записи каталога отдают отсутствующее как `null`, а не `undefined`: каталог
 * уходит машинному потребителю, а `undefined` исчезает при сериализации в JSON,
 * и «горячей клавиши нет» становится неотличимо от «поля нет вовсе».
 */
export interface CatalogParameter extends OperationParamDescription {
  readonly description: string;
}

export interface CatalogOperation {
  readonly id: string;
  readonly descriptionKey: string;
  readonly description: string;
  readonly params: readonly CatalogParameter[];
}

export interface CatalogArea {
  readonly id: string;
  readonly descriptionKey: string;
  readonly description: string;
  readonly hotkey: string | null;
  readonly editableTypes: readonly string[];
  readonly tools: readonly string[];
}

export interface CatalogEditableType {
  readonly id: string;
  readonly descriptionKey: string;
  readonly description: string;
  readonly schemaId: string | null;
  readonly areas: readonly string[];
  /** id правил, применимых к типу; сами правила — в `validationRules` каталога. */
  readonly validationRules: readonly string[];
}

/**
 * Правило валидации в каталоге. Записью, а не только id в списке типа: ED-30
 * требует от каталога описаний, а «правило `core.scene` применимо к сцене»
 * объясняет внешнему потребителю ровно ничего — по такому каталогу нельзя ни
 * понять отказ, ни решить, что чинить. Описание при этом то же самое, что видит
 * человек на английской локали: второго набора формулировок для машины ED-30 не
 * допускает, поэтому текст приходит из бандла по ключу вклада.
 */
export interface CatalogValidationRule {
  readonly id: string;
  readonly descriptionKey: string;
  readonly description: string;
  readonly appliesTo: readonly string[];
}

export interface EditorCatalog {
  readonly operations: readonly CatalogOperation[];
  readonly areas: readonly CatalogArea[];
  readonly editableTypes: readonly CatalogEditableType[];
  readonly validationRules: readonly CatalogValidationRule[];
}

/** Собирает каталог из реестров. Вызывается на каждый запрос, ничего не кэширует. */
export function buildEditorCatalog(sources: CatalogSources): EditorCatalog {
  const { contributions, operations, descriptions } = sources;
  const describe = (key: string): string => descriptions.describe(key);

  const catalogOperations = operations().map(
    (operation): CatalogOperation => ({
      id: operation.id,
      descriptionKey: operation.descriptionKey,
      description: describe(operation.descriptionKey),
      params: operation.params.map((parameter) => ({
        ...parameter,
        description: describe(parameter.descriptionKey),
      })),
    }),
  );

  const areas = contributions.areas.all();
  const tools = contributions.viewportTools.all();
  const rules = contributions.validationRules.all();
  const catalogAreas = areas.map(
    (area): CatalogArea => ({
      id: area.id,
      descriptionKey: area.descriptionKey,
      description: describe(area.descriptionKey),
      hotkey: area.hotkey ?? null,
      editableTypes: area.editableTypes.map((type) => type.id).sort(compareIds),
      // Инструмент, заявивший незарегистрированную область, просто нигде не
      // виден: набор областей сборки — не ошибка инструмента.
      tools: tools.filter((tool) => tool.areas.includes(area.id)).map((tool) => tool.id),
    }),
  );

  return {
    operations: catalogOperations,
    areas: catalogAreas,
    editableTypes: collectEditableTypes(areas, rules, describe),
    validationRules: rules.map(
      (rule): CatalogValidationRule => ({
        id: rule.id,
        descriptionKey: rule.descriptionKey,
        description: describe(rule.descriptionKey),
        appliesTo: [...rule.appliesTo].sort(compareIds),
      }),
    ),
  };
}

/**
 * Типы редактируемого приходят от областей, которые их правят. Один тип могут
 * вносить несколько областей — записи сливаются; расхождение по схеме или по
 * ключу описания при этом не сливается, а падает: две области, считающие один
 * тип разным, — дефект, который иначе разошёлся бы молча, по выбору первой
 * попавшейся.
 */
function collectEditableTypes(
  areas: readonly WorkspaceAreaContribution[],
  rules: readonly ValidationRuleContribution[],
  describe: (key: string) => string,
): readonly CatalogEditableType[] {
  const declared = new Map<string, { schemaId: string | null; descriptionKey: string }>();
  const byType = new Map<string, string[]>();

  for (const area of areas) {
    for (const type of area.editableTypes) {
      const current = { schemaId: type.schemaId ?? null, descriptionKey: type.descriptionKey };
      const known = declared.get(type.id);
      if (known !== undefined && !sameDeclaration(known, current)) {
        throw new Error(
          `каталог: тип редактируемого "${type.id}" объявлен областями по-разному` +
            ` (схемы "${known.schemaId}" и "${current.schemaId}",` +
            ` ключи "${known.descriptionKey}" и "${current.descriptionKey}")`,
        );
      }
      declared.set(type.id, current);
      const declaring = byType.get(type.id);
      if (declaring === undefined) byType.set(type.id, [area.id]);
      else declaring.push(area.id);
    }
  }

  return [...byType.keys()].sort(compareIds).map((id): CatalogEditableType => {
    const type = declared.get(id)!;
    return {
      id,
      descriptionKey: type.descriptionKey,
      description: describe(type.descriptionKey),
      schemaId: type.schemaId,
      areas: byType.get(id) ?? [],
      validationRules: rules.filter((rule) => rule.appliesTo.includes(id)).map((rule) => rule.id),
    };
  });
}

function sameDeclaration(
  a: { schemaId: string | null; descriptionKey: string },
  b: { schemaId: string | null; descriptionKey: string },
): boolean {
  return a.schemaId === b.schemaId && a.descriptionKey === b.descriptionKey;
}
