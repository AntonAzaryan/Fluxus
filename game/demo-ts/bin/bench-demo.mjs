#!/usr/bin/env node
/**
 * Браузерный бенч демо-арены (`performance-budget` PERF-7, design D6).
 *
 *   npm run bench:demo -- [--profile desktop-dev] [--seconds 20] [--warmup 5]
 *                         [--headless] [--solo] [--json] [--chrome <path>]
 *                         [--drive cliff-jump]
 *
 * Отвечает на один вопрос — «бюджет профиля ещё сходится?» — и отвечает на него
 * НАСТОЯЩИМ рендерером на настоящей сцене: поднимает dev-страницу демо, катает
 * матч против бота N секунд, забирает у probe страницы (`app/benchProbe.ts`)
 * перцентили кадра и стадий (PERF-2) и печатает их против бюджетов профиля
 * (PERF-1) с вердиктом по каждой строке.
 *
 * ## Хвост за p99
 *
 * Вердикт перцентильный, а разовые фризы живут в хвосте ЗА ним: один кадр в
 * 325 мс на двадцатисекундном окне не двигает ни p50, ни p99, и в отчёте из
 * одних перцентилей его нет вовсе. Поэтому рядом с ними печатаются максимум
 * каждой серии, топ худших кадров окна с раскладкой по стадиям и остатком «вне
 * стадий», а в режиме вождения — число ЖИВЫХ шейдерных программ рендерера на
 * границах окна (`render.programs`, «было → стало»): компиляция программы не
 * растит ни одного счётчика стоимости (PERF-3), и другого печатного следа у неё
 * нет. Это размер живого кэша, а не счётчик компиляций, и отчёт печатает границу
 * метода рядом с числом. Там же печатается ЗАНЯТАЯ ПАМЯТЬ на границах окна:
 * куча страницы после принудительной сборки мусора (CDP `HeapProfiler.collectGarbage`
 * плюс `Runtime.getHeapUsage`) и число живых геометрий и текстур рендерера
 * (`render.memory`, тем же наблюдением готового состояния, каким приезжает число
 * программ). Сборка и чтение идут ВНЕ окна замера — до обнуления probe и после
 * отчёта, — чтобы пауза сборщика не попала в перцентили кадра, ради которых
 * замер и затевался. Всё это ДИАГНОСТИКА: вердикт «сходится / не сходится» и
 * код возврата от хвоста и от памяти не зависят (PERF-7).
 *
 * В ГЕЙТ НЕ ВХОДИТ и входить не может (PERF-7): нужен браузер, а числа шумят от
 * машины к машине. Это диагностика по запросу, как `npm run coverage`; от
 * расползания стоимости между такими сверками страхуют детерминированные
 * счётчики и их голден-гейт (PERF-3, PERF-4). Поэтому и код возврата 0 при
 * ЛЮБОМ вердикте: ненулевым он бывает только когда замера не случилось вовсе —
 * не нашёлся браузер, не поднялась страница, матч не пошёл, вождение не дошло
 * до героя.
 *
 * ## Вождение героя (`--drive`)
 *
 * По умолчанию бенч меряет СТОЯЩЕГО героя: ввод не подаёт никто, и целые куски
 * работы кадра в такой замер не попадают вовсе. Маска тумана — первый из них:
 * подсистема сверяет сигнатуру наблюдателей и, пока герой стоит, не платит за
 * туман ничего (`render-ts/src/subsystems/fog.ts`, design D4 тумана). Замер
 * стоящего героя поэтому честен ровно наполовину: он не воспроизводит ни
 * пересборку маски, ни заикание на смене уровня под прыжком с уступа.
 *
 * `--drive <сценарий>` подаёт странице ввод по расписанию — теми же событиями
 * клавиатуры, какие приходят от человека: `Input.dispatchKeyEvent` поверх УЖЕ
 * поднятой сессии CDP, а страница слушает `e.code` на `window`
 * (`KeyboardMouseSource.bind`, INP-1). Второго канала управления, обходящего
 * слой ввода, здесь не заводится намеренно: замер обязан гонять тот же путь,
 * которым идёт игрок.
 *
 * Вождение страхует себя от ложной зелени: после окна бенч читает пробу тумана
 * отладочной ручкой страницы (`__renderDebug`, `render-debug` RDBG-7) и требует,
 * чтобы перестройки маски за окно ПРОДВИНУЛИСЬ. Не продвинулись — ввод до героя
 * не дошёл, мерились те же стоящие кадры, и это отказ ЗАМЕРА (код возврата 1), а
 * не вердикт бюджета.
 *
 * Браузером правит CDP поверх встроенного в Node `WebSocket` — своей
 * зависимости бенч не заводит. Playwright дал бы ту же пару «запустить и
 * выполнить в странице» ценой пакета в гейте установки, а всё, что нужно
 * здесь, — это `Target.createTarget`, `Page.navigate` и `Runtime.evaluate`.
 * Скачиванием браузеров бенч не занимается тем более: исполняемый файл
 * ищется среди уже установленных (см. `chromeExecutable`).
 *
 * Стенд отдельным процессом не поднимается (`DEMO_STAND=off`): дефолтный режим
 * страницы — матч против бота ВНУТРИ вкладки (`serverWorker.ts`, SES-1
 * `local`), и это ровно та нагрузка, которую бенч меряет. Выделенный стенд
 * добавил бы второй процесс, ничего не добавив к замеру.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Хук резолва: `bench/profile.ts` импортирует `../app/benchProbe.js`, а рядом
// лежит `.ts` — типы Node стрипает сам (>=22.18), хук добавляет остальное. Тот
// же приём, что у `core-ts/bin/sim.mjs`; регистрация обязана случиться ДО
// динамического импорта ниже, поэтому импорт статический, а импорт профиля — нет.
import '@fluxus/net/bin/tsHook.mjs';
import { flag, option } from '@fluxus/net/bin/matchFile.mjs';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const PROFILES = join(PACKAGE, 'bench', 'profiles');
const VITE_CONFIG = join(PACKAGE, 'app', 'vite.config.ts');

// ------------------------------------------------------------------ вождение

/**
 * `KeyboardEvent.code` → то, чем ту же клавишу называет CDP. Страница читает
 * только `e.code` (`KeyboardMouseSource.bind`), но событие без виртуального кода
 * — это событие, которого браузер сам никогда не порождает, и полагаться на его
 * обработку теми же путями нельзя. Набор ЗАКРЫТ: незнакомый код в макросе —
 * опечатка, и падать она обязана до запуска браузера, а не молча не нажиматься.
 */
const DRIVE_KEYS = {
  KeyW: { key: 'w', virtualKey: 87 },
  KeyA: { key: 'a', virtualKey: 65 },
  KeyS: { key: 's', virtualKey: 83 },
  KeyD: { key: 'd', virtualKey: 68 },
  Space: { key: ' ', virtualKey: 32 },
};

/** Длительность короткого нажатия действия, мс: фронт страница берёт с `keydown` (INP-2). */
const DRIVE_TAP_MS = 80;

/**
 * Макросы вождения — ДАННЫЕ, а не ветки кода: расписание правится замером так
 * же, как правятся числа профиля устройства (PERF-1), и новый сюжет нагрузки
 * добавляется строкой, а не функцией.
 *
 * Формат один: `hold` называет удерживаемые клавиши движения ЦЕЛИКОМ (что не
 * названо — отпускается), `tap` — короткое нажатие действия. Расписание крутится
 * по кругу с периодом `loopMs` до конца окна замера, поэтому длина окна
 * (`--seconds`) макрос не переписывает.
 */
const DRIVE_SCRIPTS = {
  'cliff-jump': {
    title: 'подъём на площадку rise-1 и сход с неё',
    /**
     * Герой дуэли стартует в (8.5, 24.5), ближайшая площадка rise-1 занимает
     * клетки x 11–18 × y 11–18 (`content/scenes/duel.scene.json`; экранный верх
     * — мировой север, +y). Пара «KeyS+KeyD» ведёт по диагонали к её уступу;
     * `cliffRise` героя равен нулю, то есть подъём на уровень берётся только
     * прыжком — отсюда нажатия Space раз в секунду. Обратная пара уводит с
     * площадки вниз. Каждый переход уровня разом открывает и закрывает обзор,
     * то есть перестраивает маску тумана.
     */
    loopMs: 5000,
    events: [
      { atMs: 0, hold: ['KeyS', 'KeyD'] },
      { atMs: 1000, tap: 'Space' },
      { atMs: 2000, tap: 'Space' },
      { atMs: 2500, hold: ['KeyW', 'KeyA'] },
      { atMs: 3000, tap: 'Space' },
      { atMs: 4000, tap: 'Space' },
    ],
  },
};

const DRIVE_NAMES = Object.keys(DRIVE_SCRIPTS);

if (flag('help')) {
  process.stdout.write(
    'usage: node game/demo-ts/bin/bench-demo.mjs [--profile desktop-dev] [--seconds 20]\n' +
      '       [--warmup 5] [--headless] [--solo] [--json] [--chrome <path>] [--port 5174]\n' +
      '       [--ready-timeout 90] [--cdp-timeout 10] [--drive <сценарий>]\n' +
      '\n' +
      '  --drive <сценарий>  вести героя по расписанию во время замера; без флага\n' +
      '                      герой СТОИТ, и маска тумана не перестраивается ни разу.\n' +
      '                      После окна бенч требует, чтобы перестройки маски\n' +
      '                      продвинулись, — иначе замер считается не состоявшимся.\n' +
      `                      сценарии: ${DRIVE_NAMES.map((name) => `${name} — ${DRIVE_SCRIPTS[name].title}`).join('; ')}\n`,
  );
  process.exit(0);
}

const profileArg = option('profile', 'desktop-dev');
const seconds = Number(option('seconds', '20'));
const warmupSeconds = Number(option('warmup', '5'));
const readyTimeoutMs = Number(option('ready-timeout', '90')) * 1000;
/**
 * Потолок ожидания ОДНОГО ответа CDP. Молчащий браузер — не редкость (упал
 * рендерер, застряла вкладка), и без потолка прогон висел бы на нём вечно:
 * ждать нечего, а `finally` с уборкой временного профиля так и не наступит.
 * Десять секунд, а не пара: под софтверным GL главный поток страницы умеет
 * встать на компиляции шейдеров, и обрывать по этому поводу замер было бы
 * отказом бенча, а не среды.
 */
const cdpTimeoutMs = Number(option('cdp-timeout', '10')) * 1000;
const headless = flag('headless');
const port = Number(option('port', '5174'));

if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(warmupSeconds) || warmupSeconds < 0) {
  process.stderr.write('бенч: --seconds должен быть положительным, --warmup — неотрицательным\n');
  process.exit(2);
}
if (!Number.isFinite(cdpTimeoutMs) || cdpTimeoutMs <= 0) {
  process.stderr.write('бенч: --cdp-timeout должен быть положительным числом секунд\n');
  process.exit(2);
}

// Имя сценария вождения обязательно: голый `--drive` — это команда, которая
// молча сделала бы не то, что в ней написано (замер стоящего героя).
const driveName = option('drive', undefined);
if (driveName === undefined && flag('drive')) {
  process.stderr.write(`бенч: у --drive обязательно имя сценария: ${DRIVE_NAMES.join(', ')}\n`);
  process.exit(2);
}
if (driveName !== undefined && DRIVE_SCRIPTS[driveName] === undefined) {
  process.stderr.write(
    `бенч: сценарий вождения "${driveName}" не знаком; известны: ${DRIVE_NAMES.join(', ')}\n`,
  );
  process.exit(2);
}
const driveScript = driveName === undefined ? null : DRIVE_SCRIPTS[driveName];
if (driveScript !== null) {
  for (const event of driveScript.events) {
    for (const code of event.hold ?? []) {
      if (DRIVE_KEYS[code] === undefined) {
        process.stderr.write(`бенч: сценарий "${driveName}" удерживает незнакомую клавишу "${code}"\n`);
        process.exit(2);
      }
    }
    if (event.tap !== undefined && DRIVE_KEYS[event.tap] === undefined) {
      process.stderr.write(`бенч: сценарий "${driveName}" нажимает незнакомую клавишу "${event.tap}"\n`);
      process.exit(2);
    }
  }
}

// ------------------------------------------------------------------ профиль

const profilePath =
  profileArg.endsWith('.json') || profileArg.includes('/')
    ? resolve(process.cwd(), profileArg)
    : join(PROFILES, `${profileArg}.json`);

const { validateBenchProfile, benchVerdict, benchLineFits, benchPaceFits } =
  await import('../bench/profile.ts');
const { BENCH_GLOBAL_KEY, BENCH_PROBE_VERSION, BENCH_STAGES } = await import('../app/benchProbe.ts');

let profile;
try {
  const checked = validateBenchProfile(JSON.parse(readFileSync(profilePath, 'utf8')), profileArg);
  if (!checked.ok) {
    process.stderr.write(`бенч: профиль не принят\n  ${checked.errors.join('\n  ')}\n`);
    process.exit(2);
  }
  profile = checked.profile;
} catch (error) {
  process.stderr.write(`бенч: профиль "${profilePath}" не прочитан: ${error.message}\n`);
  process.exit(2);
}

// ------------------------------------------------------------------ браузер

/** Кандидаты канала `chrome`: то, что ставят люди, а не бенч. */
const CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Имена в PATH — последний шанс канала `chrome` до отказа. */
const CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * Где внутри `chromium-<ревизия>/` лежит сам исполняемый файл — стоковая
 * раскладка загрузчика Playwright. Список короткий намеренно: бенч ищет то,
 * что уже установлено, а не поддерживает все раскладки всех загрузчиков.
 */
const PLAYWRIGHT_BINARIES = [
  join('chrome-linux', 'chrome'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
];

/** Файл (а не каталог и не оборванная ссылка) — запускать можно только его. */
function isFile(path) {
  try {
    // statSync идёт по символическим ссылкам: `<корень>/chromium` нередко и
    // есть ссылка на настоящий файл внутри `chromium-<ревизия>/`.
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Chromium в корне браузеров Playwright. Проверок две, и обе нужны:
 *
 * - `<корень>/chromium` — раскладка, собранная ссылкой (так устроены образы
 *   контейнеров). Именно ФАЙЛ: каталогом с таким же именем этот путь бывает
 *   тоже, и запускать его нечем;
 * - `<корень>/chromium-<ревизия>/chrome-linux/chrome` (на macOS —
 *   `chrome-mac/Chromium.app/Contents/MacOS/Chromium`) — стоковая раскладка
 *   загрузчика, то есть то, что лежит у человека после `npx playwright install`.
 *
 * Ревизии перебираются от свежей к старой: последняя установленная — та,
 * которой человек и пользуется.
 */
function playwrightChromium(root) {
  const direct = join(root, 'chromium');
  if (isFile(direct)) return direct;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const revisions = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
    .map((entry) => ({ name: entry.name, revision: Number(entry.name.slice('chromium-'.length)) }))
    .sort((a, b) => (b.revision || 0) - (a.revision || 0));
  for (const { name } of revisions) {
    for (const relative of PLAYWRIGHT_BINARIES) {
      const path = join(root, name, relative);
      if (isFile(path)) return path;
    }
  }
  return null;
}

/**
 * Исполняемый файл браузера. Порядок намеренный: явное указание человека →
 * браузеры Playwright, если окружение их уже поставило → канал `chrome`
 * системы. Скачивать бенч не умеет и не должен: установка браузера — дело
 * машины, а не шага замера.
 */
function chromeExecutable() {
  const explicit = option('chrome', undefined);
  if (explicit !== undefined) {
    const path = resolve(process.cwd(), explicit);
    return existsSync(path) ? { path, source: '--chrome' } : null;
  }
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers !== undefined && browsers !== '') {
    const path = playwrightChromium(browsers);
    if (path !== null) return { path, source: 'PLAYWRIGHT_BROWSERS_PATH' };
  }
  for (const path of CHROME_CANDIDATES) {
    if (existsSync(path)) return { path, source: 'канал chrome' };
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of CHROME_NAMES) {
      const path = join(dir, name);
      if (existsSync(path)) return { path, source: 'канал chrome (PATH)' };
    }
  }
  return null;
}

const browser = chromeExecutable();
if (browser === null) {
  process.stderr.write(
    'бенч: браузер не найден — замерять нечем.\n' +
      '  Поставьте Google Chrome (или Chromium) в систему либо укажите путь: --chrome <файл>.\n' +
      '  Если в окружении уже стоят браузеры Playwright, укажите их корень переменной\n' +
      '  PLAYWRIGHT_BROWSERS_PATH — бенч возьмёт оттуда chromium. Сам он ничего не скачивает.\n',
  );
  process.exit(2);
}

/** Аргументы запуска браузера: отладочный порт, чистый профиль, без троттлинга фона. */
function browserArgs(userDataDir) {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1280,800',
    // Троттлинг фоновой вкладки убил бы замер: rAF в ней идёт раз в секунду.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (headless) {
    // Софтверный GL: без GPU WebGL иначе не поднимется вовсе. Числа стадии
    // `draw` при этом — про отсутствие GPU, а не про движок (см. описание
    // профиля); стадии главного потока остаются осмысленными.
    args.push('--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars');
  }
  // Песочница Chromium под root не поднимается; в контейнерах бенч гоняют
  // именно так, и отказ здесь выглядел бы отказом бенча, а не среды.
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  return args;
}

/** Адрес CDP из stderr браузера: другого способа узнать выбранный порт нет. */
function devtoolsEndpoint(child, timeoutMs) {
  return new Promise((done, failed) => {
    let buffer = '';
    const timer = setTimeout(() => {
      failed(new Error(`браузер не сообщил адрес CDP за ${timeoutMs} мс:\n${buffer}`));
    }, timeoutMs);
    // Отказ ЗАПУСКА (файла нет, права не те) приходит событием `error`, а не
    // кодом выхода, и без подписки на него он был бы необработанным событием
    // процесса: прогон падал бы мимо `catch`, а с ним — мимо уборки временного
    // профиля в `finally`.
    child.once('error', (error) => {
      clearTimeout(timer);
      failed(new Error(`браузер "${browser.path}" не запустился: ${error.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      failed(new Error(`браузер завершился с кодом ${code}:\n${buffer}`));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match === null) return;
      clearTimeout(timer);
      done(match[1]);
    });
  });
}

// ---------------------------------------------------------------------- CDP

/**
 * Минимальный клиент CDP: запрос-ответ по id и сбор ошибок страницы.
 * Событий читается ровно два вида — исключение и `console.error`: если probe
 * так и не появился, причина почти всегда в них, и молчать о ней нельзя.
 *
 * Ни один запрос не ждёт ответа вечно: у каждого свой потолок времени, а
 * закрытие сокета отвергает ВСЕ незакрытые разом. Иначе ушедший браузер
 * оставлял бы бенч висеть на промисе, которому уже некому ответить, — а вместе
 * с ним и уборку временного профиля.
 */
async function cdpConnect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const pageErrors = [];
  let nextId = 0;
  let closed = false;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        pageErrors.push(details.exception?.description ?? details.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        pageErrors.push(
          message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '),
        );
      }
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.failed(new Error(`CDP: ${message.error.message}`));
    else entry.done(message.result);
  });

  socket.addEventListener(
    'close',
    () => {
      closed = true;
      const gone = new Error('CDP: соединение с браузером закрылось — ответа не будет');
      for (const entry of pending.values()) entry.failed(gone);
      pending.clear();
    },
    { once: true },
  );

  await new Promise((done, failed) => {
    socket.addEventListener('open', () => { done(); }, { once: true });
    socket.addEventListener('error', () => { failed(new Error('CDP: соединение с браузером не открылось')); }, { once: true });
  });

  const send = (method, params = {}, sessionId, timeoutMs = cdpTimeoutMs) =>
    new Promise((done, failed) => {
      if (closed) {
        failed(new Error(`CDP: соединение закрыто — "${method}" отправлять некуда`));
        return;
      }
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        failed(new Error(`CDP: ответа на "${method}" нет ${timeoutMs} мс`));
      }, timeoutMs);
      // Снятие таймера — на обоих исходах запроса разом: и на ответе, и на
      // отказе по закрытию сокета.
      pending.set(id, {
        done: (result) => { clearTimeout(timer); done(result); },
        failed: (error) => { clearTimeout(timer); failed(error); },
      });
      const frame = { id, method, params };
      if (sessionId !== undefined) frame.sessionId = sessionId;
      try {
        socket.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        failed(new Error(`CDP: запрос "${method}" не ушёл: ${error.message}`));
      }
    });

  return { send, pageErrors, close: () => { socket.close(); } };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------ вождение: расписание и проба страницы

/**
 * Ручка отладки страницы (`render-debug` RDBG-7). Имя повторено здесь, а не
 * импортировано из `app/debugPanel.ts`: тот тянет за собой `quality.ts` с
 * вайтовским импортом JSON-пресетов, которого Node не разбирает. Разъехаться
 * этим двум местам молча не даёт сама проверка: разошедшийся формат дампа —
 * это отказ замера с названной причиной (см. `driveFailure`), а не ноль
 * перестроек.
 */
const DEBUG_GLOBAL_KEY = '__renderDebug';

/** Отладочный источник маски видимости: из него читается счётчик перестроек. */
const FOG_SOURCE_ID = 'fog.mask';

/** Источник позы камеры: в режиме follow её фокус едет за героем. */
const CAMERA_SOURCE_ID = 'camera.pose';

/**
 * Источник числа ЖИВЫХ шейдерных программ рендерера (`render.programs`,
 * RDBG-1). Читается ТЕМИ ЖЕ двумя пробами, что счётчик перестроек маски, — до
 * окна и после, вне замера (RDBG-4).
 *
 * Величина — размер живого кэша программ, а не счётчик компиляций: освобождение
 * вынимает запись из того же набора, и компиляция, уравновешенная
 * освобождением, даёт нулевую разность. Отчёт печатает границы окна («было →
 * стало») вместе с оговоркой метода, а не одно приращение, выданное за число
 * компиляций.
 *
 * Отсутствие источника на странице замеру НЕ отказ, в отличие от маски: маской
 * проверяется, что вождение вообще доехало до героя, а число программ — это
 * подсказка к чтению отчёта. Не измерено — отчёт называет ПРИЧИНУ, а не печатает
 * «Δ0»: «мы не смотрели» и «не изменилось» — разные утверждения.
 */
const PROGRAMS_SOURCE_ID = 'render.programs';

/**
 * Источник числа ЖИВЫХ геометрий и текстур рендерера (`render.memory`,
 * RDBG-1). Читается теми же двумя пробами и в тех же точках, что число
 * программ, — до окна и после, вне замера (RDBG-4, PERF-7).
 *
 * Величина — размер живого набора, а не счётчик созданий: создание,
 * уравновешенное освобождением внутри окна, даёт нулевую разность. Отчёт
 * печатает границы окна вместе с оговоркой метода, а не одно приращение,
 * выданное за число созданий.
 */
const MEMORY_SOURCE_ID = 'render.memory';

/**
 * Плоское расписание макроса на всё окно замера: события в миллисекундах ОТ
 * НАЧАЛА окна. Собирается заранее и целиком — так число нажатий в отчёте взято
 * из того же расписания, по которому шло вождение, а не выведено из времени.
 */
function driveSchedule(script, windowMs) {
  const schedule = [];
  for (let base = 0; base < windowMs; base += script.loopMs) {
    for (const event of script.events) {
      const at = base + event.atMs;
      if (at < windowMs) schedule.push({ at, hold: event.hold, tap: event.tap });
    }
  }
  return schedule.sort((a, b) => a.at - b.at);
}

/** Байты мегабайтами — печать, а не проверка: читать их и есть смысл строки. */
function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
}

/** Секция дампа по `id`; null — источника нет либо ручка промолчала. */
function sectionOf(sections, id) {
  const section = sections === null || sections === undefined ? undefined : sections[id];
  return section === undefined || section === null ? null : section;
}

/** Фокус камеры точкой мира; null — камера ещё не собрана (`noData`). */
function focusOf(sections) {
  const camera = sectionOf(sections, CAMERA_SOURCE_ID);
  if (camera === null || typeof camera.focusWorldX !== 'number') return null;
  if (typeof camera.noData === 'string') return null;
  return { x: camera.focusWorldX, y: camera.focusWorldY };
}

/**
 * Число живых шейдерных программ в пробе — вместе с ПРИЧИНОЙ, если числа нет.
 *
 * Причин молчания ЧЕТЫРЕ, и они разные: ручка отладки страницы не отвечает
 * вовсе (тогда о реестре ничего не известно и утверждать про него нечего);
 * источника нет в реестре; источник есть, но рендерер набора живых программ не
 * ведёт (его собственное `noData`); формат секции разошёлся с бенчем. Свести их
 * в один null значило бы печатать «источник не зарегистрирован» там, где он
 * зарегистрирован и честно сказал о себе другое — или где его никто не
 * спрашивал. Поэтому слово источника едет наружу дословно.
 */
function programsProbeOf(sections) {
  if (sections === null || sections === undefined) {
    return {
      count: null,
      reason: `ручка отладки страницы ${DEBUG_GLOBAL_KEY} не отвечает: спросить число программ негде`,
    };
  }
  const section = sectionOf(sections, PROGRAMS_SOURCE_ID);
  if (section === null) {
    return {
      count: null,
      reason: `отладочный источник "${PROGRAMS_SOURCE_ID}" на странице не зарегистрирован`,
    };
  }
  if (typeof section.noData === 'string') return { count: null, reason: section.noData };
  if (typeof section.liveProgramCount !== 'number') {
    return {
      count: null,
      reason: `проба "${PROGRAMS_SOURCE_ID}" не назвала числа живых программ: формат дампа разошёлся с бенчем`,
    };
  }
  return { count: section.liveProgramCount, reason: null };
}

/**
 * Живые геометрии и текстуры в пробе — вместе с ПРИЧИНОЙ, если чисел нет.
 * Причины те же четыре и по тому же основанию, что у числа программ: молчание
 * ручки, отсутствие источника в реестре, собственное `noData` источника
 * (рендерер набора не ведёт) и разошедшийся формат секции.
 */
function memoryProbeOf(sections) {
  if (sections === null || sections === undefined) {
    return {
      geometries: null,
      textures: null,
      reason: `ручка отладки страницы ${DEBUG_GLOBAL_KEY} не отвечает: спросить живой набор негде`,
    };
  }
  const section = sectionOf(sections, MEMORY_SOURCE_ID);
  if (section === null) {
    return {
      geometries: null,
      textures: null,
      reason: `отладочный источник "${MEMORY_SOURCE_ID}" на странице не зарегистрирован`,
    };
  }
  if (typeof section.noData === 'string') {
    return { geometries: null, textures: null, reason: section.noData };
  }
  if (typeof section.liveGeometries !== 'number' || typeof section.liveTextures !== 'number') {
    return {
      geometries: null,
      textures: null,
      reason: `проба "${MEMORY_SOURCE_ID}" не назвала живого набора: формат дампа разошёлся с бенчем`,
    };
  }
  return { geometries: section.liveGeometries, textures: section.liveTextures, reason: null };
}

/**
 * Перестроек маски ЗА ОКНО: счётчик источника накопительный (с создания
 * подсистемы), и окну принадлежит его приращение между двумя пробами.
 */
function rebuildsBetween(before, after) {
  const from = sectionOf(before, FOG_SOURCE_ID);
  const to = sectionOf(after, FOG_SOURCE_ID);
  if (from === null || to === null) return 0;
  if (typeof from.rebuildCount !== 'number' || typeof to.rebuildCount !== 'number') return 0;
  return Math.max(0, to.rebuildCount - from.rebuildCount);
}

/**
 * Чем плох замер с вождением, если он плох, — строкой отказа либо null.
 *
 * Проверка одна и та же на все причины: перестройки маски за окно обязаны
 * ПРОДВИНУТЬСЯ. Маска перестраивается только на смену сигнатуры наблюдателей
 * своей команды (`fog.ts`, design D4 тумана), то есть ровно тогда, когда герой
 * сдвинулся, — а значит нулевой счётчик и есть «ввод до героя не дошёл». Это
 * отказ ЗАМЕРА, а не вердикт бюджета: мерились бы те же стоящие кадры, что и
 * без `--drive`, и зелёный вердикт на них был бы ложным.
 */
function driveFailure(before, after, rebuilds) {
  if (before === null || after === null) {
    return (
      `ручка отладки страницы ${DEBUG_GLOBAL_KEY} не отвечает: проверить, что вождение ` +
      'дошло до героя, нечем — а непроверенный замер с --drive не замер'
    );
  }
  const fog = sectionOf(after, FOG_SOURCE_ID);
  if (fog === null) {
    return `отладочный источник "${FOG_SOURCE_ID}" на странице не зарегистрирован: пересборок маски не видно`;
  }
  if (typeof fog.noData === 'string') {
    return `маска видимости так и не построена (${fog.noData})`;
  }
  if (typeof fog.rebuildCount !== 'number') {
    return `проба "${FOG_SOURCE_ID}" не назвала числа перестроек: формат дампа разошёлся с бенчем`;
  }
  if (rebuilds <= 0) {
    return (
      'вождение не сдвинуло героя: маска тумана не перестроилась за окно НИ РАЗУ — ' +
      'страница не приняла события клавиатуры либо матч не отдал герою управление'
    );
  }
  return null;
}

// ------------------------------------------------------------------- отчёт

/** Число в миллисекундах с фиксированной шириной — колонки обязаны читаться. */
const ms = (value) => `${value.toFixed(2)} мс`;

/**
 * Подписи строк отчёта: ключ probe → то, как стадия зовётся человеку. Подпись
 * `present` называет ровно то, что измерено, — покадровое обновление
 * подсистем: приём доставки (`syncTick`) идёт между кадрами и в стадию не
 * входит (см. сноску отчёта и шапку `app/benchProbe.ts`).
 */
const LINE_LABELS = {
  frame: 'кадр целиком',
  input: 'ввод и прицел',
  camera: 'камера',
  present: 'кадр подсистем',
  draw: 'рисование',
};

/**
 * Заголовки колонок стадий в таблице худших кадров: та же четвёрка PERF-2, что
 * в `LINE_LABELS`, но в ширину колонки. Полные имена стоят выше, в основной
 * таблице, — второго СЛОВАРЯ стадий здесь не заводится, только вторая подпись.
 */
const WORST_COLUMNS = {
  input: 'ввод',
  camera: 'камера',
  present: 'подсистемы',
  draw: 'рисование',
};

/** Вердикт строки словами: что именно не влезло — p50, p99 или оба. */
function verdictOf(line) {
  if (line.budget === null) return '—';
  if (benchLineFits(line)) return 'сходится';
  const over = [];
  if (!line.p50Fits) over.push('p50');
  if (!line.p99Fits) over.push('p99');
  return `не сходится (${over.join(', ')})`;
}

/** Точка в мировых единицах для отчёта; null — источник ничего не сказал. */
function pointOf(place) {
  return place === null ? '—' : `(${place.x.toFixed(1)}, ${place.y.toFixed(1)})`;
}

/**
 * Худшие кадры окна — тот же хвост ЗА p99, что и колонка max (PERF-7).
 *
 * Строка сводит ПЕРИОД кадра (то, что пережил игрок) с работой главного потока
 * ВНУТРИ этого периода и её раскладкой по стадиям. Незакрытый остаток печатается
 * колонкой «вне стадий» и называет работу МЕЖДУ кадрами — приём доставки
 * (`syncTick` идёт вне rAF-колбэка, SHELL-3) и сборку мусора: стадии их не
 * видят вовсе, а приписать их стадии значило бы соврать.
 *
 * Компиляция шейдерной программы, вопреки первому впечатлению, живёт НЕ в этой
 * колонке: драйвер собирает программу на первом рисовании нового материала, то
 * есть ВНУТРИ стадии — так фриз и выглядит («рисование» в сотни миллисекунд).
 * Отложенную часть этой работы драйвер вправе доделать и между кадрами, поэтому
 * искать её стоит в обеих колонках, а не в одной.
 *
 * Остаток бывает и ОТРИЦАТЕЛЬНЫМ, и это не сбой счёта: отметка rAF — это метка
 * кадровой синхронизации, а не момент запуска колбэка, и работа затянувшегося
 * кадра честно переваливает за свой номинальный период в следующий. Клампа
 * поэтому нет: −2 мс говорят «кадр не уложился в свой период», а нуль на этом
 * месте сказал бы «уложился ровно».
 *
 * Печать, не гейт: вердикт и код возврата от этих чисел не зависят.
 */
function printWorstFrames(out, summary) {
  if (summary.worstFrames.length === 0) return;
  out.push('  худшие кадры окна — хвост ЗА p99, тот же, что колонка max (вердикта не меняет):');
  out.push(
    `    ${'в окне, с'.padEnd(11)}${'тик'.padEnd(9)}${'период'.padEnd(10)}${'кадр'.padEnd(10)}` +
      BENCH_STAGES.map((stage) => (WORST_COLUMNS[stage] ?? stage).padEnd(11)).join('') +
      'вне стадий',
  );
  for (const frame of summary.worstFrames) {
    // Тик < 0 — доставок на этом кадре ещё не было: прочерк, а не «тик −1».
    const tick = frame.tick < 0 ? '—' : String(frame.tick);
    out.push(
      `    ${(frame.atMs / 1000).toFixed(2).padEnd(11)}${tick.padEnd(9)}` +
        `${frame.intervalMs.toFixed(2).padEnd(10)}${frame.frameMs.toFixed(2).padEnd(10)}` +
        BENCH_STAGES.map((stage) => frame.stagesMs[stage].toFixed(2).padEnd(11)).join('') +
        (frame.intervalMs - frame.frameMs).toFixed(2),
    );
  }
  out.push(
    '    числа — миллисекунды, «в окне» — секунды от начала замера, «тик» — номер последнего\n' +
      '    доставленного тика на этом кадре (сам бенч трейса не пишет; номер — зацепка для\n' +
      '    отдельного разбора). «Кадр» и стадии — работа главного потока внутри этого периода,\n' +
      '    «вне стадий» — незакрытый остаток: приём доставки (syncTick) и сборка мусора, которых\n' +
      '    стадии не видят вовсе; остаток со знаком минус — работа кадра не уложилась в свой\n' +
      '    период и ушла в следующий. Компиляция шейдерной программы сюда НЕ попадает целиком:\n' +
      '    драйвер собирает её на первом рисовании нового материала, то есть внутри стадии',
  );
  out.push('');
}

function printReport(summary, pageUrl, drive) {
  const lines = benchVerdict(profile, summary);
  const fits = lines.every((line) => benchLineFits(line));
  const out = [];
  out.push(`\nбенч демо-арены (PERF-7): профиль "${profile.name}" (${profile.deviceClass})`);
  out.push(`  ${profile.description}`);
  out.push(`  страница: ${pageUrl}`);
  out.push(`  браузер:  ${browser.path}${headless ? ' (headless, софтверный GL)' : ''}`);
  out.push(
    `  окно:     ${summary.seconds.toFixed(1)} с, кадров ${summary.frames}, ` +
      `${summary.fps.toFixed(1)} fps; тиков доставлено ${summary.ticks.delivered} ` +
      `(${summary.ticks.perSecond.toFixed(1)}/с)`,
  );
  if (summary.dropped > 0) {
    out.push(`  ВНИМАНИЕ: кольцо probe вытеснило ${summary.dropped} кадров — окно длиннее буфера`);
  }
  out.push('');
  // Колонка max — ХВОСТ за p99 (PERF-7): вердикт по ней не выносится, но без
  // неё разовый фриз в сотни миллисекунд не виден из отчёта вовсе — один кадр
  // из тысячи не двигает ни p50, ни p99.
  out.push(
    `  ${'величина'.padEnd(16)}${'p50'.padEnd(12)}${'p99'.padEnd(12)}${'max'.padEnd(12)}` +
      `${'бюджет p50/p99'.padEnd(22)}вердикт`,
  );
  for (const line of lines) {
    const label = LINE_LABELS[line.key] ?? line.key;
    const budget =
      line.budget === null ? '—' : `${line.budget.p50.toFixed(2)} / ${line.budget.p99.toFixed(2)} мс`;
    out.push(
      `  ${label.padEnd(16)}${ms(line.measured.p50).padEnd(12)}${ms(line.measured.p99).padEnd(12)}` +
        `${ms(line.measured.max).padEnd(12)}${budget.padEnd(22)}${verdictOf(line)}`,
    );
  }
  out.push('');
  // Период кадра сверяется с тем же бюджетом `frame`, но это ДРУГАЯ величина:
  // работа главного потока против того, что видит игрок (см. `benchPaceFits`).
  const paceFits = benchPaceFits(profile, summary);
  const frameBudget = profile.budgetsMs.frame;
  out.push(
    `  ${'период кадра'.padEnd(16)}${ms(summary.intervalMs.p50).padEnd(12)}` +
      `${ms(summary.intervalMs.p99).padEnd(12)}${ms(summary.intervalMs.max).padEnd(12)}` +
      `${`${frameBudget.p50.toFixed(2)} / ${frameBudget.p99.toFixed(2)} мс`.padEnd(22)}` +
      `${paceFits ? 'темп держится' : 'темп НЕ держится'}`,
  );
  out.push(
    `  ${'разрыв тика'.padEnd(16)}${ms(summary.ticks.gapMs.p50).padEnd(12)}` +
      `${ms(summary.ticks.gapMs.p99).padEnd(12)}${ms(summary.ticks.gapMs.max).padEnd(12)}` +
      `${'—'.padEnd(22)}каденс доставки`,
  );
  out.push('');
  printWorstFrames(out, summary);
  if (drive !== null) {
    // Что вождение действительно доехало до героя — числами, а не доверием:
    // маска перестраивается ТОЛЬКО когда сдвинулся наблюдатель своей команды
    // (`fog.ts`, кэш сигнатуры), и ненулевой счётчик за окно и есть тот факт.
    out.push(`  вождение: сценарий "${drive.script}" — ${drive.title}`);
    out.push(
      `  нажатий действия за окно: ${drive.taps}; фокус камеры (следование за героем): ` +
        `${pointOf(drive.focusBefore)} → ${pointOf(drive.focusAfter)}`,
    );
    out.push(
      `  перестроек маски тумана (FoW) за окно: ${drive.rebuilds}` +
        `${drive.rebuilds > 0 ? ` (${(drive.rebuilds / Math.max(summary.seconds, 1e-6)).toFixed(1)}/с)` : ''}` +
        `${drive.dissolving ? ', рассеивание не сошлось к концу окна' : ''}`,
    );
    if (drive.rebuilds <= 0) {
      out.push(
        '  ВНИМАНИЕ: маска тумана НЕ перестроилась ни разу — ввод до героя не дошёл,\n' +
          '  мерились те же стоящие кадры, что и без --drive: ЗАМЕР НЕ СОСТОЯЛСЯ',
      );
    }
    out.push(
      '  пересборка маски живёт в ПОКАДРОВОМ обновлении подсистем и нарезана на порции\n' +
        '  под тексельный бюджет (FoW, change `fog-mask-budgeted-rebuild`): её цену видно\n' +
        '  в строке «кадр подсистем», а размазана она по кадрам публикации маски',
    );
    // Компиляция шейдерной программы не растит НИ ОДНОГО счётчика стоимости
    // (PERF-3) и перцентилям кадра не видна — размер живого кэша программ на
    // границах окна и есть весь печатный след этого класса разовых фризов
    // (PERF-7). Печатаются ОБЕ границы, а не одна дельта: дельта без «было →
    // стало» читалась бы как число компиляций, которым она не является.
    if (drive.programsBefore === null || drive.programsAfter === null) {
      out.push(
        `  живых шейдерных программ рендерера: не измерено — ${drive.programsReason}\n` +
          '  (замеру это не отказ: величина — подсказка к чтению, а не проверка)',
      );
    } else {
      const delta = drive.programsAfter - drive.programsBefore;
      out.push(
        `  живых шейдерных программ рендерера: было ${drive.programsBefore} → ` +
          `стало ${drive.programsAfter} (Δ${delta >= 0 ? '+' : ''}${delta} за окно)`,
      );
      // Оговорка метода печатается ВСЕГДА, а не только при ненулевой дельте:
      // ровно нулевая дельта и есть то прочтение, от которого она страхует.
      out.push(
        '  это размер ЖИВОГО кэша программ, а не счётчик компиляций: освобождение вынимает\n' +
          '  запись из того же набора, поэтому компиляция, уравновешенная освобождением внутри\n' +
          '  окна, даёт Δ0 — нулевая дельта НЕ доказывает, что не компилировалось. Растущая от\n' +
          '  окна к окну Δ на устоявшейся игре — сигнатура пересборки с новым ключом кэша на\n' +
          '  каждом появлении; отрицательная Δ — освобождённые за окно программы, а не «минус\n' +
          '  компиляции». Точный счёт компиляций требует инструментализации GL и остаётся\n' +
          '  ручным приёмом разового разбора',
      );
    }
    // Занятая память на границах окна (PERF-7): куча страницы после
    // принудительной сборки и живой набор ресурсов рендерера. Печатаются ОБЕ
    // границы и приращение — как у программ и по той же причине.
    if (drive.heapBefore === null || drive.heapAfter === null) {
      out.push(
        `  куча страницы (после сборки мусора): не измерено — ${drive.heapReason}\n` +
          '  (замеру это не отказ: величина — подсказка к чтению, а не проверка)',
      );
    } else {
      const delta = drive.heapAfter - drive.heapBefore;
      out.push(
        `  куча страницы (после сборки мусора): было ${mib(drive.heapBefore)} → ` +
          `стало ${mib(drive.heapAfter)} (Δ${delta >= 0 ? '+' : '−'}${mib(Math.abs(delta))} за окно)`,
      );
    }
    if (drive.memoryBefore === null || drive.memoryAfter === null) {
      out.push(`  живые геометрии и текстуры рендерера: не измерено — ${drive.memoryReason}`);
    } else {
      const geometries = drive.memoryAfter.geometries - drive.memoryBefore.geometries;
      const textures = drive.memoryAfter.textures - drive.memoryBefore.textures;
      out.push(
        `  живых геометрий рендерера: было ${drive.memoryBefore.geometries} → ` +
          `стало ${drive.memoryAfter.geometries} (Δ${geometries >= 0 ? '+' : ''}${geometries}); ` +
          `текстур: было ${drive.memoryBefore.textures} → стало ${drive.memoryAfter.textures} ` +
          `(Δ${textures >= 0 ? '+' : ''}${textures})`,
      );
    }
    // Оговорка метода — ВСЕГДА, как и у программ: ровно нулевая дельта и есть
    // то прочтение, от которого она страхует.
    out.push(
      '  это размеры ЖИВЫХ наборов на границах окна, а не число созданий за окно: создание,\n' +
        '  уравновешенное освобождением внутри окна, даёт Δ0 — нулевая дельта НЕ доказывает,\n' +
        '  что ресурсы не заводились. Сборка мусора и чтение идут ВНЕ окна замера (до обнуления\n' +
        '  probe и после отчёта), поэтому в перцентили кадра их пауза не попадает. Точный учёт\n' +
        '  живых ресурсов движка и рост кучи в гейте держат PERF-8..10, а не этот замер',
    );
    out.push('');
  }
  // Что именно измерено — частью отчёта, а не знанием читателя: стадии PERF-2
  // покрыты браузерным замером не целиком, и молчать об этом значит выдавать
  // «кадр в бюджете» за «бюджет сходится весь».
  out.push(
    '  измерено напрямую: стадии кадра главного потока — ввод, камера, кадр подсистем,\n' +
      '  рисование; каденс доставки выведен пассивно (строка «разрыв тика»). Приём доставки\n' +
      '  (syncTick) идёт МЕЖДУ кадрами и ни в одну стадию не входит, тик симуляции живёт в\n' +
      '  воркере: их стоимость раскладывают детерминированные счётчики и голден-гейт\n' +
      '  (PERF-3, PERF-4), а не этот замер.',
  );
  out.push('');
  out.push(
    `  работа главного потока: ${fits ? 'в бюджете' : 'вне бюджета'}; ` +
      `темп кадра: ${paceFits ? 'держится' : 'не держится'} ` +
      `(${(1000 / Math.max(summary.intervalMs.p99, 1e-6)).toFixed(1)} fps по p99 периода)`,
  );
  out.push(`  итог: бюджет профиля ${fits && paceFits ? 'СХОДИТСЯ' : 'НЕ СХОДИТСЯ'}`);
  if (headless) {
    out.push(
      '  headless + софтверный GL: стадия «рисование» и период кадра здесь про отсутствие GPU,\n' +
        '  а не про движок — сверять бюджет профиля машины нужно прогоном с настоящим GPU',
    );
  }
  out.push(
    '  (бенч — диагностика, а не гейт: код возврата не зависит от вердикта, PERF-7)\n',
  );
  process.stdout.write(out.join('\n'));
  if (flag('json')) {
    process.stdout.write(`${JSON.stringify({ profile, summary, drive }, null, 2)}\n`);
  }
}

// -------------------------------------------------------------------- прогон

// Стенд отдельным процессом не нужен: матч против бота живёт во вкладке.
process.env.DEMO_STAND = 'off';

let server = null;
let child = null;
let cdp = null;
const userDataDir = mkdtempSync(join(tmpdir(), 'bench-demo-'));

try {
  const { createServer } = await import('vite');
  server = await createServer({
    configFile: VITE_CONFIG,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port, strictPort: false, open: false },
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0];
  if (base === undefined) throw new Error('dev-сервер демо не сообщил адрес страницы');
  const pageUrl = `${base}?bench=1${flag('solo') ? '&solo' : ''}`;

  process.stdout.write(
    `бенч: страница ${pageUrl}\n` +
      `бенч: браузер ${browser.path} (${browser.source})${headless ? ', headless' : ''}\n` +
      `бенч: прогрев ${warmupSeconds} с, замер ${seconds} с\n` +
      (driveScript === null
        ? 'бенч: вождения нет — герой стоит, маска тумана не перестраивается (--drive)\n'
        : `бенч: вождение "${driveName}" — ${driveScript.title}\n`),
  );

  child = spawn(browser.path, browserArgs(userDataDir), { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await devtoolsEndpoint(child, 30000);
  cdp = await cdpConnect(endpoint);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId);

  const evaluate = async (expression) => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails !== undefined) {
      throw new Error(
        `страница: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };

  /**
   * Событие клавиши странице — тем же путём, каким его получает человек: поверх
   * УЖЕ поднятой сессии CDP, без второго канала управления в обход слоя ввода
   * (INP-1). `rawKeyDown`, а не `keyDown`: символьного события у игровой клавиши
   * нет, и порождать его значило бы слать странице то, чего клавиатура не шлёт.
   */
  const dispatchKey = async (type, code) => {
    const key = DRIVE_KEYS[code];
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type,
        code,
        key: key.key,
        windowsVirtualKeyCode: key.virtualKey,
        nativeVirtualKeyCode: key.virtualKey,
      },
      sessionId,
    );
  };

  /**
   * Проба отладочных источников страницы (RDBG-7), не оставляющая их
   * включёнными: источник включается, снимается дамп и источник выключается
   * ОДНИМ синхронным выражением страницы. Ни один кадр с включённым источником
   * при этом не рисуется — чтение не удорожает замер (RDBG-4), — а источник,
   * включённый человеком, остаётся включённым.
   */
  /**
   * Куча страницы после ПРИНУДИТЕЛЬНОЙ полной сборки мусора (PERF-7).
   * Собирается и читается ВНЕ окна замера: пауза сборщика внутри него попала бы
   * в перцентили кадра, ради которых замер и затевался.
   *
   * Отказ CDP замеру не отказ (как и у числа программ): не всякая сборка
   * Chromium даёт эти домены, и отчёт печатает ПРИЧИНУ вместо числа — «мы не
   * смотрели» и «не изменилось» разные утверждения.
   */
  const readPageHeap = async () => {
    try {
      await cdp.send('HeapProfiler.collectGarbage', {}, sessionId);
      const usage = await cdp.send('Runtime.getHeapUsage', {}, sessionId);
      if (typeof usage.usedSize !== 'number') {
        return { bytes: null, reason: 'Runtime.getHeapUsage не назвал размера кучи' };
      }
      return { bytes: usage.usedSize, reason: null };
    } catch (error) {
      return { bytes: null, reason: `сборка мусора и чтение кучи недоступны: ${error.message}` };
    }
  };

  const readDebugSections = () =>
    evaluate(`(() => {
      const debug = globalThis[${JSON.stringify(DEBUG_GLOBAL_KEY)}];
      if (debug === undefined) return null;
      const ids = ${JSON.stringify([FOG_SOURCE_ID, CAMERA_SOURCE_ID, PROGRAMS_SOURCE_ID, MEMORY_SOURCE_ID])};
      const restore = [];
      for (const id of ids) {
        const known = debug.sources().find((source) => source.id === id);
        if (known !== undefined && !known.enabled && debug.setEnabled(id, true)) restore.push(id);
      }
      try {
        const sections = debug.dump().sections;
        const out = {};
        for (const id of ids) out[id] = sections[id] ?? null;
        return out;
      } finally {
        for (const id of restore) debug.setEnabled(id, false);
      }
    })()`);

  /**
   * Вождение героя на всё окно замера: расписание макроса И ЕСТЬ окно —
   * отдельного `sleep` на замер при `--drive` нет, остаток окна после последнего
   * события досыпается здесь же.
   */
  const driveWindow = async (script, windowMs) => {
    const schedule = driveSchedule(script, windowMs);
    const held = new Set();
    let taps = 0;
    const startedAt = Date.now();
    for (const event of schedule) {
      const wait = event.at - (Date.now() - startedAt);
      if (wait > 0) await sleep(wait);
      if (event.hold !== undefined) {
        // `hold` называет удерживаемое ЦЕЛИКОМ: что в нём не названо — отпустить.
        for (const code of Array.from(held)) {
          if (event.hold.includes(code)) continue;
          await dispatchKey('keyUp', code);
          held.delete(code);
        }
        for (const code of event.hold) {
          if (held.has(code)) continue;
          await dispatchKey('rawKeyDown', code);
          held.add(code);
        }
      }
      if (event.tap !== undefined) {
        await dispatchKey('rawKeyDown', event.tap);
        await sleep(DRIVE_TAP_MS);
        await dispatchKey('keyUp', event.tap);
        taps += 1;
      }
    }
    // Отпустить всё: удержание страница снимает только по `keyup` (INP-5), и
    // герой с зажатой клавишей бежал бы дальше — уже за пределами окна.
    for (const code of Array.from(held)) await dispatchKey('keyUp', code);
    const rest = windowMs - (Date.now() - startedAt);
    if (rest > 0) await sleep(rest);
    return { taps };
  };

  // Готовность = probe повесил ручку И кадры пошли. Кадры начинаются только
  // после handshake оболочки (SHELL-5), то есть когда матч действительно поднят.
  const probeState = `(() => { const p = globalThis[${JSON.stringify(BENCH_GLOBAL_KEY)}];` +
    ' return p === undefined ? null : { version: p.version, frames: p.frames() }; })()';
  const deadline = Date.now() + readyTimeoutMs;
  let ready = null;
  let lastPollError = null;
  while (Date.now() < deadline) {
    try {
      ready = await evaluate(probeState);
    } catch (error) {
      // Молчание страницы на ОДНОМ опросе — ещё не отказ: главный поток мог
      // встать на загрузке ассетов или компиляции шейдеров. Бюджет ожидания
      // здесь свой (`--ready-timeout`), и тратится он целиком, а причина
      // последнего молчания попадает в отказ, если бюджет так и не хватит.
      lastPollError = error;
      ready = null;
    }
    if (ready !== null && ready.frames > 0) break;
    ready = null;
    await sleep(250);
  }
  if (ready === null) {
    const said = cdp.pageErrors.length === 0 ? '' : `\n  страница сказала:\n  ${cdp.pageErrors.join('\n  ')}`;
    const silent = lastPollError === null ? '' : `\n  последний опрос: ${lastPollError.message}`;
    throw new Error(
      `probe страницы не отчитался за ${readyTimeoutMs / 1000} с — матч не пошёл или probe не включился${silent}${said}`,
    );
  }
  if (ready.version !== BENCH_PROBE_VERSION) {
    throw new Error(
      `probe страницы версии ${ready.version}, а харнесс ждёт ${BENCH_PROBE_VERSION}: перезапустите dev-сервер`,
    );
  }

  if (driveScript !== null) {
    // Страница обязана считать себя в фокусе: на расфокусе слой ввода снимает
    // удержания (`handleBlur`, INP-5), а вкладка замера создаётся второй в окне
    // браузера. Не всякая сборка это умеет — отказывать замеру не за чем.
    try {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    } catch {
      // Пусто намеренно: фокус эмулируется не везде, и вождение работает и так.
    }
  }

  // Прогрев не меряется: первые секунды матча — это загрузка ассетов, компиляция
  // шейдеров и прогрев JIT, и их перцентили сказали бы не о бюджете кадра.
  await sleep(warmupSeconds * 1000);
  // Пробы отладки снимаются ВНЕ окна замера — до обнуления probe и после отчёта:
  // дамп стоит главному потоку страницы работы, и внутри окна она попала бы в
  // перцентили кадра, ради которых замер и затевался.
  const before = driveScript === null ? null : await readDebugSections();
  const heapBefore = driveScript === null ? null : await readPageHeap();
  await evaluate(`globalThis[${JSON.stringify(BENCH_GLOBAL_KEY)}].reset()`);
  const driven = driveScript === null ? null : await driveWindow(driveScript, seconds * 1000);
  if (driveScript === null) await sleep(seconds * 1000);
  const summary = await evaluate(`globalThis[${JSON.stringify(BENCH_GLOBAL_KEY)}].report()`);
  if (summary.frames < 2) throw new Error('probe собрал меньше двух кадров — мерить нечего');
  const after = driveScript === null ? null : await readDebugSections();
  const heapAfter = driveScript === null ? null : await readPageHeap();

  let drive = null;
  if (driveScript !== null) {
    const fogAfter = sectionOf(after, FOG_SOURCE_ID);
    const rebuilds = rebuildsBetween(before, after);
    const programsBefore = programsProbeOf(before);
    const programsAfter = programsProbeOf(after);
    const memoryBefore = memoryProbeOf(before);
    const memoryAfter = memoryProbeOf(after);
    drive = {
      script: driveName,
      title: driveScript.title,
      taps: driven.taps,
      rebuilds,
      dissolving: fogAfter !== null && fogAfter.dissolving === true,
      focusBefore: focusOf(before),
      focusAfter: focusOf(after),
      // Обе границы окна, а не одна дельта: «было → стало» не даёт прочитать
      // разность как число компиляций (см. оговорку метода в отчёте).
      programsBefore: programsBefore.count,
      programsAfter: programsAfter.count,
      // Причина — у той пробы, которая числа не назвала: молчать они могли по
      // разным поводам, и в отчёт едет слово источника, а не догадка бенча.
      programsReason: programsAfter.reason ?? programsBefore.reason,
      // Занятая память на границах окна (PERF-7): куча страницы после
      // принудительной сборки и живой набор ресурсов рендерера. Обе величины —
      // диагностика: вердикт бюджета и код возврата от них не зависят.
      heapBefore: heapBefore.bytes,
      heapAfter: heapAfter.bytes,
      heapReason: heapAfter.reason ?? heapBefore.reason,
      memoryBefore: memoryBefore.geometries === null ? null : memoryBefore,
      memoryAfter: memoryAfter.geometries === null ? null : memoryAfter,
      memoryReason: memoryAfter.reason ?? memoryBefore.reason,
    };
    // Отчёт печатается ДО отказа: причина «замер не состоялся» читается вместе с
    // числами, на которых её увидели, а не вместо них.
    printReport(summary, pageUrl, drive);
    const failure = driveFailure(before, after, rebuilds);
    if (failure !== null) throw new Error(failure);
  } else {
    printReport(summary, pageUrl, null);
  }
} catch (error) {
  process.stderr.write(`\nбенч не состоялся: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    // Вежливое закрытие — попытка, а не обязательство: ответа на него может не
    // прийти вовсе (браузер уходит, не договорив), и ждать его дольше пары
    // секунд нельзя — следом идёт уборка временного профиля, а её пропускать не
    // за чем. Не ответил — добьём сигналом ниже.
    await cdp?.send('Browser.close', {}, undefined, 2000);
  } catch {
    // Браузер мог уже уйти либо промолчать — закрывать нечего.
  }
  cdp?.close();
  child?.kill();
  await server?.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

// Вердикт бюджета кода возврата не меняет (PERF-7): ненулевой остаётся только
// за отказом самого замера, выставленным в catch выше.
process.exit(process.exitCode ?? 0);
