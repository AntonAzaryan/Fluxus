import type { EventEmitter, GameEvent, ReadonlyEventLog } from './types.js';

const NO_DATA: Readonly<Record<string, number>> = Object.freeze({});

/**
 * Шина событий тика. Наружу отдаётся как `ReadonlyEventLog` — тип сужает
 * доступ, копии не делается (OBS-3: view валиден только внутри dispatch).
 *
 * Событие описывает доменный факт и ничего не знает об адресате: категоризация
 * и фильтрация — работа потребителя (OBS-4).
 */
export class EventBus implements EventEmitter, ReadonlyEventLog {
  private readonly log: GameEvent[] = [];

  emit(type: string, data: Readonly<Record<string, number>> = NO_DATA): void {
    this.log.push({ type, data });
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
}
