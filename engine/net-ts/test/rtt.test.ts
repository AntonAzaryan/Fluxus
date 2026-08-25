/**
 * Круг несущего канала (NTR-11, решение D7): наблюдаемая транспорта, а не
 * сообщение игрового протокола.
 *
 * Предмет проверки двойной, и вторая половина важнее первой. Первая — что круг
 * у WebSocket-соединения ПОЯВЛЯЕТСЯ: он меряется штатными ping/pong несущего
 * канала, и никакого сообщения в закрытый набор (NTR-4) для этого не заводится.
 * Вторая — что канал, круг измерить не умеющий, сообщает его отсутствие ЯВНО, а
 * не нулём: ноль — это здоровый лупбэк, и админ, разбирающий «дорога или
 * сервер» (`server-control` SRV-4), обязан отличать одно от другого.
 */
import { describe, expect, it } from 'vitest';
import { connectWebSocket } from '../src/transport/webSocketClient.js';
import { webSocketTransportServer } from '../src/transport/webSocketServer.js';
import { LoopbackHub, loopbackPair } from '../src/transport/loopback.js';
import { transportRtt, type Transport } from '../src/transport/transport.js';
import { freePort, until } from './support/net.js';

describe('RTT — наблюдаемая несущего канала (NTR-11)', () => {
  it('у ws-соединения круг появляется сам, без сообщения протокола', async () => {
    const port = await freePort();
    // Частый ping: предмет проверки — что круг МЕРИТСЯ, а не как часто; ждать
    // секунду ради этого значило бы держать гейт на ожидании реального времени.
    const server = webSocketTransportServer({ port, pingEveryMs: 10 });
    const accepted: Transport[] = [];
    server.onConnection((transport) => accepted.push(transport));

    const client = await connectWebSocket(`ws://127.0.0.1:${String(port)}`);
    await until(() => accepted.length > 0);
    const serverSide = accepted[0]!;

    // До первого завершённого круга отсутствие названо как «ещё нет», а не как
    // «не умею»: одно пройдёт само, другое не изменится никогда.
    const before = transportRtt(serverSide);
    expect(before.kind === 'pending' || before.kind === 'measured').toBe(true);

    await until(() => transportRtt(serverSide).kind === 'measured');
    const measured = transportRtt(serverSide);
    expect(measured.kind).toBe('measured');
    if (measured.kind === 'measured') expect(measured.ms).toBeGreaterThanOrEqual(0);

    client.close();
    await server.close();
  });

  it('лупбэк и портовые каналы ботов сообщают отсутствие круга явно, а не нулём', () => {
    const [a, b] = loopbackPair();
    // Ноль здесь был бы враньём: у лупбэка круг не «нулевой», его нет вовсе.
    expect(transportRtt(a)).toEqual({ kind: 'unsupported' });
    expect(transportRtt(b)).toEqual({ kind: 'unsupported' });

    const hub = new LoopbackHub();
    expect(transportRtt(hub.connect())).toEqual({ kind: 'unsupported' });

    // Транспорт, вовсе не объявивший наблюдаемую (обёртка сборки, подставной
    // канал теста), отсутствием поля говорит ровно то же самое.
    const bare: Transport = {
      send: () => undefined,
      close: () => undefined,
      isClosed: false,
      onMessage: () => undefined,
      onClose: () => undefined,
    };
    expect(transportRtt(bare)).toEqual({ kind: 'unsupported' });
  });

  it('сборка вправе не мерить круг вовсе — и это тоже названное отсутствие', async () => {
    const port = await freePort();
    const server = webSocketTransportServer({ port, pingEveryMs: 0 });
    const accepted: Transport[] = [];
    server.onConnection((transport) => accepted.push(transport));

    const client = await connectWebSocket(`ws://127.0.0.1:${String(port)}`);
    await until(() => accepted.length > 0);
    expect(transportRtt(accepted[0]!)).toEqual({ kind: 'unsupported' });

    client.close();
    await server.close();
  });
});
