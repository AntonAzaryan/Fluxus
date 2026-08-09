/**
 * Общее двум играющим запускалкам: источник ввода и отчёт по счётчикам.
 *
 * Вынесено потому, что играющих сторон стало две — присоединяющийся
 * (`play.mjs`) и игрок-хост (`host.mjs`), — а клиент у них один и тот же
 * (`net-session` SES-6). Разойтись им в способе брать ввод и показывать
 * счётчики означало бы сравнивать два разных прогона.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flag, option } from './matchFile.mjs';

const { fixed } = await import('@game-mvp/core');

/** Один шаг в Q16.16 — заметное движение, которое видно в снапшоте. */
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

/** Источник ввода по флагам командной строки: клавиатура, сценарий или покой. */
export function inputSource() {
  if (flag('keys')) return keyboardInput();
  const script = option('script', undefined);
  return script !== undefined ? scriptedInput(script) : () => IDLE;
}

/**
 * Отчёт по счётчикам клиента (NTR-11). `prefix` — то, что у сторон различается:
 * присоединяющийся знает свою фазу, хост — ещё и состояние матча.
 */
export function reportClient(client, prefix, onClosed) {
  return setInterval(() => {
    if (client.phase === 'closed') {
      onClosed?.(client);
      return;
    }
    const metrics = client.metrics;
    const response = metrics.inputToVisibleMs === undefined ? '—' : `${metrics.inputToVisibleMs.toFixed(0)} мс`;
    const lag = metrics.bufferLagMs === undefined ? '—' : `${metrics.bufferLagMs.toFixed(0)} мс`;
    process.stdout.write(
      `\r${prefix()}  снапшотов ${metrics.snapshotsApplied} (отброшено ${metrics.snapshotsDropped})  ` +
        `нажал→увидел ${response}  буфер ${lag}   `,
    );
  }, 500);
}
