/**
 * Голден-гейт стоимости (`performance-budget` PERF-4, PERF-6) — точная сверка
 * детерминированных счётчиков объёма работы с закоммиченным эталоном.
 *
 * ## Что сверяется
 *
 * - На каждом записанном матче (CLI-10) — `engine/tests/golden/<матч>.cost.json`:
 *   счётчики трёх стадий конвейера (PERF-2). Стадия `tick` приезжает записями
 *   диагностики ядра (DIAG-1, уровень `systems`), стадии `syncTick` и `frame` —
 *   стоком счётчиков рендера; принадлежность счётчика стадии объявляет сам
 *   рендер (`COST_COUNTER_STAGES`), а не догадка этого файла.
 *   Одна и та же запись прогоняется ДВАЖДЫ — на пресетах «производительность» и
 *   «ультра» (`render-quality` QUAL-4, design D5): у каждого своя секция
 *   документа, поэтому удорожание пути, работающего и на слабых устройствах,
 *   краснеет отдельной строкой диффа, а не тонет в общем. Стадия `tick` в
 *   документе ОДНА: симуляция от пресета не зависит (QUAL-2), и равенство её
 *   счётчиков между двумя прогонами — часть проверки, а не допущение.
 * - На синтетических осях стоимости (PERF-6) — `engine/tests/golden/scaling.cost.json`:
 *   два размера на ось (число сущностей, наблюдателей, сегментов укрытий,
 *   разрешение маски), чтобы суперлинейный рост читался отношением L/S прямо в
 *   диффе эталона.
 *
 * Значения машинно-независимы по конструкции: ни времени, ни случайности, ни
 * GPU в них нет (PERF-3). Реальное время стережёт `bench.test.ts` — и только на
 * порядок (PERF-5).
 *
 * ## Регенерация
 *
 * `npm run golden:cost` (UPDATE_COST=1) переписывает эталоны стоимости.
 * Отдельной командой, а не вместе с `npm run golden`: удорожание принимается
 * осознанным жестом с диффом на ревью (PERF-4), а не паровозом с эталонами
 * поведения. Перезапись матчей (`npm run record`) меняет и нагрузку — тогда
 * `golden:cost` идёт следом в том же коммите.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiagnosticsSink } from '@game-mvp/core';
import {
  COST_COUNTER_STAGES,
  createCostCounters,
  withCostSink,
  type CostStage,
  type RenderCostCounters,
} from '@game-mvp/render';
import {
  BENCH_PRESETS,
  BENCH_PRESET_NAMES,
  GOLDEN_DIR,
  MATCH_STAND,
  PresentationBench,
  RECORDED_MATCHES,
  benchGrid,
  loadRecording,
  matchBench,
  playRecording,
  syntheticTick,
  type BenchPresetName,
  type SyntheticLoad,
} from './benchLoad.js';

const UPDATE = process.env.UPDATE_COST === '1';

/** Плоский набор именованных счётчиков одной стадии — то, что лежит в эталоне. */
type StageCost = Record<string, number>;

// --------------------------------------------------------- счётчики стадии tick

/**
 * Сводка стоимости тика (PERF-3) — сумма записей `TICK_COST` за прогон. `ticks`
 * считает сами записи: без него по эталону не прочесть, во сколько обошёлся
 * тик, а «сколько всего» и «сколько на тик» на ревью нужны оба.
 */
interface TickCost extends StageCost {
  broadPhasePairs: number;
  commandsApplied: number;
  expressions: number;
  raycasts: number;
  ticks: number;
}

function tickCostCollector(): { readonly sink: DiagnosticsSink; readonly total: TickCost } {
  const total: TickCost = { broadPhasePairs: 0, commandsApplied: 0, expressions: 0, raycasts: 0, ticks: 0 };
  const sink: DiagnosticsSink = {
    // Границы систем достаточно: сводка стоимости — штатная телеметрия DIAG-3,
    // полного потока команд ей не нужно, а он стоил бы прогону на порядок.
    trace: 'systems',
    record: (entry) => {
      if (entry.code !== 'TICK_COST') return;
      total.ticks++;
      // Данные записи объявлены как «число или строка» (DIAG-2); счётчики
      // стоимости — всегда числа, и `Number` здесь только сужает тип.
      total.broadPhasePairs += Number(entry.data?.broadPhasePairs ?? 0);
      total.commandsApplied += Number(entry.data?.commandsApplied ?? 0);
      total.expressions += Number(entry.data?.expressions ?? 0);
      total.raycasts += Number(entry.data?.raycasts ?? 0);
    },
  };
  return { sink, total };
}

// ------------------------------------------------------- сборка документа эталона

/** Ключи по алфавиту: порядок эталона не должен зависеть от порядка объявления. */
function sorted(cost: StageCost): StageCost {
  const out: StageCost = {};
  for (const name of Object.keys(cost).sort()) out[name] = cost[name]!;
  return out;
}

/**
 * Счётчики рендера, разложенные по стадиям (PERF-2). Раскладка берётся из
 * объявления пакета — счётчик без стадии не существует, и это стережёт тест
 * `render-ts`, а не догадка по имени.
 */
function renderStages(counters: RenderCostCounters): Record<CostStage, StageCost> {
  const stages: Record<CostStage, StageCost> = { frame: {}, syncTick: {} };
  for (const name of Object.keys(counters).sort()) {
    const key = name as keyof RenderCostCounters;
    stages[COST_COUNTER_STAGES[key]][key] = counters[key];
  }
  return stages;
}

/** Стоимость одного прогона записи: сводка тика и счётчики рендера. */
interface MatchRun {
  readonly tick: TickCost;
  readonly render: RenderCostCounters;
  /** Действующее разрешение маски прогона — сценное под потолком (design D3). */
  readonly maskResolution: number;
}

/**
 * Прогон записанного матча со снятыми счётчиками обеих сторон: один и тот же
 * тик кормит и сводку ядра, и презентационный тракт — иначе стадии считались бы
 * на разных мирах.
 *
 * Стенд строится ДО подключения стока: работа сборки подсистем (и пересборка
 * маски под потолком пресета) — стоимость сборки, а не доставки, и в эталон
 * стадии `syncTick` ей входить незачем; сам аплоад маски считается один раз
 * на фактическую загрузку — на первой доставке.
 */
function runMatch(name: string, preset: BenchPresetName): MatchRun {
  const def = loadRecording(name);
  const bench = matchBench(BENCH_PRESETS[preset]);
  const { sink, total } = tickCostCollector();
  const counters = createCostCounters();
  withCostSink(counters, () => {
    playRecording(def, { diagnostics: sink, onTick: (result) => { bench.step(result); } });
  });
  // Две бухгалтерии проходов рендерера обязаны сойтись: подсистема считает их
  // сама, спай видит вызовы (design D2). Расхождение — счётчик врёт.
  expect(counters.fogRenderPasses).toBe(bench.renderer.renders);
  return { tick: total, render: counters, maskResolution: bench.maskResolution };
}

/**
 * Документ эталона матча (design D5): стадия тика ОДИН раз, стадии доставки и
 * кадра — секцией на пресет. Разложение именно такое, потому что таково
 * положение дел: симуляция пресета не знает (QUAL-2), а картинка знает.
 */
function measureMatch(name: string): unknown {
  const presets: Record<string, unknown> = {};
  let tick: StageCost | null = null;
  for (const preset of BENCH_PRESET_NAMES) {
    const run = runMatch(name, preset);
    const cost = sorted(run.tick);
    // Инвариантность симуляции — проверка, а не декларация (QUAL-2, design D6):
    // счётчики тика двух прогонов обязаны совпасть до единицы, иначе пресет
    // как-то дотянулся до мира. Побитовая сверка канонического лога — в
    // `qualityInvariance.test.ts`; здесь то же утверждение стоит даром.
    if (tick === null) tick = cost;
    else expect(cost, `${name}/${preset}: стадия tick`).toEqual(tick);
    const stages = renderStages(run.render);
    presets[preset] = { frame: stages.frame, syncTick: stages.syncTick };
  }
  return { tick, ...presets };
}

// -------------------------------------------------- оси масштабирования (PERF-6)

/** Сторона синтетической арены в клетках — общая у всех осей. */
const SCALING_EXTENT = 16;
/** Шаг решётки укрытий по умолчанию: без укрытий теневой путь маски мёртв (FOW-9). */
const SCALING_PILLARS = 4;

const BASE_LOAD: SyntheticLoad = {
  entities: 64,
  observers: 4,
  vision: 1.5,
  extent: SCALING_EXTENT,
};

interface ScalingSize {
  /** Величина оси — то единственное, чем размеры и различаются. */
  readonly magnitude: number;
  readonly pillarStep: number;
  readonly resolution: number;
  readonly load: SyntheticLoad;
}

interface ScalingAxis {
  readonly axis: string;
  readonly small: ScalingSize;
  readonly large: ScalingSize;
}

function size(magnitude: number, over: Partial<ScalingSize> = {}): ScalingSize {
  return {
    magnitude,
    pillarStep: SCALING_PILLARS,
    resolution: 4,
    load: BASE_LOAD,
    ...over,
  };
}

/** Сколько cliff-отрезков даёт решётка укрытий шагом `step` — величина своей оси. */
function segmentsOf(step: number): number {
  return benchGrid(SCALING_EXTENT, step).cliffs.length;
}

/**
 * Оси стоимости и их размеры S/L (PERF-6). Каждая ось двигает РОВНО одну
 * величину — иначе отношение L/S нечего было бы приписать.
 */
const AXES: readonly ScalingAxis[] = [
  {
    axis: 'entities',
    small: size(32, { load: { ...BASE_LOAD, entities: 32 } }),
    large: size(256, { load: { ...BASE_LOAD, entities: 256 } }),
  },
  {
    axis: 'fogObservers',
    small: size(4, { load: { ...BASE_LOAD, observers: 4 } }),
    large: size(32, { load: { ...BASE_LOAD, observers: 32 } }),
  },
  {
    axis: 'cliffSegments',
    small: size(segmentsOf(8), { pillarStep: 8 }),
    large: size(segmentsOf(2), { pillarStep: 2 }),
  },
  {
    axis: 'maskResolution',
    small: size(4, { resolution: 4 }),
    large: size(8, { resolution: 8 }),
  },
];

/**
 * Одна доставка и один кадр синтетической нагрузки под снятым замером.
 *
 * Пресета у осей нет намеренно (стенд без документа — ультра, то есть без
 * потолков): ось «разрешение маски» ДВИГАЕТ ту самую величину, которую потолок
 * ограничивает, и второй пресет мерил бы здесь не рост стоимости от разрешения,
 * а работу min() — она проверена на матчах (QUAL-4) и в `render-ts`.
 */
function measureSize(config: ScalingSize): RenderCostCounters {
  const bench = new PresentationBench({
    grid: benchGrid(SCALING_EXTENT, config.pillarStep),
    resolution: config.resolution,
  });
  const ext = syntheticTick(config.load);
  const counters = createCostCounters();
  withCostSink(counters, () => {
    bench.deliver(ext);
  });
  expect(counters.fogRenderPasses).toBe(bench.renderer.renders);
  return counters;
}

/**
 * Документ осей: величины обоих размеров рядом со счётчиками обоих размеров.
 * Список, а не словарь, чтобы порядок «сначала S, потом L» читался в диффе —
 * отношение L/S и есть то, ради чего эталон заведён.
 */
function scalingDocument(): unknown {
  return {
    axes: AXES.map((axis) => ({
      axis: axis.axis,
      small: axis.small.magnitude,
      large: axis.large.magnitude,
      cost: {
        small: renderStages(measureSize(axis.small)),
        large: renderStages(measureSize(axis.large)),
      },
    })),
  };
}

// --------------------------------------------------------------- сверка эталона

/** Канонический вид эталона — тот же, что у golden-пар ядра (SER-6, CLI-5). */
function canonical(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function checkGolden(file: string, document: unknown): void {
  const path = join(GOLDEN_DIR, file);
  const produced = canonical(document);
  if (UPDATE) {
    writeFileSync(path, produced);
    return;
  }
  const expected = readFileSync(path, 'utf8');
  // Структурная сверка первой: её дифф называет счётчик и обе величины —
  // «во сколько раз подорожало» видно без чтения строк файла (PERF-4).
  if (produced !== expected) {
    expect(JSON.parse(produced)).toEqual(JSON.parse(expected) as unknown);
  }
  expect(produced).toBe(expected);
}

describe('PERF-4: голден-гейт стоимости на записанных матчах (CLI-10)', () => {
  it('набор бенча — все записи матчей golden-набора', () => {
    const recorded = readdirSync(GOLDEN_DIR)
      .filter((name) => name.startsWith('match-') && name.endsWith('.scenario.json'))
      .map((name) => name.slice(0, -'.scenario.json'.length))
      .sort();
    expect([...RECORDED_MATCHES].sort()).toEqual(recorded);
  });

  for (const match of RECORDED_MATCHES) {
    it(`${match}: счётчики стадий совпадают с эталоном`, () => {
      checkGolden(`${match}.cost.json`, measureMatch(match));
    });
  }

  it('счётчики бенча не мёртвые: каждая стадия сделала работу на каждом пресете', () => {
    const document = measureMatch('match-fuzz') as Record<string, StageCost | Record<string, StageCost>>;
    const stages: [string, StageCost][] = [['tick', document.tick as StageCost]];
    for (const preset of BENCH_PRESET_NAMES) {
      const section = document[preset] as Record<string, StageCost>;
      stages.push([`${preset}/syncTick`, section.syncTick!], [`${preset}/frame`, section.frame!]);
    }
    for (const [where, cost] of stages) {
      const moved = Object.values(cost).filter((value) => value > 0);
      expect(moved.length, where).toBeGreaterThan(0);
    }
    expect((document.tick as StageCost).ticks).toBe(loadRecording('match-fuzz').ticks);
  });

  it('QUAL-4: потолок производительного пресета кусает — грубая маска дешевле авторской', () => {
    const performance = runMatch('match-walk', 'performance');
    const ultra = runMatch('match-walk', 'ultra');

    // Сценное значение стенда остаётся авторским потолком (FOW-10, design D3):
    // ультра показывает его как есть, производительный режим ограничивает.
    expect(ultra.maskResolution).toBe(MATCH_STAND.resolution);
    expect(performance.maskResolution).toBe(BENCH_PRESETS.performance['fog.maskResolution']);
    // Полномасочная работа растёт квадратом разрешения — вдвое грубее маска
    // вчетверо дешевле, и ровно эту строку диффа гейт и заводился стеречь.
    expect(ultra.render.fogMaskClearTexels).toBe(4 * performance.render.fogMaskClearTexels);
    expect(ultra.render.fogMaskUploadBytes).toBe(4 * performance.render.fogMaskUploadBytes);
    expect(ultra.render.fogMinimapTexels).toBe(4 * performance.render.fogMinimapTexels);
    // Доставка и кадр от пресета не зависят: сущностей столько же, подсистем
    // столько же — качество меняет подачу картинки, а не состав состояния (QUAL-2).
    expect(ultra.render.syncTickInstances).toBe(performance.render.syncTickInstances);
    expect(ultra.render.frameInstances).toBe(performance.render.frameInstances);
  });

  it('QUAL-1: значения ручек приезжают стенду контроллером, а не мимо него', () => {
    const bench = matchBench(BENCH_PRESETS.performance);

    // Реестр стенда собран из деклараций ЕГО подсистем (design D1): туман ручку
    // объявил, подсистема позиций ручек не имеет и в реестре не появляется.
    expect(bench.quality.knobs.map((knob) => knob.name)).toEqual(['fog.maskResolution']);
    expect(bench.quality.effective().get('fog.maskResolution')).toBe(
      BENCH_PRESETS.performance['fog.maskResolution'],
    );
    // Прочие ручки документа стенду не адресованы — их подсистем здесь нет
    // вовсе. Это не «неизвестные» ручки, а не объявленные на этой сцене: состав
    // документа проверяется против СОБРАННОГО реестра, и регистрация вправе
    // прийти позже применения пресета (QUAL-1).
    expect(bench.maskResolution).toBe(BENCH_PRESETS.performance['fog.maskResolution']);
  });
});

describe('PERF-6: оси масштабирования бенч-нагрузки', () => {
  it('scaling.cost.json: счётчики обоих размеров совпадают с эталоном', () => {
    checkGolden('scaling.cost.json', scalingDocument());
  });

  it('разрешение маски 4 → 8: полномасочная работа ровно вчетверо', () => {
    const axis = AXES.find((item) => item.axis === 'maskResolution')!;
    const low = measureSize(axis.small);
    const high = measureSize(axis.large);
    // Обнуление, загрузка в текстуру и блит миникарты идут по всему растру:
    // удвоение разрешения — четырёхкратное удорожание (FOW-10). Это ровно
    // половина той регрессии, ради которой заведён гейт.
    expect(high.fogMaskClearTexels).toBe(4 * low.fogMaskClearTexels);
    expect(high.fogMaskUploadBytes).toBe(4 * low.fogMaskUploadBytes);
    expect(high.fogMinimapTexels).toBe(4 * low.fogMinimapTexels);
    // Тесты субсэмплов против укрытий — вторая её половина (FOW-9).
    expect(low.fogSubsampleTests).toBeGreaterThan(0);
    expect(high.fogSubsampleTests).toBeGreaterThan(low.fogSubsampleTests);
  });

  it('число наблюдателей: reveal-полигоны кратны ему, полномасочная работа — нет', () => {
    const axis = AXES.find((item) => item.axis === 'fogObservers')!;
    const few = measureSize(axis.small);
    const many = measureSize(axis.large);
    expect(few.fogRevealCalls).toBe(axis.small.magnitude);
    expect(many.fogRevealCalls).toBe(axis.large.magnitude);
    expect(many.fogMaskClearTexels).toBe(few.fogMaskClearTexels);
  });

  it('число сегментов укрытий: отбор в радиус растёт вместе с ним', () => {
    const axis = AXES.find((item) => item.axis === 'cliffSegments')!;
    const few = measureSize(axis.small);
    const many = measureSize(axis.large);
    expect(axis.large.magnitude).toBeGreaterThan(axis.small.magnitude);
    // Отбор укрытий — проход по всем сегментам сетки на наблюдателя (FOW-9).
    expect(few.fogSegmentRangeTests).toBe(axis.small.magnitude * BASE_LOAD.observers);
    expect(many.fogSegmentRangeTests).toBe(axis.large.magnitude * BASE_LOAD.observers);
  });

  it('число сущностей: доставка растёт с ним, маска — нет', () => {
    const axis = AXES.find((item) => item.axis === 'entities')!;
    const few = measureSize(axis.small);
    const many = measureSize(axis.large);
    const ratio = axis.large.magnitude / axis.small.magnitude;
    expect(many.syncTickInstances).toBe(ratio * few.syncTickInstances);
    expect(many.fogEntitiesScanned).toBe(ratio * few.fogEntitiesScanned);
    expect(many.frameInstances).toBe(ratio * few.frameInstances);
    // Наблюдателей столько же — маска от толпы зрителей не дорожает.
    expect(many.fogMaskTexels).toBe(few.fogMaskTexels);
  });
});

describe('PERF-3: счётчики машинно-независимы', () => {
  it('повторный прогон в одном процессе даёт побитово тот же документ', () => {
    for (const match of RECORDED_MATCHES) {
      const first = measureMatch(match);
      const second = measureMatch(match);
      expect(second).toEqual(first);
      expect(canonical(second)).toBe(canonical(first));
    }
  });

  it('оси масштабирования повторяются так же', () => {
    const first = scalingDocument();
    expect(scalingDocument()).toEqual(first);
    expect(canonical(scalingDocument())).toBe(canonical(first));
  });
});
