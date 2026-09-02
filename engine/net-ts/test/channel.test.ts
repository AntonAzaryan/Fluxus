/**
 * Эмулятор канала в виртуальном времени (design D6 изменения
 * `client-tick-rtt-compensation`): предмет проверки — сам эмулятор, а не матч на
 * нём.
 *
 * Проверяется ровно то, ради чего он существует вместо настоящего сокета:
 * прогон профиля ВОСПРОИЗВОДИМ. Джиттер и потери тянутся из сидированного
 * xorshift ядра (RNG-1), поэтому два прогона одного профиля дают побитово одну и
 * ту же последовательность доставок — и ассерты про адаптацию запаса (NTR-7)
 * могут быть точными, а не «в пределах флака».
 */
import { describe, expect, it } from 'vitest';
import { transportBacklog } from '../src/transport/transport.js';
import {
  channelConfig,
  channelMatch,
  VirtualChannel,
  LAN,
  LOSSY,
  TUNNEL_JITTER,
  WALK,
  type ChannelDelivery,
  type ChannelMatch,
  type ChannelProfile,
} from './support/channel.js';

interface Run {
  readonly journal: readonly ChannelDelivery[];
  /** Метки доставленных сообщений в порядке ПРИБЫТИЯ. */
  readonly arrivals: readonly string[];
}

/** Два сообщения на шаг: порядок ВНУТРИ шага тоже обязан повторяться. */
function drive(profile: ChannelProfile): Run {
  const channel = new VirtualChannel(profile);
  const arrivals: string[] = [];
  for (let step = 0; step < 40; step++) {
    channel.step();
    channel.schedule(() => { arrivals.push(`${step}:a`); });
    channel.schedule(() => { arrivals.push(`${step}:b`); });
  }
  // Хвост: то, что ещё в полёте, обязано доехать в том же порядке.
  for (let step = 0; step < 10; step++) channel.step();
  return { journal: [...channel.journal], arrivals };
}

/** Шаг отправки из метки — по нему видно, переставил ли канал сообщения. */
function sentAtOf(label: string): number {
  return Number(label.slice(0, label.indexOf(':')));
}

describe('эмулятор канала (design D6)', () => {
  it('два прогона одного профиля дают побитово одинаковую последовательность доставок', () => {
    const first = drive(LOSSY);
    const second = drive(LOSSY);

    expect(second.journal).toEqual(first.journal);
    expect(second.arrivals).toEqual(first.arrivals);
    // Профиль с потерями обязан их производить, иначе сравнение доказывало бы
    // воспроизводимость канала, которого нет.
    expect(first.journal.some((entry) => entry.deliveredAt < 0)).toBe(true);
    // И переставлять сообщения: джиттер — это канал, который вправе доставить
    // позже отправленное раньше (NTR-2), и воспроизводиться обязана в том числе
    // перестановка.
    const reordered = first.arrivals.some(
      (label, index) => index > 0 && sentAtOf(first.arrivals[index - 1]!) > sentAtOf(label),
    );
    expect(reordered).toBe(true);
  });

  it('матч на профиле с джиттером повторяется каноническим логом', () => {
    const play = (): ChannelMatch => {
      const match = channelMatch({
        config: channelConfig(),
        profiles: [TUNNEL_JITTER, TUNNEL_JITTER],
        input: () => WALK,
      });
      match.run(120);
      return match;
    };

    const first = play();
    const second = play();

    // Канонический лог — то, чем матч доказуемо воспроизводится (NTR-8): равные
    // логи означают, что канал донёс ровно те же кадры на те же тики.
    expect(second.server.canonicalInputs).toEqual(first.server.canonicalInputs);
    expect(second.channels[0]!.journal).toEqual(first.channels[0]!.journal);
    expect(second.clients[1]!.client.metrics.inputLead).toBe(
      first.clients[1]!.client.metrics.inputLead,
    );
  });
});

describe('ручки эмулятора: ширина, порядок, замирание (design D5 change net-snapshot-backpressure)', () => {
  it('узкий канал копит задолженность: байты, ещё не начавшие передачу (NTR-22)', () => {
    // Ширина — сто байт за шаг; сообщение в триста занимает канал на три шага,
    // следующие ждут своей очереди и составляют задолженность.
    const channel = new VirtualChannel({ ...LAN, name: 'narrow', bytesPerStep: 100 });
    const arrivals: number[] = [];
    for (let i = 0; i < 4; i++) channel.schedule(() => { arrivals.push(i); }, 300);

    // Первое передаётся сейчас, три ждут: 900 байт задолженности.
    expect(channel.backlog).toBe(900);
    channel.step();
    channel.step();
    channel.step();
    // Через три шага первое доехало целиком, второе передаётся — ждут два.
    expect(channel.backlog).toBe(600);
    expect(arrivals).toEqual([0]);

    for (let i = 0; i < 12; i++) channel.step();
    expect(channel.backlog).toBe(0);
    expect(arrivals).toEqual([0, 1, 2, 3]);
  });

  it('широкий канал очередь показывает — и она пуста', () => {
    const channel = new VirtualChannel(LAN);
    channel.schedule(() => {}, 10_000);
    expect(channel.backlog).toBe(0);
  });

  it('два прогона узкого профиля повторяются побитово вместе с очередью', () => {
    const profile: ChannelProfile = { ...LOSSY, name: 'lossy-narrow', bytesPerStep: 50 };
    const run = (): { journal: readonly ChannelDelivery[]; backlog: number[] } => {
      const channel = new VirtualChannel(profile);
      const backlog: number[] = [];
      for (let step = 0; step < 30; step++) {
        channel.step();
        channel.schedule(() => {}, 120);
        backlog.push(channel.backlog);
      }
      return { journal: [...channel.journal], backlog };
    };
    expect(run()).toEqual(run());
  });

  it('`ordered`: джиттер меняет задержку, но не порядок — как у потока', () => {
    const profile: ChannelProfile = { ...TUNNEL_JITTER, name: 'ordered-jitter', jitterSteps: 3, ordered: true };
    const run = drive(profile);
    const reordered = run.arrivals.some(
      (label, index) => index > 0 && sentAtOf(run.arrivals[index - 1]!) > sentAtOf(label),
    );
    expect(reordered).toBe(false);
    // А без порядка тот же профиль переставляет — иначе проверка выше пуста.
    const free = drive({ ...profile, name: 'free-jitter', ordered: false });
    expect(free.arrivals.some((label, index) => index > 0 && sentAtOf(free.arrivals[index - 1]!) > sentAtOf(label))).toBe(true);
  });

  it('`stall`: внутри замирания доставки нет, после — залп всего накопленного', () => {
    const channel = new VirtualChannel({ ...LAN, name: 'stalling', stall: { every: 10, steps: 4 } });
    const arrivals: number[] = [];
    // Шаги 1..9: доставка штатная, по одному сообщению на шаг.
    for (let step = 1; step <= 9; step++) {
      channel.schedule(() => { arrivals.push(step); });
      channel.step();
    }
    expect(arrivals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Шаги 10..13 — замирание: отправленное копится.
    for (let step = 10; step <= 13; step++) {
      channel.schedule(() => { arrivals.push(step); });
      channel.step();
    }
    expect(arrivals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Шаг 14: залп — всё накопленное разом, в порядке отправки.
    channel.step();
    expect(arrivals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('матч на эмуляторе отдаёт хосту задолженность направления как наблюдаемую транспорта', () => {
    // Клиентский конец отдаёт очередь СВОЕГО направления — вверх, к серверу;
    // очередь направления вниз читает хост у серверного конца (NTR-22).
    const match = channelMatch({
      config: channelConfig(),
      // Сорок байт за шаг: хендшейк проходит, а кадры ввода (~84 Б на шаг)
      // канал не тянет — очередь растёт.
      profiles: [LAN, { up: { ...LAN, name: 'narrow-up', bytesPerStep: 40 }, down: LAN }],
      input: () => WALK,
    });
    match.run(200);
    // Клиентский конец широкого канала: очередь видна и пуста.
    expect(transportBacklog(match.clients[0]!.transport)).toEqual({ kind: 'measured', bytes: 0 });
    // Узкий канал вверх: кадры ввода не тянет — задолженность ненулевая.
    const narrow = transportBacklog(match.clients[1]!.transport);
    expect(narrow.kind).toBe('measured');
    if (narrow.kind === 'measured') expect(narrow.bytes).toBeGreaterThan(0);
  });
});
