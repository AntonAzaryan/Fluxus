/**
 * Граница честности (BOT-3): единственный источник состояния мира для мозга —
 * отфильтрованное состояние его собственного клиента.
 *
 * Сборка здесь ровно та, в которой соблазн «подсмотреть» реален: сервер матча и
 * бот живут в ОДНОМ процессе (`listen`, `net-session` SES-6), мир сервера лежит
 * в соседней переменной. Держится граница не уговором, а конструированием:
 * мозгу физически не передаётся ничего, кроме профиля, своего имени со слотом и
 * `ClientStep`.
 */
import { describe, expect, it } from 'vitest';
import { query, world as coreWorld } from '@fluxus/core';
import type { ClientStep } from '@fluxus/net';
import { BotHost } from '../src/host.js';
import type { BotBrain, BotBrainFactory, BotSelf } from '../src/brain.js';
import type { BotProfile } from '../src/profile.js';
import { readWorldView } from '../src/worldView.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  fogConfig,
  harness,
  settle,
  stepMatch,
  testProfile,
  TICK_RATE,
} from './fixtures.js';

interface Recorded {
  readonly args: { profile: BotProfile; self: BotSelf; count: number }[];
  readonly steps: ClientStep[];
  readonly slots: number[];
}

/** Мозг-регистратор: не играет, а записывает всё, что ему дали. */
function recordingBrain(recorded: Recorded): BotBrainFactory {
  return function factory(...args): BotBrain {
    const [profile, self] = args;
    recorded.args.push({ profile, self, count: args.length });
    return {
      observe(step) {
        recorded.steps.push(step);
        const view = readWorldView(step, self.slot);
        if (view === undefined) return;
        for (const other of view.others) {
          if (other.slot !== undefined) recorded.slots.push(other.slot);
        }
      },
      sample() {
        return undefined;
      },
    };
  };
}

function empty(): Recorded {
  return { args: [], steps: [], slots: [] };
}

describe('мозг конструируется без ссылки на мир сервера (BOT-3)', () => {
  it('в аргументах фабрики — только профиль и «кто я»', async () => {
    const recorded = empty();
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: recordingBrain(recorded),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 10; i++) await stepMatch(fixture, [human.host, seat]);

    expect(recorded.args).toHaveLength(1);
    const [call] = recorded.args;
    expect(call!.count).toBe(2);
    // «Кто я» — три скалярные величины и ничего больше, и все три пришли из
    // `Welcome` собственного клиента: передать мир этой подписью нельзя, даже
    // задавшись целью (BOT-3).
    expect(Object.keys(call!.self).sort()).toEqual(['playerId', 'slot', 'tickRate']);
    expect(call!.self).toEqual({ playerId: 'bot-1', slot: 1, tickRate: TICK_RATE });
    for (const value of Object.values(call!.self)) {
      expect(['string', 'number']).toContain(typeof value);
    }
    // Профиль — документ контента и ничего кроме: сериализуется целиком, то
    // есть ссылке на живой мир в нём взяться неоткуда (BOT-6).
    expect(JSON.parse(JSON.stringify(call!.profile))).toEqual(call!.profile);
    expect(seat.brain).toBeDefined();
    bots.dispose();
  });

  it('наблюдение — только `ClientStep`: состояние своего слота и его факты', async () => {
    const recorded = empty();
    const fixture = harness(duelConfig());
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: recordingBrain(recorded),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 10; i++) await stepMatch(fixture, [human.host, seat]);

    expect(recorded.steps.length).toBeGreaterThan(0);
    for (const step of recorded.steps) {
      expect(Object.keys(step).sort()).toEqual(['events', 'state']);
    }
    // Контроль вакуумности: без тумана чужой слот в наблюдении ЕСТЬ — значит,
    // его отсутствие в тумане ниже говорит о фильтре, а не о слепом мозге.
    expect(recorded.slots).toContain(0);
    bots.dispose();
  });
});

describe('враг в тумане войны (BOT-3)', () => {
  it('невидимый слоту бота противник не приезжает мозгу вовсе', async () => {
    const recorded = empty();
    const config = fogConfig();
    const fixture = harness(config);
    const human = connectHuman(fixture, 'p1');
    const bots = new BotHost();
    const seat = connectBot(fixture, bots, {
      playerId: 'bot-1',
      brain: recordingBrain(recorded),
      profile: testProfile(),
    });
    await settle();
    for (let i = 0; i < 30; i++) await stepMatch(fixture, [human.host, seat]);

    // Мир сервера героев знает обоих — фильтр стоит между ним и мозгом
    // (`netcode` NET-12..15), а не между сервером и симуляцией.
    const authoritative = fixture.server.snapshot();
    const heroes = [...query(authoritative.world, { all: ['Player'] })];
    expect(heroes).toHaveLength(2);
    expect(
      heroes.map((entity) => coreWorld.getField(authoritative.world, entity, 'Player', 'slot')).sort(),
    ).toEqual([0, 1]);

    // А мозгу за весь матч не приехало ни одного чужого слота: он не
    // располагает положением врага — как и клиент человека.
    expect(recorded.steps.length).toBeGreaterThan(0);
    expect(recorded.slots).toEqual([]);
    bots.dispose();
  });
});
