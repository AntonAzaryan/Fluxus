/**
 * Хостинг как таковой: что мозг узнаёт о матче, что случается с каналом на
 * `dispose`, что делает собственный темп `run()` и почему домены ввода
 * нельзя обойти изнутри мозга (BOT-2, BOT-4, BOT-5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixed } from '@fluxus/core';
import type { Transport } from '@fluxus/net';
import type { BotBrain, BotBrainFactory, BotSelf } from '../src/brain.js';
import type { BotIntent } from '../src/boundary.js';
import { BotHost } from '../src/host.js';
import { walkToCenter } from '../src/brains/scripted.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  settle,
  stepMatch,
  testProfile,
} from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Мозг-регистратор «кто я»: играть не пытается. */
function capturing(sink: BotSelf[]): BotBrainFactory {
  return (_profile, self): BotBrain => {
    sink.push(self);
    return { observe: () => undefined, sample: () => undefined };
  };
}

describe('мозг узнаёт о матче ровно то, что узнал его клиент (BOT-3, NTR-7)', () => {
  it('темп матча приезжает из `Welcome`, а не константой сборки', async () => {
    const selves: BotSelf[] = [];
    const fixture = harness(duelConfig({ tickRate: 30, snapshotRate: 30 }));
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: capturing(selves),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 5; i++) await stepMatch(fixture, [human.host, seat]);

    expect(selves).toHaveLength(1);
    expect(selves[0]!.tickRate).toBe(30);
    expect(seat.client.pacing?.tickRate).toBe(30);
    bots.dispose();
  });
});

describe('уход бота из матча (BOT-1)', () => {
  it('`dispose` закрывает канал, а не бросает его молча', async () => {
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const transport: Transport = fixture.hub.connect();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: walkToCenter,
      profile: testProfile(),
      transport,
    });
    await settle();
    for (let i = 0; i < 5; i++) await stepMatch(fixture, [human.host, seat]);
    expect(transport.isClosed).toBe(false);

    bots.dispose();
    await settle();

    // Канал закрыт с нашей стороны — сервер видит уход сразу, а не по порогу
    // молчания; на портах это же закрытие отпускает сам порт.
    expect(transport.isClosed).toBe(true);
    expect(seat.closed).toBe(true);
    expect(bots.seats).toHaveLength(0);
  });
});

describe('собственный темп хоста (BOT-4)', () => {
  it('`run()` двигает ботов сам: клиент входит в матч и шлёт ввод без ручных шагов', async () => {
    vi.useFakeTimers();
    const fixture = harness(duelConfig({ players: ['bot-1'] }));
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: walkToCenter,
      profile: testProfile(),
    });
    fixture.host.start();
    bots.run();

    await vi.advanceTimersByTimeAsync(500);

    expect(seat.client.phase).toBe('playing');
    expect(seat.client.metrics.inputsSent).toBeGreaterThan(0);
    bots.dispose();
    await fixture.host.stop();
  });

  it('таймер останавливается, когда каналы всех ботов закрыты', async () => {
    vi.useFakeTimers();
    const fixture = harness(duelConfig({ players: ['bot-1'] }));
    const bots = new BotHost();
    const transport: Transport = fixture.hub.connect();
    connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: walkToCenter,
      profile: testProfile(),
      transport,
    });
    bots.run();
    expect(vi.getTimerCount()).toBe(1);

    // Матч кончился (End, разрыв, отказ) — канал закрыт.
    transport.close('матч окончен');
    await vi.advanceTimersByTimeAsync(100);

    // Темп ведёт хост, поэтому и остановиться обязан он: иначе воркер
    // доигравшего матча крутил бы 60 Гц до конца процесса.
    expect(bots.finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    bots.dispose();
  });
});

describe('домены ввода не обходятся изнутри мозга (BOT-5, INP-3)', () => {
  it('сверхчеловеческое намерение доезжает до сервера зажатым', async () => {
    const greedy: BotBrainFactory = (): BotBrain => ({
      observe: () => undefined,
      sample: (): BotIntent => ({
        moveX: 50,
        moveY: 50,
        aimRadians: 1,
        // Бит вне ширины `buttons` (TICK-2) — на проводе его быть не может.
        buttons: 1 << 20,
      }),
    });
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: greedy,
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 20; i++) await stepMatch(fixture, [human.host, seat]);

    const frames = (fixture.server.toScenario().inputs ?? []).filter(
      (frame) => frame.playerId === 'bot-1',
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const length = Math.hypot(fixed.toFloat(frame.move.x), fixed.toFloat(frame.move.y));
      expect(length).toBeLessThanOrEqual(1 + 1e-4);
      expect(frame.buttons).toBe(0);
    }
    bots.dispose();
  });
});
