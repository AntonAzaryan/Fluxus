/**
 * Машина состояний старта (`game-boot` BOOT-1, BOOT-4) — чистый TS: ни DOM, ни
 * кадровых таймеров внутри.
 *
 * `splash` (сплеш показан, стадии ещё не пошли) → `warming` (стадии
 * исполняются) → `waiting` (локальные стадии завершены, первой доставки нет) →
 * `revealing` (сплеш угасает) → `done` (управление у назначения). Состояние
 * `waiting` необязательно на пути: доставка, пришедшая до конца прогрева, ведёт
 * из `warming` прямо в `revealing`.
 *
 * ## Почему часы и таймеры — инъекция
 *
 * `minMs` сплеша и таймауты стадий — время стены, а машина обязана быть
 * проверяемой без него: тест двигает часы руками и видит те же переходы, что
 * браузер. Отсюда `clock` и `schedule` параметрами, а не `Date.now` и
 * `setTimeout` внутри. Кадровых таймеров (`requestAnimationFrame`) здесь нет
 * вовсе: кадр приходит входом `frame()` — считает их кадровый цикл сборки.
 *
 * ## Чего раскрытие ждёт и чего не ждёт (BOOT-4)
 *
 * Ждёт: каждой ОБЯЗАТЕЛЬНОЙ стадии (исходом или своим таймаутом), первой
 * применённой доставки (SHELL-10), `warmFrames` кадров после неё и `minMs` от
 * показа сплеша. Не ждёт: необязательных стадий — их тёплые объекты вернёт
 * `finish` их собственной стадии (REND-45).
 *
 * Вечного сплеша не бывает: единственное, у чего нет потолка, — первая доставка,
 * и это ожидание наблюдаемо состоянием `waiting`, а не продолжением загрузки.
 */
import type { BootDocument } from './bootDocument.js';
import { EVENT_STAGES } from './bootDocument.js';
import type { StageOutcome } from './bootStages.js';

export type BootState = 'splash' | 'warming' | 'waiting' | 'revealing' | 'done';

/** Стадия тёплых кадров: единственная, чей потолок взводится не стартом (BOOT-4). */
const WARM_FRAMES = 'warmFrames';

/** Ход одной стадии документа — вход диагностики BOOT-5 и тестов. */
export interface BootStageProgress {
  readonly name: string;
  readonly required: boolean;
  /** Исход; `null` — стадия ещё идёт. */
  readonly outcome: StageOutcome | null;
  /** Длительность до исхода в миллисекундах; `null` — ещё идёт. */
  readonly ms: number | null;
}

/** Исход медиа сплеша (BOOT-2, BOOT-5). */
export type BootMedia = 'ok' | 'failed' | 'none';

/** Отчёт старта (BOOT-5) — сторож, не эталон: длительности суть время стены. */
export interface BootReport {
  readonly state: BootState;
  /** Время входа в каждое состояние, мс от показа сплеша. */
  readonly entered: Readonly<Record<string, number>>;
  readonly stages: readonly BootStageProgress[];
  readonly rejected: readonly string[];
  readonly notWarmed: readonly string[];
  readonly media: BootMedia;
}

/** Часы и отложенный вызов — единственная связь машины со временем. */
export interface BootClock {
  now(): number;
  /** Отложенный вызов; возвращает отмену. Своих таймеров машина не заводит. */
  schedule(ms: number, run: () => void): () => void;
}

export interface BootSequenceOptions {
  readonly document: BootDocument;
  readonly clock: BootClock;
  /**
   * Раскрытие: СИНХРОННАЯ точка бюджета кадра (REND-44). Зовётся один раз, до
   * угасания: половина арены или сущность без изображения в первом ВИДИМОМ
   * кадре — дефект, а не отложенная работа (BOOT-4).
   */
  readonly onReveal: () => void;
  /** Запрос угасания у сплеша; ответ — вход `fadeEnded()` (BOOT-2). */
  readonly onFade: (fadeMs: number) => void;
  /** Смена состояния — сплешу: он показывает ожидание матча отличимо (BOOT-4). */
  readonly onState?: (state: BootState, report: BootReport) => void;
  /** Управление назначению (BOOT-1): зовётся один раз, на входе в `done`. */
  readonly onDone?: (report: BootReport) => void;
  /**
   * Стадия свёрнута по таймауту (BOOT-4): раннеру пора вернуть тёплые объекты
   * владельцу, не дожидаясь входов, которые вправе не приехать никогда
   * (ASSET-4). Исход стадии к этому моменту уже поставлен — здесь только
   * сворачивание работы, которую машина больше не ждёт.
   */
  readonly onStageTimeout?: (name: string) => void;
  /** Момент показа сплеша по тем же часам; нет — момент создания машины. */
  readonly shownAt?: number;
  /** Отвергнутые записи документа — в отчёт (BOOT-5). */
  readonly rejected?: readonly string[];
  /** Объявленные, но не названные документом стадии (BOOT-3). */
  readonly notWarmed?: readonly string[];
  /** Исход медиа сплеша; спрашивается при сборке отчёта (BOOT-2). */
  readonly media?: () => BootMedia;
}

export interface BootSequence {
  readonly state: BootState;
  /** Стадии пошли: таймауты и `minMs` взведены, состояние — `warming`. */
  start(): void;
  /** Исход стадии-работы либо стадии-события (BOOT-3). */
  stageSettled(name: string, outcome: StageOutcome): void;
  /** Handshake оболочки получен (SHELL-5). */
  handshake(): void;
  /** Первая доставка состояния применена (SHELL-10). */
  firstDelivery(): void;
  /** Кадр кадрового цикла под сплешем (BOOT-4). */
  frame(): void;
  /** Угасание сплеша закончилось (BOOT-2). */
  fadeEnded(): void;
  report(): BootReport;
}

/** Ход стадии внутри машины: запись прогресса плюс её отмена таймаута. */
interface StageState {
  readonly name: string;
  readonly required: boolean;
  /** Потолок ожидания; `null` — таймаута нет по построению (BOOT-4). */
  readonly timeoutMs: number | null;
  outcome: StageOutcome | null;
  startedAt: number;
  ms: number | null;
  cancel: (() => void) | null;
}

export function createBootSequence(options: BootSequenceOptions): BootSequence {
  const { document: doc, clock } = options;
  const shownAt = options.shownAt ?? clock.now();
  const stages = new Map<string, StageState>();
  for (const stage of doc.stages) {
    stages.set(stage.name, {
      name: stage.name,
      required: stage.required,
      timeoutMs: stage.timeoutMs,
      outcome: null,
      startedAt: shownAt,
      ms: null,
      cancel: null,
    });
  }
  const entered: Record<string, number> = { splash: 0 };
  let state: BootState = 'splash';
  let delivered = false;
  let warmFrames = 0;
  let minElapsed = doc.splash.minMs <= 0;
  let started = false;

  const sequence: BootSequence = {
    get state(): BootState {
      return state;
    },
    start,
    stageSettled: settle,
    handshake: () => {
      settle('handshake', 'done');
    },
    firstDelivery,
    frame,
    fadeEnded,
    report,
  };
  return sequence;

  function start(): void {
    if (started) return;
    started = true;
    const now = clock.now();
    for (const stage of stages.values()) {
      stage.startedAt = now;
      // Тёплые кадры считаются ПОСЛЕ первой доставки, и её ожидание потолка не
      // имеет (BOOT-4): взведи мы их таймер здесь, он сработал бы на ожидании
      // соперника — на том самом, у чего потолка нет по построению.
      if (stage.name === WARM_FRAMES) continue;
      arm(stage, now);
    }
    if (!minElapsed) {
      // `minMs` считается от ПОКАЗА сплеша, а не от старта стадий: титры студии
      // обязаны быть читаемы независимо от скорости машины (BOOT-2).
      const left = Math.max(0, doc.splash.minMs - (now - shownAt));
      clock.schedule(left, () => {
        minElapsed = true;
        settleCheck();
      });
    }
    enter('warming');
    settleCheck();
  }

  /** Взводит таймаут стадии: до старта её ждать было нечего (BOOT-4). */
  function arm(stage: StageState, now: number): void {
    if (stage.timeoutMs === null || stage.outcome !== null) return;
    stage.startedAt = now;
    stage.cancel = clock.schedule(stage.timeoutMs, () => {
      settle(stage.name, 'timeout');
      // Порядок несущий: сперва исход, потом сворачивание. Свёрнутый раннер
      // вправе завершиться немедленно, и его `done` не должен переписывать
      // исход стадии на `done` (`settle` этого и не позволит).
      options.onStageTimeout?.(stage.name);
    });
  }

  function settle(name: string, outcome: StageOutcome): void {
    const stage = stages.get(name);
    // Стадия, которой документ не называл, исхода не имеет: молча — потому что
    // раннеров у неназванных стадий нет вовсе, а событие оболочки приходит
    // независимо от того, вписал ли его автор документа.
    if (stage?.outcome !== null) return;
    stage.outcome = outcome;
    stage.ms = Math.max(0, clock.now() - stage.startedAt);
    stage.cancel?.();
    stage.cancel = null;
    settleCheck();
  }

  function firstDelivery(): void {
    if (delivered) return;
    delivered = true;
    // Ждать соперника больше нечего: оставшееся до раскрытия — тёплые кадры и
    // минимальная длительность сплеша, то есть снова загрузка, а не ожидание
    // матча. Показывать «ждём соперника» после его прихода значило бы врать
    // игроку ровно там, где BOOT-4 требует различать эти два состояния.
    if (state === 'waiting') enter('warming');
    settle('firstDelivery', 'done');
    // Ноль тёплых кадров — законная политика документа: ждать после доставки
    // нечего, и стадия закрывается ею же.
    if (doc.warmFrames <= 0) settle(WARM_FRAMES, 'done');
    // Только теперь у тёплых кадров есть чем идти — здесь и взводится их
    // потолок: кадров может не случиться вовсе (вкладка в фоне — кадрового
    // цикла там нет), а вечного сплеша не бывает (BOOT-4).
    const frames = stages.get(WARM_FRAMES);
    if (frames !== undefined) arm(frames, clock.now());
    settleCheck();
  }

  /**
   * Тёплый кадр (BOOT-4): монтирует отложенное (REND-44) и первые ленивые пути
   * (ASSET-4) там, где их не видно. Считаются кадры ПОСЛЕ первой доставки:
   * кадру до неё монтировать нечего — состояния ещё нет.
   */
  function frame(): void {
    if (!delivered || state === 'revealing' || state === 'done') return;
    warmFrames += 1;
    if (warmFrames >= doc.warmFrames) settle(WARM_FRAMES, 'done');
    settleCheck();
  }

  function fadeEnded(): void {
    if (state !== 'revealing') return;
    enter('done');
    options.onDone?.(report());
  }

  /** Все ли обязательные стадии получили исход (BOOT-4). */
  function requiredSettled(): boolean {
    for (const stage of stages.values()) {
      if (stage.required && stage.outcome === null) return false;
    }
    return true;
  }

  /**
   * Локальные стадии — все, кроме тех, что закрывает матч: первая доставка и
   * тёплые кадры после неё. По ним и различаются «идёт прогрев» и «ждём
   * соперника» (BOOT-4).
   */
  function localSettled(): boolean {
    for (const stage of stages.values()) {
      if ((EVENT_STAGES as readonly string[]).includes(stage.name) && stage.name !== 'handshake') {
        continue;
      }
      if (stage.outcome === null) return false;
    }
    return true;
  }

  /**
   * Тёплые кадры пройдены: их насчитал кадровый цикл либо стадия закрылась
   * своим таймаутом (BOOT-4). Документ, обещающий кадры и не называющий стадии,
   * до машины не доходит — его отвергает валидация (BOOT-3): ждать кадров без
   * потолка значило бы завести второе бессрочное ожидание рядом с первой
   * доставкой, а бессрочное ожидание у раскрытия ровно одно.
   */
  function framesReady(): boolean {
    if (warmFrames >= doc.warmFrames) return true;
    return (stages.get(WARM_FRAMES)?.outcome ?? null) !== null;
  }

  function settleCheck(): void {
    if (state === 'revealing' || state === 'done' || !started) return;
    if (requiredSettled() && delivered && framesReady() && minElapsed) {
      enter('revealing');
      // Отложенная работа доделывается ЦЕЛИКОМ и до угасания: этот кадр —
      // последний под непрозрачным сплешем, а не первый видимый (BOOT-4).
      options.onReveal();
      options.onFade(doc.splash.fadeMs);
      return;
    }
    // Ожидание матча — не загрузка (BOOT-4): показывается оно отличимо, и
    // возврат в `warming` невозможен — локальные стадии уже завершены.
    if (!delivered && localSettled() && state !== 'waiting') enter('waiting');
  }

  function enter(next: BootState): void {
    state = next;
    entered[next] = Math.max(0, clock.now() - shownAt);
    options.onState?.(next, report());
  }

  function report(): BootReport {
    return {
      state,
      entered: { ...entered },
      stages: doc.stages.map((stage) => {
        const live = stages.get(stage.name)!;
        return { name: live.name, required: live.required, outcome: live.outcome, ms: live.ms };
      }),
      rejected: options.rejected ?? [],
      notWarmed: options.notWarmed ?? [],
      media: options.media?.() ?? 'none',
    };
  }
}

/**
 * Отчёт старта строкой (BOOT-5) — по образцу сторожей `[bench]`
 * (`performance-budget` PERF-5). Чистая функция: её вход — данные машины, её
 * выход читает человек, и ни одно её число не входит в эталоны (PERF-3, PERF-4)
 * — длительности здесь суть время стены и данные среды.
 */
export function formatBootReport(report: BootReport): string {
  const parts = [`[boot] ${report.state}`];
  const entered = Object.entries(report.entered)
    .map(([name, ms]) => `${name}=${Math.round(ms)}мс`)
    .join(' ');
  if (entered !== '') parts.push(entered);
  const stages = report.stages
    .map((stage) => {
      const outcome = stage.outcome ?? 'идёт';
      const ms = stage.ms === null ? '' : ` ${Math.round(stage.ms)}мс`;
      return `${stage.name}: ${outcome}${stage.required ? '' : ' (необязательная)'}${ms}`;
    })
    .join('; ');
  parts.push(`стадии: ${stages === '' ? 'ни одной' : stages}`);
  parts.push(`медиа: ${report.media}`);
  if (report.notWarmed.length > 0) parts.push(`не прогреты: ${report.notWarmed.join(', ')}`);
  if (report.rejected.length > 0) parts.push(`отвергнуто: ${report.rejected.join('; ')}`);
  return parts.join(' | ');
}
