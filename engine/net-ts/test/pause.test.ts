/**
 * Пауза матча (NTR-20): заморозка существующим переходом WSM (`Running →
 * Paused`, WSM-2), атрибуция инициатора, обратный отсчёт возобновления и
 * политика, приезжающая ДОКУМЕНТОМ МАТЧА, а не константами сервера.
 *
 * Почти всё идёт по `MatchServer` напрямую, без транспорта и таймеров (NTR-3,
 * NTR-12): предмет здесь — бухгалтерия паузы и переходы, а не доставка. Отсчёт
 * ведётся шагами расписания (решение D2), поэтому «прошло полсекунды» в тесте —
 * это тридцать вызовов `advance()` при 60 Гц, а не ожидание реального времени.
 */
import { describe, expect, it } from 'vitest';
import type { SceneDef } from '@fluxus/core';
import { MatchClient } from '../src/client/matchClient.js';
import { contentPack } from '../src/content/pack.js';
import { clientCodec, jsonSerializer, msgpackSerializer, serverCodec } from '../src/protocol/codec.js';
import { REWIND_REQUEST_EVENT } from '../src/match/rewindRequest.js';
import { parseClientMessage, parseServerMessage, ProtocolError } from '../src/protocol/messages.js';
import type {
  ClientMessage,
  PauseMessage,
  ServerMessage,
} from '../src/protocol/messages.js';
import type {
  MatchConfig,
  MatchPauseOptions,
  MatchServer,
  Outgoing,
} from '../src/server/matchServer.js';
import {
  connectClient,
  duelConfig,
  duelScene,
  harness,
  hello,
  inputMessageOf,
  settle,
  wireInput,
} from './fixtures.js';

// ------------------------------------------------------------------ хелперы

/**
 * Политика паузы теста — числа документа матча, а не сервера (NTR-20). Взяты
 * мелкими, чтобы шаги расписания считались глазами: 60 шагов на право
 * противника, 30 на отсчёт, 120 на предел длительности.
 */
const POLICY: MatchPauseOptions = {
  budgetPerPlayer: 2,
  opponentUnpauseAfterMs: 1000,
  resumeCountdownMs: 500,
  maxPauseMs: 2000,
};

const RESUME_STEPS = 30;
const OPPONENT_STEPS = 60;
const MAX_PAUSE_STEPS = 120;

/** Бит ульты отката — раскладка сборки игры, сетевому слою не известная. */
const ULT_BUTTON = 7;
const ULT = 1 << ULT_BUTTON;

function pauseRequest(action: 'pause' | 'resume'): ClientMessage {
  return { type: 'PauseRequest', action };
}

/** Матч с обоими занятыми слотами: соединение 1 — p1, соединение 2 — p2. */
function running(pause: MatchPauseOptions = POLICY, overrides: Partial<MatchConfig> = {}) {
  // Порог молчания заведомо длиннее любого прогона теста: предмет здесь пауза, а
  // слот, за который никто не говорит, завершил бы матч сам.
  const config = duelConfig({ silenceTicks: 100_000, pause, ...overrides });
  const fixture = harness(config);
  fixture.server.connect(1);
  fixture.server.receive(1, hello('p1', config.version));
  fixture.server.connect(2);
  fixture.server.receive(2, hello('p2', config.version));
  fixture.server.drain();
  return { ...fixture, config };
}

function advance(server: MatchServer, steps: number): void {
  for (let i = 0; i < steps; i++) server.advance();
}

function messagesTo(outgoing: readonly Outgoing[], to: number): ServerMessage[] {
  return outgoing.filter((entry) => entry.to === to).map((entry) => entry.message);
}

function pausesTo(outgoing: readonly Outgoing[], to: number): PauseMessage[] {
  return messagesTo(outgoing, to).filter(
    (message): message is PauseMessage => message.type === 'Pause',
  );
}

let seq = 0;

/** Кадр ввода от соединения, размеченный тиком с запасом задержки (NTR-7). */
function sendInput(server: MatchServer, connection: number, buttons = 0): void {
  seq++;
  server.receive(
    connection,
    inputMessageOf(server.epoch, wireInput(server.tick + 2, seq, 0, 0, buttons)),
  );
}

/**
 * Сцена дуэли плюс каст ульты отката по биту кнопки. Нужна перекрёстку с
 * перемоткой: без неё «запрос перемотки в заморозке не рождается» было бы
 * утверждением о сцене, которая запросов не порождает вовсе.
 */
function ultScene(): SceneDef {
  const scene = duelScene();
  const e = { var: 'e' } as const;
  return {
    ...scene,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'RewindCast',
        order: 40,
        query: { all: ['Input', 'Player'] },
        as: 'e',
        do: [
          {
            if: {
              cond: { bitTest: [{ getComponent: [e, 'Input', 'buttons'] }, ULT_BUTTON] },
              then: [
                {
                  emitEvent: {
                    type: REWIND_REQUEST_EVENT,
                    data: { initiator: e, depthTicks: 10 },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function ultConfig(): Partial<MatchConfig> {
  return {
    scene: ultScene(),
    rewind: { interval: 5, capacity: 20, holdButton: ULT_BUTTON, step: 3, holdTimeoutTicks: 8 },
  };
}

// -------------------------------------------------------------------- тесты

describe('типы паузы в закрытом наборе (NTR-4, NTR-20)', () => {
  const serializers = [msgpackSerializer, jsonSerializer];

  for (const serializer of serializers) {
    it(`круг PauseRequest через ${serializer.name}`, () => {
      const codec = serverCodec(serializer);
      for (const action of ['pause', 'resume'] as const) {
        const message = pauseRequest(action);
        expect(codec.decode(codec.encode(message as never) as never)).toEqual(message);
      }
    });

    it(`круг Pause через ${serializer.name}, включая именованный отказ`, () => {
      const codec = clientCodec(serializer);
      const server = serverCodec(serializer);
      const announced: ServerMessage = {
        type: 'Pause',
        state: 'resuming',
        slot: 1,
        countdownMs: 3000,
      };
      const denied: ServerMessage = {
        type: 'Pause',
        state: 'running',
        slot: -1,
        countdownMs: 0,
        denied: 'budget-spent',
      };
      expect(codec.decode(server.encode(announced) as never)).toEqual(announced);
      expect(codec.decode(server.encode(denied) as never)).toEqual(denied);
    });
  }

  it('PauseRequest без действия и с незнакомым действием отвергается', () => {
    expect(() => parseClientMessage({ type: 'PauseRequest' })).toThrow(ProtocolError);
    expect(() => parseClientMessage({ type: 'PauseRequest', action: 'freeze' })).toThrow(
      ProtocolError,
    );
  });

  it('Pause с состоянием вне перечня и с незнакомой причиной отвергается', () => {
    const base = { type: 'Pause', slot: 0, countdownMs: 0 };
    expect(() => parseServerMessage({ ...base, state: 'halted' })).toThrow(ProtocolError);
    expect(() => parseServerMessage({ ...base })).toThrow(ProtocolError);
    expect(() => parseServerMessage({ ...base, state: 'frozen', denied: 'nope' })).toThrow(
      ProtocolError,
    );
    // Отсутствие причины легально: это объявление состояния, а не отказ.
    expect(() => parseServerMessage({ ...base, state: 'frozen' })).not.toThrow();
  });

  it('сообщение не своего направления по-прежнему отвергается', () => {
    expect(() => parseClientMessage({ type: 'Pause', state: 'frozen', slot: 0, countdownMs: 0 })).toThrow(
      ProtocolError,
    );
    expect(() => parseServerMessage({ type: 'PauseRequest', action: 'pause' })).toThrow(
      ProtocolError,
    );
  });

  it('опечатка в имени типа остаётся неизвестным типом и не проходит молча (NTR-4)', () => {
    expect(() => parseClientMessage({ type: 'PauseRequestt', action: 'pause' })).toThrow(
      ProtocolError,
    );
  });

  it('запрос паузы до хендшейка — недопустимое для состояния сообщение', () => {
    const { server } = running();
    server.connect(9);
    server.receive(9, pauseRequest('pause'));
    const out = messagesTo(server.drain(), 9);
    expect(out[0]).toMatchObject({ type: 'Reject', reason: 'protocol-error' });
  });
});

describe('заморозка и возобновление (NTR-20, D1, D2)', () => {
  it('в заморозке живых тиков нет: тик, эпоха и канонический лог стоят', () => {
    const m = running();
    advance(m.server, 5);
    const tick = m.server.tick;
    const frames = m.server.canonicalInputs.length;

    m.server.receive(1, pauseRequest('pause'));
    expect(m.server.mode).toBe('Paused');
    expect(m.server.pauseState).toBe('frozen');

    advance(m.server, 20);
    expect(m.server.tick).toBe(tick);
    expect(m.server.epoch).toBe(0);
    expect(m.server.canonicalInputs.length).toBe(frames);
  });

  it('возобновление продолжает матч с того же тика', () => {
    const m = running();
    advance(m.server, 5);
    const tick = m.server.tick;

    m.server.receive(1, pauseRequest('pause'));
    advance(m.server, 20);
    m.server.receive(1, pauseRequest('resume'));
    expect(m.server.pauseState).toBe('resuming');

    advance(m.server, RESUME_STEPS);
    expect(m.server.mode).toBe('Running');
    expect(m.server.pauseState).toBe('running');
    // Мир продолжается с замороженного тика, а не с «догонкой» пропущенного.
    expect(m.server.tick).toBe(tick);

    advance(m.server, 3);
    expect(m.server.tick).toBe(tick + 3);
  });

  it('объявленный отсчёт едет длительностью и кончается объявлением «идёт»', () => {
    const m = running();
    m.server.receive(1, pauseRequest('pause'));
    m.server.drain();

    m.server.receive(1, pauseRequest('resume'));
    const announced = pausesTo(m.server.drain(), 2);
    expect(announced).toEqual([
      { type: 'Pause', state: 'resuming', slot: 0, countdownMs: 500 },
    ]);

    advance(m.server, RESUME_STEPS);
    expect(pausesTo(m.server.drain(), 2)).toEqual([
      { type: 'Pause', state: 'running', slot: 0, countdownMs: 0 },
    ]);
  });
});

describe('политика приходит документом матча (NTR-20, D3)', () => {
  it('запрос в пределах бюджета проходит, сверх — адресный отказ без разрыва (D4)', () => {
    const m = running({ budgetPerPlayer: 1, resumeCountdownMs: 0 });
    m.server.receive(1, pauseRequest('pause'));
    m.server.receive(1, pauseRequest('resume'));
    expect(m.server.pauseState).toBe('running');
    m.server.drain();

    m.server.receive(1, pauseRequest('pause'));
    const out = m.server.drain();
    expect(pausesTo(out, 1)).toEqual([
      { type: 'Pause', state: 'running', slot: 0, countdownMs: 0, denied: 'budget-spent' },
    ]);
    // Отказ АДРЕСНЫЙ: соседу о чужом нажатии не сообщают.
    expect(pausesTo(out, 2)).toEqual([]);
    // И соединение живо: `Reject` в этом протоколе рвёт канал (NTR-4, NTR-5), а
    // законное «нельзя сейчас» — не нарушение протокола.
    expect(out.some((entry) => entry.message.type === 'Reject')).toBe(false);
    expect(m.server.mode).toBe('Running');
  });

  it('противник вправе снять чужую паузу только по истечении срока политики', () => {
    const m = running();
    m.server.receive(1, pauseRequest('pause'));
    m.server.drain();

    m.server.receive(2, pauseRequest('resume'));
    expect(pausesTo(m.server.drain(), 2)).toEqual([
      { type: 'Pause', state: 'frozen', slot: 0, countdownMs: 0, denied: 'too-early' },
    ]);
    expect(m.server.pauseState).toBe('frozen');

    advance(m.server, OPPONENT_STEPS);
    m.server.receive(2, pauseRequest('resume'));
    expect(m.server.pauseState).toBe('resuming');
    // Инициатором нового состояния назван тот, кто его вызвал.
    expect(m.server.pauseInitiator).toBe(1);
  });

  it('инициатор снимает свою паузу немедленно — срок противника его не держит', () => {
    const m = running();
    m.server.receive(1, pauseRequest('pause'));
    m.server.receive(1, pauseRequest('resume'));
    expect(m.server.pauseState).toBe('resuming');
  });

  it('просроченная пауза возобновляется сама, и инициатор возобновления — сервер', () => {
    const m = running();
    m.server.receive(1, pauseRequest('pause'));
    m.server.drain();

    advance(m.server, MAX_PAUSE_STEPS);
    expect(m.server.pauseState).toBe('resuming');
    expect(m.server.pauseInitiator).toBe(-1);
    expect(pausesTo(m.server.drain(), 1)).toEqual([
      { type: 'Pause', state: 'resuming', slot: -1, countdownMs: 500 },
    ]);

    advance(m.server, RESUME_STEPS);
    expect(m.server.mode).toBe('Running');
  });

  it('матч без секции pause игрокам паузу не даёт, а обвязке — даёт', () => {
    const config = duelConfig({ silenceTicks: 100_000 });
    const fixture = harness(config);
    fixture.server.connect(1);
    fixture.server.receive(1, hello('p1', config.version));
    fixture.server.connect(2);
    fixture.server.receive(2, hello('p2', config.version));
    fixture.server.drain();

    fixture.server.receive(1, pauseRequest('pause'));
    expect(pausesTo(fixture.server.drain(), 1)).toEqual([
      { type: 'Pause', state: 'running', slot: -1, countdownMs: 0, denied: 'budget-spent' },
    ]);
    expect(fixture.server.pauseMatch()).toBeUndefined();
    expect(fixture.server.mode).toBe('Paused');
  });

  it('отрицательное и дробное число политики роняет сборку матча, а не приводится к нулю', () => {
    expect(() => harness(duelConfig({ pause: { budgetPerPlayer: -1 } }))).toThrow(
      /budgetPerPlayer/,
    );
    expect(() => harness(duelConfig({ pause: { resumeCountdownMs: 1.5 } }))).toThrow(
      /resumeCountdownMs/,
    );
    // Единственное НЕчисловое поле политики проверяется здесь же, хотя читает
    // его обвязка: документ матча один на всех потребителей, и опечатка,
    // пропущенная сервером, значила бы «политики нет» — молча (NTR-20).
    expect(() =>
      harness(duelConfig({ pause: { onOwnerDetach: 'puase' as 'pause' } })),
    ).toThrow(/onOwnerDetach/);
    expect(() => harness(duelConfig({ pause: { onOwnerDetach: 'ignore' } }))).not.toThrow();
  });

  it('повторная заморозка и снятие несуществующей паузы называются своими причинами', () => {
    const m = running();
    m.server.receive(2, pauseRequest('resume'));
    expect(pausesTo(m.server.drain(), 2)[0]).toMatchObject({ denied: 'not-frozen' });

    m.server.receive(1, pauseRequest('pause'));
    m.server.drain();
    m.server.receive(2, pauseRequest('pause'));
    expect(pausesTo(m.server.drain(), 2)[0]).toMatchObject({ denied: 'already-frozen' });

    m.server.receive(1, pauseRequest('resume'));
    m.server.drain();
    m.server.receive(1, pauseRequest('resume'));
    expect(pausesTo(m.server.drain(), 1)[0]).toMatchObject({ denied: 'already-resuming' });

    // И заморозка ПОВЕРХ объявленного отсчёта названа отсчётом, а не «уже
    // стоит»: игроку дальше делать разное — ждать снятия против ждать
    // возобновления, — и отказ обязан отвечать на «почему нельзя» (NTR-20).
    m.server.receive(2, pauseRequest('pause'));
    expect(pausesTo(m.server.drain(), 2)[0]).toMatchObject({
      state: 'resuming',
      denied: 'already-resuming',
    });
  });
});

describe('рассылка состояния паузы (NTR-20, NTR-9)', () => {
  it('наблюдатель получает те же сообщения, что игроки', () => {
    const m = running(POLICY, { allowObserver: true });
    m.server.connect(3);
    m.server.receive(3, hello('spectator', m.config.version, true));
    m.server.drain();

    m.server.receive(1, pauseRequest('pause'));
    const frozen = m.server.drain();
    const expected = { type: 'Pause', state: 'frozen', slot: 0, countdownMs: 0 };
    expect(pausesTo(frozen, 1)).toEqual([expected]);
    expect(pausesTo(frozen, 2)).toEqual([expected]);
    expect(pausesTo(frozen, 3)).toEqual([expected]);
  });

  it('запрос паузы от наблюдателя получает названный отказ', () => {
    const m = running(POLICY, { allowObserver: true });
    m.server.connect(3);
    m.server.receive(3, hello('spectator', m.config.version, true));
    m.server.drain();

    m.server.receive(3, pauseRequest('pause'));
    expect(pausesTo(m.server.drain(), 3)[0]).toMatchObject({ denied: 'not-a-player' });
    expect(m.server.mode).toBe('Running');
  });
});

describe('ввод в заморозке (NTR-20, D5)', () => {
  it('кадры отбрасываются без эффекта и без искажения счётчиков NTR-11', () => {
    const m = running();
    advance(m.server, 5);
    m.server.receive(1, pauseRequest('pause'));
    const before = { ...m.server.metrics.slots[0]! };

    for (let i = 0; i < 20; i++) {
      sendInput(m.server, 1);
      m.server.advance();
    }
    const after = m.server.metrics.slots[0]!;
    expect(after.applied).toBe(before.applied);
    expect(after.late).toBe(before.late);
    expect(after.outOfWindow).toBe(before.outOfWindow);
    expect(after.predicted).toBe(before.predicted);
    // И соединение живо: отброшенный кадр — не нарушение протокола.
    expect(m.server.drain().some((entry) => entry.message.type === 'Reject')).toBe(false);
  });

  it('порог молчания в заморозке не тикает — иначе длинная пауза убивала бы матч', () => {
    // Порог короче самой паузы: без остановки счётчика матч кончился бы `End`.
    const m = running(POLICY, { silenceTicks: 10 });
    advance(m.server, 3);
    m.server.receive(1, pauseRequest('pause'));
    const silent = m.server.metrics.slots[0]!.silentTicks;

    advance(m.server, 100);
    expect(m.server.metrics.slots[0]!.silentTicks).toBe(silent);
    expect(m.server.phase).toBe('running');
  });
});

describe('перекрёсток с перемоткой (NTR-20)', () => {
  it('PauseRequest и API-пауза в Rewinding получают названный отказ', () => {
    const m = running(POLICY, ultConfig());
    advance(m.server, 3);
    m.server.pause();
    m.server.beginRewind();
    expect(m.server.mode).toBe('Rewinding');
    m.server.drain();

    m.server.receive(1, pauseRequest('pause'));
    expect(pausesTo(m.server.drain(), 1)[0]).toMatchObject({ denied: 'rewinding' });
    expect(m.server.pauseMatch()).toBe('rewinding');
    // Машина перемотки доигрывает свой флоу нетронутой.
    expect(m.server.mode).toBe('Rewinding');
  });

  it('перемотка из паузы матча не начинается', () => {
    const m = running(POLICY, ultConfig());
    advance(m.server, 3);
    m.server.receive(1, pauseRequest('pause'));
    expect(() => { m.server.pause(); }).toThrow(/паузой матча/);
    expect(() => { m.server.resume(); }).toThrow(/resumeMatch/);
    // Гард стоит и на самом входе в перемотку, а не только на пути к нему:
    // ядру этот вход законен — `beginRewind` спрашивает у мира только `Paused`,
    // и пауза матча ровно его оставляет (NTR-20, WSM-2).
    expect(() => { m.server.beginRewind(); }).toThrow(/паузой матча/);
    expect(m.server.mode).toBe('Paused');
    expect(m.server.pauseState).toBe('frozen');
  });

  it('запрос перемотки в заморозке не рождается: живых тиков нет', () => {
    const m = running(POLICY, ultConfig());
    advance(m.server, 3);
    m.server.pauseMatch();

    for (let i = 0; i < 20; i++) {
      sendInput(m.server, 1, ULT);
      m.server.advance();
    }
    expect(m.server.mode).toBe('Paused');
    expect(m.server.pauseState).toBe('frozen');
    expect(m.server.epoch).toBe(0);

    // Контроль: та же сцена и тот же бит на ЖИВОМ тике перемотку заводят —
    // значит утверждение выше не о сцене, которая ничего не просит.
    m.server.resumeMatch();
    advance(m.server, RESUME_STEPS);
    expect(m.server.mode).toBe('Running');
    for (let i = 0; i < 4; i++) {
      sendInput(m.server, 1, ULT);
      m.server.advance();
    }
    expect(m.server.mode).toBe('Rewinding');
  });
});

describe('реконнект в паузу (NTR-20, NTR-17, D8)', () => {
  it('вернувшийся владелец получает Start, замороженный снапшот и состояние паузы — в этом порядке', () => {
    const m = running();
    advance(m.server, 6);
    m.server.receive(1, pauseRequest('pause'));
    m.server.disconnect(1);
    m.server.drain();

    m.server.connect(3);
    m.server.receive(3, hello('p1', m.config.version));
    const out = messagesTo(m.server.drain(), 3);
    expect(out.map((message) => message.type)).toEqual(['Welcome', 'Start', 'Snapshot', 'Pause']);
    expect(out[2]).toMatchObject({ type: 'Snapshot', epoch: 0, tick: m.server.tick });
    expect(out[3]).toEqual({ type: 'Pause', state: 'frozen', slot: 0, countdownMs: 0 });
  });

  it('заместитель, севший в паузу, получает то же самое', () => {
    const m = running();
    advance(m.server, 6);
    m.server.receive(2, pauseRequest('pause'));
    m.server.disconnect(1);
    m.server.drain();

    m.server.connect(4);
    m.server.receive(4, hello('p1', m.config.version, false, 'substitute'));
    const out = messagesTo(m.server.drain(), 4);
    expect(out.map((message) => message.type)).toEqual(['Welcome', 'Start', 'Snapshot', 'Pause']);
    expect(out[3]).toEqual({ type: 'Pause', state: 'frozen', slot: 1, countdownMs: 0 });
  });

  it('вход в НЕзамороженный матч везёт «идёт» без снапшота: отсутствие сообщения — не ответ', () => {
    // Утверждение «паузы нет» доставляется, а не подразумевается: вернись игрок
    // в матч, возобновлённый без него, и без этого сообщения его HUD держал бы
    // оверлей паузы, поставленной до разрыва (HUD-9).
    const m = running();
    advance(m.server, 6);
    m.server.disconnect(1);
    m.server.drain();

    m.server.connect(3);
    m.server.receive(3, hello('p1', m.config.version));
    const out = messagesTo(m.server.drain(), 3);
    expect(out.map((message) => message.type)).toEqual(['Welcome', 'Start', 'Pause']);
    expect(out[2]).toEqual({ type: 'Pause', state: 'running', slot: -1, countdownMs: 0 });
  });
});

describe('запрос из лобби (NTR-20, HUD-9)', () => {
  it('нажатие до старта матча возвращается ИМЕНОВАННЫМ отказом, а не молчанием', async () => {
    // HUD в демо смонтирован уже на `Welcome` (`netClient.ts`), то есть кнопка
    // паузы у игрока есть, пока он ждёт противника. Проглоти клиент этот вызов
    // — игрок не получил бы НИЧЕГО: ни паузы, ни причины. Разрывом такое нажатие
    // не карается: соединение к этому моменту уже сидит в слоте, и сервер
    // отвечает ему отказом политики (NTR-20).
    const config = duelConfig({ silenceTicks: 100_000, pause: POLICY });
    const fixture = harness(config);
    const player = connectClient(fixture.hub, 'p1', fixture.clock, config.scene);
    await settle();
    // Второй слот пуст — матч в лобби, `Start` не рассылался.
    expect(fixture.server.phase).toBe('lobby');
    expect(player.client.phase).toBe('lobby');

    player.client.requestPause('pause');
    player.host.step();
    await settle();
    fixture.host.step();
    await settle();

    expect(player.client.pause).toMatchObject({ state: 'running', denied: 'match-not-running' });
    // Соединение живо, матч не тронут: «нельзя сейчас» — не нарушение протокола.
    expect(player.client.phase).toBe('lobby');
    expect(fixture.server.pauseState).toBe('running');
  });

  it('до хендшейка запрос не уезжает вовсе: он рвал бы соединение (NTR-4)', () => {
    const config = duelConfig({ pause: POLICY });
    const pack = contentPack({ duel: config.scene });
    const client = new MatchClient({ playerId: 'p1', version: config.version, content: pack });
    // `Hello` ещё не отправлен — фаза `greeting`, и слать в неё нечего.
    expect(client.phase).toBe('greeting');
    client.requestPause('pause');
    expect(client.drain()).toEqual([]);
  });
});

describe('серверное API паузы (NTR-20, D6)', () => {
  it('админ-пауза работает при исчерпанных бюджетах игроков', () => {
    const m = running({ budgetPerPlayer: 0 });
    m.server.receive(1, pauseRequest('pause'));
    expect(pausesTo(m.server.drain(), 1)[0]).toMatchObject({ denied: 'budget-spent' });

    expect(m.server.pauseMatch()).toBeUndefined();
    expect(m.server.mode).toBe('Paused');
    expect(m.server.pauseInitiator).toBe(-1);
    // Объявление уходит всем — обвязка не отличается от игрока тем, кому видно.
    expect(pausesTo(m.server.drain(), 2)).toEqual([
      { type: 'Pause', state: 'frozen', slot: -1, countdownMs: 0 },
    ]);
  });

  it('снятие обвязкой не ждёт срока противника', () => {
    const m = running();
    m.server.receive(1, pauseRequest('pause'));
    expect(m.server.resumeMatch()).toBeUndefined();
    expect(m.server.pauseState).toBe('resuming');
  });

  it('в лобби и после конца матча API называет причину, а не молчит', () => {
    const config = duelConfig({ pause: POLICY });
    const fixture = harness(config);
    expect(fixture.server.pauseMatch()).toBe('match-not-running');

    fixture.server.connect(1);
    fixture.server.receive(1, hello('p1', config.version));
    fixture.server.connect(2);
    fixture.server.receive(2, hello('p2', config.version));
    fixture.server.stop();
    expect(fixture.server.pauseMatch()).toBe('match-not-running');
  });
});

describe('темп расписания и длительность (D2)', () => {
  it('отсчёт считается от tickRate матча, а не от числа тиков', () => {
    // Половина секунды при 30 Гц — пятнадцать шагов, при 60 Гц — тридцать: шаг
    // расписания равен тику по длительности, и отсчёт остаётся wall-clock'ом.
    const m = running(POLICY, { tickRate: 30, snapshotRate: 30 });
    m.server.receive(1, pauseRequest('pause'));
    m.server.receive(1, pauseRequest('resume'));
    advance(m.server, 14);
    expect(m.server.mode).toBe('Paused');
    m.server.advance();
    expect(m.server.mode).toBe('Running');
  });
});
