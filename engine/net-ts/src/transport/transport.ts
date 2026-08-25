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

/**
 * Круг несущего канала (NTR-11) — величина ЛИБО названное отсутствие.
 *
 * Отсутствие названо, а не выражено нулём и не `undefined`'ом, потому что этого
 * прямо требует норма: «Транспорт, несущий канал которого не умеет измерить
 * круг, SHALL сообщать отсутствие RTT явно, а не нулём». Ноль — это здоровый
 * лупбэк, и админ, разбирающий «дорога или сервер» (SRV-4), обязан отличать
 * «круга нет» от «круг нулевой».
 *
 * Двух видов отсутствия здесь два, и они разные для читателя: канал, который
 * круг измерять НЕ УМЕЕТ вовсе (лупбэк, порт воркера бота), и канал, который
 * умеет, но первого круга ещё не завершил. Первое не изменится никогда, второе
 * пройдёт само.
 */
export type TransportRtt =
  | { readonly kind: 'measured'; readonly ms: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'pending' };

/** Несущий канал круг измерить не умеет: лупбэк, порт воркера, подставной транспорт. */
export const RTT_UNSUPPORTED: TransportRtt = { kind: 'unsupported' };

/** Канал круг мерит, но первый замер ещё не завершился. */
export const RTT_PENDING: TransportRtt = { kind: 'pending' };

export interface Transport {
  send(bytes: Uint8Array): void;
  close(reason?: string): void;
  readonly isClosed: boolean;
  /** Обработчик один: два потребителя одного соединения — это ошибка сборки, а не сценарий. */
  onMessage(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: (reason?: string) => void): void;
  /**
   * Круг несущего канала (NTR-11) — НЕОБЯЗАТЕЛЬНАЯ наблюдаемая: транспорт,
   * который её не объявляет, отсутствием поля говорит то же, что `unsupported`
   * (см. `transportRtt`). Необязательная потому, что `Transport` реализуют и
   * обёртки сборок (слушающая сторона стенда), которым нечего добавить к
   * кругу обёрнутого канала.
   *
   * Сообщением игрового протокола круг не является и являться не может (NTR-4,
   * набор закрыт), а метрика отклика от него не зависит (NTR-11).
   */
  readonly rtt?: () => TransportRtt;
}

/**
 * Круг транспорта одним выражением: наблюдаемая транспорта либо названное
 * отсутствие. Одно место на всех читателей — иначе каждый решал бы сам, чем
 * считать транспорт без поля, и «ноль» появился бы там снова.
 */
export function transportRtt(transport: Transport): TransportRtt {
  return transport.rtt?.() ?? RTT_UNSUPPORTED;
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

  /**
   * Круг несущего канала (NTR-11). Умолчание — названное отсутствие: канал,
   * который круг мерить не умеет, говорит это ЯВНО, а не молчанием поля.
   * Реализация, у которой круг есть (WebSocket с ping/pong), метод переопределяет.
   */
  rtt(): TransportRtt {
    return RTT_UNSUPPORTED;
  }

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
