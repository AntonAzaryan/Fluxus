/**
 * Бот-заполнитель слота (BOT-7) на внутрипроцессном транспорте (NTR-2, NTR-12):
 * тот же `MatchServer`, тот же `MatchClient`, та же сборка бота, что играют по
 * сети, — подменён только транспорт.
 *
 * Три сценария требования проверяются буквально: друг успел до заморозки,
 * никто не пришёл, человек пришёл после старта. Четвёртый тест — про то, чего
 * в сервере нет: он не различает ботов и людей (BOT-1), и «уступка — политика
 * сборки» держится тем, что канонический лог матча с ботом во втором слоте
 * побитово совпадает с логом матча, где тот же ввод подавал человек.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixed, type InputFrame } from '@game-mvp/core';
import { BotHost } from '../src/host.js';
import { BotSlotFiller, type FillSchedule } from '../src/fill.js';
import type { BotIntent } from '../src/boundary.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  settle,
  stepMatch,
  testProfile,
  type Harness,
} from './fixtures.js';

const PLAYERS = ['p1', 'p2'] as const;
/** Шаг ввода, одинаковый у человека и у бота: сравнивать логи иначе нечем. */
const MOVE = 0.15;

/** Ручной планировщик: дедлайн наступает вызовом теста, а не течением времени. */
function manualSchedule(): { schedule: FillSchedule; run: () => void; pending: () => boolean } {
  let queued: (() => void) | null = null;
  return {
    schedule: (run) => {
      queued = run;
      return 1;
    },
    run: () => {
      const task = queued;
      queued = null;
      task?.();
    },
    pending: () => queued !== null,
  };
}

/** Мозг с постоянным намерением: ввод бота предсказуем и сравним с человеческим. */
function steadyBrain(intent: BotIntent) {
  return () => ({ observe: () => {}, sample: () => intent });
}

/**
 * Заполнитель поверх фикстуры: `attach` — обычная посадка бота (свой транспорт,
 * свой `MatchClient`), а не особый путь.
 */
function filler(
  fixture: Harness,
  bots: BotHost,
  options: {
    readonly reserved?: readonly string[];
    readonly schedule?: FillSchedule;
    readonly intent?: BotIntent;
  } = {},
): BotSlotFiller {
  return new BotSlotFiller({
    players: fixture.config.players,
    attach: (playerId) =>
      connectBot(fixture, bots, {
        playerId,
        profile: testProfile(),
        brain: steadyBrain(options.intent ?? { moveX: 0, moveY: 0, aimRadians: 0 }),
      }),
    frozen: () => fixture.server.phase !== 'lobby',
    ...(options.reserved !== undefined ? { reserved: options.reserved } : {}),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });
}

describe('бот держит слот до заморозки ростера (BOT-7)', () => {
  it('друг успел до старта: слот достаётся человеку, бот в матч не входит', async () => {
    const fixture = harness(duelConfig({ players: [...PLAYERS] }));
    const timer = manualSchedule();
    const bots = new BotHost();
    const fill = filler(fixture, bots, { reserved: ['p1'], schedule: timer.schedule });
    fill.arm();

    // Оба человека приходят ДО дедлайна — штатным `Hello`, ничего не зная ни о
    // каком боте: отзывать нечего, потому что бота в слоте ещё нет.
    const founder = connectHuman(fixture, 'p1');
    await settle();
    const friend = connectHuman(fixture, 'p2');
    await settle();

    expect(founder.client.slot).toBe(0);
    expect(friend.client.slot).toBe(1);
    // Ростер заморожен вторым `Welcome` (SES-4): матч пошёл.
    expect(fixture.server.phase).toBe('running');

    // Дедлайн наступает уже после заморозки — заполнять нечего.
    expect(timer.pending()).toBe(true);
    timer.run();
    expect(fill.filled).toBe(true);
    expect(fill.seats).toHaveLength(0);
    expect(bots.seats).toHaveLength(0);

    await stepMatch(fixture, [founder.host, friend.host]);
    // Матч идёт двумя людьми, и слотов в каноническом логе ровно два.
    const frames = fixture.server.canonicalInputs;
    expect(new Set(frames.map((frame) => frame.playerId))).toEqual(new Set(PLAYERS));
    // Сервер уступки не видел: ни одного отвергнутого сообщения, ни одного
    // лишнего подключения — только два штатных `Hello`.
    expect(fixture.server.metrics.rejectedMessages).toBe(0);
  });

  it('никто не пришёл: бот занимает слот на дедлайне, матч стартует', async () => {
    const fixture = harness(duelConfig({ players: [...PLAYERS] }));
    const timer = manualSchedule();
    const bots = new BotHost();
    const fill = filler(fixture, bots, { reserved: ['p1'], schedule: timer.schedule });
    fill.arm();

    const founder = connectHuman(fixture, 'p1');
    await settle();
    // Один человек ростер не морозит: матч ждёт второго участника (NTR-6).
    expect(fixture.server.phase).toBe('lobby');
    expect(fill.seats).toHaveLength(0);

    timer.run();
    await settle();
    const [bot] = fill.seats;
    expect(fill.seats).toHaveLength(1);
    expect(bot!.playerId).toBe('p2');
    expect(bot!.client.slot).toBe(1);
    expect(fixture.server.phase).toBe('running');
    expect(fill.prune()).toBe(0);

    for (let i = 0; i < 5; i++) await stepMatch(fixture, [founder.host, bot!]);
    expect(fixture.server.tick).toBe(5);
    // Бот присутствует в каноническом логе как обычный слот (BOT-1).
    const bots1 = fixture.server.canonicalInputs.filter((frame) => frame.playerId === 'p2');
    expect(bots1).toHaveLength(5);
    bots.dispose();
  });

  it('человек пришёл после старта: штатный отказ фазы матча (NTR-6)', async () => {
    const fixture = harness(duelConfig({ players: [...PLAYERS] }));
    const bots = new BotHost();
    const fill = filler(fixture, bots, { reserved: ['p1'] });

    const founder = connectHuman(fixture, 'p1');
    await settle();
    fill.fill();
    await settle();
    expect(fixture.server.phase).toBe('running');

    // Опоздавший претендует на слот бота — и получает отказ, определённый для
    // фазы матча. Замены посреди матча этот механизм не вводит.
    const late = connectHuman(fixture, 'p2');
    await settle();
    expect(late.client.phase).toBe('closed');
    expect(late.client.closeReason).toBe('rejected');
    expect(late.client.closeDetail).toContain('match-in-progress');
    // Бот доигрывает свой матч: состав заморожен.
    expect(fill.seats[0]!.client.phase).toBe('playing');
    expect(fill.prune()).toBe(0);

    await stepMatch(fixture, [founder.host, fill.seats[0]!]);
    expect(fixture.server.phase).toBe('running');
    bots.dispose();
  });

  it('гонка за слот: разминувшийся с дедлайном бот отпускает канал, а не спорит', async () => {
    const fixture = harness(duelConfig({ players: [...PLAYERS] }));
    const bots = new BotHost();
    // Резерва нет намеренно: заполнитель предлагает бота на ОБА слота, и слот
    // человека сервер отдаёт первому пришедшему — заполнителю отказывает.
    const fill = filler(fixture, bots);

    connectHuman(fixture, 'p1');
    await settle();
    fill.fill();
    await settle();

    expect(fill.prune()).toBe(1);
    expect(fill.seats).toHaveLength(1);
    expect(fill.seats[0]!.playerId).toBe('p2');
    expect(fixture.server.phase).toBe('running');
    bots.dispose();
  });
});

describe('сервер ботов от людей не отличает (BOT-1, BOT-7)', () => {
  it('в исходниках сервера матча бота нет ни одним словом', () => {
    for (const file of ['matchServer.ts', 'host.ts']) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../net-ts/src/server/${file}`, import.meta.url)),
        'utf8',
      );
      expect(source).not.toMatch(/bot/i);
      expect(source).not.toMatch(/заполнител/i);
    }
  });

  it('канонический лог матча с ботом совпадает с логом матча с человеком', async () => {
    /** Кадры лога без имени игрока: сравнивается ввод, а не то, кем он подан. */
    const shape = (frames: readonly InputFrame[]): unknown[] =>
      frames.map((frame) => ({
        tick: frame.tick,
        seq: frame.seq,
        move: frame.move,
        aimDir: frame.aimDir,
        buttons: frame.buttons,
        playerId: frame.playerId,
      }));

    const ticks = 8;
    const step = fixed.fromFloat(MOVE);

    // Матч с человеком во втором слоте: ввод подаётся сценарием (INP-1).
    const humanFixture = harness(duelConfig({ players: [...PLAYERS] }));
    const first = connectHuman(humanFixture, 'p1');
    const second = connectHuman(humanFixture, 'p2', () => ({
      move: { x: step, y: 0 },
      aimDir: 0,
      buttons: 0,
    }));
    await settle();
    for (let i = 0; i < ticks; i++) await stepMatch(humanFixture, [first.host, second.host]);

    // Тот же матч, где второй слот занял бот-заполнитель с тем же намерением.
    const botFixture = harness(duelConfig({ players: [...PLAYERS] }));
    const bots = new BotHost();
    const fill = filler(botFixture, bots, {
      reserved: ['p1'],
      intent: { moveX: MOVE, moveY: 0, aimRadians: 0 },
    });
    const lone = connectHuman(botFixture, 'p1');
    await settle();
    fill.fill();
    await settle();
    for (let i = 0; i < ticks; i++) await stepMatch(botFixture, [lone.host, fill.seats[0]!]);

    expect(shape(botFixture.server.canonicalInputs)).toEqual(
      shape(humanFixture.server.canonicalInputs),
    );
    expect(botFixture.server.worldInitHash).toBe(humanFixture.server.worldInitHash);
    bots.dispose();
  });
});
