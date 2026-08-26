#!/usr/bin/env node
/**
 * Сервис-пустышка, объявляемая ОТВЯЗЫВАЕМОЙ (DSK-7): держит порт, пишет свой
 * адрес в файл `--address-file`, закрепление своего сертификата — в файл
 * `--pin-file` (DSK-8) и отмечает каждый свой запуск строкой в `--mark`.
 *
 * Адресный файл — то, чем адрес пере-обнаруживается через границу сессий
 * (решение D6): контейнер даёт путь, процесс пишет адрес, следующая сессия его
 * читает. Файл закрепления устроен так же (решение D1): путь даёт контейнер,
 * строку пишет процесс. Своего сертификата у пустышки нет, поэтому закрепление
 * ей называет тот, кто её объявил, — `--pin`; настоящий сервис пишет туда
 * отпечаток собственного сертификата. Отметка запуска нужна проверке «второго
 * процесса не появилось»: по записи контейнера этого не разглядеть — она
 * перезаписывается.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const at = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const port = Number(at('--port') ?? Number.NaN);
const addressFile = at('--address-file');
const pinFile = at('--pin-file');
const pin = at('--pin');
const mark = at('--mark');
if (!Number.isInteger(port)) {
  process.stderr.write('отвязываемая пустышка: не дали --port\n');
  process.exit(2);
}
if (mark !== undefined) appendFileSync(mark, `${process.pid}\n`);

const server = createServer((socket) => { socket.end(); });
// Второй процесс на занятом порту выходит молча: отметка уже сделана, а трасса
// EADDRINUSE в выводе гейта изображала бы падение теста, а не его находку.
server.on('error', () => { process.exit(0); });
server.listen(port, '127.0.0.1', () => {
  // Закрепление пишется ПЕРЕД адресом (DSK-8, решение D5): к моменту, когда
  // адрес уехал странице, сверять уже есть с чем.
  if (pinFile !== undefined && pin !== undefined) writeFileSync(pinFile, `${pin}\n`, { mode: 0o600 });
  // Адрес пишется ПОСЛЕ того, как порт занят: файл с адресом, по которому никого
  // нет, хуже отсутствующего файла.
  if (addressFile !== undefined) writeFileSync(addressFile, `tcp://127.0.0.1:${String(port)}\n`);
});

const stop = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
