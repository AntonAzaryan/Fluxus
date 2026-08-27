/**
 * Клеточные регионы тел воды и их геометрия (`rendering` REND-35, design D1).
 *
 * Регион — маска клеток сетки террейна, разобранная из карты `cells` секции
 * `water` (PRES-2). Меш тела — горизонтальные квады НА УРЕЗЕ: вершины на поле
 * высот не ставятся, вода плоская, рельефно дно. Прямоугольники собираются
 * greedy-объединением клеток региона — фигурный водоём из двухсот клеток
 * рисуется десятком квадов вместо двухсот, а фрагментная работа от этого не
 * меняется вовсе: и глубина, и берег читаются из мировой точки фрагмента.
 *
 * Берег региону не принадлежит: клеточная карта ОГРАНИЧИВАЕТ геометрию тела, а
 * линию воды рисует пересечение уреза полем (REND-35) — фрагмент с
 * неположительной глубиной отбрасывается материалом. Поэтому карта вправе быть
 * щедрой: лишняя клетка стоит квада, а не полосы воды на суше.
 */
import { WATER_EMPTY_CELL } from '@fluxus/assets';

/** Прямоугольник клеток [x0..x0+w) × [y0..y0+h) — один квад меша тела. */
export interface WaterRect {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
}

/** Клеточный регион одного тела воды: маска, её охват и greedy-прямоугольники. */
export interface WaterRegion {
  /** Индекс тела в `bodies` секции. */
  readonly body: number;
  /** Маска по сетке row-major: 1 — клетка тела. */
  readonly mask: Uint8Array;
  /** Клеток в маске; 0 — тело названо секцией, но карта его не разместила. */
  readonly cells: number;
  /** Охват маски в клетках, включительно; пустой регион — `maxX < minX`. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly rects: readonly WaterRect[];
}

/** Плоские данные меша тела — те же поля, что у генераторов террейна (REND-7). */
export interface WaterGeometryData {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Регионы всех тел карты (REND-35). Карта к этому моменту уже проверена
 * валидацией секции (PRES-2): символы в алфавите, ряды по сетке, индексы
 * разрешаются, — поэтому разбор здесь прямой, а клетка вне алфавита просто
 * пропускается, а не толкуется.
 */
export function waterRegionsOf(
  cells: readonly string[],
  width: number,
  height: number,
  bodies: number,
): WaterRegion[] {
  const masks = Array.from({ length: bodies }, () => new Uint8Array(width * height));
  const counts = new Int32Array(bodies);
  const bounds = Array.from({ length: bodies }, () => ({
    minX: width,
    minY: height,
    maxX: -1,
    maxY: -1,
  }));
  const rows = Math.min(cells.length, height);
  for (let y = 0; y < rows; y++) {
    const row = cells[y]!;
    const columns = Math.min(row.length, width);
    for (let x = 0; x < columns; x++) {
      const symbol = row[x]!;
      if (symbol === WATER_EMPTY_CELL) continue;
      const index = symbol.codePointAt(0)! - 0x30;
      if (index < 0 || index >= bodies) continue;
      masks[index]![y * width + x] = 1;
      counts[index]!++;
      const box = bounds[index]!;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    }
  }
  return masks.map((mask, body) => {
    const box = bounds[body]!;
    return {
      body,
      mask,
      cells: counts[body]!,
      minX: box.minX,
      minY: box.minY,
      maxX: box.maxX,
      maxY: box.maxY,
      rects: greedyRects(mask, width, height),
    };
  });
}

/**
 * Greedy-объединение клеток маски в прямоугольники: клетка занимается один раз,
 * полоса тянется вправо, пока клетки в маске, и вниз, пока вся полоса в маске.
 * Обход идёт row-major, поэтому результат — ФУНКЦИЯ МАСКИ, а не порядка вызовов:
 * два разбора одной карты дают один и тот же список.
 */
export function greedyRects(mask: Uint8Array, width: number, height: number): WaterRect[] {
  const taken = new Uint8Array(mask.length);
  const rects: WaterRect[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (mask[at] !== 1 || taken[at] === 1) continue;
      let w = 1;
      while (x + w < width && mask[at + w] === 1 && taken[at + w] !== 1) w++;
      let h = 1;
      while (y + h < height && rowFree(mask, taken, (y + h) * width + x, w)) h++;
      for (let j = 0; j < h; j++) {
        taken.fill(1, (y + j) * width + x, (y + j) * width + x + w);
      }
      rects.push({ x0: x, y0: y, w, h });
    }
  }
  return rects;
}

/** Вся полоса длиной `w` от `start` — в маске и ещё не занята. */
function rowFree(mask: Uint8Array, taken: Uint8Array, start: number, w: number): boolean {
  for (let i = 0; i < w; i++) {
    if (mask[start + i] !== 1 || taken[start + i] === 1) return false;
  }
  return true;
}

/**
 * Меш тела: по квадру на прямоугольник, все вершины на высоте уреза `z`.
 * Обход вершин CCW при взгляде с +Z — нормаль вверх, как у пола террейна.
 * Нормали атрибутом не пишутся: поверхность горизонтальна, а её возмущение
 * считает фрагмент (REND-35) — вершинного смещения у воды нет вовсе.
 */
export function waterGeometryOf(
  rects: readonly WaterRect[],
  tile: number,
  z: number,
): WaterGeometryData {
  const positions = new Float32Array(rects.length * 12);
  const indices = new Uint32Array(rects.length * 6);
  rects.forEach((rect, index) => {
    const x0 = rect.x0 * tile;
    const y0 = rect.y0 * tile;
    const x1 = (rect.x0 + rect.w) * tile;
    const y1 = (rect.y0 + rect.h) * tile;
    positions.set([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], index * 12);
    const base = index * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], index * 6);
  });
  return { positions, indices };
}
