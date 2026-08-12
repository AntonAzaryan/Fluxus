/**
 * Entry бота в потоке node `worker_threads` (BOT-4, design D3) — зеркало
 * браузерного entry: тот же `startBotWorker`, другой источник init-сообщения.
 *
 * Сборка запускающей стороны:
 *
 * ```ts
 * const worker = new Worker(new URL('.../nodeEntry.js', import.meta.url));
 * const channel = new MessageChannel();
 * const botPort = connections.open(channel);        // серверный конец ушёл MatchHost,
 *                                                   // вернулся ботский
 * worker.postMessage(botWorkerInit({ ..., ports: [botPort] }), [botPort as MessagePort]);
 * ```
 */
import { parentPort } from 'node:worker_threads';
import { isBotWorkerInit } from '../assembly.js';
import { startBotWorker } from './botWorker.js';

if (parentPort === null) {
  throw new Error('nodeEntry: файл исполняется вне worker_threads — parentPort отсутствует');
}

parentPort.on('message', (message: unknown) => {
  if (!isBotWorkerInit(message)) return;
  startBotWorker(message);
});
