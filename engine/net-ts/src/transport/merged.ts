/**
 * Несколько слушающих сторон за одной (NTR-2).
 *
 * Нужно ровно в одном месте — в режиме `listen`, где сервер матча принимает и
 * внутрипроцессное соединение собственного клиента хоста, и сетевые соединения
 * остальных (`net-session` SES-1, SES-6). Слияние живёт здесь, а не в
 * `MatchHost`, потому что для сервера матча это по-прежнему одна слушающая
 * сторона: различие транспортов не должно доходить до него в виде ветвления.
 */
import type { Transport, TransportServer } from './transport.js';

export function mergeTransportServers(...servers: readonly TransportServer[]): TransportServer {
  return {
    onConnection(handler: (transport: Transport) => void): void {
      for (const server of servers) server.onConnection(handler);
    },
    async close(): Promise<void> {
      await Promise.all(servers.map((server) => server.close()));
    },
  };
}
