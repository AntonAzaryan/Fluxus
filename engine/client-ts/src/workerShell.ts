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
} from '@game-mvp/core';
import {
  firstRewindRequest,
  warnToConsole,
  REWIND_REQUEST_EVENT,
  type RewindRequestWarn,
} from '@game-mvp/net';
import type { Extractor } from '@game-mvp/render';
import { ShellSender, type SenderOptions } from './sender.js';
import { InputLatch, routeMainMessage } from './inputLatch.js';
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
  /**
   * Хотя бы один шаг уже сделан. Нужен ровно затем, чтобы ПЕРВЫЙ шаг не ждал
   * цикла и не перепроверял орган: вход в перемотку уже означает, что орган был
   * удержан — ульту прожали им же (REW-13).
   */
  stepped: boolean;
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
   * Приёмник диагностики запроса перемотки (REW-12): испорченный payload и
   * запрос, который оболочка НЕ МОЖЕТ исполнить структурно — контроллера в
   * сборке нет. Шов сборки, а не свойство мира; умолчание — `console.warn`.
   *
   * Тот же шов, что у сервера матча (`MatchServer.rewindWarn`), и по тому же
   * основанию: сцена, просящая механизм, которого хост не собрал, снаружи
   * неотличима от ульты, которая ничего не делает.
   */
  readonly rewindWarn?: RewindRequestWarn;
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

  /** Латч ввода между тиками — общий обоим режимам (`inputLatch.ts`, SHELL-6). */
  private readonly input = new InputLatch();
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
  /**
   * Несобираемость перемотки уже названа вслух. Один раз на сессию: строка на
   * каждый каст утопила бы консоль в собственном шуме.
   */
  private rewindUnavailableReported = false;

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
      this.input.dropButtons();
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
   *
   * Оболочка, собранная БЕЗ контроллера, запрос не исполняет — но и не молчит.
   * Это не тот же случай, что «запрос не в `Running`»: там сработала норма
   * REW-12, а здесь дефект СБОРКИ — сцена просит механизм, которого оболочке не
   * дали, и снаружи это выглядит как ульта, которая жжёт cooldown и ничего не
   * делает. Ровно так дефект и жил на сервере матча, пока раскладка документа
   * теряла секцию `rewind`. Отчёт — диагностика, а не исключение: тик
   * локального мира убивать нечем.
   */
  private drainRewindRequest(events: Parameters<typeof firstRewindRequest>[0]): void {
    const rewind = this.config.rewind;
    // Несобираемость уже названа — разбирать шину незачем: второй раз она
    // ничего нового не сообщит.
    if (rewind === undefined && this.rewindUnavailableReported) return;
    const request = firstRewindRequest(events, this.config.rewindWarn);
    if (request === undefined) return;
    if (rewind === undefined) {
      this.rewindUnavailableReported = true;
      (this.config.rewindWarn ?? warnToConsole)(
        `${REWIND_REQUEST_EVENT}: оболочка собрана без контроллера перемотки — ` +
          'перематывать нечем (SHELL-6, NET-11, SNAP-4). Запрос отброшен, ' +
          'следующие запросы этой сессии отбрасываются молча',
      );
      return;
    }
    if (rewind.mode !== 'Running') return;

    const { state } = this.config;
    const floor = Math.max(
      0,
      state.tick - Math.max(0, request.depthTicks),
      this.config.history?.oldestTick ?? 0,
    );
    rewind.pause();
    rewind.beginRewind();
    // Шага здесь нет намеренно: тик, на котором ульта прожата, обязан остаться
    // тем, каким его оставил живой тик (TICK-3), — точку ведёт драйвер, и
    // первый её шаг он делает на первом же своём вызове (см. `driveScrub`).
    this.scrub = { floor, idleTicks: 0, sinceStep: 0, stepped: false };
    this.idleTicks = 0;
  }

  /**
   * Ведение точки перемотки по удержанию (REW-13, REW-7): первый шаг — на
   * первом же ведении, дальше реже тика; отпускание, молчание главного потока
   * и достижение глубины дают один исход — `Rewinding → Paused → Running`.
   *
   * Тот же драйвер на втором хосте — `MatchServer.driveScrub`
   * (`engine/net-ts`, NTR-3): сервер ведёт точку по тем же правилам, читая
   * орган из кадров слота-инициатора, а не из сообщений главного потока.
   *
   * Общего кода у них нет НАМЕРЕННО, и это не случайность, а невыбранный
   * вариант: разделяемый драйвер технически возможен (прецедент рядом —
   * `firstRewindRequest` живёт в `@game-mvp/net`, и оболочка его импортирует,
   * депкруиз этого не запрещает), но различий у двух хостов больше, чем общей
   * политики — источник органа, владелец счётчика молчания, правило «инициатор
   * без слота», рассылка восстановленного состояния, — и обёртка над ними
   * вышла бы длиннее самой политики. Цена решения: правка ЗДЕСЬ обязана быть
   * повторена ТАМ, и наоборот. Держит их в шаге поведенческий тест,
   * поставленный обоим хостам: короткое нажатие двигает точку и возобновляет
   * мир на более раннем тике.
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
    // Органа управления нет вовсе — держать нечем: мир возобновится первым же
    // ведением, а не зависнет в `Rewinding`.
    if (scrub === undefined) {
      this.stopScrub();
      return;
    }

    // ПЕРВЫЙ шаг — на первом же ведении, без ожидания цикла и без перепроверки
    // органа. Прежде первого шага ждали `every` тиков, а проверка отпускания
    // стояла ЗА тем же гейтом: игрок, отпустивший клавишу внутри цикла, получал
    // мир, замерший и возобновившийся на ТОМ ЖЕ тике, — ульта сгорала на полный
    // cooldown, не отмотав ни тика. Удержание в момент каста при этом известно
    // по построению: ульту прожали тем же битом (REW-13).
    if (!session.stepped) {
      this.stepScrub();
      return;
    }

    // Дальше отпускание и молчание главного потока читаются КАЖДЫЙ тик, а не на
    // границе шага: досиженный цикл — это мир, замерший уже после того, как
    // игрок отпустил клавишу.
    const held = (this.controlButtons & (1 << scrub.button)) !== 0;
    if (!held || this.idleTicks > (scrub.timeoutTicks ?? SCRUB_DEFAULTS.timeoutTicks)) {
      this.stopScrub();
      return;
    }

    session.sinceStep++;
    if (session.sinceStep < (scrub.every ?? SCRUB_DEFAULTS.every)) return;
    this.stepScrub();
  }

  /**
   * Один шаг точки перемотки назад (REW-13): на `scrub.step` тиков, но не
   * глубже заявленной глубины автостопа и не глубже фактической глубины
   * истории — обе границы сведены в `floor` при входе (SNAP-6). Достигнув дна,
   * скраб останавливается сам: дальше отматывать нечего.
   *
   * Зовут его двое — первое ведение и последующие, — и оба через эту функцию:
   * второй экземпляр той же арифметики рядом и есть способ им разойтись.
   */
  private stepScrub(): void {
    const session = this.scrub;
    const rewind = this.config.rewind;
    if (session === undefined || rewind === undefined) return;
    session.sinceStep = 0;
    session.stepped = true;

    const { state } = this.config;
    const step = this.config.scrub?.step ?? SCRUB_DEFAULTS.step;
    const target = Math.max(session.floor, state.tick - step);
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

  /** Канонический кадр ввода из латча: `tick`/`seq` знает воркер-сторона (SHELL-6). */
  private takeInputFrame(tickNumber: number): InputFrame {
    this.seq += 1;
    const sample = this.input.take();
    return {
      tick: tickNumber,
      playerId: this.config.playerId!,
      seq: this.seq,
      move: sample.move,
      aimDir: sample.aimDir,
      // Точка появляется в кадре, только если её давали: кадр без неё и кадр с
      // нулями — разные документы для записи прогона (CLI-10).
      ...(sample.target === undefined ? {} : { target: sample.target }),
      buttons: sample.buttons,
    };
  }

  private onMessage(message: MainToWorker): void {
    routeMainMessage(
      message,
      this.sender,
      this.input,
      (control) => { this.onControl(control); },
      // Сырое сообщение ввода мимо латча: ведение точки перемотки спрашивает
      // «держат ли орган управления СЕЙЧАС», а латч отвечает на «нажимали ли
      // между тиками» (REW-5).
      (raw) => {
        this.controlButtons = raw.buttons;
        this.idleTicks = 0;
      },
    );
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
