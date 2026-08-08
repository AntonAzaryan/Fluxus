/**
 * @contribution Операции расстановки сим-объектов сцены (ED-16) — вклад в слой
 * операций авторинга (ED-29), а не часть каркаса.
 *
 * ED-29 не оставляет выбора: «Всякая правка редактируемых документов SHALL
 * выполняться зарегистрированной операцией авторинга». Поэтому поставить,
 * подвинуть, повернуть и удалить объект — это четыре вызова реестра, а не
 * четыре места, где интерфейс пишет в документ. И это же даёт ED-18 даром:
 * непрерывное перетаскивание — одна транзакция сессии, а значит одна запись
 * истории, независимо от числа кадров, на которые оно пришлось.
 *
 * ## Что операции знают о содержимом и чего не знают
 *
 * Запись расстановки — `prefab` и переопределения полей (SER-8), и именованных
 * полей позиции в формате нет вовсе. Поэтому имя компонента и имена полей
 * приходят операции ПАРАМЕТРОМ (`binding`) — настройкой проекта (ED-16), — а не
 * литералом здесь; умолчание берётся у ядра (`DEFAULT_POSITION_BINDING`), у
 * которого оно и живёт. Внешний потребитель, вызывающий операцию без интерфейса,
 * подаёт ту же привязку тем же параметром: второго пути нет.
 *
 * ## Порядок записей
 *
 * Новая запись дописывается строго в конец — `appendRecord` другого и не умеет
 * (SER-8, ED-16): порядок записей задаёт выданные ID, и вставка в середину
 * сдвинула бы `worldInit` там, где автор поставил один объект. Перемещение,
 * поворот и правка поля идут `setRecordValue` по дескриптору и списка не
 * касаются вовсе — переставить записи этими операциями нечем.
 *
 * Удаление отдельной операции здесь не получает: `document.list.remove` ядра
 * редактора делает ровно то, что нужно, и адресуется тем же дескриптором.
 * Доменная обёртка над ним была бы вторым именем одного действия — в машинном
 * каталоге (ED-30) их стало бы два на одно поведение.
 *
 * ## Квантование (FP-1, ED-16)
 *
 * «Позиции сим-объектов SHALL записываться валидными для ядра fixed-point
 * значениями», а picking отдаёт мировую точку во float и обратной конверсии в
 * потоке рендера не имеет (REND-1, REND-15). Значит, квантует редактор — и
 * квантует ВЫЗОВОМ ЯДРА (`fixed.fromFloat`), а не своим умножением на 65536
 * (ED-1). Собственная у редактора здесь только проверка, что ядро ответило
 * величиной, из которой читается обратно то же самое: контейнер Q16.16 — i32, и
 * вне диапазона он заворачивается молча, то есть позиция уехала бы на другой
 * край арены без единого сообщения.
 */
import { fixed, FIXED_ONE } from '@game-mvp/core';
import {
  OperationError,
  isJsonArray,
  isJsonObject,
  type AuthoringOperation,
  type DocumentId,
  type JsonObject,
  type JsonPath,
  type JsonValue,
  type OperationParams,
  type OperationParamSpec,
  type OperationRegistry,
} from '@game-mvp/editor-core';
import {
  DEFAULT_POSITION_BINDING,
  type PositionBinding,
  type RotationBinding,
} from './sceneDocuments.js';

/** Идентификаторы операций расстановки. Удаление — базовая операция ядра редактора. */
export const PLACEMENT_OPERATIONS = {
  add: 'scene.placement.add',
  move: 'scene.placement.move',
  rotate: 'scene.placement.rotate',
  /** `document.list.remove`: удалять запись по дескриптору умеет базовый набор. */
  remove: 'document.list.remove',
} as const;

/** Путь переопределений внутри записи расстановки (SER-8). */
export const OVERRIDES_KEY = 'overrides';

const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};
const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'ui.operation.param.list' };
const RECORD: OperationParamSpec = {
  type: 'descriptor',
  descriptionKey: 'ui.operation.param.record',
};
const PREFAB: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.prefab' };
const X: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.x' };
const Y: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.y' };
const TURNS: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.turns' };
const OPTIONAL_TURNS: OperationParamSpec = { ...TURNS, optional: true };
const BINDING: OperationParamSpec = {
  type: 'json',
  optional: true,
  descriptionKey: 'ui.operation.param.binding',
};

/**
 * Авторская величина с экрана в валидный Q16.16 (FP-1). `null` — ядро такой
 * величины не представляет: вызывающий обязан отказать, а не записать
 * завернувшийся i32.
 */
export function quantized(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const raw = fixed.fromFloat(value);
  // Округление вниз по модулю даёт расхождение строго меньше кванта; всё, что
  // больше, — след заворота контейнера, а не потеря точности.
  return Math.abs(fixed.toFloat(raw) - value) < 1 / FIXED_ONE ? raw : null;
}

function requireQuantized(operationId: string, param: string, value: number): number {
  const raw = quantized(value);
  if (raw === null) {
    throw new OperationError(operationId, `параметр "${param}": вне представимого Q16.16 (FP-1)`, {
      param,
      received: value,
    });
  }
  return raw;
}

function readString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/*
 * Читатели ниже — приведение типа, а не вторая проверка: схему параметров уже
 * сверил слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams): DocumentId => params['document'] as DocumentId;
const asList = (params: OperationParams): JsonPath => (params['list'] ?? []) as JsonPath;
const asRecord = (params: OperationParams): string => params['record'] as string;
const asNumber = (params: OperationParams, name: string): number => params[name] as number;

/**
 * Привязка из параметра. Отсутствует — конвенция ядра: проект, не сказавший о
 * позиции ничего, пользуется той, на которую опираются нативные системы ядра.
 */
export function readBinding(operationId: string, params: OperationParams): PositionBinding {
  const raw = params['binding'];
  if (raw === undefined || raw === null) return DEFAULT_POSITION_BINDING;
  if (!isJsonObject(raw)) {
    throw new OperationError(operationId, 'параметр "binding": ожидался объект привязки', {
      param: 'binding',
      received: raw,
    });
  }
  const component = readString(raw['component']);
  const x = readString(raw['x']);
  const y = readString(raw['y']);
  if (component === null || x === null || y === null) {
    throw new OperationError(
      operationId,
      'параметр "binding": нужны непустые component, x и y (ED-16)',
      { param: 'binding', received: raw },
    );
  }
  const spin = raw['rotation'];
  if (spin === undefined || spin === null) return { component, x, y };
  const spinComponent = isJsonObject(spin) ? readString(spin['component']) : null;
  const spinField = isJsonObject(spin) ? readString(spin['field']) : null;
  if (spinComponent === null || spinField === null) {
    throw new OperationError(
      operationId,
      'параметр "binding": в rotation нужны непустые component и field (ED-16)',
      { param: 'binding', received: spin },
    );
  }
  return { component, x, y, rotation: { component: spinComponent, field: spinField } };
}

/**
 * Привязка как параметр операции. Значения параметров — JSON и только JSON
 * (ED-29: вызов без интерфейса приходит из чужих рук), поэтому перекладка
 * явная, а не приведение типа.
 */
export function bindingParam(binding: PositionBinding | undefined): OperationParams {
  if (binding === undefined) return {};
  const spin = binding.rotation;
  const value: JsonObject = {
    component: binding.component,
    x: binding.x,
    y: binding.y,
    ...(spin === undefined ? {} : { rotation: { component: spin.component, field: spin.field } }),
  };
  return { binding: value };
}

function requireRotation(operationId: string, binding: PositionBinding): RotationBinding {
  if (binding.rotation === undefined) {
    throw new OperationError(
      operationId,
      'привязка проекта не называет, где лежит поворот, — поворачивать нечего (ED-16)',
      { param: 'binding' },
    );
  }
  return binding.rotation;
}

/** Карта переопределений «компонент → поле → значение» (SER-8, CMD-6). */
function overridesOf(entries: readonly [string, string, number][]): JsonObject {
  const out: Record<string, Record<string, number>> = {};
  for (const [component, field, value] of entries) {
    const fields = (out[component] ??= {});
    fields[field] = value;
  }
  return out;
}

/**
 * Постановка инстанса префаба в точку поверхности (ED-16). Возвращает дескриптор
 * дописанной записи — им же вызывающий её и выделяет (ED-17).
 */
export const addPlacementOperation: AuthoringOperation = {
  id: PLACEMENT_OPERATIONS.add,
  descriptionKey: 'ui.operation.scene.placement.add',
  params: { document: DOCUMENT, list: LIST, prefab: PREFAB, x: X, y: Y, turns: OPTIONAL_TURNS, binding: BINDING },
  apply(ctx, params) {
    const id = PLACEMENT_OPERATIONS.add;
    const binding = readBinding(id, params);
    const entries: [string, string, number][] = [
      [binding.component, binding.x, requireQuantized(id, 'x', asNumber(params, 'x'))],
      [binding.component, binding.y, requireQuantized(id, 'y', asNumber(params, 'y'))],
    ];
    const turns = params['turns'];
    if (typeof turns === 'number') {
      const spin = requireRotation(id, binding);
      entries.push([spin.component, spin.field, requireQuantized(id, 'turns', turns)]);
    }
    // Только в конец (SER-8): другого способа дописать запись у слоя нет.
    return ctx.appendRecord(asDocument(params), asList(params), {
      prefab: params['prefab'] as string,
      [OVERRIDES_KEY]: overridesOf(entries),
    });
  },
};

/**
 * Перемещение размещённого (ED-16). Пишет ровно два поля своей записи и
 * списка не касается: порядок записей от перемещения не меняется.
 */
export const movePlacementOperation: AuthoringOperation = {
  id: PLACEMENT_OPERATIONS.move,
  descriptionKey: 'ui.operation.scene.placement.move',
  params: { document: DOCUMENT, record: RECORD, x: X, y: Y, binding: BINDING },
  apply(ctx, params) {
    const id = PLACEMENT_OPERATIONS.move;
    const binding = readBinding(id, params);
    const document = asDocument(params);
    const record = asRecord(params);
    ctx.setRecordValue(
      document,
      record,
      [OVERRIDES_KEY, binding.component, binding.x],
      requireQuantized(id, 'x', asNumber(params, 'x')),
    );
    ctx.setRecordValue(
      document,
      record,
      [OVERRIDES_KEY, binding.component, binding.y],
      requireQuantized(id, 'y', asNumber(params, 'y')),
    );
    return undefined;
  },
};

/**
 * Поворот размещённого (ED-16). Угол — доля оборота в Q16.16, единица самого
 * ядра (`fixed.sin`); второй единицы редактор не вводит.
 */
export const rotatePlacementOperation: AuthoringOperation = {
  id: PLACEMENT_OPERATIONS.rotate,
  descriptionKey: 'ui.operation.scene.placement.rotate',
  params: { document: DOCUMENT, record: RECORD, turns: TURNS, binding: BINDING },
  apply(ctx, params) {
    const id = PLACEMENT_OPERATIONS.rotate;
    const spin = requireRotation(id, readBinding(id, params));
    ctx.setRecordValue(
      asDocument(params),
      asRecord(params),
      [OVERRIDES_KEY, spin.component, spin.field],
      requireQuantized(id, 'turns', asNumber(params, 'turns')),
    );
    return undefined;
  },
};

/**
 * Имена префабов конфига сцены в порядке документа — то, из чего автор выбирает,
 * что ставить (ED-16). Существование парной записи манифеста (ED-19) здесь не
 * проверяется: это правило валидации `editor.visualForPrefab`, и второй его
 * реализации быть не должно (ED-1, ED-30).
 */
export function prefabNames(config: JsonValue | undefined): readonly string[] {
  if (!isJsonObject(config)) return [];
  const list = config['prefabs'];
  if (!isJsonArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    const name = isJsonObject(entry) ? readString(entry['name']) : null;
    if (name !== null) names.push(name);
  }
  return names;
}

export const PLACEMENT_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  addPlacementOperation,
  movePlacementOperation,
  rotatePlacementOperation,
]);

/**
 * Регистрация вкладом (ED-25): набор операций приносит тот, кто собирает
 * редактор, — базовые операции ядра редактора при этом не правятся.
 */
export function registerPlacementOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of PLACEMENT_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}
