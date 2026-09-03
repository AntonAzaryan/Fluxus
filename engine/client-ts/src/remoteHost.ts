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
 * Режим оболочки (SHELL-8) main-сторону не ветвит: обе воркер-стороны — и
 * локальная (`WorkerShell`), и сетевая (`NetworkShell`) — говорят одним
 * протоколом, и хост читает конверты, не спрашивая, откуда приехал тик.
 * Единственное, что режим здесь меняет, — что о нём ЗНАЮТ: он приезжает в
 * handshake, доступен потребителю в `onReady` и полем `mode`, и по нему UI
 * решает, существуют ли органы управления перемоткой. Отправку `control` хост не
 * запрещает и в сетевом режиме: форма сообщений одна на оба режима (SHELL-6), а
 * что с запросом произойдёт дальше, решает воркер-сторона.
 *
 * Реестр подсистем и кадр живут в `PresentationStage` — общей части продюсеров
 * presentation-состояния (REND-11), ровно как у `RenderHost`. Хост от этого
 * остаётся потоком тиков и только им: документных веток здесь нет, а второй
 * продюсер (`DocumentSource`) пользуется той же сценой, не заглядывая сюда.
 * Игровой сборке сцену передавать неоткуда — второго продюсера в ней не
 * существует, и хост заводит свою.
 */
import type { TerrainGrid, Vec2 } from '@fluxus/core';
import {
  PresentationStage,
  ViewBuffer,
  tickStreamFrame,
  type PresentationProducer,
  type RenderContext,
  type RenderSubsystem,
  type TickView,
} from '@fluxus/render';
import { readTick } from './codec.js';
import type {
  ControlMessage,
  HelloMessage,
  InputMessage,
  PauseEnvelope,
  ShellMode,
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
  /**
   * Доставлено состояние паузы матча (SHELL-9, `netcode-transport` NTR-20).
   * Отдельным колбэком, а не полем кадра: в заморозке кадров нет вовсе, и пауза,
   * привязанная к ним, доехала бы только с возобновлением (см. `PauseEnvelope`).
   *
   * Хост его не трактует и ничего по нему не решает — он поток доставок, а не
   * состояние матча: куда пойдёт объявление, решает сборка (в демо — HUD,
   * HUD-9).
   */
  readonly onPause?: (pause: PauseEnvelope) => void;
}

export class RemoteHost implements PresentationProducer {
  readonly name = 'remote';

  private readonly presentation: PresentationStage;
  private readonly config: RemoteHostConfig;
  private readonly kindTable: string[] = [];
  /** Словарь статов из handshake (HUD-8, SHELL-5); пустой — сборка их не объявила. */
  private statNames: readonly string[] = [];
  private port: ShellPort | null = null;
  private buffer: ViewBuffer | null = null;

  /** Сетка террейна из handshake; null до него и на сценах без террейна. */
  terrain: TerrainGrid | null = null;
  /**
   * Режим оболочки из handshake (SHELL-8); null до него — режим наблюдением за
   * потоком доставок не выводится и до handshake неизвестен.
   */
  mode: ShellMode | null = null;
  /**
   * Суммарно вытесненных лимитом аккумулятора событий за сессию (диагностика
   * Risks). Величина ЭТОЙ доставки едет отдельно — полем доставленного
   * состояния (`TickView.expiredEvents`, SHELL-4): показать разрыв потребитель
   * вправе на той доставке, где события пропали, а не по счётчику за матч.
   */
  expiredEvents = 0;
  /**
   * Последнее доставленное состояние паузы матча (SHELL-9, NTR-20);
   * `undefined` — его не доставляли, и это не «матч идёт»: отсутствие доставки
   * есть отсутствие утверждения (SHELL-9). Наблюдательное поле рядом с колбэком
   * — для сборки, которая подписалась позже первой доставки, и для проверок;
   * матч по нему хост не ведёт (см. `onPause`).
   */
  lastPause: PauseEnvelope | undefined;

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
   * Кадр: дословный контракт `RenderHost.frame` (REND-2, REND-8) — и буквально
   * его тело: продюсер потока тиков у них один (`tickStreamFrame`), разница
   * только в том, откуда приехал тик. Пока presentation-состояние наполняет
   * другой продюсер (режим правки, REND-11), кадр не рисуется — подсистемы уже
   * ведёт он, — а часы кадра сбрасываются: превью, простоявшее в стороне,
   * иначе доиграло бы накопленное до потолка в 0.25 с одним кадром.
   */
  frame(now?: number): void {
    tickStreamFrame(this.presentation, this, this.buffer, now);
  }

  /**
   * Сырой ввод в воркер (SHELL-6); `move` и `target` — уже fixed-величины.
   * `target` необязателен: источник, точкой прицела не владеющий, о ней молчит,
   * а не сообщает начало координат (TICK-2).
   */
  sendInput(move: Vec2, aimDir = 0, buttons = 0, target: Vec2 | null = null): void {
    const message: InputMessage =
      target === null ? { t: 'input', move, aimDir, buttons } : { t: 'input', move, aimDir, target, buttons };
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
      case 'pause':
        this.lastPause = message;
        this.config.onPause?.(message);
        return;
    }
  }

  private onHello(hello: HelloMessage): void {
    this.terrain = hello.terrain;
    this.mode = hello.mode;
    this.statNames = hello.statNames ?? [];
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
    if (buffer === null) {
      // Тик до handshake — применять некому. Буфер при этом ВОЗВРАЩАЕТСЯ тем же
      // transfer'ом (SHELL-3): он уже отчуждён у воркера, и выход без возврата
      // навсегда укорачивал бы пул канала — при пуле из двух буферов вдвое.
      // Остальное содержимое конверта здесь и правда теряется: без handshake
      // нет ни раскладки видов, ни словаря статов, и класть хвост таблицы видов
      // в `kindTable` значило бы разъехаться с ней навсегда.
      this.requirePort().post({ t: 'ret', buffer: envelope.buffer }, [envelope.buffer]);
      return;
    }
    for (const kind of envelope.kinds) this.kindTable.push(kind);
    this.expiredEvents += envelope.expiredEvents;

    // Колонки — view'ы в буфер: выпить всё синхронно до возврата (SHELL-3).
    // Публикация потоком тиков: если состояние наполнял документный источник,
    // его набор гасится здесь же — объект не попадёт в кадр дважды (REND-11).
    // Гашение и `syncTick` идут до возврата буфера, как и раньше.
    //
    // Число вытесненных с прошлой доставки событий едет в доставленное
    // состояние (SHELL-4): собственный счётчик хоста суммарен за сессию, а
    // потребителю нужна величина ЭТОЙ доставки — иначе «событий не было» и
    // «события были и не доехали» для него неразличимы.
    buffer.apply(
      readTick(envelope.buffer, envelope.events, this.kindTable, this.statNames),
      envelope.expiredEvents,
    );
    this.presentation.publish(this, buffer.view);

    this.requirePort().post({ t: 'ret', buffer: envelope.buffer }, [envelope.buffer]);
  }

  private requirePort(): ShellPort {
    if (this.port === null) throw new Error('RemoteHost: порт не подключён');
    return this.port;
  }
}
