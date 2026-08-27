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
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
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
 * Поле высот без порта источника поверхности (REND-35, «Сборка без источника
 * поверхности»): полем служит высота уровня клетки (REND-7) — та же опорная
 * высота, что у вертикального смещения инстанса (REND-12). Кривизны в ней нет,
 * поэтому вода в лощине кривизны не видна, а вода в русле из уровней рисуется;
 * ошибкой это не является.
 */
export function levelFieldSampler(grid: TerrainGrid, heightStep: number): WaterFieldSampler {
  // Приём `tileSize` — точка входной границы рендера (REND-1, TERR-2).
  const tile = grid.tileSize / FIXED_ONE;
  return (wx, wy) => {
    const x = Math.min(Math.max(Math.floor(wx / tile), 0), grid.width - 1);
    const y = Math.min(Math.max(Math.floor(wy / tile), 0), grid.height - 1);
    return grid.levels[y * grid.width + x]! * heightStep;
  };
}

/**
 * Заполняет прямоугольник текселей [tx0..tx1] × [ty0..ty1] (включительно,
 * клампится по раскладке) значением «урез − поле» и возвращает число
 * заполненных текселей — счётную величину стоимости (PERF-3).
 *
 * Тексель адресует ЦЕНТР своей ячейки: так билинейная выборка фрагмента и
 * запечённое значение говорят об одной и той же точке, а край покрытия не
 * съезжает на полтекселя.
 */
export function fillWaterDepth(
  target: Uint16Array,
  layout: WaterDepthLayout,
  field: WaterFieldSampler,
  surfaceHeight: number,
  tx0 = 0,
  ty0 = 0,
  tx1 = layout.width - 1,
  ty1 = layout.height - 1,
): number {
  const fromX = Math.max(tx0, 0);
  const fromY = Math.max(ty0, 0);
  const toX = Math.min(tx1, layout.width - 1);
  const toY = Math.min(ty1, layout.height - 1);
  if (toX < fromX || toY < fromY) return 0;
  const stepX = layout.sizeX / layout.width;
  const stepY = layout.sizeY / layout.height;
  for (let ty = fromY; ty <= toY; ty++) {
    const wy = layout.originY + (ty + 0.5) * stepY;
    for (let tx = fromX; tx <= toX; tx++) {
      const wx = layout.originX + (tx + 0.5) * stepX;
      target[ty * layout.width + tx] = DataUtils.toHalfFloat(surfaceHeight - field(wx, wy));
    }
  }
  return (toX - fromX + 1) * (toY - fromY + 1);
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
): { tx0: number; ty0: number; tx1: number; ty1: number } {
  const density = layout.texelsPerCell;
  return {
    tx0: (x0 - layout.cellX) * density,
    ty0: (y0 - layout.cellY) * density,
    tx1: (x1 - layout.cellX + 1) * density - 1,
    ty1: (y1 - layout.cellY + 1) * density - 1,
  };
}
