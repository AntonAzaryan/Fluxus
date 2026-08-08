/**
 * @contribution Операции над записью манифеста визуалов (ED-14, ED-20) — вклад
 * в слой операций авторинга (ED-29), а не часть каркаса.
 *
 * ED-20 не оставляет выбора в двух вещах сразу: «Выбор модели, текстуры и скина
 * для записи манифеста SHALL производиться из просмотрщика; ручной ввод пути
 * MUST NOT быть обязательным», а ED-29 добавляет, что всякая правка документа
 * идёт зарегистрированной операцией. Отсюда три операции ниже — по одной на
 * каждое из трёх названных ED-20 назначений.
 *
 * ## Почему это не `document.setValue` с готовым путём
 *
 * Соблазн есть: каждая из трёх пишет ровно одно место. Но пишет она его В
 * ЗАПИСЬ МАНИФЕСТА, а где внутри записи лежат модель, скин по умолчанию и
 * подмена слота — знание формата (ASSET-6). Оставь его в интерфейсе, и оно
 * разъедется по кнопкам: три места, где путь собран руками, и ни одного, где
 * его можно проверить. Здесь же с ним рядом живут и проверки, которых у общей
 * операции быть не может: запись существует (ED-19), а ID ассета — путь от
 * корня дерева контента (ASSET-2), а не URL и не выход за корень. Внешний
 * потребитель, вызывающий операцию без интерфейса, получает те же проверки —
 * второго пути правки не заводится.
 *
 * ## Чего здесь нет: правил, у которых есть владелец
 *
 * Что такое законная запись манифеста — номер слота текстуры, скин, на который
 * ссылается `defaultSkin`, — знает модуль ассетов (`validateManifest`, ASSET-6),
 * и своей копии этих правил редактор не заводит: вторая реализация правила с
 * одним источником истины расходится с ним по определению (ED-1, CORE-3).
 * Поэтому правленую запись операция отдаёт на проверку владельцу (`checkEntry`),
 * а не сверяет сама.
 *
 * Обратное — доменная операция ради переименования уже имеющегося действия —
 * по-прежнему отвергается: удаление записи манифеста своей операции не
 * получает, `document.removeValue` делает ровно то, что нужно.
 */
import {
  OperationError,
  isJsonObject,
  normalizeContentPath,
  type AuthoringOperation,
  type DocumentId,
  type JsonPath,
  type JsonValue,
  type OperationContext,
  type OperationParams,
  type OperationParamSpec,
  type OperationRegistry,
} from '@game-mvp/editor-core';
import { validateManifest, type EntityVisual, type VisualManifest } from '@game-mvp/assets';

/** Идентификаторы операций над записями манифеста. */
export const VISUALS_OPERATIONS = {
  setModel: 'visuals.entry.setModel',
  setDefaultSkin: 'visuals.entry.setDefaultSkin',
  setSkinTexture: 'visuals.entry.setSkinTexture',
} as const;

/** Где в манифесте лежат записи (ASSET-6) — доменное знание вклада, а не каркаса. */
export const ENTRIES_KEY = 'entities';
/** Поля записи, в которые пишет просмотрщик (ASSET-6). */
export const MODEL_KEY = 'model';
export const DEFAULT_SKIN_KEY = 'defaultSkin';
export const SKINS_KEY = 'skins';

const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};
const ENTRY: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.entry' };
const ASSET: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.assetId' };
const SKIN: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.skin' };
const SLOT: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.slot' };

/*
 * Читатели ниже — приведение типа, а не вторая проверка: схему параметров уже
 * сверил слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams): DocumentId => params['document'] as DocumentId;
const asString = (params: OperationParams, name: string): string => params[name] as string;

/** Путь записи манифеста внутри документа. */
export function entryPath(entry: string, ...rest: readonly string[]): JsonPath {
  return [ENTRIES_KEY, entry, ...rest];
}

/**
 * Запись, в которую пишет операция, обязана существовать. Заводить её походя
 * нельзя: запись манифеста — половина пары «prefab + запись» (ED-19), и
 * созданная в одиночку она рассинхронизирует пару, которую тут же подсветит
 * валидация. Создание сущности авторинга — отдельное действие, а не побочный
 * эффект выбора модели.
 */
function requireEntry(operationId: string, ctx: OperationContext, document: DocumentId, entry: string): void {
  if (entry === '') {
    throw new OperationError(operationId, 'параметр "entry": имя записи манифеста пусто', {
      param: 'entry',
      received: entry,
    });
  }
  if (ctx.readAt(document, entryPath(entry)) === undefined) {
    throw new OperationError(
      operationId,
      `записи "${entry}" в манифесте нет — выбор модели её не заводит (ED-19)`,
      { param: 'entry', received: entry },
    );
  }
}

/**
 * ID ассета — путь от корня дерева контента и ничего кроме (ASSET-2). Проверка
 * здесь, а не в интерфейсе: операция исполнима и без него (ED-29), и «в запись
 * попадает ID ассета» (ED-20) обязано выполняться на обоих путях.
 */
function requireAssetId(operationId: string, param: string, raw: string): string {
  if (raw === '') {
    throw new OperationError(operationId, `параметр "${param}": ID ассета пуст`, {
      param,
      received: raw,
    });
  }
  let normalized: string;
  try {
    normalized = normalizeContentPath(raw);
  } catch (error) {
    throw new OperationError(
      operationId,
      `параметр "${param}": ${error instanceof Error ? error.message : String(error)}`,
      { param, received: raw },
    );
  }
  if (normalized !== raw) {
    throw new OperationError(
      operationId,
      `параметр "${param}": ID ассета — путь от корня дерева контента (ASSET-2), а не "${raw}"`,
      { param, received: raw },
    );
  }
  return normalized;
}

/** Ошибки записи глазами её владельца: запись оборачивается в манифест из неё одной. */
function entryErrors(entry: string, value: JsonValue | undefined): readonly string[] {
  const checked = validateManifest({ entities: { [entry]: value ?? null } });
  return checked.ok ? [] : checked.errors;
}

/**
 * Правленую запись проверяет модуль ассетов, а не операция (ED-1, CORE-3):
 * номер слота текстуры и скин, на который ссылается `defaultSkin`, — правила
 * формата, и живут они там же, где формат.
 *
 * Спрашивается владелец после записи и о РАЗНИЦЕ. Запись, сломанную до
 * операции, показывает валидация документа (ED-8); отказывать выбору модели за
 * чужое нарушение значило бы не дать автору его исправить. Полуправки отказ не
 * оставляет: записанное упавшей операцией откатывает слой операций (ED-29).
 */
function checkEntry(
  operationId: string,
  ctx: OperationContext,
  document: DocumentId,
  entry: string,
  before: JsonValue | undefined,
  details: { param: string; received: JsonValue },
): void {
  const known = new Set(entryErrors(entry, before));
  const introduced = entryErrors(entry, ctx.readAt(document, entryPath(entry))).filter(
    (error) => !known.has(error),
  );
  if (introduced.length > 0) {
    throw new OperationError(operationId, introduced.join('; '), details);
  }
}

/**
 * Модель записи (ED-20). Пишет ровно поле `model`: набор рисуемых частей,
 * скины и маппинг анимаций — соседние поля той же записи, и выбор модели их не
 * трогает. Что при этом пересобрать в кадре, решает подсистема (REND-17).
 */
export const setEntryModelOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setModel,
  descriptionKey: 'ui.operation.visuals.entry.setModel',
  params: { document: DOCUMENT, entry: ENTRY, asset: ASSET },
  apply(ctx, params) {
    const id = VISUALS_OPERATIONS.setModel;
    const document = asDocument(params);
    const entry = asString(params, 'entry');
    requireEntry(id, ctx, document, entry);
    const asset = requireAssetId(id, 'asset', asString(params, 'asset'));
    ctx.setValue(document, entryPath(entry, MODEL_KEY), asset);
    return undefined;
  },
};

/**
 * Скин записи по умолчанию (ASSET-6). Скин обязан быть описан самой записью:
 * `defaultSkin`, которому не соответствует ни одна подмена, — не выбор, а
 * опечатка, и рантайм на неё ответит молчанием.
 */
export const setEntryDefaultSkinOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setDefaultSkin,
  descriptionKey: 'ui.operation.visuals.entry.setDefaultSkin',
  params: { document: DOCUMENT, entry: ENTRY, skin: SKIN },
  apply(ctx, params) {
    const id = VISUALS_OPERATIONS.setDefaultSkin;
    const document = asDocument(params);
    const entry = asString(params, 'entry');
    requireEntry(id, ctx, document, entry);
    const skin = asString(params, 'skin');
    const before = ctx.readAt(document, entryPath(entry));
    ctx.setValue(document, entryPath(entry, DEFAULT_SKIN_KEY), skin);
    // Описан ли скин записью — правило формата (ASSET-6), и отвечает на него
    // модуль ассетов: своей копии этой проверки у операции нет.
    checkEntry(id, ctx, document, entry, before, { param: 'skin', received: skin });
    return undefined;
  },
};

/**
 * Текстура слота внутри скина (ASSET-6, REND-6): «варианты одной модели — разные
 * скины, а не копии модели». Скин, которого в записи ещё нет, эта операция
 * заводит: подмена и есть весь скин, и первая его подмена — то же действие, что
 * следующая. Записи это не касается — она уже существует.
 */
export const setEntrySkinTextureOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setSkinTexture,
  descriptionKey: 'ui.operation.visuals.entry.setSkinTexture',
  params: { document: DOCUMENT, entry: ENTRY, skin: SKIN, slot: SLOT, asset: ASSET },
  apply(ctx, params) {
    const id = VISUALS_OPERATIONS.setSkinTexture;
    const document = asDocument(params);
    const entry = asString(params, 'entry');
    requireEntry(id, ctx, document, entry);
    const skin = asString(params, 'skin');
    if (skin === '') {
      throw new OperationError(id, 'параметр "skin": имя скина пусто', {
        param: 'skin',
        received: skin,
      });
    }
    const slot = asString(params, 'slot');
    const asset = requireAssetId(id, 'asset', asString(params, 'asset'));
    const before = ctx.readAt(document, entryPath(entry));
    ctx.setValue(document, entryPath(entry, SKINS_KEY, skin, slot), asset);
    // Номер слота — правило формата (ASSET-5, REND-6), и проверяет его тот же
    // модуль ассетов, что проверяет манифест на загрузке.
    checkEntry(id, ctx, document, entry, before, { param: 'slot', received: slot });
    return undefined;
  },
};

export const VISUALS_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  setEntryModelOperation,
  setEntryDefaultSkinOperation,
  setEntrySkinTextureOperation,
]);

/**
 * Регистрация вкладом (ED-25): набор операций приносит тот, кто собирает
 * редактор, — базовые операции ядра редактора при этом не правятся.
 */
export function registerVisualsOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of VISUALS_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}

/**
 * Манифест из значения открытого документа (ASSET-6). Разбирает и проверяет его
 * модуль ассетов — тот же `validateManifest`, которым он проверяется на
 * загрузке: второй реализации правила, у которого есть источник, быть не должно
 * (ED-1, CORE-3). Сломанный документ отсюда уходит причиной, а не пустым
 * манифестом: пустой манифест — это «записей нет», совсем другое утверждение.
 */
export function manifestOf(value: JsonValue | undefined): VisualManifest {
  const checked = validateManifest(value);
  if (!checked.ok) throw new Error(`манифест визуалов: ${checked.errors.join('; ')}`);
  return checked.manifest;
}

/** Имена записей манифеста в порядке документа — из них автор и выбирает. */
export function entryNames(value: JsonValue | undefined): readonly string[] {
  if (!isJsonObject(value)) return [];
  const entries = value[ENTRIES_KEY];
  return isJsonObject(entries) ? Object.keys(entries) : [];
}

/** Имена скинов записи (REND-6); запись без подмен скинов не имеет вовсе. */
export function skinNames(entry: EntityVisual | null): readonly string[] {
  return entry === null ? [] : Object.keys(entry.skins ?? {});
}
