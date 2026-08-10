/**
 * NetworkShell — воркер-сторона СЕТЕВОГО режима оболочки (SHELL-1, SHELL-8):
 * держит клиент матча `engine/net-ts`, применяет персональные снапшоты и
 * извлекает из них presentation-состояние тем же `Extractor`, что локальный
 * режим. `tick()` отсюда не вызывается ни разу за сессию (`netcode-transport`
 * NTR-10) — и не «не вызывается по договорённости», а не может быть вызван:
 * `Simulation` у этого объекта нет вовсе, в конфиг приезжает только
 * `SimulationState` наполняемого снапшотами мира. Запрет структурный, а не
 * проверка в рантайме (SHELL-8).
 *
 * Чего здесь нет по той же причине: тикера симуляции, `RewindController`
 * (собственной перемотки у клиента MUST NOT быть ни при каких условиях —
 * `netcode` NET-11, `snapshot-rewind` REW-6) и `HistoryProvider` мира (полного
 * отката всего мира у клиента нет — `netcode` NET-10). Кольцо своих
 * `InputFrame` глубиной по `netcode` NET-9 есть — его ведёт `MatchClient`.
 *
 * Что здесь то же, что в локальном режиме, и это главное: канал (`ShellSender`,
 * кодек, конверты), раскладка буфера, разделение conflatable-состояния и
 * reliable-событий, состав handshake и часы главного потока. Подсистема рендера
 * (`rendering` REND-8) не знает, откуда приехал тик, — ровно так же, как не
 * знает, что он приехал каналом, а не прямым вызовом (SHELL-8).
 *
 * Мир, поднятый локально. Он есть и в сетевом режиме — `netcode-transport`
 * NTR-10 требует локального `worldInit` ради сверки хешей (NTR-5), — но
 * производимым оболочкой состоянием MUST NOT считаться: он наполняется
 * применёнными снапшотами (SHELL-8). Поднимает его сборка тем же публичным
 * путём, которым его поднимает клиент (`buildMatchWorld`), и отдаёт сюда одно
 * лишь состояние.
 *
 * ponytail: мир этот второй — свой `worldInit` для сверки хешей `MatchClient`
 * поднимает внутри себя и наружу не отдаёт. Один мир на сетевого клиента
 * означал бы правку `engine/net-ts`, которой эта работа не делает; снимается
 * это одним геттером, когда сетевой слой будет трогаться по другому поводу.
 */
import {
  FLOOR_COMPONENT,
  restoreSnapshot,
  type ChangeSet,
  type EntityId,
  type GameEvent,
  type Serializer,
  type SimulationState,
  type TerrainGrid,
  type Vec2,
} from '@game-mvp/core';
import {
  ClientHost,
  type DeliveredEvents,
  type InputSample,
  type MatchClient,
  type Transport,
} from '@game-mvp/net';
import type { Extractor, RenderEvent } from '@game-mvp/render';
import { ShellSender, type SenderOptions } from './sender.js';
import { helloMessage, type ControlMessage, type MainToWorker, type ShellPort } from './protocol.js';

/** Темп локального шага до `Welcome`: настоящий приезжает в pacing матча (NTR-7). */
const FALLBACK_STEP_RATE = 60;

/** Шина применяемого состояния, когда фактов этого тика в потоке не было. */
const NO_EVENTS: readonly GameEvent[] = [];

/**
 * Метка «дельты неизвестны, пол перечитать»: снапшот dirty-tracking'а не несёт
 * (OBS-6), а единственный читатель дельт в потоке рендера — зеркало карты пола
 * в `Extractor`, и смотрит он только на непустоту множества (TERR-6 → REND-7).
 * Поэтому непустоту метка и объявляет, а состав дельт — нет: перечитывание идёт
 * диффом по миру, и на неподвижном полу он вернёт пустой список.
 */
const FLOOR_MARK: ReadonlySet<EntityId> = new Set<EntityId>([0]);
const NO_ENTITIES: ReadonlySet<EntityId> = new Set<EntityId>();
const SNAPSHOT_CHANGES: ChangeSet = {
  isEmpty: false,
  changedEntities: (component) => (component === FLOOR_COMPONENT ? FLOOR_MARK : NO_ENTITIES),
};

/**
 * Отображение запросов машины состояний (SHELL-6) в биты кнопок ввода.
 *
 * Механизм — то, что запрос уезжает вводом на сервер (`netcode` NET-11);
 * политика — какая кнопка означает ульту отката, и живёт она в геймплейной
 * системе evaluator'а (`snapshot-rewind` WSM-5). Поэтому здесь параметр сборки,
 * а не таблица в коде оболочки: неотображённое действие ОТБРАСЫВАЕТСЯ со
 * счётчиком и локально не исполняется — исполнить его тут было бы ровно то, что
 * SHELL-6 запрещает.
 */
export type ControlButtons = Readonly<Partial<Record<ControlMessage['action'], number>>>;

export interface NetworkShellConfig {
  /**
   * Режим оболочки (SHELL-8), объявляемый сборкой. Тип — литерал: `NetworkShell`
   * есть сетевой режим. Обязателен по той же причине, что у локальной стороны:
   * умолчание сделало бы один из режимов неявной нормой.
   */
  readonly mode: 'network';
  readonly port: ShellPort;
  /** Клиент матча (`netcode-transport` NTR-10) — его цикл, кольцо инпутов и сверка хешей. */
  readonly client: MatchClient;
  /** Соединение до сервера матча; реализацию выбирает сборка (NTR-2). */
  readonly transport: Transport;
  /**
   * Состояние локально поднятого мира матча (NTR-5, NTR-10): в него применяются
   * снапшоты, и из него извлекается presentation-состояние. `Simulation` сюда не
   * приезжает намеренно — тикать этот мир нечем (SHELL-8).
   */
  readonly state: SimulationState;
  /**
   * Длительность интервала между доставками состояния в секундах — знаменатель
   * альфы интерполяции главного потока (SHELL-3, REND-2). В сетевом режиме
   * доставки идут в темпе рассылки снапшотов, поэтому сборка передаёт
   * `1 / snapshotRate` матча — ту же величину, которой сервер настроен.
   */
  readonly tickSeconds: number;
  readonly extractor: Extractor;
  /** Сетка террейна сцены для handshake (SHELL-5); null — сцена без террейна. */
  readonly terrain?: TerrainGrid | null;
  /** Биты кнопок для запросов машины состояний; без записи действие отбрасывается. */
  readonly controlButtons?: ControlButtons;
  /** Полезная нагрузка handshake для main-сборки (id игрока и прочее). */
  readonly helloExtra?: unknown;
  readonly sender?: SenderOptions;
  /** Сериализатор кадров матча; по умолчанию — умолчание протокола. */
  readonly serializer?: Serializer;
  /** Часы в миллисекундах — параметр ради тестов. */
  readonly clock?: () => number;
}

export class NetworkShell {
  /** Клиент матча — наблюдаемый выход сессии: фаза, счётчики (NTR-11), эпоха. */
  readonly client: MatchClient;

  private readonly config: NetworkShellConfig;
  private readonly sender: ShellSender;
  private readonly host: ClientHost;
  private readonly clock: () => number;

  // Латч ввода между отправками: move — последний, buttons — OR (SHELL-6).
  private move: Vec2 = { x: 0, y: 0 };
  private aimDir = 0;
  private buttons = 0;

  /** Пара `(эпоха, тик)` последнего извлечённого состояния (NTR-16). */
  private lastEpoch = 0;
  private lastTick = -1;
  /** Факты потока, чей тик обогнал применённое состояние: доедут следующей доставкой. */
  private pending: DeliveredEvents[] = [];
  /** Запросы переходов, отброшенные за отсутствием отображения в кнопку. */
  private unmapped = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: NetworkShellConfig) {
    this.config = config;
    this.client = config.client;
    this.clock = config.clock ?? (() => performance.now());
    this.sender = new ShellSender(config.port, config.sender);
    this.host = new ClientHost(config.client, config.transport, {
      now: this.clock,
      // Ввод главного потока уходит серверу сообщением `Input` (`netcode` NET-7)
      // и локально не применяется: предсказания в MVP нет (NTR-10).
      input: () => this.takeInput(),
      ...(config.serializer !== undefined ? { serializer: config.serializer } : {}),
    });
    config.port.onMessage((message) => { this.onMessage(message as MainToWorker); });
  }

  /** Сколько запросов переходов отброшено без отображения в кнопку — диагностика. */
  get unmappedControls(): number {
    return this.unmapped;
  }

  /**
   * Шлёт handshake (SHELL-5, SHELL-8: с режимом), предъявляет версию серверу
   * (NTR-5) и запускает локальный шаг.
   *
   * Handshake уходит здесь, а не по приходу `Welcome`: главный поток обязан
   * знать режим до первого кадра (SHELL-8), а состояний до `Welcome` не бывает —
   * значит порядок «режим раньше первой доставки состояния» соблюдён и в самом
   * плохом случае.
   */
  start(): void {
    this.config.port.post(
      helloMessage({
        mode: this.config.mode,
        tickSeconds: this.config.tickSeconds,
        terrain: this.config.terrain ?? null,
        ...(this.config.helloExtra !== undefined ? { extra: this.config.helloExtra } : {}),
      }),
    );
    this.host.start();
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Один шаг локального времени клиента: оценка серверного тика, отправка ввода,
   * приём доехавшего. Отдельно от таймера — тем же приёмом, что `stepTick()`
   * локальной стороны: headless-прогон и тест двигают сессию сами.
   *
   * Тиком симуляции этот шаг не является и им не становится: он ничего не
   * вычисляет о мире, а переносит уже случившееся у сервера.
   */
  step(): void {
    const delivered = this.host.step();
    for (const batch of delivered.events) {
      // Факты стёртой перемоткой ветви истории до представления не доезжают: их
      // тик принадлежит другой ветви, и проиграть их значило бы озвучить
      // события, которых в текущей истории матча не было (NTR-16). Отличить их
      // даёт эпоха пачки, и решение — потребителя (`netcode-transport` NTR-15).
      if (batch.epoch < this.client.epoch) continue;
      this.pending.push(batch);
    }
    this.applyLatest(delivered.state?.discontinuity ?? false);
    if (this.client.phase === 'closed') this.stop();
  }

  /**
   * Применённый персональный снапшот → presentation-состояние (SHELL-8).
   *
   * Свежесть — по ПАРЕ `(эпоха, тик)` лексикографически (NTR-10, NTR-16): при
   * перемотке номера тиков идут назад, и сравнение по одному тику погасило бы
   * ровно те состояния, которые `netcode` NET-11 велит показать.
   */
  private applyLatest(discontinuity: boolean): void {
    const latest = this.client.latest;
    if (latest === undefined) return;
    const epoch = this.client.epoch;
    if (epoch < this.lastEpoch || (epoch === this.lastEpoch && latest.tick <= this.lastTick)) {
      return;
    }

    // Факты тиков, предшествующих применяемому состоянию, уходят reliable-частью
    // конверта тем же путём, что события локального тика (SHELL-4); факты самого
    // применяемого тика едут шиной восстановленного мира, потому что из них
    // `Extractor` выводит ещё и направление каста (REND-5). Оба источника —
    // поток `Events` (NTR-15) и только он: шину снапшота презентационная
    // поверхность клиента не отдаёт вовсе, и прочитать её здесь нечем.
    const before: RenderEvent[] = [];
    const own: GameEvent[] = [];
    const rest: DeliveredEvents[] = [];
    for (const batch of this.pending) {
      // Факты эпохи, стёртой перемоткой, отбрасываются и здесь, а не только на
      // приёме: пачка могла лечь в ожидание ДО того, как эпоха выросла, и её тик
      // с тиками новой ветви несравним (NTR-16).
      if (batch.epoch < epoch) continue;
      if (batch.tick < latest.tick) {
        for (const event of batch.events) {
          before.push({ type: event.type, tick: batch.tick, data: event.data });
        }
      } else if (batch.tick === latest.tick) {
        for (const event of batch.events) own.push(event);
      } else {
        rest.push(batch);
      }
    }
    this.pending = rest;
    if (before.length > 0) this.sender.pushEvents(before);

    const state = this.config.state;
    restoreSnapshot(state, { ...latest, events: own.length > 0 ? own : NO_EVENTS });
    // Разрыв непрерывности мира (SHELL-7) едет в `isReplay`: для рендера
    // «состояние другой ветви истории» и «реплеевый тик» — один случай, разрыв
    // (REND-2), и `snapAll` extractor выводит из него сам. Тем же флагом он
    // гасит `freshEvents`: события перемотанного состояния уже показывались в
    // стёртой ветви.
    this.sender.push(
      this.config.extractor.extract({
        state,
        tick: latest.tick,
        mode: state.mode,
        isReplay: discontinuity,
        events: state.events,
        changes: SNAPSHOT_CHANGES,
      }),
    );

    this.lastEpoch = epoch;
    this.lastTick = latest.tick;
  }

  /** Латч ввода на отправку: `undefined` не возвращается — кадр уходит каждый шаг. */
  private takeInput(): InputSample {
    const sample: InputSample = { move: this.move, aimDir: this.aimDir, buttons: this.buttons };
    // Кнопки — фронты: латч очищается, move — состояние: остаётся. Правило то
    // же, что у локального режима, и по той же причине: нажатие между отправками
    // не должно потеряться.
    this.buttons = 0;
    return sample;
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

  /**
   * Запрос перехода машины состояний уходит вводом на сервер (SHELL-6, `netcode`
   * NET-11, REW-6) — тем же кольцом инпутов и тем же сообщением `Input`, что
   * обычный ввод: включение и выключение ульты отката для сервера неотличимо от
   * прочих нажатий, и второго канала под управление в протоколе не существует
   * (NET-7).
   *
   * Тик из `seekTo` здесь теряется намеренно: точку остановки ведёт инициатор
   * ульты на сервере (`snapshot-rewind` REW-7), а клиент шлёт только ввод —
   * канала для «перемотай на тик N» нет и быть не должно.
   */
  private onControl(message: ControlMessage): void {
    const mask = this.config.controlButtons?.[message.action];
    if (mask === undefined) {
      this.unmapped++;
      return;
    }
    this.buttons |= mask;
  }

  /**
   * Локальный шаг идёт в темпе тиков матча — той же величине, которой клиент
   * продвигает оценку серверного тика (NTR-7). Тикером симуляции этот таймер не
   * является: тикать ему нечего, навёрстывать нечего, и после долгой заморозки
   * он просто продолжает шагать — прошлое матча приедет снапшотами.
   */
  private schedule(): void {
    const rate = this.client.pacing?.tickRate ?? FALLBACK_STEP_RATE;
    this.timer = setTimeout(() => {
      this.step();
      if (this.timer !== null) this.schedule();
    }, 1000 / rate);
  }
}
