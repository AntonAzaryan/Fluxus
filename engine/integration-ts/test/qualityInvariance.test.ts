/**
 * Инварианты пресета качества (`render-quality` QUAL-2, задачи 4.1 и 4.2):
 * уровень качества картинки не меняет ни симуляцию, ни информацию, доступную
 * игроку.
 *
 * ## Что здесь доказывается
 *
 * - **Симуляция** (задача 4.1, design D6): одна записанная нагрузка (CLI-10)
 *   прогоняется дважды — под «производительным» и «ультра» документами пресета,
 *   с ЖИВЫМ презентационным трактом на каждом тике, — и канонический лог
 *   симуляции сравнивается побитово. Прогон с подключённой презентацией, а не
 *   голая симуляция, — в этом весь смысл: доказывать нечего, если тракт, на
 *   который пресет и действует, к миру не подключён.
 * - **Информация** (задача 4.2): состав доставленного состояния — те же тики и
 *   те же сущности на обоих пресетах (`netcode` NET-12: кому что видно, решает
 *   фильтр снапшота симуляции, а не подсистема рендера), и консервативность
 *   грубой маски видимости (`fog-of-war` FOW-9) — производительный потолок
 *   разрешения не открывает игроку ничего сверх того, что открыто на авторском.
 *
 * Стенд и документы пресетов — общие с гейтом стоимости (`benchLoad.ts`): у
 * QUAL-2 и QUAL-4 обязана быть ОДНА нагрузка, иначе «бюджет» и «инвариант»
 * меряли бы разные миры. Подсистем на этом стенде пять — туман, позиции,
 * террейн, модели и частицы, — и инвариант оттого сильнее: пресет действует на
 * ярус носителя (REND-20), уровень детализации (REND-22), плотность эмиссии
 * (REND-24) и разбиение поверхности (REND-9) разом, а лог симуляции обязан
 * остаться тем же байт в байт.
 */
import { describe, expect, it } from 'vitest';
import {
  fnv1a32,
  jsonSerializer,
  prettyJsonSerializer,
  snapshotToPlain,
  takeSnapshot,
  type PlainSnapshot,
} from '@game-mvp/core';
import {
  createCostCounters,
  withCostSink,
  type RenderCostCounters,
  type TickView,
  type VisibilityMask,
} from '@game-mvp/render';
import {
  BENCH_PRESETS,
  FOG_STATS,
  MATCH_STAND,
  PresentationBench,
  RECORDED_MATCHES,
  benchGrid,
  loadRecording,
  matchBench,
  playRecording,
  syntheticTick,
  type BenchPresetName,
} from './benchLoad.js';

const decoder = new TextDecoder();

// ------------------------------------------- 4.1: симуляция не знает о пресете

/** Итог одного прогона записи под одним документом пресета. */
interface PresetRun {
  /**
   * Канонический лог симуляции: снапшот на тик в том же представлении, в каком
   * их пишет прогон сценария (CLI-3) и хранят golden-пары ядра (SER-6).
   */
  readonly log: string;
  /**
   * Отпечаток каждого тика. Нужен ради ДИАГНОСТИКИ: расхождение лога длиной в
   * матч читать нечем, а список отпечатков называет первый разошедшийся тик.
   */
  readonly digests: readonly number[];
  /** Состав доставленного состояния по тикам: «тик → сущности» (NET-12). */
  readonly delivered: readonly string[];
  /** Действующее разрешение маски — сценное под потолком пресета (FOW-10). */
  readonly maskResolution: number;
  readonly render: RenderCostCounters;
}

/** Состав доставки одной строкой: тик и его сущности по возрастанию ID. */
function composition(view: TickView): string {
  const ids = [...view.entities.keys()].sort((a, b) => a - b);
  return `${view.tick}: ${ids.join(',')}`;
}

/**
 * Прогон записанного матча с презентационным трактом под документом пресета.
 * Мир идёт своим ходом, `TickResult` каждого тика уходит в тракт, и оттуда же
 * снимается канонический лог: и симуляция, и картинка — одного прогона.
 */
function playUnder(match: string, preset: BenchPresetName): PresetRun {
  const bench = matchBench(BENCH_PRESETS[preset]);
  const records: PlainSnapshot[] = [];
  const digests: number[] = [];
  const delivered: string[] = [];
  const counters = createCostCounters();
  withCostSink(counters, () => {
    playRecording(loadRecording(match), {
      onTick: (result) => {
        bench.step(result);
        const record = snapshotToPlain(takeSnapshot(result.state));
        records.push(record);
        digests.push(fnv1a32(jsonSerializer.encode(record)));
        delivered.push(composition(bench.buffer.view));
      },
    });
  });
  return {
    log: decoder.decode(prettyJsonSerializer.encode(records)),
    digests,
    delivered,
    maskResolution: bench.maskResolution,
    render: counters,
  };
}

/**
 * Прогоны записи на обоих пресетах. Считаются один раз на матч: тесты 4.1 и 4.2
 * смотрят на одну и ту же пару прогонов с разных сторон, а не на две похожие.
 */
const RUNS = new Map<string, Record<BenchPresetName, PresetRun>>();

function runsOf(match: string): Record<BenchPresetName, PresetRun> {
  const cached = RUNS.get(match);
  if (cached !== undefined) return cached;
  const runs = { performance: playUnder(match, 'performance'), ultra: playUnder(match, 'ultra') };
  RUNS.set(match, runs);
  return runs;
}

describe('QUAL-2: симуляция не зависит от пресета качества (задача 4.1, design D6)', () => {
  for (const match of RECORDED_MATCHES) {
    it(`${match}: канонический лог симуляции совпадает побитово`, () => {
      const { performance, ultra } = runsOf(match);

      // Прежде инварианта — доказательство, что проверять было что: пресеты
      // обязаны РАЗОЙТИСЬ в картинке, иначе «лог совпал» не значит ничего.
      // Расходятся они не в одном месте, а в трёх подсистемах сразу: маска
      // грубее (FOW-10), инстансы несут геометрию грубого уровня цепочки
      // (REND-22) и поверхность разбита реже (REND-9).
      expect(performance.maskResolution).toBeLessThan(ultra.maskResolution);
      expect(performance.render.fogMaskUploadBytes).toBeLessThan(ultra.render.fogMaskUploadBytes);
      expect(performance.render.modelsBatchTriangles).toBeLessThan(ultra.render.modelsBatchTriangles);
      expect(performance.render.terrainFloorQuads).toBeLessThan(ultra.render.terrainFloorQuads);

      // Отпечатки первыми: их дифф называет тик, а не вываливает лог целиком.
      expect(performance.digests, match).toEqual(ultra.digests);
      expect(performance.log, match).toBe(ultra.log);
    });
  }

  it('лог прогона — не пустой: сверялись тики, а не отсутствие тиков', () => {
    const { performance } = runsOf('match-fuzz');
    expect(performance.digests.length).toBe(loadRecording('match-fuzz').ticks);
    // Мир не стоит: одинаковый лог одинаковых тиков доказывал бы только то, что
    // запись ничего не делает.
    expect(new Set(performance.digests).size).toBeGreaterThan(1);
  });
});

describe('QUAL-2/NET-12: состав доставленной информации не зависит от пресета (задача 4.2)', () => {
  for (const match of RECORDED_MATCHES) {
    it(`${match}: те же тики и те же сущности в доставке`, () => {
      const { performance, ultra } = runsOf(match);
      // Кому что видно, решает фильтр снапшота симуляции (NET-12); подсистема
      // рендера состав доставки не трогает вовсе — ни на каком пресете.
      expect(performance.delivered, match).toEqual(ultra.delivered);
      expect(performance.delivered.length).toBe(loadRecording(match).ticks);
      expect(performance.render.syncTickInstances).toBe(ultra.render.syncTickInstances);
      expect(performance.render.fogEntitiesScanned).toBe(ultra.render.fogEntitiesScanned);
    });
  }
});

// ------------------------- 4.2: консервативность грубой маски видимости (FOW-9)

/**
 * Синтетическая нагрузка проверки маски: арена крупнее матчевой, укрытия
 * решёткой шагом 4 и наблюдатели с ЧЕЛОВЕЧЕСКИМ радиусом обзора. Радиус
 * коллайдера записанного матча (0.3 мировых единицы) на маске — пятно в
 * несколько текселей: тени за укрытиями в нём не наблюдаются, а именно они и
 * есть предмет FOW-9.
 */
const MASK_LOAD = { entities: 64, observers: 4, vision: 3, extent: 16, pillarStep: 4 } as const;

/** Стенд маски: авторское разрешение матчевого стенда, потолок — от пресета. */
function maskBench(preset: BenchPresetName): PresentationBench {
  const bench = new PresentationBench({
    grid: benchGrid(MASK_LOAD.extent, MASK_LOAD.pillarStep),
    resolution: MATCH_STAND.resolution,
    preset: BENCH_PRESETS[preset],
  });
  bench.deliver(
    syntheticTick({
      entities: MASK_LOAD.entities,
      observers: MASK_LOAD.observers,
      vision: MASK_LOAD.vision,
      extent: MASK_LOAD.extent,
    }),
  );
  return bench;
}

/** Наблюдатели доставки глазами теста — тем же правилом, что у подсистемы (FOW-7). */
function observersOf(view: TickView): readonly { x: number; y: number }[] {
  const observers: { x: number; y: number }[] = [];
  for (const entity of view.entities.values()) {
    if (entity.stats?.get(FOG_STATS.team) === undefined) continue;
    observers.push({ x: entity.currX, y: entity.currY });
  }
  return observers;
}

/**
 * Максимум тонкой маски по площадке ОДНОГО грубого текселя, накрывающего точку,
 * расширенной на хвост блюра кромки. Тексель — квант грубой маски: сравнивать её
 * с тонкой в точке значило бы сравнивать фазу растеризации, а не информацию.
 *
 * Расширение — не поблажка, а вторая половина того же кванта. Полутон кромки
 * делает блюр радиусом в ОДИН тексель уже после reveal (FOW-7, `mask.ts`), и
 * радиус этот измеряется в текселях СВОЕЙ маски: грубая размывает свет на
 * четверть юнита, тонкая — на восьмую. Симметричный перенос — не больше
 * полутекселя за геометрию, и ровно на него площадка сравнения и расширяется.
 * Утверждение FOW-9 «грубая ошибается в сторону тумана» остаётся тем же: света
 * там, где тонкая маска держит туман, у грубой не появляется — с точностью до
 * кванта её собственной кромки.
 */
function fineMaxOverTexel(fine: VisibilityMask, coarse: VisibilityMask, x: number, y: number): number {
  const size = 1 / coarse.texelsPerUnit;
  const blur = size / 2;
  const x0 = Math.floor(x * coarse.texelsPerUnit) * size - blur;
  const y0 = Math.floor(y * coarse.texelsPerUnit) * size - blur;
  const span = size + 2 * blur;
  const step = 1 / fine.texelsPerUnit;
  let best = 0;
  for (let sx = x0 + step / 2; sx < x0 + span; sx += step) {
    for (let sy = y0 + step / 2; sy < y0 + span; sy += step) best = Math.max(best, fine.valueAt(sx, sy));
  }
  return best;
}

/** Расстояние до ближайшего наблюдателя — им проверяется, куда свет не выходит. */
function nearestObserver(observers: readonly { x: number; y: number }[], x: number, y: number): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const observer of observers) nearest = Math.min(nearest, Math.hypot(x - observer.x, y - observer.y));
  return nearest;
}

describe('FOW-9: грубая маска производительного пресета консервативна (задача 4.2)', () => {
  /** Шаг сетки сэмплов: восьмая текселя грубой маски — кромки просматриваются насквозь. */
  const SAMPLE_STEP = 1 / 32;

  it('потолок пресета действительно огрубляет маску, авторское значение — нет', () => {
    expect(maskBench('performance').fog.visibility.texelsPerUnit).toBe(
      BENCH_PRESETS.performance['fog.maskResolution'],
    );
    expect(maskBench('ultra').fog.visibility.texelsPerUnit).toBe(MATCH_STAND.resolution);
  });

  it('свет грубой маски не выходит за свет тонкой дальше собственного текселя', () => {
    const coarse = maskBench('performance').fog.visibility;
    const fine = maskBench('ultra').fog.visibility;
    let coarseLit = 0;
    let uncovered = 0;
    let brighter = 0;
    // Первая разошедшаяся точка — в сообщение отказа: «37 нарушений» без адреса
    // на арене 16×16 не ищется.
    let where = '';
    for (let x = SAMPLE_STEP / 2; x < MASK_LOAD.extent; x += SAMPLE_STEP) {
      for (let y = SAMPLE_STEP / 2; y < MASK_LOAD.extent; y += SAMPLE_STEP) {
        const value = coarse.valueAt(x, y);
        if (value === 0) continue;
        coarseLit++;
        const covered = fineMaxOverTexel(fine, coarse, x, y);
        // Открытого грубой маской текселя, целиком лежащего в тумане тонкой, не
        // бывает: «показать лишний туман можно, скрыть его — нет» (FOW-9).
        if (covered === 0) uncovered++;
        // И ярче тонкой на своей площадке грубая маска не светит: огрубление
        // разрешения не добавляет света, только размывает его границу.
        if (value > covered) brighter++;
        if (value > covered && where === '') {
          where = `(${x.toFixed(3)}, ${y.toFixed(3)}): грубая ${value.toFixed(3)}, тонкая ${covered.toFixed(3)}`;
        }
      }
    }
    expect(coarseLit, 'сэмплов под светом грубой маски').toBeGreaterThan(1000);
    expect(uncovered, where).toBe(0);
    expect(brighter, where).toBe(0);
  });

  it('свет грубой маски не выходит за радиус обзора симуляции', () => {
    const bench = maskBench('performance');
    const coarse = bench.fog.visibility;
    const observers = observersOf(bench.buffer.view);
    expect(observers.length).toBe(MASK_LOAD.observers);
    // Визуал консервативнее геймплея на коэффициент конфига (FOW-9): круг
    // reveal — радиус обзора, умноженный на него. Огрубление разрешения
    // добавляет к нему не больше половины диагонали грубого текселя, а блюр
    // кромки (FOW-7) — не больше полутекселя: и этого запаса вместе взятого
    // недостаточно, чтобы свет дотянулся до геймплейного радиуса.
    const reveal = MASK_LOAD.vision * bench.fog.config.conservatism;
    const quantum = Math.SQRT2 / (2 * coarse.texelsPerUnit);
    const blur = 1 / (2 * coarse.texelsPerUnit);
    // За хвостом блюра у самой кромки градиент круга уже почти ноль, поэтому
    // наружу выходит не картинка, а одна-две градации из 255. «Свет» здесь —
    // то, что ярче этого хвоста; тот же допуск пары градаций, которым меряется
    // туман в тестах маски (`render-ts`). Абсолютная величина хвоста проверена
    // отдельно ниже — иначе порог был бы поблажкой, а не единицей измерения.
    const HALFTONE = 2 / 255;
    let farthest = 0;
    let beyondVision = 0;
    for (let x = SAMPLE_STEP / 2; x < MASK_LOAD.extent; x += SAMPLE_STEP) {
      for (let y = SAMPLE_STEP / 2; y < MASK_LOAD.extent; y += SAMPLE_STEP) {
        const value = coarse.valueAt(x, y);
        if (value === 0) continue;
        const distance = nearestObserver(observers, x, y);
        if (value > HALFTONE) farthest = Math.max(farthest, distance);
        if (distance >= MASK_LOAD.vision) beyondVision = Math.max(beyondVision, value);
      }
    }
    expect(farthest).toBeLessThanOrEqual(reveal + quantum + blur);
    expect(farthest).toBeLessThan(MASK_LOAD.vision);
    // И за геймплейным радиусом маска не светит вовсе — там только хвост блюра.
    expect(beyondVision).toBeLessThanOrEqual(HALFTONE);
  });

  it('тень за укрытием переживает огрубление: она есть на обоих пресетах', () => {
    const performance = maskBench('performance');
    const ultra = maskBench('ultra');
    const observers = observersOf(performance.buffer.view);
    const reveal = MASK_LOAD.vision * performance.fog.config.conservatism;
    // Точки В РАДИУСЕ, но тёмные, — это и есть тень укрытий (FOW-9). Их
    // существование проверяется отдельно: без укрытий предыдущие проверки
    // сравнивали бы два круга, а не два теневых рисунка.
    let shadowed = 0;
    for (let x = SAMPLE_STEP / 2; x < MASK_LOAD.extent; x += SAMPLE_STEP) {
      for (let y = SAMPLE_STEP / 2; y < MASK_LOAD.extent; y += SAMPLE_STEP) {
        if (nearestObserver(observers, x, y) >= reveal) continue;
        if (performance.fog.visibility.valueAt(x, y) === 0 && ultra.fog.visibility.valueAt(x, y) === 0) {
          shadowed++;
        }
      }
    }
    expect(shadowed).toBeGreaterThan(100);
  });
});
