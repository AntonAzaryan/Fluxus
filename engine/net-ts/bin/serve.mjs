#!/usr/bin/env node
/**
 * Сервер матча за WebSocket (NTR-12):
 *   node bin/serve.mjs examples/duel.match.json [--port 8080] [--json] [--observer]
 *
 * Здесь живут сокет и таймер — всё, чего нет внутри `MatchServer` (NTR-3).
 */
import { flag, option, readMatchFile } from './matchFile.mjs';

const file = process.argv[2];
if (file === undefined || file.startsWith('--')) {
  process.stderr.write('usage: node bin/serve.mjs <match.json> [--port 8080] [--json] [--observer]\n');
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

const tickRate = match.tickRate ?? 60;
const server = new MatchServer({
  version: { buildId: match.buildId, contentPackHash: pack.hash },
  players: match.players,
  seed: match.seed,
  sceneRef: match.sceneRef,
  scene: pack.scene(match.sceneRef),
  initial: match.initial ?? [],
  name: match.name,
  tickRate,
  snapshotRate: match.snapshotRate ?? 30,
  inputDelay: match.inputDelay ?? 2,
  ...(match.inputWindow !== undefined ? { inputWindow: match.inputWindow } : {}),
  silenceTicks: (match.silenceSeconds ?? 10) * tickRate,
  allowObserver: flag('observer'),
  // Зависимость сборки мира из файла матча (NTR-14): без неё сцена,
  // рассчитанная на интегрирующую физику, молча стояла бы на месте.
  ...(match.physics !== undefined ? { physics: match.physics } : {}),
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
  }
}, 1000);

const shutdown = async () => {
  clearInterval(report);
  await host.stop();
  process.stdout.write('\nостановлен\n');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
