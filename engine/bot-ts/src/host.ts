/**
 * Хостинг бота (BOT-1, BOT-4): бот входит в матч обычным участником — свой
 * `MatchClient` (`netcode-transport` NTR-10), свой слот ростера (`net-session`
 * SES-4), тот же поток сообщений. Ни сервер, ни клиент, ни протокол о боте не
 * знают: специальных сообщений и ветвлений «для бота» здесь нет по построению —
 * всё, что делает этот файл, это соединяет два существующих шва (SES-2).
 *
 * Швы ровно два, и мозг садится на них 1:1 (design D2):
 *
 * - `ClientStep` (выход шага клиента, NTR-15) → `BotBrain.observe`;
 * - `InputSource` (источник ввода клиента, `input-devices` INP-1) →
 *   `BotBrain.sample`.
 *
 * Своего цикла у хостинга нет — есть каденс шага клиента, и мозг к нему
 * пристёгнут. Стоимость мышления на этот каденс не влияет: `sample` синхронен и
 * отдаёт последнее готовое намерение либо ничего (BOT-2), а исполняется весь
 * хост вне потока авторитетного цикла матча (BOT-4) — свойство сборки, не кода.
 *
 * Рантайм-агностичность здесь принципиальна (design D3): хост принимает
 * `Transport`, а не порт и не сокет, поэтому один и тот же код работает во
 * внутрипроцессном транспорте автотеста, в паре портов воркера и в WebSocket
 * (NTR-2). Место исполнения выбирает сборка — `src/worker/`.
 */
import type { PhysicsOptions, Serializer, VisibilityOptions } from '@game-mvp/core';
import {
  ClientHost,
  MatchClient,
  type ClientStep,
  type ContentPack,
  type GameVersion,
  type InputSample,
  type Transport,
} from '@game-mvp/net';
import type { BotBrain, BotBrainFactory } from './brain.js';
import type { BotProfile } from './profile.js';

export interface BotSeatOptions {
  readonly playerId: string;
  /** Канал до сервера матча: по транспорту на бота — соединение как у человека (NTR-2). */
  readonly transport: Transport;
  /** Фабрика мозга (BOT-2): хост не знает, какая реализация под контрактом. */
  readonly brain: BotBrainFactory;
  /** Профиль поведения (BOT-6); читает его мозг на конструировании. */
  readonly profile: BotProfile;
  /** Контент-пак клиента: сцену клиент резолвит сам (`netcode` NET-16). */
  readonly content: ContentPack;
  readonly version: GameVersion;
  /** Зависимости сборки мира (NTR-14) — те же, что у клиента человека. */
  readonly physics?: PhysicsOptions;
  readonly visibility?: VisibilityOptions;
  readonly interpolationDelayMs?: number;
  readonly serializer?: Serializer;
  readonly now?: () => number;
}

/**
 * Один бот: клиент матча, его хост и мозг за контрактом.
 *
 * Мозг конструируется не в конструкторе, а на первом шаге, где известен слот:
 * своя сущность опознаётся в персональном снапшоте полем `Player.slot`
 * (`tick-loop` TICK-5), а слот приезжает в `Welcome` (NTR-5). Ждать его —
 * честнее, чем выдумывать: до `Welcome` наблюдать ещё нечего, состояния клиент
 * не отдаёт вовсе.
 */
export class BotSeat {
  readonly playerId: string;
  readonly client: MatchClient;
  readonly host: ClientHost;

  private readonly factory: BotBrainFactory;
  private readonly profile: BotProfile;
  private current: BotBrain | undefined;

  constructor(options: BotSeatOptions) {
    this.playerId = options.playerId;
    this.factory = options.brain;
    this.profile = options.profile;
    this.client = new MatchClient({
      playerId: options.playerId,
      version: options.version,
      content: options.content,
      ...(options.physics !== undefined ? { physics: options.physics } : {}),
      ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
      ...(options.interpolationDelayMs !== undefined
        ? { interpolationDelayMs: options.interpolationDelayMs }
        : {}),
    });
    this.host = new ClientHost(this.client, options.transport, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
      // Шов ввода (INP-1): мозг — третий источник рядом со сценарием и
      // клавиатурой, и клиент не отличает его от них.
      input: (tick) => this.sampleInput(tick),
    });
  }

  /** Мозг, если он уже сконструирован. Наблюдательный доступ — для сборки и тестов. */
  get brain(): BotBrain | undefined {
    return this.current;
  }

  start(): void {
    this.host.start();
  }

  /**
   * Шаг клиента с наблюдением (BOT-3): состояние и факты, доехавшие к этому
   * моменту, уходят мозгу — и ничего, кроме них.
   *
   * Своим шагом, а не `ClientHost.run()`, именно поэтому: собственный таймер
   * клиента зовёт `step()` внутри себя и наблюдаемый выход никому не отдаёт, то
   * есть шов наблюдения на нём не собирается. Каденс от этого не меняется —
   * его задаёт `BotHost.run()` тем же темпом матча.
   */
  step(): ClientStep {
    const step = this.host.step();
    this.ensureBrain()?.observe(step);
    return step;
  }

  dispose(): void {
    this.host.stop();
    this.current?.dispose?.();
    this.current = undefined;
  }

  /**
   * Съём ввода на тик (BOT-2): синхронный и без ожидания. Мозг, не успевший
   * решить, отдаёт `undefined` — каденс отправки клиента не сбивается, а
   * опоздавшее намерение уедет вводом на более поздний тик, как запоздавший
   * ввод человека (NTR-6).
   */
  private sampleInput(tick: number): InputSample | undefined {
    return this.ensureBrain()?.sample(tick);
  }

  private ensureBrain(): BotBrain | undefined {
    if (this.current !== undefined) return this.current;
    const slot = this.client.slot;
    if (slot === undefined) return undefined;
    // Мозгу передаётся профиль и то, кто он в матче, — и ничего больше (BOT-3):
    // ссылки на мир сервера в этих аргументах нет и появиться ей неоткуда.
    this.current = this.factory(this.profile, { playerId: this.playerId, slot });
    return this.current;
  }
}

/**
 * Хост ботов: один процесс (воркер) — сколько угодно ботов (BOT-4). Граница
 * честности проходит по клиенту и его фильтру (BOT-3), а не по воркеру, поэтому
 * десять ботов в одном хосте и десять хостов по боту для сервера неразличимы.
 */
export class BotHost {
  private readonly seatList: BotSeat[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private timerRate: number | undefined;

  get seats(): readonly BotSeat[] {
    return this.seatList;
  }

  add(options: BotSeatOptions): BotSeat {
    const seat = new BotSeat(options);
    this.seatList.push(seat);
    return seat;
  }

  /** Предъявление версии всеми ботами (NTR-5). */
  start(): void {
    for (const seat of this.seatList) seat.start();
  }

  /** Один шаг всех ботов. Отдельно от `run()`, чтобы тест двигал матч сам (NTR-12). */
  step(): void {
    for (const seat of this.seatList) seat.step();
  }

  /** Собственный темп: частота из `Welcome` первого бота, до него — 60 Гц. */
  run(): void {
    this.ensureTimer(this.seatList[0]?.client.pacing?.tickRate ?? 60);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.timerRate = undefined;
  }

  dispose(): void {
    this.stop();
    for (const seat of this.seatList) seat.dispose();
    this.seatList.length = 0;
  }

  private ensureTimer(rate: number): void {
    if (this.timer !== undefined && this.timerRate === rate) return;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timerRate = rate;
    this.timer = setInterval(() => {
      const actual = this.seatList[0]?.client.pacing?.tickRate;
      if (actual !== undefined && actual !== this.timerRate) this.ensureTimer(actual);
      this.step();
    }, 1000 / rate);
  }
}
