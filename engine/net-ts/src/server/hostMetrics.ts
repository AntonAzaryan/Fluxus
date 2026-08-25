/**
 * Счётчики ХОСТА сервера матча (NTR-11): длительность исполнения тика с
 * перцентилем p99, broadcast lag и размер снапшотов по каждому соединению
 * отдельно.
 *
 * Живут они здесь, а не в `MatchServer`, потому что мерить нечего внутри чистого
 * тика: и цикл расписания, и рассылка принадлежат хосту (NTR-3, решение D9), а
 * сервер матча часов не знает вовсе — иначе его нельзя было бы прогнать
 * вызовами в тесте (NTR-12).
 *
 * Накопление — КОЛЬЦО фиксированного размера (OBS-2): длительность матча не
 * должна двигать ни память, ни стоимость замера. Перцентиль считается на
 * ЧТЕНИИ, а не на записи, — читают его раз в секунду и только когда есть кому
 * (`server-control` SRV-4, риск «p99 в горячем цикле» дизайна), а пишут каждый
 * тик.
 *
 * Ни одно значение отсюда не попадает ни в мир, ни в канонический `inputs[]`
 * (NTR-11, OBS-2): счётчик хоста — наблюдение снаружи симуляции, и записанный в
 * мир он сделал бы прогон записи невоспроизводимым.
 */

/** Замеров в кольце: полминуты тиков при 60 Гц — хватает на осмысленный p99. */
const RING = 2048;

/**
 * Кольцо длительностей и сводка по нему. Величины — миллисекунды с дробной
 * частью: это внешний слой, и Q16.16 здесь ни при чём (FP-1 нормирует
 * симуляцию, а не наблюдение за хостом).
 */
export class DurationRing {
  private readonly samples: Float64Array;
  private next = 0;
  private filled = 0;
  private lastMs = 0;

  constructor(capacity: number = RING) {
    this.samples = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.lastMs = ms;
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
  }

  get count(): number {
    return this.filled;
  }

  get last(): number {
    return this.lastMs;
  }

  /**
   * Перцентиль по накопленному кольцу. Копия и сортировка — на ЧТЕНИИ: отчёт
   * собирается раз в секунду, а тик исполняется шестьдесят раз за то же время.
   */
  percentile(fraction: number): number {
    if (this.filled === 0) return 0;
    const sorted = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index] ?? 0;
  }

  /** Среднее по кольцу: соседство с p99 и есть ответ «редкий выброс или общий фон». */
  get meanMs(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.samples[i] ?? 0;
    return sum / this.filled;
  }
}

/** Сводка кольца — то, что уезжает наружу отчётом (`server-control` SRV-4). */
export interface DurationSummary {
  readonly lastMs: number;
  readonly meanMs: number;
  /** Перцентиль p99 — величина, названная NTR-11 поимённо. */
  readonly p99Ms: number;
  readonly samples: number;
}

export function summarize(ring: DurationRing): DurationSummary {
  return {
    lastMs: ring.last,
    meanMs: ring.meanMs,
    p99Ms: ring.percentile(0.99),
    samples: ring.count,
  };
}
