/**
 * Веса слотов текстурирования в вершинах пола (`rendering` REND-39). Отдельно
 * от генератора геометрии (`terrainGeometry.ts`), потому что это своя величина:
 * генератор выкладывает позиции и нормали — функцию сетки и поверхности, — а
 * веса суть функция РАСКРАСКИ, приезжающей отдельным ассетом (`assets`
 * ASSET-15) и меняющейся без единого сдвига вершины.
 *
 * Модуль ничего не знает ни о сцене, ни о манифесте, ни о потолках пресета: на
 * вход ему дают источник слота клетки, на выход он кладёт четвёрку весов.
 */

/** Слотов в весовой четвёрке: граница числа клеток, сходящихся в узле (REND-39). */
export const TERRAIN_PAINT_SLOTS = 4;

/**
 * Раскраска глазами генератора пола (REND-39): слот клетки и действующее число
 * слотов. Интерфейс узкий намеренно — генератор про манифест, ассеты и потолки
 * пресета не знает, ему нужен один ответ на клетку.
 */
export interface TerrainPaintSource {
  /**
   * Слот клетки, уже зажатый в действующее число слотов; клетка вне сетки —
   * `-1`: вклада в веса она не даёт, и край арены не размывается несуществующим
   * соседом.
   */
  slotAt(cellX: number, cellY: number): number;
}

/** Вклад одной примыкающей клетки; клетка вне сетки и нулевой вес не считаются. */
function addCorner(weights: number[], base: number, slot: number, weight: number): number {
  if (slot < 0 || weight <= 0) return 0;
  weights[base + slot] = weights[base + slot]! + weight;
  return weight;
}

/**
 * Нормировка четвёрки: сумма единица всюду, включая кромку арены, где вкладов
 * меньше четырёх. Нулевой суммы не бывает — хотя бы одна из четырёх клеток
 * лежит в сетке, иначе вершины здесь не было бы вовсе.
 */
function normalize(weights: number[], base: number, total: number): void {
  if (total <= 0 || total === 1) return;
  for (let i = 0; i < TERRAIN_PAINT_SLOTS; i++) weights[base + i] = weights[base + i]! / total;
}

/**
 * Веса слотов в вершине (REND-39). Раскраска — константа на клетку, а вершина
 * берёт её БИЛИНЕЙНО по решётке ЦЕНТРОВ клеток: в центре клетки вес её слота
 * равен единице, в узле сетки четыре примыкающие клетки делят его поровну.
 * Отсюда мягкий шов шириной в клетку на границе двух покрытий и сплошная
 * заливка внутри однородной области — ровно то, что REND-39 и требует.
 *
 * Четырёх весов достаточно ТОЧНО: в узле квадратной сетки сходятся не более
 * четырёх клеток, и пятого вклада не бывает.
 *
 * `weights`/`source`, равные `null`, — сцена без текстурирования: не кладётся
 * ничего, и атрибута у геометрии не появляется вовсе.
 */
export function pushPaintWeights(
  weights: number[] | null,
  source: TerrainPaintSource | null,
  wx: number,
  wy: number,
  tile: number,
): void {
  if (weights === null || source === null) return;
  // Решётка центров клеток: центр клетки (i, j) стоит в (i + 0.5, j + 0.5).
  const gx = wx / tile - 0.5;
  const gy = wy / tile - 0.5;
  const cx = Math.floor(gx);
  const cy = Math.floor(gy);
  const fx = gx - cx;
  const fy = gy - cy;
  const base = weights.length;
  for (let i = 0; i < TERRAIN_PAINT_SLOTS; i++) weights.push(0);
  let total = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const weight = (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy);
      total += addCorner(weights, base, source.slotAt(cx + dx, cy + dy), weight);
    }
  }
  normalize(weights, base, total);
}
