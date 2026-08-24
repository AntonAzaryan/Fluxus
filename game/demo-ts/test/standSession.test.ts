/**
 * Окно рестарта стенда демо-арены (`bin/demo-serve.mjs`, design D2, D3).
 *
 * Между матчами обработчика соединений нет: прежний `MatchHost` остановлен,
 * следующий ещё не создан. `BaseTransport` без обработчика молча роняет
 * входящие байты, а `Hello` клиент шлёт РОВНО один раз и не повторяет
 * (`MatchClient.start`) — поэтому слушающая сторона обязана подписаться на
 * соединение сразу, копить сказанное в окне и отдавать его следующему матчу.
 *
 * РЕГРЕССИЯ: обёртка подписывалась на настоящий транспорт только при подписке
 * матча, и `Hello` окна рестарта пропадал безвозвратно. Снаружи это выглядело
 * сетью («сервер не ответил» после тайм-аута входа), а не стендом; претендентом
 * такой клиент не становился, дедлайн бот-заполнителя не взводился (BOT-7) —
 * одинокий клиент окна рестарта ждал бы бота вечно, вопреки обещанию стенда.
 */
import { describe, expect, it } from 'vitest';
import type { Transport } from '@fluxus/net';
import { standSession } from '../app/standSession.js';

/**
 * Транспорт с повадками `BaseTransport`: обработчик один, без обработчика
 * байты пропадают, поздний подписчик закрытого соединения узнаёт о закрытии.
 */
function fakeTransport() {
  let messageHandler: ((bytes: Uint8Array) => void) | undefined;
  let closeHandler: ((reason?: string) => void) | undefined;
  let closed = false;
  let closedReason: string | undefined;
  const transport: Transport = {
    get isClosed() {
      return closed;
    },
    send: () => {},
    close(reason) {
      if (closed) return;
      closed = true;
      closedReason = reason;
      closeHandler?.(reason);
    },
    onMessage(handler) {
      if (messageHandler !== undefined) throw new Error('обработчик сообщений уже назначен');
      messageHandler = handler;
    },
    onClose(handler) {
      if (closeHandler !== undefined) throw new Error('обработчик закрытия уже назначен');
      closeHandler = handler;
      if (closed) handler(closedReason);
    },
  };
  return {
    transport,
    /** Байты «с той стороны»: без обработчика — в никуда, как у `BaseTransport.deliver`. */
    deliver(bytes: Uint8Array): void {
      if (!closed) messageHandler?.(bytes);
    },
    /** Закрытие «с той стороны» (`BaseTransport.closedByPeer`). */
    closeFromPeer(reason?: string): void {
      if (closed) return;
      closed = true;
      closedReason = reason;
      closeHandler?.(reason);
    },
  };
}

const HELLO = new Uint8Array([1, 2, 3]);

describe('окно рестарта стенда: подключившийся между матчами не теряется (D2, BOT-7)', () => {
  it('Hello, пришедший до подъёма следующего матча, доезжает до его обработчика', () => {
    const listening = standSession();
    const peer = fakeTransport();
    // Матча нет: соединение ждёт в очереди, обработчика у него ещё никто не дал.
    listening.accept(peer.transport);
    peer.deliver(HELLO);

    // Следующий матч подписался (конструктор `MatchHost`): очередь роздана, и
    // сказанное в окне отдано его обработчику, а не выброшено.
    const received: Uint8Array[] = [];
    listening.sessionServer.onConnection((transport) => {
      transport.onMessage((bytes) => received.push(bytes));
      transport.onClose(() => {});
    });
    expect(received).toEqual([HELLO]);
  });

  it('заговоривший в окне — претендент: дедлайн бот-заполнителя есть с кого взводить', () => {
    const listening = standSession();
    const peer = fakeTransport();
    listening.accept(peer.transport);
    // Молчащий сокет матч не заводит (D2)...
    expect(listening.claimants.size).toBe(0);
    peer.deliver(HELLO);
    // ...а заговоривший виден ДО подписки следующего матча: ровно это читает
    // стенд перед взводом дедлайна (`claimants.size > 0`, BOT-7).
    expect(listening.claimants.size).toBe(1);
  });

  it('ушедший в окне претендентом не остаётся, а поздний подписчик узнаёт о закрытии', () => {
    const listening = standSession();
    let gone = 0;
    listening.onClaimantsGone(() => {
      gone += 1;
    });
    const peer = fakeTransport();
    listening.accept(peer.transport);
    peer.deliver(HELLO);
    peer.closeFromPeer('ушёл');
    // Клиент передумал в окне: претендентов не осталось, и это названо.
    expect(listening.claimants.size).toBe(0);
    expect(gone).toBe(1);

    // Следующий матч, разобрав очередь, получает закрытие немедленно — тот же
    // контракт позднего подписчика, что у `BaseTransport.onClose`.
    const closes: (string | undefined)[] = [];
    listening.sessionServer.onConnection((transport) => {
      transport.onMessage(() => {});
      transport.onClose((reason) => closes.push(reason));
    });
    expect(closes).toEqual(['ушёл']);
  });

  it('при живом матче соединение идёт его обработчику сразу, без очереди', () => {
    const listening = standSession();
    const connected: Transport[] = [];
    const received: Uint8Array[] = [];
    listening.sessionServer.onConnection((transport) => {
      connected.push(transport);
      transport.onMessage((bytes) => received.push(bytes));
      transport.onClose(() => {});
    });
    const peer = fakeTransport();
    listening.accept(peer.transport);
    peer.deliver(HELLO);
    expect(connected).toHaveLength(1);
    expect(received).toEqual([HELLO]);
  });

  it('close() вида рвёт соединения матча и чистит претендентов, но следующее окно живёт', async () => {
    const listening = standSession();
    listening.sessionServer.onConnection((transport) => {
      transport.onMessage(() => {});
      transport.onClose(() => {});
    });
    const peer = fakeTransport();
    listening.accept(peer.transport);
    peer.deliver(HELLO);
    expect(listening.claimants.size).toBe(1);

    await listening.sessionServer.close();
    expect(peer.transport.isClosed).toBe(true);
    expect(listening.claimants.size).toBe(0);

    // Новое окно рестарта: пришедший ждёт следующего матча вместе со своим
    // `Hello` и уже претендент.
    const late = fakeTransport();
    listening.accept(late.transport);
    late.deliver(HELLO);
    expect(listening.claimants.size).toBe(1);
  });
});
