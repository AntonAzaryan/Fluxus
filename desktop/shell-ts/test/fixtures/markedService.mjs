#!/usr/bin/env node
/**
 * Сервис-пустышка, отмечающая каждый свой запуск строкой в файле `--mark`:
 * так тест видит, сколько процессов контейнер породил НА САМОМ ДЕЛЕ (DSK-7) —
 * по записи в `owned` этого не разглядеть, перезаписанная выглядит как одна.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';

const at = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const port = Number(at('--port') ?? Number.NaN);
const mark = at('--mark');
if (!Number.isInteger(port) || mark === undefined) {
  process.stderr.write('отмечающая пустышка: нужны --port и --mark\n');
  process.exit(2);
}
appendFileSync(mark, `${process.pid}\n`);

const server = createServer((socket) => {
  socket.end();
});
// Второй процесс на занятом порту выходит молча: отметка уже сделана, а трасса
// EADDRINUSE в выводе гейта изображала бы падение теста, а не его находку.
server.on('error', () => {
  process.exit(0);
});
server.listen(port, '127.0.0.1');

const stop = () => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
