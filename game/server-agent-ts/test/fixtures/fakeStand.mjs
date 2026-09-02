#!/usr/bin/env node
/**
 * Подставной сервер матча для тестов агента: говорит на том же контракте stdio
 * (решение D2), что настоящий стенд, и не тянет за собой ни движка, ни контента.
 *
 * Подставной, а не настоящий стенд, по той же причине, по которой контрактный
 * сьют контейнера поднимает пустышку (DSK-7): предмет проверки — СУПЕРВИЗИЯ,
 * то есть то, что агент знает о процессе, а не то, как идёт матч. Настоящий
 * стенд с ботами проверяется отдельно, сквозным прогоном (`e2e.test.ts`).
 *
 *   --port <n>            порт, который держать занятым
 *   --control-adapter     говорить управляющими линиями (как настоящий стенд)
 *   --crash-after-ms <n>  выйти ненулевым кодом через n мс (краш, SRV-1)
 *   --deaf                не реагировать на SIGTERM: проверка жёсткой остановки
 *   --silent              не поднимать порт вовсе: «сервис не поднялся»
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const at = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const has = (name) => process.argv.includes(`--${name}`);

const PREFIX = '@fx-control ';
const port = Number(at('port', '0'));
const players = ['p1', 'p2'];

// Немедленная смерть ДО прослушивания порта: несостоявшийся запуск (MGR-2).
// Договорённость теста — слово `die` в имени документа матча: агент строит
// аргументы сам, попросить процесс упасть на старте можно только так.
if (has('die') || String(at('match', '')).includes('die')) {
  process.stderr.write('подставной стенд: немедленный выход\n');
  process.exit(3);
}

// Незнакомый статус слота в отчёте: дрейф стенда и агента (SRV-4). Тем же
// приёмом — слово `drift` в имени документа матча.
const driftStatus = has('drift') || String(at('match', '')).includes('drift');

// Стенд, начавший УПРАВЛЯЮЩУЮ линию и не закончивший её переводом строки. Тем же
// приёмом — слово `flood` в имени документа матча. Так выглядит сломавшийся
// отчёт и обрыв на середине записи: маркер есть, а конца линии нет никогда,
// поэтому потолок обычной строки (`LOG_LINE_LIMIT`) её намеренно не режет.
// Проверяется на этом потолок ХВОСТА (`CONTROL_TAIL_LIMIT`), без которого буфер
// агента рос бы до `RangeError` — то есть до смерти агента вместе со всеми его
// серверами (SRV-1).
const floodControl = has('flood') || String(at('match', '')).includes('flood');

// Каталог артефактов прогона заводит СТЕНД (`--out-dir`), а не агент, — и по
// нему постмортем краха (SRV-6) собирает материалы разбора.
//
// Подставной заводит его ВСЕГДА, и это осознанное расхождение с настоящим:
// `demo-serve.mjs` создаёт каталог только в отладочном прогоне (`if (debugRun)`),
// а флага отладки в закрытом наборе параметров запуска (SRV-2) нет — значит, под
// агентом каталога сегодня не бывает вовсе, и ветвь артефактов постмортема
// недостижима (пункт 9 ревью `docs/reviews/2026-08-26-server-manager-code-review.md`).
// Фикстура моделирует стенд, который его завёл, — то есть ту сторону контракта,
// какой она станет, когда пробел закроют; иначе проверить, что агент ИЩЕТ
// каталог там же, где стенд его завёл, нечем в принципе.
const runDir = at('out-dir', '');
if (runDir !== '') {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), '{"stand":"fake"}\n');
}

/** Состояние подставного матча: ровно то, что видно в отчёте. */
const state = {
  phase: 'lobby',
  tick: 0,
  round: 1,
  pause: 'running',
  barred: new Set(),
  detached: new Set(),
  subscribed: false,
};

const emit = (line) => { process.stdout.write(`${PREFIX}${JSON.stringify(line)}\n`); };

const slot = (index) => ({
  slot: index,
  playerId: players[index],
  status: driftStatus
    ? 'взлетает'
    : state.barred.has(index)
    ? 'removed'
    : state.detached.has(index)
      ? 'disconnected'
      : state.phase === 'running'
        ? 'active'
        : 'connecting',
  role: state.detached.has(index) || state.barred.has(index) ? null : 'owner',
  rtt: { kind: 'measured', ms: 7 },
  serverResponseMs: 33,
  applied: state.tick,
  predicted: 0,
  late: 0,
  snapshotBytes: 1024,
  // Снапшоты, не ушедшие из-за очереди отправки (NTR-22): ненулевые, чтобы
  // проверялась передача величины, а не нуля по умолчанию.
  snapshotsSkipped: 2,
});

const report = () => {
  emit({
    t: 'report',
    phase: state.phase,
    tick: state.tick,
    round: state.round,
    pause: state.pause,
    slots: players.map((_, index) => slot(index)),
    metrics: state.subscribed
      ? {
          tickP99Ms: 1.5,
          tickMeanMs: 0.4,
          broadcastP99Ms: 0.9,
          snapshotsSent: state.tick,
          bytesSent: state.tick * 512,
          eventLoopDelayMs: 0.2,
          rssBytes: 42_000_000,
        }
      : null,
  });
};

if (!has('silent')) {
  const server = createServer((socket) => { socket.end(); });
  server.listen(port, '127.0.0.1');
}

if (has('control-adapter')) {
  // Обычная строка лога рядом с управляющими: тест проверяет, что агент
  // различает их МАРКЕРОМ, а не порядком.
  process.stdout.write('подставной стенд поднят\n');
  emit({ t: 'ready', port, players, buildId: 'fake-build', contentPackHash: 'fake-hash' });
  state.phase = 'running';

  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const edge = pending.indexOf('\n');
      if (edge < 0) break;
      const line = pending.slice(0, edge);
      pending = pending.slice(edge + 1);
      if (line.trim() === '') continue;
      const command = JSON.parse(line);
      let reason = '';
      switch (command.cmd) {
        case 'bar-slot':
          state.barred.add(command.slot);
          state.detached.delete(command.slot);
          break;
        case 'unbar-slot':
          state.barred.delete(command.slot);
          break;
        case 'disconnect-player':
          state.detached.add(command.slot);
          break;
        case 'pause':
          reason = state.pause === 'frozen' ? 'already-frozen' : '';
          if (reason === '') state.pause = 'frozen';
          break;
        case 'resume':
          reason = state.pause === 'running' ? 'not-frozen' : '';
          if (reason === '') state.pause = 'running';
          break;
        case 'subscribe':
          state.subscribed = true;
          break;
        case 'unsubscribe':
          state.subscribed = false;
          break;
        case 'stop':
          state.phase = 'ended';
          setTimeout(() => { process.exit(0); }, 10);
          break;
        default:
          reason = 'неизвестная команда';
      }
      process.stdout.write(`${PREFIX}${JSON.stringify({ t: 'result', id: command.id, ok: reason === '', reason })}\n`);
      // Отчёт сразу после команды: тест наблюдает исход событием подписки, а не
      // ожиданием периодического отчёта.
      report();
    }
  });

  if (floodControl) {
    // Два мегабайта маркированного хвоста ОДНОЙ записью и без перевода строки:
    // вдвое больше потолка хвоста агента (`CONTROL_TAIL_LIMIT`, 1 МиБ). Одной
    // записью — чтобы между её кусками не встала строка с переводом, которая
    // закрыла бы линию раньше потолка; периодический отчёт ниже по той же
    // причине не заводится вовсе.
    process.stdout.write(`${PREFIX}${'x'.repeat(2 * 1024 * 1024)}`);
  } else {
    setInterval(() => {
      state.tick += 60;
      // Обычная строка лога (без маркера) на каждом тике: по ней тест видит, что
      // хвост лога доходит до КАЖДОГО подписчика деталей (SRV-2), а не только до
      // первого. Смешать её с управляющей линией нельзя — разделяет их маркер.
      process.stdout.write(`лог тика ${String(state.tick)}\n`);
      report();
    }, 200).unref();
  }
}

// Документ матча со словом `crash` в имени — договорённость ТЕСТА, а не
// протокола: агент строит аргументы сам, и другого способа попросить подставной
// стенд упасть у теста нет.
const crashAfter =
  Number(at('crash-after-ms', '0')) || (String(at('match', '')).includes('crash') ? 200 : 0);
if (crashAfter > 0) {
  setTimeout(() => {
    process.stdout.write('подставной стенд падает\n');
    process.exit(7);
  }, crashAfter);
}

// Глухой к SIGTERM стенд: та же договорённость — слово `deaf` в имени документа.
// Нужен, чтобы штатная остановка шла ЧЕРЕЗ SIGKILL: именно так уходит стенд без
// обработчика сигнала, и именно так уходит любой стенд на Windows.
if (!has('deaf') && !String(at('match', '')).includes('deaf')) {
  process.on('SIGTERM', () => { process.exit(0); });
  process.on('SIGINT', () => { process.exit(0); });
}
// Процесс не должен выйти сам: держим его живым до сигнала.
setInterval(() => {}, 60_000);
