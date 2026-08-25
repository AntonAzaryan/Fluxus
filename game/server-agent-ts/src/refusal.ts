/**
 * Названный отказ операции (SRV-2: «Отказ любой операции SHALL быть наблюдаем
 * как отказ с названной причиной»).
 *
 * Исключением, а не возвращаемым значением, потому что отказ обязан прервать
 * операцию в любой её точке — от разбора сообщения до ответа стенда, — и путь до
 * клиента у него один: обработчик запроса ловит его и отвечает `refused` с той
 * же причиной. Свободная строка тут не годится: причину показывает приложение
 * (MGR-2), а не человек, читающий текст.
 */
import type { RefusalReason } from './protocol/messages.js';

export class RefusalError extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, detail: string) {
    super(detail);
    this.name = 'RefusalError';
    this.reason = reason;
  }
}

/** Любая брошенная величина — как названный отказ: неназванных здесь не остаётся. */
export function refusalOf(error: unknown): { reason: RefusalReason; detail: string } {
  if (error instanceof RefusalError) return { reason: error.reason, detail: error.message };
  return { reason: 'internal', detail: error instanceof Error ? error.message : String(error) };
}
