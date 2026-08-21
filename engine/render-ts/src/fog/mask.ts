/**
 * Маска видимости команды игрока (FOW-7, FOW-9) — CPU-растр в мировых
 * координатах (design D1): один grayscale-буфер, покрывающий прямоугольник
 * террейна, перестраиваемый на каденсе доставки.
 *
 * Для каждого наблюдателя своей команды рисуется reveal-полигон: круг
 * эффективного радиуса с радиальным градиентом края настраиваемой ширины
 * (FOW-7), обрезанный 2D shadow-casting'ом по cliff-отрезкам в радиусе (FOW-9).
 * Тени направлены по высоте, как перекрытие симуляции (PHYS-13): ребро
 * отбрасывает тень, только если его верхний уровень выше уровня наблюдателя —
 * с плато открыты и низ, и плато того же уровня за низиной.
 * Наблюдатели складываются максимумом: пересечение кругов не темнее одного.
 *
 * Тени считаются полярным depth-буфером на наблюдателя (design D3 change
 * `fow-directional-cliff-vision`): по блокирующим отрезкам в радиусе строится
 * 1D-буфер «угол → дистанция ближайшей тени», и каждый тексель платит O(1)
 * вместо теста против каждого отрезка. Стоимость перестройки — O(тексели +
 * бины × отрезки), и на плато с десятками отрезков в радиусе она не проседает.
 *
 * Вся геометрия здесь — float и приближение (REND-1): побайтового совпадения с
 * `raycast` симуляции не требуется, а расхождение консервативно — минимум по
 * соседним бинам расширяет тень, наблюдатель на линии ребра считается нижней
 * стороной, то есть там, где приближение сомневается, туман, а не свет (FOW-9).
 *
 * Точка входной границы Q16.16 → float — `fogRectOf`/`fogSegmentsOf`: сетка и
 * cliff-отрезки приезжают из ядра fixed-point (TERR-2, TERR-5), конверсия — в
 * точке приёма, глубже по маске fixed-point не существует (REND-1).
 *
 * Перестройка нарезается на порции (change `fog-mask-budgeted-rebuild`, design
 * D1–D2): проходы `clear`/`reveal`/`smooth` умеют работать по диапазону строк в
 * ЗАДНИЙ растр, а `commit()` публикует построенное свопом ссылок. Потребители
 * маски видят только целиком построенный передний растр — полупостроенного
 * состояния не наблюдает никто.
 */
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import { costSink } from '../cost.js';
import type { FogDirtyBlocks } from './dirty.js';

/** Прямоугольник мира, который покрывает маска, — прямоугольник террейна. */
export interface FogWorldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Отрезок укрытия в мировых float-координатах — производная `TerrainGrid.cliffs`
 * (TERR-5). Уровни сторон переезжают из `CliffEdge` как есть: `levelNeg` —
 * сторона меньшей координаты по оси нормали, `levelPos` — большей. По ним тень
 * становится направленной (FOW-9, PHYS-13).
 *
 * Отрезок обязан быть осевым (`x1 === x2` либо `y1 === y2`): других TERR-5 не
 * порождает, и полярная растеризация на это опирается. Диагональный отрезок —
 * ошибка вызова, а не молча неверная тень: `reveal` его отвергает.
 */
export interface FogSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly levelNeg: number;
  readonly levelPos: number;
}

/**
 * Наблюдатель своей команды: позиция и эффективный радиус в мировых единицах.
 * Уровень — доставленный `EntityView.currLevel` (TERR-4 производное): по нему
 * рёбра не выше наблюдателя не отбрасывают тень (`segmentCasts`, PHYS-13); он
 * же — слот сигнатуры перестройки маски (design D4).
 */
export interface FogObserver {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly level: number;
}

/** Прямоугольник маски из сетки террейна — приём `tileSize` (REND-1, TERR-2). */
export function fogRectOf(grid: TerrainGrid): FogWorldRect {
  const tile = grid.tileSize / FIXED_ONE;
  return { x: 0, y: 0, width: grid.width * tile, height: grid.height * tile };
}

/**
 * Cliff-отрезки сетки во float (REND-1): те же отрезки, что несут `blocksVision`
 * в симуляции (TERR-5, FOW-9), — не выведенные заново, а переиспользованные,
 * вместе с уровнями сторон (PHYS-13).
 */
export function fogSegmentsOf(grid: TerrainGrid): readonly FogSegment[] {
  return grid.cliffs.map((edge) => ({
    x1: edge.from.x / FIXED_ONE,
    y1: edge.from.y / FIXED_ONE,
    x2: edge.to.x / FIXED_ONE,
    y2: edge.to.y / FIXED_ONE,
    levelNeg: edge.levelNeg,
    levelPos: edge.levelPos,
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
 * Отбрасывает ли ребро тень для наблюдателя этого уровня (FOW-9): только если
 * верхний уровень ребра строго выше уровня наблюдателя — зеркало перекрытия
 * луча по высоте в симуляции (PHYS-13, FOW-5). Рёбра своего уровня и ниже
 * прозрачны: с плато открыт и низ за собственным ребром, и плато того же
 * уровня за низиной; снизу вверх ребро перекрывает.
 */
export function segmentCasts(level: number, segment: FogSegment): boolean {
  return (segment.levelNeg > segment.levelPos ? segment.levelNeg : segment.levelPos) > level;
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
 * Число бинов полярного depth-буфера (design D3). С запасом к дискретности
 * растра: на радиусе 22 юнита (предел PHYS-6 с хвостом) дуга бина ≈ 0.13
 * юнита ≈ тексель разрешения 8 — угловая дискретность не грубее прежней
 * растеризации субсэмплами.
 */
const SHADOW_BINS = 1024;
const TWO_PI = Math.PI * 2;

/** Бин по углу `atan2` (−π, π]; края зажимаются в диапазон индексов. */
function binOf(angle: number): number {
  const bin = Math.floor(((angle + Math.PI) / TWO_PI) * SHADOW_BINS);
  return bin < 0 ? 0 : bin >= SHADOW_BINS ? SHADOW_BINS - 1 : bin;
}

/**
 * Проход разделяемого блюра кромки (FOW-7): горизонталь пишет промежуточный
 * буфер, вертикаль читает только его. Порционная перестройка идёт ими по
 * очереди — сперва весь горизонтальный, затем весь вертикальный (design D1).
 */
export type FogSmoothPass = 'horizontal' | 'vertical';

/**
 * Растр маски: байт на тексель, 0 — туман, 255 — видно. Ряд 0 — минимальный
 * `y` мира (v = 0 текстуры); переворот для canvas-потребителей — дело блита,
 * а не растра.
 *
 * Растра ДВА (design D2 change `fog-mask-budgeted-rebuild`): передний —
 * опубликованный, его и видят потребители (`data`, `valueAt`, рассеивание,
 * миникарта, отладочный источник); задний — тот, в который пишут порции
 * незавершённой перестройки. `commit()` меняет их ссылки местами, и
 * полупостроенное состояние не наблюдаемо ни в одном кадре. Синхронный путь
 * (`clear` → `reveal` → `smooth`) пишет ПЕРЕДНИЙ растр и остаётся за снапом
 * (REND-2) и автономным использованием маски.
 */
export class VisibilityMask {
  readonly rect: FogWorldRect;
  /** Текселей на мировую единицу — разрешение маски (FOW-10). */
  readonly texelsPerUnit: number;
  readonly width: number;
  readonly height: number;
  /** Опубликованный растр — единственное, что видят потребители маски. */
  private front: Uint8Array;
  /** Задний растр порционной перестройки; null — порционного пути не было. */
  private backing: Uint8Array | null = null;

  /** Переиспользуемый список укрытий, затеняющих текущего наблюдателя. */
  private readonly near: FogSegment[] = [];
  /**
   * Полярный depth-буфер текущего наблюдателя (design D3): дистанция ближайшей
   * тени по углу. Переиспользуется между наблюдателями и доставками — горячий
   * путь перестройки не аллоцирует. Порционный reveal его переживает: буфер
   * готовится при входе в наблюдателя и читается его строками, а наблюдатели
   * идут строго по одному — второго claim'а на буфер в этот момент нет.
   */
  private readonly depth = new Float32Array(SHADOW_BINS);
  /**
   * Тот же буфер, уже свёрнутый минимумом по тройке соседних бинов, — то, что
   * и читает цикл по текселям (консервативность FOW-9). Свёртка живёт здесь, а
   * не в цикле, потому что бинов тысяча, а текселей — сотня тысяч: одна и та же
   * тройка иначе пересчитывалась бы сотнями раз.
   */
  private readonly depthMin = new Float32Array(SHADOW_BINS);
  /** Переиспользуемый буфер разделяемого блюра `smooth()`. */
  private temp: Uint8Array | null = null;

  /**
   * Подготовленный наблюдатель порционного reveal (design D1): границы его
   * прямоугольника и пороги, которые читает цикл по текселям. Запись одна и
   * переиспользуется — подготовка наблюдателя не аллоцирует.
   */
  private readonly staged = {
    x0: 0,
    x1: 0,
    y0: 0,
    y1: -1,
    ox: 0,
    oy: 0,
    radiusSq: 0,
    innerSq: 0,
    edgeWidth: 0,
    radius: 0,
    shadowed: false,
    nearestShadowSq: 0,
  };

  constructor(rect: FogWorldRect, texelsPerUnit: number) {
    this.rect = rect;
    this.texelsPerUnit = texelsPerUnit;
    this.width = Math.max(1, Math.round(rect.width * texelsPerUnit));
    this.height = Math.max(1, Math.round(rect.height * texelsPerUnit));
    this.front = new Uint8Array(this.width * this.height);
  }

  /** Опубликованный растр: то, что видят потребители маски (design D2). */
  get data(): Uint8Array {
    return this.front;
  }

  /** Всё в туман — начало перестройки на каждой доставке (design D1). */
  clear(): void {
    this.clearInto(this.front, 0, this.height - 1);
  }

  // ------------------------------------------- порционная перестройка (D1, D2)

  /**
   * Начало порционной перестройки: задний растр заводится при первом же
   * обращении и дальше переиспользуется — перестройка не аллоцирует.
   */
  beginBuild(): void {
    this.backing ??= new Uint8Array(this.front.length);
  }

  /** Обнуление строк [y0, y1] ЗАДНЕГО растра; возвращает объём работы. */
  clearRows(y0: number, y1: number): number {
    return this.clearInto(this.back(), y0, y1);
  }

  /**
   * Строки [y0, y1] подготовленного наблюдателя — в ЗАДНИЙ растр. Порядок
   * записей внутри наблюдателя тот же, что у синхронного пути: нарезка идёт по
   * строкам, и результат порционной сборки побитово равен синхронной.
   */
  revealRows(y0: number, y1: number): number {
    return this.writeReveal(this.back(), y0, y1);
  }

  /** Один проход блюра кромки по строкам [y0, y1] ЗАДНЕГО растра (FOW-7). */
  smoothRows(pass: FogSmoothPass, y0: number, y1: number): number {
    return this.smoothInto(this.back(), pass, y0, y1);
  }

  /**
   * Публикация построенного растра (design D2): передний и задний меняются
   * ссылками, и потребители в тот же момент начинают видеть целиком построенную
   * маску. Прежний передний растр остаётся под рукой задним — по нему считается
   * грязное окно рассеивания (design D5).
   *
   * Возвращает число текселей, сравнённых при разметке окна (PERF-3).
   */
  commit(dirty: FogDirtyBlocks | null): number {
    const built = this.back();
    const previous = this.front;
    this.front = built;
    this.backing = previous;
    return dirty === null ? 0 : dirty.markChanged(previous, built, this.width, this.height);
  }

  /** Первая строка прямоугольника подготовленного наблюдателя (design D1). */
  get revealFirstRow(): number {
    return this.staged.y0;
  }

  /** Последняя его строка; меньше первой — рисовать нечего. */
  get revealLastRow(): number {
    return this.staged.y1;
  }

  /** Текселей в строке его прямоугольника — знаменатель порции (PERF-3). */
  get revealRowTexels(): number {
    return this.staged.x1 - this.staged.x0 + 1;
  }

  /**
   * Reveal-полигон одного наблюдателя (FOW-7, FOW-9): круг эффективного
   * радиуса с градиентом края, обрезанный тенями укрытий в радиусе. Складывается
   * с уже нарисованным максимумом. Синхронный путь: подготовка и все строки
   * сразу, в ПЕРЕДНИЙ растр.
   */
  reveal(observer: FogObserver, edgeWidth: number, segments: readonly FogSegment[]): void {
    this.prepareReveal(observer, edgeWidth, segments);
    this.writeReveal(this.front, this.staged.y0, this.staged.y1);
  }

  /**
   * Подготовка наблюдателя к записи (design D1): границы прямоугольника, отбор
   * укрытий в радиусе и полярный depth-буфер — то, что нарезать нечего и что
   * строки потом только читают. Возвращает объём работы подготовки в единицах
   * бюджета: тесты «отрезок в радиусе» плюс пройденные бины (PERF-3).
   */
  prepareReveal(
    observer: FogObserver,
    edgeWidth: number,
    segments: readonly FogSegment[],
  ): number {
    const staged = this.staged;
    staged.y1 = -1; // рисовать нечего, пока границы не сошлись
    const radius = observer.radius;
    if (radius <= 0) return 0;
    const scale = this.texelsPerUnit;
    const x0 = Math.max(0, Math.floor((observer.x - radius - this.rect.x) * scale));
    const x1 = Math.min(this.width - 1, Math.ceil((observer.x + radius - this.rect.x) * scale));
    const y0 = Math.max(0, Math.floor((observer.y - radius - this.rect.y) * scale));
    const y1 = Math.min(this.height - 1, Math.ceil((observer.y + radius - this.rect.y) * scale));
    if (x1 < x0 || y1 < y0) return 0;

    // Тени отбрасывают только укрытия в радиусе (FOW-9): дальние в круг не
    // дотягиваются. Высота — здесь же (PHYS-13): ребро не выше уровня
    // наблюдателя прозрачно и в буфер не попадает.
    const near = this.near;
    near.length = 0;
    const radiusSq = radius * radius;
    for (const segment of segments) {
      if (segment.x1 !== segment.x2 && segment.y1 !== segment.y2) {
        throw new Error(
          'FOW-9: отрезок укрытия обязан быть осевым (TERR-5) — ' +
            'диагональную тень полярная растеризация не считает',
        );
      }
      if (!segmentCasts(observer.level, segment)) continue;
      if (distanceSqToSegment(observer.x, observer.y, segment) <= radiusSq) near.push(segment);
    }

    // Полярный depth-буфер наблюдателя (design D3): бины, пройденные
    // растеризацией, возвращаются наверх числом — счёт идёт не в цикле по
    // бинам, а сложением на отрезок (PERF-3). Дистанции лежат в КВАДРАТАХ —
    // см. `rasterizeArc`: сравнение с текселем тогда идёт по `distSq`, и
    // корень из него не берётся вовсе.
    const depth = this.depth;
    const depthMin = this.depthMin;
    let shadowRays = 0;
    // Ближайшая тень ЛЮБОГО направления: тексель ближе неё не затенён ничем, и
    // спрашивать у него угол незачем — а угол здесь единственный `atan2` на
    // тексель, самая дорогая операция цикла.
    let nearestShadowSq = Number.POSITIVE_INFINITY;
    if (near.length > 0) {
      depth.fill(Number.POSITIVE_INFINITY);
      for (const segment of near) {
        shadowRays += this.rasterizeSegment(observer.x, observer.y, segment);
      }
      for (let bin = 0; bin < SHADOW_BINS; bin++) {
        const value = Math.min(
          depth[bin]!,
          depth[bin === 0 ? SHADOW_BINS - 1 : bin - 1]!,
          depth[bin === SHADOW_BINS - 1 ? 0 : bin + 1]!,
        );
        depthMin[bin] = value;
        if (value < nearestShadowSq) nearestShadowSq = value;
      }
    }

    // Сток читается один раз на наблюдателя, не на тексель (PERF-3): объём
    // просмотра — арифметика границ прямоугольника, а не счёт в цикле.
    const cost = costSink();
    if (cost !== undefined) {
      cost.fogRevealCalls++;
      cost.fogSegmentRangeTests += segments.length;
      cost.fogNearSegments += near.length;
      cost.fogShadowRayTests += shadowRays;
      cost.fogMaskTexels += (x1 - x0 + 1) * (y1 - y0 + 1);
    }

    // Порог ПОЛНОГО света в квадрате расстояния: до него `edgeGradient` равен
    // единице тождественно, то есть значение текселя — 255, и ни корень, ни
    // сглаживание кромки его не уточняют. На арене демо (радиус обзора 24,
    // кромка 2,5) внутрь порога попадает ~80 % круга — ровно столько текселей
    // проходят цикл без `Math.sqrt`. Вырожденные случаи разведены: нулевая
    // кромка делает полным светом весь круг, кромка шире радиуса — ни один
    // тексель (порог −1 недостижим для квадрата расстояния).
    const inner = radius - edgeWidth;
    staged.x0 = x0;
    staged.x1 = x1;
    staged.y0 = y0;
    staged.y1 = y1;
    staged.ox = observer.x;
    staged.oy = observer.y;
    staged.radius = radius;
    staged.radiusSq = radiusSq;
    staged.innerSq = edgeWidth <= 0 ? radiusSq : inner > 0 ? inner * inner : -1;
    staged.edgeWidth = edgeWidth;
    staged.shadowed = near.length > 0;
    staged.nearestShadowSq = nearestShadowSq;
    // Подготовка стоит бюджету своей работы: отбор укрытий идёт по всем
    // отрезкам сетки, растеризация — по дугам бинов (design D1).
    return segments.length + shadowRays;
  }

  /**
   * Строки [y0, y1] подготовленного наблюдателя в растр `target`.
   *
   * `fogMaskTexelsWritten` — счётчик ЗАПИСЕЙ, и он единственный здесь зависит
   * от порядка наблюдателей: тексель в перекрытии двух кругов получает запись
   * только пока значение растёт, поэтому «кто первым» решает, достанется ему
   * одна запись или две. Порядок задаёт вставка сущностей в доставку —
   * перестановка сущностей сдвигает счётчик, не меняя ни картинки, ни настоящей
   * стоимости. Диффом эталона по одному этому полю удорожание не доказывается
   * (`cost.ts`). Нарезка на порции его не двигает: строки идут тем же порядком,
   * и решение текселя зависит только от уже лежащего в растре значения.
   */
  private writeReveal(target: Uint8Array, y0: number, y1: number): number {
    const staged = this.staged;
    if (y1 > staged.y1) y1 = staged.y1;
    if (y1 < y0) return 0;
    const { x0, x1, ox, oy, radius, radiusSq, innerSq, edgeWidth, shadowed } = staged;
    const nearestShadowSq = staged.nearestShadowSq;
    const depthMin = this.depthMin;
    const scale = this.texelsPerUnit;
    const width = this.width;
    // Центр наблюдателя и начало растра — в локальных, а не полями объекта:
    // цикл читает их сотню тысяч раз за перестройку.
    const rectX = this.rect.x;
    const rectY = this.rect.y;
    let written = 0;
    for (let ty = y0; ty <= y1; ty++) {
      const wy = rectY + (ty + 0.5) / scale;
      const dy = wy - oy;
      const dySq = dy * dy;
      const row = ty * width;
      for (let tx = x0; tx <= x1; tx++) {
        const dx = rectX + (tx + 0.5) / scale - ox;
        const distSq = dx * dx + dySq;
        if (distSq >= radiusSq) continue;
        const current = target[row + tx]!;
        if (current === 255) continue; // уже полностью открыт другим наблюдателем
        const value =
          distSq <= innerSq
            ? 255
            : Math.round(edgeGradient(Math.sqrt(distSq), radius, edgeWidth) * 255);
        if (value <= current) continue;
        if (shadowed && distSq >= nearestShadowSq) {
          // Дистанция тени — минимум своего и соседних бинов: консервативность
          // на разрыве силуэта (интерполяция дала бы свет в тени), тень шире, а
          // не уже (FOW-9). Тройка свёрнута до цикла (`depthMin`), сравнение
          // идёт в КВАДРАТАХ — буфер хранит их же: возведение монотонно на
          // неотрицательных, и срез тот же самый.
          const bin = binOf(Math.atan2(dy, dx));
          if (distSq >= depthMin[bin]!) continue; // за тенью — срез жёсткий, полутон делает smooth()
        }
        target[row + tx] = value;
        written++;
      }
    }
    const cost = costSink();
    if (cost !== undefined) cost.fogMaskTexelsWritten += written;
    return (y1 - y0 + 1) * (x1 - x0 + 1);
  }

  /** Обнуление строк [y0, y1] растра `target` — общий шов обоих путей. */
  private clearInto(target: Uint8Array, y0: number, y1: number): number {
    if (y1 < y0) return 0;
    const from = y0 * this.width;
    const to = (y1 + 1) * this.width;
    const cost = costSink();
    // Обнуление стоит всей маски и растёт квадратом разрешения — счётчик
    // видит это удорожание даже там, где наблюдателей нет вовсе (PERF-3).
    if (cost !== undefined) cost.fogMaskClearTexels += to - from;
    target.fill(0, from, to);
    return to - from;
  }

  /** Задний растр порционной перестройки; без `beginBuild` его не бывает. */
  private back(): Uint8Array {
    const back = this.backing;
    if (back === null) {
      throw new Error('порционная перестройка маски не начата: beginBuild() не вызван');
    }
    return back;
  }

  /**
   * Растеризация отрезка в полярный буфер (design D3): угловой интервал по
   * концам отрезка, в каждый бин — минимум дистанции пересечения луча бина с
   * линией отрезка. Интервал, накрывающий разрыв `atan2` (±π), пишется двумя
   * дугами. Дистанция до бесконечной линии, а не до отрезка: бины внутри
   * интервала пересекают сам отрезок, а краевой бин, чей центр вышел за конец,
   * получает дистанцию края — расхождение на ширину бина в сторону тени.
   *
   * Возвращает число пройденных бинов — тестов «луч бина × линия отрезка»
   * (`fogShadowRayTests`, PERF-3). Величина арифметическая: цикл по бинам
   * счётчика не касается, его складывает вызывающий.
   */
  private rasterizeSegment(ox: number, oy: number, segment: FogSegment): number {
    // Наблюдатель ровно на линии ребра: угловая растеризация вырождается
    // (offset = 0, все t = 0), и без отдельной ветки тень исчезала бы вовсе —
    // протечка света ровно там, где FOW-9 требует туман.
    const onLineVertical = segment.x1 === segment.x2 && segment.x1 === ox;
    const onLineHorizontal = segment.y1 === segment.y2 && segment.y1 === oy;
    if (onLineVertical || onLineHorizontal) {
      return this.rasterizeOnLine(ox, oy, segment, onLineVertical);
    }
    const a0 = Math.atan2(segment.y1 - oy, segment.x1 - ox);
    const a1 = Math.atan2(segment.y2 - oy, segment.x2 - ox);
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    if (hi - lo <= Math.PI) {
      return this.rasterizeArc(ox, oy, segment, binOf(lo), binOf(hi));
    }
    // Отрезок субтендирует меньше π, значит интервал [lo, hi] шире π — это
    // дополнение: дуга идёт через разрыв ±π двумя половинами.
    return (
      this.rasterizeArc(ox, oy, segment, 0, binOf(lo)) +
      this.rasterizeArc(ox, oy, segment, binOf(hi), SHADOW_BINS - 1)
    );
  }

  /**
   * Одна дуга интервала: бины подряд, в бин — минимум дистанции (design D3).
   * Возвращает число пройденных бинов — объём работы дуги (PERF-3).
   *
   * Хранится КВАДРАТ дистанции, а не она сама: единственный читатель буфера —
   * цикл по текселям `reveal`, а у него на руках квадрат расстояния до
   * наблюдателя. Возведение монотонно на неотрицательных, поэтому срез тени
   * тот же самый, зато корень не берётся ни разу на тексель. Бины сравниваются
   * между собой тем же минимумом — порядок квадраты не меняют.
   */
  private rasterizeArc(
    ox: number,
    oy: number,
    segment: FogSegment,
    binLo: number,
    binHi: number,
  ): number {
    const depth = this.depth;
    const vertical = segment.x1 === segment.x2;
    const offset = vertical ? segment.x1 - ox : segment.y1 - oy;
    for (let bin = binLo; bin <= binHi; bin++) {
      const angle = ((bin + 0.5) / SHADOW_BINS) * TWO_PI - Math.PI;
      const along = vertical ? Math.cos(angle) : Math.sin(angle);
      if (along === 0) continue;
      const t = offset / along;
      // Пересечение позади луча — краевой бин смотрит от линии; тени нет.
      if (t <= 0) continue;
      const tSq = t * t;
      if (tSq < depth[bin]!) depth[bin] = tSq;
    }
    return binHi - binLo + 1;
  }

  /**
   * Тень наблюдателя, стоящего на линии ребра (side === 0, FOW-9). Стоя на
   * самом отрезке, наблюдатель перекрыт целиком — симуляция для такой позиции
   * даёт hit на нулевой дистанции любому лучу поперёк ребра — и весь буфер
   * получает ноль. Вне пролёта отрезка тень занимает только направления вдоль
   * линии до ближайшего конца (бин направления и его соседи — консервативно).
   *
   * Возвращает число тронутых бинов (PERF-3): весь буфер, когда наблюдатель в
   * пролёте отрезка, и три бина — когда вне его.
   */
  private rasterizeOnLine(
    ox: number,
    oy: number,
    segment: FogSegment,
    vertical: boolean,
  ): number {
    const depth = this.depth;
    const lo = vertical ? Math.min(segment.y1, segment.y2) : Math.min(segment.x1, segment.x2);
    const hi = vertical ? Math.max(segment.y1, segment.y2) : Math.max(segment.x1, segment.x2);
    const at = vertical ? oy : ox;
    if (at >= lo && at <= hi) {
      depth.fill(0);
      return SHADOW_BINS;
    }
    const dist = at < lo ? lo - at : at - hi;
    // В буфере — квадраты (см. `rasterizeArc`); ноль полного перекрытия выше
    // квадратом и остаётся нулём.
    const distSq = dist * dist;
    const toward = at < lo ? 1 : -1;
    const angle = vertical ? Math.atan2(toward, 0) : Math.atan2(0, toward);
    const bin = binOf(angle);
    const prev = bin === 0 ? SHADOW_BINS - 1 : bin - 1;
    const next = bin === SHADOW_BINS - 1 ? 0 : bin + 1;
    if (distSq < depth[bin]!) depth[bin] = distSq;
    if (distSq < depth[prev]!) depth[prev] = distSq;
    if (distSq < depth[next]!) depth[next] = distSq;
    return 3;
  }

  /**
   * Полутоновая кромка (FOW-7): разделяемый box-блюр радиуса 1 текселя по всей
   * маске ПОСЛЕ всех reveal. Полярная растеризация даёт жёсткий срез и на
   * радиальном фронте тени, и на угловых сторонах конуса — блюр превращает оба
   * в полутон ~текселя одинаково для любого направления кромки (замена прежних
   * 2×2 субсэмплов). Симметричный перенос света ≤ полтекселя за геометрию тени
   * покрыт консервативным запасом радиуса (FOW-9, коэффициент FOW-10).
   */
  smooth(): void {
    this.smoothInto(this.front, 'horizontal', 0, this.height - 1);
    this.smoothInto(this.front, 'vertical', 0, this.height - 1);
  }

  /**
   * Один проход блюра по строкам [y0, y1] растра `target` — общий шов
   * синхронного и порционного путей.
   *
   * Проходы разделены и идут строго по очереди: горизонтальный пишет только
   * `temp`, вертикальный только его и читает — поэтому нарезка по строкам ничего
   * не путает, лишь бы ВЕСЬ горизонтальный проход закончился до первой строки
   * вертикального (это порядок фаз, design D1).
   *
   * Объём блюра — 2 × растр и растёт квадратом разрешения, как обнуление и
   * загрузка. Новой ручки качества это не требует (QUAL-3): объём правит тот же
   * потолок `fog.maskResolution` (FOW-10), а сток читается один раз на порцию —
   * величина арифметическая, в циклах по текселям счёта нет (PERF-3).
   */
  private smoothInto(target: Uint8Array, pass: FogSmoothPass, y0: number, y1: number): number {
    if (y1 < y0) return 0;
    const { width, height } = this;
    const cost = costSink();
    const texels = (y1 - y0 + 1) * width;
    if (cost !== undefined) cost.fogMaskSmoothTexels += texels;
    if (this.temp?.length !== target.length) {
      this.temp = new Uint8Array(target.length);
    }
    const temp = this.temp;
    if (pass === 'horizontal') {
      const last = width - 1;
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        // Скользящее окно вместо трёх чтений на тексель: горизонтальный проход
        // читает подряд, и сосед слева — это середина прошлого шага. Края
        // повторяют себя ровно как прежние зажимы индекса.
        let left = target[row]!;
        let mid = left;
        for (let x = 0; x < width; x++) {
          const right = x === last ? mid : target[row + x + 1]!;
          temp[row + x] = (left + mid + right + 1) / 3;
          left = mid;
          mid = right;
        }
      }
      return texels;
    }
    for (let y = y0; y <= y1; y++) {
      const row = y * width;
      const up = (y === 0 ? 0 : y - 1) * width;
      const down = (y === height - 1 ? y : y + 1) * width;
      for (let x = 0; x < width; x++) {
        target[row + x] = (temp[up + x]! + temp[row + x]! + temp[down + x]! + 1) / 3;
      }
    }
    return texels;
  }

  /** Доля света в мировой точке [0, 1] — ближайший тексель; вне маски — туман. */
  valueAt(worldX: number, worldY: number): number {
    const tx = Math.floor((worldX - this.rect.x) * this.texelsPerUnit);
    const ty = Math.floor((worldY - this.rect.y) * this.texelsPerUnit);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return this.front[ty * this.width + tx]! / 255;
  }
}
