/**
 * Канал управляющего протокола в СТРАНИЦЕ (`server-manager` MGR-1).
 *
 * Здесь названа граница, за которой TOFU-пиннинг (SRV-3) работает не так, как в
 * Node, и это не недосмотр реализации, а свойство среды: странице сертификат
 * канала не виден вовсе — у `WebSocket` браузера нет доступа ни к цепочке, ни к
 * отпечатку. Проверить отпечаток на уровне TLS страница поэтому НЕ МОЖЕТ.
 *
 * Что остаётся: отпечаток, названный агентом в рукопожатии, сверяется с
 * закреплённым (`controlClient.connect`) — и расхождение остаётся громким
 * отказом. Это слабее: подменивший канал вправе назвать чужой отпечаток. Чинится
 * это ОДНИМ способом — проверкой сертификата на стороне контейнера (у Electron
 * для этого есть свой шов), и это отдельное расширение моста, не смешиваемое с
 * этим change'ем (та же граница, что у шифрованного хранилища книги хостов,
 * решение D11).
 *
 * Прямое следствие для человека: удалённый хост добавляется в менеджер тем же
 * пейрингом, но полагаться на пиннинг из страницы как на защиту от MITM нельзя —
 * доверенным остаётся ЛОКАЛЬНЫЙ агент, поднятый объявленным сервисом (MGR-5).
 */
import { ControlClientError, type ControlSocketFactory, type OpenedSocket } from './controlClient.js';

/** Фабрика канала для страницы менеджера. Отпечаток она не видит и не выдумывает. */
export const browserSocket: ControlSocketFactory = (url) =>
  new Promise<OpenedSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const messageHandlers: ((text: string) => void)[] = [];
    const closeHandlers: ((reason: string) => void)[] = [];
    let settled = false;

    socket.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== 'string') return;
      for (const handler of messageHandlers) handler(data);
    });
    socket.addEventListener('close', () => {
      for (const handler of closeHandlers) handler('');
      if (settled) return;
      settled = true;
      reject(new ControlClientError('connect-failed', `канал до ${url} закрылся, не открывшись`));
    });
    socket.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      reject(new ControlClientError('connect-failed', `не удалось подключиться к ${url}`));
    });
    socket.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      resolve({
        // Пустая строка означает «среда отпечаток не показывает» — не «отпечаток
        // пустой»: закреплять нечего, и клиент сверяет то, что назвал агент.
        fingerprint: '',
        socket: {
          send: (text) => { socket.send(text); },
          close: () => { socket.close(); },
          onMessage: (handler) => { messageHandlers.push(handler); },
          onClose: (handler) => { closeHandlers.push(handler); },
        },
      });
    });
  });
