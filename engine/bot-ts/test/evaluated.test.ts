/**
 * Evaluated-мозг (BOT-8, BOT-9, BOT-10, BOT-11): выбор действия по документу,
 * каденс передумывания из профиля, трасса решений и детерминизм.
 *
 * Поток наблюдений здесь НАСТОЯЩИЙ — шаги клиента, записанные в loopback-матче:
 * синтетический снапшот проверял бы разбор фикстуры, а не мозг за границей
 * BOT-3.
 */
import { describe, expect, it } from 'vitest';
import type { ClientStep } from '@fluxus/net';
import type { BotBrain } from '../src/brain.js';
import type { BotIntent } from '../src/boundary.js';
import type { BotBehaviorDocument } from '../src/behavior.js';
import { evaluatedBrain } from '../src/brains/evaluated/evaluatedBrain.js';
import type { BotDecisionRecord } from '../src/brains/evaluated/scoring.js';
import { aimToRadians } from '../src/boundary.js';
import { BotHost } from '../src/host.js';
import type { BotProfile } from '../src/profile.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  recordSteps,
  settle,
  stepMatch,
  testBehavior,
  testProfile,
} from './fixtures.js';

const SELF = { playerId: 'bot-1', slot: 1, tickRate: 60 };

interface RunOptions {
  readonly profile?: BotProfile;
  readonly behavior?: BotBehaviorDocument;
  readonly onDecision?: (record: BotDecisionRecord) => void;
}

function brainOf(options: RunOptions): BotBrain {
  const factory = evaluatedBrain({
    behavior: options.behavior ?? testBehavior(),
    ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
  });
  return factory(options.profile ?? testProfile(), SELF);
}

/** Прогон мозга по записанному потоку наблюдений: намерение на каждый шаг. */
function replay(steps: readonly ClientStep[], options: RunOptions = {}): BotIntent[] {
  const brain = brainOf(options);
  const intents: BotIntent[] = [];
  for (const step of steps) {
    brain.observe(step);
    const tick = step.state?.to.tick;
    if (tick === undefined) continue;
    const intent = brain.sample(tick);
    if (intent !== undefined) intents.push(intent);
  }
  return intents;
}

describe('выбор действия по документу (BOT-8)', () => {
  it('мозг играет по документу: намерения есть, и они не пустые', async () => {
    const recorded = await recordSteps(duelConfig(), 40);
    const intents = replay(recorded.steps);
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.some((intent) => Math.hypot(intent.moveX, intent.moveY) > 0)).toBe(true);
  });

  /**
   * Новое поведение — правка ДОКУМЕНТА (BOT-8, сценарий «Новое поведение без
   * правки кода»): тот же мозг, тот же профиль, тот же поток наблюдений — и
   * другой выбор, потому что дизайнер поменял вес.
   */
  it('иной документ — иное поведение при том же коде и профиле', async () => {
    const recorded = await recordSteps(duelConfig(), 40);
    const chosen = (behavior: BotBehaviorDocument): string[] => {
      const decisions: string[] = [];
      replay(recorded.steps, { behavior, onDecision: (record) => decisions.push(record.chosen) });
      return decisions;
    };
    const base = chosen(testBehavior());
    // На этой дистанции документ тестов выбирает кайт. Дизайнер хочет бота
    // напористее — и это правка ОДНОЙ оси: давление перестаёт зависеть от
    // дистанции и начинает выигрывать у кайта всегда.
    const document = testBehavior();
    const pushy = chosen({
      ...document,
      actions: document.actions.map((action) =>
        action.executor === 'pressure'
          ? {
              ...action,
              considerations: [
                { input: 'enemyKnown', curve: { type: 'constant', value: 1 }, weight: 1 },
              ],
            }
          : action,
      ),
    });
    expect(base.length).toBeGreaterThan(0);
    expect(base.some((executor) => executor === 'kite')).toBe(true);
    expect(pushy).not.toEqual(base);
    expect(pushy.some((executor) => executor === 'pressure')).toBe(true);
  });

  /** BOT-9: умолчание при нулевых очках — механизм, а не запись документа. */
  it('документ, не набравший очков, оставляет бота на умолчании механизма', async () => {
    const recorded = await recordSteps(duelConfig(), 30);
    const silent: BotBehaviorDocument = {
      ...testBehavior(),
      // Единственное действие гейтится летящим снарядом, а их в этом матче нет.
      actions: [
        {
          executor: 'kite',
          considerations: [
            { input: 'threatClosing', curve: { type: 'linear', slope: 1, intercept: 0 }, weight: 1 },
          ],
        },
      ],
    };
    const decisions: BotDecisionRecord[] = [];
    const intents = replay(recorded.steps, {
      behavior: silent,
      onDecision: (record) => decisions.push(record),
    });
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((record) => record.utility === 0)).toBe(true);
    expect(decisions.every((record) => record.chosen === 'retreat')).toBe(true);
    // Бот при этом остаётся живым: намерение отдаётся каждый шаг.
    expect(intents.length).toBeGreaterThan(0);
  });
});

describe('каденс передумывания из профиля (BOT-6)', () => {
  it('между пересчётами документ не считается вовсе', async () => {
    const recorded = await recordSteps(duelConfig(), 60);
    const slow = testProfile({ decision: { intervalTicks: 20, jitterTicks: 0 } });
    const ticks: number[] = [];
    replay(recorded.steps, { profile: slow, onDecision: (record) => ticks.push(record.tick) });
    expect(ticks.length).toBeGreaterThan(1);
    for (const [index, tick] of ticks.entries()) {
      if (index === 0) continue;
      expect(tick - ticks[index - 1]!).toBeGreaterThanOrEqual(20);
    }
  });
});

/**
 * Трасса решений (BOT-10) — ЧИСТОЕ наблюдение: её включение не меняет ни одного
 * намерения. Проверяется это единственным честным способом — двумя прогонами на
 * одном потоке, отличающимися только колбэком.
 */
describe('трасса решений (BOT-10)', () => {
  it('включённая трасса не меняет последовательность намерений', async () => {
    const recorded = await recordSteps(duelConfig(), 50);
    const silent = replay(recorded.steps);
    const records: BotDecisionRecord[] = [];
    const traced = replay(recorded.steps, { onDecision: (record) => records.push(record) });
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(traced)).toBe(JSON.stringify(silent));
  });

  /** BOT-10, сценарий «Дизайнер спрашивает „почему бот отступил“». */
  it('разбор пересчёта показывает оценки всех осей и победителя', async () => {
    const recorded = await recordSteps(duelConfig(), 30);
    const records: BotDecisionRecord[] = [];
    replay(recorded.steps, { onDecision: (record) => records.push(record) });
    const record = records[records.length - 1]!;
    expect(record.actions.map((action) => action.executor)).toEqual([
      'pressure',
      'kite',
      'retreat',
      'dodge',
    ]);
    for (const action of record.actions) {
      expect(action.considerations.length).toBeGreaterThan(0);
      for (const consideration of action.considerations) {
        expect(consideration.score).toBeGreaterThanOrEqual(0);
        expect(consideration.score).toBeLessThanOrEqual(1);
      }
      // Полезность действия — произведение его осей, и диапазон она сохраняет.
      const product = action.considerations.reduce((acc, entry) => acc * entry.score, 1);
      expect(action.utility).toBeCloseTo(product, 12);
    }
    // Победитель назван, и его полезность — максимум по действиям.
    const best = Math.max(...record.actions.map((action) => action.utility));
    expect(record.utility).toBe(best);
    expect(record.actions.some((action) => action.executor === record.chosen)).toBe(true);
  });
});

/**
 * Детерминизм evaluator'а (BOT-11): два прогона от одной четвёрки «документ,
 * профиль, seed, поток наблюдений» дают одну и ту же последовательность
 * намерений. Wall-clock мозг не читает вовсе, поэтому равенство здесь точное, а
 * не «в пределах допуска».
 */
describe('детерминизм evaluator (BOT-11)', () => {
  it('два прогона на одном потоке с одним seed — одни намерения', async () => {
    const recorded = await recordSteps(duelConfig(), 60);
    const noisy = testProfile({
      // Человечность включена намеренно: именно она берёт числа из потока
      // случайности, и на несеяном генераторе прогоны разошлись бы.
      reaction: { delayTicks: 6, jitterTicks: 3, memoryTicks: 120 },
      aim: { noiseDegrees: 8, noisePeriodTicks: 7 },
      decision: { intervalTicks: 5, jitterTicks: 3 },
    });
    const first = replay(recorded.steps, { profile: noisy });
    const second = replay(recorded.steps, { profile: noisy });
    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('другой seed — другая последовательность: случайность мозга сеяна, а не выключена', async () => {
    const recorded = await recordSteps(duelConfig(), 60);
    const shape = { aim: { noiseDegrees: 8, noisePeriodTicks: 7 } };
    const first = replay(recorded.steps, { profile: testProfile({ ...shape, seed: 1 }) });
    const second = replay(recorded.steps, { profile: testProfile({ ...shape, seed: 2 }) });
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });
});

describe('evaluated-мозг в матче', () => {
  it('играет за свой слот: шлёт ввод и жмёт способность по врагу в дальности', async () => {
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: evaluatedBrain({ behavior: testBehavior(), tickSeconds: 1 / 60 }),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 60; i++) await stepMatch(fixture, [human.host, seat]);

    const frames = fixture.server.toScenario().inputs ?? [];
    const botFrames = frames.filter((frame) => frame.playerId === 'bot-1');
    expect(botFrames.length).toBeGreaterThan(0);
    // Способность нажата: враг стоит в начале координат, бот стартует рядом.
    expect(botFrames.some((frame) => frame.buttons !== 0)).toBe(true);
    // Прицел лежит в домене угла ядра, как у человека (INP-3, FP-7).
    for (const frame of botFrames) {
      expect(aimToRadians(frame.aimDir)).toBeGreaterThanOrEqual(0);
      expect(frame.buttons).toBeLessThanOrEqual(0xffff);
    }
    bots.dispose();
  });
});
