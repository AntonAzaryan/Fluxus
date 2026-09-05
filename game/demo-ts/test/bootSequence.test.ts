/**
 * Машина состояний старта (`game-boot` BOOT-1, BOOT-4, BOOT-5): порядок
 * состояний, условия раскрытия и отчёт.
 *
 * Ни DOM, ни браузера здесь нет и быть не должно: часы и отложенный вызов —
 * инъекция, и тест двигает их руками. Тем же и проверяется несущее свойство
 * машины — переходы определяются исходами стадий и событиями оболочки, а не
 * таймерами кадра (BOOT-1).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOT_DOCUMENT,
  type BootDocument,
  type BootStage,
} from '../app/boot/bootDocument.js';
import {
  createBootSequence,
  formatBootReport,
  type BootClock,
  type BootSequence,
  type BootState,
} from '../app/boot/bootSequence.js';

/** Ручные часы: время двигает тест, отложенные вызовы исполняет он же. */
function manualClock(): BootClock & { advance(ms: number): void; readonly pending: number } {
  let now = 0;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    schedule(ms, run) {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms: number): void {
      const until = now + ms;
      // Порядок исполнения — по времени срабатывания: так же, как у планировщика
      // страницы, и без него «таймаут стадии раньше minMs» проверялся бы удачей.
      for (;;) {
        const next = timers
          .filter((timer) => !timer.cancelled && timer.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        next.cancelled = true;
        now = next.at;
        next.run();
      }
      now = until;
    },
    get pending(): number {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

function stage(name: string, required = true, timeoutMs: number | null = 5000): BootStage {
  return { name, required, timeoutMs };
}

/** Документ стенда: стадии в порядке входов, как у отгружаемого демо. */
function documentOf(stages: readonly BootStage[], rest: Partial<BootDocument> = {}): BootDocument {
  return {
    ...DEFAULT_BOOT_DOCUMENT,
    stages,
    warmFrames: 2,
    ...rest,
    splash: { ...DEFAULT_BOOT_DOCUMENT.splash, ...(rest.splash ?? {}) },
  };
}

interface Stand {
  readonly boot: BootSequence;
  readonly clock: ReturnType<typeof manualClock>;
  readonly states: BootState[];
  readonly reveals: number[];
  readonly fades: number[];
  readonly done: number;
}

function stand(doc: BootDocument): Stand {
  const clock = manualClock();
  const states: BootState[] = [];
  const reveals: number[] = [];
  const fades: number[] = [];
  let done = 0;
  const boot = createBootSequence({
    document: doc,
    clock,
    onReveal: () => reveals.push(clock.now()),
    onFade: (fadeMs) => fades.push(fadeMs),
    onState: (state) => states.push(state),
    onDone: () => {
      done += 1;
    },
  });
  return {
    boot,
    clock,
    states,
    reveals,
    fades,
    get done(): number {
      return done;
    },
  };
}

/** Обычный старт демо: handshake, прогрев, доставка, тёплые кадры, раскрытие. */
function fullDocument(): BootDocument {
  return documentOf([
    stage('handshake', true, null),
    stage('prewarm.models'),
    stage('scene'),
    stage('firstDelivery', true, null),
    stage('warmFrames'),
  ]);
}

describe('обычный старт: splash → warming → revealing → done (BOOT-1)', () => {
  it('состояния идут по порядку, а waiting в пути не появляется', () => {
    const rig = stand(fullDocument());
    expect(rig.boot.state).toBe('splash');
    rig.boot.start();
    rig.boot.handshake();
    // Доставка пришла ДО конца прогрева — состояния ожидания на пути нет вовсе
    // (BOOT-1: `waiting` необязательно).
    rig.boot.firstDelivery();
    rig.boot.stageSettled('prewarm.models', 'done');
    rig.boot.stageSettled('scene', 'done');
    rig.boot.frame();
    expect(rig.boot.state).toBe('warming');
    rig.boot.frame();
    expect(rig.boot.state).toBe('revealing');
    rig.boot.fadeEnded();
    expect(rig.boot.state).toBe('done');
    expect(rig.states).toEqual(['warming', 'revealing', 'done']);
    expect(rig.done).toBe(1);
  });

  it('раскрытие — синхронная точка бюджета кадра и идёт ДО угасания (BOOT-4)', () => {
    const rig = stand(fullDocument());
    rig.boot.start();
    rig.boot.handshake();
    rig.boot.firstDelivery();
    rig.boot.stageSettled('prewarm.models', 'done');
    rig.boot.stageSettled('scene', 'done');
    rig.boot.frame();
    rig.boot.frame();
    // Отложенное (REND-44) доделывается целиком под непрозрачным сплешем: этот
    // кадр — последний под ним, а не первый видимый.
    expect(rig.reveals).toHaveLength(1);
    expect(rig.fades).toEqual([DEFAULT_BOOT_DOCUMENT.splash.fadeMs]);
    // Дальнейшие кадры раскрытия не повторяют.
    rig.boot.frame();
    expect(rig.reveals).toHaveLength(1);
  });
});

describe('минимальная длительность сплеша (BOOT-2)', () => {
  it('быстрая машина ждёт minMs: угасание не раньше 1500 мс от показа', () => {
    const rig = stand(documentOf([stage('handshake', true, null), stage('firstDelivery', true, null), stage('warmFrames')], {
      splash: { ...DEFAULT_BOOT_DOCUMENT.splash, minMs: 1500 },
      warmFrames: 1,
    }));
    rig.boot.start();
    rig.boot.handshake();
    rig.clock.advance(300);
    // Локальных стадий, кроме handshake, у этого документа нет: до доставки
    // машина уже в ожидании матча, а с её приходом — снова в прогреве.
    expect(rig.boot.state).toBe('waiting');
    rig.boot.firstDelivery();
    rig.boot.frame();
    // Всё готово за 300 мс, но титры студии обязаны быть читаемы независимо от
    // скорости машины.
    expect(rig.boot.state).toBe('warming');
    expect(rig.reveals).toEqual([]);
    rig.clock.advance(1200);
    expect(rig.boot.state).toBe('revealing');
    expect(rig.reveals).toEqual([1500]);
  });
});

describe('готовность, ожидание и таймауты (BOOT-4)', () => {
  it('обязательная стадия по таймауту не задерживает раскрытие дольше своего потолка', () => {
    const rig = stand(
      documentOf([
        stage('handshake', true, null),
        stage('prewarm.models', true, 8000),
        stage('firstDelivery', true, null),
        stage('warmFrames'),
      ], { warmFrames: 1 }),
    );
    rig.boot.start();
    rig.boot.handshake();
    rig.boot.firstDelivery();
    rig.boot.frame();
    expect(rig.boot.state).toBe('warming');
    rig.clock.advance(8000);
    // Прогрев — оптимизация, а не условие корректности: стадия получает исход
    // `timeout`, а её вид остаётся ленивому пути (ASSET-4).
    expect(rig.boot.state).toBe('revealing');
    const models = rig.boot.report().stages.find((entry) => entry.name === 'prewarm.models');
    expect(models?.outcome).toBe('timeout');
    expect(models?.ms).toBe(8000);
  });

  it('таймаут стадии сворачивает её раннера: тёплое возвращается владельцу', () => {
    // Таймаут сам по себе только ставит исход, а вторая ступень ждёт входов,
    // которые вправе не приехать никогда (ASSET-4): без сворачивания тёплые
    // объекты остались бы на руках у прогрева, и «стадия остаётся ленивому
    // пути» (BOOT-4) было бы неправдой.
    const clock = manualClock();
    const wound: string[] = [];
    const boot = createBootSequence({
      document: documentOf([
        stage('handshake', true, null),
        stage('prewarm.models', true, 8000),
        stage('firstDelivery', true, null),
        stage('warmFrames'),
      ], { warmFrames: 1 }),
      clock,
      onReveal: () => {},
      onFade: () => {},
      onStageTimeout: (name) => wound.push(name),
    });
    boot.start();
    boot.handshake();
    clock.advance(8000);
    expect(wound).toEqual(['prewarm.models']);
    // Стадия, успевшая своим исходом, сворачивать нечего: таймер снят.
    boot.stageSettled('scene', 'done');
    clock.advance(30_000);
    expect(wound).toEqual(['prewarm.models']);
  });

  it('ожидание соперника — своё состояние, а не продолжение загрузки', () => {
    const rig = stand(fullDocument());
    rig.boot.start();
    rig.boot.handshake();
    rig.boot.stageSettled('prewarm.models', 'done');
    rig.boot.stageSettled('scene', 'done');
    // Локальные стадии завершены, ростер не собран (SES-4): ждать первой
    // доставки раскрытие обязано без потолка, и показывается это отличимо.
    expect(rig.boot.state).toBe('waiting');
    rig.clock.advance(60_000);
    expect(rig.boot.state).toBe('waiting');
    // Приход доставки ведёт к тёплым кадрам и раскрытию так же, как из warming.
    rig.boot.firstDelivery();
    // Соперник пришёл: оставшееся — тёплые кадры, то есть снова загрузка.
    expect(rig.boot.state).toBe('warming');
    rig.boot.frame();
    rig.boot.frame();
    expect(rig.boot.state).toBe('revealing');
    expect(rig.states).toEqual(['warming', 'waiting', 'warming', 'revealing']);
  });

  it('тёплые кадры считаются ПОСЛЕ доставки и ровно в названном числе', () => {
    const rig = stand(fullDocument());
    rig.boot.start();
    rig.boot.handshake();
    rig.boot.stageSettled('prewarm.models', 'done');
    rig.boot.stageSettled('scene', 'done');
    // Кадры до доставки монтировать нечего — состояния ещё нет.
    for (let i = 0; i < 5; i++) rig.boot.frame();
    expect(rig.reveals).toEqual([]);
    rig.boot.firstDelivery();
    rig.boot.frame();
    expect(rig.reveals).toEqual([]);
    rig.boot.frame();
    expect(rig.reveals).toHaveLength(1);
    expect(rig.boot.report().stages.find((entry) => entry.name === 'warmFrames')?.outcome).toBe('done');
  });

  it('потолок тёплых кадров взводится ДОСТАВКОЙ, а не стартом: ожидание соперника его не тратит', () => {
    const rig = stand(
      documentOf([
        stage('handshake', true, null),
        stage('firstDelivery', true, null),
        stage('warmFrames', true, 10_000),
      ]),
    );
    rig.boot.start();
    rig.boot.handshake();
    // Соперник не идёт минуту: потолок тёплых кадров сработал бы на ожидании —
    // на том самом, у чего потолка нет по построению (BOOT-4).
    rig.clock.advance(60_000);
    expect(rig.boot.state).toBe('waiting');
    expect(rig.boot.report().stages.find((entry) => entry.name === 'warmFrames')?.outcome).toBeNull();

    rig.boot.firstDelivery();
    // Кадров нет вовсе (вкладка в фоне — кадрового цикла там нет): раскрытие
    // приходит по таймауту стадии, а вечного сплеша не бывает.
    rig.clock.advance(10_000);
    expect(rig.boot.state).toBe('revealing');
    expect(rig.boot.report().stages.find((entry) => entry.name === 'warmFrames')?.outcome).toBe('timeout');
  });

  it('необязательная стадия раскрытия не ждёт, а свой исход всё равно получает', () => {
    const rig = stand(
      documentOf([
        stage('handshake', true, null),
        stage('prewarm.particles', false, 5000),
        stage('firstDelivery', true, null),
        stage('warmFrames'),
      ], { warmFrames: 1 }),
    );
    rig.boot.start();
    rig.boot.handshake();
    rig.boot.firstDelivery();
    rig.boot.frame();
    // Раскрытие состоялось, пока стадия ещё идёт: её тёплые объекты вернёт её
    // же `finish` (REND-45).
    expect(rig.boot.state).toBe('revealing');
    expect(rig.boot.report().stages.find((entry) => entry.name === 'prewarm.particles')?.outcome).toBeNull();
    rig.boot.stageSettled('prewarm.particles', 'done');
    expect(rig.boot.report().stages.find((entry) => entry.name === 'prewarm.particles')?.outcome).toBe('done');
    // Доигравшая стадия состояния не двигает: раскрытие уже случилось.
    expect(rig.boot.state).toBe('revealing');
  });

  it('исход стадии не переписывается: пришедший позже таймаут её не трогает', () => {
    const rig = stand(fullDocument());
    rig.boot.start();
    rig.boot.stageSettled('prewarm.models', 'done');
    rig.clock.advance(10_000);
    expect(rig.boot.report().stages.find((entry) => entry.name === 'prewarm.models')?.outcome).toBe('done');
  });
});

describe('отчёт старта — сторож, не эталон (BOOT-5)', () => {
  it('строка `[boot]` несёт каждую стадию с исходом и длительностью', () => {
    const clock = manualClock();
    const boot = createBootSequence({
      document: documentOf([stage('handshake', true, null), stage('prewarm.fog'), stage('firstDelivery', true, null), stage('warmFrames')], { warmFrames: 1 }),
      clock,
      rejected: ['after: назначение "menu" зарезервировано словарём'],
      notWarmed: ['prewarm.particles'],
      media: () => 'failed',
      onReveal: () => {},
      onFade: () => {},
    });
    boot.start();
    boot.handshake();
    clock.advance(120);
    boot.stageSettled('prewarm.fog', 'skipped');
    boot.firstDelivery();
    boot.frame();
    boot.fadeEnded();

    const line = formatBootReport(boot.report());
    expect(line.startsWith('[boot] done')).toBe(true);
    for (const stageName of ['handshake', 'prewarm.fog', 'firstDelivery', 'warmFrames']) {
      expect(line).toContain(stageName);
    }
    expect(line).toContain('skipped');
    expect(line).toContain('120мс');
    // Отвергнутые записи, не прогретые стадии и исход медиа — в той же строке:
    // читать их человек обязан там, где смотрит на старт.
    expect(line).toContain('не прогреты: prewarm.particles');
    expect(line).toContain('отвергнуто: after: назначение "menu"');
    expect(line).toContain('медиа: failed');
  });

  it('идущая стадия названа идущей, а не пропущенной', () => {
    const rig = stand(fullDocument());
    rig.boot.start();
    const line = formatBootReport(rig.boot.report());
    expect(line).toContain('prewarm.models: идёт');
    expect(line).toContain('[boot] warming');
  });
});
