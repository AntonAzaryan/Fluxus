/**
 * Control-адаптер стенда демо-арены (решение D2 change'а `add-server-manager`):
 * периодический отчёт в stdout JSON-линиями и приём команд из stdin.
 *
 * Живёт он в СБОРКЕ ИГРЫ, а не в сервере матча, по той же причине, по которой
 * здесь живут политика разрыва (`detachPause.ts`) и слушающая сторона
 * (`standSession.ts`): сервер матча — чистый тик без ввода-вывода (NTR-3), а
 * stdio, расписание отчёта и `perf_hooks` — это обвязка. Админ-операции идут
 * ЧЕРЕЗ СУЩЕСТВУЮЩИЕ механизмы сервера (`server-control` SRV-5): отвязка
 * соединения, запирание слота (NTR-19), пауза матча (NTR-20) — и ни одного
 * нового сообщения в игровом протоколе (NTR-4) для них не заводится.
 *
 * Словарь линий приезжает из пакета агента (`@fluxus/server-agent/stand`): это
 * ЕГО контракт с любым стендом, и вторая копия словаря здесь была бы способом
 * им разойтись. Направление зависимости — «стенд знает словарь агента», а не
 * наоборот: агент стенд не импортирует, он его СПАВНИТ (решение D1).
 *
 * Управляющие линии маркированы (`CONTROL_LINE_PREFIX`), потому что stdout
 * стенда — это ещё и его отчёт человеку: смешать их без маркировки значило бы
 * отдать агенту поток, который он разбирает наполовину.
 */
import {
  decodeStandCommand,
  encodeStandLine,
  type StandCommand,
  type StandLine,
  type StandMetricsReport,
  type StandPhase,
  type StandSlotReport,
} from '@fluxus/server-agent/stand';

/** Статус игрока (SRV-4) — производная состояний аренды слота. */
export type SlotStatus =
  | 'connecting'
  | 'active'
  | 'disconnected'
  | 'removed'
  | 'left'
  | 'rejected';

/** Аренда слота глазами адаптера — ровно то, что отдаёт `MatchServer.slotLease`. */
export interface AdapterLease {
  readonly claimed: boolean;
  readonly attached: boolean;
  readonly role: 'owner' | 'substitute' | undefined;
  readonly barred: boolean;
  readonly lastEnd: string | undefined;
  readonly lastReject: string | undefined;
}

/**
 * Статус игрока из аренды слота и фазы матча (SRV-4).
 *
 * Порядок ветвей — от самого сильного факта к самому слабому, и он значим.
 * Запертый слот показывается `removed` при любом положении дел: это админ-запрет
 * (NTR-19), и он важнее того, кто сейчас за слотом говорит. Дальше идёт живая
 * аренда, потом — чем кончилась прошлая: «ушёл сам» и «оборвалось» суть разные
 * слова для админа, и различает их сервер.
 *
 * Слот, за которым никого не было и нет, — `connecting`: матч ждёт входа. Это не
 * «нет игрока»: перечень слотов есть ростер (NTR-6), и слот из него не исчезает.
 */
export function slotStatusOf(lease: AdapterLease, phase: StandPhase): SlotStatus {
  if (lease.barred) return 'removed';
  if (lease.attached) return phase === 'running' ? 'active' : 'connecting';
  if (lease.lastEnd === 'bye') return 'left';
  if (lease.lastEnd === 'barred') return 'removed';
  if (lease.claimed) return 'disconnected';
  if (lease.lastReject !== undefined) return 'rejected';
  return 'connecting';
}

/** Круг соединения слота либо названное его отсутствие (NTR-11). */
export interface AdapterRtt {
  readonly kind: string;
  readonly ms?: number;
}

/**
 * Взгляд адаптера на ОДИН матч. Матч у стенда сменяется авто-рестартом (design
 * D3 стенда), поэтому адаптер живёт дольше матча и получает новый взгляд на
 * каждый круг.
 *
 * Операции возвращают ПУСТУЮ строку при исполнении и названную причину при
 * отказе — та же договорённость, что у серверного API паузы (NTR-20).
 */
export interface StandMatchView {
  readonly players: readonly string[];
  readonly round: number;
  phase(): StandPhase;
  tick(): number;
  pause(): 'running' | 'frozen' | 'resuming';
  lease(slot: number): AdapterLease;
  counters(slot: number): { readonly applied: number; readonly predicted: number; readonly late: number };
  /** Наблюдаемые соединения слота; `undefined` — живого соединения нет. */
  wire(slot: number): { readonly snapshotBytes: number; readonly rtt: AdapterRtt; readonly responseMs: number | undefined } | undefined;
  /** Счётчики матча и хоста (NTR-11); зовётся ТОЛЬКО при подписке (решение D9). */
  metrics(): Omit<StandMetricsReport, 'eventLoopDelayMs' | 'rssBytes'>;
  disconnect(slot: number): string;
  bar(slot: number): string;
  unbar(slot: number): string;
  freeze(): string;
  unfreeze(): string;
  stop(): string;
}

export interface StandControlOptions {
  /** Куда писать управляющие линии: stdout процесса стенда. */
  readonly write: (text: string) => void;
  /** Метрики самого процесса (решение D9): задержка цикла событий и RSS. */
  readonly process: () => { readonly eventLoopDelayMs: number; readonly rssBytes: number };
}

export interface StandControl {
  /** Матч этого круга: адаптер живёт дольше матча (авто-рестарт стенда). */
  attach(view: StandMatchView): void;
  /** Матч свернулся: отчитываться больше не о чем до следующего `attach`. */
  detach(): void;
  /** Одна линия из stdin. Незнакомая — молча игнорируется: это не наш канал. */
  handle(raw: string): void;
  /** Собрать и отправить отчёт. Зовёт расписание стенда — часов у адаптера нет. */
  report(): void;
  /** Стенд поднялся и слушает: адрес игрового эндпоинта известен только ему. */
  ready(line: Omit<Extract<StandLine, { t: 'ready' }>, 't'>): void;
  /** Подписан ли кто-нибудь на детали (решение D9). */
  readonly subscribed: boolean;
}

/**
 * Адаптер одного процесса стенда. Часов внутри нет: `report()` зовёт расписание
 * стенда, как `advance()` зовёт драйвер матча, — и по той же причине (NTR-12).
 */
export function standControl(options: StandControlOptions): StandControl {
  let view: StandMatchView | undefined;
  let subscribed = false;

  const send = (line: StandLine): void => { options.write(encodeStandLine(line)); };

  const result = (id: number, reason: string): void => {
    send({ t: 'result', id, ok: reason === '', reason });
  };

  /** Слот в отчёте: аренда, счётчики и наблюдаемые соединения (SRV-4). */
  const slotReport = (current: StandMatchView, slot: number): StandSlotReport => {
    const lease = current.lease(slot);
    const counters = current.counters(slot);
    const wire = current.wire(slot);
    return {
      slot,
      playerId: current.players[slot] ?? '',
      status: slotStatusOf(lease, current.phase()),
      role: lease.role ?? null,
      // Соединения нет — круга нет, и это названо явно, а не нулём (NTR-11).
      rtt: wire?.rtt ?? { kind: 'unsupported' },
      // СЕРВЕРНАЯ половина отклика (NTR-11): полное «нажал → увидел» — величина
      // клиента и в админ-канал не едет. Читается у `ConnectionMetrics.responseMs`
      // хоста, где так и названа, и уезжает под своим честным именем.
      serverResponseMs: wire?.responseMs ?? null,
      applied: counters.applied,
      predicted: counters.predicted,
      late: counters.late,
      snapshotBytes: wire?.snapshotBytes ?? 0,
    };
  };

  /**
   * Операция над слотом (SRV-5). Слот вне ростера — названный отказ, а не
   * исключение наружу: команда пришла с провода, и упавший на ней стенд был бы
   * куда худшим исходом, чем отказ.
   */
  const onSlot = (current: StandMatchView, command: StandCommand, apply: (slot: number) => string): string => {
    if (command.slot < 0 || command.slot >= current.players.length) {
      return `слот ${command.slot} вне ростера из ${current.players.length}`;
    }
    return apply(command.slot);
  };

  const apply = (command: StandCommand): string => {
    // Подписка живёт в адаптере, а не в матче: она про то, собирать ли отчёт
    // метрик (решение D9), и матч о ней не знает.
    if (command.cmd === 'subscribe') {
      subscribed = true;
      return '';
    }
    if (command.cmd === 'unsubscribe') {
      subscribed = false;
      return '';
    }
    const current = view;
    if (current === undefined) return 'матча нет: стенд между матчами';
    switch (command.cmd) {
      case 'disconnect-player':
        return onSlot(current, command, (slot) => current.disconnect(slot));
      case 'bar-slot':
        return onSlot(current, command, (slot) => current.bar(slot));
      case 'unbar-slot':
        return onSlot(current, command, (slot) => current.unbar(slot));
      case 'pause':
        return current.freeze();
      case 'resume':
        return current.unfreeze();
      case 'stop':
        return current.stop();
    }
  };

  return {
    get subscribed(): boolean {
      return subscribed;
    },
    attach(next) {
      view = next;
    },
    detach() {
      view = undefined;
    },
    handle(raw) {
      const command = decodeStandCommand(raw.trim());
      // Незнакомая строка молча пропускается: stdin стенда — не только канал
      // агента, и отвечать отказом на чужую строку значило бы придумывать
      // отправителя.
      if (command === undefined) return;
      result(command.id, apply(command));
    },
    report() {
      const current = view;
      if (current === undefined) return;
      const phase = current.phase();
      send({
        t: 'report',
        phase,
        tick: current.tick(),
        round: current.round,
        pause: current.pause(),
        slots: current.players.map((_, slot) => slotReport(current, slot)),
        // Метрики собираются ТОЛЬКО при подписке (решение D9, риск p99):
        // перцентиль считается по кольцу, и без читателя эта работа не делается.
        metrics: subscribed ? { ...current.metrics(), ...options.process() } : null,
      });
    },
    ready(line) {
      send({ t: 'ready', ...line });
    },
  };
}
