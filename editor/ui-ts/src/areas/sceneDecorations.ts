/**
 * @contribution Операции расстановки декораций (ED-16, ED-19,
 * `presentation-scene` PRES-2, PRES-3, PRES-5) — вклад в слой операций
 * авторинга (ED-29), а не часть каркаса.
 *
 * Соседний вклад — `scenePlacement.ts` — делает то же для сим-объектов, и
 * разница между ними ровно та, что между документами пары. Общее у них
 * дисциплина: поставить, подвинуть, повернуть, отмасштабировать — это вызовы
 * реестра, а не места, где интерфейс пишет в документ. Отсюда же ED-18 даром:
 * непрерывное перетаскивание — одна транзакция сессии, то есть одна запись
 * истории независимо от числа кадров.
 *
 * ## Чего эти операции НЕ знают
 *
 * Привязки проекта (`binding`) у них нет и быть не может: имена компонентов и
 * полей — свойство сим-документа, а в записи decoration полей симуляции нет ни
 * под каким именем (PRES-2). Позиция лежит прямо в записи, и адресовать её
 * нечем, кроме имён самого формата.
 *
 * ## Порядок записей
 *
 * Новая запись дописывается строго в конец — `appendRecord` другого и не умеет
 * (PRES-2). Основание здесь другое, чем у расстановки сцены: ID порядок
 * decoration не выдаёт и `worldInit` не двигает (PRES-4), — но наблюдаем он
 * разрешением picking'а при совпадающей дистанции (REND-15) и величиной диффа,
 * и перестановка записей побочным эффектом другой операции быть не должна.
 *
 * Удаление своей операции здесь не получает, ровно как и у расстановки:
 * `document.list.remove` ядра редактора делает то, что нужно, и адресуется тем
 * же дескриптором. Благодаря этому «удалить выделенное» — ОДНА операция на
 * юнита и на декорацию сразу (сценарий ED-16), а не две с двумя записями
 * истории.
 *
 * ## Квантование (PRES-3)
 *
 * «Записываемые значения SHALL квантоваться инструментом авторинга до записи»,
 * и квантует их редактор — но не своим округлением, а ВЫЗОВОМ модуля, которому
 * формат принадлежит (`quantizeDecorationLength`, `quantizeDecorationYaw`). Шаг
 * — свойство формата, и второе его определение здесь разошлось бы с первым так
 * же молча, как разошлось бы своё умножение на 65536 с `fixed.fromFloat`
 * (ED-1). Собственная у операции только проверка, что величина вообще
 * представима: `null` — отказ, а не запись нечисла.
 *
 * ## Переход между слоями (PRES-5)
 *
 * Перевод decoration в prop и обратно — перенос объекта МЕЖДУ документами пары
 * одной операцией: запись исчезает из одного и появляется в другом. Одной,
 * потому что существование объекта одновременно в обоих документах PRES-5
 * запрещает, а две операции подряд — ровно такое состояние между ними, и
 * `undo` водил бы по нему как по достижимому (ED-18).
 */
import { fixed } from '@fluxus/core';
import {
  quantizeDecorationLength,
  quantizeDecorationYaw,
  visualKeys,
  type VisualManifest,
} from '@fluxus/assets';
import {
  OperationError,
  isJsonObject,
  type AuthoringOperation,
  type DocumentId,
  type JsonObject,
  type JsonValue,
  type OperationContext,
  type OperationParamSpec,
  type OperationParams,
  type OperationRegistry,
} from '@fluxus/editor-core';
import { DECORATION_FIELDS, type PositionBinding } from './sceneDocuments.js';
import { OVERRIDES_KEY, overridesOf, readBinding, requireQuantized } from './scenePlacement.js';
import { BINDING, DOCUMENT, LIST, OPTIONAL_TURNS, PREFAB, RECORD, X, Y, asDocument, asList, asNumber, asRecord } from './operationParams.js';

/** Идентификаторы операций слоя декораций. Удаление — базовая операция ядра. */
export const DECORATION_OPERATIONS = {
  add: 'scene.decoration.add',
  /**
   * Перемещение и поворот — операции размещённого, общие на оба слоя
   * (`scenePlacement.ts`, параметр `layer`): выделение бывает смешанным, и
   * групповая операция обязана действовать на всё сразу (ED-17).
   */
  move: 'scene.placement.move',
  rotate: 'scene.placement.rotate',
  scale: 'scene.decoration.scale',
  /** `document.list.remove`: удалять запись по дескриптору умеет базовый набор. */
  remove: 'document.list.remove',
  toProp: 'scene.decoration.toProp',
  fromProp: 'scene.decoration.fromProp',
} as const;

const VISUAL: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.visual' };
const SCALE: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.scale' };
const TARGET: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.target',
};

/** Квантованная длина (позиция, масштаб) либо отказ операции (PRES-3). */
function requireLength(operationId: string, param: string, value: number): number {
  const quantizedValue = quantizeDecorationLength(value);
  if (quantizedValue === null) {
    throw new OperationError(operationId, `параметр "${param}": не конечное число (PRES-3)`, {
      param,
      received: value,
    });
  }
  return quantizedValue;
}

/** Квантованный курс долей оборота либо отказ операции (PRES-3). */
function requireYaw(operationId: string, param: string, value: number): number {
  const quantizedValue = quantizeDecorationYaw(value);
  if (quantizedValue === null) {
    throw new OperationError(operationId, `параметр "${param}": не конечное число (PRES-3)`, {
      param,
      received: value,
    });
  }
  return quantizedValue;
}

/**
 * Ключ вида записи (PRES-2): обязательная НЕПУСТАЯ строка. Проверка своя, а не
 * схемы параметров: схема знает «строка», а пустой строки формат не допускает —
 * и операция, записавшая её, оставила бы в документе запись, которую его же
 * валидация отвергает. Инструмент авторинга обязан производить документ,
 * проходящий формат, а не документ, о котором потом скажет валидация.
 *
 * Дорога сюда не только у автора: перевод prop → decoration (PRES-5) берёт вид
 * у размещённого, а у сим-объекта, чей prefab в манифесте не описан, вида нет
 * вовсе — и тогда переводить нечего.
 */
function requireVisual(operationId: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new OperationError(
      operationId,
      'параметр "visual": ключ записи манифеста визуалов — непустая строка (PRES-2)',
      { param: 'visual', ...(typeof value === 'string' ? { received: value } : {}) },
    );
  }
  return value;
}

function requirePositiveScale(operationId: string, value: number): number {
  const quantizedValue = requireLength(operationId, 'scale', value);
  if (quantizedValue <= 0) {
    throw new OperationError(
      operationId,
      'параметр "scale": множитель обязан превышать ноль (PRES-2)',
      { param: 'scale', received: value },
    );
  }
  return quantizedValue;
}

/**
 * Постановка декорации в точку поверхности (ED-16, PRES-2). Возвращает
 * дескриптор дописанной записи — им же вызывающий её и выделяет (ED-17).
 *
 * Курс пишется только тогда, когда он назван и ненулевой: умолчание формата —
 * ноль (PRES-2), и записанный явно ноль был бы полем, ничего не сообщающим,
 * зато видимым в диффе каждой поставленной декорации.
 */
const addDecorationOperation: AuthoringOperation = {
  id: DECORATION_OPERATIONS.add,
  descriptionKey: 'ui.operation.scene.decoration.add',
  params: { document: DOCUMENT, list: LIST, visual: VISUAL, x: X, y: Y, turns: OPTIONAL_TURNS },
  apply(ctx, params) {
    const id = DECORATION_OPERATIONS.add;
    const turns = params.turns;
    const record: Record<string, JsonValue> = {
      [DECORATION_FIELDS.visual]: requireVisual(id, params.visual),
      [DECORATION_FIELDS.x]: requireLength(id, 'x', asNumber(params, 'x')),
      [DECORATION_FIELDS.y]: requireLength(id, 'y', asNumber(params, 'y')),
    };
    if (typeof turns === 'number') {
      const yaw = requireYaw(id, 'turns', turns);
      // Нулевой курс полем не пишется: умолчание формата и есть ноль (PRES-2).
      if (yaw !== 0) record[DECORATION_FIELDS.yaw] = yaw;
    }
    // Только в конец (PRES-2): другого способа дописать запись у слоя нет.
    return ctx.appendRecord(asDocument(params), asList(params), record);
  },
};

/** Масштаб декорации (PRES-2): положительный множитель поверх масштаба вида. */
const scaleDecorationOperation: AuthoringOperation = {
  id: DECORATION_OPERATIONS.scale,
  descriptionKey: 'ui.operation.scene.decoration.scale',
  params: { document: DOCUMENT, record: RECORD, scale: SCALE },
  apply(ctx, params) {
    ctx.setRecordValue(
      asDocument(params),
      asRecord(params),
      [DECORATION_FIELDS.scale],
      requirePositiveScale(DECORATION_OPERATIONS.scale, asNumber(params, 'scale')),
    );
    return undefined;
  },
};

/** Число записи; нечисло — значение по умолчанию формата. */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Запись, адресованная дескриптором: сам документ, дескриптор и объект записи
 * по её адресу. Отсутствие объекта — структурный отказ (ED-30), а не пустая
 * запись: переносить между слоями (PRES-5) нечего, если переносимого нет.
 */
function requireEntry(
  id: string,
  ctx: OperationContext,
  params: OperationParams,
): { readonly source: DocumentId; readonly descriptor: string; readonly entry: JsonObject } {
  const source = asDocument(params);
  const descriptor = asRecord(params);
  const where = ctx.locate(source, descriptor);
  const entry = ctx.readAt(source, where.path);
  if (!isJsonObject(entry)) {
    throw new OperationError(id, `запись "${descriptor}": по её адресу нет объекта записи`, {
      param: 'record',
      received: descriptor,
    });
  }
  return { source, descriptor, entry };
}

/**
 * Перевод decoration в prop (PRES-5): запись исчезает из парного документа и
 * появляется записью начальной расстановки конфига сцены (SER-8). Одной
 * операцией — существование объекта в обоих документах сразу PRES-5 запрещает.
 *
 * Место на арене сохраняется: позиция и курс уже стоят на шаге PRES-3, и
 * приведение их к ближайшему Q16.16 даёт погрешность не больше половины шага
 * Q16.16 — ниже разрешения самой симуляции. Объект от смены слоя не двигается
 * вовсе.
 *
 * Внешность при этом не переписывается: ключи разделов манифеста лежат в одном
 * пространстве (ASSET-9), и вид, которым декорация была нарисована, остаётся
 * тем же. Переезжает объект, а не его описание.
 */
const decorationToPropOperation: AuthoringOperation = {
  id: DECORATION_OPERATIONS.toProp,
  descriptionKey: 'ui.operation.scene.decoration.toProp',
  params: {
    document: DOCUMENT,
    record: RECORD,
    target: TARGET,
    list: LIST,
    prefab: PREFAB,
    binding: BINDING,
  },
  apply(ctx, params) {
    const id = DECORATION_OPERATIONS.toProp;
    const { source, descriptor, entry } = requireEntry(id, ctx, params);
    const binding: PositionBinding = readBinding(id, params);
    const entries: [string, string, number][] = [
      [binding.component, binding.x, requireQuantized(id, 'x', readNumber(entry[DECORATION_FIELDS.x], 0))],
      [binding.component, binding.y, requireQuantized(id, 'y', readNumber(entry[DECORATION_FIELDS.y], 0))],
    ];
    const turns = readNumber(entry[DECORATION_FIELDS.yaw], 0);
    // Курс переносится, только если проект знает, где его хранить: привязка без
    // поворота — честный ответ «сцена поворота не хранит» (ED-16), а не повод
    // выдумать имя компонента.
    if (binding.rotation !== undefined && turns !== 0) {
      entries.push([binding.rotation.component, binding.rotation.field, requireQuantized(id, 'turns', turns)]);
    }
    // Порядок важен: сперва появление в приёмнике, потом исчезновение из
    // источника. Упади вторая половина — откатится всё применение целиком
    // (сессия возвращает документы к состоянию до него), и объект не окажется
    // потерянным ни в одном из двух документов.
    const created = ctx.appendRecord(asDocument(params, 'target'), asList(params), {
      prefab: params.prefab as string,
      [OVERRIDES_KEY]: overridesOf(entries),
    });
    ctx.removeRecord(source, descriptor);
    return created;
  },
};

/**
 * Перевод prop в decoration (PRES-5) — обратное направление, и погрешность у
 * него ДРУГАЯ. Значение Q16.16 произвольно, и квантование его к шагу PRES-3
 * смещает объект не больше чем на половину шага — пять десятитысячных мировой
 * единицы, — что ВЫШЕ разрешения симуляции. Смещение допустимо: объект,
 * переставший быть prop'ом, симуляции больше не принадлежит, и сравнивать его
 * новую позицию не с чем.
 *
 * Побайтового возврата исходного значения круговой перевод не даёт и не должен
 * обещать: обещание держалось бы на хранении неквантованного значения где-то
 * помимо документов пары.
 */
const propToDecorationOperation: AuthoringOperation = {
  id: DECORATION_OPERATIONS.fromProp,
  descriptionKey: 'ui.operation.scene.decoration.fromProp',
  params: {
    document: DOCUMENT,
    record: RECORD,
    target: TARGET,
    list: LIST,
    visual: VISUAL,
    binding: BINDING,
  },
  apply(ctx, params) {
    const id = DECORATION_OPERATIONS.fromProp;
    const { source, descriptor, entry } = requireEntry(id, ctx, params);
    const binding = readBinding(id, params);
    const overrides = entry[OVERRIDES_KEY];
    const component = isJsonObject(overrides) ? overrides[binding.component] : undefined;
    const raw = (field: string): number =>
      isJsonObject(component) ? readNumber(component[field], 0) : 0;
    // Q16.16 → доля мировой единицы делает ЯДРО (`fixed.toFloat`), а не деление
    // на 65536 здесь: второй реализации конверсии редактор не заводит (ED-1).
    const record: Record<string, JsonValue> = {
      [DECORATION_FIELDS.visual]: requireVisual(id, params.visual),
      [DECORATION_FIELDS.x]: requireLength(id, 'x', fixed.toFloat(raw(binding.x))),
      [DECORATION_FIELDS.y]: requireLength(id, 'y', fixed.toFloat(raw(binding.y))),
    };
    const spin = binding.rotation;
    if (spin !== undefined) {
      const spinComponent = isJsonObject(overrides) ? overrides[spin.component] : undefined;
      const turnsRaw = isJsonObject(spinComponent) ? readNumber(spinComponent[spin.field], 0) : 0;
      const turns = requireYaw(id, 'turns', fixed.toFloat(turnsRaw));
      if (turns !== 0) record[DECORATION_FIELDS.yaw] = turns;
    }
    const created = ctx.appendRecord(asDocument(params, 'target'), asList(params), record);
    ctx.removeRecord(source, descriptor);
    return created;
  },
};

/**
 * Из чего автор выбирает вид декорации — пространство визуальных ключей целиком
 * (ASSET-9): ставить декорацию можно и видом сущности, потому что камень,
 * который бывает и препятствием, и украшением, описан один раз.
 *
 * Считает пространство модуль ассетов (`visualKeys`), а не этот файл: раздела
 * два, и второе их перечисление здесь разошлось бы с первым ровно так же молча,
 * как второе определение шага квантования. Здесь остаётся только «манифеста нет
 * — выбирать не из чего».
 */
export function decorationVisualNames(manifest: VisualManifest | null): readonly string[] {
  return manifest === null ? [] : visualKeys(manifest);
}

export const DECORATION_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  addDecorationOperation,
  scaleDecorationOperation,
  decorationToPropOperation,
  propToDecorationOperation,
]);

/**
 * Регистрация вкладом (ED-25): набор операций приносит тот, кто собирает
 * редактор, — базовые операции ядра редактора при этом не правятся.
 */
export function registerDecorationOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of DECORATION_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}
