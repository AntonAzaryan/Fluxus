/**
 * Канал управляющего протокола в СТРАНИЦЕ: исход попытки открыть его.
 *
 * Предмет проверки — маленький автомат, у которого нет наблюдаемого выхода,
 * кроме исхода промиса: сработавший срок, немедленный отказ канала и обычное
 * закрытие уже открытого канала выглядят снаружи почти одинаково, а внутри
 * различаются снятым таймером и тем, тронут ли промис второй раз. Такое
 * регрессирует молча, поэтому пиннится здесь.
 *
 * `WebSocket` подставной: настоящий требовал бы сети и настоящих десяти секунд,
 * а проверяется поведение фабрики, а не браузера.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserSocket } from '../src/client/browserSocket.js';
import { ControlClientError } from '../src/client/controlClient.js';

type Listener = () => void;

/** Сокет-пустышка: события подаёт тест, закрытия считает сам. */
class FakeSocket {
  static last: FakeSocket | undefined;
  readonly url: string;
  closes = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closes += 1;
  }

  send(): void {
    // Отправку этот тест не проверяет: она начинается уже после рукопожатия.
  }

  /** Событие среды: `open`, `error`, `close`. */
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const opened = (): FakeSocket => {
  const socket = FakeSocket.last;
  if (socket === undefined) throw new Error('фабрика не создала сокет');
  return socket;
};

/**
 * Исход попытки — значением, каким бы он ни был. Обработчик вешается СРАЗУ:
 * отказ здесь наступает раньше, чем тест до него доберётся, и промис без
 * читателя стал бы необработанным отклонением — шумом, который прогон засчитает
 * себе в ошибки.
 */
const outcome = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    (value) => value,
    (error: unknown) => error,
  );

const refusalOf = (settled: unknown): ControlClientError => {
  expect(settled).toBeInstanceOf(ControlClientError);
  return settled as ControlClientError;
};

beforeEach(() => {
  FakeSocket.last = undefined;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('канал страницы: попытка обязана кончиться исходом (SRV-2)', () => {
  it('молчащий адрес отвергается по сроку, и срок снимается вместе с попыткой', async () => {
    const attempt = outcome(browserSocket('wss://127.0.0.1:8443', ''));
    const socket = opened();
    // До срока попытка не разрешена ничем: ни отказа, ни канала.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(socket.closes).toBe(0);

    await vi.advanceTimersByTimeAsync(1_500);
    const error = refusalOf(await attempt);
    expect(error.reason).toBe('connect-failed');
    // Названо ровно известное: молчание, а не отвергнутый сертификат.
    expect(error.message).toContain('не ответил за 10000 мс');
    expect(error.message).not.toContain('сертификат');
    // Сокет закрыт, и висящих таймеров после отказа не остаётся.
    expect(socket.closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('немедленный отказ канала называет и вероятную причину, и обход', async () => {
    const attempt = outcome(browserSocket('wss://127.0.0.1:8443', ''));
    opened().emit('error');
    const error = refusalOf(await attempt);
    expect(error.reason).toBe('connect-failed');
    // Самоподписанный сертификат — догадка, уместная ровно здесь: отказ TLS
    // приходит сразу, а не молчанием (см. `PAGE_LIMIT`).
    expect(error.message).toContain('самоподписанный сертификат');
    expect(error.message).toContain('MGR-5');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('открытый канал снимает срок, а его последующее закрытие промиса не трогает', async () => {
    const attempt = browserSocket('wss://127.0.0.1:8443', '');
    const socket = opened();
    socket.emit('open');
    const channel = await attempt;
    // Срок снят открытием: иначе через десять секунд он отверг бы уже
    // работающий канал.
    expect(vi.getTimerCount()).toBe(0);
    expect(channel.fingerprint).toBe('');

    const closed: string[] = [];
    channel.socket.onClose((reason) => closed.push(reason));
    socket.emit('close');
    // Закрытие доезжает до подписчика и НЕ пытается отвергнуть разрешённый
    // промис: второй исход у попытки не появляется.
    expect(closed).toEqual(['']);
    await expect(attempt).resolves.toBe(channel);
    // И сокет фабрика при этом сама не закрывает: он уже закрыт средой.
    expect(socket.closes).toBe(0);

    channel.socket.close();
    expect(socket.closes).toBe(1);
  });
});
