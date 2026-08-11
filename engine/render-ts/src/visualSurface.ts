/**
 * Визуальная поверхность террейна (REND-9, REND-10): непрерывная функция
 * высоты и нормали, единая для геометрии террейна и наклона инстансов.
 * Хелпер принадлежит рендеру, а не какой-то из подсистем: подсистемы за общим
 * контрактом друг о друге не знают (REND-8), обе получают его извне.
 *
 * Поле высот — сумма двух слагаемых (REND-9):
 *
 *     h(u, v) = base(u, v) + curv(S(u), S(v)),   S(t) = t² · (3 − 2t)
 *
 * `base` — уровень клетки × heightStep с рампами по `cornerLevels`,
 * интерполированный билинейно; `curv` — узловые смещения карты кривизны
 * (ASSET-7), тоже билинейно, но по параметрам, пропущенным через smoothstep.
 * Смещение задано прямо в узле и общее для всех примыкающих к узлу уровней:
 * на cliff-границе кромка плато и кромка низины сдвигаются одним значением,
 * перепад уровней сохраняется в поле точно, стенка остаётся вертикальной той
 * же высоты — обрыв нельзя «закопать» кривизной по построению (REND-9).
 *
 * Разделение слагаемых и есть причина, по которой поверхность внутри уровня
 * гладкая (C1), а рампа остаётся плоскостью: `S'(0) = S'(1) = 0`, поэтому
 * производная слагаемого кривизны на границе клетки равна нулю с обеих сторон
 * — хребта в узле сетки нет; база через `S` не пропускается, иначе перепад в
 * уровень между углами рампы превратился бы в волну (REND-7). При отсутствии
 * карты `curv ≡ 0`, и поле совпадает с прежним билинейным побитово.
 *
 * Нормаль — аналитическая производная той же формы, без численного
 * дифференцирования по кадрам.
 *
 * В матче сетка и карта кривизны иммутабельны (TERR-6) — углы считаются один
 * раз. У документного источника террейна (REND-14) они мутабельны: кисти редактора
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
  /**
   * Высота в мировой точке, посчитанная по углам ЗАДАННОЙ клетки; точка вне
   * клетки клампится к её границам. Нужна там, где клетку выбирает вызывающий,
   * а не округление координаты: марш picking'а по полю высот (REND-15) на
   * границе двух клеток обязан считать по той, в которую вошёл, — иначе
   * попадание в стенку обрыва разрешалось бы в клетку под ней.
   *
   * Формула та же, что у `heightAt`: обе зовут одну билинейную выборку, второй
   * реализации поля высот не появляется (REND-9).
   */
  heightInCell(cellX: number, cellY: number, wx: number, wy: number): number;
  /** Единичная нормаль в мировой точке; пишет в out и возвращает его. */
  normalAt(wx: number, wy: number, out: SurfaceNormal): SurfaceNormal;
  /**
   * Нормаль, посчитанная по углам ЗАДАННОЙ клетки — близнец `heightInCell` с
   * тем же клампом точки к границам клетки. Вершина геометрии получает нормаль
   * из клетки, которой она принадлежит (REND-9): внутри уровня соседние клетки
   * дают на общем ребре одно и то же (`S'` там ноль, углы общие), а через
   * cliff-границу нормали не усредняются вовсе — силуэт кромки остаётся резким.
   */
  normalInCell(
    cellX: number,
    cellY: number,
    wx: number,
    wy: number,
    out: SurfaceNormal,
  ): SurfaceNormal;
  /**
   * Есть ли у клетки кривизна — «хотя бы одно из четырёх УЗЛОВЫХ смещений
   * ненулевое». Это порог разбиения геометрии (REND-9): поле внутри клетки
   * зависит только от её четырёх узлов, поэтому клетка с нулевыми узлами —
   * ровно плоский квад без швов с разбитым соседом, а клетка на краю холма
   * (общие узлы ненулевые) честно попадает в разбиваемые.
   */
  hasCellCurvature(x: number, y: number): boolean;
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
   * Прямоугольник задаётся в ИЗМЕНИВШИХСЯ клетках: узлы общие у смежных
   * клеток, а углы рампы зависят от уровней соседей, поэтому расширение на
   * клетку по каждой стороне поверхность делает сама. Размеры сетки и `tileSize` менять нельзя — другая
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

export function createVisualSurface(
  initialGrid: TerrainGrid,
  heightStep: number,
  initialCurvature: TerrainCurvatureMap | null = null,
): MutableVisualSurface {
  const { width, height } = initialGrid;
  let grid = initialGrid;
  let curvature = initialCurvature;
  // Приём сетки — точка входной границы (REND-1, TERR-2): дальше поверхность
  // считается целиком во float. Второй случай той же границы — доставка сетки
  // после инициализации (REND-14), см. `update` ниже.
  let tile = grid.tileSize / FIXED_ONE;

  // Мировые высоты углов каждой клетки, [cell * 4 + corner], порядок cornerLevels.
  const corners = new Float32Array(width * height * 4);
  // Узловые смещения кривизны тех же углов в мировых единицах: `corners` минус
  // база. Держатся рядом, а не вычитаются обратно, потому что по ним спрашивают
  // порог разбиения (`hasCellCurvature`) и считают слагаемое `curv` (REND-9).
  const offsets = new Float32Array(width * height * 4);
  // Узел карты — угол клетки, значение — целый множитель 1/CURVATURE_SCALE
  // шага высоты (ASSET-7). Уровень угла узлу безразличен: одно смещение
  // двигает поверхность каждого примыкающего уровня одинаково.
  const offsetOfNode = (nodeX: number, nodeY: number): number => {
    if (curvature === null) return 0;
    return (curvature.offsets[nodeY * (width + 1) + nodeX]! / CURVATURE_SCALE) * heightStep;
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
        const o00 = offsetOfNode(x, y);
        const o10 = offsetOfNode(x + 1, y);
        const o11 = offsetOfNode(x + 1, y + 1);
        const o01 = offsetOfNode(x, y + 1);
        offsets[base] = o00;
        offsets[base + 1] = o10;
        offsets[base + 2] = o11;
        offsets[base + 3] = o01;
        corners[base] = levels[0] * heightStep + o00;
        corners[base + 1] = levels[1] * heightStep + o10;
        corners[base + 2] = levels[2] * heightStep + o11;
        corners[base + 3] = levels[3] * heightStep + o01;
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

  /**
   * Единственная реализация формы поверхности: и высота под точкой, и высота в
   * заданной клетке, и нормаль читают её. Второй копии формулы быть не должно —
   * расхождение с ней и есть расхождение с картинкой (REND-9).
   *
   * База билинейна по (u, v), слагаемое кривизны — по (S(u), S(v)). В углах
   * `S` тождественна, поэтому `sample` в углу равен `corners` побитово, а без
   * карты кривизны все узловые смещения нулевые и остаётся ровно прежняя
   * билинейная форма.
   */
  const sample = (cell: number, u: number, v: number): number => {
    const at = cell * 4;
    const o00 = offsets[at]!;
    const o10 = offsets[at + 1]!;
    const o11 = offsets[at + 2]!;
    const o01 = offsets[at + 3]!;
    const b00 = corners[at]! - o00;
    const b10 = corners[at + 1]! - o10;
    const b11 = corners[at + 2]! - o11;
    const b01 = corners[at + 3]! - o01;
    const base =
      b00 * (1 - u) * (1 - v) + b10 * u * (1 - v) + b11 * u * v + b01 * (1 - u) * v;
    const su = smoothstep(u);
    const sv = smoothstep(v);
    const curv =
      o00 * (1 - su) * (1 - sv) + o10 * su * (1 - sv) + o11 * su * sv + o01 * (1 - su) * sv;
    return base + curv;
  };

  /**
   * Нормаль по углам заданной клетки в её локальных (u, v). Производные —
   * аналитические: у базы прежние, у слагаемого кривизны добавляется множитель
   * `S'`, который на границах клетки обращается в ноль (REND-9).
   */
  const normalOf = (cell: number, u: number, v: number, out: SurfaceNormal): SurfaceNormal => {
    const at = cell * 4;
    const o00 = offsets[at]!;
    const o10 = offsets[at + 1]!;
    const o11 = offsets[at + 2]!;
    const o01 = offsets[at + 3]!;
    const b00 = corners[at]! - o00;
    const b10 = corners[at + 1]! - o10;
    const b11 = corners[at + 2]! - o11;
    const b01 = corners[at + 3]! - o01;
    const su = smoothstep(u);
    const sv = smoothstep(v);
    const dhdu =
      (1 - v) * (b10 - b00) +
      v * (b11 - b01) +
      smoothstepDerivative(u) * ((1 - sv) * (o10 - o00) + sv * (o11 - o01));
    const dhdv =
      (1 - u) * (b01 - b00) +
      u * (b11 - b10) +
      smoothstepDerivative(v) * ((1 - su) * (o01 - o00) + su * (o11 - o10));
    const dhdx = dhdu / tile;
    const dhdy = dhdv / tile;
    const invLen = 1 / Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
    out.x = -dhdx * invLen;
    out.y = -dhdy * invLen;
    out.z = invLen;
    return out;
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
      // Вторая точка приёма той же входной границы: сетка доставлена после
      // инициализации (REND-1, REND-14, TERR-2).
      tile = grid.tileSize / FIXED_ONE;
      if (x1 < x0 || y1 < y0) return;
      // Узел общий у смежных клеток, а углы рампы зависят от уровней соседей —
      // правка клетки трогает соседей, расширение на клетку делает поверхность.
      computeCells(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    },

    cornerHeights(x: number, y: number): [number, number, number, number] {
      const base = (y * width + x) * 4;
      return [corners[base]!, corners[base + 1]!, corners[base + 2]!, corners[base + 3]!];
    },

    heightAt(wx: number, wy: number): number {
      locate(wx, wy);
      return sample(scratch.cell, scratch.u, scratch.v);
    },

    heightInCell(cellX: number, cellY: number, wx: number, wy: number): number {
      const cx = Math.min(Math.max(cellX, 0), width - 1);
      const cy = Math.min(Math.max(cellY, 0), height - 1);
      const u = Math.min(Math.max(wx / tile - cx, 0), 1);
      const v = Math.min(Math.max(wy / tile - cy, 0), 1);
      return sample(cy * width + cx, u, v);
    },

    normalAt(wx: number, wy: number, out: SurfaceNormal): SurfaceNormal {
      locate(wx, wy);
      return normalOf(scratch.cell, scratch.u, scratch.v, out);
    },

    normalInCell(
      cellX: number,
      cellY: number,
      wx: number,
      wy: number,
      out: SurfaceNormal,
    ): SurfaceNormal {
      const cx = Math.min(Math.max(cellX, 0), width - 1);
      const cy = Math.min(Math.max(cellY, 0), height - 1);
      const u = Math.min(Math.max(wx / tile - cx, 0), 1);
      const v = Math.min(Math.max(wy / tile - cy, 0), 1);
      return normalOf(cy * width + cx, u, v, out);
    },

    hasCellCurvature(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      const at = (y * width + x) * 4;
      return (
        offsets[at] !== 0 ||
        offsets[at + 1] !== 0 ||
        offsets[at + 2] !== 0 ||
        offsets[at + 3] !== 0
      );
    },
  };
}

/**
 * Сглаживающий параметр `S(t) = t² · (3 − 2t)`: монотонна на [0, 1], не выходит
 * за его пределы (слагаемое кривизны не выходит за пределы узловых смещений
 * клетки — сплайновых выбросов нет) и обнуляет производную на обоих концах —
 * этим и убирается излом поверхности в узле сетки (REND-9).
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** `S'(t) = 6t(1 − t)`; ноль на обоих концах отрезка — это и есть C1 на границе. */
function smoothstepDerivative(t: number): number {
  return 6 * t * (1 - t);
}
