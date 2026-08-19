#!/usr/bin/env node
/**
 * Сервер матча за WebSocket (NTR-12):
 *   node bin/serve.mjs examples/duel.match.json [--port 8080] [--json] [--observer]
 *     [--trace=off|systems|full] [--trace-select=<вид|код>,...]
 *     [--trace-out=<path>] [--record-out=<path>]
 *
 * Значение флага принимается обеими формами — `--trace=full` и `--trace full`:
 * CLI прогона сценария принимает первую (CLI-7), примеры запуска стенда —
 * вторую, а CLI-11 требует одного образа на обе запускалки.
 *
 * Здесь живут сокет и таймер — всё, чего нет внутри `MatchServer` (NTR-3).
 * Здесь же — ввод-вывод трейса: строку в файл пишет функция, инъектированная
 * запускалкой (CLI-11), а сервер о ней не знает.
 *
 * Умолчание — выключенный трейс: с ним прогон тот же, каким был до появления
 * отладочного режима. Объём включённого — в шапке `bin/trace.mjs`.
 *
 * Трейс без записи матча невоспроизводим (DIAG-9): ввод порождают боты и люди,
 * а не seed, — поэтому `--trace-out` без `--record-out` называется вслух, а не
 * оставляется поводом к расследованию, которого не получится.
 */
import { writeFileSync } from 'node:fs';
import { flag, matchConfigOf, option, readMatchFile } from './matchFile.mjs';
import { openMatchTrace, traceOptions, TRACE_USAGE, TRACE_WITHOUT_RECORD } from './trace.mjs';

const file = process.argv[2];
if (file === undefined || file.startsWith('--')) {
  process.stderr.write(
    `usage: node bin/serve.mjs <match.json> [--port 8080] [--json] [--observer]\n       ${TRACE_USAGE} [--record-out=<path>]\n`,
  );
  process.exit(2);
}

const { contentPack } = await import('../src/content/pack.ts');
const { MatchServer } = await import('../src/server/matchServer.ts');
const { MatchHost } = await import('../src/server/host.ts');
const { webSocketTransportServer } = await import('../src/transport/webSocketServer.ts');
const { jsonSerializer, msgpackSerializer } = await import('../src/protocol/codec.ts');

const match = readMatchFile(file);
const port = Number(option('port', '8080'));
const pack = contentPack(match.scenes);
const serializer = flag('json') ? jsonSerializer : msgpackSerializer;
const recordOut = option('record-out');
const tracing = openMatchTrace(traceOptions());

if (tracing !== undefined && recordOut === undefined) {
  process.stdout.write(`${TRACE_WITHOUT_RECORD}          добавьте --record-out=<path>\n`);
}

// Раскладка документа матча в конфиг — общая с остальными запускалками
// (`matchConfigOf`), включая зависимости сборки мира (NTR-14). Своё здесь одно:
// наблюдатель — решение запуска, а не свойство матча.
const server = new MatchServer({
  ...matchConfigOf(match, pack),
  allowObserver: flag('observer'),
  ...(tracing !== undefined ? { trace: tracing.trace } : {}),
});

const host = new MatchHost(server, webSocketTransportServer({ port }), { serializer });

process.stdout.write(
  `матч "${match.name}" на ws://127.0.0.1:${port}\n` +
    `  версия: ${match.buildId} + ${pack.hash}\n` +
    `  worldInit: ${server.worldInitHash}\n` +
    `  слоты: ${match.players.join(', ')}\n` +
    `  темп: ${server.pacing.tickRate} Гц, рассылка ${server.pacing.snapshotRate} Гц, задержка ввода ${server.pacing.inputDelay}\n` +
    `  формат: ${serializer.name}${flag('observer') ? ', наблюдатель разрешён' : ''}\n\n`,
);

host.start();

// Раздельные счётчики по слотам (NTR-11): «ввод теряется» и «ввод вялый» —
// разные дефекты, и различить их можно только раздельным счётом.
const report = setInterval(() => {
  const slots = server.metrics.slots
    .map((slot, i) => `${match.players[i]}: ${slot.applied}/${slot.predicted}/${slot.late}`)
    .join('  ');
  process.stdout.write(
    `\rтик ${server.tick} [${server.phase}]  применено/предсказано/опоздало → ${slots}  ` +
      `снапшотов ${server.metrics.snapshotsSent}, ${(server.metrics.bytesSent / 1024).toFixed(1)} КиБ   `,
  );
  if (server.phase === 'ended') {
    clearInterval(report);
    process.stdout.write('\nматч завершён\n');
    saveArtifacts();
  }
}, 1000);

/**
 * Запись матча в форме документа сценария (CLI-2, NTR-8) и закрытие трейса.
 * Матч с перемоткой плоской формой не выражается (NTR-16) — прогон говорит об
 * этом прямо вместо файла, реплей которого разойдётся с матчем (CLI-11).
 */
let saved = false;
function saveArtifacts() {
  if (saved) return;
  saved = true;
  if (recordOut !== undefined) {
    try {
      writeFileSync(recordOut, `${JSON.stringify(server.toScenario(), null, 2)}\n`);
      process.stdout.write(`запись матча: ${recordOut}\n`);
    } catch (error) {
      process.stdout.write(`записи матча не будет: ${error.message}\n`);
    }
  }
  if (tracing !== undefined) {
    // Закрытие писателя наружу не бросает (`bin/trace.mjs`): отказ сброса
    // хвоста называется тем же полем `failure`, а не уносит с собой прогон.
    tracing.close();
    if (tracing.failure !== undefined) {
      process.stdout.write(`трейс оборван: ${tracing.failure}\n`);
    }
  }
}

const shutdown = async () => {
  clearInterval(report);
  await host.stop();
  saveArtifacts();
  process.stdout.write('\nостановлен\n');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
