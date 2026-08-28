/**
 * @contribution Операции над секцией эффектов камеры манифеста визуалов
 * (ED-14, ASSET-8) — вклад в слой операций авторинга (ED-29), а не часть
 * каркаса.
 *
 * ED-14 требует таблиц «событие тика → импульсный эффект» и «состояние
 * сущности → длящийся эффект», правимых из редактора; ED-29 — чтобы всякая
 * правка документа шла зарегистрированной операцией. Отсюда две операции ниже:
 * привязка (она же перетипизация) и одно число.
 *
 * ## Почему это не `document.setValue` с готовым путём
 *
 * Причина та же, что у соседа (`assetVisuals.ts`): где внутри манифеста лежат
 * таблицы секции — знание формата (ASSET-8), а не кнопки. Здесь к нему
 * добавляется второе знание, которого у общей операции быть не может: что
 * законно в записи, говорит машинное описание типов эффектов (`camera` CAM-9),
 * и сверяются с ним обе операции. Внешний потребитель, вызывающий операцию без
 * интерфейса, получает те же проверки — второго пути правки секции не заводится.
 *
 * ## Списка типов здесь нет
 *
 * Ни в каком виде: описание приходит параметром при сборке набора операций
 * (`cameraEffectsOperations`), а умолчание — описание сборки камеры. Набранный
 * здесь перечень был бы вторым перечнем к перечню камеры (CAM-9) и разошёлся бы
 * с ним молча — ровно то, что ED-14 запрещает прямым текстом.
 *
 * ## Чего здесь нет: операции удаления
 *
 * Удаление записи своей операции не получает — `document.removeValue` делает
 * ровно это. Доменная операция ради переименования уже имеющегося действия
 * отвергнута по тем же основаниям, по каким её нет у соседа. Дотянуться до неё
 * из таблицы автор при этом обязан (`REMOVE_BINDING_OPERATION`, кнопка строки в
 * `assets.ts`): «удаление есть в слое операций» и «удаление недостижимо из
 * интерфейса» вместе означали бы правку JSON руками, чего ED-14 не допускает.
 */
import {
  OperationError,
  isJsonArray,
  isJsonObject,
  type AuthoringOperation,
  type DocumentId,
  type JsonPath,
  type JsonValue,
  type OperationContext,
  type OperationParamSpec,
  type OperationRegistry,
} from '@fluxus/editor-core';
import {
  cameraEffectParamInRange,
  cameraEffectParams,
  cameraEffectRangeText,
  cameraEffectType,
  validateManifest,
  type CameraEffectKind,
  type CameraEffectParamSpec,
  type CameraEffectTypeSpec,
  type CameraEffectsDescription,
} from '@fluxus/assets';
import { CAMERA_EFFECTS_DESCRIPTION } from '@fluxus/render';
import { DOCUMENT, asDocument, asNumber, asString } from './operationParams.js';

/** Идентификаторы операций над секцией эффектов. */
export const CAMERA_EFFECTS_OPERATIONS = {
  bind: 'visuals.cameraEffects.bind',
  setParam: 'visuals.cameraEffects.setParam',
} as const;

/**
 * Чем снимается привязка: общей операцией снятия значения. Своей у секции нет
 * (см. шапку), но названа она здесь — таблице секции нужно чем-то удалять, а
 * литерал идентификатора в интерфейсе был бы вторым знанием о том же решении.
 */
export const REMOVE_BINDING_OPERATION = 'document.removeValue';

/** Где в манифесте лежит секция и её таблицы (ASSET-8) — доменное знание вклада. */
const SECTION_KEY = 'cameraEffects';
export const EVENTS_TABLE = 'events';
export const STATES_TABLE = 'states';
export const EFFECT_KEY = 'effect';

/** Таблица секции и вид эффекта, который в ней законен (ASSET-8, CAM-9). */
const TABLE_KINDS: Readonly<Record<string, CameraEffectKind>> = Object.freeze({
  [EVENTS_TABLE]: 'impulse',
  [STATES_TABLE]: 'lasting',
});

/** Имена таблиц в порядке секции — из них автор и выбирает. */
const TABLES: readonly string[] = Object.freeze([EVENTS_TABLE, STATES_TABLE]);

const TABLE: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.table' };
const BINDING_NAME: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.bindingName',
};
const EFFECT: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.effect' };
const PARAM: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.effectParam' };
const VALUE: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.value' };

/** Путь записи привязки внутри документа манифеста. */
export function bindingPath(table: string, name: string, ...rest: readonly string[]): JsonPath {
  return [SECTION_KEY, table, name, ...rest];
}

/** Вид эффекта, законный в этой таблице; отказ — если таблицы такой нет. */
function requireKind(operationId: string, table: string): CameraEffectKind {
  const kind = TABLE_KINDS[table];
  if (kind === undefined) {
    throw new OperationError(
      operationId,
      `параметр "table": таблицы "${table}" в секции эффектов нет (допустимы: ${TABLES.join(', ')})`,
      { param: 'table', received: table },
    );
  }
  return kind;
}

function requireName(operationId: string, name: string): string {
  if (name === '') {
    throw new OperationError(operationId, 'параметр "name": имя привязки пусто', {
      param: 'name',
      received: name,
    });
  }
  return name;
}

/** Запись привязки, если она есть; `null` — привязки с таким именем нет. */
function bindingAt(
  ctx: OperationContext,
  document: DocumentId,
  table: string,
  name: string,
): JsonValue | null {
  return ctx.readAt(document, bindingPath(table, name)) ?? null;
}

/**
 * Тип записи глазами описания (CAM-9). Отказ операции здесь — не строгость
 * ради строгости: незаявленный параметр или тип не того вида валидация тут же
 * назовёт находкой, и записывать такое операцией значило бы заводить автору
 * работу вместо результата.
 */
function requireType(
  operationId: string,
  description: CameraEffectsDescription,
  effect: string,
  kind: CameraEffectKind,
): CameraEffectTypeSpec {
  const type = cameraEffectType(description, effect);
  if (type === undefined) {
    throw new OperationError(
      operationId,
      `параметр "effect": тип "${effect}" описанием камеры не объявлен (CAM-9)`,
      { param: 'effect', received: effect },
    );
  }
  if (type.kind !== kind) {
    throw new OperationError(
      operationId,
      `параметр "effect": тип "${effect}" объявлен как ${type.kind}, а таблица требует ${kind}`,
      { param: 'effect', received: effect },
    );
  }
  return type;
}

/** Ошибки записи глазами её владельца: запись оборачивается в манифест из неё одной. */
function bindingErrors(
  description: CameraEffectsDescription,
  table: string,
  name: string,
  value: JsonValue | undefined,
): readonly string[] {
  const checked = validateManifest(
    { entities: {}, [SECTION_KEY]: { [table]: { [name]: value ?? null } } },
    { cameraEffects: description },
  );
  return checked.ok ? [] : checked.errors;
}

/**
 * Правленую запись проверяет модуль ассетов, а не операция (ED-1, CORE-3):
 * что такое законная запись секции, отвечает `validateManifest` с описанием —
 * тот же вызов, которым манифест проверяется на загрузке и в реальном времени.
 *
 * Спрашивается владелец после записи и о РАЗНИЦЕ: запись, сломанную до
 * операции, показывает валидация документа (ED-8), и отказывать правке за чужое
 * нарушение значило бы не дать автору его исправить. Предупреждения отказом не
 * являются (ASSET-8): манифест переживает код.
 */
function checkBinding(
  operationId: string,
  ctx: OperationContext,
  description: CameraEffectsDescription,
  document: DocumentId,
  table: string,
  name: string,
  before: JsonValue | null,
  details: { param: string; received: JsonValue },
): void {
  const known = new Set(bindingErrors(description, table, name, before ?? undefined));
  const introduced = bindingErrors(
    description,
    table,
    name,
    ctx.readAt(document, bindingPath(table, name)),
  ).filter((error) => !known.has(error));
  if (introduced.length > 0) throw new OperationError(operationId, introduced.join('; '), details);
}

/**
 * Привязка «событие/состояние → эффект» (ED-14). Заводит запись или
 * перетипизовывает существующую.
 *
 * Пишет только `effect`: чисел не подставляет — умолчания знает код (CAM-9), а
 * записанное умолчание раздувает дифф (ED-21) и врёт, когда умолчание в коде
 * поменяют. При смене типа параметры, которых новый тип не объявляет, из записи
 * удаляются: иначе автор остаётся с числами, на которые валидация тут же
 * ругается, и чистит их руками. Потеря чисел обратима одним undo (ED-18).
 */
function bindCameraEffectOperation(
  description: CameraEffectsDescription = CAMERA_EFFECTS_DESCRIPTION,
): AuthoringOperation {
  return {
    id: CAMERA_EFFECTS_OPERATIONS.bind,
    descriptionKey: 'ui.operation.visuals.cameraEffects.bind',
    params: { document: DOCUMENT, table: TABLE, name: BINDING_NAME, effect: EFFECT },
    apply(ctx, params) {
      const id = CAMERA_EFFECTS_OPERATIONS.bind;
      const document = asDocument(params);
      const table = asString(params, 'table');
      const kind = requireKind(id, table);
      const name = requireName(id, asString(params, 'name'));
      const effect = asString(params, 'effect');
      const type = requireType(id, description, effect, kind);
      const before = bindingAt(ctx, document, table, name);
      ctx.setValue(document, bindingPath(table, name, EFFECT_KEY), effect);
      // Числа, которых новый тип не объявляет, снимаются — по одному, а не
      // перезаписью всей записи: перезапись потеряла бы и то, что тип объявляет.
      if (isJsonObject(before)) {
        const declared = new Set(cameraEffectParams(description, type).map((spec) => spec.name));
        for (const param of Object.keys(before)) {
          if (param === EFFECT_KEY || declared.has(param)) continue;
          ctx.removeValue(document, bindingPath(table, name, param));
        }
      }
      checkBinding(id, ctx, description, document, table, name, before, {
        param: 'effect',
        received: effect,
      });
      return undefined;
    },
  };
}

/** Параметр записи по описанию; отказ — если тип его не объявляет (CAM-9). */
function requireParam(
  operationId: string,
  description: CameraEffectsDescription,
  type: CameraEffectTypeSpec,
  param: string,
): CameraEffectParamSpec {
  const declared = cameraEffectParams(description, type);
  const spec = declared.find((candidate) => candidate.name === param);
  if (spec === undefined) {
    throw new OperationError(
      operationId,
      `параметр "param": тип "${type.id}" параметра "${param}" не объявляет (допустимы: ${declared
        .map((candidate) => candidate.name)
        .join(', ')})`,
      { param: 'param', received: param },
    );
  }
  return spec;
}

/**
 * Одно число записи (ED-14). Имя параметра сверяется с описанием, значение — с
 * объявленным диапазоном: приведение к границе — поведение кадра (CAM-6), а не
 * разрешение писать такое на диск (ASSET-8).
 */
function setCameraEffectParamOperation(
  description: CameraEffectsDescription = CAMERA_EFFECTS_DESCRIPTION,
): AuthoringOperation {
  return {
    id: CAMERA_EFFECTS_OPERATIONS.setParam,
    descriptionKey: 'ui.operation.visuals.cameraEffects.setParam',
    params: { document: DOCUMENT, table: TABLE, name: BINDING_NAME, param: PARAM, value: VALUE },
    apply(ctx, params) {
      const id = CAMERA_EFFECTS_OPERATIONS.setParam;
      const document = asDocument(params);
      const table = asString(params, 'table');
      const kind = requireKind(id, table);
      const name = requireName(id, asString(params, 'name'));
      const before = bindingAt(ctx, document, table, name);
      // Записи, которой нет, число не назначается: привязка — это тип, и
      // заводить её походя означало бы завести запись без `effect`, то есть
      // нарушение формата (ASSET-8).
      if (!isJsonObject(before) || typeof before[EFFECT_KEY] !== 'string') {
        throw new OperationError(
          id,
          `привязки "${name}" в таблице "${table}" нет — параметр назначать нечему`,
          { param: 'name', received: name },
        );
      }
      const type = requireType(id, description, before[EFFECT_KEY], kind);
      const param = asString(params, 'param');
      const spec = requireParam(id, description, type, param);
      const value = asNumber(params, 'value');
      if (!Number.isFinite(value)) {
        throw new OperationError(id, `параметр "value": ожидалось конечное число`, {
          param: 'value',
          received: value,
        });
      }
      // Сравнение и его запись — те же, что у валидации секции (ASSET-8): второй
      // ответ на вопрос «это в диапазоне?» разошёлся бы с первым молча.
      if (!cameraEffectParamInRange(spec, value)) {
        throw new OperationError(
          id,
          `параметр "value": ${value} вне диапазона ${cameraEffectRangeText(spec)}, объявленного типом "${type.id}"`,
          { param: 'value', received: value },
        );
      }
      ctx.setValue(document, bindingPath(table, name, param), value);
      checkBinding(id, ctx, description, document, table, name, before, {
        param: 'value',
        received: value,
      });
      return undefined;
    },
  };
}

/** Набор операций секции — по одному на действие автора (ED-29). */
export function cameraEffectsOperations(
  description: CameraEffectsDescription = CAMERA_EFFECTS_DESCRIPTION,
): readonly AuthoringOperation[] {
  return Object.freeze([
    bindCameraEffectOperation(description),
    setCameraEffectParamOperation(description),
  ]);
}

/**
 * Регистрация вкладом (ED-25): набор операций приносит тот, кто собирает
 * редактор, — вместе с описанием типов, которое он же приносит правилам
 * валидации.
 */
export function registerCameraEffectsOperations(
  registry: OperationRegistry,
  description: CameraEffectsDescription = CAMERA_EFFECTS_DESCRIPTION,
): OperationRegistry {
  for (const operation of cameraEffectsOperations(description)) registry.register(operation);
  return registry;
}

/** Записи таблицы секции в порядке документа — то, из чего строится таблица (ED-14). */
export function bindingNames(value: JsonValue | undefined, table: string): readonly string[] {
  if (!isJsonObject(value)) return [];
  const section = value[SECTION_KEY];
  if (!isJsonObject(section)) return [];
  const entries = section[table];
  return isJsonObject(entries) ? Object.keys(entries) : [];
}

/** Запись привязки как объект; `null` — её нет или она не объект. */
export function bindingOf(
  value: JsonValue | undefined,
  table: string,
  name: string,
): Readonly<Record<string, JsonValue>> | null {
  if (!isJsonObject(value)) return null;
  const section = value[SECTION_KEY];
  if (!isJsonObject(section)) return null;
  const entries = section[table];
  if (!isJsonObject(entries)) return null;
  const entry = entries[name];
  return isJsonObject(entry) ? entry : null;
}

/** Типы, законные в этой таблице: описание, отфильтрованное по её виду (CAM-9). */
export function typesForTable(
  description: CameraEffectsDescription,
  table: string,
): readonly CameraEffectTypeSpec[] {
  const kind = TABLE_KINDS[table];
  return kind === undefined ? [] : description.types.filter((type) => type.kind === kind);
}

/** Поля записи: параметры типа плюс параметры привязки его вида (CAM-9). */
export function paramsForBinding(
  description: CameraEffectsDescription,
  effect: string,
): readonly CameraEffectParamSpec[] {
  const type = cameraEffectType(description, effect);
  return type === undefined ? [] : cameraEffectParams(description, type);
}

/**
 * Имена событий тика, встречающиеся в JSON-системах документа: аргумент `type`
 * действия `emitEvent` — строковый литерал, и другого машинного перечня событий
 * сегодня нет (нативные системы ядра называют свои литералами в коде).
 *
 * Поэтому это ПОДСКАЗКА, а не проверка: находки на имя, которого здесь нет,
 * редактор не заводит — иначе он ругался бы на каждое нативное событие.
 * Машинный перечень типов событий — работа того же рода, что CAM-9, и она
 * отдельная (открытый вопрос change'а).
 */
export function emittedEventTypes(value: JsonValue | undefined): readonly string[] {
  const found = new Set<string>();
  const walk = (node: JsonValue | undefined): void => {
    if (isJsonArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isJsonObject(node)) return;
    const emit = node.emitEvent;
    if (isJsonObject(emit) && typeof emit.type === 'string') found.add(emit.type);
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return [...found].sort();
}
