#!/usr/bin/env node
/**
 * Стенд демо-арены: выделенный сервер матча (`net-session` SES-1, режим
 * `dedicated`) с бот-заполнителем слотов (BOT-7) и авто-рестартом (design D3).
 *
 *   node game/demo-ts/bin/demo-serve.mjs [--port 8080] [--bot-fill-ms 120000]
 *                                       [--on-disconnect bot|hold|pause] [--substitute-delay-ms 2000]
 *                                       [--silence-seconds <окно возврата>]
 *                                       [--match content/matches/duel.match.json]
 *                                       [--bot content/bots/normal.json] [--brain evaluated]
 *                                       [--json] [--once] [--control-adapter]
 *                                       [--debug] [--max-ticks 600] [--out-dir runs/latest]
 *                                       [--trace=off|systems|full] [--trace-select=<вид|код>,...]
 *                                       [--dict <словарь журнала>]
 *
 * `--control-adapter` (`server-control` SRV-1, SRV-4, SRV-5; решение D2) —
 * стенд, поднятый АГЕНТОМ хоста: отчёт о фазе, слотах и метриках уходит
 * маркированными JSON-линиями в stdout, команды админа приходят JSON-линиями в
 * stdin. Без флага стенд ведёт себя ровно как прежде — ни одной лишней строки,
 * ни одного лишнего замера (решение D9).
 *
 * Значение флага принимается обеими формами — `--trace=full` и `--trace full`
 * (CLI-11, `@fluxus/net/bin/matchFile.mjs`).
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
 * `content/bots/normal.json` и названный профилем документ поведения
 * `content/bots/behaviors/*.json`) через `fs`, а движку дерево контента запрещено
 * (`game-content` CONT-4). Игре оно разрешено — она и есть игра (CONT-1),
 * поэтому здесь чтение не требует оправдания. Сетевые детали приходят
 * опубликованной поверхностью пакета (`@fluxus/net`), а не файлами под его
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
 * 2а. Бот-заместитель: слот, потерявший соединение уже в бою, стенд по политике
 *    `--on-disconnect bot` отдаёт боту (BOT-14) — обычным клиентом с ролью
 *    заместителя (NTR-18), с паузой `--substitute-delay-ms`, чтобы сетевой
 *    всплеск не дёргал бота. Вернувшийся владелец забирает слот вытеснением, и
 *    это механизм СЕРВЕРА (NTR-17, NTR-18): стенд лишь не пере-подключает
 *    вытесненного. Политика `hold` не делает ничего — слот ждёт владельца до
 *    порога молчания (`--silence-seconds`, умолчание — поле документа матча).
 * 2б. Пауза при разрыве: политика `--on-disconnect pause` (NTR-20, решение D6)
 *    замораживает матч серверным API паузы, пока слот без соединения, и
 *    возобновляет его по правилам документа матча, когда владелец вернулся
 *    реконнектом (NTR-17). Умолчание флага — поле `pause.onOwnerDetach`
 *    документа матча: правила паузы — данные, а не флаги запускалки.
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
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
// Раскладка документа матча — та же, что у запускалок net (`matchConfigOf`), и
// берётся она оттуда же: разойдись стенд с `serve.mjs` в сборке мира, и один
// файл матча поднял бы два разных мира (NTR-5, NTR-14). Подпуть пакета, потому
// что помощник запускалок в публичный `@fluxus/net` не входит, а вторая копия
// раскладки и есть тот самый способ разойтись.
import {
  clientBuildOptions,
  flag,
  matchConfigOf,
  option,
  readMatchFile,
} from '@fluxus/net/bin/matchFile.mjs';
// Флаги трейса — оттуда же и по той же причине (CLI-11): уровень, отбор и путь
// вывода стенд принимает тем же образом, что и `serve.mjs`.
import {
  openMatchTrace,
  traceOptions,
  TRACE_USAGE,
  TRACE_WITHOUT_RECORD,
} from '@fluxus/net/bin/trace.mjs';
// Журнал собирается ТЕМ ЖЕ кодом, что и команда `npm run journal` (CLI-12):
// второй разбор трейса рядом означал бы вторую реализацию выборки фактов.
import { journalDocument, journalFromFile, journalReport } from '@fluxus/core/bin/journal.mjs';

const fromRepo = (relative) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

if (flag('help')) {
  process.stdout.write(
    'usage: node game/demo-ts/bin/demo-serve.mjs [--port 8080] [--bot-fill-ms 120000]\n' +
      '       [--on-disconnect bot|hold|pause] [--substitute-delay-ms 2000] [--silence-seconds <сек>]\n' +
      '       [--match <match.json>] [--bot <profile.json>] [--brain evaluated|scripted] [--json] [--once]\n' +
      '       [--control-adapter]\n' +
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
} = await import('@fluxus/net');
const {
  BRAIN_KINDS,
  BotSlotFiller,
  BotSubstitutes,
  PortConnections,
  attachBots,
  parseBotBehavior,
  parseBotProfile,
} = await import('@fluxus/bot');
// Слушающая сторона между матчами — модуль сборки, а не часть скрипта: окно
// рестарта проверяется тестом (`test/standSession.test.ts`). Типы Node
// стрипает сам (>=22.18, тот же приём, что у `bots-sync.mjs`), а динамическим
// импортом — как и всё типизированное в этом файле: после установки хука.
const { standSession } = await import('../app/standSession.ts');
// Умолчания и разбор политик стенда — там же и по той же причине: молча уехавшее
// умолчание снаружи неотличимо от «стенд ведёт себя странно»
// (`test/standPolicy.test.ts`).
const { standPolicy } = await import('../app/standPolicy.ts');
// Политика «разрыв замораживает матч» (NTR-20, D6) — там же и по той же
// причине: она принадлежит сборке-основателю, а не серверу матча.
const { DetachPause } = await import('../app/detachPause.ts');
// Control-адаптер агента хоста (`server-control` SRV-4, SRV-5; решение D2):
// отчёт и команды по stdio. Там же и по той же причине, что политики выше —
// проверяется он тестом, а не глазами по выводу процесса.
const { standControl } = await import('../app/controlAdapter.ts');
// Что запертый слот (NTR-19) значит для стенда: переезд запрета в следующий круг
// и диагноз пустой посадки. Там же и по той же причине, что политики выше — круг,
// не стартующий из-за запрета, обязан сказать об этом сам и не обязан падать, а
// проверяется это тестом (`test/barredSlots.test.ts`).
const { carryBarredSlots, seatingIsStandFailure } = await import('../app/barredSlots.ts');

const match = readMatchFile(option('match', fromRepo('content/matches/duel.match.json')));
const pack = contentPack(match.scenes);
const profile = parseBotProfile(
  JSON.parse(readFileSync(option('bot', fromRepo('content/bots/normal.json')), 'utf8')),
  'профиль бота стенда',
);
// Документ поведения (BOT-8) стенд берёт по пути, который назвал ПРОФИЛЬ:
// «какую политику играет этот бот» — данные, а не флаг запускалки и не
// константа обвязки. Путь адресуется от корня дерева контента (ASSET-2), читать
// которое стенду законно — он игра (CONT-1).
const behavior = parseBotBehavior(
  JSON.parse(readFileSync(fromRepo(`content/${profile.behavior}`), 'utf8')),
  profile.behavior,
);
const brain = option('brain', 'evaluated');
// Имя мозга проверяется ЗДЕСЬ, до первого подключения: неизвестное имя иначе
// обнаружилось бы падением потока ботов на дедлайне — то есть матчем, который
// молча не стартовал (BOT-2).
if (!BRAIN_KINDS.includes(brain)) {
  process.stderr.write(`неизвестный мозг "${brain}"; известные: ${BRAIN_KINDS.join(', ')}\n`);
  process.exit(2);
}
/**
 * Числовой параметр запуска. Проверяется, а не берётся `Number`'ом молча:
 * `--max-ticks abc` даёт `NaN`, а сравнение `tick >= NaN` ложно всегда — то есть
 * отладочный прогон, обязанный завершаться САМ (CLI-11), не завершился бы
 * никогда и висел бы до Ctrl+C, которого у него нет.
 */
function numberOption(name, fallback) {
  const raw = option(name, fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    process.stderr.write(`--${name}: ожидалось неотрицательное число, получено "${raw}"\n`);
    process.exit(2);
  }
  return value;
}

const port = numberOption('port', 8080);
/**
 * Отладочный прогон (CLI-11): боты садятся немедленно, матч ограничен по тикам,
 * артефакты ложатся в каталог. `--once` он подразумевает — прогон для разбора
 * ровно один, и авто-рестарт переписал бы его артефакты следующим матчем.
 */
const debugRun = flag('debug');
/**
 * Политики этого запуска (BOT-7, BOT-14, NTR-6): дедлайн бота-заполнителя, что
 * делать со слотом без соединения, пауза до заместителя и окно возврата.
 * Умолчание окна — поле документа матча: величина остаётся данными, флаг лишь
 * перекрывает её.
 */
let policy;
try {
  policy = standPolicy({
    text: option,
    number: numberOption,
    debug: debugRun,
    silenceSeconds: match.silenceSeconds ?? 10,
    // Умолчание `--on-disconnect` берётся у документа матча (NTR-20, D6): что
    // делать при отвязке владельца — правило паузы, а правила паузы — данные.
    ...(match.pause?.onOwnerDetach !== undefined
      ? { onOwnerDetach: match.pause.onOwnerDetach }
      : {}),
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const botFillMs = policy.botFillMs;
/** Ограничение длительности отладочного матча: десять секунд при 60 Гц. */
const maxTicks = numberOption('max-ticks', 600);
const outDir = option('out-dir', fromRepo('runs/latest'));
const dictPath = option('dict', fromRepo('game/demo-ts/app/journal/duel.dictionary.json'));
// Каталог заводится ДО матча: писателю трейса открывать файл в несуществующем
// каталоге нечем, а узнать об этом в конце прогона — значит потерять прогон.
if (debugRun) mkdirSync(outDir, { recursive: true });
// Полный уровень — умолчание отладочного прогона: события едут только на нём
// (DIAG-3), а без событий журнал боя пуст. Цена — объём (шапка `bin/trace.mjs`);
// длинному прогону отвечает `--trace-select=event`.
const traceFlags = traceOptions(debugRun ? { level: 'full', out: join(outDir, 'trace.jsonl') } : {});
const tracing = openMatchTrace(traceFlags);
// Запись матча кладёт рядом с трейсом только отладочный прогон: вне его стенд
// играет матч за матчем, и записи ни одного из них не остаётся. Трейс без
// записи невоспроизводим (DIAG-9), и прогон обязан назвать причину вслух
// (CLI-11) — тем же текстом, каким называет её `serve.mjs`: одно и то же
// положение дел не должно читаться в двух стендах как два разных.
if (tracing !== undefined && !debugRun) {
  process.stdout.write(`${TRACE_WITHOUT_RECORD}          добавьте --debug — он кладёт запись рядом\n`);
}
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
    // Окно возврата (NTR-6, NTR-17) — величина документа матча, перекрываемая
    // флагом запуска: тюнить её можно без правки кода, а стенд, поднятый на
    // время отладки, вправе сократить её одной командой.
    silenceTicks: policy.silenceSeconds * tickRate,
    // Диагностика запроса перемотки — в отчёт стенда, то есть в stdout: её
    // умолчание пишет в stderr, а туда же по умолчанию идёт трейс, и мешать их
    // в одном потоке нельзя (CLI-11).
    rewindWarn: (message) => process.stdout.write(`\n${message}\n`),
    // Подключение sink'а ход матча не меняет (DIAG-8): отладочный матч — тот же
    // матч, и в запись (`toScenario`) это поле не входит (CLI-11).
    ...(tracing !== undefined ? { trace: tracing.trace } : {}),
  };
}

// ------------------------------------------------- слушающая сторона стенда

const sockets = webSocketTransportServer({ port });

// ------------------------------------------------- control-адаптер агента
//
// Поднимается ТОЛЬКО по флагу (решение D2): без него стенд остаётся ровно тем,
// чем был, — ни отчёта, ни замера задержки цикла событий, ни подписки на stdin.

/**
 * Задержка цикла событий процесса (решение D9). Мониторится встроенным
 * гистограммой `perf_hooks` — тем же прибором, каким её мерит Node сам, — и
 * сбрасывается на каждом отчёте: величина за интервал отвечает на «сервер
 * тормозит ПРЯМО СЕЙЧАС», а величина за всё время жизни процесса — нет.
 */
let loopDelay = null;
/** Стоп по команде агента: авто-рестарт после него не поднимает следующий матч. */
let stopRequested = false;
/**
 * Слоты, запертые админом (NTR-19). Живут ДОЛЬШЕ круга: `MatchServer` строится
 * заново на каждый матч (D3), а запрет отменяет только человек (SRV-5).
 */
const barredSlots = new Set();
const control = flag('control-adapter')
  ? standControl({
      write: (text) => process.stdout.write(text),
      process: () => {
        const mean = loopDelay === null ? 0 : loopDelay.mean / 1e6;
        loopDelay?.reset();
        return {
          eventLoopDelayMs: Number.isFinite(mean) ? mean : 0,
          rssBytes: process.memoryUsage.rss(),
        };
      },
    })
  : null;
if (control !== null) {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  // Команды приходят линиями: буфер собирается здесь, потому что stdin —
  // поток байтов, а не строк, и команда вправе приехать двумя кусками.
  let pending = '';
  process.stdin.setEncoding('utf8');
  // Команда набора — десятки байтов; всё, что длиннее без перевода строки, не
  // команда. Потолок нужен потому, что растущая строка кончается не отказом, а
  // `RangeError` внутри обработчика `data` — то есть смертью стенда посреди матча.
  const COMMAND_LINE_LIMIT = 64 * 1024;
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const edge = pending.indexOf('\n');
      if (edge < 0) break;
      const line = pending.slice(0, edge);
      pending = pending.slice(edge + 1);
      if (line.trim() !== '') control.handle(line);
    }
    if (pending.length > COMMAND_LINE_LIMIT) {
      pending = '';
      process.stdout.write('\nстенд: команда без перевода строки длиннее предела — буфер сброшен\n');
    }
  });
  control.ready({
    port,
    players: match.players,
    buildId: match.buildId,
    contentPackHash: pack.hash,
  });
}
/**
 * Слушающая сторона между матчами (`app/standSession.ts`): очередь окна
 * рестарта, претенденты на слоты и «сессионный вид» для одного матча. Байты,
 * пришедшие в окно рестарта, она копит и отдаёт следующему матчу — `Hello`
 * клиент шлёт ровно один раз, и потерянный означал бы «сервер не ответил».
 */
const listening = standSession();
sockets.onConnection((raw) => { listening.accept(raw); });

// ------------------------------------------------------------------- матчи

process.stdout.write(
  `стенд демо-арены "${match.name}" на ws://127.0.0.1:${port}\n` +
    `  версия: ${match.buildId} + ${pack.hash}\n` +
    `  слоты: ${match.players.join(', ')}\n` +
    `  темп: ${tickRate} Гц, формат: ${serializer.name}\n` +
    `  бот-заполнитель: мозг "${brain}", профиль "${profile.name}", ` +
    `дедлайн ${botFillMs} мс после первого претендента на слот\n` +
    `  разрыв в бою: ${
      policy.onDisconnect === 'bot'
        ? `бот-заместитель через ${policy.substituteDelayMs} мс`
        : policy.onDisconnect === 'pause'
          ? 'пауза матча до возврата владельца'
          : 'ничего — слот ждёт владельца'
    }, окно возврата ${policy.silenceSeconds} с\n` +
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
  // Команда `stop` агента (SRV-2) — тот же случай: следующий матч поднимать
  // некому и незачем.
  if (flag('once') || debugRun || stopRequested) break;
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
  listening.onClaimant(() => {});
  listening.onClaimantsGone(() => {});

  const server = new MatchServer(matchConfig());
  const connections = new PortConnections();
  const host = new MatchHost(server, mergeTransportServers(listening.sessionServer, connections), { serializer });

  let botWorker = null;
  let failure = null;
  /** Сворачивание матча: остановка потока ботов — не его падение. */
  let stopping = false;
  /**
   * Отказ стенда: называется громко и один раз — и в тот же поток, что и
   * остальной отчёт запускалки. В stdout, а не в stderr, потому что stderr —
   * умолчание вывода трейса (`bin/trace.mjs`), а трейс и собственный отчёт
   * запускалки MUST NOT идти одним потоком (CLI-11): артефакт со строками
   * постороннего происхождения разбирается человеком, а не программой.
   */
  const fail = (message) => {
    if (failure !== null) return;
    failure = message;
    process.stdout.write(`\nстенд: ${message}\n`);
  };

  /**
   * Поток ботов этого матча — ОДИН на матч и на обе политики: заполнитель
   * (BOT-7) и заместитель (BOT-14) сажают ботов в него же. Второй поток на
   * заместителя ничего бы не дал: граница честности проходит по клиенту и его
   * фильтру, а не по потоку (BOT-3, BOT-4).
   */
  const ensureBotWorker = () => {
    if (botWorker !== null) return botWorker;
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
      // Отказ заместителю (слот успел занять владелец — `slot-taken`) отказом
      // стенда не является: матч в этот момент идёт, а не стоит в лобби. Что
      // делает с этим диагнозом запертый слот (NTR-19) и почему судить о нём по
      // отказу `slot-barred` НЕЛЬЗЯ — `app/barredSlots.ts`.
      if (
        seatingIsStandFailure({
          taken: taken.length,
          rejections: report.seats.map((seat) => (seat.rejected === null ? '' : String(seat.rejected))),
          lobby: server.phase === 'lobby',
          barred: match.players.some((_, slot) => server.slotBarredAt(slot)),
        })
      ) {
        fail(
          'бот не занял ни одного слота, а матч всё ещё в лобби — ' +
            'проверьте формат кадра (--json), версию сборки и контент-пак (NTR-5)',
        );
      }
    });
    return botWorker;
  };

  /**
   * Посадка ботов одним init-сообщением — общий путь заполнителя и заместителя:
   * различаются они списком мест и ролью соединения (NTR-18), а не сборкой.
   */
  const spawnBots = (seats) => {
    attachBots({
      worker: ensureBotWorker(),
      connections,
      channel: () => new MessageChannel(),
      seats,
      buildId: match.buildId,
      sceneRef: match.sceneRef,
      scene,
      // Тот же формат, которым говорит сервер (SER-3): бот — обычный участник
      // матча, и «свойство сборки» относится к нему наравне с людьми.
      wireFormat,
      // Зависимости сборки мира — общей раскладкой запускалок (NTR-14): бот
      // предсказывает тики (NTR-10) и обязан тикать тем же составом, что сервер.
      ...clientBuildOptions(match),
    });
  };

  /**
   * Политика разрыва (BOT-14): слот, оставшийся без соединения уже в бою,
   * получает бота-заместителя — или не получает ничего. Наблюдение идёт СНАРУЖИ
   * сервера (`slotAttached`, `phase`), как и у заполнителя: сервер о ботах не
   * знает (BOT-1).
   */
  const substitutes =
    policy.onDisconnect === 'bot'
      ? new BotSubstitutes({
          players: match.players,
          attached: (slot) => server.slotAttached(slot),
          // Запертому админом слоту (NTR-19) заместителя не предлагаем — по той
          // же причине, по какой его не предлагает заполнитель и не ждёт
          // `DetachPause`: вход в запертый слот закрыт НЕЗАВИСИМО от заявленной
          // роли, и посаженный бот получил бы `slot-barred`. Плата за отсутствие
          // этой проверки — потерянный бот и строка «сажаю заместителя» о
          // посадке, которой не будет.
          barred: (slot) => server.slotBarredAt(slot),
          running: () => server.phase === 'running',
          // Играть не с кем — заместителя не сажаем: то же условие, по которому
          // заполнитель не заводит бой ботов в пустом матче (BOT-7). Считаются
          // ПРЕТЕНДЕНТЫ слушающей стороны, то есть участники, пришедшие сокетом
          // и не закрывшие его: боты приезжают портами (`PortConnections`) и в
          // это число не входят — иначе матч, покинутый людьми, продлевал бы
          // сам себя своими же заместителями и не кончился бы никогда (NTR-6).
          // Отладочный прогон исключением не является: людей в нём нет по
          // построению, и заместители ему не нужны — боты в нём владельцы.
          abandoned: () => listening.claimants.size === 0,
          delayMs: policy.substituteDelayMs,
          attach: (playerId) => {
            process.stdout.write(`\nслот "${playerId}" без соединения — сажаю заместителя\n`);
            spawnBots([{ playerId, role: 'substitute', brain, profile, behavior }]);
          },
        })
      : null;

  /**
   * Политика разрыва «заморозить матч» (NTR-20, D6): слот без соединения
   * накрывается паузой серверного API, вернувшийся владелец её снимает. Тем же
   * наблюдением снаружи, что и заместитель, и через то же API, которым паузу
   * ставит админ (`server-control` SRV-5).
   */
  const detachPause =
    policy.onDisconnect === 'pause'
      ? new DetachPause({
          players: match.players,
          attached: (slot) => server.slotAttached(slot),
          // Запертого админом владельца (NTR-19) ждать нечего: его `Hello`
          // получает названный отказ, и вернуться он не может. Без этого
          // админ-операция «убрать игрока» замораживала бы весь матч.
          barred: (slot) => server.slotBarredAt(slot),
          running: () => server.phase === 'running',
          state: () => server.pauseState,
          pause: () => server.pauseMatch(),
          resume: () => server.resumeMatch(),
          // Матч, покинутый всеми, не замораживается: заморозка остановила бы и
          // порог молчания (NTR-6), и он не кончился бы никогда.
          abandoned: () => listening.claimants.size === 0,
          report: (message) => process.stdout.write(`\n${message}\n`),
        })
      : null;

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
    frozen: () => server.phase !== 'lobby' || (!debugRun && listening.claimants.size === 0),
    // Слоты предлагаются ВСЕ: какой из них занят человеком, обвязка не знает —
    // сервер владельца слота не называет, и спрашивать его об этом значило бы
    // завести рядом с ним ветвление по типу участника (BOT-1). Занятый слот
    // сервер отвергает штатным `slot-taken`, и бот отпускает канал; кто в итоге
    // сел, приезжает отчётом из потока ботов.
    attach: (playerIds) => {
      // Запертые слоты (NTR-19) из предложения выпадают: вход в них запрещён
      // админом, и предлагать их значило бы гарантировать отказ.
      const offered = playerIds.filter(
        (playerId) => !server.slotBarredAt(match.players.indexOf(playerId)),
      );
      if (offered.length === 0) {
        process.stdout.write('\nдедлайн: свободных незапертых слотов нет — бот не предлагается\n');
        return [];
      }
      spawnBots(offered.map((playerId) => ({ playerId, brain, profile, behavior })));
      process.stdout.write(`\nдедлайн: бот предложен на слоты ${offered.join(', ')}\n`);
      // Места живут в другом потоке — наблюдать их отсюда нечем (BOT-4).
      return [];
    },
  });

  let filler = makeFiller();
  listening.onClaimant(() => { filler.arm(); });
  // Ушёл последний претендент — отсчёт начинать не с кого: неистёкший дедлайн
  // отменяется вместе с заполнителем, а следующий пришедший заведёт свой.
  // Заполнитель однократен по построению (BOT-7: заморозка одна), поэтому
  // «отменить и завести заново» здесь и означает «отложить до людей».
  listening.onClaimantsGone(() => {
    if (filler.filled) return;
    filler.dispose();
    filler = makeFiller();
  });
  // Претенденты, доставшиеся этому матчу из очереди рестарта, дедлайн уже
  // «нажали» — взводим его за них. Отладочный прогон взводит его сам: ждать
  // претендента-человека там некого, и пустой стенд ждал бы вечно.
  if (listening.claimants.size > 0 || debugRun) filler.arm();

  process.stdout.write(`матч #${number}: жду участников на ws://127.0.0.1:${port}\n`);
  host.start();
  // Запреты, поставленные админом раньше (NTR-19), переносятся на новый круг:
  // `MatchServer` у каждого матча свой, а запрет отменяет только человек (SRV-5).
  // Переезд НАЗЫВАЕТСЯ: круг с запертым слотом не стартует вовсе, и молчащий об
  // этом стенд выглядит зависшим (`app/barredSlots.ts`).
  const carried = carryBarredSlots(barredSlots, match.players);
  for (const slot of carried.slots) host.bar(slot);
  if (carried.note !== '') process.stdout.write(carried.note);

  // Матч этого круга глазами агента (решение D2). Всё, что здесь читается, —
  // публичные наблюдения сервера и хоста: аренда слота (NTR-17..NTR-19),
  // счётчики слотов и счётчики хоста (NTR-11). Ни одного захода в мир (OBS-2).
  control?.attach({
    players: match.players,
    round: number,
    phase: () => server.phase,
    tick: () => server.tick,
    pause: () => server.pauseState,
    lease: (slot) => server.slotLease(slot),
    counters: (slot) => server.metrics.slots[slot],
    wire: (slot) => {
      const connection = server.slotLease(slot).connection;
      if (connection === undefined) return undefined;
      const metrics = host.connectionMetrics(connection);
      if (metrics === undefined) return undefined;
      return { snapshotBytes: metrics.snapshotBytes, rtt: metrics.rtt, responseMs: metrics.responseMs };
    },
    metrics: () => {
      const summary = host.report();
      return {
        tickP99Ms: summary.tick.p99Ms,
        tickMeanMs: summary.tick.meanMs,
        broadcastP99Ms: summary.broadcast.p99Ms,
        snapshotsSent: server.metrics.snapshotsSent,
        bytesSent: server.metrics.bytesSent,
      };
    },
    // Админ-операции (SRV-5) — существующими механизмами сервера матча, без
    // единого нового сообщения в игровом протоколе (NTR-4). Исходящие уезжают
    // рассылкой хоста: сам сервер ввода-вывода не делает (NTR-3).
    disconnect: (slot) => {
      const lease = server.slotLease(slot);
      const connection = lease.connection;
      if (connection === undefined) return 'у слота нет живого соединения';
      // Операция адресована ВЛАДЕЛЬЦУ (SRV-5). Слот, который ведёт заместитель
      // (NTR-18), она бы порвала впустую: политика стенда посадит нового через
      // `substituteDelayMs`, и админу отчитались бы успехом об отменённом
      // действии. Названный отказ честнее.
      if (lease.role === 'substitute') {
        return 'слот ведёт заместитель, а не владелец: отвязывать нечего (NTR-18)';
      }
      // Отвязка идёт ЧЕРЕЗ ХОСТ: канал принадлежит ему (NTR-3), и рвать его
      // обязан он — иначе клиент считал бы себя в матче, а сервер молча
      // отбрасывал бы его ввод. Дальше действует штатный реконнект (NTR-17).
      return host.detach(connection) ? '' : 'соединение уже закрыто';
    },
    bar: (slot) => {
      host.bar(slot);
      // Запрет ПЕРЕЖИВАЕТ авто-рестарт круга. Он живёт в `MatchServer`, а тот
      // строится заново на каждый круг (D3 стенда): без этой памяти запрет
      // тихо истекал бы сменой матча, и убранный игрок возвращался бы сам — а
      // админу об этом никто бы не сказал. Снимает его только `unbar` (SRV-5).
      barredSlots.add(slot);
      return '';
    },
    unbar: (slot) => {
      host.unbar(slot);
      barredSlots.delete(slot);
      return '';
    },
    freeze: () => server.pauseMatch() ?? '',
    unfreeze: () => server.resumeMatch() ?? '',
    stop: () => {
      stopRequested = true;
      server.stop();
      host.flush();
      return '';
    },

  });

  // Отчёт стенда — ЛИБО человеку, либо агенту, но не оба сразу: прогресс-строка
  // пишется без перевода строки (`\r`), и управляющая линия, приклеенная к её
  // хвосту, перестала бы читаться агентом как линия (риск дизайна «лог и
  // управляющие сообщения не смешиваются без маркировки»).
  const report = setInterval(() => {
    if (control !== null) {
      control.report();
      return;
    }
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
      // Взгляд политики разрыва (BOT-14): слоты без живого соединения взводят
      // паузу до посадки заместителя, вернувшийся владелец её отменяет.
      // Опросом, потому что о разрывах сервер наружу не сообщает и не должен
      // (NTR-3): расписание держит тот, кто им владеет.
      substitutes?.poll();
      // Взгляд политики «разрыв замораживает матч» (NTR-20): тем же опросом и
      // по той же причине — о разрывах сервер наружу не сообщает.
      detachPause?.poll();
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
  // Матч свернулся: отчитываться до следующего `attach` не о чем, а команды
  // получают названный отказ «матча нет» вместо действия над мертвецом.
  control?.detach();
  listening.onClaimant(() => {});
  listening.onClaimantsGone(() => {});
  filler.dispose();
  // Неистёкшая пауза заместителя отменяется вместе с матчем: бот, приехавший в
  // уже свёрнутый матч, получил бы отказ и оставил бы за собой лишний канал.
  substitutes?.dispose();
  detachPause?.dispose();
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
 *
 * Каждый шаг огорожен своим `try`, а сводка пишется ПОСЛЕДНЕЙ и несёт причины
 * не сложившегося: сорвавшийся шаг иначе унёс бы с собой весь набор — в том
 * числе `run.json`, единственный артефакт, который называет, что пошло не так.
 * Пустой каталог вместо разбора боя — самый дорогой исход отладочного прогона.
 */
function saveArtifacts(server, failure) {
  // Трейс закрывается ДО чтения: журнал собирается по файлу, и недописанный
  // хвост буфера стал бы усечённой строкой на ровном месте. Наружу закрытие не
  // бросает (`bin/trace.mjs`) — отказ сброса хвоста приезжает полем `failure`.
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

  // Путь берётся у РАЗОБРАННЫХ флагов, а не собирается вторым выражением:
  // `--trace-out` мог увести трейс из каталога прогона, и журнал собирался бы
  // тогда по файлу, которого нет.
  const tracePath = traceFlags.out;
  if (tracing !== undefined && tracePath !== undefined) {
    summary.trace = {
      path: relative(outDir, tracePath),
      // Отказ записи гасит трейс, а не матч (DIAG-8), и называется он ЗДЕСЬ:
      // молча оборванный трейс выглядит поводом к расследованию, которого не
      // получится. Поле одно на обе половины отказа — съём и сброс хвоста.
      ...(tracing.failure !== undefined ? { failure: tracing.failure } : {}),
    };
  }

  /**
   * Один шаг набора: сорвался — назван в сводке под своим именем и не унёс
   * остальные. Причину пишем и в поток отчёта запускалки (stdout, отдельный от
   * трейса, CLI-11), чтобы она была видна и без чтения `run.json`.
   */
  const step = (name, body) => {
    try {
      body();
    } catch (error) {
      summary.failed ??= {};
      summary.failed[name] = error.message;
      process.stdout.write(`\nартефакт "${name}" не сложился: ${error.message}\n`);
    }
  };

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

  if (tracing !== undefined && tracePath !== undefined) {
    step('journal', () => {
      // Журнал собирается по ФАЙЛУ (CLI-12). `--trace-out` мог увести трейс в
      // устройство или в канал — читать оттуда «весь трейс» нечем, и назвать
      // это отказом шага честнее, чем упереться в предел строки V8 на середине.
      if (!statSync(tracePath).isFile()) {
        throw new Error(`трейс "${tracePath}" — не обычный файл: журнал собирать не из чего`);
      }
      const result = journalFromFile(tracePath, dictPath);
      writeFileSync(join(outDir, 'journal.jsonl'), journalDocument(result));
      summary.journal = {
        path: 'journal.jsonl',
        facts: result.entries.length,
        // Незнакомый тип — не отказ прогона, а отставший словарь (DIAG-10), и
        // назван он списком, а не молчанием.
        unknownTypes: result.unknownTypes,
        ...(result.malformedLines > 0 ? { malformedLines: result.malformedLines } : {}),
      };
      // Отчёт о журнале — часть отчёта запускалки, и идёт он тем же потоком:
      // сам журнал лежит файлом, а stderr занят умолчанием вывода трейса.
      process.stdout.write(journalReport(result));
    });
  }

  // Сводка — последней и вне `step`: она и есть то место, где названы отказы
  // остальных шагов, и падать ей больше не на чем.
  try {
    writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`\nартефакты прогона: ${outDir}\n`);
  } catch (error) {
    process.stdout.write(`\nсводки прогона не будет: ${error.message}\n`);
  }
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
