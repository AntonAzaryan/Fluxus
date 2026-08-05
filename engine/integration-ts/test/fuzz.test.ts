/**
 * Фазз-смоук (CLI-9): случайные потоки ввода от фиксированного seed через
 * публичный xorshift ядра. Оракул — реплей-парность NTR-8: записанный матч
 * обязан побитово воспроизводиться прогоном сценария, поэтому ассерты о
 * содержании матча не нужны — любое расхождение состояния ловится сверкой.
 *
 * Бюджет тиков фиксирован: расширение пространства сценариев — новыми
 * seed'ами и фикстурами, а не удлинением этого прогона.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain } from '@game-mvp/core';
import { fuzzInput, playMatch, type PlayedMatch } from './fixtures.js';

const TICKS = 90;
const SEED = 20260805;

function play(): Promise<PlayedMatch> {
  return playMatch(TICKS, {
    a: fuzzInput(SEED, 'fuzz-p1', TICKS + 64),
    b: fuzzInput(SEED, 'fuzz-p2', TICKS + 64),
  });
}

describe('фазз с фиксированным seed (CLI-9)', () => {
  it('прогон воспроизводим и реплеится побитово (NTR-8)', async () => {
    const first = await play();
    const second = await play();

    // Два независимых матча от одного seed — один и тот же матч целиком:
    // мир, канонический лог, финальное состояние.
    expect(first.server.worldInitHash).toBe(second.server.worldInitHash);
    expect(second.server.canonicalInputs).toEqual(first.server.canonicalInputs);
    expect(snapshotToPlain(second.server.snapshot())).toEqual(snapshotToPlain(first.server.snapshot()));

    // Реплей-парность: канонический лог, прогнанный ядром как сценарий,
    // даёт побитово то состояние, в котором остановился сервер.
    const replay = runScenario(first.server.toScenario());
    expect(replay.worldInitHash).toBe(first.server.worldInitHash);
    expect(replay.ticks).toHaveLength(first.server.tick + 1);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(first.server.snapshot()));

    // Вертикаль пережила фазз: мост дожил до последнего снапшота клиента.
    expect(first.bridge.host.view.tick).toBe(first.b.client.latest!.tick);
  });
});
