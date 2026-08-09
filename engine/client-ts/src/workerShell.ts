/**
 * WorkerShell — воркер-сторона оболочки (SHELL-1): владеет симуляцией,
 * тикером и каналом. Главному потоку отсюда не видно ничего, кроме
 * handshake и конвертов тиков.
 *
 * Тикер — setTimeout-цикл с коррекцией дрейфа (design Decision 8): таймеры
 * dedicated worker'ов не душатся так, как main-thread (SHELL-1, сценарий
 * фоновой вкладки). Отставание навёрстывается пачкой тиков с потолком, за
 * потолком тикер пересинхронизируется — после долгой заморозки воркер не
 * «доигрывает» минуты.
 *
 * Ввод (SHELL-6): сырые сообщения main латчатся (`buttons` — OR, чтобы
 * нажатие между тиками не потерялось), на границе тика собирается
 * канонический `InputFrame` с `tick`/`seq` воркера. Команды WSM зовут
 * `RewindController` ядра и ничего больше (WSM-5).
 */
import {
  dispatch,
  tick as coreTick,
  type InputFrame,
  type RewindController,
  type Simulation,
  type SimulationState,
  type TickObserver,
  type Vec2,
} from '@game-mvp/core';
import type { Extractor } from '@game-mvp/render';
import { ShellSender, type SenderOptions } from './sender.js';
import type { ControlMessage, HelloMessage, MainToWorker, ShellPort } from './protocol.js';

/** Потолок навёрстывания за один проход таймера; дальше — пересинхронизация. */
const MAX_CATCH_UP_TICKS = 4;

export interface WorkerShellConfig {
  readonly port: ShellPort;
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly tickSeconds: number;
  readonly extractor: Extractor;
  /** Слот локального игрока; undefined — тикать без ввода (наблюдатель). */
  readonly playerId?: string;
  /** Контроллер переходов WSM; undefined — команды управления игнорируются. */
  readonly rewind?: RewindController;
  /** Дополнительные наблюдатели тика (диагностика, метрики) — после extractor'а. */
  readonly observers?: readonly TickObserver[];
  /** Полезная нагрузка handshake для main-сборки (id игрока и прочее). */
  readonly helloExtra?: unknown;
  readonly sender?: SenderOptions;
  /** Часы в миллисекундах — параметр ради тестов. */
  readonly clock?: () => number;
}

export class WorkerShell {
  private readonly config: WorkerShellConfig;
  private readonly sender: ShellSender;
  private readonly observer: TickObserver;
  private readonly clock: () => number;
  private readonly tickMs: number;

  // Латч ввода между тиками: move — последний, buttons — OR (SHELL-6).
  private move: Vec2 = { x: 0, y: 0 };
  private aimDir = 0;
  private buttons = 0;
  private seq = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;

  constructor(config: WorkerShellConfig) {
    this.config = config;
    this.clock = config.clock ?? (() => performance.now());
    this.tickMs = config.tickSeconds * 1000;
    this.sender = new ShellSender(config.port, config.sender);
    this.observer = {
      name: 'shell',
      onTick: (result) => this.sender.push(config.extractor.extract(result)),
    };
    config.port.onMessage((message) => this.onMessage(message as MainToWorker));
  }

  /** Шлёт handshake (SHELL-5) и запускает тикер. */
  start(): void {
    const hello: HelloMessage = {
      t: 'hello',
      tickSeconds: this.config.tickSeconds,
      terrain: this.config.sim.terrain?.grid ?? null,
      ...(this.config.helloExtra !== undefined ? { extra: this.config.helloExtra } : {}),
    };
    this.config.port.post(hello);
    this.nextTickAt = this.clock() + this.tickMs;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Один тик вручную — для тестов и headless-прогонов без таймеров. */
  stepTick(): void {
    const { sim, state } = this.config;
    const frames: InputFrame[] =
      this.config.playerId === undefined ? [] : [this.takeInputFrame(state.tick + 1)];
    const result = coreTick(sim, state, frames);
    dispatch(result, [this.observer, ...(this.config.observers ?? [])]);
  }

  private takeInputFrame(tickNumber: number): InputFrame {
    this.seq += 1;
    const frame: InputFrame = {
      tick: tickNumber,
      playerId: this.config.playerId!,
      seq: this.seq,
      move: this.move,
      aimDir: this.aimDir,
      buttons: this.buttons,
    };
    // Кнопки — фронты: латч очищается, move — состояние: остаётся.
    this.buttons = 0;
    return frame;
  }

  private onMessage(message: MainToWorker): void {
    switch (message.t) {
      case 'ret':
        this.sender.ack(message.buffer);
        return;
      case 'input':
        this.move = message.move;
        this.buttons |= message.buttons;
        if (message.buttons !== 0) this.aimDir = message.aimDir;
        return;
      case 'control':
        this.onControl(message);
        return;
    }
  }

  private onControl(message: ControlMessage): void {
    const rewind = this.config.rewind;
    if (rewind === undefined) return;
    switch (message.action) {
      case 'pause':
        rewind.pause();
        return;
      case 'resume':
        rewind.resume();
        return;
      case 'beginRewind':
        rewind.beginRewind();
        return;
      case 'seekTo':
        if (message.tick !== undefined) rewind.seekTo(message.tick);
        return;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.onTimer(), Math.max(0, this.nextTickAt - this.clock()));
  }

  private onTimer(): void {
    let ticked = 0;
    while (this.clock() >= this.nextTickAt && ticked < MAX_CATCH_UP_TICKS) {
      this.stepTick();
      this.nextTickAt += this.tickMs;
      ticked++;
    }
    // За потолком навёрстывания — пересинхронизация, а не догонка минут.
    if (this.clock() >= this.nextTickAt) this.nextTickAt = this.clock() + this.tickMs;
    this.schedule();
  }
}
