/**
 * Обратное давление рассылки состояний (NTR-22): хост не отправляет очередной
 * персональный снапшот соединению, задолженность отправки которого переросла
 * порог, и считает такие пропуски отдельно по соединению (NTR-11).
 *
 * Две половины, и проверяют они разное. Первая — пороговая арифметика на
 * ПОДСТАВНОМ транспорте, задолженностью которого управляет сам тест: канала тут
 * нет вовсе, доставка синхронна, и утверждения точны до байта. Вторая — матч на
 * эмуляторе канала в виртуальном времени (design D6): у одного из двух клиентов
 * downlink уже потока состояний, у второго LAN, — и предмет проверки в том, что
 * политика чинит первого, не задевая ни второго, ни канонический лог (OBS-2).
 *
 * Ширина узкого канала выражена через ЗАМЕРЕННЫЙ размер персонального снапшота
 * фикстурной сцены, а не через угаданное число байт: иначе профиль пришлось бы
 * подбирать заново после любой правки сцены, а тест молча перестал бы проверять
 * узкий канал.
 */
import { describe, expect, it } from 'vitest';
import { clientCodec } from '../src/protocol/codec.js';
import type { ServerMessage } from '../src/protocol/messages.js';
import { MatchHost } from '../src/server/host.js';
import { MatchServer, type MatchConfig } from '../src/server/matchServer.js';
import {
  BaseTransport,
  BACKLOG_UNSUPPORTED,
  type Transport,
  type TransportBacklog,
  type TransportServer,
} from '../src/transport/transport.js';
import { duelConfig, hello } from './fixtures.js';
import {
  channelConfig,
  channelMatch,
  LAN,
  WALK,
  type ChannelMatch,
  type ChannelProfile,
} from './support/channel.js';

const codec = clientCodec();

// ------------------------------------------- подставной транспорт и его сервер

/**
 * Транспорт, у которого задолженность назначает тест: пороговая арифметика
 * обязана проверяться ОТДЕЛЬНО от канала — иначе утверждение «на границе
 * пропускается» держалось бы на модели ширины, а не на самом хосте.
 */
class FakeTransport extends BaseTransport {
  /** Всё, что хост передал в отправку, в порядке передачи. */
  readonly sent: Uint8Array[] = [];
  /** Задолженность в байтах; `undefined` — канал очереди не показывает вовсе. */
  queued: number | undefined = 0;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  override backlog(): TransportBacklog {
    return this.queued === undefined ? BACKLOG_UNSUPPORTED : { kind: 'measured', bytes: this.queued };
  }

  /** Кадр от клиента. Доставка синхронна: часов у подставного канала нет. */
  receive(bytes: Uint8Array): void {
    this.deliver(bytes);
  }

  protected doClose(): void {
    // Закрывать нечего: сокета за подставным транспортом не стоит.
  }
}

class FakeTransportServer implements TransportServer {
  private handler: ((transport: Transport) => void) | undefined;

  onConnection(handler: (transport: Transport) => void): void {
    this.handler = handler;
  }

  connect(): FakeTransport {
    const transport = new FakeTransport();
    this.handler?.(transport);
    return transport;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface Rig {
  readonly server: MatchServer;
  readonly host: MatchHost;
  readonly links: readonly FakeTransport[];
}

/**
 * Матч на подставных транспортах: оба игрока входят сразу, рассылка идёт каждый
 * тик (`snapshotRate` равен `tickRate`) — так один шаг расписания даёт ровно
 * одну рассылку, и считать пропуски можно шагами.
 *
 * `queued` — задолженность обоих каналов ДО хендшейка: очередь, переполненная с
 * самого начала, есть отдельный случай, а не «то же самое, только позже».
 */
function rig(maxQueuedSnapshots?: number, queued = 0): Rig {
  const config: MatchConfig = duelConfig({
    tickRate: 20,
    snapshotRate: 20,
    silenceTicks: 100_000,
  });
  const transports = new FakeTransportServer();
  const server = new MatchServer(config);
  const host = new MatchHost(server, transports, {
    now: () => 0,
    ...(maxQueuedSnapshots === undefined ? {} : { maxQueuedSnapshots }),
  });
  const links = config.players.map(() => transports.connect());
  for (const link of links) link.queued = queued;
  for (const [index, link] of links.entries()) {
    link.receive(codec.encode(hello(config.players[index]!, config.version)));
  }
  return { server, host, links };
}

function kinds(link: FakeTransport): string[] {
  return link.sent.map((bytes) => codec.decode(bytes).type);
}

function messagesOf(link: FakeTransport): ServerMessage[] {
  return link.sent.map((bytes) => codec.decode(bytes));
}

/** Размер последнего ушедшего соединению снапшота — то, чем хост меряет очередь. */
function lastSnapshotBytes(link: FakeTransport): number {
  for (let i = link.sent.length - 1; i >= 0; i--) {
    const bytes = link.sent[i]!;
    if (codec.decode(bytes).type === 'Snapshot') return bytes.byteLength;
  }
  return 0;
}

function snapshotCount(link: FakeTransport): number {
  return kinds(link).filter((type) => type === 'Snapshot').length;
}

describe('пороговая арифметика хоста (NTR-22)', () => {
  it('первый снапшот уходит при любой очереди, а следующие пропускаются', () => {
    // Очередь заведомо больше любого порога ещё до первой рассылки: мерить её
    // нечем — размера снапшота ИМЕННО ЭТОМУ соединению хост не знает.
    const { host, links } = rig(2, 1_000_000);
    const link = links[0]!;
    host.step();

    expect(snapshotCount(link)).toBe(1);
    expect(host.connectionMetrics(1)?.snapshotsSkipped).toBe(0);

    // Дальше размер известен, и очередь превышает порог: снапшоты не уходят.
    for (let i = 0; i < 10; i++) host.step();
    expect(snapshotCount(link)).toBe(1);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(10);
    // Байты пропущенного не считаются: их никто не отправлял (NTR-11).
    expect(host.connectionMetrics(1)!.snapshotBytes).toBe(lastSnapshotBytes(link));
    expect(host.connectionMetrics(1)!.snapshots).toBe(1);
  });

  it('порог — «столько снапшотов в очереди»: на границе снапшот уже пропускается', () => {
    const { host, links } = rig(2);
    const link = links[0]!;
    host.step();
    const size = lastSnapshotBytes(link);
    expect(size).toBeGreaterThan(0);

    // Байтом ниже порога — снапшот уходит.
    link.queued = 2 * size - 1;
    host.step();
    expect(snapshotCount(link)).toBe(2);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(0);

    // Ровно на пороге — уже нет: «больше порога» считается по «не меньше»,
    // потому что очередь ровно в два снапшота и есть та, которую следующая
    // рассылка только удлинит.
    link.queued = 2 * lastSnapshotBytes(link);
    host.step();
    expect(snapshotCount(link)).toBe(2);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(1);

    // Канал разгрёб очередь — рассылка возвращается сама, без внешнего сигнала.
    link.queued = 0;
    host.step();
    expect(snapshotCount(link)).toBe(3);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(1);
  });

  it('порог у каждого соединения свой: сосед с пустой очередью снапшоты получает', () => {
    const { host, links } = rig(2);
    host.step();
    const narrow = links[0]!;
    const wide = links[1]!;
    narrow.queued = 1_000_000;

    for (let i = 0; i < 8; i++) host.step();

    expect(snapshotCount(narrow)).toBe(1);
    expect(snapshotCount(wide)).toBe(9);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(8);
    expect(host.connectionMetrics(2)!.snapshotsSkipped).toBe(0);
  });

  it('пропускается только снапшот: поток событий, пауза и конец уходят при полной очереди', () => {
    const { server, host, links } = rig(2);
    const link = links[0]!;
    host.step();
    // Хендшейк уже уехал при полной очереди быть не мог — проверяем его отдельно
    // ниже; здесь предмет — сообщения ИДУЩЕГО матча.
    expect(kinds(link)).toContain('Welcome');
    for (const each of links) each.queued = 1_000_000;

    for (let i = 0; i < 6; i++) host.step();
    // Поток событий (NTR-15) избыточен сам и мал: его пропуск дал бы разрывы
    // диапазона ради байтов, которых он не съедает.
    const events = kinds(link).filter((type) => type === 'Events').length;
    expect(events).toBeGreaterThan(0);

    server.pauseMatch();
    host.flush();
    expect(kinds(link)).toContain('Pause');

    server.stop();
    host.flush();
    expect(kinds(link)).toContain('End');
    // И ни одного лишнего снапшота за всё это время.
    expect(snapshotCount(link)).toBe(1);
  });

  it('хендшейк уходит соединению, чья очередь переполнена с самого начала', () => {
    const { server, host, links } = rig(2, 1_000_000);

    // Надёжная доставка хендшейка (NTR-5) очередью не отменяется: без `Welcome`
    // клиент не начинает вовсе.
    expect(kinds(links[0]!)).toContain('Welcome');
    expect(messagesOf(links[0]!).some((message) => message.type === 'Reject')).toBe(false);
    expect(server.phase).toBe('running');
    // И пропусков на хендшейке не случилось: пропускается только `Snapshot`.
    expect(host.connectionMetrics(1)?.snapshotsSkipped).toBe(0);
  });

  it('канал, не показывающий очереди, пропусков не даёт (сценарий «Транспорт без очереди»)', () => {
    const { host, links } = rig(2);
    // Названное отсутствие, а не ноль: пропуск по неизвестной очереди был бы
    // пропуском по догадке.
    for (const each of links) each.queued = undefined;

    for (let i = 0; i < 20; i++) host.step();

    expect(snapshotCount(links[0]!)).toBe(20);
    const metrics = host.connectionMetrics(1)!;
    expect(metrics.snapshotsSkipped).toBe(0);
    expect(metrics.backlog).toEqual({ kind: 'unsupported' });
  });

  it('`Infinity` выключает политику: пропусков нет и при бесконечной очереди', () => {
    const { host, links } = rig(Number.POSITIVE_INFINITY);
    for (const each of links) each.queued = 1_000_000_000;

    for (let i = 0; i < 20; i++) host.step();

    expect(snapshotCount(links[0]!)).toBe(20);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(0);
  });

  it('умолчание порога — два снапшота: сборка без ручки политику уже имеет', () => {
    const { host, links } = rig();
    const link = links[0]!;
    host.step();
    const size = lastSnapshotBytes(link);

    link.queued = 2 * size;
    host.step();

    expect(snapshotCount(link)).toBe(1);
    expect(host.connectionMetrics(1)!.snapshotsSkipped).toBe(1);
  });
});

// ------------------------------------------------------ матч на узком канале

/** Шагов канала на одну рассылку: `tickRate / snapshotRate` конфига тестов. */
const STEPS_PER_BROADCAST = 2;

/**
 * Замер персонального снапшота фикстурной сцены — то, через что выражается
 * ширина узкого канала. Замер, а не число: профиль обязан оставаться узким и
 * после правки сцены.
 */
function measureSnapshotBytes(): number {
  const match = channelMatch({
    config: channelConfig(),
    profiles: [LAN, LAN],
    input: () => WALK,
  });
  match.run(40);
  const connection = match.host.report().connections[0]!;
  return Math.round(connection.snapshotBytes / connection.snapshots);
}

const SNAPSHOT_BYTES = measureSnapshotBytes();

/**
 * Узкий downlink: канал держит семь десятых потока состояний. Не десятую и не
 * сотую — предмет проверки в том, что политика ограничивает отставание на
 * канале, который поток почти тянет, а не в том, что оборванный канал ничего не
 * доставляет.
 */
const NARROW_DOWN: ChannelProfile = {
  ...LAN,
  name: 'narrow-down',
  bytesPerStep: Math.round((SNAPSHOT_BYTES / STEPS_PER_BROADCAST) * 0.7),
};

/** Матч «сосед на LAN плюс второй за узким downlink». */
function narrowMatch(maxQueuedSnapshots: number): ChannelMatch {
  return channelMatch({
    config: channelConfig(),
    profiles: [LAN, { up: LAN, down: NARROW_DOWN }],
    input: () => WALK,
    host: { maxQueuedSnapshots },
  });
}

/** Отставание последнего применённого клиентом состояния от серверного тика. */
function staleness(match: ChannelMatch, index: number): number {
  return match.server.tick - (match.clients[index]!.client.latest?.tick ?? 0);
}

/** Канонический ввод одного слота — то, что запись матча предъявит воспроизведению. */
function framesOf(match: ChannelMatch, playerId: string): string {
  return JSON.stringify(match.server.canonicalInputs.filter((frame) => frame.playerId === playerId));
}

describe('обратное давление на эмуляторе канала (NTR-22, design D6)', () => {
  it('узкий канал показан замером: снапшот не помещается в шаги рассылки', () => {
    // Утверждение о самом стенде: канал, на котором поток состояний ПОМЕЩАЕТСЯ,
    // ничего бы не проверил, и молчаливое превращение узкого профиля в широкий
    // сделало бы оба теста ниже зелёными ни о чём.
    expect(SNAPSHOT_BYTES).toBeGreaterThan(0);
    expect(NARROW_DOWN.bytesPerStep! * STEPS_PER_BROADCAST).toBeLessThan(SNAPSHOT_BYTES);
  });

  it('без политики отставание состояний растёт без предела (сценарий «Узкий канал»)', () => {
    const match = narrowMatch(Number.POSITIVE_INFINITY);
    match.run(400);
    const early = staleness(match, 1);
    match.run(1200);
    const late = staleness(match, 1);

    // Очередь без предела: втрое больше прогона — втрое больше отставания.
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(3 * early);
    expect(match.host.report().connections[1]!.snapshotsSkipped).toBe(0);
  });

  it('с политикой отставание ограничено, пропуски названы, ввод слота применяется', () => {
    const match = narrowMatch(2);
    match.run(400);
    const early = staleness(match, 1);
    const settled = match.server.metrics.slots[1]!.applied;
    match.run(1200);
    const late = staleness(match, 1);

    // Установившийся режим: отставание держится там же, где было через 400
    // шагов, а не растёт вместе с прогоном.
    expect(late).toBeLessThanOrEqual(2 * early);
    expect(late).toBeLessThan(60);

    const [near, far] = match.host.report().connections;
    expect(far!.snapshotsSkipped).toBeGreaterThan(0);
    expect(far!.backlog.kind).toBe('measured');
    // Соседа на широком канале политика не трогает (сценарий «Широкий канал»).
    expect(near!.snapshotsSkipped).toBe(0);

    // Ввод узкого слота продолжает применяться: прореживание лечит канал
    // состояний, а не отбирает у игрока управление (NTR-7).
    const applied = match.server.metrics.slots[1]!.applied - settled;
    expect(applied).toBeGreaterThan(1100);
    // Потолок запаса — окно приёма за вычетом запаса оценки тика (NTR-7); до
    // него запас не доходит: канал узкий, а не длинный.
    const pacing = match.server.pacing;
    const ceiling = pacing.inputWindow - pacing.tickRate / pacing.snapshotRate - pacing.inputDelay;
    const lead = match.clients[1]!.client.metrics.inputLead!;
    expect(lead).toBeLessThan(ceiling);
    // Счётчик сервера считает ОТПРАВЛЕННЫЕ снапшоты (NTR-11): пропущенные в него
    // не входят, и он равен сумме по соединениям — админ, делящий байты на
    // снапшоты (SRV-4), делит на то, что ушло.
    const report = match.host.report();
    const perConnection = report.connections.reduce((sum, connection) => sum + connection.snapshots, 0);
    expect(match.server.metrics.snapshotsSent).toBe(perConnection);
    expect(report.connections.some((connection) => connection.snapshotsSkipped > 0)).toBe(true);
  });

  it('соседа не задевает: его снапшоты и его канонический ввод — те же (OBS-2)', () => {
    const withPolicy = narrowMatch(2);
    const without = narrowMatch(Number.POSITIVE_INFINITY);
    withPolicy.run(600);
    without.run(600);

    // Слот соседа не отличает матч с пропусками от матча без них: решение
    // принято во внешнем слое по наблюдаемой ЕГО канала, а не по состоянию мира.
    expect(framesOf(withPolicy, 'p1')).toBe(framesOf(without, 'p1'));
    const near = withPolicy.host.report().connections[0]!;
    // Полный темп рассылки: по снапшоту на каждый её шаг.
    expect(near.snapshots).toBe(600 / STEPS_PER_BROADCAST);
    expect(near.snapshotsSkipped).toBe(0);
  });

  it('чтение очереди матч не двигает: на широком канале лог совпадает побитово (OBS-2)', () => {
    const play = (maxQueuedSnapshots: number): string => {
      const match = channelMatch({
        config: channelConfig(),
        profiles: [LAN, LAN],
        input: () => WALK,
        host: { maxQueuedSnapshots },
      });
      match.run(400);
      for (const connection of match.host.report().connections) {
        expect(connection.snapshotsSkipped).toBe(0);
      }
      return JSON.stringify(match.server.toScenario());
    };

    // Матч с включённой политикой и матч с выключенной — одна и та же запись,
    // байт в байт: наблюдаемая внешнего слоя в мир не попадает (NTR-11, OBS-2).
    expect(play(2)).toBe(play(Number.POSITIVE_INFINITY));
  });
});
