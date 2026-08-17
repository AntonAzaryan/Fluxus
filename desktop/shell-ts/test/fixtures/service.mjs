#!/usr/bin/env node
/**
 * Сервис-пустышка контрактного сьюта (DSK-7): слушает порт, отданный ему
 * подстановкой `{port}`, и на этом всё.
 *
 * Пустышка, а не стенд демо-арены, и это не лень: сьют границы не вправе
 * зависеть ни от движка, ни от контента (DSK-3), а проверяет он ровно то, что
 * контейнер знает о сервисе, — «процесс жив» и «по адресу отвечают».
 */
import { createServer } from 'node:net';

const index = process.argv.indexOf('--port');
const port = index < 0 ? Number.NaN : Number(process.argv[index + 1]);
if (!Number.isInteger(port)) {
  process.stderr.write('сервис-пустышка: не дали --port\n');
  process.exit(2);
}

const server = createServer((socket) => {
  socket.end();
});
server.listen(port, '127.0.0.1');

const stop = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
