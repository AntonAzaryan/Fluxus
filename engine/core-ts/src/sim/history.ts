/**
 * История снапшотов (SNAP-2..4, SNAP-6). Ring buffer полных копий, снимаемых
 * по интервалу: мир мутабелен (TICK-1), поэтому прошлое — это редкие полные
 * копии плюс детерминированный реплей между ними (REW-2), а не копия на тик.
 *
 * Интервал и глубина — параметры провайдера, а не константы ядра (SNAP-4): у
 * rewind-ульты буфер редкий и глубокий, у netcode-reconciliation частый и
 * короткий. Оба сидят за одним интерфейсом `HistoryProvider` и в одном
 * процессе живут независимо.
 */
import { takeSnapshot } from './tick.js';
import type { HistoryProvider, ReadonlySimulationState, Snapshot } from '../types.js';

export interface RingHistoryOptions {
  /** Тиков между снапшотами (SNAP-4). 1 — каждый тик. */
  readonly interval: number;
  /** Сколько снапшотов держится; переполнение затирает самый старый (SNAP-3). */
  readonly capacity: number;
}

export class RingHistory implements HistoryProvider {
  readonly interval: number;
  readonly capacity: number;

  private readonly slots: (Snapshot | undefined)[];
  /** Куда ляжет следующий снапшот. */
  private head = 0;
  private size = 0;

  constructor(options: RingHistoryOptions) {
    const { interval, capacity } = options;
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error('SNAP-4: "interval" — целое ≥ 1');
    }
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('SNAP-3: "capacity" — целое ≥ 1');
    }
    this.interval = interval;
    this.capacity = capacity;
    this.slots = new Array<Snapshot | undefined>(capacity).fill(undefined);
  }

  /**
   * Глубина, которую покрывает буфер (SNAP-6). Связь механизма с политикой:
   * при изменении глубины ульты пересматриваются оба параметра.
   */
  get depth(): number {
    return this.interval * (this.capacity - 1);
  }

  /** Снимает снапшот, если тик кратен интервалу (SNAP-4). */
  record(state: ReadonlySimulationState): void {
    if (state.tick % this.interval !== 0) return;
    this.push(takeSnapshot(state));
  }

  /** Кладёт готовый снапшот мимо проверки интервала — для тестов и ручного управления. */
  push(snapshot: Snapshot): void {
    this.slots[this.head] = snapshot;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  get oldestTick(): number | undefined {
    return this.oldest()?.tick;
  }

  get newestTick(): number | undefined {
    return this.at(this.size - 1)?.tick;
  }

  /**
   * Ближайший снапшот с тиком ≤ `tick`; запрос глубже буфера упирается в самый
   * старый доступный (REW-1).
   *
   * Равный тик — не ничья: после перемотки живые тики записываются заново под
   * теми же номерами (NTR-16), и буфер без усечения держит два снапшота одного
   * тика — стёртой ветви и живой. Побеждает записанный ПОЗЖЕ (`>=` при обходе
   * от старого слота к новому): стёртая ветвь отброшена (REW-13), и
   * восстановление из неё молча подменило бы мир состоянием, в котором
   * симуляция уже не находится.
   *
   * ponytail: линейный скан по буферу. При ориентире SNAP-4 (порядка 14
   * снапшотов на ульту) бинарный поиск не окупает лишнего кода; менять — когда
   * появится провайдер с сотнями слотов.
   */
  nearest(tick: number): Snapshot | undefined {
    let best: Snapshot | undefined;
    // Дно буфера — минимальный ТИК, а не самый старый слот: после перемотки
    // порядок записи перестаёт совпадать с порядком тиков, и старейший слот
    // может держать снапшот стёртой ветви с тиком выше живых.
    let floor: Snapshot | undefined;
    for (let i = 0; i < this.size; i++) {
      const snapshot = this.at(i)!;
      if (snapshot.tick <= tick && (best === undefined || snapshot.tick >= best.tick)) best = snapshot;
      if (floor === undefined || snapshot.tick <= floor.tick) floor = snapshot;
    }
    return best ?? floor;
  }

  private oldest(): Snapshot | undefined {
    return this.at(0);
  }

  /** `i = 0` — самый старый из живых слотов. */
  private at(i: number): Snapshot | undefined {
    if (i < 0 || i >= this.size) return undefined;
    return this.slots[(this.head - this.size + i + this.capacity * 2) % this.capacity];
  }
}
