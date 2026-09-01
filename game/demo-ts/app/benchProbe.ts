/**
 * Probe стадий кадра демо (`performance-budget` PERF-2, PERF-7, design D4).
 *
 * Отвечает на один вопрос — «во что обошёлся кадр и из чего он сложился», — и
 * отвечает числами того же вида, в каком записан бюджет профиля устройства
 * (PERF-1): перцентили, а не среднее. Среднее прячет статтер, который игрок и
 * видит.
 *
 * Probe ВЫКЛЮЧЕН по умолчанию и включается строкой запроса (`?bench=1`).
 * Выключенный он стоит кадру ровно одного сравнения с `null` (см. `frame` в
 * `main.ts`): ни обращения к часам, ни записи в буфер — то же правило
 * инертности, что у счётчиков стоимости (PERF-3 «выключенный учёт бесплатен»).
 * Иначе замер мерил бы себя: `performance.now()` на каждом шве кадра — не
 * бесплатная операция, и оставлять её в обычном запуске нельзя.
 *
 * Аллокаций на кадр нет: кольцевые буферы заведены один раз при включении,
 * стадии кадра пишутся в заранее созданный `scratch`, и единственная аллокация
 * — сборка отчёта, которая случается один раз в конце прогона.
 *
 * Хвост распределения ЗА p99 отчёт называет отдельно (PERF-7): максимум каждой
 * серии и худшие кадры окна с раскладкой по стадиям (`BenchWorstFrame`). Один
 * кадр из тысячи не двигает ни p50, ни p99 — перцентили прячут разовый фриз по
 * построению, — а игрок видит именно его. Отбирается хвост в `report()`, из уже
 * хранимого кольца: покадровому пути от этого не прибавляется ни работы, ни
 * аллокаций.
 *
 * Каденс тика выведен ПАССИВНО, из уже доставленного: номер тика последней
 * доставки (`TickView.tick`) читается покадрово, и его приращения дают и число
 * доставленных тиков, и разрывы между доставками. Своих сообщений в канал
 * оболочки probe не добавляет — тикер живёт в воркере (SHELL-1), и спрашивать
 * его о темпе значило бы менять протокол ради замера.
 */

/**
 * Стадии кадра главного потока, по которым раскладывается бюджет (PERF-2).
 * Список — единственный: по нему probe заводит буферы, по нему же профиль
 * устройства называет свои бюджеты (`bench/profile.ts`).
 *
 * - `input` — прицельный raycast, сэмплер ввода, накладка тач-стиков;
 * - `camera` — конвейер позы камеры (CAM-1): rig, эффекты, посадка на THREE;
 * - `present` — `remote.frame(now)`: ПОКАДРОВОЕ обновление подсистем
 *   (интерполяция поз, отсечение, выбор уровня детализации, порции перестройки
 *   маски FoW и её рассеивание), плюс фигуры главного потока, которые садятся
 *   на позу этого же кадра;
 * - `draw` — проход рисования: пост-проход тумана либо прямой рендер.
 *
 * ## Что этими числами НЕ измерено
 *
 * Браузерный замер отбивает ровно то, что делает кадр главного потока, — эти
 * четыре стадии, — и пассивно выводит каденс доставки. Остального в них нет,
 * и читать их как «весь бюджет PERF-2» нельзя:
 *
 * - приём доставки (`syncTick`) в кадр не попадает вовсе: подсистемам его
 *   раздаёт `RemoteHost` НА ПРИХОД сообщения из воркера (SHELL-3), то есть
 *   между кадрами, а не внутри rAF-колбэка. Пересборка маски FoW с ним больше
 *   не едет: доставка только кладёт входы, а растр строят порции стадии
 *   `present` (change `fog-mask-budgeted-rebuild`);
 * - тик симуляции — тем более: он идёт в воркере своим тикером (SHELL-1), и
 *   главный поток о его стоимости не знает ничего;
 * - экстракция и канал доставки — там же, в воркере: плоскую форму собирает
 *   `Extractor`, а отправляет её кодек оболочки, и до главного потока эта
 *   работа доезжает уже сделанной.
 *
 * Все три величины атрибутируются детерминированными счётчиками стоимости и их
 * голден-гейтом (PERF-3, PERF-4): там стадии `tick`, `extract` и `syncTick`
 * разложены по системам и подсистемам, машинно-независимо и без браузера.
 * Здесь же о доставке говорит только её каденс — разрывы между номерами тика.
 */
export const BENCH_STAGES = ['input', 'camera', 'present', 'draw'] as const;

export type BenchStage = (typeof BENCH_STAGES)[number];

/** Имя ручки на `window`, по которому отчёт забирает браузерный бенч. */
export const BENCH_GLOBAL_KEY = '__benchProbe';

/** Версия формата отчёта: харнесс сверяет её, прежде чем читать поля. */
export const BENCH_PROBE_VERSION = 2;

/**
 * Худших кадров окна в отчёте (PERF-7). Наличие потолка — механизм, его
 * величина — политика: пять строк читаются целиком, а поменять их число значит
 * поправить константу, а не формат отчёта (то же правило, что у перечней дампа
 * отладки, `render-debug` RDBG-7).
 */
export const BENCH_WORST_FRAMES = 5;

/**
 * Ёмкость кольца в кадрах: ~136 с при 60 fps. Прогон бенча короче (порядка
 * 20 с), и вытеснение остаётся аварийным случаем — отчёт называет его числом
 * `dropped`, чтобы «замер длиной в буфер» не выглядел замером длиной в прогон.
 */
export const BENCH_CAPACITY = 8192;

/** Перцентили одной серии в миллисекундах. */
export interface BenchPercentiles {
  readonly samples: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

/** Каденс доставленных тиков, выведенный из номеров тика (см. шапку). */
export interface BenchTicks {
  /** Тиков доставлено за окно замера. */
  readonly delivered: number;
  /** Тиков в секунду — темп симуляции, каким его видит главный поток. */
  readonly perSecond: number;
  /** Разрывы между доставками: p99 здесь — это заикание тикера воркера. */
  readonly gapMs: BenchPercentiles;
}

/**
 * Один худший кадр окна — хвост распределения ЗА p99 (PERF-7).
 *
 * ## Что с чем спарено
 *
 * Отметка rAF кадра N — это КОНЕЦ периода, внутри которого работал кадр N−1:
 * своя работа кадра N начинается уже после его отметки. Поэтому строка сводит
 * период `at[N] − at[N−1]` с работой и стадиями кадра N−1 — единственной
 * работой главного потока, которая в этот период попала. Спари период с работой
 * ОДНОГО и того же кадра — и строка фриза показала бы гигантский период рядом с
 * дешёвым кадром, то есть ровно не назвала бы виновника.
 *
 * ## Почему отбор по периоду, а не по работе кадра
 *
 * Игрок видит период. Фриз, случившийся МЕЖДУ кадрами (приём доставки SHELL-3,
 * сборка мусора), в работу кадра не входит вовсе и в топ по ней не попал бы, а
 * период его несёт. Незакрытый остаток `intervalMs − frameMs` эту работу и
 * называет — печатает его харнесс отдельной колонкой «вне стадий». Остаток
 * бывает и отрицательным: отметка rAF — метка кадровой синхронизации, а не
 * момент запуска колбэка, и работа затянувшегося кадра честно переваливает за
 * свой номинальный период в следующий.
 */
export interface BenchWorstFrame {
  /**
   * Начало периода ОТ НАЧАЛА окна замера, мс — место кадра внутри окна, и
   * только оно. Ключом к записям трейса эта величина не является: своего трейса
   * бенч не пишет вовсе, а записи `npm run demo:debug` ключуются номером тика
   * (`tick` ниже), не часами главного потока.
   */
  readonly atMs: number;
  /** Период кадра по часам rAF, мс — то, что пережил игрок. */
  readonly intervalMs: number;
  /** Работа главного потока внутри этого периода, мс. */
  readonly frameMs: number;
  /** Та же работа по стадиям (PERF-2), мс. */
  readonly stagesMs: Readonly<Record<BenchStage, number>>;
  /** Номер последнего доставленного тика на этом кадре; < 0 — доставки не было. */
  readonly tick: number;
}

/** Отчёт probe за окно замера. */
export interface BenchSummary {
  readonly version: number;
  /** Длина окна по часам главного потока. */
  readonly seconds: number;
  readonly frames: number;
  /** Кадров в секунду за окно — та же величина, что видит игрок. */
  readonly fps: number;
  /** Кадров вытеснено кольцом: > 0 означает, что окно длиннее буфера. */
  readonly dropped: number;
  /** Время кадра целиком (CPU главного потока, от начала кадра до конца рисования). */
  readonly frameMs: BenchPercentiles;
  /** Период кадра по часам rAF — достигнутый темп, а не стоимость работы. */
  readonly intervalMs: BenchPercentiles;
  readonly stagesMs: Readonly<Record<BenchStage, BenchPercentiles>>;
  readonly ticks: BenchTicks;
  /**
   * Худшие кадры окна по периоду, от худшего к лучшему; не длиннее
   * `BENCH_WORST_FRAMES` (PERF-7). Перцентили хвост за p99 прячут по
   * построению: разовый фриз в сотни миллисекунд при зелёном p99 виден только
   * здесь и в `max` серий.
   */
  readonly worstFrames: readonly BenchWorstFrame[];
}

/**
 * Перцентиль по методу ближайшего ранга: ранг `ceil(p/100 · n)`, значение по
 * нему из отсортированной серии. Никакой интерполяции — p99 обязан быть
 * НАСТОЯЩИМ кадром из замера, а не средним между двумя соседями: бюджет
 * проверяет пережитый статтер, а не его сглаженную оценку.
 */
function rankOf(sorted: readonly number[], percent: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percent / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index]!;
}

/** Тот же перцентиль по неотсортированной серии — вход для тестов и отчётов. */
export function benchPercentile(values: readonly number[], percent: number): number {
  return rankOf([...values].sort((a, b) => a - b), percent);
}

/** Сводка серии: p50, p99 и максимум одним проходом сортировки. */
export function benchSummarize(values: readonly number[]): BenchPercentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: rankOf(sorted, 50),
    p99: rankOf(sorted, 99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
  };
}

/** Значения строки запроса, читаемые как «выключено»: `?bench=0` — это не «включено». */
const BENCH_OFF = new Set(['0', 'off', 'false', 'no']);

/**
 * Запрошен ли замер строкой запроса страницы. Умолчание — ВЫКЛЮЧЕНО: probe
 * существует ради ручной диагностики (PERF-7), и обычный запуск демо о нём не
 * знает.
 */
export function benchRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('bench');
  if (value === null) return false;
  return !BENCH_OFF.has(value.toLowerCase());
}

/**
 * Сбор таймингов кадра в кольцевые буферы. Порядок вызовов на кадр —
 * `begin` → `mark` по разу на стадию → `end`; отступление от него не ломает
 * буфер, но смещает стадии, поэтому вызов один и живёт в одном месте
 * (`frame` в `main.ts`).
 */
export class BenchProbe {
  private readonly clock: () => number;
  /** Отметка кадра по часам rAF — из неё выводятся период и разрывы доставки. */
  private readonly atMs = new Float64Array(BENCH_CAPACITY);
  private readonly totalMs = new Float64Array(BENCH_CAPACITY);
  private readonly stageMs = new Float64Array(BENCH_CAPACITY * BENCH_STAGES.length);
  /** Номер последнего доставленного тика на этом кадре; < 0 — доставки не было. */
  private readonly tickNo = new Float64Array(BENCH_CAPACITY);
  /** Стадии текущего кадра до записи в кольцо: буфер на кадр, а не объект. */
  private readonly scratch = new Float64Array(BENCH_STAGES.length);

  private cursor = 0;
  private count = 0;
  private dropped = 0;
  private stage = 0;
  private startedAt = 0;
  private markedAt = 0;
  private frameAt = 0;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** Начало кадра; `now` — отметка rAF, то есть часы периода кадра. */
  begin(now: number): void {
    this.frameAt = now;
    this.stage = 0;
    this.startedAt = this.clock();
    this.markedAt = this.startedAt;
  }

  /** Конец очередной стадии кадра: время с прошлой отметки. */
  mark(): void {
    const at = this.clock();
    if (this.stage < this.scratch.length) this.scratch[this.stage] = at - this.markedAt;
    this.stage += 1;
    this.markedAt = at;
  }

  /**
   * Конец кадра. `tick` — номер последнего доставленного тика (или < 0, если
   * доставки ещё не было): часы здесь больше не читаются, концом кадра служит
   * последняя отметка стадии.
   */
  end(tick: number): void {
    const slot = this.cursor;
    this.atMs[slot] = this.frameAt;
    this.totalMs[slot] = this.markedAt - this.startedAt;
    this.tickNo[slot] = tick;
    const base = slot * BENCH_STAGES.length;
    for (let i = 0; i < BENCH_STAGES.length; i += 1) {
      this.stageMs[base + i] = i < this.stage ? this.scratch[i]! : 0;
    }
    this.cursor = (slot + 1) % BENCH_CAPACITY;
    if (this.count < BENCH_CAPACITY) this.count += 1;
    else this.dropped += 1;
  }

  /** Забыть собранное, оставив буферы: так снимается прогрев перед замером. */
  reset(): void {
    this.cursor = 0;
    this.count = 0;
    this.dropped = 0;
  }

  /** Кадров в буфере — признак «страница уже рисует». */
  get frames(): number {
    return this.count;
  }

  /** Хронологический порядок занятых слотов кольца. */
  private slots(): number[] {
    const start = this.count === BENCH_CAPACITY ? this.cursor : 0;
    const order: number[] = [];
    for (let i = 0; i < this.count; i += 1) order.push((start + i) % BENCH_CAPACITY);
    return order;
  }

  /** Отчёт за окно замера; аллокации только здесь — вне кадра. */
  report(): BenchSummary {
    const order = this.slots();
    const totals: number[] = [];
    const intervals: number[] = [];
    const gaps: number[] = [];
    const stages: number[][] = BENCH_STAGES.map(() => []);
    /**
     * Худшие периоды окна: отбираются ЗДЕСЬ, из уже хранимого кольца, а не
     * копятся на кадре. Кольцо несёт всё нужное, и покадровый отбор был бы
     * работой и аллокацией В КАДРЕ ради отчёта, который снимается раз в прогон
     * (та же дисциплина, что у остального `report()`). Список короткий —
     * вставка в него дешевле сортировки всего окна и не растёт с числом кадров.
     *
     * `slot` — кадр, РАБОТА которого пришлась на этот период, то есть
     * предыдущий по хронологии (см. `BenchWorstFrame`).
     */
    const worst: { slot: number; interval: number }[] = [];
    let previousSlot = -1;
    let previousAt = 0;
    let previousTick = -1;
    let segmentFirst = -1;
    let delivered = 0;
    let deliveredAt = 0;

    for (let i = 0; i < order.length; i += 1) {
      const slot = order[i]!;
      const at = this.atMs[slot]!;
      totals.push(this.totalMs[slot]!);
      if (i > 0) {
        const interval = at - previousAt;
        intervals.push(interval);
        // Место в списке ищется с хвоста, и вставка идёт только строго БОЛЬШЕ
        // соседа: на равных периодах впереди остаётся тот, что случился раньше,
        // и топ не пляшет от порядка обхода.
        let place = worst.length;
        while (place > 0 && interval > worst[place - 1]!.interval) place -= 1;
        if (place < BENCH_WORST_FRAMES) {
          worst.splice(place, 0, { slot: previousSlot, interval });
          if (worst.length > BENCH_WORST_FRAMES) worst.length = BENCH_WORST_FRAMES;
        }
      }
      previousSlot = slot;
      previousAt = at;
      const base = slot * BENCH_STAGES.length;
      for (let s = 0; s < BENCH_STAGES.length; s += 1) stages[s]!.push(this.stageMs[base + s]!);
      const tick = this.tickNo[slot]!;
      if (tick < 0) continue;
      if (previousTick < 0) {
        segmentFirst = tick;
        deliveredAt = at;
      } else if (tick > previousTick) {
        gaps.push(at - deliveredAt);
        deliveredAt = at;
      } else if (tick < previousTick) {
        // Номер тика пошёл НАЗАД — перемотка (NTR-16): нумерация ветви истории
        // начинается заново, и через границу ветвей приращения не читаются.
        // Разность «последний − первый» мерила бы здесь глубину отката, а не
        // каденс (вплоть до отрицательного «тиков доставлено»), поэтому
        // доставленное копится по отрезкам монотонной нумерации. Разрыв через
        // границу тоже не записывается: пауза перемотки — состояние матча, а
        // не заикание тикера воркера.
        delivered += previousTick - segmentFirst;
        segmentFirst = tick;
        deliveredAt = at;
      }
      previousTick = tick;
    }
    if (segmentFirst >= 0) delivered += previousTick - segmentFirst;

    const seconds =
      order.length < 2 ? 0 : (this.atMs[order[order.length - 1]!]! - this.atMs[order[0]!]!) / 1000;
    const stagesMs = {} as Record<BenchStage, BenchPercentiles>;
    for (let s = 0; s < BENCH_STAGES.length; s += 1) stagesMs[BENCH_STAGES[s]!] = benchSummarize(stages[s]!);

    // Отметки худших кадров — ОТ НАЧАЛА окна, а не по часам страницы: окно
    // начинается с `reset()`, и абсолютное время главного потока читателю
    // отчёта не говорит ничего.
    const windowAt = order.length === 0 ? 0 : this.atMs[order[0]!]!;
    const worstFrames: BenchWorstFrame[] = worst.map(({ slot, interval }) => {
      const frameStages = {} as Record<BenchStage, number>;
      const base = slot * BENCH_STAGES.length;
      for (let s = 0; s < BENCH_STAGES.length; s += 1) {
        frameStages[BENCH_STAGES[s]!] = this.stageMs[base + s]!;
      }
      return {
        atMs: this.atMs[slot]! - windowAt,
        intervalMs: interval,
        frameMs: this.totalMs[slot]!,
        stagesMs: frameStages,
        tick: this.tickNo[slot]!,
      };
    });

    return {
      version: BENCH_PROBE_VERSION,
      seconds,
      frames: order.length,
      fps: seconds > 0 ? (order.length - 1) / seconds : 0,
      dropped: this.dropped,
      frameMs: benchSummarize(totals),
      intervalMs: benchSummarize(intervals),
      stagesMs,
      ticks: {
        delivered,
        perSecond: seconds > 0 ? delivered / seconds : 0,
        gapMs: benchSummarize(gaps),
      },
      worstFrames,
    };
  }
}

/** Ручка probe на `window`: всё, что харнессу нужно от страницы. */
export interface BenchProbeGlobal {
  readonly version: number;
  readonly stages: readonly BenchStage[];
  /** Кадров собрано — по нему харнесс ждёт, что матч действительно пошёл. */
  frames: () => number;
  reset: () => void;
  report: () => BenchSummary;
}

/** Носитель ручки: `window` страницы, а в тестах — обычный объект. */
export interface BenchProbeHost {
  [BENCH_GLOBAL_KEY]?: BenchProbeGlobal;
}

/**
 * Завести probe и повесить его ручку на носителя. Часы — параметр ради тестов:
 * в странице это `performance.now()`, тот же источник, что у отметок rAF.
 */
export function attachBenchProbe(host: BenchProbeHost, clock?: () => number): BenchProbe {
  const probe = new BenchProbe(clock ?? (() => performance.now()));
  host[BENCH_GLOBAL_KEY] = {
    version: BENCH_PROBE_VERSION,
    stages: BENCH_STAGES,
    frames: () => probe.frames,
    reset: () => {
      probe.reset();
    },
    report: () => probe.report(),
  };
  return probe;
}
