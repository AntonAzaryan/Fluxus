/**
 * Машинное само-описание редактора (ED-30): каталог операций авторинга с
 * параметрами, набор рабочих областей и набор типов редактируемого.
 *
 * Каталог собирается из тех же реестров (ED-25), из которых строится интерфейс,
 * и собирается в момент запроса. Хранимого каталога нет намеренно: хранимый —
 * это второе описание, расходящееся с первым, ровно как ручная таблица ключей,
 * которую запрещает ED-28. По той же причине здесь нет ни одной формулировки
 * описания: тексты приходят из строковых ресурсов через `DescriptionResolver`,
 * а ключи — от самих вкладов и операций.
 *
 * Реестр операций каталогу не принадлежит — он живёт в слое операций
 * (`../operations/`). Зависимость выражена узким интерфейсом чтения
 * (`OperationCatalogSource`): каталог знает про операции ровно то, что обязан
 * показать, и ни один из двух модулей не владеет другим.
 */
import type { ContributionReader } from './contribution.js';
import { compareIds } from './contribution.js';
import type { DescriptionResolver } from './descriptions.js';
import type {
  ValidationRuleContribution,
  ViewportToolContribution,
  WorkspaceAreaContribution,
} from './kinds.js';

/** Параметр операции — то, что каталог обязан показать про него (ED-30). */
export interface OperationParameterView {
  readonly name: string;
  /** Тип параметра в словаре слоя операций; каталог его не толкует. */
  readonly type: string;
  readonly optional: boolean;
  /**
   * Значение параметра живёт только в текущей сессии — таков сессионный
   * дескриптор записи расстановки. Каталог обязан говорить об этом явно:
   * ссылка, сохранённая между сессиями, недействительна.
   */
  readonly sessionScoped: boolean;
  readonly descriptionKey: string;
}

/** Операция авторинга (ED-29) глазами каталога. */
export interface OperationView {
  readonly id: string;
  readonly descriptionKey: string;
  readonly params: readonly OperationParameterView[];
}

/**
 * Источник операций: функция, а не готовый список. Каталог строится в момент
 * запроса, и список, переданный значением, был бы снимком — тем самым вторым
 * описанием, только с коротким сроком жизни.
 */
export type OperationCatalogSource = () => readonly OperationView[];

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
export interface CatalogParameter extends OperationParameterView {
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
  readonly validationRules: readonly string[];
}

export interface EditorCatalog {
  readonly operations: readonly CatalogOperation[];
  readonly areas: readonly CatalogArea[];
  readonly editableTypes: readonly CatalogEditableType[];
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
    editableTypes: collectEditableTypes(areas, contributions.validationRules.all(), describe),
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
