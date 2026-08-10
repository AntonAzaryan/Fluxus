/**
 * RemoteHost — main-сторона воркер-сборки рендера (SHELL-1, SHELL-2).
 *
 * Зеркало `RenderHost` по контракту подсистем: тот же `register`, тот же
 * `frame`, тот же `TickView` — подсистемы не знают, что тик приехал каналом,
 * а не прямым вызовом (REND-8). Внутри — `ViewBuffer` из render-ts, кормимый
 * прочитанным конвертом; буфер возвращается воркеру сразу после применения
 * (ping-pong, SHELL-3).
 *
 * Часы — этого потока: `ViewBuffer.apply` ставит `lastTickAtMs` в момент
 * доставки, альфа интерполяции не зависит от timeOrigin воркера (SHELL-7).
 *
 * Обратный канал (SHELL-6): `sendInput` и `control` — единственное влияние
 * главного потока на симуляцию.
 *
 * Реестр подсистем и кадр живут в `PresentationStage` — общей части продюсеров
 * presentation-состояния (REND-11), ровно как у `RenderHost`. Хост от этого
 * остаётся потоком тиков и только им: документных веток здесь нет, а второй
 * продюсер (`DocumentSource`) пользуется той же сценой, не заглядывая сюда.
 * Игровой сборке сцену передавать неоткуда — второго продюсера в ней не
 * существует, и хост заводит свою.
 */
import type { TerrainGrid, Vec2 } from '@game-mvp/core';
import {
  PresentationStage,
  ViewBuffer,
  type PresentationProducer,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '@game-mvp/render';
import { readTick } from './codec.js';
import type {
  ControlMessage,
  HelloMessage,
  InputMessage,
  ShellPort,
  TickEnvelope,
  WorkerToMain,
} from './protocol.js';

export interface RemoteHostConfig {
  /**
   * Сцена подсистем, разделяемая с другим продюсером presentation-состояния
   * (REND-11): её передаёт редактор, чтобы вьюпорт и runner превью (`editor`
   * ED-9) кормили одни и те же подсистемы. По умолчанию хост заводит свою — в
   * игровом клиенте второго продюсера не существует.
   */
  readonly stage?: PresentationStage;
  /** Скачок позиции за тик больше этого (мировых единиц) — телепорт, snap (REND-2). */
  readonly snapDistance?: number;
  /** Часы в миллисекундах; по умолчанию performance.now — параметр ради тестов. */
  readonly clock?: () => number;
  /**
   * Handshake получен (SHELL-5): terrain и полезная нагрузка сборки доступны,
   * пора регистрировать подсистемы — до первой доставки состояния.
   */
  readonly onReady?: (hello: HelloMessage) => void;
}

export class RemoteHost implements PresentationProducer {
  readonly name = 'remote';

  private readonly presentation: PresentationStage;
  private readonly config: RemoteHostConfig;
  private readonly kindTable: string[] = [];
  private port: ShellPort | null = null;
  private buffer: ViewBuffer | null = null;

  /** Сетка террейна из handshake; null до него и на сценах без террейна. */
  terrain: TerrainGrid | null = null;
  /** Суммарно вытесненных лимитом аккумулятора событий (диагностика Risks). */
  expiredEvents = 0;

  constructor(context: RenderContext, config: RemoteHostConfig = {}) {
    this.presentation = config.stage ?? new PresentationStage(context);
    this.config = config;
  }

  /** Presentation-состояние последнего доставленного тика; null до первой доставки. */
  get view(): TickView | null {
    return this.buffer?.view ?? null;
  }

  /** Сцена подсистем — общая с документным источником, когда его завёл редактор (REND-11). */
  get stage(): PresentationStage {
    return this.presentation;
  }

  /** Регистрирует подсистему; порядок регистрации = порядок вызовов (REND-8). */
  register(subsystem: RenderSubsystem): this {
    this.presentation.register(subsystem);
    return this;
  }

  /** Подключает порт воркера; сообщения начинают обрабатываться немедленно. */
  connect(port: ShellPort): this {
    if (this.port !== null) throw new Error('RemoteHost: порт уже подключён');
    this.port = port;
    port.onMessage((message) => { this.onMessage(message as WorkerToMain); });
    return this;
  }

  /**
   * Кадр: дословный контракт `RenderHost.frame` (REND-2, REND-8). Пока
   * presentation-состояние наполняет другой продюсер (режим правки, REND-11),
   * кадр не рисуется: подсистемы уже ведёт он.
   */
  frame(now?: number): void {
    if (this.buffer === null || !this.presentation.isActive(this)) return;
    const timing = now === undefined ? this.buffer.frame() : this.buffer.frame(now);
    if (timing === null) return;
    this.presentation.frame(timing.dt, timing.alpha);
  }

  /** Сырой ввод в воркер (SHELL-6); `move` — уже fixed-вектор. */
  sendInput(move: Vec2, aimDir = 0, buttons = 0): void {
    const message: InputMessage = { t: 'input', move, aimDir, buttons };
    this.requirePort().post(message);
  }

  /** Команда машины состояний мира (SHELL-6, WSM-1..6). */
  control(action: ControlMessage['action'], tick?: number): void {
    const message: ControlMessage =
      tick === undefined ? { t: 'control', action } : { t: 'control', action, tick };
    this.requirePort().post(message);
  }

  private onMessage(message: WorkerToMain): void {
    switch (message.t) {
      case 'hello':
        this.onHello(message);
        return;
      case 'tick':
        this.onTick(message);
        return;
    }
  }

  private onHello(hello: HelloMessage): void {
    this.terrain = hello.terrain;
    this.buffer = new ViewBuffer({
      tickSeconds: hello.tickSeconds,
      ...(this.config.snapDistance !== undefined
        ? { snapDistance: this.config.snapDistance }
        : {}),
      ...(hello.terrain !== null ? { floorBits: new Uint8Array(hello.terrain.floor) } : {}),
      ...(this.config.clock !== undefined ? { clock: this.config.clock } : {}),
    });
    this.config.onReady?.(hello);
  }

  private onTick(envelope: TickEnvelope): void {
    const buffer = this.buffer;
    if (buffer === null) return; // тик до handshake — некому применять
    for (const kind of envelope.kinds) this.kindTable.push(kind);
    this.expiredEvents += envelope.expiredEvents;

    // Колонки — view'ы в буфер: выпить всё синхронно до возврата (SHELL-3).
    // Публикация потоком тиков: если состояние наполнял документный источник,
    // его набор гасится здесь же — объект не попадёт в кадр дважды (REND-11).
    // Гашение и `syncTick` идут до возврата буфера, как и раньше.
    buffer.apply(readTick(envelope.buffer, envelope.events, this.kindTable));
    this.presentation.publish(this, buffer.view);

    this.requirePort().post({ t: 'ret', buffer: envelope.buffer }, [envelope.buffer]);
  }

  private requirePort(): ShellPort {
    if (this.port === null) throw new Error('RemoteHost: порт не подключён');
    return this.port;
  }
}
