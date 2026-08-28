/**
 * Полярный depth-буфер теней укрытий (FOW-9, design D3 change
 * `fow-directional-cliff-vision`) — «угол → дистанция ближайшей тени» для
 * ОДНОГО наблюдателя маски видимости.
 *
 * Зачем он: тени в маске считались тестом текселя против каждого отрезка в
 * радиусе, и на плато с десятками отрезков цикл по текселям проседал. Здесь по
 * блокирующим отрезкам один раз строится 1D-буфер по бинам, и каждый тексель
 * платит O(1). Стоимость сборки — O(бины × отрезки), и нарезка перестройки на
 * порции её не удешевляет и не удорожает: тот же объём, разложенный по кадрам.
 *
 * Буфер живёт отдельным модулем, а не внутри `mask.ts`, ровно потому, что это
 * замкнутая структура: снаружи её строят по отрезкам и читают по бину, а вся
 * полярная арифметика (разрыв `atan2`, вырожденная позиция на линии ребра,
 * консервативная свёртка по тройке бинов) не выходит наружу.
 *
 * Вся геометрия здесь — float и приближение (REND-1), и расхождение
 * консервативно: минимум по соседним бинам расширяет тень, наблюдатель на
 * линии ребра считается перекрытым — там, где приближение сомневается, туман,
 * а не свет (FOW-9).
 */

/**
 * Отрезок укрытия в мировых float-координатах — производная `TerrainGrid.cliffs`
 * (TERR-5). Уровни сторон переезжают из `CliffEdge` как есть: `levelNeg` —
 * сторона меньшей координаты по оси нормали, `levelPos` — большей. По ним тень
 * становится направленной (FOW-9, PHYS-13).
 *
 * Отрезок обязан быть осевым (`x1 === x2` либо `y1 === y2`): других TERR-5 не
 * порождает, и полярная растеризация на это опирается. Диагональный отрезок —
 * ошибка вызова, а не молча неверная тень: отбор укрытий его отвергает.
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
export function binOf(angle: number): number {
  const bin = Math.floor(((angle + Math.PI) / TWO_PI) * SHADOW_BINS);
  return bin < 0 ? 0 : bin >= SHADOW_BINS ? SHADOW_BINS - 1 : bin;
}

/**
 * Полярный depth-буфер одного наблюдателя. Буферы переиспользуются между
 * наблюдателями и доставками — горячий путь перестройки не аллоцирует.
 * Порционный reveal их переживает: буфер готовится при входе в наблюдателя и
 * читается его строками, а наблюдатели идут строго по одному — второго claim'а
 * на буфер в этот момент нет.
 */
export class ShadowDepth {
  /** Переиспользуемый список укрытий, затеняющих текущего наблюдателя. */
  private readonly near: FogSegment[] = [];
  /** Сырой буфер растеризации: дистанция ближайшей тени по углу, в КВАДРАТАХ. */
  private readonly depth = new Float32Array(SHADOW_BINS);
  /**
   * Тот же буфер, уже свёрнутый минимумом по тройке соседних бинов, — то, что
   * и читает цикл по текселям (консервативность FOW-9). Свёртка живёт здесь, а
   * не в цикле, потому что бинов тысяча, а текселей — сотня тысяч: одна и та же
   * тройка иначе пересчитывалась бы сотнями раз.
   */
  readonly depthMin = new Float32Array(SHADOW_BINS);
  /**
   * Тот же `depthMin`, но ЛИНЕЙНОЙ дистанцией: полутень фронта считает долю
   * кромки, а доля — величина линейная, и квадратами её не выразить. Корень
   * берётся на бин, а не на тексель: бинов тысяча, текселей сотня тысяч. Срез
   * тени при этом остаётся на квадратах — сравнение с ним идёт по `depthMin` и
   * корня не требует вовсе.
   *
   * Заполняется, только когда полутень считается, — при нулевой кромке буфер
   * держит числа ПРОШЛОГО наблюдателя, и это безопасно ровно потому, что
   * единственный его читатель стоит под тем же условием.
   */
  readonly depthEdge = new Float32Array(SHADOW_BINS);
  /**
   * Ближайшая тень ЛЮБОГО направления, в квадрате дистанции: тексель ближе неё
   * не затенён ничем, и спрашивать у него угол незачем — а угол здесь
   * единственный `atan2` на тексель, самая дорогая операция цикла.
   */
  nearestShadowSq = Number.POSITIVE_INFINITY;

  /** Есть ли вообще укрытия, затеняющие текущего наблюдателя. */
  get casting(): boolean {
    return this.near.length > 0;
  }

  /** Сколько укрытий отобрано — слагаемое объёма работы подготовки (PERF-3). */
  get nearCount(): number {
    return this.near.length;
  }

  /**
   * Отбор укрытий, затеняющих наблюдателя (FOW-9): тени отбрасывают только
   * укрытия в радиусе, дальние в круг не дотягиваются. Высота — здесь же
   * (PHYS-13): ребро не выше уровня наблюдателя прозрачно и в буфер не
   * попадает.
   */
  collect(
    ox: number,
    oy: number,
    level: number,
    segments: readonly FogSegment[],
    radiusSq: number,
  ): void {
    const near = this.near;
    near.length = 0;
    for (const segment of segments) {
      if (segment.x1 !== segment.x2 && segment.y1 !== segment.y2) {
        throw new Error(
          'FOW-9: отрезок укрытия обязан быть осевым (TERR-5) — ' +
            'диагональную тень полярная растеризация не считает',
        );
      }
      if (!segmentCasts(level, segment)) continue;
      if (distanceSqToSegment(ox, oy, segment) <= radiusSq) near.push(segment);
    }
  }

  /**
   * Сборка буфера по отобранным укрытиям и его свёртка минимумом по тройке
   * соседних бинов. Дистанции лежат в КВАДРАТАХ — см. `rasterizeArc`: сравнение
   * с текселем тогда идёт по `distSq`, и корень из него не берётся вовсе;
   * `depthEdge` заполняется только под `penumbra`.
   *
   * Возвращает число пройденных растеризацией бинов — счёт идёт не в цикле по
   * бинам, а сложением на отрезок (PERF-3).
   */
  build(ox: number, oy: number, penumbra: boolean): number {
    this.nearestShadowSq = Number.POSITIVE_INFINITY;
    const near = this.near;
    if (near.length === 0) return 0;
    const depth = this.depth;
    depth.fill(Number.POSITIVE_INFINITY);
    let shadowRays = 0;
    for (const segment of near) {
      shadowRays += this.rasterizeSegment(ox, oy, segment);
    }
    this.foldNeighbours(penumbra);
    return shadowRays;
  }

  /**
   * Свёртка сырого буфера в `depthMin` минимумом по тройке соседних бинов:
   * консервативность на разрыве силуэта (интерполяция дала бы свет в тени),
   * тень шире, а не уже (FOW-9).
   */
  private foldNeighbours(penumbra: boolean): void {
    const depth = this.depth;
    const depthMin = this.depthMin;
    const depthEdge = this.depthEdge;
    let nearestShadowSq = Number.POSITIVE_INFINITY;
    for (let bin = 0; bin < SHADOW_BINS; bin++) {
      const value = Math.min(
        depth[bin]!,
        depth[bin === 0 ? SHADOW_BINS - 1 : bin - 1]!,
        depth[bin === SHADOW_BINS - 1 ? 0 : bin + 1]!,
      );
      depthMin[bin] = value;
      if (penumbra) depthEdge[bin] = Math.sqrt(value);
      if (value < nearestShadowSq) nearestShadowSq = value;
    }
    this.nearestShadowSq = nearestShadowSq;
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
   * цикл по текселям reveal, а у него на руках квадрат расстояния до
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
}
