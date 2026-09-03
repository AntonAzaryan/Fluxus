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
  type OperationParamSpec,
  type OperationRegistry,
} from '@fluxus/editor-core';
import { validateManifest, type EntityVisual, type VisualManifest } from '@fluxus/assets';
import { reasonOf } from '../reason.js';
import { VFX_AUTHORING_OPERATIONS } from './assetVfx.js';
import { ASSET_ID, DOCUMENT, asDocument, asNumber, asString } from './operationParams.js';

/** Идентификаторы операций над записями манифеста. */
export const VISUALS_OPERATIONS = {
  setModel: 'visuals.entry.setModel',
  setDefaultSkin: 'visuals.entry.setDefaultSkin',
  setSkinTexture: 'visuals.entry.setSkinTexture',
  setAnimation: 'visuals.entry.setAnimation',
  setSurfaceAlign: 'visuals.entry.setSurfaceAlign',
  setCurvatureMap: 'visuals.terrain.setCurvatureMap',
} as const;

/** Где в манифесте лежат записи (ASSET-6) — доменное знание вклада, а не каркаса. */
const ENTRIES_KEY = 'entities';
/** Поля записи, в которые пишет просмотрщик (ASSET-6). */
const MODEL_KEY = 'model';
const DEFAULT_SKIN_KEY = 'defaultSkin';
const SKINS_KEY = 'skins';
/** Таблицы маппинга клипов записи (`rendering` REND-4). */
const ANIMATIONS_KEY = 'animations';
const ANIMATION_TABLES = ['states', 'events'] as const;
export type AnimationTable = (typeof ANIMATION_TABLES)[number];
/** Параметры наклона по поверхности (`rendering` REND-10). */
const SURFACE_ALIGN_KEY = 'surfaceAlign';
/** Presentation-данные террейна арены: карта кривизны (`assets` ASSET-7). */
const TERRAIN_KEY = 'terrain';
const CURVATURE_MAP_KEY = 'curvatureMap';

const ENTRY: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.entry' };
const SKIN: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.skin' };
const SLOT: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.slot' };
const TABLE: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.animationTable' };
const STATE: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.animationName' };
const CLIP: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.clip' };
const FACTOR: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.alignFactor' };
const MAX_ANGLE: OperationParamSpec = {
  type: 'number',
  optional: true,
  descriptionKey: 'ui.operation.param.alignMaxAngle',
};
const CURVATURE: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.curvatureMap',
};

/** Путь записи манифеста внутри документа. */
function entryPath(entry: string, ...rest: readonly string[]): JsonPath {
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
      `параметр "${param}": ${reasonOf(error)}`,
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
const setEntryModelOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setModel,
  descriptionKey: 'ui.operation.visuals.entry.setModel',
  params: { document: DOCUMENT, entry: ENTRY, asset: ASSET_ID },
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
const setEntryDefaultSkinOperation: AuthoringOperation = {
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
const setEntrySkinTextureOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setSkinTexture,
  descriptionKey: 'ui.operation.visuals.entry.setSkinTexture',
  params: { document: DOCUMENT, entry: ENTRY, skin: SKIN, slot: SLOT, asset: ASSET_ID },
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

/**
 * Клип состояния или события записи (ED-14: «привязку сущностей к моделям,
 * скинам и АНИМАЦИЯМ»; `rendering` REND-4). Значение — подстрока имени клипа, а
 * не имя файла: какой клип модели ложится на состояние, решает манифест, а не
 * код рендера.
 *
 * Пустой клип СНИМАЕТ привязку, а не пишет пустую строку: пустая строка —
 * ошибка формата (ASSET-6), и завести её единственной операцией правки значило
 * бы сделать снятие привязки недостижимым из редактора — то есть заставить
 * автора править манифест руками, что ED-14 запрещает считать обязательным.
 * Опустевшая таблица и опустевший блок `animations` уходят следом: пустой
 * объект в документе — след правки, а не данные (ED-21).
 */
const setEntryAnimationOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setAnimation,
  descriptionKey: 'ui.operation.visuals.entry.setAnimation',
  params: { document: DOCUMENT, entry: ENTRY, table: TABLE, name: STATE, clip: CLIP },
  apply(ctx, params) {
    const id = VISUALS_OPERATIONS.setAnimation;
    const document = asDocument(params);
    const entry = asString(params, 'entry');
    requireEntry(id, ctx, document, entry);
    const table = asString(params, 'table');
    if (!(ANIMATION_TABLES as readonly string[]).includes(table)) {
      throw new OperationError(
        id,
        `параметр "table": таблица маппинга — одна из ${ANIMATION_TABLES.join(', ')} (REND-4)`,
        { param: 'table', received: table },
      );
    }
    const name = asString(params, 'name');
    if (name === '') {
      throw new OperationError(id, 'параметр "name": имя состояния или события пусто', {
        param: 'name',
        received: name,
      });
    }
    const clip = asString(params, 'clip');
    const before = ctx.readAt(document, entryPath(entry));
    const path = entryPath(entry, ANIMATIONS_KEY, table, name);
    if (clip === '') {
      if (ctx.readAt(document, path) === undefined) return undefined;
      ctx.removeValue(document, path);
      pruneEmpty(ctx, document, entryPath(entry, ANIMATIONS_KEY, table));
      pruneEmpty(ctx, document, entryPath(entry, ANIMATIONS_KEY));
      return undefined;
    }
    ctx.setValue(document, path, clip);
    checkEntry(id, ctx, document, entry, before, { param: 'clip', received: clip });
    return undefined;
  },
};

/** Опустевшая карта уходит из документа: пустой объект — след правки, а не данные. */
function pruneEmpty(ctx: OperationContext, document: DocumentId, path: JsonPath): void {
  const value = ctx.readAt(document, path);
  if (isJsonObject(value) && Object.keys(value).length === 0) ctx.removeValue(document, path);
}

/**
 * Параметры наклона по поверхности записи (ED-14, `rendering` REND-10). Блок
 * пишется ЦЕЛИКОМ, а не по полю: `factor` в нём обязателен (ASSET-6), и
 * операция «записать только лимит угла» оставила бы в документе заведомо
 * невалидный блок, который тут же отвергла бы проверка владельца.
 *
 * Отсутствующий лимит угла — снятие поля, а не ноль: ноль означает «всегда
 * вертикален», а отсутствие — «лимита нет» (REND-10).
 */
const setEntrySurfaceAlignOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setSurfaceAlign,
  descriptionKey: 'ui.operation.visuals.entry.setSurfaceAlign',
  params: { document: DOCUMENT, entry: ENTRY, factor: FACTOR, maxAngleDeg: MAX_ANGLE },
  apply(ctx, params) {
    const id = VISUALS_OPERATIONS.setSurfaceAlign;
    const document = asDocument(params);
    const entry = asString(params, 'entry');
    requireEntry(id, ctx, document, entry);
    const factor = asNumber(params, 'factor');
    const maxAngleDeg = params.maxAngleDeg;
    const before = ctx.readAt(document, entryPath(entry));
    ctx.setValue(document, entryPath(entry, SURFACE_ALIGN_KEY), {
      factor,
      ...(typeof maxAngleDeg === 'number' ? { maxAngleDeg } : {}),
    });
    // Диапазоны — правила формата (ASSET-6, REND-10), и проверяет их владелец.
    checkEntry(id, ctx, document, entry, before, { param: 'factor', received: factor });
    return undefined;
  },
};

/**
 * Ссылка манифеста на карту кривизны арены (ED-14: «ссылки на ассеты арены»;
 * `assets` ASSET-7). Живёт не в записи, а в секции террейна манифеста: карта
 * принадлежит арене, а не виду.
 *
 * Пустой ID снимает ссылку — по тому же основанию, что и пустой клип: пустая
 * строка тут ошибка формата, и без снятия автор чинил бы документ руками.
 */
const setCurvatureMapOperation: AuthoringOperation = {
  id: VISUALS_OPERATIONS.setCurvatureMap,
  descriptionKey: 'ui.operation.visuals.terrain.setCurvatureMap',
  params: { document: DOCUMENT, asset: CURVATURE },
  apply(ctx, params) {
    const id = VISUALS_OPERATIONS.setCurvatureMap;
    const document = asDocument(params);
    const raw = asString(params, 'asset');
    const path: JsonPath = [TERRAIN_KEY, CURVATURE_MAP_KEY];
    if (raw === '') {
      if (ctx.readAt(document, path) !== undefined) ctx.removeValue(document, path);
      pruneEmpty(ctx, document, [TERRAIN_KEY]);
      return undefined;
    }
    ctx.setValue(document, path, requireAssetId(id, 'asset', raw));
    return undefined;
  },
};

export const VISUALS_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  setEntryModelOperation,
  setEntryDefaultSkinOperation,
  setEntrySkinTextureOperation,
  setEntryAnimationOperation,
  setEntrySurfaceAlignOperation,
  setCurvatureMapOperation,
  // Секции VFX того же документа (`assetVfx.ts`, REND-23, REND-24) — здесь, а
  // не своей точкой регистрации: своя понадобилась эффектам камеры ради
  // ПАРАМЕТРА (машинного описания типов CAM-9), которого у этих операций нет, а
  // второе место регистрации есть второе место, где о наборе можно забыть.
  ...VFX_AUTHORING_OPERATIONS,
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
