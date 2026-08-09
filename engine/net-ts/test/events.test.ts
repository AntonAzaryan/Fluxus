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
import type { SceneDef } from '@game-mvp/core';
import {
  duelConfig,
  duelScene,
  fogScene,
  harness,
  hello,
  inputMessage,
  inputMessageOf,
  wireInput,
} from './fixtures.js';
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
 * Та же сцена с туманом. `flipTo` — маска видимости, которую герой слота 1
 * получает начиная с тика 2: ею и разводятся «ушёл в туман» и «вышел из тумана»
 * между публикацией события и рассылкой. Маска переставляется системой, а не
 * считается `VisibilitySystem`: предмет проверки — момент отбора, а не расчёт
 * видимости.
 */
function fogCastScene(flipTo?: number): SceneDef {
  const fog = fogScene();
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
    // Событий — нет: расписание у потока то же, что у снапшотов по NTR-7
    // (NTR-15, «Расписание»), тик восстановления исполнен в прежней эпохе и свои
    // факты в ней уже отдал, а живых тиков новой эпохи ещё нет.
    expect(eventsOf(outgoing).size).toBe(0);
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
    // переисполненного тика 1.
    expect(messages[0]!).toMatchObject({ epoch: 1, from: 4 });
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

  it('сливать нечего — уходит один End', () => {
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
    expect(Object.keys(snapshot.snapshot).sort()).toEqual(['events', 'mode', 'rng', 'tick', 'world']);
    // Шина своего тика в кадре осталась (SNAP-1) и осталась именно шиной тика,
    // а не накопленным диапазоном.
    expect(snapshot.snapshot.events.map((event) => event.type)).toEqual(['Cast']);
  });

  it('шина в кадре — та же отобранная проекция, что и поток (NET-18, NET-13)', () => {
    // Каст невидимого врага НА тике рассылки: шина кадра и пачка потока отобраны
    // одним вызовом фильтра на одном тике, и разойтись им негде.
    const server = running(fogConfig(2));
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
