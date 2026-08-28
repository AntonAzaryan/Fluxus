/**
 * Бот — заполнитель слота ростера (BOT-7): слот, который к заморозке ростера
 * (`net-session` SES-4) не занял человек, сборка-основатель отдаёт боту.
 *
 * Здесь живёт ровно одна политика, и принадлежит она СБОРКЕ: боты подключаются
 * к незанятым слотам только в момент заморозки, а не заранее (design D2).
 * Отсюда следует всё остальное. Человек, пришедший до дедлайна, занимает слот
 * штатным `Hello` — отзывать нечего, потому что бота в слоте ещё нет, и серверу
 * нечего различать (BOT-1): он видит обычные подключения фазы сбора ростера.
 *
 * Альтернатива «бот садится сразу, на `Hello` человека сборка его отзывает»
 * отвергнута дизайном: сигнала «человек хочет слот» у сборки нет — сервер
 * отвергает `Hello` в занятый слот, не уведомляя владельца бота, — и завести
 * такой сигнал значило бы поставить ветвление по типу участника рядом с
 * сервером.
 *
 * Чего здесь нет и быть не может: ни одного сообщения, ни одного поля протокола,
 * ни одного обращения к серверу матча. Заполнитель умеет две вещи — считать
 * время до дедлайна и позвать сборочный `attach`, который создаёт обычное
 * бот-место (`BotSeat`) с обычным транспортом (`netcode-transport` NTR-2).
 *
 * После заморозки РОСТЕР не меняется (NTR-6): бот, вошедший в матч, — владелец
 * своего слота, доигрывает его и вытеснению (`netcode-transport` NTR-18) не
 * подлежит, а человек, пришедший позже за этим слотом, получает штатный
 * `slot-taken`. Замены участника посреди матча этот механизм не вводит и
 * вводить не должен: временный заместитель отвалившегося владельца — другая
 * политика и другой файл (BOT-14, `substitute.ts`).
 */

/** Планировщик дедлайна: подменяется тестом и прогоном, который двигает время сам. */
export type FillSchedule = (run: () => void, delayMs: number) => unknown;

/**
 * Умолчания планировщика — обычные таймеры хоста. Живут рядом с типом и
 * переиспользуются заместителем (`substitute.ts`): у двух политик ботов
 * планировщик один, и разъехаться этим умолчаниям нечем.
 */
export const defaultSchedule: FillSchedule = (run, delayMs) => setTimeout(run, delayMs);

export const defaultCancel = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

/**
 * Посаженное место глазами заполнителя — структурный минимум `BotSeat`.
 *
 * Минимум, а не сам `BotSeat`, потому что хост ботов живёт вне потока сервера
 * (BOT-4): у сборки, отдавшей ботов воркеру, объектов мест на этой стороне нет
 * вовсе, и `attach` вправе вернуть пустой список — заполнитель от этого не
 * ломается, он просто не наблюдает исход посадки. Там, где хост в том же
 * процессе (автотест, браузерный sim-воркер), места видны, и `prune()` убирает
 * те, которым сервер отказал.
 */
export interface BotFillSeat {
  readonly playerId: string;
  /** Клиент места: отказ сервера читается отсюда и ниоткуда больше. */
  readonly client: { readonly closeReason: string | undefined };
  dispose(): void;
}

export interface BotSlotFillerOptions {
  /**
   * Ростер матча в порядке конфига (`MatchConfig.players`): слот — это индекс в
   * списке (`tick-loop` TICK-5), и заполнитель адресуется теми же именами, что
   * предъявляет в `Hello` человек.
   */
  readonly players: readonly string[];
  /**
   * Посадить ботов в перечисленные слоты: создать места, каналы и запустить их.
   * Делает это сборка, потому что транспорт — её выбор (NTR-2): loopback в
   * автотесте, пара портов к воркеру в браузере и на выделенном сервере.
   *
   * Одним вызовом на все слоты, а не по вызову на слот: хост ботов вправе быть
   * один на несколько мест (BOT-4), и init-сообщение воркеру тоже одно. Что
   * вернётся — те места, которые сборке ВИДНЫ (см. `BotFillSeat`); пустой
   * список законен и означает «боты уехали в другой поток».
   */
  readonly attach: (playerIds: readonly string[]) => readonly BotFillSeat[];
  /**
   * Слоты, которые основатель держит за СВОИМИ людьми — теми, кого он хостит
   * сам и о которых знает без сервера (браузерная сборка знает, что p1 — это
   * оболочка вкладки). Резерв не запрещает слот, а избавляет от заведомо
   * отвергаемого подключения.
   */
  readonly reserved?: readonly string[];
  /**
   * Пауза до заморозки ростера в миллисекундах, считая от `arm()`. Ноль —
   * «второго человека не ждём» (браузерный дефолт, design D2); выделенный
   * сервер даёт настоящую паузу после первого пришедшего.
   */
  readonly deadlineMs?: number;
  /**
   * Наблюдение основателя за собственным матчем: ростер уже заморожен —
   * заполнять нечего. Величина сборки, а не сервера: сервер о заполнителе не
   * знает (BOT-1), а основатель свой `MatchServer` держит в руках и его
   * публичную фазу читает.
   */
  readonly frozen?: () => boolean;
  readonly schedule?: FillSchedule;
  readonly cancel?: (handle: unknown) => void;
}

export class BotSlotFiller {
  private readonly options: BotSlotFillerOptions;
  private readonly reserved: ReadonlySet<string>;
  private readonly attached: BotFillSeat[] = [];

  private handle: unknown;
  private armed = false;
  private done = false;

  constructor(options: BotSlotFillerOptions) {
    for (const playerId of options.reserved ?? []) {
      if (!options.players.includes(playerId)) {
        throw new Error(`BotSlotFiller: резерв "${playerId}" не входит в ростер матча`);
      }
    }
    this.options = options;
    this.reserved = new Set(options.reserved ?? []);
  }

  /** Места, посаженные заполнителем. До дедлайна список пуст — в этом всё (BOT-7). */
  get seats(): readonly BotFillSeat[] {
    return this.attached;
  }

  /** Дедлайн уже прошёл: состав, который держит эта сборка, окончателен. */
  get filled(): boolean {
    return this.done;
  }

  get deadlineMs(): number {
    return this.options.deadlineMs ?? 0;
  }

  /**
   * Запустить отсчёт до заморозки. Идемпотентен: второй пришедший человек
   * дедлайн не продлевает — иначе поток заходящих откладывал бы старт матча
   * бесконечно.
   */
  arm(): void {
    if (this.armed || this.done) return;
    this.armed = true;
    const schedule = this.options.schedule ?? defaultSchedule;
    this.handle = schedule(() => {
      this.handle = undefined;
      this.fill();
    }, this.deadlineMs);
  }

  /**
   * Заморозка: боты садятся в слоты, которых не занял человек. Однократна —
   * повторный вызов отдаёт уже посаженных, а не сажает вторых.
   */
  fill(): readonly BotFillSeat[] {
    if (this.done) return this.attached;
    this.done = true;
    this.clearTimer();
    // Ростер успели занять люди — заполнять нечего, и это первый сценарий
    // BOT-7: бот в такой матч не входит вовсе, а сервер уступки не видел.
    if (this.options.frozen?.() === true) return this.attached;
    const free = this.options.players.filter((playerId) => !this.reserved.has(playerId));
    if (free.length === 0) return this.attached;
    this.attached.push(...this.options.attach(free));
    return this.attached;
  }

  /**
   * Убрать места, которых сервер не принял: слот успел занять человек, чей
   * `Hello` разминулся с дедлайном (гонка, названная в Risks дизайна), либо
   * матч уже кончился. Отказ штатный (`slot-taken`, `match-ended`), и ответ на
   * него — отпустить канал, а не повторять попытку: ростер заморожен (NTR-6).
   */
  prune(): number {
    let removed = 0;
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const seat = this.attached[i];
      if (seat?.client.closeReason !== 'rejected') continue;
      seat.dispose();
      this.attached.splice(i, 1);
      removed++;
    }
    return removed;
  }

  /**
   * Отменить неистёкший дедлайн. Посаженные места не трогает: ими владеет
   * `BotHost`, и закрывать их дважды — его забота, а не заполнителя.
   */
  dispose(): void {
    this.done = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.handle === undefined) return;
    (this.options.cancel ?? defaultCancel)(this.handle);
    this.handle = undefined;
  }
}
