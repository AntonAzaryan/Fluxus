/**
 * Кольцо собственных кадров ввода (NET-9), около 120 тиков — две секунды.
 *
 * Клиент не предсказывает (NTR-10), и кольцо ему нужно не для
 * reconciliation, а по двум своим причинам: измерить задержку «нажал → увидел»
 * (сопоставив `seq` из снапшота с моментом отправки) и ответить на вопрос
 * «отправлено против применено» при разборе потерь. Когда предсказание
 * включится, кольцо уже будет тем самым, что требует NET-4, — добавится цикл
 * симуляции, а не инфраструктура.
 *
 * Рядом с кадром хранится эпоха, в которой он отправлен (NTR-16): номер тика
 * при перемотке перестаёт быть именем, и без эпохи кадр стёртой ветви истории
 * неотличим от свежего. Кадры стёртой эпохи переотправляться MUST NOT (NTR-10)
 * — любой путь повторной отправки обязан сверить `epoch` записи с текущей
 * эпохой клиента, — но из кольца они не удаляются: по ним и видно, сколько
 * ввода игрока унесла перемотка (`strandedBefore`).
 *
 * Путь повторной отправки сейчас один — его нет: клиент шлёт кадр один раз.
 * Заведёт его reconciliation (NET-4, NET-5), которая переигрывает свои кадры
 * после коррекции сервера, — и именно она обязана сверить `epoch`, а не
 * полагаться на то, что в кольце лежит только текущая ветвь истории.
 */
import type { InputFrame } from '@fluxus/core';

export interface SentInput {
  readonly frame: InputFrame;
  readonly sentAtMs: number;
  /** Эпоха, против которой кадр порождён и отправлен (NTR-16). */
  readonly epoch: number;
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

  /**
   * Эпоха здесь — обязательный аргумент, а не умолчание: кадр без неё
   * неотличим от кадра стёртой перемоткой ветви истории (NTR-16), а тихий ноль
   * сделал бы такой кадр вечно «своим».
   */
  push(frame: InputFrame, sentAtMs: number, epoch: number): void {
    this.slots[frame.tick % this.slots.length] = { frame, sentAtMs, epoch };
  }

  /** Кадр на конкретный тик — если он ещё не вытеснен из кольца. */
  at(tick: number): SentInput | undefined {
    const entry = this.slots[tick % this.slots.length];
    return entry?.frame.tick === tick ? entry : undefined;
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
      if (entry?.frame.seq === seq) return entry;
    }
    return undefined;
  }

  /**
   * Сколько кадров кольца осталось в эпохах старше указанной — то есть сколько
   * ввода игрока унесла перемотка (NTR-10). Это единственное, ради чего они в
   * кольце остаются: переотправке они не подлежат, потому что ветви истории, к
   * которой они адресованы, в матче больше нет.
   */
  strandedBefore(epoch: number): number {
    let count = 0;
    for (const entry of this.slots) {
      if (entry !== undefined && entry.epoch < epoch) count++;
    }
    return count;
  }
}
