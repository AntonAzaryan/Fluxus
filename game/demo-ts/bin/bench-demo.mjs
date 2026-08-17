#!/usr/bin/env node
/**
 * Браузерный бенч демо-арены (`performance-budget` PERF-7, design D6).
 *
 *   npm run bench:demo -- [--profile desktop-dev] [--seconds 20] [--warmup 5]
 *                         [--headless] [--solo] [--json] [--chrome <path>]
 *
 * Отвечает на один вопрос — «бюджет профиля ещё сходится?» — и отвечает на него
 * НАСТОЯЩИМ рендерером на настоящей сцене: поднимает dev-страницу демо, катает
 * матч против бота N секунд, забирает у probe страницы (`app/benchProbe.ts`)
 * перцентили кадра и стадий (PERF-2) и печатает их против бюджетов профиля
 * (PERF-1) с вердиктом по каждой строке.
 *
 * В ГЕЙТ НЕ ВХОДИТ и входить не может (PERF-7): нужен браузер, а числа шумят от
 * машины к машине. Это диагностика по запросу, как `npm run coverage`; от
 * расползания стоимости между такими сверками страхуют детерминированные
 * счётчики и их голден-гейт (PERF-3, PERF-4). Поэтому и код возврата 0 при
 * ЛЮБОМ вердикте: ненулевым он бывает только когда замера не случилось вовсе —
 * не нашёлся браузер, не поднялась страница, матч не пошёл.
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Хук резолва: `bench/profile.ts` импортирует `../app/benchProbe.js`, а рядом
// лежит `.ts` — типы Node стрипает сам (>=22.18), хук добавляет остальное. Тот
// же приём, что у `core-ts/bin/sim.mjs`; регистрация обязана случиться ДО
// динамического импорта ниже, поэтому импорт статический, а импорт профиля — нет.
import '@game-mvp/net/bin/tsHook.mjs';
import { flag, option } from '@game-mvp/net/bin/matchFile.mjs';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const PROFILES = join(PACKAGE, 'bench', 'profiles');
const VITE_CONFIG = join(PACKAGE, 'app', 'vite.config.ts');

if (flag('help')) {
  process.stdout.write(
    'usage: node game/demo-ts/bin/bench-demo.mjs [--profile desktop-dev] [--seconds 20]\n' +
      '       [--warmup 5] [--headless] [--solo] [--json] [--chrome <path>] [--port 5174]\n',
  );
  process.exit(0);
}

const profileArg = option('profile', 'desktop-dev');
const seconds = Number(option('seconds', '20'));
const warmupSeconds = Number(option('warmup', '5'));
const readyTimeoutMs = Number(option('ready-timeout', '90')) * 1000;
const headless = flag('headless');
const port = Number(option('port', '5174'));

if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(warmupSeconds) || warmupSeconds < 0) {
  process.stderr.write('бенч: --seconds должен быть положительным, --warmup — неотрицательным\n');
  process.exit(2);
}

// ------------------------------------------------------------------ профиль

const profilePath =
  profileArg.endsWith('.json') || profileArg.includes('/')
    ? resolve(process.cwd(), profileArg)
    : join(PROFILES, `${profileArg}.json`);

const { validateBenchProfile, benchVerdict, benchLineFits, benchPaceFits } =
  await import('../bench/profile.ts');
const { BENCH_GLOBAL_KEY, BENCH_PROBE_VERSION } = await import('../app/benchProbe.ts');

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
    const path = join(browsers, 'chromium');
    if (existsSync(path)) return { path, source: 'PLAYWRIGHT_BROWSERS_PATH' };
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
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match === null) return;
      clearTimeout(timer);
      done(match[1]);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      failed(new Error(`браузер завершился с кодом ${code}:\n${buffer}`));
    });
  });
}

// ---------------------------------------------------------------------- CDP

/**
 * Минимальный клиент CDP: запрос-ответ по id и сбор ошибок страницы.
 * Событий читается ровно два вида — исключение и `console.error`: если probe
 * так и не появился, причина почти всегда в них, и молчать о ней нельзя.
 */
async function cdpConnect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const pageErrors = [];
  let nextId = 0;

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

  await new Promise((done, failed) => {
    socket.addEventListener('open', () => { done(); }, { once: true });
    socket.addEventListener('error', () => { failed(new Error('CDP: соединение с браузером не открылось')); }, { once: true });
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((done, failed) => {
      nextId += 1;
      const id = nextId;
      pending.set(id, { done, failed });
      const frame = { id, method, params };
      if (sessionId !== undefined) frame.sessionId = sessionId;
      socket.send(JSON.stringify(frame));
    });

  return { send, pageErrors, close: () => { socket.close(); } };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------- отчёт

/** Число в миллисекундах с фиксированной шириной — колонки обязаны читаться. */
const ms = (value) => `${value.toFixed(2)} мс`;

/** Подписи строк отчёта: ключ probe → то, как стадия зовётся человеку. */
const LINE_LABELS = {
  frame: 'кадр целиком',
  input: 'ввод и прицел',
  camera: 'камера',
  present: 'доставка+кадр',
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

function printReport(summary, pageUrl) {
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
  out.push(
    `  ${'величина'.padEnd(16)}${'p50'.padEnd(12)}${'p99'.padEnd(12)}` +
      `${'бюджет p50/p99'.padEnd(22)}вердикт`,
  );
  for (const line of lines) {
    const label = LINE_LABELS[line.key] ?? line.key;
    const budget =
      line.budget === null ? '—' : `${line.budget.p50.toFixed(2)} / ${line.budget.p99.toFixed(2)} мс`;
    out.push(
      `  ${label.padEnd(16)}${ms(line.measured.p50).padEnd(12)}${ms(line.measured.p99).padEnd(12)}` +
        `${budget.padEnd(22)}${verdictOf(line)}`,
    );
  }
  out.push('');
  // Период кадра сверяется с тем же бюджетом `frame`, но это ДРУГАЯ величина:
  // работа главного потока против того, что видит игрок (см. `benchPaceFits`).
  const paceFits = benchPaceFits(profile, summary);
  const frameBudget = profile.budgetsMs.frame;
  out.push(
    `  ${'период кадра'.padEnd(16)}${ms(summary.intervalMs.p50).padEnd(12)}` +
      `${ms(summary.intervalMs.p99).padEnd(12)}` +
      `${`${frameBudget.p50.toFixed(2)} / ${frameBudget.p99.toFixed(2)} мс`.padEnd(22)}` +
      `${paceFits ? 'темп держится' : 'темп НЕ держится'}`,
  );
  out.push(
    `  ${'разрыв тика'.padEnd(16)}${ms(summary.ticks.gapMs.p50).padEnd(12)}` +
      `${ms(summary.ticks.gapMs.p99).padEnd(12)}${'—'.padEnd(22)}каденс доставки`,
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
  if (flag('json')) process.stdout.write(`${JSON.stringify({ profile, summary }, null, 2)}\n`);
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
      `бенч: прогрев ${warmupSeconds} с, замер ${seconds} с\n`,
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

  // Готовность = probe повесил ручку И кадры пошли. Кадры начинаются только
  // после handshake оболочки (SHELL-5), то есть когда матч действительно поднят.
  const probeState = `(() => { const p = globalThis[${JSON.stringify(BENCH_GLOBAL_KEY)}];` +
    ' return p === undefined ? null : { version: p.version, frames: p.frames() }; })()';
  const deadline = Date.now() + readyTimeoutMs;
  let ready = null;
  while (Date.now() < deadline) {
    ready = await evaluate(probeState);
    if (ready !== null && ready.frames > 0) break;
    ready = null;
    await sleep(250);
  }
  if (ready === null) {
    const said = cdp.pageErrors.length === 0 ? '' : `\n  страница сказала:\n  ${cdp.pageErrors.join('\n  ')}`;
    throw new Error(
      `probe страницы не отчитался за ${readyTimeoutMs / 1000} с — матч не пошёл или probe не включился${said}`,
    );
  }
  if (ready.version !== BENCH_PROBE_VERSION) {
    throw new Error(
      `probe страницы версии ${ready.version}, а харнесс ждёт ${BENCH_PROBE_VERSION}: перезапустите dev-сервер`,
    );
  }

  // Прогрев не меряется: первые секунды матча — это загрузка ассетов, компиляция
  // шейдеров и прогрев JIT, и их перцентили сказали бы не о бюджете кадра.
  await sleep(warmupSeconds * 1000);
  await evaluate(`globalThis[${JSON.stringify(BENCH_GLOBAL_KEY)}].reset()`);
  await sleep(seconds * 1000);
  const summary = await evaluate(`globalThis[${JSON.stringify(BENCH_GLOBAL_KEY)}].report()`);
  if (summary.frames < 2) throw new Error('probe собрал меньше двух кадров — мерить нечего');

  printReport(summary, pageUrl);
} catch (error) {
  process.stderr.write(`\nбенч не состоялся: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    await cdp?.send('Browser.close');
  } catch {
    // Браузер мог уже уйти — закрывать нечего.
  }
  cdp?.close();
  child?.kill();
  await server?.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

// Вердикт бюджета кода возврата не меняет (PERF-7): ненулевой остаётся только
// за отказом самого замера, выставленным в catch выше.
process.exit(process.exitCode ?? 0);
