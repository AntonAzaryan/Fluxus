/**
 * Путь ввода на ненадёжном канале (NTR-2, NTR-8): настоящий матч на
 * внутрипроцессном транспорте, у которого канал клиент → сервер теряет,
 * задерживает и дублирует сообщения ввода.
 *
 * Почему это здесь, а не в `net-ts`. Судьба одного кадра — применён, предсказан,
 * опоздал — проверена поштучно в `pacing.test.ts`, где сообщения серверу подаёт
 * тест. Здесь сообщения шлёт настоящий клиент, а предмет проверки — то, что не
 * краснеет ни в одном пакете по отдельности: канонический лог матча, пережившего
 * потери, ОСТАЁТСЯ каноническим — прогон записи ядром даёт побитово серверное
 * состояние (NTR-8). Это и есть договор детерминизма сетевой игры: потеря ввода
 * меняет содержание матча, но не его воспроизводимость.
 *
 * Потеря и переупорядочивание ставятся ОБЁРТКОЙ НАД ТРАНСПОРТОМ (NTR-2) — как в
 * `eventDelivery.test.ts`, только на исходящей стороне клиента: подменяется
 * именно канал, сервер и клиент под ним те же, что играют. Случайности в обёртке
 * нет — вердикт выносится по номеру сообщения своего типа, прогон повторяем.
 *
 * Хендшейк обёртка пропускает всегда: надёжной доставки требует только он
 * (NTR-5), и его потеря была бы проверкой другого требования.
 */
import { describe, expect, it } from 'vitest';
import { runScenario, snapshotToPlain } from '@fluxus/core';
import {
  DEFAULT_SERIALIZER,
  serverCodec,
  type ClientMessage,
  type Codec,
  type MatchConfig,
  type MatchServer,
  type ServerMessage,
  type Transport,
} from '@fluxus/net';
import {
  TICK_RATE,
  connectClient,
  duelConfig,
  fuzzInput,
  harness,
  settle,
  type ClientLink,
  type ConnectedClient,
} from './fixtures.js';

// -------------------------------------------------------- обёртка транспорта

/** Вердикт канала об исходящем сообщении — те же четыре судьбы, что у входящих (NTR-2). */
type Verdict = 'pass' | 'drop' | 'hold' | 'twice';

/** Вердикт по сообщению и его порядковому номеру СРЕДИ СООБЩЕНИЙ СВОЕГО ТИПА. */
type Policy = (message: ClientMessage, nth: number) => Verdict;

const PASS: Policy = () => 'pass';

function inputVerdict(nths: readonly number[], verdict: Verdict): Policy {
  return (message, nth) => (message.type === 'Input' && nths.includes(nth) ? verdict : 'pass');
}

/**
 * Канал-обёртка исходящей стороны клиента. Разбор — только для вердикта и для
 * записи: до сервера доезжают те же байты, что отправлены.
 */
class InputTap implements Transport {
  /** Сообщения, дошедшие до сервера, в порядке доставки. */
  readonly wire: ClientMessage[] = [];
  /** Всё, что клиент отправил, включая уроненное и задержанное. */
  readonly seen: ClientMessage[] = [];

  private readonly inner: Transport;
  private readonly policy: Policy;
  private readonly codec: Codec<ServerMessage, ClientMessage> = serverCodec(DEFAULT_SERIALIZER);
  private readonly held: Uint8Array[] = [];
  private readonly counts = new Map<string, number>();

  constructor(inner: Transport, policy: Policy) {
    this.inner = inner;
    this.policy = policy;
  }

  get isClosed(): boolean {
    return this.inner.isClosed;
  }

  send(bytes: Uint8Array): void {
    const message = this.codec.decode(bytes);
    const nth = this.counts.get(message.type) ?? 0;
    this.counts.set(message.type, nth + 1);
    this.seen.push(message);
    switch (this.policy(message, nth)) {
      case 'drop':
        return;
      case 'hold':
        this.held.push(bytes);
        return;
      case 'twice':
        this.deliver(bytes);
        this.deliver(bytes);
        return;
      default:
        this.deliver(bytes);
    }
  }

  close(reason?: string): void {
    this.inner.close(reason);
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.inner.onMessage(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.inner.onClose(handler);
  }

  /** Отпустить задержанное: сообщение приезжает ПОСЛЕ более поздних — переупорядочивание. */
  release(): void {
    for (const bytes of this.held.splice(0, this.held.length)) this.deliver(bytes);
  }

  private deliver(bytes: Uint8Array): void {
    if (this.inner.isClosed) return;
    this.wire.push(this.codec.decode(bytes));
    this.inner.send(bytes);
  }
}

class InputTapLink implements ClientLink {
  readonly taps: InputTap[] = [];
  private readonly hub: ClientLink;
  private readonly policy: Policy;

  constructor(hub: ClientLink, policy: Policy) {
    this.hub = hub;
    this.policy = policy;
  }

  connect(): Transport {
    const tap = new InputTap(this.hub.connect(), this.policy);
    this.taps.push(tap);
    return tap;
  }
}

// -------------------------------------------------------------------- матч

interface Party extends ConnectedClient {
  readonly tap: InputTap;
}

interface Match {
  readonly server: MatchServer;
  readonly a: Party;
  readonly b: Party;
  tick(count?: number): Promise<void>;
  release(party: Party): Promise<void>;
}

const TICKS = 48;
const SEED = 424242;

async function playing(policies: { a?: Policy; b?: Policy } = {}): Promise<Match> {
  const config: MatchConfig = duelConfig({ seed: SEED });
  const fixture = harness(config);
  const aLink = new InputTapLink(fixture.hub, policies.a ?? PASS);
  const bLink = new InputTapLink(fixture.hub, policies.b ?? PASS);
  // Зависимости сборки клиентского мира — по наличию, как их передаёт
  // `playMatch`: `connectClient` объявляет их серверу-эквивалентной сборке
  // только тогда, когда ключ есть (NTR-14).
  const build = {
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  };
  const inputA = fuzzInput(SEED, 'chaos-p1', TICKS + 64);
  const inputB = fuzzInput(SEED, 'chaos-p2', TICKS + 64);
  const a = connectClient(aLink, 'p1', fixture.clock, config.scene, inputA, build);
  const b = connectClient(bLink, 'p2', fixture.clock, config.scene, inputB, build);
  await settle();

  return {
    server: fixture.server,
    a: { ...a, tap: aLink.taps[0]! },
    b: { ...b, tap: bLink.taps[0]! },
    async tick(count = 1) {
      for (let i = 0; i < count; i++) {
        fixture.clock.ms += 1000 / TICK_RATE;
        a.host.step();
        b.host.step();
        await settle();
        fixture.host.step();
        await settle();
      }
    },
    async release(party: Party) {
      party.tap.release();
      await settle();
    },
  };
}

/**
 * Оракул всей суиты (NTR-8): что бы канал ни сделал с вводом, записанный матч
 * прогоняется ядром в побитово то же состояние. Ассертов о содержании матча
 * рядом с ним не нужно — расхождение состояния ловится сверкой.
 */
function expectReplayParity(server: MatchServer): void {
  const replay = runScenario(server.toScenario());
  expect(replay.worldInitHash).toBe(server.worldInitHash);
  expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
}

const inputsOf = (messages: readonly ClientMessage[]): readonly ClientMessage[] =>
  messages.filter((message) => message.type === 'Input');

// -------------------------------------------------------------------- тесты

describe('путь ввода на ненадёжном канале (NTR-2, NTR-8)', () => {
  it('потерянные кадры заменяются повтором, а запись матча реплеится побитово', async () => {
    const clean = await playing();
    await clean.tick(TICKS);
    const match = await playing({ a: inputVerdict([6, 7, 8, 9, 10], 'drop') });
    await match.tick(TICKS);

    // Контроль: уроненное действительно везло кадры, и сервер их не получил —
    // предсказанных тиков у слота стало больше, чем в том же матче без потерь.
    expect(inputsOf(match.a.tap.seen).length - inputsOf(match.a.tap.wire).length).toBe(5);
    expect(match.server.metrics.slots[0]!.predicted).toBeGreaterThan(
      clean.server.metrics.slots[0]!.predicted,
    );

    // Матч жив: снапшоты доезжают до обоих клиентов до конца.
    expect(match.a.client.latest!.tick).toBe(match.server.tick);
    expect(match.b.client.latest!.tick).toBe(match.server.tick);

    // Сам договор: содержание матча изменилось, воспроизводимость — нет.
    expectReplayParity(match.server);
  });

  it('дубль сообщения ввода не меняет канонический лог (NTR-2)', async () => {
    const clean = await playing();
    await clean.tick(TICKS);
    const match = await playing({ a: inputVerdict([4, 9, 14], 'twice') });
    await match.tick(TICKS);

    // Контроль: канал действительно доставил три сообщения дважды.
    expect(inputsOf(match.a.tap.wire).length).toBe(inputsOf(match.a.tap.seen).length + 3);

    // Дубль невидим: кадр применяется на своём тике один раз, и канонический
    // лог совпадает с логом того же матча на исправном канале побитово.
    expect(match.server.canonicalInputs).toEqual(clean.server.canonicalInputs);
    expect(snapshotToPlain(match.server.snapshot())).toEqual(
      snapshotToPlain(clean.server.snapshot()),
    );
    expectReplayParity(match.server);
  });

  it('переставленный кадр приходит на исполненный тик и мир назад не переигрывается (NET-1)', async () => {
    const match = await playing({ a: inputVerdict([6], 'hold') });
    await match.tick(12);
    const before = snapshotToPlain(match.server.snapshot());

    // Задержанное отпускается спустя дюжину тиков: кадр безнадёжно опоздал.
    await match.release(match.a);
    expect(match.server.metrics.slots[0]!.late).toBe(1);

    // Опоздание засчитано, но состояние сервера им не тронуто (NET-1), и
    // предсказанный на его месте кадр уже в каноническом логе (TICK-2).
    expect(snapshotToPlain(match.server.snapshot())).toEqual(before);
    expect(match.server.metrics.slots[0]!.predicted).toBeGreaterThan(0);

    await match.tick(TICKS - 12);
    expectReplayParity(match.server);
  });
});
