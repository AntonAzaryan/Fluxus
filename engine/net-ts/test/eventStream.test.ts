/**
 * Приём потока событий клиентом (NTR-15): курсор пары `(эпоха, тик)`,
 * однократность, порядок, разрыв диапазона и счётчики (NTR-11, NTR-16).
 *
 * Клиент здесь настоящий — тот же, что играет матч (NTR-12), — и хендшейк с
 * состояниями он проходит от настоящего сервера. Сообщения потока событий при
 * этом подаёт тест: предмет проверки — правило ПОЛУЧАТЕЛЯ, и согласие двух
 * сторон (то есть сервер, который шлёт `Events`) не должно быть условием того,
 * что правило проверено. Согласие сторон проверяется отдельно — на границе, а
 * не на моке (решение 7 дизайна).
 */
import { describe, expect, it } from 'vitest';
import { BUILD_ID, duelConfig, harness, hello } from './fixtures.js';
import { contentPack } from '../src/content/pack.js';
import { ClientHost } from '../src/client/host.js';
import { MatchClient } from '../src/client/matchClient.js';
import { toWireSnapshot } from '../src/protocol/messages.js';
import type { EventBatch, ServerMessage } from '../src/protocol/messages.js';
import type { Transport } from '../src/transport/transport.js';

/**
 * Канал-заглушка: хост требует транспорт, а предмет проверок ниже — его шаг, а
 * не доставка. Настоящий канал под теми же вызовами — в `match.test.ts`.
 */
class SinkTransport implements Transport {
  readonly sent: Uint8Array[] = [];
  isClosed = false;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(): void {
    this.isClosed = true;
  }

  onMessage(): void {
    // Входящих у заглушки нет: сообщения подаёт тест прямо в клиент.
  }

  onClose(): void {
    // Закрытия тоже: матч в этих проверках не кончается.
  }
}

/** Пачка одного тика: типы событий в порядке публикации (EVT-2). */
function batch(tick: number, ...types: readonly string[]): EventBatch {
  return { tick, events: types.map((type) => ({ type, data: {} })) };
}

function events(epoch: number, from: number, to: number, ...batches: EventBatch[]): ServerMessage {
  return { type: 'Events', epoch, from, to, batches };
}

/**
 * Клиент, прошедший хендшейк настоящего сервера и доигравший `ticks` тиков, но
 * НЕ получивший ни одного серверного `Events`.
 *
 * Поток сервера здесь именно удерживается, а не выключается конфигом: канал
 * теряет сообщения по построению (NTR-2), и «`Events` до клиента не доехали» —
 * штатное состояние получателя, а не искусственная сборка. Курсор потока
 * остаётся девственным, и все сообщения потока в этих тестах подаёт тест — то
 * есть проверяется правило получателя, а не согласие двух сторон (это фаза
 * сервера и интеграционные тесты).
 */
function playing(ticks = 4) {
  const config = duelConfig();
  const { server } = harness(config);
  const pack = contentPack({ duel: config.scene });
  const client = new MatchClient({
    playerId: 'p1',
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
  });
  const clock = { ms: 0 };

  const relay = (): void => {
    for (const outgoing of server.drain()) {
      if (outgoing.to !== 1 || outgoing.message.type === 'Events') continue;
      client.receive(outgoing.message, clock.ms);
    }
  };

  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  relay();
  for (let i = 0; i < ticks; i++) {
    clock.ms += 1000 / 60;
    server.advance();
    relay();
  }

  const feed = (message: ServerMessage): void => { client.receive(message, clock.ms); };
  /** Снапшот сервера под нужной парой: состояние настоящее, номер — из теста. */
  const snapshot = (epoch: number, tick: number): void => {
    const plain = toWireSnapshot(server.snapshot());
    feed({ type: 'Snapshot', epoch, tick, snapshot: { ...plain, tick } });
  };
  return { server, client, clock, feed, snapshot };
}

describe('клиент: поток событий — порядок и однократность (NTR-15, EVT-2)', () => {
  it('пачки применяются по возрастанию тика, внутри тика — в присланном порядке', () => {
    const { client, feed } = playing();

    // Пачки в сообщении переставлены: канал переупорядочивает (NTR-2), и
    // порядок применения обязан браться из номеров тиков, а не из порядка тела.
    feed(events(0, 0, 5, batch(5, 'Cast', 'EntityDied'), batch(3, 'Hit')));

    const delivered = client.takeEvents();
    expect(delivered.map((entry) => entry.tick)).toEqual([3, 5]);
    expect(delivered.map((entry) => entry.epoch)).toEqual([0, 0]);
    // Порядок публикации внутри тика нормирован (EVT-2) и на проводе не теряется.
    expect(delivered[1]!.events.map((event) => event.type)).toEqual(['Cast', 'EntityDied']);
    expect(client.metrics.eventBatchesDelivered).toBe(2);
    expect(client.metrics.eventBatchesDropped).toBe(0);
    expect(client.metrics.eventRangeGaps).toBe(0);
  });

  it('факт достаётся потребителю ровно один раз: очередь пустеет чтением (NTR-12)', () => {
    const { client, feed } = playing();
    feed(events(0, 0, 3, batch(2, 'EntityDied')));

    expect(client.pendingEvents).toHaveLength(1);
    expect(client.takeEvents()).toHaveLength(1);
    // Второе чтение пусто: иначе звук и VFX проиграются столько раз, сколько
    // потребитель заглянул в клиент.
    expect(client.takeEvents()).toEqual([]);
    expect(client.pendingEvents).toEqual([]);
  });

  it('повторно доставленный тик отбрасывается по курсору и считается отдельно (NTR-11)', () => {
    const { client, feed } = playing();
    const repeat = events(0, 0, 3, batch(2, 'EntityDied'));
    feed(repeat);
    expect(client.takeEvents()).toHaveLength(1);

    // Избыточность (NTR-15): каждое сообщение повторяет предыдущие рассылки, и
    // на канале без потерь повтор — штатное положение дел, а не ошибка.
    feed(repeat);

    expect(client.takeEvents()).toEqual([]);
    expect(client.metrics.eventBatchesDelivered).toBe(1);
    expect(client.metrics.eventBatchesDropped).toBe(1);
    expect(client.metrics.eventRangeGaps).toBe(0);
  });

  it('повтор тика внутри одного сообщения применяется один раз', () => {
    const { client, feed } = playing();

    feed(events(0, 0, 3, batch(2, 'EntityDied'), batch(2, 'EntityDied')));

    expect(client.takeEvents()).toHaveLength(1);
    expect(client.metrics.eventBatchesDropped).toBe(1);
  });
});

describe('клиент: курсор потока и разрыв диапазона (NTR-15, NTR-11)', () => {
  it('курсор встаёт на конец объявленного диапазона, а не на последнюю непустую пачку', () => {
    const { client, feed } = playing();

    // Диапазон 0..5 покрыт полностью, событие только на тике 2: тики 3..5 —
    // «событий не было», а не «пачки потерялись».
    feed(events(0, 0, 5, batch(2, 'Cast')));
    expect(client.takeEvents()).toHaveLength(1);

    feed(events(0, 6, 9, batch(7, 'Cast')));

    // Останься курсор на тике 2 — `from` 6 оказался бы позже курсора+1, и
    // каждая тихая рассылка засчитывалась бы разрывом у исправного канала.
    expect(client.metrics.eventRangeGaps).toBe(0);
    expect(client.takeEvents().map((entry) => entry.tick)).toEqual([7]);
  });

  it('сообщение целиком не новее курсора отбрасывается без разрыва', () => {
    const { client, feed } = playing();
    feed(events(0, 0, 5, batch(2, 'Cast')));
    client.takeEvents();

    // Повтор молчаливого хвоста: диапазон кончается там же, где курсор.
    feed(events(0, 3, 5));

    expect(client.takeEvents()).toEqual([]);
    expect(client.metrics.eventRangeGaps).toBe(0);
    expect(client.metrics.eventBatchesDropped).toBe(0);
  });

  it('разрыв диапазона посчитан отдельно, курсор перескакивает, догадок нет', () => {
    const { client, feed } = playing();
    feed(events(0, 0, 3, batch(1, 'Cast')));
    client.takeEvents();

    // Потерь больше глубины повтора: диапазон начался позже, чем кончился
    // последний применённый.
    feed(events(0, 8, 9, batch(8, 'EntityDied')));

    expect(client.metrics.eventRangeGaps).toBe(1);
    // Дыра названа и посчитана, а не восполнена: фактов тиков 4..7 не
    // придумано, запроса на переотправку не послано (NTR-2).
    expect(client.takeEvents().map((entry) => entry.tick)).toEqual([8]);

    // Курсор перескочил на конец разорванного диапазона: следующее сообщение
    // встык разрывом уже не считается.
    feed(events(0, 10, 11, batch(10, 'Cast')));
    expect(client.metrics.eventRangeGaps).toBe(1);
    expect(client.takeEvents().map((entry) => entry.tick)).toEqual([10]);
  });

  it('первое сообщение потока разрывом не считается, где бы ни начинался диапазон', () => {
    const { client, feed } = playing();

    // Применённого диапазона ещё нет, и «позже, чем кончился последний»
    // сравнивать не с чем.
    feed(events(0, 40, 42, batch(41, 'Cast')));

    expect(client.metrics.eventRangeGaps).toBe(0);
    expect(client.takeEvents().map((entry) => entry.tick)).toEqual([41]);
  });
});

describe('клиент: поток событий и эпоха (NTR-16, NTR-15)', () => {
  it('события переисполненного тика доезжают: курсор — пара, а не номер тика', () => {
    const { client, feed } = playing();
    feed(events(0, 0, 5, batch(4, 'Cast')));
    client.takeEvents();

    // Возобновление с тика 2: живые тики снова идут 3, 4, 5 — уже новой ветвью.
    feed(events(1, 3, 5, batch(4, 'EntityDied')));

    // Курсор по одному тику погасил бы ровно этот факт — тот, ради доставки
    // которого поток и заведён (NET-14).
    const delivered = client.takeEvents();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ epoch: 1, tick: 4 });
    expect(delivered[0]!.events.map((event) => event.type)).toEqual(['EntityDied']);
  });

  it('рост эпохи не растит ни счётчик разрывов, ни счётчик отброшенных повторов', () => {
    const { client, feed } = playing();
    feed(events(0, 0, 5, batch(4, 'Cast')));
    client.takeEvents();

    // Диапазон новой эпохи начинается где угодно: номера тиков после перемотки
    // идут заново, и «позже» между эпохами не определено.
    feed(events(1, 3, 5, batch(3, 'Cast')));
    feed(events(2, 100, 101, batch(100, 'Cast')));

    // Перемотка наблюдаема с обеих сторон и дефектом канала не является:
    // считать её разрывом значило бы растить счётчик дефектов на каждой ульте.
    expect(client.metrics.eventRangeGaps).toBe(0);
    expect(client.metrics.eventBatchesDropped).toBe(0);
    expect(client.metrics.eventBatchesDelivered).toBe(3);
  });

  it('пачки стёртой эпохи, доехавшие повтором, отбрасываются по паре и разрывом не считаются', () => {
    const { client, feed } = playing();
    feed(events(0, 0, 5, batch(4, 'Cast')));
    feed(events(1, 3, 5, batch(4, 'EntityDied')));
    client.takeEvents();

    // Сообщение прежней эпохи, застрявшее в канале: по номеру тика оно «свежее»
    // применённого, по паре — старше.
    feed(events(0, 6, 7, batch(6, 'Cast')));

    expect(client.takeEvents()).toEqual([]);
    expect(client.metrics.eventBatchesDropped).toBe(1);
    expect(client.metrics.eventRangeGaps).toBe(0);

    // Курсор остался в новой эпохе: сообщение её ветви применяется как ни в чём
    // не бывало.
    feed(events(1, 6, 7, batch(6, 'Cast')));
    expect(client.takeEvents().map((entry) => entry.tick)).toEqual([6]);
  });
});

describe('шаг хоста: у очереди фактов есть потребитель (NTR-15)', () => {
  /** Клиент без хендшейка: `onEvents` мира не касается и `Welcome` не требует. */
  function hosted() {
    const config = duelConfig();
    const pack = contentPack({ duel: config.scene });
    const client = new MatchClient({
      playerId: 'p1',
      version: { buildId: BUILD_ID, contentPackHash: pack.hash },
      content: pack,
    });
    const host = new ClientHost(client, new SinkTransport(), { now: () => 0 });
    return { client, host };
  }

  it('шаг отдаёт каждый факт ровно один раз', () => {
    const { client, host } = hosted();
    client.receive(events(0, 0, 5, batch(2, 'EntityDied'), batch(4, 'Cast')), 0);

    expect(host.step().events.map((entry) => entry.tick)).toEqual([2, 4]);
    // Второй шаг пуст: очередь пустеет сливом, и звук проигрывается не столько
    // раз, сколько кадров нарисовал рендер.
    expect(host.step().events).toEqual([]);
    expect(client.pendingEvents).toEqual([]);
  });

  it('слив не ждёт готовности буфера интерполяции', () => {
    const { client, host } = hosted();
    client.receive(events(0, 0, 3, batch(1, 'EntityDied')), 0);

    const step = host.step();
    // Состояния нет — снапшотов клиент не видел вовсе. Факты это не
    // задерживает: связать их с готовностью буфера значило бы терять факты ровно
    // там, где картинка ещё не поехала.
    expect(step.state).toBeUndefined();
    expect(step.events.map((entry) => entry.tick)).toEqual([1]);
  });
});

describe('клиент: два курсора независимы (NTR-15, NTR-10)', () => {
  it('отброшенный устаревший снапшот не двигает курсор событий', () => {
    const { client, feed, snapshot } = playing();
    const applied = client.latest!.tick;
    const dropped = client.metrics.snapshotsDropped;

    // Состояние того же тика приезжает устаревшим и гибнет (NTR-10)…
    snapshot(0, applied - 2);
    expect(client.metrics.snapshotsDropped).toBe(dropped + 1);

    // …а факты того же тика применяются: у состояния и у фактов разные курсоры,
    // и один курсор на двоих унёс бы события вместе с отброшенным снапшотом.
    feed(events(0, applied - 2, applied - 2, batch(applied - 2, 'EntityDied')));

    expect(client.takeEvents().map((entry) => entry.tick)).toEqual([applied - 2]);
    expect(client.metrics.eventBatchesDropped).toBe(0);
  });

  it('продвижение курсора событий не считается применением снапшота', () => {
    const { client, feed, snapshot } = playing();
    const applied = client.latest!.tick;
    const appliedCount = client.metrics.snapshotsApplied;

    feed(events(0, 0, applied + 5, batch(applied + 1, 'Cast')));
    client.takeEvents();

    expect(client.metrics.snapshotsApplied).toBe(appliedCount);
    expect(client.latest!.tick).toBe(applied);

    // Снапшот тика, чьи факты уже применены, состояние всё равно несёт: курсор
    // событий его не гасит.
    snapshot(0, applied + 1);
    expect(client.metrics.snapshotsApplied).toBe(appliedCount + 1);
    expect(client.latest!.tick).toBe(applied + 1);
  });

  it('презентационная поверхность шины не отдаёт, хотя в кадре она едет (NTR-15)', () => {
    const { client, clock } = playing();

    // Шина в кадре на проводе остаётся и в буфере лежит как есть: это
    // состояние, восстанавливаемое вместе с миром (SNAP-1). Наружу её не отдают
    // ни `latest`, ни `sample()`: единственный источник фактов — `takeEvents()`,
    // иначе события тиков рассылки проигрались бы дважды. Строки ниже не
    // компилируются, и это часть проверки — запрет держится типом, а не
    // примечанием в документации (NTR-15, «Шина внутри снапшота»).
    // @ts-expect-error шины в презентационной проекции нет
    const busOfLatest: unknown = client.latest!.events;
    const sampled = client.sample(clock.ms)!;
    // @ts-expect-error её нет и в паре сэмпла
    const busOfSample: unknown = sampled.from.events;

    // При этом на проводе она приехала — проверка про поверхность, а не про кадр.
    expect(Array.isArray(busOfLatest)).toBe(true);
    expect(Array.isArray(busOfSample)).toBe(true);
  });

  it('поток событий не порождает исходящих сообщений и не трогает состояние (NTR-11, NTR-2)', () => {
    const { client, feed } = playing();
    client.drain();
    const before = client.latest;

    feed(events(0, 0, 5, batch(2, 'EntityDied')));

    // Подтверждений принятых тиков в протоколе нет и быть не должно (NTR-15):
    // устойчивость даётся избыточностью, а не reliable-подканалом.
    expect(client.drain()).toEqual([]);
    // Счётчики наблюдательны: в мир клиента и в отправляемый ввод они не едут
    // (NTR-11) — состояние после применения потока то же самое.
    expect(client.latest).toBe(before);
  });
});
