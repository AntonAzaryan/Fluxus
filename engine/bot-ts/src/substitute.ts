/**
 * Бот — заместитель отвалившегося игрока (BOT-14): слот, оставшийся после
 * `Start` без живого соединения, сборка-основатель вправе временно отдать боту.
 *
 * Здесь живёт ровно одна политика, и принадлежит она СБОРКЕ — той стороне,
 * которая ботом владеет: сажать заместителя или не сажать («бот» против
 * «ничего»), и через сколько после разрыва. Сервер матча об этом не знает и
 * знать не может (BOT-1): он даёт механизм аренды слота (`netcode-transport`
 * NTR-18) и ботов от людей не отличает.
 *
 * Чего здесь нет и быть не может, ровно как в `fill.ts`: ни одного сообщения,
 * ни одного поля протокола, ни одного обращения к серверу матча. Наблюдение
 * идёт СНАРУЖИ — «есть ли у слота живое соединение» (`MatchServer.slotAttached`)
 * и «идёт ли матч», — а посадку делает сборочный `attach`, создающий обычное
 * бот-место (`BotSeat`) с ролью заместителя и обычным транспортом (NTR-2).
 *
 * Вернувшийся владелец забирает слот вытеснением, и это механизм СЕРВЕРА
 * (NTR-18): бот отпускает канал штатным отказом, а заместителя на занятый слот
 * политика не пере-подключает — слот с живым соединением ей неотличим от слота
 * с владельцем, и это единственное, что ей нужно знать.
 *
 * Отвалился владелец снова — политика решает заново.
 *
 * Матч, покинутый ВСЕМИ, заместителями не оживляется (`abandoned`): слот с
 * живым соединением молчания не копит (NTR-6), и матч, доигрываемый одними
 * ботами, не кончился бы вовсе — сборка-основатель осталась бы занята им
 * навсегда. То же условие и по той же причине держит заполнитель слотов
 * (BOT-7).
 */
import type { FillSchedule } from './fill.js';

export interface BotSubstitutesOptions {
  /**
   * Ростер матча в порядке конфига (`MatchConfig.players`): слот — это индекс в
   * списке (`tick-loop` TICK-5), и заместитель предъявляет то же имя игрока,
   * что предъявлял бы владелец (NTR-17, NTR-18).
   */
  readonly players: readonly string[];
  /**
   * Есть ли у слота живое соединение. Наблюдение сборки-основателя за
   * собственным матчем — та же величина, которой пользуется заполнитель слотов
   * (BOT-7): публичное состояние сервера, а не знание о типе участника.
   */
  readonly attached: (slot: number) => boolean;
  /**
   * Идёт ли матч. До `Start` заместителей не бывает вовсе (NTR-18): пустой слот
   * до старта — забота бота-заполнителя (BOT-7).
   */
  readonly running: () => boolean;
  /**
   * Матч ПОКИНУТ: играть уже не с кем, и сажать заместителя незачем.
   *
   * То же условие, по которому заполнитель отказывается сажать ботов в пустой
   * матч (BOT-7, `fill.ts`: «а при двух слотах — начать бой ботов между собой и
   * занять стенд»), и по той же причине. Без него политика «бот» лишает матч
   * ЕДИНСТВЕННОГО способа закончиться: слот с живым соединением молчания не
   * копит (NTR-6), и матч, из которого ушли все люди, шёл бы ботами до
   * остановки процесса — сборка-основатель не подняла бы следующий.
   *
   * Отсутствие — «никогда не покинут»: величина принадлежит сборке, которая
   * одна и знает, кто ещё на связи (BOT-14), а механизму знать это неоткуда.
   */
  readonly abandoned?: () => boolean;
  /**
   * Посадить заместителя за названного игрока: создать место, канал и запустить
   * его. Делает это сборка, потому что транспорт — её выбор (NTR-2).
   */
  readonly attach: (playerId: string) => void;
  /**
   * Пауза между наблюдением разрыва и посадкой бота. Не ноль по умолчанию:
   * сетевой всплеск на секунду не должен дёргать бота, а разрыв и короткая
   * потеря связи в момент разрыва неотличимы (NTR-6).
   */
  readonly delayMs?: number;
  readonly schedule?: FillSchedule;
  readonly cancel?: (handle: unknown) => void;
}

/**
 * Состояние слота глазами политики:
 *
 * - `idle` — у слота есть живое соединение либо разрыв ещё не замечен;
 * - `pending` — разрыв замечен, идёт пауза до посадки;
 * - `seating` — бот предложен слоту, и политика ждёт исхода посадки.
 *
 * Из `seating` политика выходит, только увидев у слота живое соединение. Это и
 * есть защита от второй посадки в окно, пока бот едет к серверу; ценой того,
 * что бот, не доехавший вовсе (упавший поток, разошедшийся формат кадра),
 * второй попытки не получает — деградация к политике «ничего», а не поток
 * подключений в никуда.
 */
type SlotState = 'idle' | 'pending' | 'seating';

const DEFAULT_DELAY_MS = 2000;

const defaultSchedule: FillSchedule = (run, delayMs) => setTimeout(run, delayMs);

const defaultCancel = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export class BotSubstitutes {
  private readonly options: BotSubstitutesOptions;
  private readonly states: SlotState[];
  private readonly handles: unknown[];
  private disposed = false;

  constructor(options: BotSubstitutesOptions) {
    this.options = options;
    this.states = options.players.map(() => 'idle');
    this.handles = options.players.map(() => undefined);
  }

  get delayMs(): number {
    return this.options.delayMs ?? DEFAULT_DELAY_MS;
  }

  /** Состояние слота — наблюдательный доступ для отчёта стенда и тестов. */
  stateOf(slot: number): 'idle' | 'pending' | 'seating' {
    return this.states[slot] ?? 'idle';
  }

  /**
   * Один взгляд на матч: слоты без живого соединения взводят паузу, слоты с
   * соединением её отменяют.
   *
   * Опросом, а не подпиской, потому что подписываться не на что: сервер о
   * разрывах наружу не сообщает и не должен (BOT-1, NTR-3), а частота взгляда —
   * дело того, кто держит расписание.
   */
  poll(): void {
    if (this.disposed) return;
    if (!this.options.running() || this.options.abandoned?.() === true) {
      // Матч не идёт: до `Start` заместителей не бывает (NTR-18), после конца
      // сажать некуда. Матч покинут: заместитель некому и не для кого — пусть
      // кончается порогом молчания (NTR-6), освобождая сборку под следующий.
      // Неистёкшие паузы отменяются в обоих случаях — иначе бот приехал бы в
      // матч, которого уже нет или который никому не нужен.
      for (let slot = 0; slot < this.states.length; slot++) this.reset(slot);
      return;
    }
    for (let slot = 0; slot < this.states.length; slot++) {
      if (this.options.attached(slot)) {
        // Слот занят живым соединением — владельцем ли, заместителем ли:
        // различать их политике нечем и незачем (NTR-18).
        this.reset(slot);
        continue;
      }
      if (this.states[slot] !== 'idle') continue;
      this.states[slot] = 'pending';
      this.handles[slot] = (this.options.schedule ?? defaultSchedule)(() => {
        this.handles[slot] = undefined;
        this.seat(slot);
      }, this.delayMs);
    }
  }

  /** Снять неистёкшие паузы. Посаженные места не трогает: ими владеет `BotHost`. */
  dispose(): void {
    this.disposed = true;
    for (let slot = 0; slot < this.states.length; slot++) this.reset(slot);
  }

  /**
   * Пауза истекла. Условия перепроверяются: за неё владелец мог вернуться
   * (NTR-17), а матч — кончиться порогом молчания (NTR-6).
   */
  private seat(slot: number): void {
    if (this.disposed || this.states[slot] !== 'pending') return;
    if (!this.options.running() || this.options.attached(slot)) {
      this.states[slot] = 'idle';
      return;
    }
    // За паузу мог уйти последний человек: сажать заместителя в покинутый матч
    // значит занять сборку боями ботов (BOT-7, BOT-14).
    if (this.options.abandoned?.() === true) {
      this.states[slot] = 'idle';
      return;
    }
    this.states[slot] = 'seating';
    this.options.attach(this.options.players[slot]!);
  }

  private reset(slot: number): void {
    const handle = this.handles[slot];
    if (handle !== undefined) {
      (this.options.cancel ?? defaultCancel)(handle);
      this.handles[slot] = undefined;
    }
    this.states[slot] = 'idle';
  }
}
