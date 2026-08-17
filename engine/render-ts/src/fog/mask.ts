/**
 * Маска видимости команды игрока (FOW-7, FOW-9) — CPU-растр в мировых
 * координатах (design D1): один grayscale-буфер, покрывающий прямоугольник
 * террейна, перестраиваемый на каденсе доставки.
 *
 * Для каждого наблюдателя своей команды рисуется reveal-полигон: круг
 * эффективного радиуса с радиальным градиентом края настраиваемой ширины
 * (FOW-7), обрезанный 2D shadow-casting'ом по cliff-отрезкам в радиусе (FOW-9).
 * Наблюдатели складываются максимумом: пересечение кругов не темнее одного.
 *
 * Вся геометрия здесь — float и приближение (REND-1): побайтового совпадения с
 * `raycast` симуляции не требуется, а расхождение консервативно — тень
 * отбрасывает и касание отрезка, то есть там, где приближение сомневается,
 * туман, а не свет (FOW-9).
 *
 * Точка входной границы Q16.16 → float — `fogRectOf`/`fogSegmentsOf`: сетка и
 * cliff-отрезки приезжают из ядра fixed-point (TERR-2, TERR-5), конверсия — в
 * точке приёма, глубже по маске fixed-point не существует (REND-1).
 */
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import { costSink, type RenderCostCounters } from '../cost.js';

/** Прямоугольник мира, который покрывает маска, — прямоугольник террейна. */
export interface FogWorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Отрезок укрытия в мировых float-координатах — производная `TerrainGrid.cliffs` (TERR-5). */
export interface FogSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Наблюдатель своей команды: позиция и эффективный радиус в мировых единицах. */
export interface FogObserver {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Прямоугольник маски из сетки террейна — приём `tileSize` (REND-1, TERR-2). */
export function fogRectOf(grid: TerrainGrid): FogWorldRect {
  const tile = grid.tileSize / FIXED_ONE;
  return { x: 0, y: 0, width: grid.width * tile, height: grid.height * tile };
}

/**
 * Cliff-отрезки сетки во float (REND-1): те же отрезки, что несут `blocksVision`
 * в симуляции (TERR-5, FOW-9), — не выведенные заново, а переиспользованные.
 */
export function fogSegmentsOf(grid: TerrainGrid): readonly FogSegment[] {
  return grid.cliffs.map((edge) => ({
    x1: edge.from.x / FIXED_ONE,
    y1: edge.from.y / FIXED_ONE,
    x2: edge.to.x / FIXED_ONE,
    y2: edge.to.y / FIXED_ONE,
  }));
}

/**
 * Градиент края видимой области (FOW-7): доля света по расстоянию до
 * наблюдателя. Монотонно не возрастает с расстоянием; сглажен smoothstep'ом,
 * чтобы кромка не читалась ни ступенью, ни изломом. Нулевая ширина — резкий
 * край: законная конфигурация, а не деление на ноль.
 */
export function edgeGradient(distance: number, radius: number, edgeWidth: number): number {
  if (distance >= radius) return 0;
  if (edgeWidth <= 0) return 1;
  const t = Math.min((radius - distance) / edgeWidth, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Перекрывает ли отрезок укрытия луч «наблюдатель → точка» (FOW-9, 2D
 * shadow-casting). Касание концом или коллинеарное наложение считается
 * перекрытием: расхождение приближения — в сторону тумана.
 */
export function segmentBlocks(
  ox: number,
  oy: number,
  px: number,
  py: number,
  segment: FogSegment,
): boolean {
  return segmentsCross(ox, oy, px, py, segment.x1, segment.y1, segment.x2, segment.y2);
}

/** Пересечение отрезков [a, b] и [c, d], границы включительно (консервативно). */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Вырожденные случаи — точка на отрезке: тоже тень (консервативность FOW-9).
  if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function onSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    Math.min(ax, bx) <= px && px <= Math.max(ax, bx) &&
    Math.min(ay, by) <= py && py <= Math.max(ay, by)
  );
}

/** Квадрат расстояния от точки до отрезка — отбор укрытий в радиусе наблюдателя. */
function distanceSqToSegment(px: number, py: number, segment: FogSegment): number {
  const vx = segment.x2 - segment.x1;
  const vy = segment.y2 - segment.y1;
  const wx = px - segment.x1;
  const wy = py - segment.y1;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq <= 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return dx * dx + dy * dy;
}

/**
 * Растр маски: байт на тексель, 0 — туман, 255 — видно. Ряд 0 — минимальный
 * `y` мира (v = 0 текстуры); переворот для canvas-потребителей — дело блита,
 * а не растра.
 */
/** Смещения 2×2 субсэмплов тени в долях текселя — плоский массив пар (x, y). */
const SHADOW_SUBSAMPLES = [-0.25, -0.25, 0.25, -0.25, -0.25, 0.25, 0.25, 0.25] as const;

/**
 * Число открытых субсэмплов текселя [0, 4] — покрытие тени, а не бинарный тест
 * по центру: жёсткий переход 0→255 шириной в тексель читается лесенкой на
 * диагонали кромки даже под билинейным сэмплом текстуры, а полутон частичного
 * покрытия и есть «край без ступеней» (FOW-7). Консервативность FOW-9
 * сохранена: частично перекрытый тексель темнее полностью открытого, света
 * тень не добавляет.
 */
function litSubsamples(
  observer: FogObserver,
  wx: number,
  wy: number,
  scale: number,
  near: readonly FogSegment[],
  /** Сток стоимости, уже прочитанный вызывающим (PERF-3): здесь только инкремент. */
  cost: RenderCostCounters | undefined,
): number {
  let lit = 0;
  for (let s = 0; s < SHADOW_SUBSAMPLES.length; s += 2) {
    const sx = wx + SHADOW_SUBSAMPLES[s]! / scale;
    const sy = wy + SHADOW_SUBSAMPLES[s + 1]! / scale;
    let blocked = false;
    for (const segment of near) {
      if (cost !== undefined) cost.fogSubsampleTests++;
      if (segmentBlocks(observer.x, observer.y, sx, sy, segment)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) lit += 1;
  }
  return lit;
}

export class VisibilityMask {
  readonly rect: FogWorldRect;
  /** Текселей на мировую единицу — разрешение маски (FOW-10). */
  readonly texelsPerUnit: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  /** Переиспользуемый список укрытий в радиусе текущего наблюдателя. */
  private readonly near: FogSegment[] = [];

  constructor(rect: FogWorldRect, texelsPerUnit: number) {
    this.rect = rect;
    this.texelsPerUnit = texelsPerUnit;
    this.width = Math.max(1, Math.round(rect.width * texelsPerUnit));
    this.height = Math.max(1, Math.round(rect.height * texelsPerUnit));
    this.data = new Uint8Array(this.width * this.height);
  }

  /** Всё в туман — начало перестройки на каждой доставке (design D1). */
  clear(): void {
    const cost = costSink();
    // Обнуление стоит всей маски и растёт квадратом разрешения — счётчик
    // видит это удорожание даже там, где наблюдателей нет вовсе (PERF-3).
    if (cost !== undefined) cost.fogMaskClearTexels += this.data.length;
    this.data.fill(0);
  }

  /**
   * Reveal-полигон одного наблюдателя (FOW-7, FOW-9): круг эффективного
   * радиуса с градиентом края, обрезанный тенями укрытий в радиусе. Складывается
   * с уже нарисованным максимумом.
   */
  reveal(observer: FogObserver, edgeWidth: number, segments: readonly FogSegment[]): void {
    const radius = observer.radius;
    if (radius <= 0) return;
    const scale = this.texelsPerUnit;
    const x0 = Math.max(0, Math.floor((observer.x - radius - this.rect.x) * scale));
    const x1 = Math.min(this.width - 1, Math.ceil((observer.x + radius - this.rect.x) * scale));
    const y0 = Math.max(0, Math.floor((observer.y - radius - this.rect.y) * scale));
    const y1 = Math.min(this.height - 1, Math.ceil((observer.y + radius - this.rect.y) * scale));
    if (x1 < x0 || y1 < y0) return;

    // Тени отбрасывают только укрытия в радиусе (FOW-9): дальние в круг не
    // дотягиваются, и платить за их проверку на каждом текселе незачем.
    const near = this.near;
    near.length = 0;
    const radiusSq = radius * radius;
    for (const segment of segments) {
      if (distanceSqToSegment(observer.x, observer.y, segment) <= radiusSq) near.push(segment);
    }

    // Сток читается один раз на наблюдателя, не на тексель (PERF-3): объём
    // просмотра — арифметика границ прямоугольника, а не счёт в цикле.
    const cost = costSink();
    if (cost !== undefined) {
      cost.fogRevealCalls++;
      cost.fogSegmentRangeTests += segments.length;
      cost.fogNearSegments += near.length;
      cost.fogMaskTexels += (x1 - x0 + 1) * (y1 - y0 + 1);
    }

    for (let ty = y0; ty <= y1; ty++) {
      const wy = this.rect.y + (ty + 0.5) / scale;
      const dy = wy - observer.y;
      const row = ty * this.width;
      for (let tx = x0; tx <= x1; tx++) {
        const wx = this.rect.x + (tx + 0.5) / scale;
        const dx = wx - observer.x;
        const distSq = dx * dx + dy * dy;
        if (distSq >= radiusSq) continue;
        const current = this.data[row + tx]!;
        if (current === 255) continue; // уже полностью открыт другим наблюдателем
        const value = Math.round(edgeGradient(Math.sqrt(distSq), radius, edgeWidth) * 255);
        if (value <= current) continue;
        if (near.length === 0) {
          this.data[row + tx] = value;
          if (cost !== undefined) cost.fogMaskTexelsWritten++;
          continue;
        }
        const lit = litSubsamples(observer, wx, wy, scale, near, cost);
        if (lit === 0) continue;
        const shaded = lit === 4 ? value : Math.round((value * lit) / 4);
        if (shaded > current) {
          this.data[row + tx] = shaded;
          if (cost !== undefined) cost.fogMaskTexelsWritten++;
        }
      }
    }
  }

  /** Доля света в мировой точке [0, 1] — ближайший тексель; вне маски — туман. */
  valueAt(worldX: number, worldY: number): number {
    const tx = Math.floor((worldX - this.rect.x) * this.texelsPerUnit);
    const ty = Math.floor((worldY - this.rect.y) * this.texelsPerUnit);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return this.data[ty * this.width + tx]! / 255;
  }
}
