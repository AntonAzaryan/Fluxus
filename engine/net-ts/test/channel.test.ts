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
import {
  channelConfig,
  channelMatch,
  VirtualChannel,
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
