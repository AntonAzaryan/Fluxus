#!/usr/bin/env node
/**
 * Подставной сервер матча для тестов менеджера: говорит на контракте stdio
 * агента (решение D2) и не тянет за собой ни движка, ни контента.
 *
 * Менеджеру для проверки нужен ЖИВОЙ агент (MGR-1: управление только через
 * протокол), но не нужен настоящий бой: предмет проверок здесь — список,
 * детали и админ-операции, а не матч. Настоящий стенд с ботами проверяется
 * сквозным прогоном в пакете агента.
 */
import { createServer } from 'node:net';

const at = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

const PREFIX = '@fx-control ';
const port = Number(at('port') ?? '0');
const players = ['герой', 'соперник'];
const state = { barred: new Set(), pause: 'running', subscribed: false, tick: 0 };

const emit = (line) => { process.stdout.write(`${PREFIX}${JSON.stringify(line)}\n`); };

const report = () => {
  emit({
    t: 'report',
    phase: 'running',
    tick: state.tick,
    round: 1,
    pause: state.pause,
    slots: players.map((playerId, slot) => ({
      slot,
      playerId,
      status: state.barred.has(slot) ? 'removed' : 'active',
      role: state.barred.has(slot) ? null : 'owner',
      rtt: { kind: 'measured', ms: 11 + slot },
      serverResponseMs: 45,
      applied: state.tick,
      predicted: 0,
      late: 0,
      snapshotBytes: 4096,
      // Пропуски по очереди отправки (NTR-22): ненулевые, чтобы вид менеджера
      // проверялся на величине, а не на нуле, который он показал бы и без поля.
      snapshotsSkipped: 3,
    })),
    metrics: state.subscribed
      ? {
          tickP99Ms: 1.25,
          tickMeanMs: 0.5,
          broadcastP99Ms: 0.75,
          snapshotsSent: state.tick,
          bytesSent: state.tick * 256,
          eventLoopDelayMs: 0.15,
          rssBytes: 55_000_000,
        }
      : null,
  });
};

createServer((socket) => { socket.end(); }).listen(port, '127.0.0.1');
process.stdout.write('подставной стенд менеджера поднят\n');
// Аргументы запуска — обычной строкой лога (без маркера управляющей линии):
// только по ней тест видит, ЧТО агент передал стенду, — параметры запуска
// (SRV-2) в записи реестра не отражаются.
process.stdout.write(`аргументы: ${process.argv.slice(2).join(' ')}\n`);
emit({ t: 'ready', port, players, buildId: 'manager-build', contentPackHash: 'manager-hash' });

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
    if (command.cmd === 'bar-slot') state.barred.add(command.slot);
    else if (command.cmd === 'unbar-slot') state.barred.delete(command.slot);
    else if (command.cmd === 'pause') reason = state.pause === 'frozen' ? 'already-frozen' : (state.pause = 'frozen', '');
    else if (command.cmd === 'resume') reason = state.pause === 'running' ? 'not-frozen' : (state.pause = 'running', '');
    else if (command.cmd === 'subscribe') state.subscribed = true;
    else if (command.cmd === 'unsubscribe') state.subscribed = false;
    else if (command.cmd === 'stop') setTimeout(() => { process.exit(0); }, 10);
    process.stdout.write(`${PREFIX}${JSON.stringify({ t: 'result', id: command.id, ok: reason === '', reason })}\n`);
    report();
  }
});

setInterval(() => {
  state.tick += 60;
  report();
}, 200).unref();

process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });

// Документ матча со словом `crash` в имени — договорённость ТЕСТА, а не
// протокола: так же устроен подставной стенд агента. Выход ненулевым кодом —
// после того как порт уже отвечает, иначе это несостоявшийся запуск, а не краш
// идущего сервера (SRV-6).
if (String(at('match') ?? '').includes('crash')) {
  setTimeout(() => {
    process.stdout.write('подставной стенд менеджера падает\n');
    process.exit(7);
  }, 250);
}

setInterval(() => {}, 60_000);
