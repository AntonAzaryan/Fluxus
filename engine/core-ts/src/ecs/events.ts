import type { EventLog, GameEvent } from '../types.js';
import { countEvent, record, traceFull } from '../debug.js';

const NO_DATA: Readonly<Record<string, number>> = Object.freeze({});

/**
 * Шина событий тика. Наружу отдаётся как `ReadonlyEventLog` — тип сужает
 * доступ, копии не делается (OBS-3: view валиден только внутри dispatch).
 *
 * Событие описывает доменный факт и ничего не знает об адресате: категоризация
 * и фильтрация — работа потребителя (OBS-4).
 */
export class EventBus implements EventLog {
  private readonly log: GameEvent[] = [];

  emit(type: string, data: Readonly<Record<string, number>> = NO_DATA): void {
    this.log.push({ type, data });
    countEvent();
    // Вторая точка съёма трейса помимо Command Buffer (DIAG-2): без неё
    // взаимный порядок событий и команд внутри системы не восстановить.
    const traced = traceFull();
    if (traced !== undefined) record(traced, 'event', 'info', 'EVENT', { data: { type, ...data } });
  }

  get length(): number {
    return this.log.length;
  }

  at(index: number): GameEvent {
    const event = this.log[index];
    if (event === undefined) throw new RangeError(`нет события с индексом ${index}`);
    return event;
  }

  [Symbol.iterator](): Iterator<GameEvent> {
    return this.log[Symbol.iterator]();
  }

  /** Между тиками лог начинается заново: события не переживают тик (OBS-3). */
  clear(): void {
    this.log.length = 0;
  }

  /**
   * Возврат шины к состоянию целевого тика (REW-10). Именно возврат, а не
   * очистка: пустая шина после отката дала бы расхождение с честным реплеем.
   */
  restore(events: readonly GameEvent[]): void {
    this.log.length = 0;
    this.log.push(...events);
  }
}
