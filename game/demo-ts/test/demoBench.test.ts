/**
 * Probe кадра и референс-профиль устройства (`performance-budget` PERF-1,
 * PERF-2, PERF-7).
 *
 * Браузера здесь нет и быть не должно: бенч — ручная диагностика (PERF-7), а
 * проверяется в гейте то, что от браузера не зависит, — арифметика перцентилей,
 * инертность выключенного probe и форма профиля. Ошибка ровно в этих трёх
 * местах стоила бы дороже всего: неверный перцентиль даёт вердикт наоборот,
 * включённый по умолчанию probe меряет сам себя в обычном запуске демо, а
 * непроверенный профиль молча теряет половину бюджетов.
 */
import { describe, expect, it } from 'vitest';
import {
  BENCH_CAPACITY,
  BENCH_GLOBAL_KEY,
  BENCH_PROBE_VERSION,
  BENCH_STAGES,
  BenchProbe,
  attachBenchProbe,
  benchPercentile,
  benchRequested,
  benchSummarize,
  type BenchProbeHost,
  type BenchSummary,
} from '../app/benchProbe.js';
import {
  BENCH_BUDGET_KEYS,
  benchLineFits,
  benchPaceFits,
  benchVerdict,
  validateBenchProfile,
  type BenchProfile,
} from '../bench/profile.js';
import desktopDevJson from '../bench/profiles/desktop-dev.json';

/** Прогон одного кадра через probe на управляемых часах. */
function feed(
  probe: BenchProbe,
  clock: { now: number },
  at: number,
  stages: readonly number[],
  tick: number,
): void {
  clock.now = at;
  probe.begin(at);
  for (const cost of stages) {
    clock.now += cost;
    probe.mark();
  }
  probe.end(tick);
}

function probeOnClock(): { probe: BenchProbe; clock: { now: number } } {
  const clock = { now: 0 };
  return { probe: new BenchProbe(() => clock.now), clock };
}

describe('перцентили замера (PERF-1)', () => {
  it('ближайший ранг на известном ряде 1..100: p50 = 50, p99 = 99', () => {
    const series = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(benchPercentile(series, 50)).toBe(50);
    expect(benchPercentile(series, 99)).toBe(99);
    expect(benchPercentile(series, 100)).toBe(100);
    // Порядок подачи не важен — серия сортируется.
    expect(benchPercentile([...series].reverse(), 99)).toBe(99);
  });

  it('перцентиль — настоящее значение из ряда, а не интерполяция соседей', () => {
    // Ряд из двух: p99 обязан быть пережитым кадром 40, а не средним 20.5.
    expect(benchPercentile([1, 40], 99)).toBe(40);
    expect(benchPercentile([1, 40], 50)).toBe(1);
  });

  it('статтер при среднем 60 fps виден по p99 (PERF-1, сценарий спеки)', () => {
    // Ровно сценарий требования: темп 60 fps, но каждые полсекунды (каждый
    // тридцатый кадр) кадр стоит 40 мс. Пять секунд такого потока:
    const series = Array.from({ length: 300 }, (_, i) => (i % 30 === 0 ? 40 : 16));
    const average = series.reduce((sum, value) => sum + value, 0) / series.length;
    const summary = benchSummarize(series);

    // Среднее — те же ~16.8 мс, то есть «почти 60 fps»: провал им не виден.
    expect(average).toBeLessThan(17);
    expect(summary.p50).toBe(16);
    // А p99 — 40 мс, и бюджет 16.6 он не проходит.
    expect(summary.p99).toBe(40);
    expect(summary.max).toBe(40);
    expect(summary.samples).toBe(300);
  });

  it('пустая серия не роняет отчёт: нулей, а не NaN', () => {
    expect(benchSummarize([])).toEqual({ samples: 0, p50: 0, p99: 0, max: 0 });
  });
});

describe('probe стадий кадра (PERF-2)', () => {
  it('стадии кадра раскладываются по отметкам, а кадр целиком — их сумма', () => {
    const { probe, clock } = probeOnClock();
    feed(probe, clock, 0, [1, 2, 3, 4], 10);
    feed(probe, clock, 16, [1, 2, 3, 4], 10);
    feed(probe, clock, 32, [1, 2, 3, 4], 11);

    const report = probe.report();

    expect(report.version).toBe(BENCH_PROBE_VERSION);
    expect(report.frames).toBe(3);
    expect(report.dropped).toBe(0);
    expect(report.frameMs.p50).toBe(10);
    expect(report.stagesMs.input.p50).toBe(1);
    expect(report.stagesMs.camera.p50).toBe(2);
    expect(report.stagesMs.present.p50).toBe(3);
    expect(report.stagesMs.draw.p50).toBe(4);
    // Период кадра считается по часам rAF, а не по стоимости работы.
    expect(report.intervalMs.p50).toBe(16);
    expect(report.seconds).toBeCloseTo(0.032, 6);
    expect(report.fps).toBeCloseTo(62.5, 6);
  });

  it('регрессия одной стадии видна в ней одной — атрибуция без профилировщика', () => {
    const { probe, clock } = probeOnClock();
    // Та самая форма регрессии, ради которой писался бюджет: подорожал приём
    // доставки (пересборка маски FoW в `syncTick`), остальные стадии те же.
    feed(probe, clock, 0, [1, 2, 3, 4], 1);
    feed(probe, clock, 16, [1, 2, 48, 4], 2);

    const report = probe.report();

    expect(report.stagesMs.present.p99).toBe(48);
    expect(report.stagesMs.input.p99).toBe(1);
    expect(report.stagesMs.camera.p99).toBe(2);
    expect(report.stagesMs.draw.p99).toBe(4);
  });

  it('каденс тика выведен пассивно — из номеров доставленных тиков', () => {
    const { probe, clock } = probeOnClock();
    // Тик доставлен на 1-м и на 3-м кадре: 2-й повторяет прежний номер.
    feed(probe, clock, 0, [0, 0, 0, 0], 10);
    feed(probe, clock, 16, [0, 0, 0, 0], 10);
    feed(probe, clock, 32, [0, 0, 0, 0], 11);
    feed(probe, clock, 48, [0, 0, 0, 0], 12);

    const report = probe.report();

    expect(report.ticks.delivered).toBe(2);
    expect(report.ticks.gapMs.p50).toBe(16);
    expect(report.ticks.gapMs.max).toBe(32);
    expect(report.ticks.perSecond).toBeCloseTo(2 / 0.048, 6);
  });

  it('кадры до первой доставки в каденс не входят: тика ещё нет, а не «тик 0»', () => {
    const { probe, clock } = probeOnClock();
    feed(probe, clock, 0, [0, 0, 0, 0], -1);
    feed(probe, clock, 16, [0, 0, 0, 0], -1);
    feed(probe, clock, 32, [0, 0, 0, 0], 5);
    feed(probe, clock, 48, [0, 0, 0, 0], 6);

    const report = probe.report();

    expect(report.frames).toBe(4);
    expect(report.ticks.delivered).toBe(1);
    expect(report.ticks.gapMs.samples).toBe(1);
  });

  it('кольцо не растёт: переполнение вытесняет старое и называет число вытесненных', () => {
    const { probe, clock } = probeOnClock();
    for (let i = 0; i < BENCH_CAPACITY + 5; i += 1) feed(probe, clock, i * 16, [0, 0, 0, 1], i);

    const report = probe.report();

    expect(report.frames).toBe(BENCH_CAPACITY);
    expect(report.dropped).toBe(5);
    // Окно — последние BENCH_CAPACITY кадров, и хронология в нём не перепутана.
    expect(report.intervalMs.p50).toBe(16);
    expect(report.ticks.delivered).toBe(BENCH_CAPACITY - 1);
  });

  it('reset забывает прогрев, но буферы остаются теми же', () => {
    const { probe, clock } = probeOnClock();
    feed(probe, clock, 0, [9, 9, 9, 9], 1);
    feed(probe, clock, 16, [9, 9, 9, 9], 2);

    probe.reset();
    feed(probe, clock, 32, [1, 1, 1, 1], 3);
    feed(probe, clock, 48, [1, 1, 1, 1], 4);

    const report = probe.report();
    expect(report.frames).toBe(2);
    expect(report.frameMs.max).toBe(4);
    expect(report.dropped).toBe(0);
  });
});

describe('включение probe строкой запроса (PERF-7)', () => {
  it('по умолчанию ВЫКЛЮЧЕН: обычный запуск демо о замере не знает', () => {
    expect(benchRequested('')).toBe(false);
    expect(benchRequested('?solo')).toBe(false);
    expect(benchRequested('?server=ws://127.0.0.1:8080')).toBe(false);
  });

  it('включается явно, и явное «выключено» тоже читается', () => {
    expect(benchRequested('?bench=1')).toBe(true);
    expect(benchRequested('?bench')).toBe(true);
    expect(benchRequested('?solo&bench=1')).toBe(true);
    expect(benchRequested('?bench=0')).toBe(false);
    expect(benchRequested('?bench=off')).toBe(false);
    expect(benchRequested('?bench=FALSE')).toBe(false);
  });

  it('ручка отчёта вешается на носителя под известным харнессу именем', () => {
    const host: BenchProbeHost = {};

    const probe = attachBenchProbe(host, () => 0);

    const api = host[BENCH_GLOBAL_KEY];
    expect(api).toBeDefined();
    expect(api!.version).toBe(BENCH_PROBE_VERSION);
    expect(api!.stages).toEqual([...BENCH_STAGES]);
    expect(api!.frames()).toBe(0);
    probe.begin(0);
    probe.end(1);
    expect(api!.frames()).toBe(1);
    api!.reset();
    expect(api!.report().frames).toBe(0);
  });
});

describe('референс-профиль устройства (PERF-1)', () => {
  it('закоммиченный desktop-dev проходит проверку формы', () => {
    const result = validateBenchProfile(desktopDevJson, 'desktop-dev.json');
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('бюджет кадра профиля разработчика и есть продуктовый минимум 60 fps', () => {
    const result = validateBenchProfile(desktopDevJson, 'desktop-dev.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Число живёт в файле, а не здесь: проверяется смысл — p99 не длиннее кадра
    // при 60 fps, а p50 не выше p99.
    expect(1000 / result.profile.budgetsMs.frame.p99).toBeGreaterThanOrEqual(60);
    expect(result.profile.budgetsMs.frame.p50).toBeLessThanOrEqual(
      result.profile.budgetsMs.frame.p99,
    );
    expect(result.profile.deviceClass).toBe('desktop');
    expect(result.profile.description.length).toBeGreaterThan(0);
  });

  it('ключи бюджетов — кадр плюс ровно те стадии, которые отбивает probe', () => {
    expect(BENCH_BUDGET_KEYS).toEqual(['frame', ...BENCH_STAGES]);
  });

  function errorsOf(raw: unknown): readonly string[] {
    const result = validateBenchProfile(raw, 'проба');
    return result.ok ? [] : result.errors;
  }

  it('битая форма называет ВСЕ причины разом, а не первую', () => {
    const errors = errorsOf({ name: '', deviceClass: 'desktop', budgetsMs: {} });
    expect(errors.some((line) => line.includes('"name"'))).toBe(true);
    expect(errors.some((line) => line.includes('"description"'))).toBe(true);
    expect(errors.some((line) => line.includes('"frame"'))).toBe(true);
    expect(errors.every((line) => line.startsWith('проба: '))).toBe(true);
  });

  it('не объект — отказ целиком', () => {
    expect(errorsOf(null).length).toBe(1);
    expect(errorsOf([]).length).toBe(1);
    expect(errorsOf('desktop-dev').length).toBe(1);
  });

  it('опечатка в имени стадии — ошибка, а не молча незамеченный бюджет', () => {
    const errors = errorsOf({
      name: 'проба',
      deviceClass: 'desktop',
      description: 'проба',
      budgetsMs: { frame: { p50: 8, p99: 16.6 }, presentt: { p50: 1, p99: 2 } },
    });
    expect(errors.some((line) => line.includes('presentt'))).toBe(true);
    expect(errors.some((line) => line.includes('present'))).toBe(true);
  });

  it('нечисловой, неположительный и переставленный бюджет отвергаются', () => {
    const bad = (frame: unknown): readonly string[] =>
      errorsOf({ name: 'проба', deviceClass: 'desktop', description: 'проба', budgetsMs: { frame } });
    expect(bad({ p50: 8, p99: '16.6' }).some((line) => line.includes('p99'))).toBe(true);
    expect(bad({ p50: 0, p99: 16.6 }).some((line) => line.includes('p50'))).toBe(true);
    expect(bad({ p50: 20, p99: 16.6 }).some((line) => line.includes('переставлены'))).toBe(true);
    expect(bad(42).length).toBeGreaterThan(0);
  });

  it('профиль вправе бюджетировать только кадр: незаявленная стадия — не отказ', () => {
    const result = validateBenchProfile(
      {
        name: 'только кадр',
        deviceClass: 'tablet',
        description: 'референсного устройства ещё нет — бюджет пока один',
        budgetsMs: { frame: { p50: 8, p99: 16.6 } },
      },
      'проба',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.budgetsMs.present).toBeUndefined();
  });
});

describe('вердикт замера против бюджета (PERF-7)', () => {
  const profile: BenchProfile = {
    name: 'проба',
    deviceClass: 'desktop',
    description: 'проба',
    budgetsMs: { frame: { p50: 8, p99: 16.6 }, present: { p50: 4, p99: 9 } },
  };

  /** Замер нужной формы: probe на управляемых часах, а не рукописный объект. */
  function summaryOf(stages: readonly (readonly number[])[]): BenchSummary {
    const { probe, clock } = probeOnClock();
    for (const [index, frame] of stages.entries()) feed(probe, clock, index * 16, frame, index);
    return probe.report();
  }

  it('замер в бюджете — «сходится» по каждой заявленной строке', () => {
    const lines = benchVerdict(profile, summaryOf([[1, 1, 3, 1], [1, 1, 3, 1]]));

    expect(lines.map((line) => line.key)).toEqual([...BENCH_BUDGET_KEYS]);
    expect(lines.every((line) => benchLineFits(line))).toBe(true);
    // Стадии без бюджета вердикта не проваливают и не выдумывают.
    expect(lines.find((line) => line.key === 'draw')?.budget).toBeNull();
  });

  it('дешёвый по CPU кадр при провальном темпе — «не держится» (PERF-1)', () => {
    // Главный поток укладывается в единицы миллисекунд, а кадры приходят раз в
    // 150 мс: он ждёт GPU или vsync. Стоимость кадра об этом не говорит ничего,
    // и без отдельной сверки периода вердикт был бы «сходится» при 6.7 fps.
    const summary = summaryOf([[1, 1, 1, 1], [1, 1, 1, 1]]);
    const slow: BenchSummary = { ...summary, intervalMs: { samples: 1, p50: 150, p99: 150, max: 150 } };

    expect(benchVerdict(profile, slow).every((line) => benchLineFits(line))).toBe(true);
    expect(benchPaceFits(profile, slow)).toBe(false);
    expect(benchPaceFits(profile, summary)).toBe(true);
  });

  it('перебор по p99 одной стадии валит её строку и кадр, остальные — нет', () => {
    const lines = benchVerdict(profile, summaryOf([[1, 1, 3, 1], [1, 1, 30, 1]]));
    const present = lines.find((line) => line.key === 'present')!;
    const frame = lines.find((line) => line.key === 'frame')!;
    const camera = lines.find((line) => line.key === 'camera')!;

    expect(present.p50Fits).toBe(true);
    expect(present.p99Fits).toBe(false);
    expect(frame.p99Fits).toBe(false);
    expect(benchLineFits(camera)).toBe(true);
  });
});
