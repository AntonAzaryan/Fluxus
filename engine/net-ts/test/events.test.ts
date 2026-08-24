/**
 * Поток событий на участке server → client, серверная половина (NTR-15).
 *
 * Проверяется не то, как ядро отбирает события по видимости — это зона
 * FoW-тестов ядра и `filter.test.ts`, — а то, что сетевой слой зовёт отбор НА
 * КАЖДОМ исполненном тике, накапливает уже отобранное по `viewpoint`, объявляет
 * диапазон полностью и не даёт ему пересечь границу эпохи.
 *
 * Всё идёт по `MatchServer` напрямую, без транспорта и без таймеров (NTR-3,
 * NTR-12): предмет проверки — расписание и бухгалтерия диапазонов, а не
 * доставка. Курсор получателя и счётчики разрывов — другая фаза изменения.
 */
import { describe, expect, it } from 'vitest';
import type { SceneDef } from '@fluxus/core';
import {
  authoredMaskScene,
  duelConfig,
  duelScene,
  harness,
  hello,
  inputMessage,
  inputMessageOf,
  wireInput,
} from './fixtures.js';
import { contentPack } from '../src/content/pack.js';
import { MatchClient } from '../src/client/matchClient.js';
import type { EventsMessage, SnapshotMessage } from '../src/protocol/messages.js';
import type { MatchConfig, MatchServer, Outgoing } from '../src/server/matchServer.js';

// --------------------------------------------------------------------- сцены

/**
 * Сцена дуэли плюс система, публикующая событие по фронту кнопки, — тот же
 * приём, что в golden-сценарии `input-drive` ядра. Событие ссылается на
 * кастующего полем `entity`: политика видимости по умолчанию (NET-13) отбирает
 * событие ровно по видимости упомянутой сущности, и без ссылки отбирать было бы
 * нечего.
 */
function castScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'Cast',
        order: 20,
        query: { all: ['Input', 'Player'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                and: [
                  { bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'buttons'] }, 0] },
                  { '!': [{ bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'prevButtons'] }, 0] }] },
                ],
              },
              then: [
                {
                  emitEvent: {
                    type: 'Cast',
                    data: {
                      entity: { var: 'e' },
                      slot: { getComponent: [{ var: 'e' }, 'Player', 'slot'] },
                    },
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

/**
 * Та же сцена с компонентами FoW. `flipTo` — маска видимости, которую герой слота
 * 1 получает начиная с тика 2: ею и разводятся «ушёл в туман» и «вышел из тумана»
 * между публикацией события и рассылкой.
 *
 * Маску переставляет система сцены, а не считает `VisibilitySystem`: предмет
 * проверки — момент отбора, а не расчёт видимости. Поэтому и сцена берётся с
 * компонентами, объявленными руками (`authoredMaskScene`), а не с флагом `fog`:
 * флаг обязывал бы матч объявить пересчёт (NTR-14), и нативная система
 * переписала бы авторскую маску битом собственной команды героя (FOW-3) — то
 * есть отняла бы у теста его предмет.
 */
function fogCastScene(flipTo?: number): SceneDef {
  const fog = authoredMaskScene();
  const cast = castScene();
  return {
    ...fog,
    systems: [
      ...(cast.systems ?? []),
      ...(flipTo === undefined
        ? []
        : [
            {
              name: 'Flip',
              order: 30,
              query: { all: ['Player', 'Visibility'] },
              as: 'e',
              do: [
                {
                  if: {
                    cond: {
                      and: [
                        { '==': [{ getComponent: [{ var: 'e' }, 'Player', 'slot'] }, 1] },
                        { '>=': [{ tick: [] }, 2] },
                      ],
                    },
                    then: [
                      {
                        modifyComponent: {
                          entity: { var: 'e' },
                          component: 'Visibility',
                          values: { visibleTo: flipTo },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ]),
    ],
  };
}

/** Герой слота 0 виден команде 0; маска героя слота 1 — предмет теста. */
function fogConfig(enemyMask: number, flipTo?: number, overrides: Partial<MatchConfig> = {}) {
  return duelConfig({
    scene: fogCastScene(flipTo),
    eventRepeat: 0,
    initial: [
      { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
      {
        prefab: 'Hero',
        overrides: { Player: { slot: 1 }, Visibility: { visibleTo: enemyMask }, Team: { id: 1 } },
      },
    ],
    ...overrides,
  });
}

// ------------------------------------------------------------------ хелперы

function running(config: MatchConfig, observer = false): MatchServer {
  const { server } = harness(config);
  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  if (observer) {
    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));
  }
  server.drain();
  return server;
}

/** Сообщения потока по соединениям, в порядке отправки. */
function eventsOf(outgoing: readonly Outgoing[]): Map<number, EventsMessage[]> {
  const byConnection = new Map<number, EventsMessage[]>();
  for (const entry of outgoing) {
    if (entry.message.type !== 'Events') continue;
    const list = byConnection.get(entry.to) ?? [];
    list.push(entry.message);
    byConnection.set(entry.to, list);
  }
  return byConnection;
}

function drainEvents(server: MatchServer): Map<number, EventsMessage[]> {
  return eventsOf(server.drain());
}

/** Плоский список «тик → типы событий» одного сообщения: короче в ожиданиях. */
function ticksOf(message: EventsMessage): number[] {
  return message.batches.map((batch) => batch.tick);
}

function advance(server: MatchServer, ticks: number): void {
  for (let i = 0; i < ticks; i++) server.advance();
}

// -------------------------------------------------------------------- тесты

describe('накопление и объявленный диапазон (NTR-15)', () => {
  it('событие тика без рассылки доезжает ближайшей рассылкой с номером своего тика', () => {
    const config = duelConfig({ scene: castScene(), eventRepeat: 0 });
    const server = running(config);
    // tickRate 60 / snapshotRate 30 — рассылка на каждом втором тике, то есть
    // тик 1 рассылкой не сопровождается вовсе.
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));

    server.advance();
    expect(drainEvents(server).size).toBe(0);

    server.advance();
    const message = drainEvents(server).get(1)![0]!;
    expect(message).toMatchObject({ type: 'Events', epoch: 0, from: 1, to: 2 });
    expect(ticksOf(message)).toEqual([1]);
    expect(message.batches[0]!.events.map((event) => event.type)).toEqual(['Cast']);
  });

  it('рассылка без событий всё равно уходит и объявляет диапазон', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    advance(server, 2);

    const message = drainEvents(server).get(1)![0]!;
    // Пустое сообщение — единственное, что отличает тишину от потери.
    expect(message).toMatchObject({ from: 1, to: 2, batches: [] });
  });

  it('диапазоны смежны: следующий начинается там, где кончился предыдущий', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    advance(server, 4);

    const messages = drainEvents(server).get(1)!;
    expect(messages.map((message) => [message.from, message.to])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe('избыточность вместо подтверждений (NTR-15)', () => {
  it('сообщение повторяет предыдущие рассылки, диапазон расширяется на глубину повтора', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 2 }));
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 8);

    const messages = drainEvents(server).get(1)!;
    expect(messages.map((message) => [message.from, message.to])).toEqual([
      [1, 2],
      [1, 4],
      [1, 6],
      // Глубина накопления — «период рассылки × (глубина повтора + 1)» тиков,
      // то есть 2 × 3 = 6: окно [1, 2] вытеснено из кольца.
      [3, 8],
    ]);
    // Пачка тика 1 едет трижды и переживает две потери подряд.
    expect(messages.map(ticksOf)).toEqual([[1], [1], [1], []]);
  });

  it('повтор едет тем же объектом пачки: отбор случился один раз — на публикации', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 2 }));
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 6);

    const messages = drainEvents(server).get(1)!;
    expect(messages.map(ticksOf)).toEqual([[1], [1], [1]]);
    // Тот же объект, а не равный: пачка отобрана вызовом фильтра на СВОЁМ тике
    // и на рассылке не пересобирается. Пересборка означала бы отбор по
    // состоянию мира на момент рассылки — то есть ровно ту ошибку, против
    // которой написан «Момент фильтрации» (NTR-15).
    const first = messages[0]!.batches[0]!;
    expect(messages[1]!.batches[0]!).toBe(first);
    expect(messages[2]!.batches[0]!).toBe(first);
  });

  it('глубина 0 — без повтора', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 4);

    const messages = drainEvents(server).get(1)!;
    expect(messages.map(ticksOf)).toEqual([[1], []]);
  });
});

describe('отбор на тике публикации (NET-13, NTR-15)', () => {
  it('враг ушёл в туман между публикацией и рассылкой — событие доехало', () => {
    // Герой слота 1 виден обеим командам на тике 1 и прячется с тика 2.
    const config = fogConfig(3, 2);
    const server = running(config);
    server.receive(2, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 2);

    const outgoing = server.drain();
    const message = eventsOf(outgoing).get(1)![0]!;
    expect(ticksOf(message)).toEqual([1]);

    // Контроль: к моменту рассылки враг из персонального снапшота уже вырезан —
    // отбор по состоянию на момент рассылки потерял бы легальный факт.
    const snapshot = outgoing.find(
      (entry) => entry.to === 1 && entry.message.type === 'Snapshot',
    )!.message as SnapshotMessage;
    expect(snapshot.snapshot.world.aliveCount).toBe(1);
  });

  it('враг вышел из тумана между публикацией и рассылкой — событие не доехало', () => {
    // Зеркало предыдущего: на тике 1 враг невидим, с тика 2 виден.
    const config = fogConfig(2, 3);
    const server = running(config);
    server.receive(2, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 4);

    const messages = drainEvents(server);
    // Ни в одной рассылке: накоплено уже отобранное, и поток не становится
    // вторым каналом утечки FoW.
    expect(messages.get(1)!.flatMap(ticksOf)).toEqual([]);
    // Событие при этом было — своему каст доехал.
    expect(messages.get(2)!.flatMap(ticksOf)).toEqual([1]);
  });

  it('наблюдатель получает поток без фильтрации тем же путём (NTR-9)', () => {
    const config = fogConfig(2, undefined, { allowObserver: true });
    const server = running(config, true);
    server.receive(2, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 2);

    const messages = drainEvents(server);
    expect(messages.get(1)!.flatMap(ticksOf)).toEqual([]);
    expect(messages.get(3)!.flatMap(ticksOf)).toEqual([1]);
    // Диапазон у наблюдателя тот же: отдельной ветки и отдельного расписания у
    // него нет.
    expect(messages.get(3)![0]!).toMatchObject({ from: 1, to: 2 });
  });
});

describe('накопитель по viewpoint, а не по соединению (NTR-15)', () => {
  it('два соединения одной команды делят одну пачку', () => {
    const config = duelConfig({ scene: castScene(), teams: [0, 0], eventRepeat: 0 });
    const server = running(config);
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 2);

    const messages = drainEvents(server);
    // Тот же объект, а не равный: пачка считается один раз на `viewpoint`.
    expect(messages.get(1)![0]!).toBe(messages.get(2)![0]!);
    expect(ticksOf(messages.get(1)![0]!)).toEqual([1]);
  });

  it('разные viewpoint — разные сообщения', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    advance(server, 2);

    const messages = drainEvents(server);
    expect(messages.get(1)![0]!).not.toBe(messages.get(2)![0]!);
  });

  it('вернувшийся наблюдатель открывает диапазон заново, а не объявляет несобранное покрытым', () => {
    const config = duelConfig({ scene: castScene(), eventRepeat: 2, allowObserver: true });
    const server = running(config, true);
    advance(server, 2);
    expect(drainEvents(server).get(3)![0]!).toMatchObject({ from: 1, to: 2 });

    // Наблюдатель ушёл: тики 3..4 его `viewpoint` никто не собирает.
    server.disconnect(3);
    server.receive(1, inputMessage(wireInput(3, 1, 0, 0, 1)));
    advance(server, 2);
    // Контроль: каст на тике 3 БЫЛ — игроку он доехал, и молчание ниже не от
    // того, что событие не случилось.
    expect(drainEvents(server).get(1)!.flatMap(ticksOf)).toEqual([3]);

    server.connect(4);
    server.receive(4, hello('watcher', config.version, true));
    server.drain();
    advance(server, 2);

    const message = drainEvents(server).get(4)![0]!;
    // Диапазон открыт первым СОБРАННЫМ после возвращения тиком. Объяви он 1..6
    // (кольцо прежнего соединения так и предлагает), тики 3..4 значились бы
    // покрытыми, и каст тика 3 читался бы как «событий не было» — потеря,
    // выданная за тишину (NTR-15, «Объявленный диапазон»).
    expect(message).toMatchObject({ epoch: 0, from: 5, to: 6 });
    expect(ticksOf(message)).toEqual([]);
  });
});

describe('эпоха диапазона (NTR-16)', () => {
  function rewindable(interval: number) {
    return duelConfig({
      scene: castScene(),
      eventRepeat: 2,
      rewind: { interval, capacity: 32 },
    });
  }

  it('рассылка по факту восстановления потока событий не несёт', () => {
    const server = running(rewindable(1));
    advance(server, 6);
    server.drain();

    server.pause();
    server.beginRewind();
    server.seekTo(3);

    const outgoing = server.drain();
    // Снапшот уходит — состояние восстановлено и наблюдаемо (NTR-16, REW-11).
    expect(outgoing.filter((entry) => entry.message.type === 'Snapshot')).toHaveLength(2);
    // Новых событий рассылка восстановления не открывает: расписание у потока
    // то же, что у снапшотов по NTR-7 (NTR-15, «Расписание»), живых тиков новой
    // эпохи ещё нет. Уходит только последний, максимально избыточный повтор
    // ПРЕЖНЕЙ эпохи, срезанный по точке восстановления («Избыточность»).
    const streams = eventsOf(outgoing);
    expect(streams.size).toBe(2);
    for (const messages of streams.values()) {
      expect(messages).toHaveLength(1);
      expect(messages[0]!).toMatchObject({ epoch: 0, to: 3 });
      expect(ticksOf(messages[0]!)).toEqual([]);
    }
    expect(server.epoch).toBe(1);
  });

  it('после смены эпохи диапазон открывается первым живым тиком новой ветви', () => {
    const server = running(rewindable(1));
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    // Отпускание кнопки: иначе фронта на повторе последнего кадра больше не
    // будет, и каст после перемотки не случится.
    server.receive(1, inputMessage(wireInput(2, 2, 0, 0, 0)));
    advance(server, 6);
    server.drain();

    server.pause();
    server.beginRewind();
    server.seekTo(3);
    server.pause();
    server.resume();
    server.drain();

    // Клиент новой эпохи шлёт ввод, помеченный ею же.
    server.receive(1, inputMessageOf(1, wireInput(4, 3, 0, 0, 1)));
    server.advance();

    const message = drainEvents(server).get(1)![0]!;
    // Кольцо сброшено: окна стёртой эпохи не повторяются, и диапазон не
    // пересекает границу эпохи — он открыт первым ЖИВЫМ тиком новой ветви.
    expect(message).toMatchObject({ epoch: 1, from: 4, to: 4 });
    expect(ticksOf(message)).toEqual([4]);
  });

  /**
   * `snapshotRate` 15 при `tickRate` 60 — рассылка на каждом четвёртом тике:
   * между рассылкой тика 4 и живым тиком 7 лежит открытое окно из трёх тиков, и
   * точка восстановления делит его надвое. Ровно это деление и есть предмет
   * проверок ниже.
   */
  function windowedRewindable(): MatchConfig {
    return duelConfig({
      scene: castScene(),
      snapshotRate: 15,
      eventRepeat: 2,
      rewind: { interval: 1, capacity: 32 },
    });
  }

  /** Каст p1 на тиках 5 и 7 — по разные стороны точки восстановления 6. */
  function castsAtFiveAndSeven(server: MatchServer): void {
    server.receive(
      1,
      inputMessage(wireInput(5, 1, 0, 0, 1), wireInput(6, 2, 0, 0, 0), wireInput(7, 3, 0, 0, 1)),
    );
  }

  it('префикс исполненных тиков уходит сообщением прежней эпохи, стёртый хвост — нет', () => {
    const server = running(windowedRewindable());
    castsAtFiveAndSeven(server);
    advance(server, 7);
    // Рассылка была на тике 4; тики 5..7 остались в открытом окне.
    expect(drainEvents(server).get(1)!.map((message) => [message.from, message.to])).toEqual([[1, 4]]);

    server.pause();
    server.beginRewind();
    server.seekTo(6);

    const outgoing = server.drain().filter((entry) => entry.to === 1);
    expect(outgoing.map((entry) => entry.message.type)).toEqual(['Events', 'Snapshot']);
    const prefix = outgoing[0]!.message as EventsMessage;
    // Тики 5 и 6 исполнены живьём и перемоткой НЕ стёрты: их эффекты лежат в
    // восстановленном мире, и «события каждого исполненного тика SHALL
    // доставляться» (NTR-15) относится к ним. Уходит это прежней эпохой и до
    // того, как эпоха выросла; сообщение — последнее в эпохе, поэтому несёт и
    // кольцо повторов («Избыточность»): диапазон начинается его первым окном.
    expect(prefix).toMatchObject({ epoch: 0, from: 1, to: 6 });
    expect(ticksOf(prefix)).toEqual([5]);
    // Пачка тика 7 принадлежит стёртой ветви и уходит вместе с кольцом
    // (решение 8 дизайна) — в объявленный диапазон она не попадает вовсе.
    expect(server.epoch).toBe(1);
    expect(outgoing[1]!.message).toMatchObject({ type: 'Snapshot', epoch: 1, tick: 6 });
  });

  it('окно целиком за точкой восстановления — уходит только повтор кольца', () => {
    const server = running(windowedRewindable());
    castsAtFiveAndSeven(server);
    advance(server, 7);
    server.drain();

    server.pause();
    server.beginRewind();
    server.seekTo(4);

    // Открытое окно начиналось тиком 5 — всё оно стёрто, и «диапазон» из него
    // получился бы вывернутым: 5..4. Пачки тиков 5 и 7 не едут; уходит лишь
    // последний повтор кольца прежней эпохи, срезанный по точке восстановления.
    const messages = drainEvents(server).get(1)!;
    expect(messages).toHaveLength(1);
    expect(messages[0]!).toMatchObject({ epoch: 0, from: 1, to: 4 });
    expect(ticksOf(messages[0]!)).toEqual([]);
    expect(server.epoch).toBe(1);
  });

  it('клиент применяет факты префикса ровно один раз, и рост эпохи следом разрывом не считается', () => {
    const config = windowedRewindable();
    const { server } = harness(config);
    const pack = contentPack({ duel: config.scene });
    const client = new MatchClient({ playerId: 'p1', version: config.version, content: pack });
    const clock = { ms: 0 };
    const relay = (): void => {
      for (const outgoing of server.drain()) {
        if (outgoing.to !== 1) continue;
        clock.ms += 1;
        client.receive(outgoing.message, clock.ms);
      }
    };

    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    relay();
    castsAtFiveAndSeven(server);
    advance(server, 7);
    relay();
    // Рассылка тика 4 объявила пустой диапазон 1..4: каст тика 5 в неё не попал.
    expect(client.takeEvents()).toEqual([]);

    server.pause();
    server.beginRewind();
    server.seekTo(6);
    relay();

    const delivered = client.takeEvents();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ epoch: 0, tick: 5 });
    // Ровно один раз: очередь пустеет чтением, и второго проигрывания нет.
    expect(client.takeEvents()).toEqual([]);
    expect(client.metrics.eventBatchesDelivered).toBe(1);

    server.pause();
    server.resume();
    advance(server, 2);
    relay();

    // Первое сообщение новой эпохи начинается с тика 7 — «позже» между эпохами
    // не определено, и разрывом это не считается (NTR-16, решение 8).
    expect(client.epoch).toBe(1);
    expect(client.metrics.eventRangeGaps).toBe(0);
    expect(client.metrics.eventBatchesDelivered).toBe(1);
  });

  it('тики внутреннего реплея в поток не попадают (REW-4, OBS-5)', () => {
    // Интервал 4: `seekTo(3)` восстанавливает снапшот тика 0 и ДОИГРЫВАЕТ тики
    // 1..3 реплеем. Тик 1 при этом публикует свой каст повторно — и в поток он
    // попасть не должен ни одной пачкой.
    const server = running(rewindable(4));
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    server.receive(1, inputMessage(wireInput(2, 2, 0, 0, 0)));
    advance(server, 6);
    // Контроль: каст тика 1 в живой эпохе доехал — значит реплей тика 1 внутри
    // `seekTo` публикует его повторно, и молчание ниже не от того, что события
    // не было вовсе.
    expect(drainEvents(server).get(1)!.flatMap(ticksOf)).toEqual([1, 1, 1]);

    server.pause();
    server.beginRewind();
    server.seekTo(3);
    server.pause();
    server.resume();
    advance(server, 2);

    const messages = drainEvents(server).get(1)!;
    expect(messages.flatMap(ticksOf)).toEqual([]);
    // Первый диапазон новой эпохи начинается за точкой возобновления, а не с
    // переисполненного тика 1; перед ним — только повтор кольца прежней эпохи.
    const fresh = messages.find((message) => message.epoch === 1)!;
    expect(fresh).toMatchObject({ epoch: 1, from: 4 });
    expect(messages.filter((message) => message.epoch === 0).flatMap(ticksOf)).toEqual([]);
  });
});

describe('завершение матча (NTR-15)', () => {
  it('накопленное уходит раньше End в том же drain', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    advance(server, 2);
    server.drain();

    server.receive(1, inputMessage(wireInput(3, 1, 0, 0, 1)));
    server.advance();
    server.stop();

    const outgoing = server.drain().filter((entry) => entry.to === 1);
    expect(outgoing.map((entry) => entry.message.type)).toEqual(['Events', 'End']);
    const tail = outgoing[0]!.message as EventsMessage;
    // Хвост покрывает нерассланные тики и не перекрывает предыдущий диапазон.
    expect(tail).toMatchObject({ epoch: 0, from: 3, to: 3 });
    expect(ticksOf(tail)).toEqual([3]);
    // Соединение закрывается после потока, а не до него.
    expect(outgoing.map((entry) => entry.closeAfter)).toEqual([false, true]);
  });

  it('пустой хвост объявляется: тики после последней рассылки покрыты и перед End', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    advance(server, 2);
    server.drain();

    // Тик 3 исполнен, событий на нём нет — и это ровно тот случай, ради
    // которого объявленный диапазон существует.
    advance(server, 1);
    server.stop();

    const outgoing = server.drain().filter((entry) => entry.to === 1);
    expect(outgoing.map((entry) => entry.message.type)).toEqual(['Events', 'End']);
    // Без этого сообщения получатель не отличил бы «на тике 3 событий не было»
    // от «последнее сообщение матча потерялось».
    expect(outgoing[0]!.message).toMatchObject({ from: 3, to: 3, batches: [] });
  });

  it('слив повторяет кольцо: последнее сообщение матча — самое избыточное', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 2 }));
    server.receive(1, inputMessage(wireInput(3, 1, 0, 0, 1)));
    advance(server, 4);
    // Рассылка тика 4 везла каст тика 3 — и это единственное сообщение по
    // расписанию, которое его везло. Считаем его потерянным каналом (NTR-2):
    // ниже проверяется, чинит ли потерю слив.
    const scheduled = drainEvents(server).get(1)!;
    expect(scheduled[scheduled.length - 1]!).toMatchObject({ from: 1, to: 4 });
    expect(ticksOf(scheduled[scheduled.length - 1]!)).toEqual([3]);

    advance(server, 1);
    server.stop();

    const outgoing = server.drain().filter((entry) => entry.to === 1);
    expect(outgoing.map((entry) => entry.message.type)).toEqual(['Events', 'End']);
    const tail = outgoing[0]!.message as EventsMessage;
    // Кольцо повторено: у последнего сообщения нет СЛЕДУЮЩЕГО, и «каждое
    // сообщение повторяет несколько предыдущих рассылок» (NTR-15) держится
    // только здесь. Факт тика 3 доезжает, хотя везшее его сообщение потеряно.
    expect(tail).toMatchObject({ epoch: 0, from: 1, to: 5 });
    expect(ticksOf(tail)).toEqual([3]);
  });

  it('хвоста нет, а кольцо есть — сообщение всё равно уходит повтором', () => {
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 2 }));
    server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
    advance(server, 2);
    server.drain();
    server.stop();

    const outgoing = server.drain().filter((entry) => entry.to === 1);
    expect(outgoing.map((entry) => entry.message.type)).toEqual(['Events', 'End']);
    const tail = outgoing[0]!.message as EventsMessage;
    // Диапазон тот же, что объявляла последняя рассылка: доехала она — повтор
    // отбросит курсор получателя, не доехала — факт спасён. Молчать здесь
    // значило бы сделать последнее сообщение матча самым скупым.
    expect(tail).toMatchObject({ from: 1, to: 2 });
    expect(ticksOf(tail)).toEqual([1]);
  });

  it('нечего слить вовсе — уходит один End', () => {
    // Глубина повтора 0: кольцо пусто по построению, и после рассылки тика 2 не
    // осталось ни хвоста, ни повторов — объявлять нечего.
    const server = running(duelConfig({ scene: castScene(), eventRepeat: 0 }));
    advance(server, 2);
    server.drain();
    server.stop();

    const outgoing = server.drain().filter((entry) => entry.to === 1);
    expect(outgoing.map((entry) => entry.message.type)).toEqual(['End']);
  });
});

describe('швы: снапшот и канонический лог', () => {
  it('Snapshot не изменился ни полем, ни смыслом (NTR-15, решение 1)', () => {
    const server = running(duelConfig({ scene: castScene() }));
    server.receive(1, inputMessage(wireInput(2, 1, 0, 0, 1)));
    advance(server, 2);

    const snapshot = server
      .drain()
      .find((entry) => entry.message.type === 'Snapshot')!.message as SnapshotMessage;
    // Поля-расширения под поток событий в снапшоте не завелось: у состояния и у
    // фактов разные правила отбрасывания, и одно сообщение вынуждало бы одно
    // правило на двоих (NTR-4).
    expect(Object.keys(snapshot).sort()).toEqual(['epoch', 'snapshot', 'tick', 'type']);
    // Состав кадра — перечисленные NET-18 части, без состояний стримов RNG.
    expect(Object.keys(snapshot.snapshot).sort()).toEqual(['events', 'mode', 'tick', 'world']);
    // Шина своего тика в кадре осталась (SNAP-1) и осталась именно шиной тика,
    // а не накопленным диапазоном.
    expect(snapshot.snapshot.events.map((event) => event.type)).toEqual(['Cast']);
  });

  it('шина в кадре — та же отобранная проекция, что и поток (NET-18, NET-13)', () => {
    // Каст невидимого врага НА тике рассылки: шина кадра и пачка потока отобраны
    // одним вызовом фильтра на одном тике, и разойтись им негде.
    const server = running(fogConfig(2, undefined, { allowObserver: true }), true);
    server.receive(2, inputMessage(wireInput(2, 1, 0, 0, 1)));
    advance(server, 2);

    const outgoing = server.drain();
    const events = eventsOf(outgoing);
    const frameOf = (to: number) =>
      outgoing.find((entry) => entry.to === to && entry.message.type === 'Snapshot')!
        .message as SnapshotMessage;

    expect(events.get(1)!.flatMap(ticksOf)).toEqual([]);
    expect(frameOf(1).snapshot.events).toEqual([]);

    expect(events.get(2)!.flatMap(ticksOf)).toEqual([2]);
    expect(frameOf(2).snapshot.events.map((event) => event.type)).toEqual(['Cast']);

    // Наблюдателю (`viewpoint = ALL`) фильтр снимается ЦЕЛИКОМ, а не по каналам
    // (NTR-9): и шина кадра, и пачка потока у него неотобраны. Разойдись каналы
    // здесь — у одного из них появился бы собственный отбор, которого NET-13 не
    // допускает ни у кого, включая наблюдателя.
    expect(events.get(3)!.flatMap(ticksOf)).toEqual([2]);
    expect(frameOf(3).snapshot.events.map((event) => event.type)).toEqual(['Cast']);
  });

  /**
   * NET-13 «Действующий предикат» и NTR-9: предикат назван конфигом матча, и
   * закрытие открытого геймплейного вопроса — смена ЭТОГО поля, а не правка ядра
   * или сетевого слоя. Проверяется не сам предикат, а то, что названный конфигом
   * действует и что действует он на ОБА канала одним вызовом: разойдись они,
   * клиент увидел бы в состоянии факт, которого нет в потоке.
   *
   * Предикат взят нарочно не про видимость — «уходит только каст слота 0», — чтобы
   * его действие нельзя было спутать с действием нормированного: тот на сцене без
   * тумана пропускает оба каста.
   */
  it('предикат, названный конфигом матча, действует на кадр и на поток (NET-13, NTR-9)', () => {
    const casts = (config: MatchConfig): { frame: number[]; stream: number[] } => {
      const server = running(config);
      // Каст обоих слотов на тике 1, и тик 1 же — тик рассылки (`snapshotRate`
      // равен `tickRate`): шина кадра и пачка потока говорят об одном тике.
      server.receive(1, inputMessage(wireInput(1, 1, 0, 0, 1)));
      server.receive(2, inputMessage(wireInput(1, 1, 0, 0, 1)));
      server.advance();

      const outgoing = server.drain();
      const frame = outgoing.find(
        (entry) => entry.to === 1 && entry.message.type === 'Snapshot',
      )!.message as SnapshotMessage;
      const stream = eventsOf(outgoing).get(1)!;
      return {
        frame: frame.snapshot.events.map((event) => event.data.slot!),
        stream: stream.flatMap((message) =>
          message.batches.flatMap((batch) => batch.events.map((event) => event.data.slot!)),
        ),
      };
    };

    const base = { scene: castScene(), snapshotRate: 60, eventRepeat: 0 } as const;
    const chosen = casts(
      duelConfig({ ...base, eventVisibility: (event) => event.data.slot === 0 }),
    );
    expect(chosen.frame).toEqual([0]);
    expect(chosen.stream).toEqual([0]);

    // Отсутствие поля даёт нормированный NET-13 предикат, а не «ничего»: на сцене
    // без тумана видимы оба каста, и оба доезжают обоими каналами. Без этой
    // половины проверка не отличила бы действующий предикат конфига от того, что
    // поле просто игнорируется.
    const normed = casts(duelConfig(base));
    expect(normed.frame).toEqual([0, 1]);
    expect(normed.stream).toEqual([0, 1]);
  });

  it('канонический inputs[] от потока событий не зависит (NTR-8)', () => {
    const inputs = [wireInput(1, 1, 0, 0, 1), wireInput(2, 2, 0, 0, 0), wireInput(3, 3)];
    const logOf = (scene: SceneDef) => {
      const server = running(duelConfig({ scene }));
      for (const frame of inputs) server.receive(1, inputMessage(frame));
      advance(server, 4);
      return server.canonicalInputs;
    };

    // Сцена с событиями и сцена без них дают один и тот же канонический лог:
    // поток событий — выход тика, а не его вход (OBS-1), и в запись не входит.
    expect(logOf(castScene())).toEqual(logOf(duelScene()));
  });
});
