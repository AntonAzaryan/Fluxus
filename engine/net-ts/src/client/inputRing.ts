/**
 * Кольцо собственных кадров ввода (NET-9), около 120 тиков — две секунды.
 *
 * Клиент MVP не предсказывает (NTR-10), и кольцо ему нужно не для
 * reconciliation, а по двум своим причинам: измерить задержку «нажал → увидел»
 * (сопоставив `seq` из снапшота с моментом отправки) и ответить на вопрос
 * «отправлено против применено» при разборе потерь. Когда предсказание
 * включится, кольцо уже будет тем самым, что требует NET-4, — добавится цикл
 * симуляции, а не инфраструктура.
 */
import type { InputFrame } from '@game-mvp/core';

export interface SentInput {
  readonly frame: InputFrame;
  readonly sentAtMs: number;
}

export const DEFAULT_RING_TICKS = 120;

export class InputRing {
  private readonly slots: (SentInput | undefined)[];

  constructor(capacity: number = DEFAULT_RING_TICKS) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('InputRing: ёмкость — положительное целое');
    }
    this.slots = Array.from({ length: capacity }, () => undefined);
  }

  get capacity(): number {
    return this.slots.length;
  }

  push(frame: InputFrame, sentAtMs: number): void {
    this.slots[frame.tick % this.slots.length] = { frame, sentAtMs };
  }

  /** Кадр на конкретный тик — если он ещё не вытеснен из кольца. */
  at(tick: number): SentInput | undefined {
    const entry = this.slots[tick % this.slots.length];
    return entry !== undefined && entry.frame.tick === tick ? entry : undefined;
  }

  /**
   * Поиск по `seq` — то, что приезжает обратно в снапшоте.
   *
   * ponytail: линейный скан по кольцу, порядка 120 элементов на применённый
   * снапшот (30 раз в секунду). Индекс `seq → слот` имеет смысл, когда кольцо
   * станет заметно глубже или снапшоты — заметно чаще.
   */
  bySeq(seq: number): SentInput | undefined {
    for (const entry of this.slots) {
      if (entry !== undefined && entry.frame.seq === seq) return entry;
    }
    return undefined;
  }
}
