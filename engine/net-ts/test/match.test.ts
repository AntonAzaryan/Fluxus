/**
 * Матч двух игроков целиком (NTR-8, NTR-10, NTR-12): сервер, два клиента и
 * внутрипроцессный транспорт — тот же код, что играет по сети.
 *
 * Главная проверка здесь — парность (NTR-8): записанный матч прогоняется через
 * `runScenario` ядра и обязан дать побитово то же состояние. Без неё у сетевого
 * слоя нет доказательства, что он не сломал детерминизм, и первое же
 * расхождение искали бы в ядре, где его нет.
 */
import { describe, expect, it } from 'vitest';
import {
  fixed,
  query,
  runScenario,
  snapshotToPlain,
  world as coreWorld,
} from '@fluxus/core';
import {
  connectClient,
  duelConfig,
  duelScene,
  harness,
  hello,
  inputMessage,
  inputMessageOf,
  placedScene,
  settle,
  wireInput,
  STEP,
  type ConnectedClient,
} from './fixtures.js';
import { replaySegments } from '../src/match/replay.js';
import { toWireSnapshot } from '../src/protocol/messages.js';
import type { InputSource } from '../src/client/host.js';
import type { PresentedState } from '../src/client/interpolation.js';
import type { MatchConfig, Outgoing } from '../src/server/matchServer.js';

function walkRight(untilTick: number): InputSource {
  return (tick) => (tick <= untilTick ? { move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined);
}

function positionOfSlot(snapshot: PresentedState, slot: number): { x: number; y: number } | undefined {
  for (const entity of query(snapshot.world, { all: ['Player', 'Position'] })) {
    if (coreWorld.getField(snapshot.world, entity, 'Player', 'slot') !== slot) continue;
    return {
      x: coreWorld.getField(snapshot.world, entity, 'Position', 'x'),
      y: coreWorld.getField(snapshot.world, entity, 'Position', 'y'),
    };
  }
  return undefined;
}

async function playMatch(ticks: number, config: MatchConfig = duelConfig()) {
  const fixture = harness(config);
  const scene = config.scene;
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, { input: walkRight(8) });
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
  await settle();

  for (let i = 0; i < ticks; i++) {
    fixture.clock.ms += 1000 / 60;
    a.host.step();
    b.host.step();
    await settle();
    fixture.host.step();
    await settle();
  }
  return { ...fixture, a, b };
}

describe('матч двух игроков', () => {
  it('хендшейк доводит обоих до игры', async () => {
    const { server, a, b } = await playMatch(0);
    expect(server.phase).toBe('running');
    expect(a.client.phase).toBe('playing');
    expect(b.client.phase).toBe('playing');
    expect(a.client.slot).toBe(0);
    expect(b.client.slot).toBe(1);
  });

  it('ввод игрока 1 доезжает до состояния, которое видит игрок 2', async () => {
    const { b, server } = await playMatch(24);

    expect(server.tick).toBeGreaterThan(0);
    const seen = b.client.latest;
    expect(seen).toBeDefined();
    // Игрок 2 не двигался и видит чужое движение исключительно из снапшота.
    expect(positionOfSlot(seen!, 0)!.x).toBeGreaterThan(0);
    expect(positionOfSlot(seen!, 1)!.x).toBe(0);
  });

  it('записанный матч воспроизводится прогоном сценария побитово (NTR-8)', async () => {
    const { server } = await playMatch(24);

    const replay = runScenario(server.toScenario());
    expect(replay.worldInitHash).toBe(server.worldInitHash);
    expect(replay.ticks).toHaveLength(server.tick + 1);
    // Последний тик прогона против канонического состояния сервера — включая
    // rng, шину событий и режим мира, а не только позиции.
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
  });

  it('расстановка сцены применяется до расстановки матча и остаётся парной ядру (SER-8, NTR-8)', async () => {
    // Сцена с непустым `initial`: пролог `buildMatchWorld` повторяет пролог
    // ядра, и забытая в нём расстановка сцены разошлась бы именно здесь.
    const { server, a } = await playMatch(12, duelConfig({ scene: placedScene() }));

    const snapshot = server.snapshot();
    // Реквизит сцены занял первые слоты, герои матча встали за ним (ID-2).
    const positions = [...query(snapshot.world, { all: ['Position'] })].map((entity) => ({
      x: coreWorld.getField(snapshot.world, entity, 'Position', 'x'),
      hero: coreWorld.hasComponent(snapshot.world, entity, 'Player'),
    }));
    expect(positions).toHaveLength(4);
    expect(positions.slice(0, 2).map((entry) => entry.hero)).toEqual([false, false]);
    expect(positions.slice(2).map((entry) => entry.hero)).toEqual([true, true]);

    const replay = runScenario(server.toScenario());
    expect(replay.worldInitHash).toBe(server.worldInitHash);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(snapshot));
    // Клиент поднимает мир той же сборкой из той же сцены контент-пака (NTR-5).
    expect(a.client.worldInitHash).toBe(server.worldInitHash);
  });

  it('канонический лог содержит кадр каждого слота на каждом тике', async () => {
    const { server } = await playMatch(12);

    const frames = server.canonicalInputs;
    expect(frames).toHaveLength(server.tick * 2);
    for (let tick = 1; tick <= server.tick; tick++) {
      const atTick = frames.filter((frame) => frame.tick === tick);
      expect(atTick.map((frame) => frame.playerId).sort()).toEqual(['p1', 'p2']);
    }
  });

  it('клиент не тикает симуляцию — он применяет чужое состояние (NTR-10)', async () => {
    const { a, server } = await playMatch(16);

    // Локальный мир клиента поднят ради сверки хешей и остался на worldInit:
    // предсказания пока нет, и мир вперёд клиент не двигает.
    expect(a.client.worldInitHash).toBe(server.worldInitHash);
    expect(a.client.latest!.tick).toBeGreaterThan(0);
  });

  it('устаревший снапшот отбрасывается (NTR-10)', async () => {
    const { a, server, clock } = await playMatch(16);

    const applied = a.client.metrics.snapshotsApplied;
    const lastTick = a.client.latest!.tick;
    a.client.receive(
      { type: 'Snapshot', epoch: 0, tick: lastTick - 2, snapshot: toWireSnapshot(server.snapshot()) },
      clock.ms,
    );

    expect(a.client.metrics.snapshotsDropped).toBe(1);
    expect(a.client.metrics.snapshotsApplied).toBe(applied);
    expect(a.client.latest!.tick).toBe(lastTick);
    // Отброшенный снапшот признака разрыва не взводит: он не состояние другой
    // ветви истории, а старое состояние этой (SHELL-7).
    expect(a.client.discontinuous).toBe(false);
  });

  it('признак разрыва едет в доставке состояния и гасится ею (SHELL-7)', async () => {
    const { a, server, clock } = await playMatch(16);

    // Фон: пока эпоха одна, доставка идёт без разрыва.
    expect(a.client.sample(clock.ms)!.discontinuity).toBe(false);

    const rewoundTo = a.client.latest!.tick - 4;
    a.client.receive(
      {
        type: 'Snapshot',
        epoch: 1,
        tick: rewoundTo,
        snapshot: { ...toWireSnapshot(server.snapshot()), tick: rewoundTo },
      },
      clock.ms,
    );

    // Признак приезжает вместе с состоянием, а не отдельным вызовом рядом с ним.
    const sampled = a.client.sample(clock.ms)!;
    expect(sampled.discontinuity).toBe(true);
    // Буфер интерполяции сброшен, и показывается именно перемотанное состояние.
    // Без сброса буфер держал бы состояния прежней эпохи, порядок в нём задан
    // тиком, и показанным осталось бы состояние стёртой ветви (NTR-10).
    expect(sampled.to.tick).toBe(rewoundTo);
    expect(a.client.latest!.tick).toBe(rewoundTo);
    // Интерполировать между ветвями истории нечем: «проезда» нет.
    expect(sampled.from).toBe(sampled.to);
    // И гасится доставкой: второй кадр рисуется уже обычным порядком.
    expect(a.client.sample(clock.ms)!.discontinuity).toBe(false);
    expect(a.client.discontinuous).toBe(false);
    // Перемотка унесла отправленный в прежней эпохе ввод — это видно счётчиком
    // (NTR-10), и в мир он при этом не попадает (NTR-11). Унесено ровно всё
    // отправленное: кольцо глубже матча, и другой эпохи в нём не было.
    expect(a.client.metrics.inputsStranded).toBe(a.client.metrics.inputsSent);
    expect(a.client.metrics.inputsSent).toBeGreaterThan(0);
  });

  it('в замороженный мир клиент ввод шлёт: в нём едет управление перемоткой (NET-11, REW-5)', async () => {
    const { a, server, clock } = await playMatch(16);

    const sent = a.client.metrics.inputsSent;
    // Состояние с сервера, который перематывает: режим мира приезжает внутри
    // снапшота (SNAP-1), и он же — единственный честный источник для клиента.
    // Матч поднят без истории, поэтому режим ставится прямо в плоской форме —
    // предмет проверки здесь клиентский, а не серверный.
    a.client.receive(
      {
        type: 'Snapshot',
        epoch: 1,
        tick: a.client.latest!.tick - 4,
        snapshot: { ...toWireSnapshot(server.snapshot()), mode: 'Rewinding' },
      },
      clock.ms,
    );

    // Клиент продолжает слать: во время `Rewinding` живых тиков нет, и
    // контрольный бит ведения перемотки едет ровно этими кадрами — второго
    // канала под управление в протоколе нет (NTR-8). Различить «мой бит ведёт
    // скраб» и «мой бит — обычное действие» клиент не может: инициатора знает
    // сервер.
    a.client.pushInput({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 }, clock.ms);
    expect(a.client.metrics.inputsSent).toBe(sent + 1);
    // На симуляцию такой кадр всё равно не влияет — отбор авторитетный и стоит
    // на сервере: «ввод в замороженный мир до симуляции не доходит» ниже.
  });
});

/**
 * Перемотка на сервере (NET-11) и сегментированный канонический лог (NTR-16).
 *
 * Матч гоняется по `MatchServer` напрямую: предмет проверки — что сервер
 * рассылает восстановленное состояние и как выглядит лог, а не транспорт.
 */
describe('перемотка на сервере (NET-11, NTR-16)', () => {
  function rewindableMatch(overrides: Partial<MatchConfig> = {}) {
    const config = duelConfig({ rewind: { interval: 1, capacity: 64 }, ...overrides });
    const fixture = harness(config);
    fixture.server.connect(1);
    fixture.server.receive(1, hello('p1', config.version));
    fixture.server.connect(2);
    fixture.server.receive(2, hello('p2', config.version));
    fixture.server.drain();
    return { ...fixture, config };
  }

  /** Пары `(эпоха, тик)` разосланных состояний глазами одного соединения. */
  function pairsOf(outgoing: readonly Outgoing[]): [number, number][] {
    const pairs: [number, number][] = [];
    for (const entry of outgoing) {
      const message = entry.message;
      if (entry.to !== 1 || message.type !== 'Snapshot') continue;
      pairs.push([message.epoch, message.tick]);
    }
    return pairs;
  }

  it('эпоха растёт только там, где номер тика уменьшился: скраб 500 → 480 → 490 → 470 (NTR-16)', () => {
    // Та самая последовательность, на которой правило проверяется в решении 2
    // design.md: инициатор ведёт точку остановки назад, вперёд и снова назад.
    const { server } = rewindableMatch({ rewind: { interval: 1, capacity: 600 } });
    // Шаг вправо на каждом тике: позиция слота 0 равна номеру тика, и по ней
    // видно, что скраб восстанавливает именно запрошенное состояние, а не
    // ближайший снапшот.
    for (let tick = 1; tick <= 500; tick++) {
      server.receive(1, inputMessage(wireInput(tick, tick, STEP)));
      server.advance();
    }
    server.drain();

    const pairs: [number, number][] = [];
    const positions: number[] = [];
    server.pause();
    server.beginRewind();
    // Четвёртый шаг — повторная рассылка уже восстановленного состояния.
    for (const target of [480, 490, 470, 470]) {
      server.seekTo(target);
      pairs.push(...pairsOf(server.drain()));
      positions.push(positionOfSlot(server.snapshot(), 0)!.x);
    }

    // (0,500) < (1,480) < (1,490) < (2,470). Счётчик, привязанный ко входу в
    // `Rewinding` или к вызову `seekTo`, дал бы либо одну эпоху на весь скраб —
    // и пара (1,470) оказалась бы МЕНЬШЕ (1,490), то есть клиент погасил бы
    // конечное положение ползунка (NTR-10), — либо новую эпоху на каждый шаг, и
    // промежуточные положения объявились бы разными ветвями истории.
    expect(pairs).toEqual([
      [1, 480],
      [1, 490],
      [2, 470],
      // Повторная рассылка того же состояния: пара равна предыдущей, и эпоха не
      // растёт — другого состояния с этой парой не существует (NTR-16).
      [2, 470],
    ]);
    expect(server.epoch).toBe(2);
    expect(server.tick).toBe(470);
    // Скраб вперёд не «стоит на месте»: тики 481..490 доигрываются по тем же
    // каноническим вводам, из которых они были исполнены (REW-2, NTR-16).
    expect(positions).toEqual([480, 490, 470, 470].map(fixed.fromInt));
    // Скраб тиков не исполнял, поэтому сегментов новых эпох в логе нет: эпохи 1
    // и 2 прошли без единого живого тика (NTR-16).
    expect(server.canonicalSegments.map((segment) => segment.epoch)).toEqual([0]);
  });

  it('матч без перемотки даёт ровно один сегмент, совпадающий с плоским логом', () => {
    const { server } = rewindableMatch();
    for (let tick = 1; tick <= 6; tick++) server.advance();

    const segments = server.canonicalSegments;
    expect(segments).toHaveLength(1);
    expect(segments[0]!.epoch).toBe(0);
    expect(segments[0]!.frames).toEqual(server.canonicalInputs);
    // Документ сценария у такого матча прежний, и прогон ядра ему парен (NTR-8).
    const replay = runScenario(server.toScenario());
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
  });

  it('восстановленное состояние рассылается по факту, мимо расписания, с новой эпохой', () => {
    const { server } = rewindableMatch();
    for (let tick = 1; tick <= 7; tick++) {
      server.receive(1, inputMessage(wireInput(tick, tick, STEP)));
      server.advance();
    }
    // Тик 7 не кратен `snapshotEvery` (60/30 = 2): очередной момент расписания
    // ещё не наступил, и всё, что уедет дальше, послано именно восстановлением.
    server.drain();

    server.pause();
    server.beginRewind();
    server.seekTo(4);

    expect(server.mode).toBe('Rewinding');
    expect(server.tick).toBe(4);
    expect(server.epoch).toBe(1);
    const sent = server.drain().filter((entry) => entry.message.type === 'Snapshot');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.message).toMatchObject({ type: 'Snapshot', epoch: 1, tick: 4 });
  });

  it('ввод прежней эпохи после перемотки отбрасывается как вышедший за окно (NTR-7)', () => {
    const { server } = rewindableMatch();
    for (let tick = 1; tick <= 6; tick++) server.advance();
    server.pause();
    server.beginRewind();
    server.seekTo(3);
    server.pause();
    server.resume();

    server.receive(1, inputMessage(wireInput(5, 42, STEP)));
    expect(server.metrics.slots[0]!.outOfWindow).toBe(1);
    expect(server.metrics.slots[0]!.late).toBe(0);

    // Эпоха — величина сообщения, а счёт идёт по кадрам: сообщение стёртой
    // ветви уносит с собой весь свой ввод, сколько бы кадров в нём ни было.
    server.receive(1, inputMessage(wireInput(6, 43, STEP), wireInput(7, 44, STEP)));
    expect(server.metrics.slots[0]!.outOfWindow).toBe(3);
    expect(server.metrics.slots[0]!.late).toBe(0);
  });

  it('predicted-кадр после перемотки повторяет кадр тика восстановления (NTR-7)', () => {
    const { server } = rewindableMatch();
    // До тика 4 игрок шёл вправо, после — влево: различаются не только номера
    // `seq`, но и сам ввод, поэтому повтор «последнего полученного» виден и в
    // состоянии мира, а не только в логе.
    for (let tick = 1; tick <= 8; tick++) {
      server.receive(1, inputMessage(wireInput(tick, tick, tick <= 4 ? STEP : -STEP)));
      server.advance();
    }

    server.pause();
    server.beginRewind();
    server.seekTo(4);
    server.pause();
    server.resume();
    // Ровно один тик после возобновления: проверяется ПЕРВЫЙ тик новой ветви,
    // на котором кадра ещё нет ни у одного слота.
    server.advance();

    const segments = server.canonicalSegments;
    expect(segments).toHaveLength(2);
    // Повторён кадр тика 4, а не последний полученный сервером кадр тика 8:
    // мир вернулся в состояние тика 4 целиком (REW-2), и ввода из стёртого
    // будущего в этой ветви истории не было.
    expect(segments[1]!.frames[0]).toMatchObject({ playerId: 'p1', tick: 5, seq: 4 });
    expect(segments[1]!.frames[0]!.move.x).toBe(STEP);
    // И мир на этом тике поехал вправо, а не влево.
    expect(server.tick).toBe(5);
    expect(positionOfSlot(server.snapshot(), 0)!.x).toBe(fixed.fromInt(5));
  });

  it('переисполненные тики уходят во второй сегмент, и его прогон парен серверу', () => {
    const { server, config } = rewindableMatch();
    for (let tick = 1; tick <= 8; tick++) {
      server.receive(1, inputMessage(wireInput(tick, tick, STEP)));
      server.advance();
    }

    server.pause();
    server.beginRewind();
    server.seekTo(4);
    server.pause();
    server.resume();
    for (let tick = 5; tick <= 8; tick++) server.advance();

    const segments = server.canonicalSegments;
    expect(segments.map((segment) => segment.epoch)).toEqual([0, 1]);
    expect(segments[0]!.frames.map((frame) => frame.tick)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
    expect(segments[1]!.frames.map((frame) => frame.tick)).toEqual([5, 5, 6, 6, 7, 7, 8, 8]);

    // Прогон сегментированной записи: перед первым кадром сегмента мир
    // восстанавливается на предшествующий тик (NTR-16).
    const replay = replaySegments({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      segments,
    });
    expect(replay.worldInitHash).toBe(server.worldInitHash);
    expect(replay.tick).toBe(server.tick);
    expect(snapshotToPlain(replay.snapshot)).toEqual(snapshotToPlain(server.snapshot()));

    // Плоской формы документа у такого матча нет, и отказ явный (CLI-2).
    expect(() => server.toScenario()).toThrow(/сегмент/);
  });

  it('вторая перемотка восстанавливает живую ветвь, а не стёртую первой (REW-2, NTR-16)', () => {
    const { server } = rewindableMatch();
    // Эпоха 0: игрок идёт вправо восемь тиков.
    for (let tick = 1; tick <= 8; tick++) {
      server.receive(1, inputMessage(wireInput(tick, tick, STEP)));
      server.advance();
    }
    expect(positionOfSlot(server.snapshot(), 0)!.x).toBe(fixed.fromInt(8));

    server.pause();
    server.beginRewind();
    server.seekTo(4);
    server.pause();
    server.resume();
    expect(server.epoch).toBe(1);

    // Эпоха 1: те же номера тиков исполняются заново, и игрок идёт влево.
    for (let tick = 5; tick <= 8; tick++) {
      server.receive(1, inputMessageOf(1, wireInput(tick, 100 + tick, -STEP)));
      server.advance();
    }
    expect(positionOfSlot(server.snapshot(), 0)!.x).toBe(0);

    // Вторая перемотка на тик 6. В истории лежит по снапшоту тика 6 на каждую
    // ветвь, и без отсечения стёртой восстановилась бы она — молча и с
    // расхождением парности (NTR-8).
    server.pause();
    server.beginRewind();
    server.seekTo(6);

    expect(server.tick).toBe(6);
    expect(server.epoch).toBe(2);
    expect(positionOfSlot(server.snapshot(), 0)!.x).toBe(fixed.fromInt(2));
  });

  it('пропуск тика в записи отвергается, а не доигрывается нулевым вводом (NTR-16)', () => {
    const config = duelConfig();
    const frames = (tick: number) =>
      config.players.map((playerId) => ({
        tick,
        playerId,
        seq: 0,
        move: { x: 0, y: 0 },
        aimDir: 0,
        buttons: 0,
      }));

    // Сегменты покрывают тики 1..2 и 5..6: тики 3 и 4 не исполнены ни одним из
    // них, то есть запись не полна. Доиграть их нулевым вводом означало бы
    // получить состояние, которого на сервере не было (DET-1, NTR-8).
    expect(() =>
      replaySegments({
        scene: config.scene,
        seed: config.seed,
        players: config.players,
        ...(config.initial !== undefined ? { initial: config.initial } : {}),
        segments: [
          { epoch: 0, frames: [...frames(1), ...frames(2)] },
          { epoch: 1, frames: [...frames(5), ...frames(6)] },
        ],
      }),
    ).toThrow(/не покрыт/);
  });

  it('точка остановки впереди исполненного тика отвергается (REW-7)', () => {
    const { server } = rewindableMatch();
    for (let tick = 1; tick <= 8; tick++) server.advance();

    server.pause();
    server.beginRewind();
    expect(() => { server.seekTo(9); }).toThrow(/впереди/);
    // Мир при этом не сдвинулся ни на тик: реплей по пустому логу не начался.
    expect(server.tick).toBe(8);

    // Скраб назад и снова вперёд внутри одной перемотки законен (NTR-16):
    // тики 5..6 исполнены и лежат в каноническом логе, и доигрываются по нему.
    server.seekTo(4);
    server.seekTo(6);
    expect(server.tick).toBe(6);

    // А после возобновления и первого же живого тика прежнее будущее стёрто:
    // записи лога на тики 8.. принадлежат ветви, которой в матче больше нет, и
    // доиграть по ним значило бы выдать состояние, авторитетным не бывшее.
    // Поэтому граница — последний ИСПОЛНЕННЫЙ тик, а не максимум за матч.
    server.pause();
    server.resume();
    server.advance();
    expect(server.tick).toBe(7);
    server.pause();
    server.beginRewind();
    expect(() => { server.seekTo(8); }).toThrow(/впереди/);
  });

  it('ввод в замороженный мир до симуляции не доходит (NET-11, REW-5)', () => {
    const { server } = rewindableMatch();
    for (let tick = 1; tick <= 4; tick++) server.advance();

    // `Paused`: кадр помечен верной эпохой и будущим тиком в окне — все
    // остальные проверки приёма он проходит.
    server.pause();
    server.receive(1, inputMessage(wireInput(6, 55, STEP)));
    // Кадры замороженного мира не судятся вовсе: даже адресованный далеко за
    // окно приёма не растит счётчик — сервер их не рассматривает.
    server.receive(1, inputMessage(wireInput(100_000, 57, STEP)));
    // `Rewinding`: перемотка на тот же тик эпохи не двигает (NTR-16), поэтому и
    // сброс неприменённого ввода по смене эпохи здесь не срабатывает.
    server.beginRewind();
    server.seekTo(4);
    server.receive(1, inputMessageOf(server.epoch, wireInput(6, 56, STEP)));
    server.pause();
    server.resume();

    for (let tick = 5; tick <= 6; tick++) server.advance();

    const own = server.canonicalInputs.filter((frame) => frame.playerId === 'p1');
    expect(own.some((frame) => frame.seq === 55 || frame.seq === 56)).toBe(false);
    // Залпа на возобновлении нет: мир игрока не двигался вовсе.
    expect(positionOfSlot(server.snapshot(), 0)!.x).toBe(0);
    // Молча: канал исправен, и NTR-11 такого класса дефекта не определяет.
    const counters = server.metrics.slots[0]!;
    expect(counters.applied).toBe(0);
    expect(counters.late).toBe(0);
    expect(counters.outOfWindow).toBe(0);
  });
});

/**
 * Клиент: номер состояния — пара `(эпоха, тик)` (NTR-10, NTR-16).
 *
 * Состояния подаются клиенту синтетически, минуя транспорт: предмет проверки —
 * правило сравнения пар и три его следствия (буфер, признак разрыва, оценка
 * серверного тика), а не доставка. Плоская форма при этом настоящая, снятая с
 * сервера, — иначе проверялось бы сравнение чисел, а не применение состояния.
 */
describe('клиент: номер состояния — пара (эпоха, тик) (NTR-10, NTR-16)', () => {
  async function playing() {
    const played = await playMatch(16);
    const plain = toWireSnapshot(played.server.snapshot());
    // Номер тика в плоской форме тот же, что в сообщении: снапшот тика T несёт
    // состояние тика T, и подложить одно под номером другого значило бы
    // проверять сравнение чисел вместо применения состояния.
    const send = (epoch: number, tick: number): void => {
      played.a.client.receive(
        { type: 'Snapshot', epoch, tick, snapshot: { ...plain, tick } },
        played.clock.ms,
      );
    };
    return { ...played, send };
  }

  it('снапшот перемотки применяется: пара больше применённой при меньшем тике', async () => {
    const { a, send } = await playing();
    const applied = a.client.metrics.snapshotsApplied;
    const dropped = a.client.metrics.snapshotsDropped;
    const before = a.client.latest!.tick;

    send(1, before - 4);

    // Сравнение по одному номеру тика погасило бы ровно это состояние — то,
    // которое NET-11 велит показать: «устаревший» и «перемотанный» снапшоты по
    // тику неразличимы.
    expect(a.client.metrics.snapshotsApplied).toBe(applied + 1);
    expect(a.client.metrics.snapshotsDropped).toBe(dropped);
    expect(a.client.latest!.tick).toBe(before - 4);
    expect(a.client.epoch).toBe(1);
  });

  it('равная пара отбрасывается: другого состояния с этой парой не существует', async () => {
    const { a, send } = await playing();
    send(1, a.client.latest!.tick - 4);
    const applied = a.client.metrics.snapshotsApplied;
    const dropped = a.client.metrics.snapshotsDropped;
    const tick = a.client.latest!.tick;

    // Повторная рассылка того же состояния: живой тик исполняется за эпоху один
    // раз, а восстановление на тот же тик внутри эпохи даёт то же состояние.
    send(1, tick);

    expect(a.client.metrics.snapshotsApplied).toBe(applied);
    expect(a.client.metrics.snapshotsDropped).toBe(dropped + 1);
    expect(a.client.latest!.tick).toBe(tick);
  });

  it('снапшот большего тика, но прежней эпохи, гасится и признака разрыва не взводит', async () => {
    const { a, send, clock } = await playing();
    send(1, a.client.latest!.tick - 4);
    // Разрыв смены эпохи прочитан и погашен — дальше проверяется чистый фон.
    expect(a.client.sample(clock.ms)!.discontinuity).toBe(true);
    const tick = a.client.latest!.tick;
    const dropped = a.client.metrics.snapshotsDropped;

    // Состояние стёртой ветви, доехавшее с опозданием: по номеру тика оно
    // «свежее» применённого, по паре — старше.
    send(0, tick + 10);

    expect(a.client.metrics.snapshotsDropped).toBe(dropped + 1);
    expect(a.client.latest!.tick).toBe(tick);
    expect(a.client.epoch).toBe(1);
    // Признак взводит РОСТ эпохи, а не всякое её несовпадение: иначе оболочка
    // рисовала бы snap на состоянии, которого она даже не получила (SHELL-7).
    expect(a.client.discontinuous).toBe(false);
  });

  it('оценка серверного тика пересинхронизируется по первому снапшоту новой эпохи', async () => {
    const { a, send, clock } = await playing();
    expect(a.client.serverTick).toBeGreaterThan(8);

    // Перемотка глубоко в прошлое. Постепенное подтягивание оценку не опустило
    // бы вовсе — `max` держит прежнее значение, — и собственные кадры клиента
    // остались бы адресованными в стёртое будущее (NTR-10, NTR-7).
    send(1, 3);
    expect(a.client.serverTick).toBe(3);

    a.client.pushInput({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 }, clock.ms);
    const sent = a.client.drain().filter((message) => message.type === 'Input');
    // Наблюдаемая половина: следующий кадр адресован тиком новой ветви и её
    // эпохой — то есть проходит проверку приёма сервера, а не выпадает из окна.
    expect(sent[sent.length - 1]).toMatchObject({ epoch: 1, frames: [{ tick: 3 + 2 }] });
  });

  it('вне смены эпохи оценка держится потолком, а не прыгает на тик снапшота', async () => {
    const { a, send } = await playing();
    send(1, 3);
    expect(a.client.serverTick).toBe(3);

    // Часы клиента ушли вперёд — обычный дрейф, а не перемотка.
    for (let i = 0; i < 50; i++) a.client.advance();
    expect(a.client.serverTick).toBe(53);

    send(1, 10);

    // Снапшот той же эпохи оценку не пересинхронизирует (было бы 10) и не
    // оставляет дрейфовать (было бы 53): потолок — тик снапшота плюс период
    // рассылки и запас задержки ввода.
    expect(a.client.serverTick).toBe(10 + 60 / 30 + 2);
  });
});

describe('наблюдаемость (NTR-11)', () => {
  it('отклик измеряется без единого лишнего сообщения в протоколе', async () => {
    const { a } = await playMatch(24);

    expect(a.client.metrics.inputsSent).toBeGreaterThan(0);
    // `seq` возвращается сам — его кладёт в компонент ввода `InputSystem` ядра.
    expect(a.client.metrics.inputToVisibleMs).toBeDefined();
    expect(a.client.metrics.inputToVisibleMs).toBeGreaterThan(0);
    expect(a.client.metrics.inputToVisibleMaxMs).toBeGreaterThanOrEqual(
      a.client.metrics.inputToVisibleMinMs!,
    );
  });

  it('молчащий игрок не превращает отклик в «время с последнего нажатия»', async () => {
    // Клиент отправил ввод и замолчал: сервер продолжает подставлять
    // predicted-кадры, повторяя последний `seq` (TICK-2). Тот же `seq`,
    // померенный повторно, дал бы растущее без предела число вместо отклика.
    const fixture = harness();
    const scene = duelScene();
    const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, { input: walkRight(2) });
    connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
    await settle();

    for (let i = 0; i < 40; i++) {
      fixture.clock.ms += 1000 / 60;
      a.host.step();
      await settle();
      fixture.host.step();
      await settle();
    }

    expect(a.client.metrics.inputToVisibleMs).toBeDefined();
    // Ввода не было около 38 тиков (>600 мс), а отклик обязан остаться откликом.
    expect(a.client.metrics.inputToVisibleMaxMs).toBeLessThan(400);
  });

  it('оценка серверного тика не убегает вперёд без предела', async () => {
    // Собственный таймер клиента идёт не ровно в темпе сервера. Односторонний
    // подтягивающий `max` копил бы расхождение, пока кадры не выпали бы из окна
    // приёма — то есть ввод исчезал бы целиком (NTR-7).
    const fixture = harness();
    const scene = duelScene();
    const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, { input: walkRight(1000) });
    connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
    await settle();

    for (let i = 0; i < 60; i++) {
      fixture.clock.ms += 1000 / 60;
      // Клиент шагает вдвое чаще сервера — намеренно разъезжающиеся часы.
      a.host.step();
      a.host.step();
      await settle();
      fixture.host.step();
      await settle();
    }

    const drift = a.client.serverTick - fixture.server.tick;
    expect(drift).toBeLessThanOrEqual(4);
    // И ввод при этом продолжает применяться, а не выпадает из окна.
    expect(fixture.server.metrics.slots[0]!.outOfWindow).toBe(0);
    expect(fixture.server.metrics.slots[0]!.applied).toBeGreaterThan(0);
  });

  it('причины расходятся по разным счётчикам, а не сводятся в одну', async () => {
    const { server, a } = await playMatch(24);

    const counters = server.metrics.slots[0]!;
    expect(counters.applied).toBeGreaterThan(0);
    expect(counters.late).toBe(0);
    expect(counters.outOfWindow).toBe(0);
    expect(server.metrics.snapshotsSent).toBeGreaterThan(0);
    expect(server.metrics.bytesSent).toBeGreaterThan(0);
    expect(a.client.metrics.bytesReceived).toBeGreaterThan(0);
  });

  it('буфер интерполяции отстаёт от последнего состояния (NET-3)', async () => {
    const { a, clock } = await playMatch(24);

    const sampled = a.client.sample(clock.ms);
    expect(sampled).toBeDefined();
    expect(a.client.metrics.bufferLagMs).toBeDefined();
    expect(sampled!.alpha).toBeGreaterThanOrEqual(0);
    expect(sampled!.alpha).toBeLessThanOrEqual(1);
  });
});

describe('транспорт', () => {
  it('матч идёт без сокетов и без таймеров', async () => {
    // Тест целиком отработал на внутрипроцессном транспорте и ручных шагах —
    // это и есть то, ради чего сервер не заводит часов (NTR-3, NTR-12).
    const { server } = await playMatch(4);
    expect(server.tick).toBe(4);
  });

  it('оба клиента прошли через один и тот же код', async () => {
    const { a, b }: { a: ConnectedClient; b: ConnectedClient } = await playMatch(4);
    expect(a.client.constructor).toBe(b.client.constructor);
    expect(a.host.constructor).toBe(b.host.constructor);
  });
});
