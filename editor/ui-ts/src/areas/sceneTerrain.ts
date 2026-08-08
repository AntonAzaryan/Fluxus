/**
 * @contribution Операции кистей — уровня, вида клетки и кривизны (ED-10, ED-11)
 * — вклад в слой операций авторинга (ED-29), а не часть каркаса.
 *
 * ED-29 не оставляет выбора: «Всякая правка редактируемых документов SHALL
 * выполняться зарегистрированной операцией авторинга». Поэтому мазок кисти —
 * это последовательность применений одной зарегистрированной операции внутри
 * одной транзакции сессии, а не запись интерфейса в документ. Из этого же
 * даром получается ED-18: непрерывный мазок — одна транзакция, значит одна
 * запись истории, сколько бы клеток он ни задел.
 *
 * ## Два слоя данных, две операции
 *
 * Кисти террейна принадлежат sim-ассету (TERR-2): карта уровней и карта флагов.
 * Кисть кривизны принадлежит presentation-ассету (ASSET-7) и трогает только
 * его. Разделение здесь структурное, а не дисциплинарное: у операции кривизны
 * нет ни одного пути внутрь карт террейна, а у операций террейна — внутрь карты
 * кривизны, и «кисть кривизны не меняет симуляцию» (ED-11) проверяется тем, что
 * ей нечем.
 *
 * ## Чего здесь нет: cliff-геометрии
 *
 * TERR-5: «Геометрия обрывов SHALL выводиться из карты уровней при загрузке и
 * MUST NOT храниться в ассете как отдельный редактируемый слой». Поэтому
 * операции, пишущей обрыв, здесь нет и появиться ей неоткуда — редактор правит
 * карту уровней, а обрывы выводит ядро (`createTerrainGrid`) и показывает
 * рендер (REND-14). Отсутствие такой операции и есть выполнение ED-10
 * «MUST NOT давать редактировать её напрямую»: не «не предлагаем в интерфейсе»,
 * а «в машинном каталоге ED-30 её нет».
 *
 * ## Откуда берутся символы карт
 *
 * Карта кривизны: обратная таблица выводится обходом `curvatureOffsetOf` —
 * экспортированного разбора символа (ASSET-7). Своей копии её алфавита у
 * редактора нет вовсе, и диапазон смещений — то, что в этом алфавите выразимо.
 *
 * Карты террейна: разбор живёт в ядре (`createTerrainGrid`), но обратного хода
 * — символа по уровню — оно не экспортирует, а ассет пишет редактор (ED-10).
 * Символы поэтому названы здесь. Вторым описанием ПРАВИЛА это не становится:
 * согласие с ядром проверяет само ядро на каждой правке (ED-8) — карта,
 * разошедшаяся с алфавитом, не доживает до кадра, — а round-trip «записали
 * уровень → ядро прочитало тот же» пиннится тестом, а не совпадением двух
 * таблиц на глаз.
 */
import { curvatureOffsetOf } from '@game-mvp/assets';
import {
  OperationError,
  formatPath,
  isJsonArray,
  type AuthoringOperation,
  type DocumentId,
  type JsonPath,
  type JsonValue,
  type OperationContext,
  type OperationParams,
  type OperationParamSpec,
  type OperationRegistry,
} from '@game-mvp/editor-core';

/** Идентификаторы операций кистей. */
export const TERRAIN_OPERATIONS = {
  level: 'scene.terrain.level',
  cell: 'scene.terrain.cell',
  curvature: 'scene.curvature.offset',
} as const;

/** Имена карт внутри ассетов (TERR-2, ASSET-7) — поля формата, а не выдумка кисти. */
export const LEVEL_MAP = 'levels';
export const FLAG_MAP = 'flags';
export const OFFSET_MAP = 'rows';

/**
 * Символы карты уровней (TERR-3): индекс символа и есть уровень клетки, а длина
 * строки — весь выразимый диапазон.
 */
const LEVEL_CHARS = '0123456789ABCDEF';

/** Наибольший выразимый уровень — производное алфавита, а не второе число. */
export const MAX_LEVEL = LEVEL_CHARS.length - 1;

/**
 * Вид клетки в карте флагов (TERR-3): один символ описывает клетку целиком,
 * комбинаций в модели нет — рампа без пола смысла не имеет. Поэтому «пометить
 * рампой», «снять пол» и «вернуть пол» (ED-10) — три значения одного параметра,
 * а не три независимых флага, которые можно было бы выставить разом.
 */
export const TERRAIN_CELL_KINDS = ['plain', 'ramp', 'noFloor'] as const;
export type TerrainCellKind = (typeof TERRAIN_CELL_KINDS)[number];

const CELL_CHARS: Readonly<Record<TerrainCellKind, string>> = {
  plain: '.',
  ramp: '^',
  noFloor: '_',
};

/**
 * Смещение → символ карты кривизны (ASSET-7). Таблица выведена из разбора
 * ядра, а не записана рядом с ним: печатаемый ASCII — то множество, из которого
 * алфавит карты вообще выбирается, и обход его через `curvatureOffsetOf` даёт
 * ровно обратное отображение.
 */
const CURVATURE_CHARS: ReadonlyMap<number, string> = (() => {
  const chars = new Map<number, string>();
  for (let code = 0x21; code <= 0x7e; code++) {
    const char = String.fromCharCode(code);
    const offset = curvatureOffsetOf(char);
    if (offset !== null && !chars.has(offset)) chars.set(offset, char);
  }
  return chars;
})();

/** Диапазон смещений — то, что выразимо алфавитом, и ничего сверх него. */
export const MIN_OFFSET = Math.min(...CURVATURE_CHARS.keys());
export const MAX_OFFSET = Math.max(...CURVATURE_CHARS.keys());

/** Смещения по возрастанию — из них автор и выбирает, чем красить. */
export const CURVATURE_OFFSETS: readonly number[] = Object.freeze(
  [...CURVATURE_CHARS.keys()].sort((a, b) => a - b),
);

const DOCUMENT: OperationParamSpec = {
  type: 'document',
  descriptionKey: 'ui.operation.param.document',
};
const ASSET_PATH: OperationParamSpec = {
  type: 'path',
  optional: true,
  descriptionKey: 'ui.operation.param.asset',
};
const CELL_X: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.cellX' };
const CELL_Y: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.cellY' };
const LEVEL: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.level' };
const KIND: OperationParamSpec = { type: 'string', descriptionKey: 'ui.operation.param.cellKind' };
const OFFSET: OperationParamSpec = { type: 'number', descriptionKey: 'ui.operation.param.offset' };

/*
 * Читатели ниже — приведение типа, а не вторая проверка: схему параметров уже
 * сверил слой операций к моменту вызова `apply` (ED-30).
 */
const asDocument = (params: OperationParams): DocumentId => params['document'] as DocumentId;
const asBase = (params: OperationParams): JsonPath => (params['path'] ?? []) as JsonPath;
const asNumber = (params: OperationParams, name: string): number => params[name] as number;

/**
 * Красит одну клетку текстовой карты: ряд переписывается целиком, потому что
 * ряд и есть единица формата (TERR-3, ASSET-7) — одна строка на ряд сетки.
 * Правка целится в ряд, а не в карту, чтобы мазок по одной полосе оставлял в
 * диффе одну строку, а не весь файл (ED-21).
 *
 * Клетка вне карты — отказ, а не молчаливое расширение: достроенный ряд был бы
 * картой другой ширины, то есть ассетом, которого автор не рисовал.
 */
function paintCell(
  ctx: OperationContext,
  operationId: string,
  params: OperationParams,
  map: string,
  char: string,
): void {
  const document = asDocument(params);
  const mapPath: JsonPath = [...asBase(params), map];
  const rows: JsonValue | undefined = ctx.readAt(document, mapPath);
  if (!isJsonArray(rows)) {
    throw new OperationError(
      operationId,
      `${formatPath(mapPath)}: карта — массив строк, по одной на ряд сетки`,
      { received: rows ?? null },
    );
  }
  const y = asNumber(params, 'cellY');
  const x = asNumber(params, 'cellX');
  const row = Number.isInteger(y) && y >= 0 ? rows[y] : undefined;
  if (typeof row !== 'string') {
    throw new OperationError(operationId, `клетка (${x}, ${y}): рядов в карте ${rows.length}`, {
      param: 'cellY',
      received: y,
    });
  }
  if (!Number.isInteger(x) || x < 0 || x >= row.length) {
    throw new OperationError(operationId, `клетка (${x}, ${y}): клеток в ряду ${row.length}`, {
      param: 'cellX',
      received: x,
    });
  }
  ctx.setValue(document, [...mapPath, y], row.slice(0, x) + char + row.slice(x + 1));
}

/**
 * Уровень клетки (ED-10, TERR-3). Диапазон проверяется здесь, а не только
 * ядром: «значение вне диапазона… MUST NOT возникать в результате программной
 * мутации» — то есть отказать обязана сама запись, а не разбор записанного.
 */
export const setLevelOperation: AuthoringOperation = {
  id: TERRAIN_OPERATIONS.level,
  descriptionKey: 'ui.operation.scene.terrain.level',
  params: { document: DOCUMENT, path: ASSET_PATH, cellX: CELL_X, cellY: CELL_Y, level: LEVEL },
  apply(ctx, params) {
    const id = TERRAIN_OPERATIONS.level;
    const level = asNumber(params, 'level');
    const char = Number.isInteger(level) ? LEVEL_CHARS[level] : undefined;
    if (char === undefined) {
      throw new OperationError(id, `параметр "level": уровень вне [0, ${MAX_LEVEL}] (TERR-3)`, {
        param: 'level',
        received: level,
      });
    }
    paintCell(ctx, id, params, LEVEL_MAP, char);
    return undefined;
  },
};

/**
 * Вид клетки (ED-10): рампа, снятый пол, обычная клетка. Карты уровней не
 * касается — снятие пола «уровни вокруг не меняет» потому, что менять их этой
 * операцией нечем.
 */
export const setCellKindOperation: AuthoringOperation = {
  id: TERRAIN_OPERATIONS.cell,
  descriptionKey: 'ui.operation.scene.terrain.cell',
  params: { document: DOCUMENT, path: ASSET_PATH, cellX: CELL_X, cellY: CELL_Y, kind: KIND },
  apply(ctx, params) {
    const id = TERRAIN_OPERATIONS.cell;
    const kind = params['kind'] as string;
    const char = (CELL_CHARS as Record<string, string | undefined>)[kind];
    if (char === undefined) {
      throw new OperationError(
        id,
        `параметр "kind": вид клетки — один из ${TERRAIN_CELL_KINDS.join(', ')} (TERR-3)`,
        { param: 'kind', received: kind },
      );
    }
    paintCell(ctx, id, params, FLAG_MAP, char);
    return undefined;
  },
};

/**
 * Смещение клетки в карте кривизны (ED-11, ASSET-7). Величина — шестнадцатые
 * доли шага высоты рендера, и амплитуда за пределами алфавита невыразима по
 * построению: символа для неё просто нет.
 */
export const setCurvatureOperation: AuthoringOperation = {
  id: TERRAIN_OPERATIONS.curvature,
  descriptionKey: 'ui.operation.scene.curvature.offset',
  params: { document: DOCUMENT, path: ASSET_PATH, cellX: CELL_X, cellY: CELL_Y, offset: OFFSET },
  apply(ctx, params) {
    const id = TERRAIN_OPERATIONS.curvature;
    const offset = asNumber(params, 'offset');
    const char = Number.isInteger(offset) ? CURVATURE_CHARS.get(offset) : undefined;
    if (char === undefined) {
      throw new OperationError(
        id,
        `параметр "offset": смещение вне [${MIN_OFFSET}, ${MAX_OFFSET}] (ASSET-7)`,
        { param: 'offset', received: offset },
      );
    }
    paintCell(ctx, id, params, OFFSET_MAP, char);
    return undefined;
  },
};

export const TERRAIN_AUTHORING_OPERATIONS: readonly AuthoringOperation[] = Object.freeze([
  setLevelOperation,
  setCellKindOperation,
  setCurvatureOperation,
]);

/**
 * Регистрация вкладом (ED-25): набор операций приносит тот, кто собирает
 * редактор, — базовые операции ядра редактора при этом не правятся.
 */
export function registerTerrainOperations(registry: OperationRegistry): OperationRegistry {
  for (const operation of TERRAIN_AUTHORING_OPERATIONS) registry.register(operation);
  return registry;
}
