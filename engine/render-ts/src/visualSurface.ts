/**
 * Визуальная поверхность террейна (REND-9, REND-10): непрерывная функция
 * высоты и нормали, единая для геометрии террейна и наклона инстансов.
 * Хелпер принадлежит рендеру, а не какой-то из подсистем: подсистемы за общим
 * контрактом друг о друге не знают (REND-8), обе получают его извне.
 *
 * Базовая высота — уровень клетки × heightStep с рампами по `cornerLevels`;
 * поверх — смещения карты кривизны (ASSET-7), сглаженные усреднением по углам
 * и билинейной интерполяцией внутри клетки. Усреднение в угле идёт только по
 * смежным клеткам уровня самого угла: выпуклость плато не «перетекает» через
 * cliff-границу на нижний уровень, а рампа смыкается с плато без щели.
 * Нормаль — аналитическая производная той же билинейной формы, без численного
 * дифференцирования по кадрам.
 *
 * В матче сетка и карта кривизны иммутабельны (TERR-6) — углы считаются один
 * раз. У документного продюсера (REND-11) они мутабельны: кисти редактора
 * правят уровни и кривизну (ED-10, ED-11), поэтому поверхность умеет
 * пересчитывать углы прямоугольником клеток (`update`), а не собираться заново
 * на каждый мазок. Пересчитанную сетку отдаёт ядро (TERR-5): производные
 * величины здесь не выводятся, только читаются.
 */
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import { CURVATURE_SCALE, type TerrainCurvatureMap } from '@game-mvp/assets';

/**
 * Уровни четырёх углов клетки в порядке [c00, c10, c11, c01] (x,y → x+1,y →
 * x+1,y+1 → x,y+1). У обычной клетки все углы на её уровне; у рампы рёбра,
 * смежные с проходимым перепадом в единицу (TERR-5), поднимаются/опускаются
 * до уровня соседа — так пара «рампа + плато» смыкается без щелей.
 * Порядок рёбер фиксирован (W, E, N, S): последняя запись побеждает —
 * однозначность вместо зависимости от данных.
 */
export function cornerLevels(
  grid: TerrainGrid,
  x: number,
  y: number,
): [number, number, number, number] {
  const cell = y * grid.width + x;
  const own = grid.levels[cell]!;
  const corners: [number, number, number, number] = [own, own, own, own];
  if (grid.ramps[cell] !== 1) return corners;

  const stepNeighbour = (nx: number, ny: number): number | null => {
    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) return null;
    const level = grid.levels[ny * grid.width + nx]!;
    // Сама клетка — рампа, поэтому перепад ровно в единицу проходим (TERR-5).
    return Math.abs(level - own) === 1 ? level : null;
  };

  const west = stepNeighbour(x - 1, y);
  if (west !== null) {
    corners[0] = west;
    corners[3] = west;
  }
  const east = stepNeighbour(x + 1, y);
  if (east !== null) {
    corners[1] = east;
    corners[2] = east;
  }
  const north = stepNeighbour(x, y - 1);
  if (north !== null) {
    corners[0] = north;
    corners[1] = north;
  }
  const south = stepNeighbour(x, y + 1);
  if (south !== null) {
    corners[3] = south;
    corners[2] = south;
  }
  return corners;
}

/** Нормаль поверхности; заполняется `normalAt` без аллокаций на кадр. */
export interface SurfaceNormal {
  x: number;
  y: number;
  z: number;
}

/** Непрерывная визуальная поверхность террейна в мировых единицах. */
export interface VisualSurface {
  readonly hasCurvature: boolean;
  /** Мировые высоты углов клетки [c00, c10, c11, c01] — вход генераторов геометрии. */
  cornerHeights(x: number, y: number): [number, number, number, number];
  /** Высота в мировой точке; тотальна — за краем сетки отвечает ближайшая клетка. */
  heightAt(wx: number, wy: number): number;
  /** Единичная нормаль в мировой точке; пишет в out и возвращает его. */
  normalAt(wx: number, wy: number, out: SurfaceNormal): SurfaceNormal;
}

/**
 * Поверхность, чьи углы можно пересчитать по прямоугольнику клеток. Нужна
 * документному продюсеру: кисть правит несколько клеток, а не арену, и пересчёт
 * всей сетки на мазок съел бы бюджет кадра ED-15 тем же, чем его съела бы
 * пересборка сцены (REND-11).
 */
export interface MutableVisualSurface extends VisualSurface {
  /**
   * Подменяет сетку и карту кривизны и пересчитывает углы клеток прямоугольника
   * [x0..x1] × [y0..y1] (включительно, клампится по сетке). Пустой прямоугольник
   * (`x1 < x0`) меняет только ссылки — так уходит сетка, отличающаяся лишь
   * картой пола: пола поверхность не видит.
   *
   * Прямоугольник задаётся в ИЗМЕНИВШИХСЯ клетках: угол клетки усредняется по
   * смежным с ним клеткам, поэтому расширение на клетку по каждой стороне
   * поверхность делает сама. Размеры сетки и `tileSize` менять нельзя — другая
   * арена требует другой раскладки углов, то есть новой поверхности.
   */
  update(
    grid: TerrainGrid,
    curvature: TerrainCurvatureMap | null,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void;
}

/** Смежные с узлом (nx, ny) клетки — до четырёх; используется усреднением углов. */
const NODE_CELLS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [-1, 0],
  [0, 0],
];

export function createVisualSurface(
  initialGrid: TerrainGrid,
  heightStep: number,
  initialCurvature: TerrainCurvatureMap | null = null,
): MutableVisualSurface {
  const { width, height } = initialGrid;
  let grid = initialGrid;
  let curvature = initialCurvature;
  // Приём сетки — точка входной границы (REND-1, TERR-2): дальше поверхность
  // считается целиком во float.
  let tile = grid.tileSize / FIXED_ONE;

  // Мировые высоты углов каждой клетки, [cell * 4 + corner], порядок cornerLevels.
  const corners = new Float32Array(width * height * 4);
  const offsetOfCorner = (cornerLevel: number, nodeX: number, nodeY: number): number => {
    if (curvature === null) return 0;
    let sum = 0;
    let count = 0;
    for (const [dx, dy] of NODE_CELLS) {
      const cx = nodeX + dx;
      const cy = nodeY + dy;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const cell = cy * width + cx;
      // Только клетки уровня самого угла: через cliff-границу не усредняем.
      if (grid.levels[cell] !== cornerLevel) continue;
      sum += curvature.offsets[cell]!;
      count++;
    }
    return count === 0 ? 0 : (sum / count / CURVATURE_SCALE) * heightStep;
  };

  /** Пересчёт углов клеток прямоугольника; границы клампятся по сетке. */
  const computeCells = (x0: number, y0: number, x1: number, y1: number): void => {
    const fromX = Math.max(x0, 0);
    const fromY = Math.max(y0, 0);
    const toX = Math.min(x1, width - 1);
    const toY = Math.min(y1, height - 1);
    for (let y = fromY; y <= toY; y++) {
      for (let x = fromX; x <= toX; x++) {
        const levels = cornerLevels(grid, x, y);
        const base = (y * width + x) * 4;
        corners[base] = levels[0] * heightStep + offsetOfCorner(levels[0], x, y);
        corners[base + 1] = levels[1] * heightStep + offsetOfCorner(levels[1], x + 1, y);
        corners[base + 2] = levels[2] * heightStep + offsetOfCorner(levels[2], x + 1, y + 1);
        corners[base + 3] = levels[3] * heightStep + offsetOfCorner(levels[3], x, y + 1);
      }
    }
  };
  computeCells(0, 0, width - 1, height - 1);

  /** Клетка и локальные (u, v) точки; за краем — ближайшая клетка (как TERR-4). */
  const scratch = { cell: 0, u: 0, v: 0 };
  const locate = (wx: number, wy: number): void => {
    const gx = wx / tile;
    const gy = wy / tile;
    const cx = Math.min(Math.max(Math.floor(gx), 0), width - 1);
    const cy = Math.min(Math.max(Math.floor(gy), 0), height - 1);
    scratch.cell = cy * width + cx;
    scratch.u = Math.min(Math.max(gx - cx, 0), 1);
    scratch.v = Math.min(Math.max(gy - cy, 0), 1);
  };

  return {
    get hasCurvature(): boolean {
      return curvature !== null;
    },

    update(
      nextGrid: TerrainGrid,
      nextCurvature: TerrainCurvatureMap | null,
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ): void {
      if (nextGrid.width !== width || nextGrid.height !== height) {
        throw new Error(
          `render: поверхность собрана на сетке ${width}×${height}, ` +
            `пришла ${nextGrid.width}×${nextGrid.height} — нужна новая поверхность (REND-9)`,
        );
      }
      grid = nextGrid;
      curvature = nextCurvature;
      // Вторая точка приёма той же входной границы (REND-1, TERR-2).
      tile = grid.tileSize / FIXED_ONE;
      if (x1 < x0 || y1 < y0) return;
      // Угол усредняется по смежным клеткам — правка клетки трогает соседей.
      computeCells(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    },

    cornerHeights(x: number, y: number): [number, number, number, number] {
      const base = (y * width + x) * 4;
      return [corners[base]!, corners[base + 1]!, corners[base + 2]!, corners[base + 3]!];
    },

    heightAt(wx: number, wy: number): number {
      locate(wx, wy);
      const base = scratch.cell * 4;
      const { u, v } = scratch;
      const h00 = corners[base]!;
      const h10 = corners[base + 1]!;
      const h11 = corners[base + 2]!;
      const h01 = corners[base + 3]!;
      return (
        h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h11 * u * v + h01 * (1 - u) * v
      );
    },

    normalAt(wx: number, wy: number, out: SurfaceNormal): SurfaceNormal {
      locate(wx, wy);
      const base = scratch.cell * 4;
      const { u, v } = scratch;
      const h00 = corners[base]!;
      const h10 = corners[base + 1]!;
      const h11 = corners[base + 2]!;
      const h01 = corners[base + 3]!;
      // Производные билинейной формы по мировым осям.
      const dhdx = ((1 - v) * (h10 - h00) + v * (h11 - h01)) / tile;
      const dhdy = ((1 - u) * (h01 - h00) + u * (h11 - h10)) / tile;
      const invLen = 1 / Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
      out.x = -dhdx * invLen;
      out.y = -dhdy * invLen;
      out.z = invLen;
      return out;
    },
  };
}
