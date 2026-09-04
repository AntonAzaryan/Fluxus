/**
 * Воркер сервера матча вкладки (design D1): здесь исполняется авторитетный цикл
 * дефолтного демо — сессия `local` (`net-session` SES-1).
 *
 * Главному потоку отсюда уходит ровно одна вещь — порт участника, которым
 * клиентский воркер соединяется с матчем. Ни состояния, ни тиков, ни presentation:
 * рисует их клиент, как и в матче на выделенном стенде (SES-2).
 */
import { isBotWorkerInit, startBotWorker, type WorkerLike } from '@fluxus/bot';
import { demoMatchConfig } from './match.js';
import { demoBotBehavior, demoBotProfile } from './bots.js';
import { openLocalSession } from './localSession.js';
import { isDemoServerInit, type DemoServerReady } from './wiring.js';

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown, transfer?: unknown[]): void;
};

/**
 * Поток ботов. Целевая сборка — отдельный воркер (BOT-4): стоимость мышления
 * мозга не должна влиять на каденс тика сервера.
 *
 * Запасной путь — тот же `BotHost` прямо здесь, в воркере сервера. Это ОСОЗНАННАЯ
 * ДЕГРАДАЦИЯ СБОРКИ, названная в Risks дизайна (D5): вложенные воркеры
 * поддержаны не везде, а демо-стенд без бота бесполезнее, чем демо-стенд с
 * ботом в одном потоке с сервером. Спека при этом не правится: BOT-4 остаётся
 * требованием к сборке, и целевая сборка ему удовлетворяет.
 */
function botThread(): WorkerLike {
  try {
    const worker = new Worker(new URL('./botWorker.ts', import.meta.url), { type: 'module' });
    // Переходник к структурному минимуму `WorkerLike`: у DOM-воркера
    // `postMessage` перегружен, и список переноса у него обязателен.
    return {
      postMessage(message: unknown, transfer?: readonly unknown[]): void {
        worker.postMessage(message, (transfer ?? []) as Transferable[]);
      },
    };
  } catch (error) {
    console.warn('демо: вложенный воркер бота недоступен, бот едет в потоке сервера (BOT-4, D5)', error);
    return {
      postMessage(message: unknown): void {
        if (isBotWorkerInit(message)) startBotWorker(message);
      },
    };
  }
}

scope.addEventListener('message', (event) => {
  if (!isDemoServerInit(event.data)) return;

  // Документы контент-пака приезжают конвертом сборки (CONT-5, design D4):
  // читает их главный поток из раздачи оболочки, и матч вкладки поднимается по
  // тому же экземпляру, по которому клиент считает свою версию (NTR-5).
  const { documents } = event.data;
  // Профиль — человечность (BOT-6), документ поведения — политика выбора
  // (BOT-8); связку называет профиль, а читает дерево контента игра (CONT-4).
  const profile = demoBotProfile();
  const session = openLocalSession({
    config: demoMatchConfig(documents),
    // Первый слот держит оболочка этой же вкладки: предлагать его боту незачем,
    // сервер всё равно отказал бы (BOT-7).
    reserved: documents.match.players.slice(0, 1),
    // Дедлайн нулевой: второго ЧЕЛОВЕКА эта сборка не ждёт (design D2).
    botFillMs: 0,
    bots: {
      worker: botThread(),
      channel: () => new MessageChannel(),
      brain: 'evaluated',
      profile,
      behavior: demoBotBehavior(profile),
    },
  });

  // Канал человека открывается ДО старта расписания: слот основателя занят его
  // собственным `Hello`, а не удержан особым правилом (SES-6).
  const port = session.connect(new MessageChannel());
  const ready: DemoServerReady = { t: 'demo-server-ready', port };
  scope.postMessage(ready, [port]);
  session.start();
});
