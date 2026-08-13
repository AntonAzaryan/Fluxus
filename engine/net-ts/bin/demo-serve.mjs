#!/usr/bin/env node
/**
 * Стенд демо-арены: выделенный сервер матча (`net-session` SES-1, режим
 * `dedicated`) с бот-заполнителем слотов (BOT-7) и авто-рестартом (design D3).
 *
 *   node engine/net-ts/bin/demo-serve.mjs [--port 8080] [--bot-fill-ms 5000]
 *                                         [--match content/matches/duel.match.json]
 *                                         [--bot content/bots/normal.json] [--brain classic]
 *                                         [--json] [--once]
 *
 * Тонкая обвязка поверх тех же деталей, что и `serve.mjs`: `MatchServer`,
 * `MatchHost`, WebSocket-транспорт — те же самые и не тронутые (SES-2). Своего
 * здесь ровно три вещи, и все три — сборочные:
 *
 * 1. Демо-арена из дерева контента: матч-конфиг и сцена берутся из `content/`,
 *    а не из примера рядом с пакетом (`game-content` CONT-1).
 * 2. Бот-заполнитель: слот, не занятый человеком к дедлайну `--bot-fill-ms`,
 *    получает бота (BOT-7). Отсчёт идёт от ПЕРВОГО подключения, а не от старта
 *    процесса: пустой стенд ждёт людей, а не сажает ботов в вечный матч сам с
 *    собой. Боты живут в отдельном потоке (BOT-4) — `demoBot.worker.mjs`.
 * 3. Авто-рестарт: по завершении матча (`End` любой причины, включая молчание
 *    слота) обвязка поднимает следующий матч тем же конфигом. Цикл живёт
 *    ЗДЕСЬ — `MatchServer` остаётся чистым тиком без ввода-вывода (NTR-3), и
 *    ни одной ветки «а если матч кончился, начни новый» в нём не появляется.
 *
 * Слушающая сторона WebSocket переживает рестарт: порт открывается один раз, а
 * матчу отдаётся его «сессионный вид» — тот же `TransportServer`, закрытие
 * которого рвёт соединения ушедшего матча, но не отпускает порт. Иначе каждый
 * рестарт означал бы пересадку сокета, а пересаженный сокет — окно, в котором
 * стенд не отвечает.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import { flag, matchConfigOf, option, readMatchFile } from './matchFile.mjs';

const fromRepo = (relative) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

if (flag('help')) {
  process.stdout.write(
    'usage: node engine/net-ts/bin/demo-serve.mjs [--port 8080] [--bot-fill-ms 5000]\n' +
      '       [--match <match.json>] [--bot <profile.json>] [--brain classic|scripted] [--json] [--once]\n',
  );
  process.exit(0);
}

const { contentPack } = await import('../src/content/pack.ts');
const { MatchServer } = await import('../src/server/matchServer.ts');
const { MatchHost } = await import('../src/server/host.ts');
const { webSocketTransportServer } = await import('../src/transport/webSocketServer.ts');
const { mergeTransportServers } = await import('../src/transport/merged.ts');
const { jsonSerializer, msgpackSerializer } = await import('../src/protocol/codec.ts');
const { BotSlotFiller, PortConnections, attachBots, parseBotProfile } = await import('@game-mvp/bot');

const match = readMatchFile(option('match', fromRepo('content/matches/duel.match.json')));
const pack = contentPack(match.scenes);
const profile = parseBotProfile(
  JSON.parse(readFileSync(option('bot', fromRepo('content/bots/normal.json')), 'utf8')),
  'профиль бота стенда',
);
const brain = option('brain', 'classic');
const port = Number(option('port', '8080'));
const botFillMs = Number(option('bot-fill-ms', '5000'));
const serializer = flag('json') ? jsonSerializer : msgpackSerializer;
const tickRate = match.tickRate ?? 60;
const scene = pack.scene(match.sceneRef);

/**
 * Конфиг матча — один на все рестарты: следующий матч играется тем же (D3).
 * Раскладка общая с `serve.mjs` (`matchConfigOf`), включая зависимости сборки
 * мира (NTR-14): те же значения предъявит клиент, иначе хеш `worldInit`
 * разойдётся ещё на входе (NTR-5).
 */
function matchConfig() {
  return matchConfigOf(match, pack);
}

// ------------------------------------------------- слушающая сторона стенда

const sockets = webSocketTransportServer({ port });
/** Соединения текущего матча: закрываются на рестарте, порт остаётся. */
let live = [];
/** Обработчик соединений текущего матча; между матчами — `undefined`. */
let session;
/** Пришедшие, пока матч не поднят: подключившийся раньше не теряется. */
const waiting = [];
/** Первое подключение матча: с него идёт отсчёт до заморозки ростера (D2). */
let onArrival = () => {};

sockets.onConnection((transport) => {
  live.push(transport);
  onArrival();
  if (session === undefined) waiting.push(transport);
  else session(transport);
});

/** Вид слушающей стороны для ОДНОГО матча: его `close()` порт не отпускает. */
const sessionServer = {
  onConnection(next) {
    session = next;
    while (waiting.length > 0) next(waiting.shift());
  },
  close() {
    session = undefined;
    for (const transport of live) transport.close('match-restarted');
    live = [];
    return Promise.resolve();
  },
};

// ------------------------------------------------------------------- матчи

process.stdout.write(
  `стенд демо-арены "${match.name}" на ws://127.0.0.1:${port}\n` +
    `  версия: ${match.buildId} + ${pack.hash}\n` +
    `  слоты: ${match.players.join(', ')}\n` +
    `  темп: ${tickRate} Гц, формат: ${serializer.name}\n` +
    `  бот-заполнитель: мозг "${brain}", профиль "${profile.name}", ` +
    `дедлайн ${botFillMs} мс после первого подключения\n` +
    `  клиент: npm run play -- --url ws://127.0.0.1:${port} --player ${match.players[0]}\n` +
    `  вкладка: демо с ?server=ws://127.0.0.1:${port}\n\n`,
);

let round = 0;
for (;;) {
  round++;
  await runMatch(round);
  if (flag('once')) break;
  process.stdout.write('\nматч завершён — поднимаю следующий тем же конфигом\n');
}
await shutdown(0);

/**
 * Один матч от подъёма до `End`. Всё, что здесь создаётся, здесь же и
 * закрывается: следующий матч начинается с чистого сервера, чистого хоста и
 * нового потока ботов.
 */
async function runMatch(number) {
  const server = new MatchServer(matchConfig());
  const connections = new PortConnections();
  const host = new MatchHost(server, mergeTransportServers(sessionServer, connections), { serializer });

  let botWorker = null;
  const filler = new BotSlotFiller({
    players: match.players,
    deadlineMs: botFillMs,
    // Ростер успели занять люди — заполнять нечего (BOT-7, сценарий «Друг успел
    // до старта»). Читается публичная фаза СВОЕГО сервера: сервер о заполнителе
    // по-прежнему не знает (BOT-1).
    frozen: () => server.phase !== 'lobby',
    // Слоты предлагаются ВСЕ: какой из них занят человеком, обвязка не знает —
    // сервер владельца слота не называет, и спрашивать его об этом значило бы
    // завести рядом с ним ветвление по типу участника (BOT-1). Занятый слот
    // сервер отвергает штатным `slot-taken`, и бот отпускает канал; кто в итоге
    // сел, приезжает отчётом из потока ботов.
    attach: (playerIds) => {
      botWorker = new Worker(new URL('./demoBot.worker.mjs', import.meta.url));
      botWorker.unref();
      botWorker.on('message', (report) => {
        if (report?.t !== 'bot-report') return;
        const taken = report.seats.filter((seat) => seat.slot !== null);
        process.stdout.write(
          `\nбот сел в слоты: ${taken.map((seat) => seat.playerId).join(', ') || '—'}` +
            `; отказано: ${report.seats.filter((seat) => seat.rejected !== null).length}\n`,
        );
      });
      attachBots({
        worker: botWorker,
        connections,
        channel: () => new MessageChannel(),
        seats: playerIds.map((playerId) => ({ playerId, brain, profile })),
        buildId: match.buildId,
        sceneRef: match.sceneRef,
        scene,
        ...(match.physics !== undefined ? { physics: match.physics } : {}),
        ...(match.visibility !== undefined ? { visibility: match.visibility } : {}),
      });
      process.stdout.write(`\nдедлайн: бот предложен на слоты ${playerIds.join(', ')}\n`);
      // Места живут в другом потоке — наблюдать их отсюда нечем (BOT-4).
      return [];
    },
  });
  onArrival = () => { filler.arm(); };

  process.stdout.write(`матч #${number}: жду участников на ws://127.0.0.1:${port}\n`);
  host.start();

  const report = setInterval(() => {
    const slots = server.metrics.slots
      .map((slot, i) => `${match.players[i]}: ${slot.applied}/${slot.predicted}/${slot.late}`)
      .join('  ');
    process.stdout.write(
      `\rматч #${number} тик ${server.tick} [${server.phase}]  применено/предсказано/опоздало → ${slots}  ` +
        `снапшотов ${server.metrics.snapshotsSent}, ${(server.metrics.bytesSent / 1024).toFixed(1)} КиБ   `,
    );
  }, 1000);

  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (server.phase !== 'ended') return;
      clearInterval(poll);
      resolve();
    }, 100);
  });

  clearInterval(report);
  onArrival = () => {};
  filler.dispose();
  await host.stop();
  await connections.close();
  await botWorker?.terminate();
}

async function shutdown(code) {
  await sockets.close();
  process.stdout.write('\nстенд остановлен\n');
  process.exit(code);
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
