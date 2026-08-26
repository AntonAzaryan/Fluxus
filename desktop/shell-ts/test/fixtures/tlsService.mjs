#!/usr/bin/env node
/**
 * ШИФРОВАННЫЙ сервис-пустышка (DSK-8): держит wss на self-signed сертификате,
 * пишет свой адрес в `--address-file`, а закрепление своего сертификата — в
 * `--pin-file`.
 *
 * Ровно то положение дел, ради которого заведено закрепление: цепочки доверия у
 * сертификата нет по построению, штатная проверка платформы его отвергает, и
 * единственное основание принять его — совпадение отпечатка с тем, который
 * назвал сам сервис. Настоящий такой сервис — агент хоста (`server-control`
 * SRV-3), но сьюту границы движок и игра запрещены (DSK-3), поэтому здесь
 * пустышка: TLS настоящий, а за ним — ничего.
 *
 * Пара КЛЮЧ/СЕРТИФИКАТ рождается на каждом запуске и умирает вместе с процессом:
 * приватного ключа в репозитории нет и быть не должно, а закреплению постоянство
 * не нужно — пустышка называет отпечаток того сертификата, который предъявляет
 * сама. Постоянный отпечаток нужен только гейтовому тесту счёта отпечатка, и там
 * лежит committed СЕРТИФИКАТ (`pinned.cert.pem`) — публичный, без ключа.
 *
 * Отпечаток считается разбором сертификата (`X509Certificate`), а не разбором
 * PEM-обёртки: сервис называет своё закрепление сам, и способ счёта у него свой.
 * Совпасть со счётом контейнера он обязан — на этом всё и держится.
 *
 * Рукопожатие WebSocket отвечено вручную: пустышке нужен ОТКРЫТЫЙ канал и ни
 * одного фрейма после него, а библиотека ради этого тянула бы в контейнер
 * зависимость, которой у него нет.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import selfsigned from 'selfsigned';

const at = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const port = Number(at('--port') ?? Number.NaN);
const addressFile = at('--address-file');
const pinFile = at('--pin-file');
if (!Number.isInteger(port)) {
  process.stderr.write('шифрованная пустышка: не дали --port\n');
  process.exit(2);
}

// Имя в сертификате формально: подлинность здесь проверяется ОТПЕЧАТКОМ, а не
// цепочкой и не совпадением имени, — цепочки у self-signed нет по построению.
const generated = selfsigned.generate([{ name: 'commonName', value: 'fluxus-tls-fixture' }], {
  days: 365,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ],
});

/** Магическая строка рукопожатия WebSocket (RFC 6455). */
const HANDSHAKE = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = createServer({ cert: generated.cert, key: generated.private }, (request, response) => {
  response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('пустышка говорит только по wss');
});

server.on('upgrade', (request, socket) => {
  const offered = String(request.headers['sec-websocket-key'] ?? '');
  const accept = createHash('sha1').update(`${offered}${HANDSHAKE}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  // Дальше — тишина: проверяется, что канал ОТКРЫЛСЯ, а не что по нему ездит.
});
// Второй процесс на занятом порту выходит молча — по той же причине, что и
// обычная пустышка: трасса EADDRINUSE изображала бы падение прогона.
server.on('error', () => { process.exit(0); });

server.listen(port, '127.0.0.1', () => {
  // Закрепление пишется ПЕРЕД адресом (решение D5): к моменту, когда адрес уехал
  // странице, сверять уже есть с чем. Без `--pin-file` не пишется вовсе — так
  // выглядит сервис, закрепления не обещавший.
  if (pinFile !== undefined) {
    const pin = new X509Certificate(generated.cert).fingerprint256.replaceAll(':', '').toLowerCase();
    writeFileSync(pinFile, `${pin}\n`, { mode: 0o600 });
  }
  if (addressFile !== undefined) writeFileSync(addressFile, `wss://127.0.0.1:${String(port)}\n`);
});

const stop = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
