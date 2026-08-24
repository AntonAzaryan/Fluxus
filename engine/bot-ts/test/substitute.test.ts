/**
 * Бот — заместитель отвалившегося игрока (BOT-14) на внутрипроцессном
 * транспорте (NTR-2, NTR-12): тот же `MatchServer`, тот же `MatchClient`, та же
 * сборка бота, что играют по сети, — подменены только транспорт и планировщик
 * паузы.
 *
 * Четыре сценария требования проверяются буквально: политика «бот» подхватывает
 * слот, политика «ничего» его не трогает, вернувшийся владелец забирает слот
 * вытеснением (и заместитель не пере-подключается), а запись матча замещения не
 * видит вовсе.
 */
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '@game-mvp/core';
import { BotHost } from '../src/host.js';
import { BotSubstitutes } from '../src/substitute.js';
import type { BotIntent } from '../src/boundary.js';
import {
  connectBot,
  connectHuman,
  duelConfig,
  harness,
  manualSchedule,
  settle,
  stepMatch,
  testProfile,
  type Harness,
} from './fixtures.js';
import type { Transport } from '@game-mvp/net';

const PLAYERS = ['p1', 'p2'] as const;
/** Заметный шаг вправо: по нему видно, что ввод заместителя доехал до лога. */
const MOVE: BotIntent = { moveX: 1, moveY: 0, aimRadians: 0 };

/** Мозг с постоянным намерением: ввод заместителя предсказуем. */
function steadyBrain(intent: BotIntent) {
  return () => ({ observe: () => {}, sample: () => intent });
}

interface Policy {
  readonly substitutes: BotSubstitutes;
  readonly bots: BotHost;
  readonly timer: ReturnType<typeof manualSchedule>;
  /** Кого политика предложила слотам — в порядке посадки. */
  readonly seated: string[];
  /** «Играть уже не с кем» глазами сборки: тест ставит его руками. */
  readonly abandoned: { value: boolean };
}

/**
 * Политика замещения поверх фикстуры: наблюдение идёт снаружи сервера
 * (`slotAttached`, `phase`), а посадка — обычным бот-местом с ролью
 * заместителя (NTR-18), а не особым путём.
 */
function policy(fixture: Harness): Policy {
  const bots = new BotHost();
  const timer = manualSchedule();
  const seated: string[] = [];
  const abandoned = { value: false };
  const substitutes = new BotSubstitutes({
    players: fixture.config.players,
    attached: (slot) => fixture.server.slotAttached(slot),
    running: () => fixture.server.phase === 'running',
    abandoned: () => abandoned.value,
    schedule: timer.schedule,
    attach: (playerId) => {
      seated.push(playerId);
      connectBot(fixture, bots, {
        playerId,
        role: 'substitute',
        profile: testProfile(),
        brain: steadyBrain(MOVE),
      });
    },
  });
  return { substitutes, bots, timer, seated, abandoned };
}

interface Seat {
  readonly host: { step(): unknown };
  readonly transport: Transport;
}

/** Матч двух людей: у обоих свой транспорт — тестам нужно рвать его руками. */
async function duel(): Promise<{ fixture: Harness; owner: Seat; rival: Seat }> {
  const fixture = harness(duelConfig({ players: [...PLAYERS], silenceTicks: 8 }));
  const ownerTransport = fixture.hub.connect();
  const rivalTransport = fixture.hub.connect();
  const owner = connectHuman(fixture, 'p1', undefined, ownerTransport);
  // Соперник шлёт ввод каждый тик: его слот молчания не копит, и порог, когда
  // он срабатывает, срабатывает из-за отвалившегося владельца — того, ради
  // кого тест и написан.
  const rival = connectHuman(
    fixture,
    'p2',
    () => ({ move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 }),
    rivalTransport,
  );
  await settle();
  return {
    fixture,
    owner: { host: owner.host, transport: ownerTransport },
    rival: { host: rival.host, transport: rivalTransport },
  };
}

describe('политика «бот»: слот подхвачен (BOT-14)', () => {
  it('разрыв владельца — бот входит заместителем, и порог молчания матч не рвёт', async () => {
    const { fixture, owner, rival } = await duel();
    const { substitutes, bots, timer, seated } = policy(fixture);
    expect(fixture.server.phase).toBe('running');

    owner.transport.close('обрыв');
    await settle();
    expect(fixture.server.slotAttached(0)).toBe(false);

    // Пауза перед посадкой: сетевой всплеск не должен дёргать бота (design D7).
    substitutes.poll();
    expect(substitutes.stateOf(0)).toBe('pending');
    expect(seated).toHaveLength(0);

    timer.run();
    await settle();
    expect(seated).toEqual(['p1']);
    expect(bots.seats[0]!.client.slot).toBe(0);
    expect(fixture.server.slotAttached(0)).toBe(true);
    // Молчание слота обнулено посадкой живого соединения (NTR-6): матч,
    // который без заместителя умер бы порогом, продолжается.
    expect(fixture.server.metrics.slots[0]!.silentTicks).toBe(0);

    for (let i = 0; i < 12; i++) {
      await stepMatch(fixture, [rival.host, bots.seats[0]!]);
      substitutes.poll();
    }
    expect(fixture.server.phase).toBe('running');
    // Заместитель ведёт слот: его ввод применён как обычный ввод слота.
    const own = fixture.server.canonicalInputs.filter((frame) => frame.playerId === 'p1');
    expect(own.some((frame) => frame.move.x > 0)).toBe(true);
    bots.dispose();
    substitutes.dispose();
  });

  it('владелец вернулся раньше паузы — посадки не будет', async () => {
    const { fixture, owner } = await duel();
    const { substitutes, timer, seated, bots } = policy(fixture);

    owner.transport.close('короткий обрыв');
    await settle();
    substitutes.poll();
    expect(substitutes.stateOf(0)).toBe('pending');

    // Владелец успел вернуться реконнектом (NTR-17) до истечения паузы.
    connectHuman(fixture, 'p1');
    await settle();
    expect(fixture.server.slotAttached(0)).toBe(true);

    timer.run();
    await settle();
    // Условия перепроверяются на истечении паузы, а не только при взводе.
    expect(seated).toHaveLength(0);
    expect(substitutes.stateOf(0)).toBe('idle');
    bots.dispose();
    substitutes.dispose();
  });
});

describe('политика «ничего»: слот ждёт владельца (BOT-14)', () => {
  it('без политики слот живёт на predicted-кадрах и матч кончается порогом', async () => {
    const { fixture, owner, rival } = await duel();

    owner.transport.close('обрыв');
    await settle();
    // Никто не вмешивается: бот не подключается, и это тоже политика сборки.
    for (let i = 0; i < 10; i++) await stepMatch(fixture, [rival.host]);

    expect(fixture.server.phase).toBe('ended');
    expect(fixture.server.metrics.slots[0]!.predicted).toBeGreaterThan(0);
  });

  it('матч, покинутый всеми, заместителями не оживляют — он кончается порогом', async () => {
    // Иначе политика «бот» лишает матч единственного способа закончиться: слот
    // с живым соединением молчания не копит (NTR-6), и стенд остался бы занят
    // боем ботов навсегда — тем самым, которого не заводит заполнитель (BOT-7).
    const { fixture, owner, rival } = await duel();
    const { substitutes, timer, seated, bots, abandoned } = policy(fixture);

    owner.transport.close('обрыв');
    rival.transport.close('обрыв');
    await settle();
    abandoned.value = true;

    substitutes.poll();
    expect(timer.pending()).toBe(false);
    expect(seated).toHaveLength(0);

    for (let i = 0; i < 10; i++) {
      await stepMatch(fixture, []);
      substitutes.poll();
    }
    expect(seated).toHaveLength(0);
    expect(fixture.server.phase).toBe('ended');
    bots.dispose();
    substitutes.dispose();
  });

  it('последний человек ушёл за паузу — посадки уже не будет', async () => {
    const { fixture, owner } = await duel();
    const { substitutes, timer, seated, bots, abandoned } = policy(fixture);

    owner.transport.close('обрыв');
    await settle();
    substitutes.poll();
    expect(substitutes.stateOf(0)).toBe('pending');

    // Пока шла пауза, ушёл и соперник: условия перепроверяются на её истечении.
    abandoned.value = true;
    timer.run();
    await settle();
    expect(seated).toHaveLength(0);
    expect(substitutes.stateOf(0)).toBe('idle');
    bots.dispose();
    substitutes.dispose();
  });

  it('до старта заместителей не бывает вовсе (NTR-18)', () => {
    const fixture = harness(duelConfig({ players: [...PLAYERS] }));
    const { substitutes, timer, seated } = policy(fixture);
    expect(fixture.server.phase).toBe('lobby');

    substitutes.poll();
    expect(timer.pending()).toBe(false);
    expect(seated).toHaveLength(0);
    substitutes.dispose();
  });
});

describe('владелец вернулся к слоту с ботом (BOT-14, NTR-18)', () => {
  it('заместитель вытеснен, отпускает канал и на занятый слот не возвращается', async () => {
    const { fixture, owner, rival } = await duel();
    const { substitutes, bots, timer, seated } = policy(fixture);

    owner.transport.close('обрыв');
    await settle();
    substitutes.poll();
    timer.run();
    await settle();
    const seat = bots.seats[0]!;
    expect(seat.client.slot).toBe(0);
    await stepMatch(fixture, [rival.host, seat]);

    // Владелец возвращается своим идентификатором и ролью владельца.
    const back = connectHuman(fixture, 'p1');
    await settle();
    expect(back.client.slot).toBe(0);
    // Вытеснение — механизм сервера: бот получает штатный отказ и закрывается.
    expect(seat.client.phase).toBe('closed');
    expect(seat.client.closeReason).toBe('rejected');
    expect(seat.client.closeDetail).toContain('displaced-by-owner');
    expect(seat.closed).toBe(true);

    // Сборка-основатель не пере-подключает вытесненного: слот занят владельцем.
    substitutes.poll();
    expect(timer.pending()).toBe(false);
    expect(seated).toEqual(['p1']);
    for (let i = 0; i < 4; i++) {
      await stepMatch(fixture, [rival.host, back.host]);
      substitutes.poll();
    }
    expect(seated).toEqual(['p1']);
    expect(fixture.server.phase).toBe('running');
    bots.dispose();
    substitutes.dispose();
  });
});

describe('замещение невидимо записи матча (BOT-14, NTR-8)', () => {
  it('в каноническом логе только слоты ростера — по кадру на тик, без следов смены арендатора', async () => {
    const { fixture, owner, rival } = await duel();
    const { substitutes, bots, timer } = policy(fixture);

    for (let i = 0; i < 3; i++) await stepMatch(fixture, [owner.host, rival.host]);
    owner.transport.close('обрыв');
    await settle();
    substitutes.poll();
    timer.run();
    await settle();
    const seat = bots.seats[0]!;
    for (let i = 0; i < 3; i++) await stepMatch(fixture, [rival.host, seat]);
    const back = connectHuman(fixture, 'p1');
    await settle();
    for (let i = 0; i < 3; i++) await stepMatch(fixture, [rival.host, back.host]);

    const frames: readonly InputFrame[] = fixture.server.canonicalInputs;
    const ticks = fixture.server.tick;
    expect(new Set(frames.map((frame) => frame.playerId))).toEqual(new Set(PLAYERS));
    expect(frames).toHaveLength(ticks * PLAYERS.length);
    // По кадру на слот на каждом тике: predicted, ботовские и человеческие —
    // все одной формы, и различить их в логе нечем.
    for (let tick = 1; tick <= ticks; tick++) {
      expect(frames.filter((frame) => frame.tick === tick)).toHaveLength(PLAYERS.length);
    }
    bots.dispose();
    substitutes.dispose();
  });
});
