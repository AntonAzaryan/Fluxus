/**
 * Внутрипроцессное рандеву (`net-session` SES-3): адресов не существует, и
 * инвайт является ключом в реестре процесса.
 *
 * Не заглушка, а полноправная реализация — по той же причине, по которой ею
 * является внутрипроцессный транспорт (NTR-2, NTR-12): автотест обязан гонять ту
 * же сборку сессии, что играет по сети. Отсюда и асинхронность: под ним лежит
 * `LoopbackHub`, доставляющий через планировщик, а не синхронно из `send`.
 */
import { LoopbackHub, type LoopbackOptions } from '../../transport/loopback.js';
import type { Transport } from '../../transport/transport.js';
import { decodeInvite, encodeInvite } from '../invite.js';
import { randomToken } from './token.js';
import { RendezvousError, type PublishedSession, type Rendezvous, type SessionChannel } from '../rendezvous.js';

const VIA = 'in-process';

export interface InProcessRendezvousOptions extends LoopbackOptions {
  /** Подменяемый источник токенов: тесту нужен предсказуемый инвайт, а не случайный. */
  readonly token?: () => string;
}

/**
 * Реестр — свойство объекта рандеву, а не модуля. Глобальный реестр связал бы
 * два независимых матча в одном процессе, а именно так их и гоняет тест.
 */
export class InProcessRendezvous implements Rendezvous {
  readonly name = VIA;

  private readonly options: InProcessRendezvousOptions;
  private readonly published = new Map<string, LoopbackHub>();

  constructor(options: InProcessRendezvousOptions = {}) {
    this.options = options;
  }

  publish(channel: SessionChannel): Promise<PublishedSession> {
    const token = (this.options.token ?? randomToken)();
    const { token: _token, ...loopback } = this.options;
    const hub = new LoopbackHub(loopback);
    this.published.set(token, hub);
    const invite = encodeInvite({ via: VIA, channel, token });
    const published: PublishedSession = {
      transports: hub,
      invite,
      close: async () => {
        this.published.delete(token);
        await hub.close();
      },
    };
    return Promise.resolve(published);
  }

  /**
   * Ждать здесь нечего, но отказ обязан приезжать отказом промиса, как у сетевой
   * реализации: иначе вызывающий ловит его двумя способами. Отсюда обёртка —
   * исполнитель `Promise` превращает синхронный бросок в отказ.
   */
  resolve(invite: string): Promise<Transport> {
    return new Promise((resolve) => { resolve(this.open(invite)); });
  }

  private open(invite: string): Transport {
    const payload = decodeInvite(invite);
    if (payload.via !== VIA) {
      throw new RendezvousError(`инвайт выдан другим рандеву: ${payload.via}`);
    }
    const hub = this.published.get(payload.token);
    if (hub === undefined) {
      // Названный отказ, а не тихое ожидание: инвайт после закрытия сессии и
      // инвайт из чужого процесса неотличимы для предъявителя, но оба — конец
      // пути, а не пауза (SES-5).
      throw new RendezvousError('инвайт не действует: сессия закрыта или его не выдавали');
    }
    return hub.connect();
  }
}
