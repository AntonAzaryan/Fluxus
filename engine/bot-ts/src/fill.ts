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
 * После заморозки состав не меняется (NTR-6): бот, вошедший в матч, доигрывает
 * его, а человек, пришедший позже, получает штатный отказ сервера — этим
 * механизм замены посреди матча не вводится и вводить его не должен.
 */
import type { BotSeat } from './host.js';

/** Планировщик дедлайна: подменяется тестом и прогоном, который двигает время сам. */
export type FillSchedule = (run: () => void, delayMs: number) => unknown;

export interface BotSlotFillerOptions {
  /**
   * Ростер матча в порядке конфига (`MatchConfig.players`): слот — это индекс в
   * списке (`tick-loop` TICK-5), и заполнитель адресуется теми же именами, что
   * предъявляет в `Hello` человек.
   */
  readonly players: readonly string[];
  /**
   * Посадить бота в слот: создать место, канал и запустить его. Делает это
   * сборка, потому что транспорт — её выбор (NTR-2): loopback в автотесте,
   * пара портов в браузере, сокет на выделенном сервере.
   */
  readonly attach: (playerId: string) => BotSeat;
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

const defaultSchedule: FillSchedule = (run, delayMs) => setTimeout(run, delayMs);

const defaultCancel = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export class BotSlotFiller {
  private readonly options: BotSlotFillerOptions;
  private readonly reserved: ReadonlySet<string>;
  private readonly attached: BotSeat[] = [];

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
  get seats(): readonly BotSeat[] {
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
  fill(): readonly BotSeat[] {
    if (this.done) return this.attached;
    this.done = true;
    this.clearTimer();
    // Ростер успели занять люди — заполнять нечего, и это первый сценарий
    // BOT-7: бот в такой матч не входит вовсе, а сервер уступки не видел.
    if (this.options.frozen?.() === true) return this.attached;
    for (const playerId of this.options.players) {
      if (this.reserved.has(playerId)) continue;
      this.attached.push(this.options.attach(playerId));
    }
    return this.attached;
  }

  /**
   * Убрать места, которых сервер не принял: слот успел занять человек, чей
   * `Hello` разминулся с дедлайном (гонка, названная в Risks дизайна), либо
   * матч уже шёл. Отказ штатный (`slot-taken`, `match-in-progress`), и ответ на
   * него — отпустить канал, а не повторять попытку: состав заморожен (NTR-6).
   */
  prune(): number {
    let removed = 0;
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const seat = this.attached[i]!;
      if (seat.client.closeReason !== 'rejected') continue;
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
