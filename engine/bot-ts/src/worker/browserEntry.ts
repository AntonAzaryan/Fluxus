/**
 * Entry бота в браузерном dedicated Worker (BOT-4, design D3).
 *
 * Тонкий по существу, а не по стилю: всё, что здесь есть, — приём одного
 * init-сообщения и передача его общей воркер-стороне. Порты матча приезжают в
 * этом же сообщении transfer'ом (`ports`), поэтому второго канала настройки не
 * нужно, а `MatchServer` о существовании воркера не знает (SES-2).
 *
 * Сборка главного потока:
 *
 * ```ts
 * const worker = new Worker(new URL('.../browserEntry.ts', import.meta.url), { type: 'module' });
 * const channel = new MessageChannel();
 * const botPort = connections.open(channel);        // серверный конец ушёл MatchHost,
 *                                                   // вернулся ботский
 * worker.postMessage(botWorkerInit({ ..., ports: [botPort] }), [botPort as MessagePort]);
 * ```
 */
import { isBotWorkerInit } from '../assembly.js';
import { startBotWorker } from './botWorker.js';

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

scope.addEventListener('message', (event) => {
  if (!isBotWorkerInit(event.data)) return;
  startBotWorker(event.data);
});
