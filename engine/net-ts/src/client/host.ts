/**
 * Связка клиента с транспортом — зеркало серверного хоста: сокет, таймер и
 * часы живут здесь, а `MatchClient` остаётся чистым циклом (NTR-10).
 */
import type { Serializer } from '@fluxus/core';
import { clientCodec, DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import { ProtocolError, type ClientMessage, type ServerMessage } from '../protocol/messages.js';
import type { Transport } from '../transport/transport.js';
import type { DeliveredEvents, InputSample, MatchClient, MatchSample } from './matchClient.js';

/** Источник ввода: сценарий из файла, клавиатура или тест. `undefined` — на этом тике ввода нет. */
export type InputSource = (tick: number) => InputSample | undefined;

/**
 * Наблюдаемый выход шага клиента: состояние на этот момент и факты, доехавшие к
 * нему (NTR-15).
 *
 * Двумя полями, а не одним сэмплом с событиями внутри: сэмпл — состояние на
 * момент времени, и его нет вовсе, пока буфер интерполяции не набрался, а факт
 * однократен и ждать буфера не может. Связать их значило бы терять факты ровно
 * там, где картинка ещё не поехала, — и очередь клиента копилась бы без
 * потребителя.
 */
export interface ClientStep {
  /** Состояние с признаком разрыва (SHELL-7); `undefined` — буфер ещё не набрался. */
  readonly state: MatchSample | undefined;
  /** Факты, слитые с прошлого шага, по возрастанию пары `(эпоха, тик)`. Каждый — ровно один раз. */
  readonly events: readonly DeliveredEvents[];
}

export interface ClientHostOptions {
  readonly serializer?: Serializer;
  readonly input?: InputSource;
  readonly now?: () => number;
}

export class ClientHost {
  readonly client: MatchClient;

  private readonly transport: Transport;
  private readonly codec: Codec<ClientMessage, ServerMessage>;
  private readonly input: InputSource | undefined;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private timerRate: number | undefined;

  constructor(client: MatchClient, transport: Transport, options: ClientHostOptions = {}) {
    this.client = client;
    this.transport = transport;
    this.codec = clientCodec(options.serializer ?? DEFAULT_SERIALIZER);
    this.input = options.input;
    this.now = options.now ?? (() => performance.now());

    transport.onMessage((bytes) => {
      this.client.metrics.bytesReceived += bytes.byteLength;
      try {
        this.client.receive(this.codec.decode(bytes), this.now());
      } catch (error) {
        const detail = error instanceof ProtocolError ? error.message : String(error);
        // Исход НАЗЫВАЕТСЯ своим именем (NTR-4): сломанный кадр — это
        // `protocol-error`, а не выдуманное «матч окончен, сервер остановлен».
        // Разница несущая (см. `ClientCloseReason`): после конца матча сборке
        // возвращаться некуда, а сбой протокола — это сломанный канал, и
        // подменённый исход предлагал бы игроку не то действие.
        this.client.onProtocolError(detail);
        this.transport.close(detail);
      }
      this.flush();
    });

    transport.onClose(() => {
      this.client.onTransportClosed();
      this.stop();
    });
  }

  flush(): void {
    if (this.transport.isClosed) return;
    for (const message of this.client.drain()) this.transport.send(this.codec.encode(message));
  }

  /** Предъявление версии и уход в ожидание `Welcome` (NTR-5). */
  start(): void {
    this.client.start();
    this.flush();
  }

  /**
   * Шаг локального времени клиента: оценка серверного тика и сэмпл ввода.
   * Отдельно от `run()`, чтобы тест двигал клиента сам, без таймеров.
   *
   * Возвращает состояние на этот момент вместе с признаком разрыва — то, что
   * рисует рендер (SHELL-7), — и факты, доехавшие к этому шагу (NTR-15).
   */
  step(): ClientStep {
    const now = this.now();
    this.client.advance();
    if (this.input !== undefined && this.client.phase === 'playing') {
      const sample = this.input(this.client.serverTick);
      if (sample !== undefined) this.client.pushInput(sample, now);
    }
    // Сэмпл буфера интерполяции — то, что на каждом кадре делает рендер. Здесь
    // он нужен и без рендера: иначе отставание буфера (NTR-11) никто не считает,
    // и headless-прогон не отвечает на треть вопроса про отклик.
    //
    // Сэмпл несёт признак разрыва (SHELL-7) и гасит его — значит, состояние в
    // связке с этим хостом берут отсюда: рендер, поднятый поверх, читает
    // возвращённый сэмпл, а не зовёт `sample()` вторым потребителем.
    const state = this.client.sample(now);
    // Очередь фактов сливается КАЖДЫЙ шаг и независимо от того, отдал ли буфер
    // сэмпл: единица потока — факт, а не кадр (NTR-15). Слив здесь и делает
    // хост тем потребителем, ради которого очередь заведена, — без него она
    // копилась бы до конца матча, а «доставлено» означало бы «доехало до
    // клиента», а не «отдано наверх».
    const events = this.client.takeEvents();
    this.flush();
    return { state, events };
  }

  /** Запускает собственный темп. Частота берётся из `Welcome`, до него — 60 Гц по умолчанию. */
  run(): void {
    this.ensureTimer(this.client.pacing?.tickRate ?? 60);
  }

  private ensureTimer(rate: number): void {
    if (this.timer !== undefined && this.timerRate === rate) return;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timerRate = rate;
    this.timer = setInterval(() => {
      // Темп матча приезжает в `Welcome`; до него клиент идёт умолчанием и
      // перестраивается, как только узнал настоящий.
      const actual = this.client.pacing?.tickRate;
      if (actual !== undefined && actual !== this.timerRate) this.ensureTimer(actual);
      this.step();
    }, 1000 / rate);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.timerRate = undefined;
  }
}
