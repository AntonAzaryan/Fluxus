/**
 * Пауза матча и парность записи (`netcode-transport` NTR-20, NTR-8).
 *
 * Предмет — не механика паузы (она проверена в `engine/net-ts`), а то, что
 * симуляция о ней не знает: тики не исполняются, эпоха не растёт, канонический
 * лог записей о паузе НЕ СОДЕРЖИТ, и матч с паузами реплеится ядром побитово —
 * прогоном того же документа сценария, которым проверяются матчи без пауз
 * (NTR-8, CLI-2).
 *
 * Вертикаль настоящая: `MatchServer`, два `MatchClient` и loopback (NTR-12).
 * Пауза приходит от игрока обратным каналом протокола (`PauseRequest`), а не
 * вызовом внутрь сервера, — то есть проверяется тот путь, которым она случится
 * в бою.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain, type InputFrame } from '@fluxus/core';
import type { MatchConfig, MatchServer } from '@fluxus/net';
import {
  TICK_RATE,
  connectClient,
  duelConfig,
  harness,
  settle,
  walkRight,
  type Harness,
} from './fixtures.js';

/**
 * Политика паузы матча теста (NTR-20) — числа документа матча: бюджет на
 * несколько пауз и короткий отсчёт возобновления в сто миллисекунд, то есть
 * шесть шагов расписания при 60 Гц.
 */
const PAUSE_POLICY = { budgetPerPlayer: 4, resumeCountdownMs: 100 } as const;
const RESUME_STEPS = 6;

function config(): MatchConfig {
  // Порог молчания заведомо длиннее прогона: предмет здесь запись, а не
  // окно возврата.
  return duelConfig({ pause: PAUSE_POLICY, silenceTicks: 100_000 });
}

interface Match {
  readonly fixture: Harness;
  /** Один круг расписания: шаги клиентов, доставка, шаг сервера, доставка. */
  round(count?: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

async function playing(): Promise<Match> {
  const matchConfig = config();
  const fixture = harness(matchConfig);
  const build = { physics: matchConfig.physics, visibility: matchConfig.visibility };
  // Непрерывный ввод у обоих: пауза обязана быть невидима записи именно на
  // матче, в котором на каждом тике что-то происходит.
  const a = connectClient(fixture.hub, 'p1', fixture.clock, matchConfig.scene, walkRight(400), build);
  const b = connectClient(fixture.hub, 'p2', fixture.clock, matchConfig.scene, walkRight(400), build);
  await settle();

  const round = async (count = 1): Promise<void> => {
    for (let i = 0; i < count; i++) {
      fixture.clock.ms += 1000 / TICK_RATE;
      a.host.step();
      b.host.step();
      await settle();
      fixture.host.step();
      await settle();
    }
  };

  return {
    fixture,
    round,
    async pause() {
      // Запрос уходит обратным каналом, как из HUD (HUD-2), и доезжает до
      // сервера обычным сообщением закрытого набора (NTR-4).
      a.client.requestPause('pause');
      await round();
    },
    async resume() {
      a.client.requestPause('resume');
      await round(RESUME_STEPS + 1);
    },
  };
}

/**
 * Оракул требования (NTR-8): записанный матч прогоняется ядром в побитово то же
 * состояние. Ассертов о содержании матча рядом не нужно — расхождение ловится
 * сверкой.
 */
function expectReplayParity(server: MatchServer): void {
  const replay = runScenario(server.toScenario());
  expect(replay.worldInitHash).toBe(server.worldInitHash);
  expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
}

/** Номера тиков канонического лога по возрастанию, без повторов. */
function loggedTicks(frames: readonly InputFrame[]): number[] {
  return [...new Set(frames.map((frame) => frame.tick))].sort((left, right) => left - right);
}

describe('матч с паузами реплеится побитово (NTR-20, NTR-8)', () => {
  it('запись прогоняется ядром в то же состояние, и следов паузы в ней нет', async () => {
    const match = await playing();
    const server = match.fixture.server;

    await match.round(20);
    const frozenTick = server.tick;
    expect(frozenTick).toBeGreaterThan(0);

    await match.pause();
    expect(server.pauseState).toBe('frozen');
    // Долгая заморозка: живых тиков в ней нет, эпоха не растёт (NTR-16, NTR-20).
    await match.round(40);
    expect(server.tick).toBe(frozenTick);
    expect(server.epoch).toBe(0);

    await match.resume();
    await match.round(20);
    // Вторая пауза — уже от возобновлённого матча: одна заморозка на запись не
    // похожа на две ровно ничем, и проверить это дешевле, чем рассуждать.
    await match.pause();
    await match.round(15);
    await match.resume();
    await match.round(20);

    expect(server.tick).toBeGreaterThan(frozenTick);
    expect(server.mode).toBe('Running');

    // Сам договор: запись матча с паузами воспроизводится побитово.
    expectReplayParity(server);

    // И в логе нет ни пауз, ни отсчётов — только кадры тиков: сегмент один
    // (перемотки не было, NTR-16), тики идут подряд от первого до последнего, и
    // на каждом ровно по кадру на слот (TICK-2).
    expect(server.canonicalSegments).toHaveLength(1);
    const frames = server.canonicalInputs;
    const ticks = loggedTicks(frames);
    expect(ticks).toEqual(Array.from({ length: server.tick }, (_, i) => i + 1));
    expect(frames).toHaveLength(server.tick * 2);
    // Заморозка не оставила ни одного тика без кадра слота и ни одного лишнего.
    for (const tick of ticks) {
      expect(frames.filter((frame) => frame.tick === tick)).toHaveLength(2);
    }
  });

  it('документ записи не отличим по составу от документа матча без пауз', async () => {
    // Форма записи от паузы не меняется вовсе: те же поля, тот же ростер, то же
    // число тиков, что и у матча, сыгранного без единой заморозки (CLI-2).
    const paused = await playing();
    await paused.round(10);
    await paused.pause();
    await paused.round(30);
    await paused.resume();
    await paused.round(10);

    const plain = await playing();
    await plain.round(paused.fixture.server.tick);

    const a = paused.fixture.server.toScenario();
    const b = plain.fixture.server.toScenario();
    expect(a.ticks).toBe(b.ticks);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.players).toEqual(b.players);
    expectReplayParity(paused.fixture.server);
  });
});
