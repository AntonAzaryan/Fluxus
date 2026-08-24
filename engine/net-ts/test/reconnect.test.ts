/**
 * Реконнект в идущий матч (NTR-17) и замещающее соединение (NTR-18).
 *
 * Предмет проверки — АРЕНДА СЛОТА: слот ростера после `Start` не двигается
 * (NTR-6), а меняется соединение, которое за него говорит. Отсюда состав
 * проверок: тот же хендшейк на возврате, повторный `Start` с исходным тиком,
 * возобновление персональных снапшотов и потока событий, вытеснение
 * заместителя владельцем и порог молчания как окно возврата.
 *
 * Почти всё идёт по `MatchServer` напрямую, без транспорта и таймеров (NTR-3,
 * NTR-12): предмет здесь — бухгалтерия аренды, а не доставка. Клиентская
 * половина (NTR-17, «Переподключившийся клиент SHALL начинать приём с чистого
 * состояния») проверяется на loopback'е — там она и живёт.
 */
import { describe, expect, it } from 'vitest';
import type { SceneDef } from '@fluxus/core';
import {
  connectClient,
  duelConfig,
  duelScene,
  harness,
  hello,
  inputMessage,
  settle,
  wireInput,
  STEP,
} from './fixtures.js';
import { parseClientMessage, ProtocolError } from '../src/protocol/messages.js';
import type {
  EventsMessage,
  ServerMessage,
  SnapshotMessage,
} from '../src/protocol/messages.js';
import type { MatchConfig, MatchServer, Outgoing } from '../src/server/matchServer.js';

// ------------------------------------------------------------------ хелперы

/** Матч с обоими занятыми слотами: соединение 1 — p1, соединение 2 — p2. */
function running(overrides: Partial<MatchConfig> = {}) {
  const config = duelConfig({ silenceTicks: 1000, ...overrides });
  const fixture = harness(config);
  fixture.server.connect(1);
  fixture.server.receive(1, hello('p1', config.version));
  fixture.server.connect(2);
  fixture.server.receive(2, hello('p2', config.version));
  fixture.server.drain();
  return { ...fixture, config };
}

function advance(server: MatchServer, ticks: number): void {
  for (let i = 0; i < ticks; i++) server.advance();
}

let seq = 0;

/**
 * Прогон тиков, на которых перечисленные соединения шлют ввод. Нужен там, где
 * предмет проверки — порог молчания: слот, за который никто не говорит, копит
 * молчание и завершает матч сам, унося с собой проверяемое утверждение.
 */
function play(server: MatchServer, ticks: number, senders: readonly number[]): void {
  for (let i = 0; i < ticks; i++) {
    seq++;
    for (const id of senders) server.receive(id, inputMessage(wireInput(server.tick + 2, seq)));
    server.advance();
  }
}

/** Сообщения, адресованные одному соединению, в порядке отправки. */
function messagesTo(outgoing: readonly Outgoing[], to: number): ServerMessage[] {
  return outgoing.filter((entry) => entry.to === to).map((entry) => entry.message);
}

/**
 * Вход соединения `id` за игрока `playerId`. Возвращает то, что сервер ответил
 * именно ему: `Welcome`, `Start` и отказы — всё адресное.
 */
function join(
  server: MatchServer,
  config: MatchConfig,
  id: number,
  playerId: string,
  role: 'owner' | 'substitute' = 'owner',
): ServerMessage[] {
  server.connect(id);
  server.receive(id, hello(playerId, config.version, false, role));
  return messagesTo(server.drain(), id);
}

/**
 * Сцена дуэли плюс маяк: каждый слот публикует событие на КАЖДОМ тике. Ровный
 * поток нужен затем, чтобы диапазоны сообщений `Events` были предсказуемы и
 * пересечение читалось по номерам тиков, а не по наличию пачек.
 */
function beaconScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'Beacon',
        order: 20,
        query: { all: ['Player'] },
        as: 'e',
        do: [{ emitEvent: { type: 'Beacon', data: { entity: { var: 'e' } } } }],
      },
    ],
  };
}

function eventsTo(outgoing: readonly Outgoing[], to: number): EventsMessage[] {
  return messagesTo(outgoing, to).filter(
    (message): message is EventsMessage => message.type === 'Events',
  );
}

// -------------------------------------------------------------------- тесты

describe('роль соединения в Hello (NTR-4, NTR-18)', () => {
  const wire = (extra: Record<string, unknown>): unknown => ({
    type: 'Hello',
    playerId: 'p1',
    version: { buildId: 'b', contentPackHash: 'c' },
    ...extra,
  });

  it('поле обязательно: Hello без роли — protocol-error', () => {
    // Умолчания у разбора нет намеренно: молча подставленная роль владельца
    // дала бы заместителю право вытеснять чужое соединение (NTR-18).
    expect(() => parseClientMessage(wire({}))).toThrow(ProtocolError);
  });

  it('незнакомая роль отвергается, а не приводится к владельцу', () => {
    expect(() => parseClientMessage(wire({ role: 'boss' }))).toThrow(ProtocolError);
    expect(() => parseClientMessage(wire({ role: null }))).toThrow(ProtocolError);
  });

  it('обе роли закрытого набора разбираются', () => {
    expect(parseClientMessage(wire({ role: 'owner' }))).toMatchObject({ role: 'owner' });
    expect(parseClientMessage(wire({ role: 'substitute' }))).toMatchObject({ role: 'substitute' });
  });
});

describe('реконнект владельца (NTR-17)', () => {
  it('возврат проходит тот же хендшейк: Welcome и Start с исходным тиком начала', () => {
    const { server, config } = running();
    advance(server, 10);
    server.disconnect(1);
    expect(server.slotAttached(0)).toBe(false);
    advance(server, 4);
    server.drain();

    const answered = join(server, config, 3, 'p1');
    expect(answered[0]).toMatchObject({ type: 'Welcome', slot: 0 });
    // Тик начала матча — ИСХОДНЫЙ (NTR-17): матч для вернувшегося не начался
    // заново, и `Start` не выдаёт текущий тик за начало.
    expect(answered[1]).toEqual({ type: 'Start', tick: 0 });
    expect(server.tick).toBe(14);
    expect(server.slotAttached(0)).toBe(true);
  });

  it('персональные снапшоты возобновляются с текущего места матча', () => {
    const { server, config } = running();
    advance(server, 10);
    server.disconnect(1);
    advance(server, 4);
    server.drain();

    join(server, config, 3, 'p1');
    advance(server, 2);
    const snapshots = messagesTo(server.drain(), 3).filter(
      (message): message is SnapshotMessage => message.type === 'Snapshot',
    );
    expect(snapshots).not.toHaveLength(0);
    // Досылки пропущенного нет: первое же состояние — «сейчас» матча (NTR-17).
    expect(snapshots[0]!.tick).toBe(server.tick);
    expect(snapshots.every((message) => message.tick >= 15)).toBe(true);
  });

  it('ростер, канонический лог и эпоха от возврата не двигаются', () => {
    const { server, config } = running();
    advance(server, 4);
    server.disconnect(1);
    advance(server, 6);
    join(server, config, 3, 'p1');
    advance(server, 4);

    // Слот всё это время получал predicted-кадры и записан в лог как обычно
    // (NTR-7, NTR-8): запись матча с разрывом реплеится без знания о разрыве.
    const own = server.canonicalInputs.filter((frame) => frame.playerId === 'p1');
    expect(own).toHaveLength(14);
    expect(own.map((frame) => frame.tick)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    expect(server.canonicalInputs).toHaveLength(28);
    // Ветвь истории не менялась — эпохе расти неоткуда (NTR-16).
    expect(server.epoch).toBe(0);
  });

  it('вернувшийся получает ввод обратно: его кадры применяются', () => {
    const { server, config } = running();
    advance(server, 4);
    server.disconnect(1);
    advance(server, 4);
    join(server, config, 3, 'p1');

    server.receive(3, inputMessage(wireInput(server.tick + 2, 40, STEP)));
    advance(server, 2);
    const applied = server.canonicalInputs.filter(
      (frame) => frame.playerId === 'p1' && frame.seq === 40,
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]!.move.x).toBe(STEP);
  });
});

describe('отказы идущего матча (NTR-6, NTR-17)', () => {
  it('идентификатора нет в ростере — отказ, названный по-своему', () => {
    const { server, config } = running();
    advance(server, 3);
    server.drain();
    // Реконнект возвращает участника ростера, но входа новым не открывает.
    expect(join(server, config, 3, 'p3')[0]).toMatchObject({ reason: 'unknown-player' });
  });

  it('слот занят живым владельцем — «слот занят», а не подмена соединения', () => {
    const { server, config } = running();
    advance(server, 3);
    server.drain();

    const answered = join(server, config, 3, 'p1');
    expect(answered[0]).toMatchObject({ type: 'Reject', reason: 'slot-taken' });
    // Живое соединение владельца не тронуто: двух владельцев у слота не бывает,
    // а «умного» отбора настоящего владельца без аутентификации нет (NTR-17).
    expect(server.slotAttached(0)).toBe(true);
    server.receive(1, inputMessage(wireInput(server.tick + 2, 7, STEP)));
    advance(server, 2);
    expect(server.canonicalInputs.some((frame) => frame.seq === 7)).toBe(true);
  });
});

describe('замещающее соединение (NTR-18)', () => {
  it('до Start заместителю отказ с названным исходом', () => {
    const config = duelConfig();
    const { server } = harness(config);
    const answered = join(server, config, 1, 'p1', 'substitute');
    expect(answered[0]).toMatchObject({ type: 'Reject', reason: 'substitute-before-start' });
    expect(server.phase).toBe('lobby');
  });

  it('садится на слот без живого соединения и получает Welcome со Start', () => {
    const { server, config } = running();
    advance(server, 6);
    server.disconnect(1);
    advance(server, 2);
    server.drain();

    const answered = join(server, config, 3, 'p1', 'substitute');
    expect(answered[0]).toMatchObject({ type: 'Welcome', slot: 0 });
    expect(answered[1]).toEqual({ type: 'Start', tick: 0 });
    expect(server.slotAttached(0)).toBe(true);
  });

  it('слот с живым соединением заместитель не отбирает ни у кого', () => {
    const { server, config } = running();
    advance(server, 2);
    server.drain();
    // Живой владелец.
    expect(join(server, config, 3, 'p1', 'substitute')[0]).toMatchObject({ reason: 'slot-taken' });

    server.disconnect(1);
    join(server, config, 4, 'p1', 'substitute');
    server.drain();
    // Живой заместитель — тот же отказ: заместитель не вытесняет никого.
    expect(join(server, config, 5, 'p1', 'substitute')[0]).toMatchObject({ reason: 'slot-taken' });
  });

  it('слот заместителя молчания не копит, и матч порогом не завершается', () => {
    const { server, config } = running({ silenceTicks: 6 });
    server.disconnect(1);
    play(server, 5, [2]);
    expect(server.metrics.slots[0]!.silentTicks).toBeGreaterThan(0);

    join(server, config, 3, 'p1', 'substitute');
    // Посадка живого соединения обнуляет счётчик: порог — окно ВОЗВРАТА, и
    // отсчитывать его новому арендатору с чужого числа нельзя (NTR-6).
    expect(server.metrics.slots[0]!.silentTicks).toBe(0);
    // Дальше слот ведёт заместитель, и для матча он неотличим от владельца:
    // ввод применяется, молчание не копится, порог не срабатывает (NTR-18).
    play(server, 20, [2, 3]);
    expect(server.phase).toBe('running');
    expect(server.canonicalInputs.some((frame) => frame.playerId === 'p1' && frame.seq > 0)).toBe(
      true,
    );
  });

  it('владелец вытесняет заместителя: исход назван, слот у владельца, ввод вытесненного отброшен', () => {
    const { server, config } = running();
    advance(server, 4);
    server.disconnect(1);
    join(server, config, 3, 'p1', 'substitute');
    advance(server, 2);
    server.drain();

    server.connect(4);
    server.receive(4, hello('p1', config.version));
    const out = server.drain();

    const displaced = out.filter((entry) => entry.to === 3);
    expect(displaced).toHaveLength(1);
    expect(displaced[0]!.message).toMatchObject({ type: 'Reject', reason: 'displaced-by-owner' });
    // Механизм — исход плюс разрыв: нового типа сообщения вытеснение не завело.
    expect(displaced[0]!.closeAfter).toBe(true);
    expect(messagesTo(out, 4)[0]).toMatchObject({ type: 'Welcome', slot: 0 });
    expect(server.slotAttached(0)).toBe(true);

    // Ввод вытесненного больше не принимается — тика с двумя арендаторами слота
    // не существует (NTR-18, NTR-7).
    server.receive(3, inputMessage(wireInput(server.tick + 2, 77, STEP)));
    server.receive(4, inputMessage(wireInput(server.tick + 2, 88, 0, STEP)));
    advance(server, 2);
    const own = server.canonicalInputs.filter((frame) => frame.playerId === 'p1');
    expect(own.some((frame) => frame.seq === 77)).toBe(false);
    expect(own.some((frame) => frame.seq === 88)).toBe(true);
  });

  it('закрытие вытесненного канала не отнимает слот у владельца', () => {
    const { server, config } = running();
    advance(server, 2);
    server.disconnect(1);
    join(server, config, 3, 'p1', 'substitute');
    join(server, config, 4, 'p1');
    // Транспорт вытесненного закрывается ПОСЛЕ того, как слот достался
    // владельцу: порядок здесь именно такой в живом матче.
    server.disconnect(3);
    expect(server.slotAttached(0)).toBe(true);
  });
});

describe('аренда слота кончается вместе с соединением (NTR-17, NTR-18)', () => {
  it('отказ севшему соединению освобождает слот, и владелец возвращается', () => {
    // Разрыв по названному исходу (NTR-4) — такая же смерть соединения, как
    // закрытый канал: испорченный кадр, сообщение не для своего состояния,
    // повторный `Hello`. Слот, оставшийся числиться за мертвецом, не пустил бы
    // обратно ни владельца (NTR-17), ни заместителя (NTR-18), а наблюдающей
    // сборке (BOT-14) сообщал бы неправду.
    const { server, config } = running();
    advance(server, 4);
    server.drain();
    expect(server.slotAttached(0)).toBe(true);

    server.protocolError(1, 'protocol-error', 'битый кадр');
    expect(server.drain()[0]!.message).toMatchObject({ type: 'Reject', reason: 'protocol-error' });
    expect(server.slotAttached(0)).toBe(false);

    // Закрытие канала следом ничего не ломает: соединения уже нет.
    server.disconnect(1);
    expect(server.slotAttached(0)).toBe(false);

    const answered = join(server, config, 3, 'p1');
    expect(answered[0]).toMatchObject({ type: 'Welcome', slot: 0 });
    expect(server.slotAttached(0)).toBe(true);
  });

  it('повторный Hello севшего соединения тоже освобождает слот', () => {
    const { server, config } = running();
    advance(server, 2);
    server.drain();
    server.receive(1, hello('p1', config.version));
    expect(server.drain().at(-1)!.message).toMatchObject({ reason: 'protocol-error' });
    expect(server.slotAttached(0)).toBe(false);
    // Заместителю слот теперь доступен — политика сборки не ждёт впустую.
    expect(join(server, config, 4, 'p1', 'substitute')[0]).toMatchObject({ type: 'Welcome' });
  });

  it('до старта отказ севшему освобождает и сам слот ростера', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.drain();
    server.protocolError(1, 'protocol-error', 'битый кадр');
    server.drain();

    // Состав ещё не заморожен: слот снова свободен, и его занимает следующий.
    expect(join(server, config, 2, 'p1')[0]).toMatchObject({ type: 'Welcome', slot: 0 });
    expect(server.phase).toBe('lobby');
  });
});

describe('порог молчания как окно возврата (NTR-6, NTR-17)', () => {
  it('возврат до превышения порога матч не завершает', () => {
    const { server, config } = running({ silenceTicks: 5 });
    server.disconnect(1);
    play(server, 5, [2]);
    expect(server.phase).toBe('running');
    expect(server.metrics.slots[0]!.silentTicks).toBe(5);

    join(server, config, 3, 'p1');
    play(server, 20, [2, 3]);
    expect(server.phase).toBe('running');
  });

  it('невозврат завершает матч End с названным исходом', () => {
    const { server } = running({ silenceTicks: 5 });
    server.disconnect(1);
    play(server, 6, [2]);
    expect(server.phase).toBe('ended');
    expect(server.drain().at(-1)!.message).toMatchObject({ type: 'End', reason: 'player-silent' });
  });
});

describe('поток событий на реаттаче (NTR-17, NTR-15)', () => {
  it('союзник по команде не отдаёт вернувшемуся ни своё накопленное, ни пропущенное', () => {
    // Накопитель потока — общий на `viewpoint` (NET-12), и слоты одной команды
    // делят его. «Открыт заново» при этом свойство СОЕДИНЕНИЯ: союзник обязан
    // получить всё накопленное, а вернувшийся — ничего из опубликованного до
    // его посадки, включая тики времени отсутствия (NTR-17 «Досылать
    // пропущенное… MUST NOT»).
    const { server, config } = running({ scene: beaconScene(), teams: [0, 0] });
    advance(server, 6);
    const before = eventsTo(server.drain(), 1);
    expect(before.at(-1)).toMatchObject({ from: 1, to: 6 });

    server.disconnect(1);
    // Тики отсутствия: их пачки накопитель собирает — для живого союзника.
    advance(server, 3);
    server.drain();
    join(server, config, 3, 'p1');
    advance(server, 2);

    const out = server.drain();
    const returned = eventsTo(out, 3);
    expect(returned).not.toHaveLength(0);
    expect(returned[0]!.from).toBeGreaterThan(9);
    expect(returned[0]!.batches.every((batch) => batch.tick > 9)).toBe(true);

    // А союзнику того же `viewpoint` тем же тиком уехало ВСЁ накопленное,
    // включая тики, на которых слота-соседа не было в матче.
    const ally = eventsTo(out, 2);
    expect(ally).not.toHaveLength(0);
    expect(ally[0]!.batches.some((batch) => batch.tick <= 9)).toBe(true);
  });

  it('первый диапазон после возврата не пересекается с доставленным до разрыва', () => {
    // Разрыв и возврат внутри одного тика — самый узкий случай: накопитель
    // слота выбросить некому, и без сброса кольцо повторов уехало бы
    // вернувшемуся дублями уже виденных тиков (design D6).
    const { server, config } = running({ scene: beaconScene() });
    advance(server, 6);
    const before = eventsTo(server.drain(), 1);
    expect(before.at(-1)).toMatchObject({ from: 1, to: 6 });

    server.disconnect(1);
    join(server, config, 3, 'p1');
    advance(server, 2);
    const after = eventsTo(server.drain(), 3);

    expect(after).not.toHaveLength(0);
    expect(after[0]!.from).toBeGreaterThan(6);
    expect(after[0]!.batches.every((batch) => batch.tick > 6)).toBe(true);
  });
});

describe('срез потока не порождает кадра без диапазона (NTR-15, NTR-4)', () => {
  it('весь объявленный диапазон опубликован до посадки — сообщения нет вовсе', () => {
    // Узкий случай без смены эпохи: соединение село посреди ОТКРЫТОГО окна, а
    // перемотка тут же вернула мир на тик раньше посадки. Прежний срез отдал бы
    // `from > to` — кадр, который разбор обязан отвергнуть (NTR-4), — вместо
    // того чтобы промолчать.
    const { server, config } = running({
      scene: beaconScene(),
      rewind: { interval: 1, capacity: 64 },
    });
    advance(server, 8);
    server.disconnect(1);
    join(server, config, 3, 'p1');
    server.drain();

    // Восстановление на тик РАНЬШЕ посадки: префикс стёртой эпохи уходит
    // соединениям, которые его собирали, а вернувшемуся — нечего.
    server.pause();
    server.beginRewind();
    // Точка восстановления внутри кольца повторов и РАНЬШЕ тика посадки
    // вернувшегося: префикс стёртой эпохи для его соседа есть, для него — нет.
    server.seekTo(6);
    const out = server.drain();

    for (const entry of out) {
      if (entry.message.type !== 'Events') continue;
      // Ни одного перевёрнутого диапазона: это и есть «кадр без диапазона».
      expect(entry.message.to).toBeGreaterThanOrEqual(entry.message.from);
    }
    // Вернувшемуся из этого префикса не уехало ничего: всё в нём опубликовано
    // до его посадки (NTR-17).
    expect(eventsTo(out, 3)).toHaveLength(0);
    // А слоту, никуда не уходившему, префикс достался.
    expect(eventsTo(out, 2)).not.toHaveLength(0);
  });
});

describe('возврат и перемотка на одном канале (NTR-17, NTR-16, NTR-4)', () => {
  it('перемотка после возврата не выбивает вернувшегося из идущего матча', async () => {
    // ЧЕРЕЗ КОДЕК, а не вызовами `MatchServer` напрямую: цена дефекта здесь —
    // кадр, который получатель обязан отвергнуть (перевёрнутый диапазон
    // `from > to`, NTR-15), а отвергает его разбор (NTR-4). Сервер, говорящий с
    // клиентом мимо кодека, такого не замечает вовсе.
    const config = duelConfig({
      silenceTicks: 1000,
      scene: beaconScene(),
      // Матч с ульту отката: демо-арена играет именно так
      // (`content/matches/duel.match.json`), и перемотка на ней — главный путь,
      // а не редкий случай.
      rewind: { interval: 1, capacity: 128 },
    });
    const { hub, server, host, clock } = harness(config);
    const owner = connectClient(hub, 'p1', clock, config.scene);
    const rival = connectClient(hub, 'p2', clock, config.scene);
    await settle();
    expect(server.phase).toBe('running');
    for (let i = 0; i < 12; i++) host.step();
    await settle();

    // Разрыв и возврат владельца: срез потока для нового соединения открыт с
    // тика его посадки (NTR-17).
    owner.transport.close('обрыв сети');
    await settle();
    for (let i = 0; i < 4; i++) host.step();
    await settle();
    const back = connectClient(hub, 'p1', clock, config.scene);
    await settle();
    expect(back.client.phase).toBe('playing');
    for (let i = 0; i < 4; i++) {
      host.step();
      back.host.step();
      rival.host.step();
    }
    await settle();
    const seatedAt = server.tick;
    const deliveredBefore = back.client.metrics.eventBatchesDelivered;

    // Ульта отката: точка восстановления РАНЬШЕ тика посадки вернувшегося —
    // ровно то, ради чего перемотка и существует.
    server.pause();
    server.beginRewind();
    server.seekTo(6);
    server.pause();
    server.resume();
    host.flush();
    await settle();
    expect(server.epoch).toBe(1);
    expect(server.tick).toBeLessThan(seatedAt);

    for (let i = 0; i < 8; i++) {
      host.step();
      back.host.step();
      rival.host.step();
    }
    await settle();

    // Вернувшийся остался в матче: канал жив, отказа не было.
    expect(back.client.phase).toBe('playing');
    expect(back.client.closeReason).toBeUndefined();
    expect(server.phase).toBe('running');
    // Состояние новой ветви истории до него доехало и применилось (NTR-16).
    expect(back.client.epoch).toBe(1);
    expect(back.client.latest!.tick).toBe(server.tick);
    // И факты новой ветви — тоже: срез прежней эпохи их не режет, иначе
    // «события каждого исполненного тика SHALL доставляться» (NTR-15) держалось
    // бы для соперника и не держалось для вернувшегося.
    expect(back.client.metrics.eventBatchesDelivered).toBeGreaterThan(deliveredBefore);
    expect(back.client.metrics.eventRangeGaps).toBe(0);
    // Соперник, никуда не уходивший, прожил ту же перемотку так же.
    expect(rival.client.phase).toBe('playing');
    expect(rival.client.epoch).toBe(1);
  });
});

describe('клиент входит в идущий матч (NTR-17, NTR-10)', () => {
  it('свежий клиент возвращается в свой слот и продолжает получать состояние', async () => {
    const config = duelConfig({ silenceTicks: 1000 });
    const { hub, server, host, clock } = harness(config);
    const owner = connectClient(hub, 'p1', clock, config.scene);
    connectClient(hub, 'p2', clock, config.scene);
    await settle();
    expect(server.phase).toBe('running');

    for (let i = 0; i < 20; i++) host.step();
    await settle();
    expect(owner.client.phase).toBe('playing');

    owner.transport.close('обрыв канала');
    await settle();
    expect(server.slotAttached(0)).toBe(false);
    // Оборванный канал называется своим исходом — после него возврат возможен.
    expect(owner.client.closeReason).toBe('disconnected');

    for (let i = 0; i < 10; i++) host.step();
    await settle();

    const back = connectClient(hub, 'p1', clock, config.scene);
    await settle();
    expect(back.client.slot).toBe(0);
    expect(back.client.phase).toBe('playing');

    for (let i = 0; i < 4; i++) {
      host.step();
      back.host.step();
    }
    await settle();
    back.host.step();

    // Первое принятое состояние — «сейчас» матча, и оценка серверного тика
    // синхронизирована по нему (NTR-17): кадры уезжают в актуальные тики, а не
    // в тик начала матча, приехавший повторным `Start`. Не равенство, а окно:
    // оценка идёт своим темпом и ограничена сверху периодом рассылки плюс
    // запасом задержки (`resyncTick`).
    expect(back.client.latest!.tick).toBe(server.tick);
    expect(back.client.serverTick).toBeGreaterThanOrEqual(server.tick);
    expect(back.client.serverTick).toBeLessThanOrEqual(server.tick + 4);
    // Чистый курсор потока: первый принятый диапазон разрывом не считается.
    expect(back.client.metrics.eventRangeGaps).toBe(0);
    expect(back.client.epoch).toBe(0);

    back.client.pushInput({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 }, clock.ms);
    back.host.flush();
    await settle();
    // Кадр помечен тиком `оценка + inputDelay` (NTR-7) и применяется, когда до
    // него дойдёт расписание: несколько тиков запаса на дорогу до него.
    for (let i = 0; i < 8; i++) host.step();
    expect(
      server.canonicalInputs.some((frame) => frame.playerId === 'p1' && frame.move.x === STEP),
    ).toBe(true);
  });
});
