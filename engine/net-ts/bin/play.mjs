#!/usr/bin/env node
/**
 * Headless-клиент матча (NTR-12):
 *   node bin/play.mjs examples/duel.match.json --player p1 [--url ws://127.0.0.1:8080]
 *                     [--invite fluxus1.…] [--keys] [--script inputs.json] [--json] [--observer]
 *
 * Две дороги в матч и один клиент. `--url` ведёт прямо в поднятый матч
 * (преднастроенный ростер — форма `dedicated`), `--invite` — через лобби к
 * игроку-хосту (форма `listen`). После входа различий нет: тот же
 * `MatchClient`, тот же хендшейк, тот же поток снапшотов (`net-session` SES-2).
 *
 * Рендера нет и не требуется: наблюдаемый выход — принятые снапшоты и счётчики
 * (NTR-12). Рендер подключается к этому же `MatchClient` позже.
 */
import { clientBuildOptions, flag, option, readMatchFile } from './matchFile.mjs';
import { inputSource, reportClient } from './play.shared.mjs';

const file = process.argv[2];
if (file === undefined || file.startsWith('--')) {
  process.stderr.write(
    'usage: node bin/play.mjs <match.json> --player <id> [--url ws://…] [--invite fluxus1.…] [--keys]\n',
  );
  process.exit(2);
}

const { contentPack } = await import('../src/content/pack.ts');
const { MatchClient } = await import('../src/client/matchClient.ts');
const { ClientHost } = await import('../src/client/host.ts');
const { connectWebSocket } = await import('../src/transport/webSocketClient.ts');
const { joinSession, SessionJoinError } = await import('../src/session/joinSession.ts');
const { WebSocketRendezvous } = await import('../src/session/rendezvous/webSocket.ts');
const { jsonSerializer, msgpackSerializer } = await import('../src/protocol/codec.ts');

const match = readMatchFile(file);
const playerId = option('player', match.players[0]);
const invite = option('invite', undefined);
const observer = flag('observer');
const serializer = flag('json') ? jsonSerializer : msgpackSerializer;

// Клиент берёт из файла матча только сборочные вещи: контент-пак, идентификатор
// сборки и зависимости сборки мира (NTR-14). Данные матча — слот, seed,
// расстановку, темп — он узнаёт из `Welcome` (NTR-5), как и в бою.
const pack = contentPack(match.scenes);
const clientOptions = {
  playerId,
  version: { buildId: match.buildId, contentPackHash: pack.hash },
  content: pack,
  observer,
  ...clientBuildOptions(match),
};

let client;
let host;
let transport;
let describeEntry;

if (invite !== undefined) {
  if (observer) {
    process.stderr.write('наблюдатель входит прямо в матч (--url), а не через лобби\n');
    process.exit(2);
  }
  process.stdout.write('вхожу в лобби по инвайту, жду старта матча…\n');
  let joined;
  try {
    joined = await joinSession({
      rendezvous: new WebSocketRendezvous(),
      invite,
      client: clientOptions,
      serializer,
      clientHost: { input: inputSource() },
    });
  } catch (error) {
    const detail = error instanceof SessionJoinError ? error.message : String(error);
    process.stderr.write(`в матч не попал: ${detail}\n`);
    process.exit(1);
  }
  ({ client, host, transport } = joined);
  describeEntry = `по инвайту, ростер: ${joined.roster?.join(', ') ?? '—'}`;
} else {
  const url = option('url', 'ws://127.0.0.1:8080');
  client = new MatchClient(clientOptions);
  transport = await connectWebSocket(url);
  host = new ClientHost(client, transport, { serializer, input: inputSource() });
  host.start();
  describeEntry = `к ${url}`;
}

host.run();

process.stdout.write(
  `подключён ${describeEntry} как ${observer ? 'наблюдатель' : playerId}\n` +
    `  версия: ${match.buildId} + ${pack.hash}\n` +
    (flag('keys') ? '  управление: WASD — движение, пробел — каст, Ctrl+C — выход\n\n' : '\n'),
);

const report = reportClient(
  client,
  () => `[${client.phase}] слот ${client.slot ?? '—'}  тик ${client.serverTick}`,
  () => {
    clearInterval(report);
    process.stdout.write(`\nсоединение закрыто: ${client.closeReason} — ${client.closeDetail}\n`);
    process.exit(0);
  },
);

const shutdown = () => {
  clearInterval(report);
  host.stop();
  transport.close('выход');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
