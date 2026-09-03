/**
 * Глубинная текстура тела воды (`rendering` REND-35, design D1): маленькая
 * карта «урез − поле», запечённая CPU выборкой ТОГО ЖЕ поля высот, по которому
 * строится геометрия террейна и садятся инстансы (REND-9). Второй реализации
 * поверхности не появляется — здесь только выборка.
 *
 * ## Почему в текстуре лежит глубина, а не высота поля
 *
 * Глубина — величина, которой пользуется фрагмент: по ней идут и цвет, и пена,
 * и отбрасывание суши. Хранить вместо неё абсолютную высоту значило бы тратить
 * мантиссу half-float на общую для всей текстуры константу уреза: у арены с
 * уровнями в десятки мировых единиц шаг half-float около высоты 16 — уже 0.016,
 * то есть четверть той глубины, которую лощина кривизны вообще создаёт. У
 * разности же ноль стоит ровно на берегу, где точность и нужна.
 *
 * ## Пер-текстурно, а не пер-вершинно
 *
 * У плоского меша вершин мало (квад на greedy-прямоугольник), и берег,
 * посчитанный по вершинам, вышел бы гранёным. Текстура с билинейной выборкой
 * даёт линию воды по полю, а не по сетке квадов; её плотность — «текселей на
 * клетку» под потолком пресета (QUAL-1).
 */
import { DataUtils } from 'three';
import type { WaterRegion } from './region.js';

/** Раскладка глубинной текстуры тела: размер в текселях и мировой охват. */
export interface WaterDepthLayout {
  readonly width: number;
  readonly height: number;
  /** Мировая точка левого-нижнего угла покрытия (угол клетки, не центр текселя). */
  readonly originX: number;
  readonly originY: number;
  /** Мировой размер покрытия — по нему фрагмент считает uv. */
  readonly sizeX: number;
  readonly sizeY: number;
  /** Клетка левого-нижнего угла покрытия — по ней считается адрес правки. */
  readonly cellX: number;
  readonly cellY: number;
  /** Текселей на клетку — действующая плотность под потолком пресета (QUAL-1). */
  readonly texelsPerCell: number;
}

/** Поле высот глазами глубинной текстуры: высота в мировой точке (REND-9). */
export type WaterFieldSampler = (wx: number, wy: number) => number;

/**
 * Раскладка по охвату региона (REND-35). Покрывается ровно bbox клеток тела:
 * дальше воды нет по построению, и тексели туда были бы работой ни за чем.
 * Пустой регион (`maxX < minX`) даёт нулевую раскладку — текстуре взяться не от
 * чего, и подсистема её не заводит.
 */
export function waterDepthLayout(
  region: WaterRegion,
  tile: number,
  texelsPerCell: number,
): WaterDepthLayout {
  const density = Math.max(1, Math.floor(texelsPerCell));
  if (region.maxX < region.minX || region.maxY < region.minY) {
    return {
      width: 0,
      height: 0,
      originX: 0,
      originY: 0,
      sizeX: 0,
      sizeY: 0,
      cellX: 0,
      cellY: 0,
      texelsPerCell: density,
    };
  }
  const cellsX = region.maxX - region.minX + 1;
  const cellsY = region.maxY - region.minY + 1;
  return {
    width: cellsX * density,
    height: cellsY * density,
    originX: region.minX * tile,
    originY: region.minY * tile,
    sizeX: cellsX * tile,
    sizeY: cellsY * tile,
    cellX: region.minX,
    cellY: region.minY,
    texelsPerCell: density,
  };
}

/**
 * Клетки покрытия глазами заливки: маска тела (`WaterRegion.mask`) и живая
 * карта пола (TERR-6). Раздельные правила у клетки ТЕЛА и у клетки, попавшей в
 * bbox покрытия, но телу не принадлежащей, — см. `fillWaterDepth`.
 */
export interface WaterDepthCells {
  /** Маска клеток тела по сетке row-major: 1 — клетка тела. */
  readonly mask: Uint8Array;
  /** Ширина сетки: ею адресуются и маска, и карта пола. */
  readonly gridWidth: number;
  /** Живая карта пола (TERR-6); `null` — пол считается везде. */
  readonly floor: Uint8Array | null;
}

/** Прямоугольник текселей [tx0..tx1] × [ty0..ty1], включительно. */
export interface WaterTexelRect {
  readonly tx0: number;
  readonly ty0: number;
  readonly tx1: number;
  readonly ty1: number;
}

/** Что заливке нужно сверх поля: адрес правки и клетки покрытия. */
export interface WaterDepthFill {
  /** Прямоугольник к перезаполнению; не задан — вся раскладка. */
  readonly rect?: WaterTexelRect | undefined;
  /** Клетки покрытия; не заданы — «урез − поле» во всех текселях без правил. */
  readonly cells?: WaterDepthCells | undefined;
}

/**
 * Заполняет прямоугольник текселей (клампится по раскладке) значением
 * «урез − поле» и возвращает число заполненных текселей — счётную величину
 * стоимости (PERF-3).
 *
 * Тексель адресует ЦЕНТР своей ячейки: так билинейная выборка фрагмента и
 * запечённое значение говорят об одной и той же точке, а край покрытия не
 * съезжает на полтекселя.
 *
 * ## Клетка тела, клетка без пола и клетка за телом — три разных правила
 *
 * Покрытие — bbox тела, и в него попадают клетки, телу не принадлежащие:
 * плато между рукавами реки, соседний берег, вырез карты. Меша там нет, но
 * ЗНАЧЕНИЕ там есть, и билинейная выборка фрагмента у самой кромки меша
 * смешивает его с последним текселем воды. Отсюда правила:
 *
 * - клетка ТЕЛА (`mask === 1`) с полом — «урез − поле» в центре текселя: берег
 *   внутри тела остаётся линией пересечения уреза полем (REND-35);
 * - клетка ТЕЛА без пола (TERR-6) — ровно ноль: под выбитой клеткой дна нет, и
 *   глубина там не положительна, то есть вода не рисуется (REND-35);
 * - клетка ЗА ТЕЛОМ — ДИЛАТАЦИЯ: наибольшее из значений соседних текселей
 *   тела, а нет таких соседей — своё «урез − поле». Стена уровня выше уреза не
 *   берег: без дилатации её тексель держит около −(перепад) при соседнем
 *   водяном около +0.1 шага, смесь пересекает ноль в доле текселя ВНУТРИ меша,
 *   и у подножия стены отбрасывалась бы полоса воды с пеной и градиентом
 *   мелководья.
 *
 * Правило дилатации — чистая функция адреса (максимум по соседям, а не
 * распространение по уже записанным значениям): точечная перезаливка
 * прямоугольника даёт то же, что перезаливка всей текстуры, и повторный вызов
 * ничего не сдвигает.
 */
export function fillWaterDepth(
  target: Uint16Array,
  layout: WaterDepthLayout,
  field: WaterFieldSampler,
  surfaceHeight: number,
  options: WaterDepthFill = {},
): number {
  const rect = options.rect;
  const fromX = Math.max(rect?.tx0 ?? 0, 0);
  const fromY = Math.max(rect?.ty0 ?? 0, 0);
  const toX = Math.min(rect?.tx1 ?? layout.width - 1, layout.width - 1);
  const toY = Math.min(rect?.ty1 ?? layout.height - 1, layout.height - 1);
  if (toX < fromX || toY < fromY) return 0;
  const stepX = layout.sizeX / layout.width;
  const stepY = layout.sizeY / layout.height;
  const cells = options.cells;
  /** «Урез − поле» в центре текселя — выборка без правил клеток. */
  const raw = (tx: number, ty: number): number =>
    surfaceHeight -
    field(layout.originX + (tx + 0.5) * stepX, layout.originY + (ty + 0.5) * stepY);
  for (let ty = fromY; ty <= toY; ty++) {
    for (let tx = fromX; tx <= toX; tx++) {
      target[ty * layout.width + tx] = DataUtils.toHalfFloat(
        texelDepth(cells, layout, tx, ty, raw),
      );
    }
  }
  return (toX - fromX + 1) * (toY - fromY + 1);
}

/**
 * Значение ОДНОГО текселя — чистая функция его адреса: три правила выше,
 * выбранные принадлежностью клетки телу. Без клеток покрытия остаётся прежняя
 * разность «урез − поле» — так заливку зовут прямые вызовы (редактор, тесты).
 */
function texelDepth(
  cells: WaterDepthCells | undefined,
  layout: WaterDepthLayout,
  tx: number,
  ty: number,
  raw: (tx: number, ty: number) => number,
): number {
  if (cells === undefined) return raw(tx, ty);
  if (inBody(cells, layout, tx, ty)) return bodyDepth(cells, layout, tx, ty, raw);
  return dilated(cells, layout, tx, ty, raw);
}

/** Клетка сетки под текселем; тексель раскладки всегда лежит в пределах сетки. */
function cellOf(cells: WaterDepthCells, layout: WaterDepthLayout, tx: number, ty: number): number {
  const cx = layout.cellX + Math.floor(tx / layout.texelsPerCell);
  const cy = layout.cellY + Math.floor(ty / layout.texelsPerCell);
  return cy * cells.gridWidth + cx;
}

/** Принадлежит ли тексель клетке ТЕЛА — по маске региона (design D4). */
function inBody(cells: WaterDepthCells, layout: WaterDepthLayout, tx: number, ty: number): boolean {
  return cells.mask[cellOf(cells, layout, tx, ty)] === 1;
}

/** Глубина текселя тела: ноль под выбитой клеткой (TERR-6), иначе «урез − поле». */
function bodyDepth(
  cells: WaterDepthCells,
  layout: WaterDepthLayout,
  tx: number,
  ty: number,
  raw: (tx: number, ty: number) => number,
): number {
  const floor = cells.floor;
  if (floor !== null && floor[cellOf(cells, layout, tx, ty)] === 0) return 0;
  return raw(tx, ty);
}

/**
 * Дилатация в тексель за телом: наибольшая глубина среди соседних текселей
 * тела; соседей нет — своё «урез − поле». Восемь соседей, а не четыре: у
 * внутреннего угла стены водяной сосед бывает только по диагонали.
 */
function dilated(
  cells: WaterDepthCells,
  layout: WaterDepthLayout,
  tx: number,
  ty: number,
  raw: (tx: number, ty: number) => number,
): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const value = sourceDepth(cells, layout, tx + dx, ty + dy, raw);
      if (value > best) best = value;
    }
  }
  return best === Number.NEGATIVE_INFINITY ? raw(tx, ty) : best;
}

/**
 * Глубина соседа как ИСТОЧНИКА дилатации: минус бесконечность у текселя за
 * покрытием и у текселя, телу не принадлежащего, — источником он не является.
 */
function sourceDepth(
  cells: WaterDepthCells,
  layout: WaterDepthLayout,
  tx: number,
  ty: number,
  raw: (tx: number, ty: number) => number,
): number {
  if (tx < 0 || ty < 0 || tx >= layout.width || ty >= layout.height) {
    return Number.NEGATIVE_INFINITY;
  }
  if (!inBody(cells, layout, tx, ty)) return Number.NEGATIVE_INFINITY;
  return bodyDepth(cells, layout, tx, ty, raw);
}

/**
 * Прямоугольник текселей, накрывающий прямоугольник клеток [x0..x1] × [y0..y1]
 * (включительно) — адрес точечной инвалидации (REND-35: правка кривизны,
 * walkable-вклад, догрузка ассета и переподача сетки видны не позже следующего
 * кадра). Клетка вне покрытия даёт пустой прямоугольник.
 */
export function depthTexelRect(
  layout: WaterDepthLayout,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): WaterTexelRect {
  const density = layout.texelsPerCell;
  return {
    tx0: (x0 - layout.cellX) * density,
    ty0: (y0 - layout.cellY) * density,
    tx1: (x1 - layout.cellX + 1) * density - 1,
    ty1: (y1 - layout.cellY + 1) * density - 1,
  };
}
