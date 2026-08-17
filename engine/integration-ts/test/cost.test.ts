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
  GOLDEN_DIR,
  MATCH_STAT_SOURCES,
  PresentationBench,
  RECORDED_MATCHES,
  benchGrid,
  loadRecording,
  playRecording,
  syntheticTick,
  type SyntheticLoad,
} from './benchLoad.js';

const UPDATE = process.env.UPDATE_COST === '1';

/** Плоский набор именованных счётчиков одной стадии — то, что лежит в эталоне. */
type StageCost = Record<string, number>;

/** Арена презентационного стенда матча: 8×8 клеток, укрытия решёткой шагом 2. */
const MATCH_GRID = { extent: 8, pillarStep: 2, resolution: 4 } as const;

// --------------------------------------------------------- счётчики стадии tick

/**
 * Сводка стоимости тика (PERF-3) — сумма записей `TICK_COST` за прогон. `ticks`
 * считает сами записи: без него по эталону не прочесть, во сколько обошёлся
 * тик, а «сколько всего» и «сколько на тик» на ревью нужны оба.
 */
interface TickCost extends StageCost {
  broadPhasePairs: number;
  commands: number;
  expressions: number;
  raycasts: number;
  ticks: number;
}

function tickCostCollector(): { readonly sink: DiagnosticsSink; readonly total: TickCost } {
  const total: TickCost = { broadPhasePairs: 0, commands: 0, expressions: 0, raycasts: 0, ticks: 0 };
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
      total.commands += Number(entry.data?.commands ?? 0);
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

/** Документ эталона матча: три стадии конвейера, ключи по алфавиту. */
function matchDocument(tickCost: TickCost, render: RenderCostCounters): unknown {
  const stages = renderStages(render);
  return { frame: stages.frame, syncTick: stages.syncTick, tick: sorted(tickCost) };
}

/**
 * Прогон записанного матча со снятыми счётчиками обеих сторон: один и тот же
 * тик кормит и сводку ядра, и презентационный тракт — иначе стадии считались бы
 * на разных мирах.
 *
 * Стенд строится ДО подключения стока: разовая загрузка маски в текстуру при
 * создании подсистемы — стоимость сборки, а не доставки, и в эталон стадии
 * `syncTick` ей входить незачем.
 */
function measureMatch(name: string): unknown {
  const def = loadRecording(name);
  const bench = new PresentationBench({
    grid: benchGrid(MATCH_GRID.extent, MATCH_GRID.pillarStep),
    resolution: MATCH_GRID.resolution,
    stats: MATCH_STAT_SOURCES,
  });
  const { sink, total } = tickCostCollector();
  const counters = createCostCounters();
  withCostSink(counters, () => {
    playRecording(def, { diagnostics: sink, onTick: (result) => { bench.step(result); } });
  });
  // Две бухгалтерии проходов рендерера обязаны сойтись: подсистема считает их
  // сама, спай видит вызовы (design D2). Расхождение — счётчик врёт.
  expect(counters.fogRenderPasses).toBe(bench.renderer.renders);
  return matchDocument(total, counters);
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

/** Одна доставка и один кадр синтетической нагрузки под снятым замером. */
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

  it('счётчики бенча не мёртвые: каждая стадия сделала работу', () => {
    const document = measureMatch('match-fuzz') as Record<string, StageCost>;
    for (const stage of ['tick', 'syncTick', 'frame']) {
      const cost = document[stage]!;
      const moved = Object.values(cost).filter((value) => value > 0);
      expect(moved.length, stage).toBeGreaterThan(0);
    }
    expect(document.tick!.ticks).toBe(loadRecording('match-fuzz').ticks);
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
