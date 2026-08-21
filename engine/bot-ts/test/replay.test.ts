/**
 * Детерминизм-нейтральность мозга (BOT-5): матч с ботом воспроизводится от
 * ЗАПИСАННЫХ ВВОДОВ побитово, и мозг при реплее не исполняется и не нужен.
 *
 * Это то самое место, где «внутри мозга допустимы float, wall-clock и несеяная
 * случайность» перестаёт быть опасным: единственный канал влияния мозга на
 * симуляцию — обычные `InputFrame` (`tick-loop` TICK-2), а они канонические
 * данные. Оракул — та же реплей-парность, что у матча людей (NTR-8, CLI-10).
 */
import { describe, expect, it } from 'vitest';
import { runScenario, runScenarioBytes, snapshotToPlain } from '@game-mvp/core';
import type { BotBrainFactory } from '../src/brain.js';
import { BotHost } from '../src/host.js';
import { evaluatedBrain } from '../src/brains/evaluated/evaluatedBrain.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  settle,
  stepMatch,
  testBehavior,
  testProfile,
  STEP,
} from './fixtures.js';

/** Счётчик обращений к мозгу: реплей обязан не увеличить его ни на единицу. */
function counting(inner: BotBrainFactory, counters: { observe: number; sample: number }): BotBrainFactory {
  return (profile, self) => {
    const brain = inner(profile, self);
    return {
      observe(step) {
        counters.observe++;
        brain.observe(step);
      },
      sample(tick) {
        counters.sample++;
        return brain.sample(tick);
      },
    };
  };
}

describe('реплей матча с ботом (BOT-5)', () => {
  it('прогон сценария даёт побитово то состояние, в котором остановился сервер', async () => {
    const counters = { observe: 0, sample: 0 };
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1', (tick) =>
      tick <= 40 ? { move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined,
    );
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: counting(evaluatedBrain({ behavior: testBehavior() }), counters),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 45; i++) await stepMatch(fixture, [human.host, seat]);

    expect(counters.observe).toBeGreaterThan(0);
    expect(counters.sample).toBeGreaterThan(0);
    const scenario = fixture.server.toScenario();
    const played = { observe: counters.observe, sample: counters.sample };

    const replay = runScenario(scenario);

    // Мозг при реплее не исполняется: сценарий несёт вводы, а не решения.
    expect(counters).toEqual(played);
    expect(replay.worldInitHash).toBe(fixture.server.worldInitHash);
    expect(replay.ticks).toHaveLength(fixture.server.tick + 1);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(
      snapshotToPlain(fixture.server.snapshot()),
    );
    bots.dispose();
  });

  it('повторный реплей побитово равен первому — мозг в эталон не входит', async () => {
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: evaluatedBrain({ behavior: testBehavior() }),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 30; i++) await stepMatch(fixture, [human.host, seat]);

    const scenario = fixture.server.toScenario();
    const first = Buffer.from(runScenarioBytes(scenario));
    const second = Buffer.from(runScenarioBytes(scenario));
    expect(second.equals(first)).toBe(true);
    // Ввод бота в записи — обычные кадры игрока: ни следа мозга, ни профиля.
    const text = JSON.stringify(scenario.inputs);
    expect(text).not.toContain('profile');
    expect(text).not.toContain('brain');
    bots.dispose();
  });

  /**
   * То же, но профилем НОВОГО вида (BOT-6): бот отдаёт точку прицела и биты
   * подтверждения, они уезжают проводом (`netcode-transport` NTR-7) и ложатся в
   * канонический `inputs[]`. Реплей от записанных вводов обязан быть побитовым
   * и здесь — иначе точка на проводе стала бы каналом недетерминизма (CLI-10).
   */
  it('матч с фазовым кастом бота воспроизводится побитово от записанных вводов', async () => {
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: evaluatedBrain({ behavior: testBehavior() }),
      profile: testProfile({
        abilities: [
          {
            name: 'fireball',
            button: 0,
            target: 'enemy',
            range: 20,
            holdTicks: 1,
            cooldownTicks: 10,
            weight: 1,
            cast: {
              slotIndex: 0,
              commit: 'confirm' as const,
              confirmButton: 8,
              cancelButton: 9,
              holdTicks: 3,
              cancelChance: 0,
              giveUpTicks: 12,
              steps: [
                { aim: 'enemy', confirmDelayTicks: 1, pointNoise: 0 },
                { aim: 'self', confirmDelayTicks: 1, pointNoise: 0 },
              ],
            },
          },
        ],
      }),
    });
    await settle();
    for (let i = 0; i < 40; i++) await stepMatch(fixture, [human.host, seat]);

    const scenario = fixture.server.toScenario();
    // Точка и бит подтверждения ДЕЙСТВИТЕЛЬНО доехали до канонического лога:
    // без этого тест проверял бы реплей пустого потока.
    const botFrames = (scenario.inputs ?? []).filter((frame) => frame.playerId === 'bot-1');
    expect(botFrames.some((frame) => frame.target !== undefined)).toBe(true);
    expect(botFrames.some((frame) => (frame.buttons & (1 << 8)) !== 0)).toBe(true);

    const replay = runScenario(scenario);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(
      snapshotToPlain(fixture.server.snapshot()),
    );
    const first = Buffer.from(runScenarioBytes(scenario));
    expect(Buffer.from(runScenarioBytes(scenario)).equals(first)).toBe(true);
    bots.dispose();
  });
});
