#!/usr/bin/env node
/**
 * Headless-клиент матча (NTR-12):
 *   node bin/play.mjs examples/duel.match.json --player p1 [--url ws://127.0.0.1:8080]
 *                     [--keys] [--script inputs.json] [--json] [--observer]
 *
 * Рендера нет и не требуется: наблюдаемый выход — принятые снапшоты и счётчики
 * (NTR-12). Рендер подключается к этому же `MatchClient` позже.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flag, option, readMatchFile } from './matchFile.mjs';

const file = process.argv[2];
if (file === undefined || file.startsWith('--')) {
  process.stderr.write('usage: node bin/play.mjs <match.json> --player <id> [--url ws://…] [--keys]\n');
  process.exit(2);
}

const { contentPack } = await import('../src/content/pack.ts');
const { MatchClient } = await import('../src/client/matchClient.ts');
const { ClientHost } = await import('../src/client/host.ts');
const { connectWebSocket } = await import('../src/transport/webSocketClient.ts');
const { jsonSerializer, msgpackSerializer } = await import('../src/protocol/codec.ts');
const { fixed } = await import('@game-mvp/core');

const match = readMatchFile(file);
const playerId = option('player', match.players[0]);
const url = option('url', 'ws://127.0.0.1:8080');
const observer = flag('observer');

// Клиент берёт из файла матча ровно две вещи: свой контент-пак и идентификатор
// сборки. Всё остальное — слот, seed, расстановку, темп — он узнаёт из
// `Welcome` (NTR-5), как и в бою.
const pack = contentPack(match.scenes);

const STEP = fixed.fromFloat(0.15);
const IDLE = { move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 };

/** Сценарий ввода из файла: `[{ "tick": 10, "moveX": 0.15, "buttons": 1 }, …]`. */
function scriptedInput(path) {
  const script = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'));
  const byTick = new Map(script.map((entry) => [entry.tick, entry]));
  return (tick) => {
    const entry = byTick.get(tick);
    if (entry === undefined) return undefined;
    return {
      move: { x: fixed.fromFloat(entry.moveX ?? 0), y: fixed.fromFloat(entry.moveY ?? 0) },
      aimDir: fixed.fromFloat(entry.aimDir ?? 0),
      buttons: entry.buttons ?? 0,
    };
  };
}

/**
 * Клавиатура в терминале даёт нажатие, но не отпускание, поэтому удержание
 * эмулируется: клавиша задаёт направление на ~200 мс. Для замера отклика этого
 * достаточно — измеряется задержка от нажатия до появления в снапшоте.
 */
function keyboardInput() {
  const HOLD_TICKS = 12;
  let move = { x: 0, y: 0 };
  let holdUntil = 0;
  let buttons = 0;
  let buttonsUntil = 0;

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === '\u0003') process.exit(0); // Ctrl+C в raw-режиме сигнала не даёт
    if (key === 'w') move = { x: 0, y: STEP };
    else if (key === 's') move = { x: 0, y: -STEP };
    else if (key === 'a') move = { x: -STEP, y: 0 };
    else if (key === 'd') move = { x: STEP, y: 0 };
    else if (key === ' ') buttons = 1;
    else return;
    holdUntil = current + HOLD_TICKS;
    if (buttons === 1) buttonsUntil = current + 1;
  });

  let current = 0;
  return (tick) => {
    current = tick;
    const sample = {
      move: tick < holdUntil ? move : { x: 0, y: 0 },
      aimDir: 0,
      buttons: tick < buttonsUntil ? buttons : 0,
    };
    if (tick >= buttonsUntil) buttons = 0;
    return sample;
  };
}

const input = flag('keys')
  ? keyboardInput()
  : option('script', undefined) !== undefined
    ? scriptedInput(option('script'))
    : () => IDLE;

const client = new MatchClient({
  playerId,
  version: { buildId: match.buildId, contentPackHash: pack.hash },
  content: pack,
  observer,
});

const transport = await connectWebSocket(url);
const host = new ClientHost(client, transport, {
  serializer: flag('json') ? jsonSerializer : msgpackSerializer,
  input,
});

process.stdout.write(
  `подключён к ${url} как ${observer ? 'наблюдатель' : playerId}\n` +
    `  версия: ${match.buildId} + ${pack.hash}\n` +
    (flag('keys') ? '  управление: WASD — движение, пробел — каст, Ctrl+C — выход\n\n' : '\n'),
);

host.start();
host.run();

const report = setInterval(() => {
  if (client.phase === 'closed') {
    clearInterval(report);
    process.stdout.write(`\nсоединение закрыто: ${client.closeReason} — ${client.closeDetail}\n`);
    process.exit(0);
  }
  const metrics = client.metrics;
  const response = metrics.inputToVisibleMs === undefined ? '—' : `${metrics.inputToVisibleMs.toFixed(0)} мс`;
  const lag = metrics.bufferLagMs === undefined ? '—' : `${metrics.bufferLagMs.toFixed(0)} мс`;
  process.stdout.write(
    `\r[${client.phase}] слот ${client.slot ?? '—'}  тик ${client.serverTick}  ` +
      `снапшотов ${metrics.snapshotsApplied} (отброшено ${metrics.snapshotsDropped})  ` +
      `нажал→увидел ${response}  буфер ${lag}   `,
  );
}, 500);

const shutdown = () => {
  clearInterval(report);
  host.stop();
  transport.close('выход');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
