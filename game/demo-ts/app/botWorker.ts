/**
 * Поток бота вкладки (BOT-4): entry, принимающий одно init-сообщение и
 * отдающий его общей воркер-стороне бот-пакета.
 *
 * Свой файл, а не `bot-ts/src/worker/browserEntry.ts` напрямую, по причине
 * сборочной: `new Worker(new URL(…))` берёт путь, а не имя пакета, и адресовать
 * файл внутри зависимости этим способом нечем.
 */
import { isBotWorkerInit, startBotWorker } from '@fluxus/bot';

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

scope.addEventListener('message', (event) => {
  if (!isBotWorkerInit(event.data)) return;
  startBotWorker(event.data);
});
