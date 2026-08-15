/**
 * WorkerShell — воркер-сторона ЛОКАЛЬНОГО режима оболочки (SHELL-1, SHELL-8):
 * владеет симуляцией, тикером и каналом. Главному потоку отсюда не видно
 * ничего, кроме handshake и конвертов тиков.
 *
 * Локальный режим означает, что состояние производит сама оболочка: воркер
 * тикает симуляцию, держит `HistoryProvider` и исполняет переходы машины
 * состояний у себя. Так поднимаются демо, редактор (`editor` ED-9) и
 * офлайн-прогон. Клиент сетевого матча поднимает вторую воркер-сторону —
 * `NetworkShell` (`networkShell.ts`), у которой симуляции нет вовсе; режим
 * фиксируется на старте сессии и меняться по ходу MUST NOT (SHELL-8).
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
  type HistoryProvider,
  type InputFrame,
  type InputLog,
  type RewindController,
  type Simulation,
  type SimulationState,
  type TickObserver,
  type Vec2,
} from '@game-mvp/core';
import { firstRewindRequest } from '@game-mvp/net';
import type { Extractor } from '@game-mvp/render';
import { ShellSender, type SenderOptions } from './sender.js';
import { helloMessage, type ControlMessage, type MainToWorker, type ShellPort } from './protocol.js';

/** Потолок навёрстывания за один проход таймера; дальше — пересинхронизация. */
const MAX_CATCH_UP_TICKS = 4;

const SCRUB_DEFAULTS = {
  /** Тиков назад за шаг скраба. */
  step: 4,
  /** Тиков между шагами: реже тика — по той же причине, что у сервера. */
  every: 2,
  /** Порог молчания главного потока в тиках: замолчал — считаем отпущенным. */
  timeoutTicks: 15,
} as const;

/**
 * История локального режима: провайдер ядра плюс необязательная обрезка стёртой
 * перемоткой ветви. Контракт объявлен структурно, а не типом сетевого слоя:
 * `RingHistory` ядра подходит как есть, `BranchHistory` матча — вместе с
 * `dropAfter`, и оболочке не приходится знать, чей провайдер ей дали.
 *
 * Без обрезки после перемотки в буфере оказываются два снапшота на один номер
 * тика — стёртой ветви и живой, — и следующая перемотка восстановила бы ту,
 * в которой мир уже не находится.
 */
export interface ShellHistory extends HistoryProvider {
  dropAfter?(tick: number): void;
}

/** Орган ведения скраба в локальном режиме (REW-5, REW-7). */
export interface ShellScrubOptions {
  /** Бит действия, удержание которого ведёт точку перемотки назад. */
  readonly button: number;
  /** Тиков назад за шаг; по умолчанию — {@link SCRUB_DEFAULTS}. */
  readonly step?: number;
  /** Тиков между шагами. */
  readonly every?: number;
  /** Порог молчания главного потока в тиках: пропал канал — мир возобновляется. */
  readonly timeoutTicks?: number;
}

/** Ведущаяся перемотка: живёт от запроса до возобновления, состоянием мира не является. */
interface ScrubSession {
  readonly floor: number;
  idleTicks: number;
  sinceStep: number;
}

export interface WorkerShellConfig {
  /**
   * Режим оболочки (SHELL-8), объявляемый сборкой. Тип — литерал: `WorkerShell`
   * есть локальный режим, и другого значения у него не бывает. Поле при этом
   * обязательное, а не выведенное умолчанием: умолчание сделало бы один из двух
   * режимов неявной нормой, а SHELL-8 требует выбора на старте сессии.
   */
  readonly mode: 'local';
  readonly port: ShellPort;
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly tickSeconds: number;
  readonly extractor: Extractor;
  /** Слот локального игрока; undefined — тикать без ввода (наблюдатель). */
  readonly playerId?: string;
  /** Контроллер переходов WSM; undefined — команды управления игнорируются. */
  readonly rewind?: RewindController;
  /**
   * Канонический лог вводов (TICK-2): реплей внутри `seekTo` идёт по нему
   * (REW-2). Пишет его оболочка, потому что канонический кадр собирает она —
   * наблюдателю тика `InputFrame` не виден вовсе.
   */
  readonly inputs?: InputLog;
  /**
   * История снапшотов. Снимается только с живых тиков (SNAP-1): реплей и
   * замороженный мир историю не пишут.
   */
  readonly history?: ShellHistory;
  /**
   * Орган ведения скраба. Нет поля — оболочка исполнит запрос перемотки, но
   * вести точку ей нечем, и мир возобновится по порогу молчания.
   */
  readonly scrub?: ShellScrubOptions;
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

  /**
   * Кнопки САМОГО СВЕЖЕГО сообщения ввода, а не латч тика: во время перемотки
   * живых тиков нет, и «держит ли игрок орган управления» читается прямо из
   * входящего сообщения (REW-5) — ровно как сервер читает это из входящих
   * кадров инициатора (`netcode` NET-11). Латч `buttons` для этого не годится:
   * он собирает фронты и гасится на границе тика, то есть отвечает на другой
   * вопрос — «нажимали ли», а не «держат ли сейчас».
   */
  private controlButtons = 0;
  /** Тиков с последнего сообщения ввода: молчание главного потока = отпускание. */
  private idleTicks = 0;
  private scrub: ScrubSession | undefined;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTickAt = 0;

  constructor(config: WorkerShellConfig) {
    this.config = config;
    this.clock = config.clock ?? (() => performance.now());
    this.tickMs = config.tickSeconds * 1000;
    this.sender = new ShellSender(config.port, config.sender);
    this.observer = {
      name: 'shell',
      onTick: (result) => { this.sender.push(config.extractor.extract(result)); },
    };
    config.port.onMessage((message) => { this.onMessage(message as MainToWorker); });
  }

  /** Шлёт handshake (SHELL-5, SHELL-8: с режимом) и запускает тикер. */
  start(): void {
    this.config.port.post(
      helloMessage({
        mode: this.config.mode,
        tickSeconds: this.config.tickSeconds,
        terrain: this.config.sim.terrain?.grid ?? null,
        // Словарь статов доставки — один раз в handshake (HUD-8, SHELL-5).
        statNames: this.config.extractor.statNames,
        ...(this.config.helloExtra !== undefined ? { extra: this.config.helloExtra } : {}),
      }),
    );
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
    this.idleTicks++;
    // Шаг ведения точки перемотки — ДО тика: замороженный тик отдаёт
    // наблюдателям текущее состояние мира, и восстановленное должно успеть им
    // стать. Иначе презентация отставала бы от скраба на тик.
    if (state.mode !== 'Running') {
      this.driveScrub();
      // Ввод, накопленный в замороженном мире, симуляции не достаётся (REW-5):
      // латч фронтов гасится тут же, а не доезжает залпом до первого живого
      // тика после возобновления. Тот же смысл, что у сброса неприменённых
      // кадров на сервере (`netcode` NET-11).
      this.buttons = 0;
    }

    const live = state.mode === 'Running';
    // Вне `Running` канонический кадр не собирается: применить его некуда
    // (REW-4), а ввод замороженного мира на симуляцию влиять не должен (REW-5).
    const frames: InputFrame[] =
      live && this.config.playerId !== undefined ? [this.takeInputFrame(state.tick + 1)] : [];
    if (live) this.config.inputs?.record(state.tick + 1, frames);

    const result = coreTick(sim, state, frames);
    dispatch(result, [this.observer, ...(this.config.observers ?? [])]);
    if (!live) return;

    // Снапшоты — только с живых тиков (SNAP-1).
    this.config.history?.record(state);
    // Запрос перемотки дренируется ПОСЛЕ тика: ядро событие не исполняет, мир
    // внутри тика им не изменён (TICK-3), переходы проводит хост (SHELL-6).
    this.drainRewindRequest(result.events);
  }

  /**
   * Локальный хост исполняет запрос ульты сам (REW-12) — тем же core-API, что и
   * команды управления (WSM-5, SHELL-6). В сетевом режиме этого пути нет: там
   * запрос дренирует сервер, а собственной перемотки у клиента MUST NOT быть
   * вовсе (`netcode` NET-11).
   *
   * Испорченный payload запросом не считается: `firstRewindRequest`
   * предупреждает и отдаёт `undefined`, а не бросает, — тик локального мира от
   * опечатки в контенте умирать не должен так же, как и цикл матча.
   */
  private drainRewindRequest(events: Parameters<typeof firstRewindRequest>[0]): void {
    const rewind = this.config.rewind;
    if (rewind === undefined) return;
    const request = firstRewindRequest(events);
    if (request === undefined) return;
    if (rewind.mode !== 'Running') return;

    const { state } = this.config;
    const floor = Math.max(
      0,
      state.tick - Math.max(0, request.depthTicks),
      this.config.history?.oldestTick ?? 0,
    );
    rewind.pause();
    rewind.beginRewind();
    this.scrub = { floor, idleTicks: 0, sinceStep: 0 };
    this.idleTicks = 0;
  }

  /**
   * Ведение точки перемотки по удержанию (REW-13, REW-7): шаг реже тика,
   * отпускание и достижение глубины дают один исход — `Rewinding → Paused →
   * Running`.
   */
  private driveScrub(): void {
    const session = this.scrub;
    const rewind = this.config.rewind;
    if (session === undefined || rewind === undefined) return;
    // Мир вывели из `Rewinding` мимо драйвера — командой управления из HUD,
    // например: ведение точки прекращается, второго ведущего у машины
    // состояний нет.
    if (rewind.mode !== 'Rewinding') {
      this.scrub = undefined;
      return;
    }

    const scrub = this.config.scrub;
    const timeoutTicks = scrub?.timeoutTicks ?? SCRUB_DEFAULTS.timeoutTicks;
    session.sinceStep++;
    if (session.sinceStep < (scrub?.every ?? SCRUB_DEFAULTS.every)) return;
    session.sinceStep = 0;

    // Органа управления нет вовсе — держать нечем: мир возобновится по порогу
    // молчания, а не зависнет в `Rewinding`.
    const held = scrub !== undefined && (this.controlButtons & (1 << scrub.button)) !== 0;
    if (!held || this.idleTicks > timeoutTicks) {
      this.stopScrub();
      return;
    }

    const { state } = this.config;
    const target = Math.max(session.floor, state.tick - (scrub.step ?? SCRUB_DEFAULTS.step));
    if (target < state.tick) {
      rewind.seekTo(target);
      // Стёртая ветвь уходит из истории здесь же: живые тики новой ветви пойдут
      // по тем же номерам, и двух снапшотов на один тик в буфере быть не должно.
      this.config.history?.dropAfter?.(state.tick);
    }
    if (target <= session.floor) this.stopScrub();
  }

  /** Конец ведения точки: мир продолжается с откаченного тика (WSM-2). */
  private stopScrub(): void {
    this.scrub = undefined;
    this.config.rewind?.pause();
    this.config.rewind?.resume();
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
        this.controlButtons = message.buttons;
        this.idleTicks = 0;
        if (message.buttons !== 0) this.aimDir = message.aimDir;
        return;
      case 'control':
        this.onControl(message);
        return;
    }
  }

  /**
   * Локальный режим исполняет запрошенный переход у себя, через core-API
   * (SHELL-6, WSM-5): авторитет над состоянием здесь у оболочки. В сетевом
   * режиме этого пути нет вовсе — запрос уезжает вводом на сервер
   * (`NetworkShell`), потому что собственной перемотки у клиента MUST NOT быть
   * ни при каких условиях (`netcode` NET-11).
   */
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
    this.timer = setTimeout(() => { this.onTimer(); }, Math.max(0, this.nextTickAt - this.clock()));
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
