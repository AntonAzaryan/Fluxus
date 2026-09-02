/**
 * Эмулятор канала в ВИРТУАЛЬНОМ времени (design D6 изменения
 * `client-tick-rtt-compensation`) и матч на нём.
 *
 * Внутрипроцессный транспорт уже принимает планировщик доставки
 * (`LoopbackOptions.schedule`), поэтому эмулятор строится на нём и ничего не
 * знает ни о сервере, ни о клиенте: очередь «доставить на шаге N», которую тест
 * сливает тем же явным `step()`, что двигает матч. Ни таймеров, ни `Date.now`,
 * ни ожидания микротасков — прогон профиля воспроизводится побитово, и потому
 * ассерты здесь точные, а не «в пределах флака».
 *
 * Профиль канала — ДАННЫЕ: задержка в шагах, джиттер и потери. Джиттер и потери
 * тянутся из сидированного xorshift ядра (RNG-1), а не из `Math.random`, ровно
 * ради этой воспроизводимости: два прогона одного профиля дают одну и ту же
 * последовательность доставок.
 *
 * Настоящий сокет задержек не эмулирует и не должен: задержка на нём
 * машинозависима и дала бы флаки там, где эмулятор даёт точность. WS-тесты
 * остаются про хендшейк и разрыв.
 */
import { XorShift128Stream, seedStateFromName } from '@fluxus/core';
import { MatchHost, type MatchHostOptions } from '../../src/server/host.js';
import { MatchServer, type MatchConfig } from '../../src/server/matchServer.js';
import { LoopbackHub } from '../../src/transport/loopback.js';
import { mergeTransportServers } from '../../src/transport/merged.js';
import type { InputSource } from '../../src/client/host.js';
import { connectClient, duelConfig, STEP, type Clock, type ConnectedClient } from '../fixtures.js';

/** Замирание канала: раз в `every` шагов доставка останавливается на `steps` шагов. */
interface ChannelStall {
  readonly every: number;
  readonly steps: number;
}

/** Профиль канала — данные, а не код: он же сидирует поток случайности. */
export interface ChannelProfile {
  /** Имя профиля; им сидируется поток джиттера и потерь. */
  readonly name: string;
  /** Задержка доставки в шагах — половина круга. */
  readonly delaySteps: number;
  /** Разброс задержки: доставка едет на `delaySteps + [0, jitterSteps]`. */
  readonly jitterSteps: number;
  /** Доля теряемых сообщений в тысячных: `0` — канал без потерь. */
  readonly lossPerMille: number;
  /**
   * Пропускная способность, байт за шаг; нет поля — не ограничена. Сообщение
   * занимает канал на `bytes / bytesPerStep` шагов, отправленное позже ждёт
   * освобождения; байты сообщений, ещё не начавших передачу, — задолженность
   * канала (NTR-22), которую лупбэк отдаёт как `backlog`.
   */
  readonly bytesPerStep?: number;
  /**
   * Доставка как у потока (TCP, WebSocket): сообщение не обгоняет отправленное
   * раньше, джиттер меняет задержку, а не порядок. Нет поля — канал вправе
   * переставлять (NTR-2), как датаграммный.
   */
  readonly ordered?: boolean;
  /**
   * Замирание: доставка останавливается на `steps` шагов раз в `every`, и всё
   * накопленное уезжает залпом. Так потеря пакета выглядит с TCP/WebSocket — не
   * дырой, а паузой и всплеском.
   */
  readonly stall?: ChannelStall;
}

/** Одна доставка в журнале канала: чем и доказывается воспроизводимость. */
export interface ChannelDelivery {
  /** Шаг, на котором сообщение отдано в канал. */
  readonly sentAt: number;
  /** Шаг доставки; `-1` — канал сообщение потерял. */
  readonly deliveredAt: number;
}

interface Pending {
  readonly at: number;
  readonly order: number;
  readonly deliver: () => void;
}

/** Сообщение в очереди сериализации узкого канала: когда начнёт передачу и сколько весит. */
interface Queued {
  readonly departAt: number;
  readonly bytes: number;
}

/**
 * Канал: планировщик для `loopbackPair`/`LoopbackHub` плюс явный шаг.
 *
 * Минимальная задержка — один шаг даже у профиля с нулём: доставка обязана быть
 * асинхронной (NTR-2), иначе получатель отвечал бы отправителю, не дав тому
 * закончить обработчик, — порядок, которого в сети не бывает.
 */
export class VirtualChannel {
  private profile: ChannelProfile;
  private readonly rng: XorShift128Stream;
  private readonly pending: Pending[] = [];
  private readonly log: ChannelDelivery[] = [];
  /** Очередь сериализации узкого канала: сообщения, ещё не начавшие передачу. */
  private readonly queued: Queued[] = [];
  /** До какого шага канал занят передачей уже принятого. */
  private busyUntil = 0;
  /** Шаг доставки последнего запланированного сообщения — порог для `ordered`. */
  private lastAt = 0;
  private now = 0;
  private order = 0;

  constructor(profile: ChannelProfile) {
    this.profile = profile;
    this.rng = new XorShift128Stream(seedStateFromName(0, profile.name));
  }

  /** Планировщик доставки: то, что уезжает в `LoopbackOptions.schedule`. */
  schedule(deliver: () => void, bytes = 0): void {
    // Оба знака случайности тянутся ВСЕГДА и в одном порядке — даже когда
    // профиль их не использует: позиция потока не должна зависеть от того,
    // какие ручки в профиле ненулевые.
    const lost = this.rng.nextBelow(1000) < this.profile.lossPerMille;
    const jitter = this.rng.nextBelow(this.profile.jitterSteps + 1);
    const order = this.order++;
    if (lost) {
      this.log.push({ sentAt: this.now, deliveredAt: -1 });
      return;
    }
    // Узкий канал: сообщение ждёт, пока канал освободится от принятого раньше,
    // и занимает его на время своей передачи. Задолженность — то, что ждёт.
    // Доезжает сообщение, когда передан его последний байт: ожидание очереди
    // плюс собственная передача, и только потом дорога.
    let wire = 0;
    const width = this.profile.bytesPerStep;
    if (width !== undefined) {
      const departAt = Math.max(this.now, this.busyUntil);
      this.busyUntil = departAt + bytes / width;
      wire = this.busyUntil - this.now;
      this.queued.push({ departAt, bytes });
    }
    let at = this.now + Math.max(1, Math.ceil(wire + this.profile.delaySteps + jitter));
    // Поток не обгоняет сам себя: доставка не раньше предыдущей.
    if (this.profile.ordered === true) at = Math.max(at, this.lastAt);
    this.lastAt = at;
    this.log.push({ sentAt: this.now, deliveredAt: at });
    this.pending.push({ at, order, deliver });
  }

  /**
   * Задолженность отправки, байты (NTR-22): сообщения, принятые каналом, но ещё
   * не начавшие передачу. У канала без ограничения ширины — всегда ноль:
   * очередь видна, просто пуста.
   */
  get backlog(): number {
    let bytes = 0;
    for (const entry of this.queued) if (entry.departAt > this.now) bytes += entry.bytes;
    return bytes;
  }

  /** Канал замер: внутри окна замирания доставка стоит, накопленное едет залпом после. */
  private stalled(): boolean {
    const stall = this.profile.stall;
    return stall !== undefined && this.now % stall.every < stall.steps && this.now >= stall.every;
  }

  /**
   * Шаг канала: время двигается на единицу, и сливается всё, что к этому шагу
   * доехало. Отправленное ВНУТРИ слива ждёт следующего шага — иначе профиль с
   * нулевой задержкой доставлял бы ответ в том же шаге и цикл «ответ на ответ»
   * не имел бы дна.
   */
  step(): void {
    this.now++;
    // Очередь сериализации чистится от начавшего передачу: задолженность — это
    // ждущие, а не всё, что канал когда-либо принял.
    for (let i = this.queued.length - 1; i >= 0; i--) {
      if (this.queued[i]!.departAt <= this.now) this.queued.splice(i, 1);
    }
    if (this.stalled()) return;
    const due = this.pending.filter((entry) => entry.at <= this.now);
    if (due.length === 0) return;
    for (const entry of due) this.pending.splice(this.pending.indexOf(entry), 1);
    // Порядок слива — по времени доставки, а при равном — по порядку отправки:
    // джиттер вправе переставить сообщения (NTR-2), но переставить их обязан
    // одинаково в каждом прогоне.
    due.sort((left, right) => left.at - right.at || left.order - right.order);
    for (const entry of due) entry.deliver();
  }

  /**
   * Смена профиля на живом канале — «канал выправился» и «канал испортился»
   * одним движением. Поток случайности продолжается, а не пересидивается:
   * прогон обязан оставаться воспроизводимым и после смены.
   */
  retune(profile: ChannelProfile): void {
    this.profile = profile;
  }

  /** Журнал доставок в порядке отправки: им и сверяются два прогона профиля. */
  get journal(): readonly ChannelDelivery[] {
    return this.log;
  }
}

/** Канал без плеча: LAN, круг короче буфера задержки ввода. */
export const LAN: ChannelProfile = {
  name: 'lan',
  delaySteps: 0,
  jitterSteps: 0,
  lossPerMille: 0,
};

/**
 * Туннель: круг заметно больше `inputDelay` тиков — ровно тот канал, на котором
 * константная разметка теряет управление.
 */
export const TUNNEL: ChannelProfile = {
  name: 'tunnel',
  delaySteps: 4,
  jitterSteps: 0,
  lossPerMille: 0,
};

/** Тот же туннель, но с разбросом: запас обязан не дёргаться на джиттере. */
export const TUNNEL_JITTER: ChannelProfile = {
  name: 'tunnel-jitter',
  delaySteps: 4,
  jitterSteps: 1,
  lossPerMille: 0,
};

/** Канал с потерями — для проверки самого эмулятора, а не матча. */
export const LOSSY: ChannelProfile = {
  name: 'lossy',
  delaySteps: 1,
  jitterSteps: 3,
  lossPerMille: 120,
};

/**
 * Рвущийся downlink при живом uplink: снапшоты теряются, ввод доезжает.
 * Несимметричная поломка — не редкость и по счётчикам (NTR-11) выглядит иначе
 * симметричной, поэтому она и выражается профилем на направление.
 */
export const DOWNLINK_LOSS: ChannelProfile = {
  name: 'downlink-loss',
  delaySteps: 1,
  jitterSteps: 0,
  lossPerMille: 400,
};

/**
 * Оборванный downlink: снапшоты не доезжают ВОВСЕ, ввод доезжает. Крайний случай
 * прореженного, и проверяет он другое: прореженный downlink подтверждения всё
 * же приносит, а оборванный не приносит ни одного — то есть выглядит ровно как
 * канал длиннее запаса, лечить который запасом и надо (design D1).
 */
export const DOWNLINK_DEAD: ChannelProfile = {
  name: 'downlink-dead',
  delaySteps: 1,
  jitterSteps: 0,
  lossPerMille: 1000,
};

/** Игрок, идущий вправо каждый тик: отправка живая, а значит сигнал есть. */
export const WALK: InputSource = () => ({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 });

/**
 * Конфиг матча тестов канала. Темп МЕЛКИЙ намеренно (`tickRate` 20): окна
 * контроллера запаса выведены из темпа матча, а не зашиты числами, и мелкий
 * темп делает их короткими — прогон остаётся быстрым, не переставая быть
 * настоящим. `inputWindow` 30 — вдвое уже, чем у документа демо-арены (60), и
 * это намеренно: потолок адаптации в полкруга держит прогоны короткими, а сами
 * границы контроллер выводит из темпа, не из числа.
 */
export function channelConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return duelConfig({
    tickRate: 20,
    snapshotRate: 10,
    inputDelay: 2,
    inputWindow: 30,
    // Порог молчания поднят НАМЕРЕННО и только здесь: эти проверки про темп
    // адаптации, а не про выживание слота, и лишний конец матча посреди прогона
    // сделал бы их про другое. Что запас успевает вырасти ДО штатного порога
    // (NTR-6) — отдельное утверждение, и проверяется оно отдельным тестом, на
    // штатном пороге: скрытая подмена сделала бы этот вопрос непроверенным.
    silenceTicks: 100_000,
    ...overrides,
  });
}

/**
 * Канал игрока: один профиль на оба направления либо по профилю на каждое.
 *
 * Пара нужна там, где предмет проверки — несимметричная поломка: «рвётся
 * downlink, uplink жив» лечится не тем же, чем длинная дорога, и запас разметки
 * от потери снапшотов двигаться не обязан (design D1).
 */
type ChannelLink = ChannelProfile | { readonly up: ChannelProfile; readonly down: ChannelProfile };

export interface ChannelMatchOptions {
  readonly config: MatchConfig;
  /** По каналу на игрока: у каждого клиента свой канал до одного сервера. */
  readonly profiles: readonly ChannelLink[];
  /** Источник ввода клиента по его номеру; `undefined` — клиент молчит. */
  readonly input?: (index: number) => InputSource | undefined;
  /**
   * Настройки сборки хоста матча — сюда попадает порог обратного давления
   * рассылки (`maxQueuedSnapshots`, NTR-22). Часы хостом берутся из общего
   * `clock` эмулятора и подмене отсюда не подлежат.
   */
  readonly host?: Omit<MatchHostOptions, 'now'>;
  /**
   * Часы клиента быстрее серверных: раз в столько шагов клиент делает ЛИШНИЙ
   * шаг. `undefined` — часы идут в ногу.
   *
   * Ручка эмулятора, а не канала: собственный таймер клиента и цикл тиков
   * сервера — разные часы, и расхождение между ними обязано быть неотличимо от
   * исправного канала для контроллера запаса (NTR-7). Проверить это иначе
   * нечем: без ручки харнесс двигает стороны строго в ногу — единственный
   * режим, в котором разъехавшихся часов не бывает.
   */
  readonly extraStepEvery?: (index: number) => number | undefined;
  /**
   * Часы клиента МЕДЛЕННЕЕ серверных: раз в столько шагов клиент шага не делает
   * вовсе. `undefined` — часы идут в ногу.
   *
   * Зеркало `extraStepEvery`, и заведено отдельно, потому что стороны у
   * расхождения разные. Убежавший вперёд клиент упирается в потолок
   * `resyncTick`, и его номера тиков лишь повторяются — дыр в разметке не
   * возникает. Отставший подтягивается через `max()`, то есть ПЕРЕШАГИВАЕТ
   * номер: тик остаётся без кадра, сервер живёт его на повторе, и наблюдение
   * обязано отличить эту дыру от короткого запаса (NTR-7). Оба таймера в
   * продакшене — голый `setInterval` без догона, и медленной стороной клиент
   * бывает примерно так же часто, как быстрой.
   */
  readonly slowStepEvery?: (index: number) => number | undefined;
}

export interface ChannelMatch {
  readonly server: MatchServer;
  readonly host: MatchHost;
  readonly clients: readonly ConnectedClient[];
  /** Канал ОТ клиента по игрокам; у симметричного канала он же и обратный. */
  readonly channels: readonly VirtualChannel[];
  /** Канал К клиенту по игрокам: у симметричного — тот же объект, что в `channels`. */
  readonly downlinks: readonly VirtualChannel[];
  readonly clock: Clock;
  /** Один шаг общего расписания: каналы, клиенты, сервер. */
  step(): void;
  run(steps: number): void;
}

/**
 * Матч на эмулированных каналах: сервер один, канал у каждого клиента свой.
 *
 * Раздельные каналы нужны потому, что баг туннеля наблюдается У ВТОРОГО ИГРОКА:
 * один сидит рядом с сервером, другой — за длинной дорогой, и разница между
 * ними и есть предмет проверки.
 */
export function channelMatch(options: ChannelMatchOptions): ChannelMatch {
  const { config, profiles } = options;
  // У симметричного канала оба направления — ОДИН объект: поток случайности и
  // профиль у них общие, и подмена профиля на живом канале меняет обе стороны,
  // как и было. Пара заводится только там, где её попросили явно.
  const channels = profiles.map((link) =>
    'up' in link ? new VirtualChannel(link.up) : new VirtualChannel(link),
  );
  const downlinks = profiles.map((link, index) =>
    'up' in link ? new VirtualChannel(link.down) : channels[index]!,
  );
  const hubs = channels.map((channel, index) => {
    const down = downlinks[index]!;
    return new LoopbackHub({
      schedule: (deliver, bytes) => { channel.schedule(deliver, bytes); },
      scheduleBack: (deliver, bytes) => { down.schedule(deliver, bytes); },
      // Задолженность направления — та самая очередь канала (NTR-22): её и
      // читает хост, решая, пропускать ли снапшот этому соединению.
      backlog: () => channel.backlog,
      backlogBack: () => down.backlog,
    });
  });
  const clock: Clock = { ms: 0 };
  const server = new MatchServer(config);
  // Хост поднимается ДО клиентов: `LoopbackHub.connect` отдаёт серверный конец
  // подписчику сразу, и подписчиком обязан быть уже собранный хост.
  const host = new MatchHost(server, mergeTransportServers(...hubs), {
    ...options.host,
    now: () => clock.ms,
  });
  const clients = config.players.map((playerId, index) => {
    const input = options.input?.(index);
    return connectClient(hubs[index]!, playerId, clock, config.scene, {
      ...(input === undefined ? {} : { input }),
    });
  });

  const stepMs = 1000 / (config.tickRate ?? 60);
  let steps = 0;
  const step = (): void => {
    clock.ms += stepMs;
    steps++;
    // Сначала доставка того, что доехало к этому шагу, потом — работа сторон:
    // так шаг читается как «канал донёс — стороны увидели и ответили».
    for (const [index, channel] of channels.entries()) {
      channel.step();
      const down = downlinks[index]!;
      // Симметричный канал — один объект на оба направления: второй шаг двигал
      // бы его время вдвое быстрее матча.
      if (down !== channel) down.step();
    }
    for (const [index, client] of clients.entries()) {
      // Пропущенный шаг отставших часов клиента: сервер свой тик всё равно
      // исполнит, а клиент этот номер перешагнёт на ближайшей пересинхронизации.
      const slow = options.slowStepEvery?.(index);
      if (slow !== undefined && steps % slow === 0) continue;
      client.host.step();
      // Лишний шаг убежавших вперёд часов клиента — ПОСЛЕ обычного, чтобы шаг
      // расписания оставался одним шагом сервера.
      const every = options.extraStepEvery?.(index);
      if (every !== undefined && steps % every === 0) client.host.step();
    }
    host.step();
  };

  return {
    server,
    host,
    clients,
    channels,
    downlinks,
    clock,
    step,
    run(steps: number): void {
      for (let i = 0; i < steps; i++) step();
    },
  };
}
