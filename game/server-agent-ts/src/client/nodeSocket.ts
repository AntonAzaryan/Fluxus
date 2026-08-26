/**
 * Канал управляющего протокола в Node (SRV-3, решение D4): wss с
 * TOFU-пиннингом отпечатка.
 *
 * Сертификат агента self-signed, поэтому обычная проверка цепочки доверия
 * отвергла бы его — и это не то, чем проверяется подлинность агента.
 * Проверяется она ОТПЕЧАТКОМ: при первом подключении он закрепляется, при
 * следующих сверяется, а несовпадение — громкий отказ с объяснением, после
 * которого продолжить можно только явным решением человека (SRV-3).
 *
 * Отсюда `rejectUnauthorized: false` рядом с ручной сверкой: цепочки нет и не
 * будет, а отпечаток есть. Молча доверять любому сертификату этот код не
 * начинает — при закреплённом отпечатке несовпадение рвёт канал ДО первого
 * сообщения.
 */
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import { normalizeFingerprint } from '../protocol/fingerprint.js';
import { ControlClientError, type ControlSocketFactory, type OpenedSocket } from './controlClient.js';

/** Отпечаток предъявленного сертификата в той же форме, что и у агента. */
function peerFingerprint(socket: TLSSocket): string {
  // Сокет вправе оказаться НЕ TLS: `ws://` в адресе даёт обычный `net.Socket`,
  // у которого этих методов нет вовсе, и обращение к ним роняло бы процесс
  // держателя клиента `TypeError`-ом вместо названного отказа. Канал существует
  // только шифрованным (SRV-3) — значит, это отказ, а не крах.
  if (typeof socket.getPeerX509Certificate !== 'function') {
    throw new ControlClientError(
      'connect-failed',
      'канал открылся без TLS: управляющий канал существует только шифрованным (SRV-3)',
    );
  }
  const certificate = socket.getPeerX509Certificate();
  if (certificate !== undefined) return normalizeFingerprint(certificate.fingerprint256);
  // Старая форма API — тот же отпечаток, полученный другим путём.
  return normalizeFingerprint(socket.getPeerCertificate().fingerprint256);
}

/** Фабрика канала для Node: тесты агента и менеджер в десктоп-контейнере. */
export const nodeSocket: ControlSocketFactory = (url, pinned) =>
  new Promise<OpenedSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    let fingerprint = '';
    let settled = false;
    const messageHandlers: ((text: string) => void)[] = [];
    const closeHandlers: ((reason: string) => void)[] = [];

    socket.on('upgrade', (response) => {
      try {
        fingerprint = peerFingerprint(response.socket as TLSSocket);
      } catch (error) {
        settled = true;
        socket.terminate();
        reject(error instanceof Error ? error : new ControlClientError('connect-failed', String(error)));
        return;
      }
      if (pinned === '' || fingerprint === pinned) return;
      // Громкий отказ (SRV-3): канал рвётся до единого сообщения, и причина
      // называет обе величины — иначе человеку нечего сравнить.
      settled = true;
      socket.terminate();
      reject(
        new ControlClientError(
          'fingerprint-changed',
          `отпечаток хоста изменился: закреплён ${pinned}, предъявлен ${fingerprint}`,
        ),
      );
    });

    socket.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      for (const handler of messageHandlers) handler(text);
    });
    socket.on('close', () => {
      for (const handler of closeHandlers) handler('');
    });
    socket.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(new ControlClientError('connect-failed', error.message));
    });
    socket.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({
        fingerprint,
        socket: {
          send: (text) => { socket.send(text); },
          close: () => { socket.close(); },
          onMessage: (handler) => { messageHandlers.push(handler); },
          onClose: (handler) => { closeHandlers.push(handler); },
        },
      });
    });
  });
