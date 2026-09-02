#!/usr/bin/env node
/**
 * Матч, основанный игроком (`net-session` SES-1, режим `listen`):
 *   node bin/host.mjs ../../content/matches/duel.match.json --player p1 [--port 8080]
 *                     [--advertise host:port] [--keys] [--script inputs.json] [--json]
 *
 * Авторитетный цикл исполняется здесь же, рядом с собственным клиентом хоста.
 * Клиент этот — обычный: тот же `MatchClient`, тот же хендшейк, тот же
 * персональный снапшот; отличается он только внутрипроцессным транспортом
 * (SES-6). Выделенный сервер поднимается тем же кодом — `bin/serve.mjs`, — и
 * различие между запускалками и есть вся разница между режимами (SES-2).
 *
 * Ограничение шага названо прямо: слушать входящие соединения умеет процесс, а
 * не вкладка браузера, поэтому приглашённый доберётся сюда по LAN или пробросу
 * порта. Хост во вкладке — это рандеву поверх WebRTC, и встаёт оно под тот же
 * интерфейс (SES-3).
 */
import { clientBuildOptions, flag, matchDataOf, option, readMatchFile } from './matchFile.mjs';
import { inputSource, reportClient } from './play.shared.mjs';

const file = process.argv[2];
if (file === undefined || file.startsWith('--')) {
  process.stderr.write('usage: node bin/host.mjs <match.json> --player <id> [--port 8080] [--keys]\n');
  process.exit(2);
}

const { contentPack } = await import('../src/content/pack.ts');
const { HostSession } = await import('../src/session/hostSession.ts');
const { WebSocketRendezvous } = await import('../src/session/rendezvous/webSocket.ts');
const { jsonSerializer, msgpackSerializer } = await import('../src/protocol/codec.ts');

const match = readMatchFile(file);
const founder = option('player', match.players[0]);
const port = Number(option('port', '8080'));
const pack = contentPack(match.scenes);
const serializer = flag('json') ? jsonSerializer : msgpackSerializer;
// Раскладка документа матча — общая с `serve.mjs` и стендом (`matchDataOf`):
// одна запускалка не должна поднимать мир иначе, чем другая (NTR-5, NTR-14).
const matchData = matchDataOf(match, pack);

const rendezvous = new WebSocketRendezvous({
  port,
  ...(option('advertise', undefined) !== undefined ? { advertise: option('advertise') } : {}),
});

const session = await HostSession.open({
  rendezvous,
  version: { buildId: match.buildId, contentPackHash: pack.hash },
  founder,
  slots: match.players.length,
  serializer,
  match: matchData,
});

process.stdout.write(
  `матч "${match.name}" основан игроком ${founder}, порт ${rendezvous.port}\n` +
    `  версия: ${match.buildId} + ${pack.hash}\n` +
    `  слоты: ${match.players.length} (занят ${session.roster.length})\n` +
    `  формат: ${serializer.name}\n\n` +
    `инвайт (передайте приглашённым целиком):\n${session.invite}\n\n` +
    `матч стартует, как только соберутся все слоты\n\n`,
);

// Ждём заполнения ростера. Опрос, а не подписка: лобби — чистый цикл без
// таймеров (SES-4), и расписание, как и у матча, живёт снаружи.
const roster = new Set(session.roster);
await new Promise((resolve) => {
  const poll = setInterval(() => {
    for (const player of session.roster) {
      if (!roster.has(player)) {
        roster.add(player);
        process.stdout.write(`вошёл ${player} (${session.roster.length}/${match.players.length})\n`);
      }
    }
    if (session.lobby.isFull) {
      clearInterval(poll);
      resolve();
    }
  }, 200);
});

const started = await session.start();
process.stdout.write(`\nростер заморожен: ${started.server.config.players.join(', ')}\n`);
process.stdout.write(`worldInit: ${started.server.worldInitHash}\n\n`);

const local = session.localClient(
  {
    playerId: founder,
    version: { buildId: match.buildId, contentPackHash: pack.hash },
    content: pack,
    // Обе стороны берут зависимости сборки из ОДНОГО описания матча (NTR-14):
    // раскладка общая на все запускалки, перечисления имён здесь нет.
    ...clientBuildOptions(match),
  },
  { input: inputSource() },
);
local.host.start();
local.host.run();
started.host.start();

if (flag('keys')) process.stdout.write('управление: WASD — движение, пробел — каст, Ctrl+C — выход\n\n');

/**
 * Снапшоты, не отправленные слоту из-за очереди отправки его соединения
 * (NTR-22). Тире — живого соединения у слота нет: пропускать было нечего, и ноль
 * тут соврал бы про здоровый канал.
 */
function skippedOf(slot) {
  const connection = started.server.slotLease(slot).connection;
  if (connection === undefined) return '—';
  return started.host.connectionMetrics(connection)?.snapshotsSkipped ?? '—';
}

const report = reportClient(local.client, () => {
  // Применено/предсказано/опоздало/пропущено (NTR-11, NTR-22): четвёртым идёт
  // «канал узкий» — ответ, которого раздельные счётчики слота не давали.
  const slots = started.server.metrics.slots
    .map((slot, i) => `${started.server.config.players[i]}: ${slot.applied}/${slot.predicted}/${slot.late}/${skippedOf(i)}`)
    .join('  ');
  return `[${session.info.mode}/${session.info.phase}] тик ${started.server.tick}  ${slots}`;
});

const shutdown = async () => {
  clearInterval(report);
  local.host.stop();
  await session.close();
  process.stdout.write('\nматч закрыт\n');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
