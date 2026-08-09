/**
 * Транспорт за интерфейсом (NTR-2). Логика матча не знает, какая реализация
 * под ним: сервер и клиент принимают `Transport`, а не сокет.
 *
 * Интерфейс работает с байтовыми сообщениями, а не с потоком: сохранение
 * границ — обязанность реализации. Транспорт поверх датаграмм границы уже даёт,
 * транспорт поверх потока обязан их восстановить, и вынос этой заботы в
 * протокол сделал бы её общей платой за частную проблему.
 *
 * Чего в интерфейсе нет намеренно: гарантий надёжности и порядка. Поток матча
 * нормативно к ним не привязан (NTR-2) — снапшот несёт свой тик и
 * самодостаточен, ввод несёт свой тик и `seq`, — чтобы переход на ненадёжный
 * канал ради снятия head-of-line blocking был заменой файла, а не пересмотром
 * цикла.
 */

/** Идентификатор соединения на стороне сервера. Числовой: адресация исходящих — горячий путь. */
export type ConnectionId = number;

export interface Transport {
  send(bytes: Uint8Array): void;
  close(reason?: string): void;
  readonly isClosed: boolean;
  /** Обработчик один: два потребителя одного соединения — это ошибка сборки, а не сценарий. */
  onMessage(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: (reason?: string) => void): void;
}

export interface TransportServer {
  onConnection(handler: (transport: Transport) => void): void;
  close(): Promise<void>;
}

/** Общая часть реализаций: хранение обработчиков и однократность закрытия. */
export abstract class BaseTransport implements Transport {
  private messageHandler: ((bytes: Uint8Array) => void) | undefined;
  private closeHandler: ((reason?: string) => void) | undefined;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    if (this.messageHandler !== undefined) {
      throw new Error('Transport: обработчик сообщений уже назначен');
    }
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    if (this.closeHandler !== undefined) {
      throw new Error('Transport: обработчик закрытия уже назначен');
    }
    this.closeHandler = handler;
    if (this.closed) handler(this.closedReason);
  }

  abstract send(bytes: Uint8Array): void;

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    this.doClose(reason);
    this.closeHandler?.(reason);
  }

  protected closedReason: string | undefined;

  /** Закрытие пришло с той стороны: своё состояние сбрасываем, чужое не трогаем. */
  protected closedByPeer(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    this.closeHandler?.(reason);
  }

  protected deliver(bytes: Uint8Array): void {
    if (this.closed) return;
    this.messageHandler?.(bytes);
  }

  protected abstract doClose(reason?: string): void;
}
