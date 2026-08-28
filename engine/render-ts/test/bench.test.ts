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
 * порог «в притык» краснел бы на слабой машине разработчика — ровно это здесь и
 * случилось, пороги в миллисекундах краснели в контейнере вдвое медленнее
 * авторского. Поэтому ассерт идёт не по миллисекундам, а по ЭТАЛОННЫМ ЕДИНИЦАМ
 * работы (`engine/tests/bench/calibration.ts`): та же нагрузка, померенная в том
 * же процессе, делит миллисекунды на скорость машины, и остаётся отношение —
 * «во сколько раз доставка дороже эталона». Машина в отношении сокращается,
 * подорожание операции — нет. Совсем от условий прогона отношение не свободно:
 * под чужой нагрузкой на машине оно наблюдалось втрое-вчетверо выше спокойного
 * (замер длиннее калибровки, и планировщик отбирает у него больше). Порядок
 * запаса это переживает, а деградация на порядок сквозь него проходит: правка,
 * сделавшая перестройку маски в 20 раз дороже при неизменных счётчиках, красит
 * все три оси разом — проверено.
 *
 * Оси — ровно те, по которым в рендер въехала регрессия пересборки маски
 * (proposal «Why»): разрешение маски 4/8, число наблюдателей, число cliff-
 * отрезков. Время печатается рядом с детерминированными счётчиками той же
 * нагрузки: «сколько работы» и «сколько это стоило» читаются одной строкой.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FogSubsystem,
  createCostCounters,
  fogSegmentsOf,
  withCostSink,
  type EntityView,
  type RenderCostCounters,
  type TickView,
} from '../src/index.js';
import { benchUnits, calibrationLine } from '../../tests/bench/calibration.js';
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
/** Поворот кольца наблюдателей на доставку, радианы — свежие входы каждой (D4). */
const ROTATION = 0.017;

const STATS = { visionRadius: 'vision', team: 'team' } as const;

interface FogAxis {
  /** Тексели маски на мировую единицу (FOW-10) — ось разрешения. */
  readonly resolution: number;
  /** Число наблюдателей своей команды — ось наблюдателей. */
  readonly observers: number;
  /** Шаг решётки возвышенных клеток; 0 — ровная арена — ось сегментов укрытий. */
  readonly pillarStep: number;
}

/**
 * Наблюдатель кольца на шаге `step` доставки. Кольцо поворачивается с каждым
 * шагом: подсистема перестраивает маску только при СМЕНЕ сигнатуры входов
 * (design D4), и повтор той же доставки мерил бы сравнение чисел, а не
 * растеризацию, — сторож стерёг бы пустоту.
 *
 * Центр и радиус кольца сдвинуты с узлов решётки укрытий намеренно:
 * наблюдатель, стоящий ровно на линии ребра, перекрыт целиком
 * (`rasterizeOnLine`, FOW-9), и ось сегментов мерила бы вырожденную ветку
 * вместо настоящей растеризации теней. Уровень наблюдателя — нулевой
 * (умолчание фикстуры): рёбра поднятых клеток выше него и тень отбрасывают
 * (PHYS-13).
 */
function observerView(index: number, count: number, step: number): EntityView {
  const angle = (index / count) * Math.PI * 2 + step * ROTATION;
  const radius = ARENA / 4 + 1;
  return makeEntityView(index + 1, {
    currX: ARENA / 2 + 0.5 + Math.cos(angle) * radius,
    currY: ARENA / 2 + 0.5 + Math.sin(angle) * radius,
    prevX: ARENA / 2,
    prevY: ARENA / 2,
    stats: new Map([
      [STATS.team, 0],
      [STATS.visionRadius, VISION],
    ]),
  });
}

function stand(axis: FogAxis): { fog: FogSubsystem; views: readonly TickView[] } {
  const grid = axis.pillarStep === 0 ? flatGrid(ARENA) : pillarGrid(ARENA, axis.pillarStep);
  const fog = new FogSubsystem({
    grid,
    stats: STATS,
    hero: () => 1,
    config: { resolution: axis.resolution },
    // Бюджет снят: сторож меряет ВРЕМЯ ОДНОЙ перестройки, а не латентность её
    // нарезки (change `fog-mask-budgeted-rebuild`, design D1). С бюджетом здесь
    // мерилось бы, за сколько кадров стенд догоняет доставку, — величина
    // каденса стенда, а не стоимости растра.
    rebuildBudget: Number.POSITIVE_INFINITY,
    createCanvas: fogCanvasFactory(),
  });
  fog.init(makeRenderContext());
  // Доставки готовятся заранее и в замер не входят: меряется перестройка маски,
  // а не сборка Map доставки.
  const views = Array.from({ length: WARMUP + DELIVERIES + 1 }, (_, step) =>
    makeTickView(
      Array.from({ length: axis.observers }, (_, i) => observerView(i, axis.observers, step)),
    ),
  );
  return { fog, views };
}

interface BenchResult {
  readonly perDeliveryMs: number;
  /** То же время в эталонных единицах машины (PERF-5) — величина, по которой ассерт. */
  readonly perDeliveryUnits: number;
  readonly cost: RenderCostCounters;
}

/**
 * Замер одной перестройки маски на каденсе доставки (design D1) — прогрев,
 * измеряемый цикл, затем отдельная доставка со стоком: счётчики снимаются ВНЕ
 * замера времени, чтобы учёт не попал в измеряемое (PERF-3).
 */
function benchFog(label: string, axis: FogAxis): BenchResult {
  const { fog, views } = stand(axis);
  // Доставка плюс её кадр: растр строит кадр (design D1), и мерить одну
  // доставку значило бы мерить сборку `Map` вместо растеризации. Рассеивание в
  // замер не входит — `dt` нулевой.
  const rebuild = (view: TickView): void => {
    fog.syncTick(view);
    fog.updateFrame(0, 0);
  };

  // Прогрев JIT перед замером.
  for (let i = 0; i < WARMUP; i++) rebuild(views[i]!);
  const t0 = performance.now();
  for (let i = 0; i < DELIVERIES; i++) rebuild(views[WARMUP + i]!);
  const perDeliveryMs = (performance.now() - t0) / DELIVERIES;
  const perDeliveryUnits = benchUnits(perDeliveryMs);

  const cost = createCostCounters();
  withCostSink(cost, () => {
    rebuild(views[WARMUP + DELIVERIES]!);
  });

  console.log(
    `[bench] маска FoW, ${label}: ${perDeliveryMs.toFixed(3)} мс/доставка ` +
      `(${perDeliveryUnits.toFixed(2)} эталонной единицы); ` +
      `тексели ${cost.fogMaskTexels}, лучи теней ${cost.fogShadowRayTests}, ` +
      `блюр ${cost.fogMaskSmoothTexels}, растр ${cost.fogMaskClearTexels}, ` +
      `загрузка ${cost.fogMaskUploadBytes} байт`,
  );
  return { perDeliveryMs, perDeliveryUnits, cost };
}

describe('замеры рендера (информативно)', () => {
  beforeAll(() => {
    // Печать при каждом прогоне (PERF-5): по этой строке читаются все
    // остальные — доставка печатается и в миллисекундах, и в её единицах.
    console.log(calibrationLine());
  });

  it('ось разрешения маски: 4 против 8 текселей на юнит (FOW-10)', () => {
    const low = benchFog('разрешение 4', { resolution: 4, observers: 4, pillarStep: 0 });
    const high = benchFog('разрешение 8', { resolution: 8, observers: 4, pillarStep: 0 });

    // Работа растёт квадратом разрешения — это видно счётчиком, а не часами.
    expect(high.cost.fogMaskClearTexels).toBe(4 * low.cost.fogMaskClearTexels);
    // Блюр кромки идёт по всему растру двумя проходами — та же квадратичность.
    expect(high.cost.fogMaskSmoothTexels).toBe(4 * low.cost.fogMaskSmoothTexels);
    // Сторожевые пороги — в эталонных единицах машины (PERF-5): наблюдаемое
    // отношение 0.4…0.5 и 1.7…1.9 единицы на доставку, порог на порядок выше.
    // Разница машин в отношении сокращается, подорожание доставки — нет.
    expect(low.perDeliveryUnits).toBeLessThan(5);
    expect(high.perDeliveryUnits).toBeLessThan(20);
  });

  it('ось наблюдателей: 1 против 12 кругов на той же маске', () => {
    const one = benchFog('1 наблюдатель', { resolution: 4, observers: 1, pillarStep: 0 });
    const many = benchFog('12 наблюдателей', { resolution: 4, observers: 12, pillarStep: 0 });

    expect(many.cost.fogRevealCalls).toBe(12);
    // Наблюдаемое — 0.25 и 0.6 эталонной единицы на доставку; порог на порядок выше.
    expect(one.perDeliveryUnits).toBeLessThan(3);
    expect(many.perDeliveryUnits).toBeLessThan(8);
  });

  it('ось сегментов укрытий: ровная арена против решётки обрывов (FOW-9)', () => {
    const bare = benchFog('без укрытий', { resolution: 4, observers: 4, pillarStep: 0 });
    const dense = benchFog('решётка обрывов', { resolution: 4, observers: 4, pillarStep: 6 });

    expect(fogSegmentsOf(pillarGrid(ARENA, 6)).length).toBeGreaterThan(0);
    // Наблюдатели решётки — на нулевом уровне, клетки решётки подняты: рёбра
    // тень отбрасывают, и теневой путь на этой оси действительно исполняется
    // (`segmentCasts`, FOW-9, PHYS-13).
    expect(bare.cost.fogShadowRayTests).toBe(0);
    expect(dense.cost.fogShadowRayTests).toBeGreaterThan(0);
    // Наблюдаемое — 0.36 эталонной единицы против 1.1: сама решётка обрывов и
    // есть тот класс стоимости, ради которого сторож стоит; порог на порядок выше.
    expect(bare.perDeliveryUnits).toBeLessThan(4);
    expect(dense.perDeliveryUnits).toBeLessThan(10);
  });
});
