/**
 * Бот в матче на внутрипроцессном транспорте (BOT-1, BOT-2, BOT-4).
 *
 * Предмет теста — не «бот умеет ходить», а неразличимость: сервер исполняет для
 * бота тот же код, что для человека, и специального пути у бота нет ни в
 * сообщениях, ни в ростере (`net-session` SES-2). Второе — что медленный мозг не
 * сбивает каденс: съём ввода синхронен, и опоздавшее намерение уезжает позже,
 * как запоздавший ввод человека (NTR-7).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SERIALIZER, serverCodec, type ClientMessage, type Transport } from '@fluxus/net';
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
  STEP,
} from './fixtures.js';

/** Транспорт-шпион: записывает типы сообщений, ушедших наверх, и ничего не меняет. */
function spy(transport: Transport, sink: string[]): Transport {
  const codec = serverCodec(DEFAULT_SERIALIZER);
  return {
    get isClosed() {
      return transport.isClosed;
    },
    send(bytes) {
      const message: ClientMessage = codec.decode(bytes);
      sink.push(message.type);
      transport.send(bytes);
    },
    close: (reason) => { transport.close(reason); },
    onMessage: (handler) => { transport.onMessage(handler); },
    onClose: (handler) => { transport.onClose(handler); },
  };
}

/**
 * Мозг, думающий дольше тика (BOT-2, сценарий «Мозг задумался»): решение
 * готовится `thinkTicks` наблюдений и до готовности съём отдаёт прежнее.
 */
function slowBrain(thinkTicks: number, counters: { samples: number; undefineds: number }): BotBrainFactory {
  return (): BotBrain => {
    let seen = 0;
    let ready: BotIntent | undefined;
    return {
      observe() {
        seen++;
        if (seen % thinkTicks === 0) ready = { moveX: 1, moveY: 0, aimRadians: 0 };
      },
      sample() {
        counters.samples++;
        if (ready === undefined) counters.undefineds++;
        return ready;
      },
    };
  };
}

describe('бот — обычный участник матча (BOT-1)', () => {
  it('подключается, получает слот и шлёт ввод тем же протоколом, что человек', async () => {
    const fixture = harness(duelConfig());
    const botWire: string[] = [];
    const humanWire: string[] = [];
    // Человеку тоже шпион: сравнивать потоки можно только с одинаковой оптикой.
    const human = connectHuman(
      fixture,
      'p1',
      (tick) => (tick <= 40 ? { move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined),
      spy(fixture.hub.connect(), humanWire),
    );
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: walkToCenter,
      profile: testProfile(),
      transport: spy(fixture.hub.connect(), botWire),
    });
    await settle();

    for (let i = 0; i < 40; i++) await stepMatch(fixture, [human.host, seat]);

    expect(seat.client.slot).toBe(1);
    expect(seat.client.phase).toBe('playing');
    expect(seat.client.metrics.inputsSent).toBeGreaterThan(0);
    // Наверх от бота уходят только сообщения матча — Hello и Input, ровно как у
    // человека. Специального сообщения «я бот» в протоколе нет (SES-2).
    expect([...new Set(botWire)].sort()).toEqual(['Hello', 'Input']);
    expect([...new Set(humanWire)].sort()).toEqual([...new Set(botWire)].sort());
    bots.dispose();
  });

  it('записанный матч не содержит признака «этим играл бота» — только имена слотов', async () => {
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: walkToCenter,
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 20; i++) await stepMatch(fixture, [human.host, seat]);

    const scenario = fixture.server.toScenario();
    const text = JSON.stringify(scenario);
    expect(text).not.toContain('bot-player');
    expect(text).not.toContain('"isBot"');
    // Единственный след бота — id игрока в ростере, то есть имя (BOT-1).
    expect(scenario.players).toEqual(['p1', 'bot-1']);
    // Канонический лог знает обоих одинаково: кадры есть у каждого слота.
    const owners = new Set((scenario.inputs ?? []).map((frame) => frame.playerId));
    expect(owners).toEqual(new Set(['p1', 'bot-1']));
    bots.dispose();
  });
});

describe('медленный мозг не сбивает каденс (BOT-2, BOT-4)', () => {
  it('сервер тикает по расписанию, съём ввода происходит каждый тик', async () => {
    const counters = { samples: 0, undefineds: 0 };
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: slowBrain(10, counters),
      profile: testProfile(),
    });
    await settle();

    const ticks = 30;
    for (let i = 0; i < ticks; i++) await stepMatch(fixture, [human.host, seat]);

    // Сервер прошёл своё расписание целиком — «тяжёлое решение мозга» его не
    // задержало (BOT-4, сценарий «Тяжёлое решение мозга»).
    expect(fixture.server.tick).toBe(ticks);
    // Съём случился на каждом тике фазы игры, и часть съёмов ушла впустую —
    // это и есть «отдаётся последнее готовое намерение либо отсутствие ввода».
    expect(counters.samples).toBeGreaterThan(0);
    expect(counters.undefineds).toBeGreaterThan(0);
    expect(seat.client.metrics.inputsSent).toBeGreaterThan(0);
    expect(seat.client.metrics.inputsSent).toBeLessThan(counters.samples);
    bots.dispose();
  });

  it('несколько ботов живут в одном хосте (BOT-4)', async () => {
    const fixture = harness(duelConfig({ players: ['bot-1', 'bot-2', 'bot-3'] }));
    const bots = new BotHost();
    const seats = ['bot-1', 'bot-2', 'bot-3'].map((playerId) =>
      connectBot(fixture, bots, { playerId, brain: walkToCenter, profile: testProfile() }),
    );
    await settle();
    for (let i = 0; i < 20; i++) await stepMatch(fixture, seats);

    expect(bots.seats).toHaveLength(3);
    expect(seats.map((seat) => seat.client.slot)).toEqual([0, 1, 2]);
    for (const seat of seats) expect(seat.client.phase).toBe('playing');
    bots.dispose();
  });
});
