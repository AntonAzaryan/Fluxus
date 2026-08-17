/**
 * Сторожевые числа рендера (`performance-budget` PERF-5, задача 3.1). Не
 * микробенчмарк-сьют и не гейт стоимости: точный контроль объёма работы держат
 * счётчики (PERF-3, PERF-4), а здесь меряется реальное время — то, чего
 * счётчики не видят, константное замедление на единицу работы.
 *
 * Конвенции — те же, что у замеров канала (`client-ts/test/bench.test.ts`):
 * прогрев JIT, `performance.now()` вокруг измеряемого цикла, печать `[bench]`
 * при каждом прогоне, ассерт ТОЛЬКО против деградации на порядок. Жёстких
 * порогов здесь MUST NOT быть (PERF-5): числа между машинами несравнимы, и
 * порог «в притык» краснел бы на слабой машине разработчика.
 *
 * Оси — ровно те, по которым в рендер въехала регрессия пересборки маски
 * (proposal «Why»): разрешение маски 4/8, число наблюдателей, число cliff-
 * отрезков. Время печатается рядом с детерминированными счётчиками той же
 * нагрузки: «сколько работы» и «сколько это стоило» читаются одной строкой.
 */
import { describe, expect, it } from 'vitest';
import {
  FogSubsystem,
  createCostCounters,
  fogSegmentsOf,
  withCostSink,
  type EntityView,
  type RenderCostCounters,
  type TickView,
} from '../src/index.js';
import {
  flatGrid,
  fogCanvasFactory,
  makeEntityView,
  makeRenderContext,
  makeTickView,
  pillarGrid,
} from './fixtures.js';

/** Арена крупнее демо-сцены: сторож должен ловить регрессию с запасом. */
const ARENA = 48;
const VISION = 8;
const WARMUP = 5;
const DELIVERIES = 20;

const STATS = { visionRadius: 'vision', team: 'team' } as const;

interface FogAxis {
  /** Тексели маски на мировую единицу (FOW-10) — ось разрешения. */
  readonly resolution: number;
  /** Число наблюдателей своей команды — ось наблюдателей. */
  readonly observers: number;
  /** Шаг решётки возвышенных клеток; 0 — ровная арена — ось сегментов укрытий. */
  readonly pillarStep: number;
}

function observerView(index: number, count: number): EntityView {
  // Наблюдатели раскладываются по кольцу внутри арены: круги пересекаются, как
  // на живой сцене, но краем маски не срезаются.
  const angle = (index / count) * Math.PI * 2;
  const radius = ARENA / 4;
  return makeEntityView(index + 1, {
    currX: ARENA / 2 + Math.cos(angle) * radius,
    currY: ARENA / 2 + Math.sin(angle) * radius,
    prevX: ARENA / 2,
    prevY: ARENA / 2,
    stats: new Map([
      [STATS.team, 0],
      [STATS.visionRadius, VISION],
    ]),
  });
}

function stand(axis: FogAxis): { fog: FogSubsystem; view: TickView } {
  const grid = axis.pillarStep === 0 ? flatGrid(ARENA) : pillarGrid(ARENA, axis.pillarStep);
  const fog = new FogSubsystem({
    grid,
    stats: STATS,
    hero: () => 1,
    config: { resolution: axis.resolution },
    createCanvas: fogCanvasFactory(),
  });
  fog.init(makeRenderContext());
  const view = makeTickView(
    Array.from({ length: axis.observers }, (_, i) => observerView(i, axis.observers)),
  );
  return { fog, view };
}

interface BenchResult {
  readonly perDeliveryMs: number;
  readonly cost: RenderCostCounters;
}

/**
 * Замер одной перестройки маски на каденсе доставки (design D1) — прогрев,
 * измеряемый цикл, затем отдельная доставка со стоком: счётчики снимаются ВНЕ
 * замера времени, чтобы учёт не попал в измеряемое (PERF-3).
 */
function benchFog(label: string, axis: FogAxis): BenchResult {
  const { fog, view } = stand(axis);

  // Прогрев JIT перед замером.
  for (let i = 0; i < WARMUP; i++) fog.syncTick(view);
  const t0 = performance.now();
  for (let i = 0; i < DELIVERIES; i++) fog.syncTick(view);
  const perDeliveryMs = (performance.now() - t0) / DELIVERIES;

  const cost = createCostCounters();
  withCostSink(cost, () => {
    fog.syncTick(view);
  });

  console.log(
    `[bench] маска FoW, ${label}: ${perDeliveryMs.toFixed(3)} мс/доставка; ` +
      `тексели ${cost.fogMaskTexels}, тесты субсэмплов ${cost.fogSubsampleTests}, ` +
      `растр ${cost.fogMaskClearTexels}, загрузка ${cost.fogMaskUploadBytes} байт`,
  );
  return { perDeliveryMs, cost };
}

describe('замеры рендера (информативно)', () => {
  it('ось разрешения маски: 4 против 8 текселей на юнит (FOW-10)', () => {
    const low = benchFog('разрешение 4', { resolution: 4, observers: 4, pillarStep: 0 });
    const high = benchFog('разрешение 8', { resolution: 8, observers: 4, pillarStep: 0 });

    // Работа растёт квадратом разрешения — это видно счётчиком, а не часами.
    expect(high.cost.fogMaskClearTexels).toBe(4 * low.cost.fogMaskClearTexels);
    // Сторожевые пороги: на порядок выше наблюдаемого (0.3 и 1.1 мс на машине
    // разработчика) — ловят деградацию, а не разницу машин (PERF-5).
    expect(low.perDeliveryMs).toBeLessThan(4);
    expect(high.perDeliveryMs).toBeLessThan(15);
  });

  it('ось наблюдателей: 1 против 12 кругов на той же маске', () => {
    const one = benchFog('1 наблюдатель', { resolution: 4, observers: 1, pillarStep: 0 });
    const many = benchFog('12 наблюдателей', { resolution: 4, observers: 12, pillarStep: 0 });

    expect(many.cost.fogRevealCalls).toBe(12);
    // Наблюдаемое — 0.2 и 0.6 мс на доставку; порог на порядок выше.
    expect(one.perDeliveryMs).toBeLessThan(3);
    expect(many.perDeliveryMs).toBeLessThan(8);
  });

  it('ось сегментов укрытий: ровная арена против решётки обрывов (FOW-9)', () => {
    const bare = benchFog('без укрытий', { resolution: 4, observers: 4, pillarStep: 0 });
    const dense = benchFog('решётка обрывов', { resolution: 4, observers: 4, pillarStep: 6 });

    expect(fogSegmentsOf(pillarGrid(ARENA, 6)).length).toBeGreaterThan(0);
    expect(bare.cost.fogSubsampleTests).toBe(0);
    expect(dense.cost.fogSubsampleTests).toBeGreaterThan(0);
    // Наблюдаемое — 0.3 мс против 8.8 мс: сама решётка обрывов и есть тот
    // класс стоимости, ради которого сторож стоит; порог на порядок выше.
    expect(bare.perDeliveryMs).toBeLessThan(4);
    expect(dense.perDeliveryMs).toBeLessThan(100);
  });
});
