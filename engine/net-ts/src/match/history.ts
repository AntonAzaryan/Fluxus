/**
 * История матча: `HistoryProvider` (SNAP-2) со срезанием стёртой перемоткой
 * ветви.
 *
 * Зачем вторая реализация. `RingHistory` ядра пишет снапшоты подряд и удалять
 * их не умеет — ей и незачем: мир, который только идёт вперёд, второго снапшота
 * на один номер тика не порождает. Матч с перемоткой порождает: после
 * восстановления на тик T живые тики идут по тем же номерам заново (NTR-16), и
 * в кольце оказываются ДВА снапшота тика T+1 — стёртой ветви и живой.
 * `RingHistory.nearest()` при равных тиках оставляет тот, что пришёл раньше,
 * то есть стёртый, и следующая перемотка восстановила бы состояние ветви, в
 * которой матч больше не находится, — молча и с расхождением парности NTR-8.
 *
 * Отсюда `dropAfter`: в точке восстановления история обрезается по тику
 * восстановления, и в ней остаётся ровно живая ветвь. Обрезка идёт по строгому
 * «больше», а не «больше либо равно»: снапшот РОВНО тика восстановления —
 * то же самое состояние, которое механизм перемотки только что получил
 * реплеем (REW-2, DET-1), и он остаётся точкой восстановления живой ветви.
 * Срезать и его означало бы опустошать историю на откате к самому старому
 * снапшоту — и следующая перемотка упиралась бы в «история пуста» (REW-1).
 *
 * SNAP-2 такую вторую реализацию прямо предполагает: интерфейс разводит
 * реализации с разными профилями хранения, и ядро ради сетевого слоя не
 * трогается.
 */
import {
  RingHistory,
  takeSnapshot,
  type HistoryProvider,
  type ReadonlySimulationState,
  type RingHistoryOptions,
  type Snapshot,
} from '@fluxus/core';

/** Провайдер ядра плюс то, что нужно матчу: глубина буфера и обрезка ветви. */
export interface MatchHistory extends HistoryProvider {
  /** Глубина, которую покрывает буфер (SNAP-6). */
  readonly depth: number;
  /** Убирает снапшоты тиков строго больше `tick` — стёртую перемоткой ветвь. */
  dropAfter(tick: number): void;
}

export class BranchHistory implements MatchHistory {
  private readonly options: RingHistoryOptions;
  /** Чтение целиком делегируется кольцу ядра: правило REW-1 живёт в одном месте. */
  private ring: RingHistory;
  /**
   * Зеркало содержимого кольца по возрастанию тика. Кольцо своих слотов наружу
   * не отдаёт, а обрезка обязана знать, что в нём лежит, — поэтому список
   * ссылок ведётся рядом. Снапшот при этом снимается один, а не два.
   */
  private entries: Snapshot[] = [];

  constructor(options: RingHistoryOptions) {
    this.options = options;
    this.ring = new RingHistory(options);
  }

  get depth(): number {
    return this.ring.depth;
  }

  get oldestTick(): number | undefined {
    return this.ring.oldestTick;
  }

  get newestTick(): number | undefined {
    return this.ring.newestTick;
  }

  /**
   * Правило интервала (SNAP-4) повторено здесь ровно затем, чтобы зеркало
   * содержало то же, что кольцо: снимать снапшот дважды нельзя, а узнать у
   * кольца, записало ли оно этот, нечем.
   *
   * Принимает read-only проекцию наравне с провайдером ядра (OBS-1, SNAP-2):
   * тело только читает — номер тика и снятие снапшота, — а зовут историю из
   * `onTick`, где на руках отчёт о тике, а не состояние хоста.
   */
  record(state: ReadonlySimulationState): void {
    if (state.tick % this.options.interval !== 0) return;
    this.push(takeSnapshot(state));
  }

  /** Готовый снапшот мимо проверки интервала — для тестов и ручного управления. */
  push(snapshot: Snapshot): void {
    this.ring.push(snapshot);
    this.entries.push(snapshot);
    if (this.entries.length > this.options.capacity) this.entries.shift();
  }

  nearest(tick: number): Snapshot | undefined {
    return this.ring.nearest(tick);
  }

  /**
   * Обрезка в точке восстановления, а не при первой записи новой ветви:
   * инвариант «в истории лежит только живая ветвь» держится тогда безусловно, и
   * проверять его не нужно ни в одном другом месте. Плата — скраб вперёд внутри
   * одной перемотки (500 → 480 → 490) теряет снапшоты между 480 и 490 и
   * доигрывает их реплеем; это ровно тот способ, которым REW-2 и получает
   * состояние целевого тика.
   */
  dropAfter(tick: number): void {
    const kept = this.entries.filter((snapshot) => snapshot.tick <= tick);
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    // Кольцо пересобирается: удалять из него нечем, а вернуть в него выжившие
    // в прежнем порядке — та же операция, что запись, только разом.
    this.ring = new RingHistory(this.options);
    for (const snapshot of kept) this.ring.push(snapshot);
  }
}
