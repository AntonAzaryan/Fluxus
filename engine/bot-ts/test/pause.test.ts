/**
 * Бот на паузе матча (`netcode-transport` NTR-20, решение D9): спец-логики нет,
 * и это закрепляется тестом, а не обещанием.
 *
 * Бот — обычный клиент (BOT-1): в заморозке ему не приходят живые снапшоты, его
 * `Input` сервер отбрасывает, а `Pause` разбирается клиентом и мозгу не
 * доставляется вовсе — состояние паузы не факт мира (OBS-1) и в наблюдаемый
 * выход шага не входит.
 *
 * Что проверяется, кроме «не упало»: мозг не зацикливается на длинной паузе
 * (наблюдения продолжают приходить ровно по шагу, а не пачкой), очередь фактов
 * не копится (в заморозке фактов не порождается), и после возобновления бот
 * продолжает играть тем же клиентом — без реконнекта и без сброса.
 */
import { describe, expect, it } from 'vitest';
import type { ClientStep, MatchPauseOptions } from '@fluxus/net';
import { BotHost } from '../src/host.js';
import { walkToCenter } from '../src/brains/scripted.js';
import type { BotBrain, BotBrainFactory } from '../src/brain.js';
import type { BotIntent } from '../src/boundary.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  settle,
  stepMatch,
  testProfile,
  TICK_RATE,
} from './fixtures.js';

/** Политика паузы матча теста — числа документа, не сервера (NTR-20). */
const PAUSE: MatchPauseOptions = { budgetPerPlayer: 1, resumeCountdownMs: 100 };
/** Отсчёт в 100 мс при 60 Гц — шесть шагов расписания. */
const RESUME_STEPS = 6;

interface BrainLog {
  observed: ClientStep[];
  samples: number;
}

/** Мозг-счётчик поверх обычного: считает наблюдения и съёмы, ходит как ходил. */
function countingBrain(log: BrainLog): BotBrainFactory {
  return (profile, match): BotBrain => {
    const inner = walkToCenter(profile, match);
    return {
      observe(step) {
        log.observed.push(step);
        inner.observe(step);
      },
      sample(tick): BotIntent | undefined {
        log.samples++;
        return inner.sample(tick);
      },
    };
  };
}

describe('бот на паузе матча (NTR-20, D9)', () => {
  it('мозг не зацикливается и не копит очередь на длинной паузе', async () => {
    const config = duelConfig({ pause: PAUSE, silenceTicks: 100_000 });
    const fixture = harness(config);
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const log: BrainLog = { observed: [], samples: 0 };
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: countingBrain(log),
      profile: testProfile(),
    });
    await settle();

    for (let i = 0; i < 10; i++) await stepMatch(fixture, [human.host, seat]);
    const beforeTick = fixture.server.tick;
    expect(beforeTick).toBeGreaterThan(0);
    const observedBefore = log.observed.length;

    // Паузу ставит человек своим запросом (NTR-20) — бот о ней ничего не знает.
    human.client.requestPause('pause');
    await stepMatch(fixture, [human.host, seat]);
    expect(fixture.server.pauseState).toBe('frozen');

    // Пауза длиной в пять секунд по расписанию матча. Ровно столько же, сколько
    // тридцать, доказывает утверждения ниже — «наблюдал по шагу» и «очередь не
    // копится» суть свойства КАЖДОГО шага заморозки, а не её длительности, — а
    // тысяча восемьсот кругов лупбэка стоила бы больше умолчания vitest в 5000
    // мс и роняла бы гейт по таймауту, а не по предмету теста.
    const frozenSteps = TICK_RATE * 5;
    for (let i = 0; i < frozenSteps; i++) await stepMatch(fixture, [human.host, seat]);

    // Живых тиков не было — матч стоит там, где его застали (NTR-20).
    expect(fixture.server.tick).toBe(beforeTick);
    // Мозг наблюдал РОВНО по шагу: ни пропусков, ни залпа накопленного.
    expect(log.observed.length - observedBefore).toBe(frozenSteps + 1);
    // Очередь фактов не копилась: в заморозке событий не порождается вовсе.
    expect(seat.client.pendingEvents).toEqual([]);
    // И клиент бота жив: заморозка соединения не рвёт.
    expect(seat.closed).toBe(false);
    expect(seat.client.phase).toBe('playing');

    // Состояние паузы бот РАЗОБРАЛ — иначе кадр порвал бы соединение (NTR-4), —
    // и держит его наравне с человеком; мозгу оно не доставляется.
    expect(seat.client.pause).toMatchObject({ state: 'frozen', slot: 0 });

    // Возобновление — и бот продолжает играть тем же клиентом.
    human.client.requestPause('resume');
    for (let i = 0; i < RESUME_STEPS + 4; i++) await stepMatch(fixture, [human.host, seat]);
    expect(fixture.server.mode).toBe('Running');
    expect(fixture.server.tick).toBeGreaterThan(beforeTick);
    expect(seat.client.pause).toMatchObject({ state: 'running' });
    expect(seat.client.slot).toBe(1);
    expect(log.samples).toBeGreaterThan(0);

    bots.dispose();
  });

  it('ввод бота в заморозке отбрасывается сервером и счётчиков не искажает', async () => {
    const config = duelConfig({ pause: PAUSE, silenceTicks: 100_000 });
    const fixture = harness(config);
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: walkToCenter,
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 10; i++) await stepMatch(fixture, [human.host, seat]);

    human.client.requestPause('pause');
    await stepMatch(fixture, [human.host, seat]);
    const slot = { ...fixture.server.metrics.slots[1]! };
    const sentBefore = seat.client.metrics.inputsSent;

    for (let i = 0; i < 30; i++) await stepMatch(fixture, [human.host, seat]);

    // Бот шлёт ввод как ни в чём не бывало — спец-логики «молчать в паузе» у
    // него нет и не нужно (D9): сервер отбрасывает эти кадры молча.
    expect(seat.client.metrics.inputsSent).toBeGreaterThan(sentBefore);
    const after = fixture.server.metrics.slots[1]!;
    expect(after.applied).toBe(slot.applied);
    expect(after.late).toBe(slot.late);
    expect(after.outOfWindow).toBe(slot.outOfWindow);
    expect(after.predicted).toBe(slot.predicted);

    bots.dispose();
  });
});
