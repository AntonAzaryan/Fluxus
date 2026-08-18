#!/usr/bin/env node
/**
 * Стенд демо-арены: выделенный сервер матча (`net-session` SES-1, режим
 * `dedicated`) с бот-заполнителем слотов (BOT-7) и авто-рестартом (design D3).
 *
 *   node game/demo-ts/bin/demo-serve.mjs [--port 8080] [--bot-fill-ms 5000]
 *                                       [--match content/matches/duel.match.json]
 *                                       [--bot content/bots/normal.json] [--brain classic]
 *                                       [--json] [--once]
 *                                       [--debug] [--max-ticks 600] [--out-dir runs/latest]
 *                                       [--trace=off|systems|full] [--trace-select=<вид|код>,...]
 *                                       [--dict <словарь журнала>]
 *
 * Отладочный прогон (`--debug`, CLI-11) — ОДНА команда и ни человека за
 * клавиатурой, ни второго процесса: боты занимают слоты немедленно, матч
 * ограничен по тикам и завершается сам, артефакты остаются на диске. Каталог
 * вывода — стабильный путь (`runs/latest`), а не каталог со временем в имени:
 * разбирающему бой не должно приходиться искать свежий прогон по дате.
 *
 * Состав артефактов: трейс (`trace.jsonl`), запись матча в форме документа
 * сценария (`match.scenario.json`, CLI-2, NTR-8), журнал боя (`journal.jsonl`,
 * DIAG-10) и сводка прогона (`run.json`). Отметок реального времени,
 * идентификаторов процесса и прочих данных окружения нет ни в одном (CLI-11):
 * два прогона одной записи обязаны сравниваться `diff`'ом.
 *
 * Ввод при этом недетерминирован (BOT-5) — и это не дефект, а ровно тот случай,
 * ради которого DIAG-9 требует класть запись рядом: воспроизводится не «стенд»,
 * а отыгранный матч.
 *
 * Стенд живёт в сборке игры, а не в `engine/net-ts`, и это не переезд ради
 * порядка: он читает дерево контента (`content/matches/duel.match.json`,
 * `content/bots/normal.json`) через `fs`, а движку дерево контента запрещено
 * (`game-content` CONT-4). Игре оно разрешено — она и есть игра (CONT-1),
 * поэтому здесь чтение не требует оправдания. Сетевые детали приходят
 * опубликованной поверхностью пакета (`@game-mvp/net`), а не файлами под его
 * `src/`.
 *
 * Тонкая обвязка поверх тех же деталей, что и `serve.mjs` пакета net:
 * `MatchServer`, `MatchHost`, WebSocket-транспорт — те же самые и не тронутые
 * (SES-2). Своего здесь ровно три вещи, и все три — сборочные:
 *
 * 1. Демо-арена из дерева контента: матч-конфиг и сцена берутся из `content/`,
 *    а не из примера рядом с пакетом (`game-content` CONT-1).
 * 2. Бот-заполнитель: слот, не занятый человеком к дедлайну `--bot-fill-ms`,
 *    получает бота (BOT-7). Отсчёт идёт от первого ПРЕТЕНДЕНТА — участника,
 *    который уже что-то сказал, — а не от старта процесса и не от факта
 *    соединения: пустой стенд ждёт людей, а не сажает ботов в вечный матч сам с
 *    собой, и молчащий сокет его не заводит. Боты живут в отдельном потоке
 *    (BOT-4) — `demoBot.worker.mjs`.
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
// Раскладка документа матча — та же, что у запускалок net (`matchConfigOf`), и
// берётся она оттуда же: разойдись стенд с `serve.mjs` в сборке мира, и один
// файл матча поднял бы два разных мира (NTR-5, NTR-14). Подпуть пакета, потому
// что помощник запускалок в публичный `@game-mvp/net` не входит, а вторая копия
// раскладки и есть тот самый способ разойтись.
import { flag, matchConfigOf, option, readMatchFile } from '@game-mvp/net/bin/matchFile.mjs';
// Флаги трейса — оттуда же и по той же причине (CLI-11): уровень, отбор и путь
// вывода стенд принимает тем же образом, что и `serve.mjs`.
import { openMatchTrace, traceOptions, TRACE_USAGE } from '@game-mvp/net/bin/trace.mjs';
// Журнал собирается ТЕМ ЖЕ кодом, что и команда `npm run journal` (CLI-12):
// второй разбор трейса рядом означал бы вторую реализацию выборки фактов.
import { journalDocument, journalFromFile, journalReport } from '@game-mvp/core/bin/journal.mjs';

const fromRepo = (relative) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

if (flag('help')) {
  process.stdout.write(
    'usage: node game/demo-ts/bin/demo-serve.mjs [--port 8080] [--bot-fill-ms 5000]\n' +
      '       [--match <match.json>] [--bot <profile.json>] [--brain classic|scripted] [--json] [--once]\n' +
      `       [--debug] [--max-ticks 600] [--out-dir runs/latest] [--dict <словарь>]\n       ${TRACE_USAGE}\n`,
  );
  process.exit(0);
}

const {
  contentPack,
  jsonSerializer,
  mergeTransportServers,
  msgpackSerializer,
  MatchHost,
  MatchServer,
  webSocketTransportServer,
} = await import('@game-mvp/net');
const { BRAIN_KINDS, BotSlotFiller, PortConnections, attachBots, parseBotProfile } =
  await import('@game-mvp/bot');

const match = readMatchFile(option('match', fromRepo('content/matches/duel.match.json')));
const pack = contentPack(match.scenes);
const profile = parseBotProfile(
  JSON.parse(readFileSync(option('bot', fromRepo('content/bots/normal.json')), 'utf8')),
  'профиль бота стенда',
);
const brain = option('brain', 'classic');
// Имя мозга проверяется ЗДЕСЬ, до первого подключения: неизвестное имя иначе
// обнаружилось бы падением потока ботов на дедлайне — то есть матчем, который
// молча не стартовал (BOT-2).
if (!BRAIN_KINDS.includes(brain)) {
  process.stderr.write(`неизвестный мозг "${brain}"; известные: ${BRAIN_KINDS.join(', ')}\n`);
  process.exit(2);
}
const port = Number(option('port', '8080'));
/**
 * Отладочный прогон (CLI-11): боты садятся немедленно, матч ограничен по тикам,
 * артефакты ложатся в каталог. `--once` он подразумевает — прогон для разбора
 * ровно один, и авто-рестарт переписал бы его артефакты следующим матчем.
 */
const debugRun = flag('debug');
const botFillMs = Number(option('bot-fill-ms', debugRun ? '0' : '5000'));
/** Ограничение длительности отладочного матча: десять секунд при 60 Гц. */
const maxTicks = Number(option('max-ticks', '600'));
const outDir = option('out-dir', fromRepo('runs/latest'));
const dictPath = option('dict', fromRepo('game/demo-ts/app/journal/duel.dictionary.json'));
// Каталог заводится ДО матча: писателю трейса открывать файл в несуществующем
// каталоге нечем, а узнать об этом в конце прогона — значит потерять прогон.
if (debugRun) mkdirSync(outDir, { recursive: true });
// Полный уровень — умолчание отладочного прогона: события едут только на нём
// (DIAG-3), а без событий журнал боя пуст. Цена — объём (шапка `bin/trace.mjs`);
// длинному прогону отвечает `--trace-select=event`.
const tracing = openMatchTrace(
  traceOptions(debugRun ? { level: 'full', out: join(outDir, 'trace.jsonl') } : {}),
);
const serializer = flag('json') ? jsonSerializer : msgpackSerializer;
// Формат кадра — свойство сборки, а не поле протокола, и он один на ВСЕХ
// участников матча: сервер, люди и боты. Дебаг-формат, объявленный только
// серверу, дал бы не отказ, а тишину — бот шлёт `Hello`, которого сервер не
// разбирает (SER-3, `protocol/codec.ts`). Имя берётся у САМОГО сериализатора:
// второе решение «каким форматом говорим» рядом с первым и есть способ им
// разойтись.
const wireFormat = serializer.name;
const tickRate = match.tickRate ?? 60;
const scene = pack.scene(match.sceneRef);

/**
 * Конфиг матча — один на все рестарты: следующий матч играется тем же (D3).
 * Раскладка общая с `serve.mjs` (`matchConfigOf`), включая зависимости сборки
 * мира (NTR-14): те же значения предъявит клиент, иначе хеш `worldInit`
 * разойдётся ещё на входе (NTR-5).
 */
function matchConfig() {
  return {
    ...matchConfigOf(match, pack),
    // Подключение sink'а ход матча не меняет (DIAG-8): отладочный матч — тот же
    // матч, и в запись (`toScenario`) это поле не входит (CLI-11).
    ...(tracing !== undefined ? { trace: tracing.trace } : {}),
  };
}

// ------------------------------------------------- слушающая сторона стенда

const sockets = webSocketTransportServer({ port });
/** Соединения текущего матча: закрываются на рестарте, порт остаётся. */
const live = new Set();
/**
 * Претенденты на слоты: соединения, которые уже ЗАГОВОРИЛИ и не закрыты.
 *
 * Отсчёт до заморозки ростера идёт от них, а не от факта соединения (D2).
 * Разница не косметическая: открытый сокет, не сказавший ни слова, — это
 * сканер порта, недогрузившаяся вкладка или прокси, и заводить по нему матч
 * нельзя. Дедлайн, взведённый молчащим сокетом, сажает ботов в ОБА слота, матч
 * стартует бот против бота и занимает стенд, а пришедший следом человек
 * получает «матч занят» — стенд, выведенный из строя чужим подключением.
 *
 * Претендент опознаётся первым сообщением, а не разбором `Hello`: первое, что
 * шлёт участник, и есть предъявление версии (NTR-5), и второй разбор протокола
 * рядом с сервером обвязке не нужен — ей нужен факт «кто-то пришёл играть».
 * Отвергнутый (чужая версия, занятый слот) закрывается сервером и из множества
 * уходит сам.
 */
const claimants = new Set();
/** Обработчик соединений текущего матча; между матчами — `undefined`. */
let session;
/** Пришедшие, пока матч не поднят: подключившийся раньше не теряется. */
const waiting = [];
/** Появился первый претендент этого матча — взвести дедлайн (D2). */
let onClaimant = () => {};
/** Претендентов не осталось — отсчёт начинать не с кого. */
let onClaimantsGone = () => {};

/**
 * Наблюдающая обёртка над соединением: считает, заговорил ли участник, и
 * убирает его при закрытии. Обёртка, а не подписка рядом, потому что и
 * `onMessage`, и `onClose` держат ровно по одному обработчику
 * (`BaseTransport`), и принадлежат они `MatchHost` — вклиниться можно только
 * между ним и настоящим транспортом. Байты обёртка не разбирает и не трогает.
 */
function observed(inner) {
  let spoke = false;
  const wrapper = {
    get isClosed() {
      return inner.isClosed;
    },
    send: (bytes) => inner.send(bytes),
    close: (reason) => inner.close(reason),
    onMessage(handler) {
      inner.onMessage((bytes) => {
        if (!spoke) {
          spoke = true;
          claimants.add(wrapper);
          onClaimant();
        }
        handler(bytes);
      });
    },
    onClose(handler) {
      inner.onClose((reason) => {
        live.delete(wrapper);
        if (claimants.delete(wrapper) && claimants.size === 0) onClaimantsGone();
        handler(reason);
      });
    },
  };
  return wrapper;
}

sockets.onConnection((raw) => {
  const transport = observed(raw);
  live.add(transport);
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
    live.clear();
    claimants.clear();
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
    `дедлайн ${botFillMs} мс после первого претендента на слот\n` +
    `  клиент: npm run play -- --url ws://127.0.0.1:${port} --player ${match.players[0]}\n` +
    `  вкладка: демо с ?server=ws://127.0.0.1:${port}\n` +
    (debugRun
      ? `  отладочный прогон: боты садятся сразу, матч до тика ${maxTicks}, артефакты в ${outDir}\n`
      : '') +
    '\n',
);

let round = 0;
let failed = false;
for (;;) {
  round++;
  failed = await runMatch(round);
  // Отладочный прогон — ровно один матч: авто-рестарт переписал бы его
  // артефакты следующим матчем, и разбирать было бы уже не тот бой.
  if (flag('once') || debugRun) break;
  process.stdout.write('\nматч завершён — поднимаю следующий тем же конфигом\n');
}
// Одиночный прогон — это проверка, и её исход обязан быть в коде возврата:
// «бот не сел, а слоты пустые» — отказ стенда, а не тихая строка в логе.
await shutdown(failed ? 1 : 0);

/**
 * Один матч от подъёма до `End`. Всё, что здесь создаётся, здесь же и
 * закрывается: следующий матч начинается с чистого сервера, чистого хоста и
 * нового потока ботов. Возвращает признак отказа стенда — того, что требует
 * внимания человека, а не очередного рестарта.
 */
async function runMatch(number) {
  // Подключившиеся, пока прежний матч сворачивался, ждут в очереди и станут
  // участниками ЭТОГО матча — их раздаст конструктор `MatchHost` ниже. Те из
  // них, кто уже заговорил, — претенденты, и отсчёт для них идёт: без этого
  // одинокий клиент, попавший в окно рестарта, ждал бы бота вечно.
  onClaimant = () => {};
  onClaimantsGone = () => {};

  const server = new MatchServer(matchConfig());
  const connections = new PortConnections();
  const host = new MatchHost(server, mergeTransportServers(sessionServer, connections), { serializer });

  let botWorker = null;
  let failure = null;
  /** Сворачивание матча: остановка потока ботов — не его падение. */
  let stopping = false;
  /** Отказ стенда: называется громко и один раз. */
  const fail = (message) => {
    if (failure !== null) return;
    failure = message;
    process.stderr.write(`\nстенд: ${message}\n`);
  };
  const makeFiller = () => new BotSlotFiller({
    players: match.players,
    deadlineMs: botFillMs,
    // Заполнять нечего в двух случаях, и оба читаются снаружи сервера (BOT-1).
    // Первый — ростер успели занять люди (BOT-7, сценарий «Друг успел до
    // старта»): публичная фаза матча. Второй — играть не с кем: претендент,
    // взведший отсчёт, ушёл раньше дедлайна, и посадить бота значило бы отдать
    // ему пустой матч (а при двух слотах — начать бой ботов между собой и
    // занять стенд). Стенд остаётся в лобби и ждёт людей.
    // Отладочный прогон снимает ВТОРОЕ условие, и только его: играть здесь не с
    // кем по построению — человека за клавиатурой нет и не предполагается
    // (CLI-11, «Самодостаточность»), а бой ботов между собой и есть предмет
    // разбора. Первое условие остаётся: занятый людьми ростер не переигрывается
    // ботами ни в каком режиме.
    frozen: () => server.phase !== 'lobby' || (!debugRun && claimants.size === 0),
    // Слоты предлагаются ВСЕ: какой из них занят человеком, обвязка не знает —
    // сервер владельца слота не называет, и спрашивать его об этом значило бы
    // завести рядом с ним ветвление по типу участника (BOT-1). Занятый слот
    // сервер отвергает штатным `slot-taken`, и бот отпускает канал; кто в итоге
    // сел, приезжает отчётом из потока ботов.
    attach: (playerIds) => {
      botWorker = new Worker(new URL('./demoBot.worker.mjs', import.meta.url));
      botWorker.unref();
      // Упавший поток ботов — самый тихий из отказов: матч просто не стартует.
      // Поэтому и `error`, и ненулевой `exit` называются вслух.
      botWorker.on('error', (error) => { fail(`поток ботов упал: ${error.message}`); });
      botWorker.on('exit', (code) => {
        // `terminate()` на сворачивании матча даёт код 1 — это не отказ.
        if (code !== 0 && !stopping) fail(`поток ботов вышел с кодом ${code}`);
      });
      botWorker.on('message', (report) => {
        if (report?.t !== 'bot-report') return;
        const taken = report.seats.filter((seat) => seat.slot !== null);
        process.stdout.write(
          `\nбот сел в слоты: ${taken.map((seat) => seat.playerId).join(', ') || '—'}` +
            `; отказано: ${report.seats.filter((seat) => seat.rejected !== null).length}\n`,
        );
        // Ни одного занятого слота при незамороженном ростере означает, что
        // заполнитель не сработал: разошёлся формат кадра, версия или контент.
        // Матч в этом состоянии стоит в лобби вечно, и молчать об этом нельзя.
        if (taken.length === 0 && server.phase === 'lobby') {
          fail(
            'бот не занял ни одного слота, а матч всё ещё в лобби — ' +
              'проверьте формат кадра (--json), версию сборки и контент-пак (NTR-5)',
          );
        }
      });
      attachBots({
        worker: botWorker,
        connections,
        channel: () => new MessageChannel(),
        seats: playerIds.map((playerId) => ({ playerId, brain, profile })),
        buildId: match.buildId,
        sceneRef: match.sceneRef,
        scene,
        // Тот же формат, которым говорит сервер (SER-3): бот — обычный участник
        // матча, и «свойство сборки» относится к нему наравне с людьми.
        wireFormat,
        ...(match.physics !== undefined ? { physics: match.physics } : {}),
        ...(match.visibility !== undefined ? { visibility: match.visibility } : {}),
      });
      process.stdout.write(`\nдедлайн: бот предложен на слоты ${playerIds.join(', ')}\n`);
      // Места живут в другом потоке — наблюдать их отсюда нечем (BOT-4).
      return [];
    },
  });

  let filler = makeFiller();
  onClaimant = () => { filler.arm(); };
  // Ушёл последний претендент — отсчёт начинать не с кого: неистёкший дедлайн
  // отменяется вместе с заполнителем, а следующий пришедший заведёт свой.
  // Заполнитель однократен по построению (BOT-7: заморозка одна), поэтому
  // «отменить и завести заново» здесь и означает «отложить до людей».
  onClaimantsGone = () => {
    if (filler.filled) return;
    filler.dispose();
    filler = makeFiller();
  };
  // Претенденты, доставшиеся этому матчу из очереди рестарта, дедлайн уже
  // «нажали» — взводим его за них. Отладочный прогон взводит его сам: ждать
  // претендента-человека там некого, и пустой стенд ждал бы вечно.
  if (claimants.size > 0 || debugRun) filler.arm();

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

  // Матч кончается двумя способами: `End` — своим, отказ стенда — чужим. Ждать
  // `ended` после отказа бессмысленно: матч, который не стартовал, никогда его
  // не достигнет — под `--once` стенд висел бы вместо того, чтобы назвать
  // причину и выйти ненулевым кодом.
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      // Отладочный матч ограничен по длительности и завершается САМ (CLI-11):
      // человека, который нажмёт Ctrl+C, у прогона нет. Остановка идёт штатным
      // путём сервера — тем же `End`, что и всякий другой конец матча.
      if (debugRun && server.phase === 'running' && server.tick >= maxTicks) server.stop();
      if (server.phase !== 'ended' && failure === null) return;
      clearInterval(poll);
      resolve();
    }, 100);
  });

  clearInterval(report);
  onClaimant = () => {};
  onClaimantsGone = () => {};
  filler.dispose();
  // `host.stop()` закрывает слушающие стороны обоих транспортов — и вид сокета,
  // и портовые каналы ботов (`mergeTransportServers`), — поэтому второго
  // закрытия здесь нет.
  await host.stop();
  stopping = true;
  await botWorker?.terminate();
  if (debugRun) saveArtifacts(server, failure);
  return failure !== null;
}

/**
 * Артефакты отладочного прогона (CLI-11): трейс, запись матча, журнал боя и
 * сводка. Ни в одном из них нет отметок реального времени, идентификаторов
 * процесса и прочих данных окружения — по тому же основанию, по которому их не
 * содержит запись диагностики (DIAG-2): два прогона одной записи обязаны
 * сравниваться `diff`'ом.
 */
function saveArtifacts(server, failure) {
  // Трейс закрывается ДО чтения: журнал собирается по файлу, и недописанный
  // хвост буфера стал бы усечённой строкой на ровном месте.
  tracing?.close();

  const summary = {
    match: match.name,
    buildId: match.buildId,
    contentPackHash: pack.hash,
    worldInitHash: server.worldInitHash,
    players: match.players,
    tickRate,
    ticks: server.tick,
    phase: server.phase,
    epochs: server.epoch + 1,
    slots: server.metrics.slots.map((slot, i) => ({
      playerId: match.players[i],
      applied: slot.applied,
      predicted: slot.predicted,
      late: slot.late,
    })),
    snapshotsSent: server.metrics.snapshotsSent,
    ...(failure !== null ? { failure } : {}),
  };

  if (tracing !== undefined) {
    summary.trace = {
      path: 'trace.jsonl',
      // Отказ записи гасит трейс, а не матч (DIAG-8), и называется он ЗДЕСЬ:
      // молча оборванный трейс выглядит поводом к расследованию, которого не
      // получится.
      ...(tracing.trace.failure !== undefined ? { failure: tracing.trace.failure } : {}),
    };
  }

  // Трейс без записи невоспроизводим (DIAG-9): ввод порождают боты, а не seed.
  // Матч с перемоткой плоской формой документа сценария не выражается (NTR-16,
  // CLI-2) — прогон говорит это прямо вместо усечённой записи, которая
  // выглядела бы воспроизводимой и разошлась бы при первом же реплее.
  try {
    writeFileSync(join(outDir, 'match.scenario.json'), `${JSON.stringify(server.toScenario(), null, 2)}\n`);
    summary.record = 'match.scenario.json';
  } catch (error) {
    summary.recordSkipped = error.message;
    process.stdout.write(`\nзаписи матча не будет: ${error.message}\n`);
  }

  if (tracing !== undefined) {
    const result = journalFromFile(join(outDir, 'trace.jsonl'), dictPath);
    writeFileSync(join(outDir, 'journal.jsonl'), journalDocument(result));
    summary.journal = {
      path: 'journal.jsonl',
      facts: result.entries.length,
      // Незнакомый тип — не отказ прогона, а отставший словарь (DIAG-10), и
      // назван он списком, а не молчанием.
      unknownTypes: result.unknownTypes,
      ...(result.malformedLines > 0 ? { malformedLines: result.malformedLines } : {}),
    };
    process.stderr.write(journalReport(result));
  }

  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`\nартефакты прогона: ${outDir}\n`);
}

async function shutdown(code) {
  // Трейс закрывается и на сигнале остановки: буфер писателя иначе остался бы
  // недописанным, и последняя строка файла выглядела бы усечённой.
  tracing?.close();
  await sockets.close();
  process.stdout.write('\nстенд остановлен\n');
  process.exit(code);
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
