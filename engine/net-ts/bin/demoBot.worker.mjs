/**
 * Поток ботов стенда демо-арены (BOT-4): хостинг бота исполняется ВНЕ потока
 * авторитетного цикла матча, и здесь этот поток заводится.
 *
 * Зеркало браузерного `browserEntry.ts` и нодового `nodeEntry.ts` бот-пакета:
 * приём одного init-сообщения и передача его общей воркер-стороне. Своим
 * файлом, а не `nodeEntry.ts` напрямую, ровно по одной причине — хук резолва
 * `./x.js` → `./x.ts` действует на поток, и воркеру он нужен свой (`tsHook.mjs`).
 */
import { parentPort } from 'node:worker_threads';
import './tsHook.mjs';

if (parentPort === null) {
  throw new Error('demoBot.worker: файл исполняется вне worker_threads — parentPort отсутствует');
}

const { isBotWorkerInit, startBotWorker } = await import('@game-mvp/bot');

/**
 * Отчёт об исходе посадки: какие слоты бот действительно занял, а где сервер
 * отказал (слот успел занять человек — штатный `slot-taken`). Заполнитель на
 * стороне сервера мест не видит по построению (BOT-4), а стенд обязан
 * печатать правду, а не намерение.
 */
function reportSeats(host) {
  const settled = (seat) => seat.client.slot !== undefined || seat.closed;
  const deadline = Date.now() + 2000;
  const tick = () => {
    if (!host.seats.every(settled) && Date.now() < deadline) {
      setTimeout(tick, 50);
      return;
    }
    parentPort.postMessage({
      t: 'bot-report',
      seats: host.seats.map((seat) => ({
        playerId: seat.playerId,
        slot: seat.client.slot ?? null,
        rejected: seat.client.closeReason === 'rejected' ? seat.client.closeDetail : null,
      })),
    });
  };
  setTimeout(tick, 50);
}

parentPort.on('message', (message) => {
  if (!isBotWorkerInit(message)) return;
  reportSeats(startBotWorker(message));
});
