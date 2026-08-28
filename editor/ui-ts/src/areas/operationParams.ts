/**
 * @contribution Словарь параметров операций рабочих областей (ED-29, ED-30) —
 * вклад, а не часть каркаса: имена, которые эти параметры называют (prefab,
 * запись расстановки, привязка позиции), доменные, и каркасу их знать нельзя
 * (ED-25).
 *
 * Спецификация параметра — то, чем операция объявляет его машинному каталогу:
 * тип, необязательность и ключ описания (ED-28). Общие параметры объявлены
 * здесь однажды, а не по копии на вклад: `descriptionKey` — ключ ресурса, и
 * восемь его написаний расходятся с бандлом по одному месту за раз, каждое
 * своей опечаткой. Свой параметр вклад по-прежнему объявляет у себя: общим
 * становится то, что называют двое, а не всё подряд.
 *
 * Читатели значений — приведение типа, а не вторая проверка: схему параметров
 * уже сверил слой операций к моменту вызова `apply` (ED-30). Второй проверки
 * здесь нет намеренно — она разошлась бы со схемой ровно тогда, когда схему
 * поправили, а её не тронули.
 */
import type { DocumentId, JsonPath, OperationParams, OperationParamSpec } from '@fluxus/editor-core';

/** Документ, который правит операция. */
export const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};

/** Путь до отслеживаемого списка внутри документа. */
export const LIST: OperationParamSpec = { type: 'path', descriptionKey: 'ui.operation.param.list' };

/** Сессионный дескриптор записи: адрес, переживающий правку соседей (ED-29). */
export const RECORD: OperationParamSpec = {
  type: 'descriptor',
  descriptionKey: 'ui.operation.param.record',
};

/** Имя prefab'а, на который ссылается запись (SER-8, ACT-1). */
export const PREFAB: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.prefab' };

/** ID ассета — путь от корня дерева контента и ничего кроме (ASSET-2). */
export const ASSET_ID: OperationParamSpec = {
  type: 'string',
  descriptionKey: 'ui.operation.param.assetId',
};

export const X: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.x' };
export const Y: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.y' };

/** Курс долей оборота — единицей ядра, а не радианами кадра (FP-1). */
export const TURNS: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.turns' };
export const OPTIONAL_TURNS: OperationParamSpec = { ...TURNS, optional: true };

/**
 * Привязка проекта «где у объекта позиция и поворот» (ED-16). Необязательна:
 * проект, её не назвавший, поворота не хранит вовсе.
 */
export const BINDING: OperationParamSpec = {
  type: 'json',
  optional: true,
  descriptionKey: 'ui.operation.param.binding',
};

/** Документ операции; имя параметра — не всегда `document` (перенос между парой). */
export const asDocument = (params: OperationParams, name = 'document'): DocumentId =>
  params[name] as DocumentId;
export const asList = (params: OperationParams): JsonPath => (params.list ?? []) as JsonPath;
export const asPath = (params: OperationParams): JsonPath => (params.path ?? []) as JsonPath;
export const asRecord = (params: OperationParams): string => params.record as string;
export const asString = (params: OperationParams, name: string): string => params[name] as string;
export const asNumber = (params: OperationParams, name: string): number => params[name] as number;
