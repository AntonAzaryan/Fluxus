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
 *   разрешение маски, число событий эффекта, потолок разбиения террейна), чтобы
 *   суперлинейный рост читался отношением L/S прямо в диффе эталона.
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
import { runScenario, type DiagnosticsSink } from '@fluxus/core';
import {
  COST_COUNTER_STAGES,
  createCostCounters,
  withCostSink,
  type CostStage,
  type QualityPreset,
  type RenderCostCounters,
} from '@fluxus/render';
import {
  BENCH_PRESETS,
  BENCH_PRESET_NAMES,
  NAV_PATH,
  NPC_STRESS,
  loadNavPath,
  loadNpcStress,
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
  /**
   * Работа поиска пути за тик (`pathfinding` NAV-5): раскрытые узлы A* плюс
   * пробы клеток обхода видимости. Своя строка, а не сумма с соседями: величина
   * растёт размером арены и числом перезапросов, и в общем счётчике её
   * регрессия утонула бы.
   */
  navNodes: number;
  /** Осмотренные соседи-агенты сетки платформы поведения NPC (NPC-6, NPC-9). */
  npcNeighbors: number;
  raycasts: number;
  ticks: number;
}

function tickCostCollector(): { readonly sink: DiagnosticsSink; readonly total: TickCost } {
  const total: TickCost = {
    broadPhasePairs: 0,
    commandsApplied: 0,
    expressions: 0,
    navNodes: 0,
    npcNeighbors: 0,
    raycasts: 0,
    ticks: 0,
  };
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
      total.navNodes += Number(entry.data?.navNodes ?? 0);
      total.npcNeighbors += Number(entry.data?.npcNeighbors ?? 0);
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
  // Две бухгалтерии проходов рендерера обязаны сойтись: подсистемы считают их
  // сами, спай видит вызовы (design D2). Владельцев проходов у кадра двое —
  // цепочка пост-обработки рисует сцену, туман кладёт маску поверх (REND-34,
  // FOW-7), — и сойтись обязана СУММА: расхождение означает, что счётчик врёт
  // либо что проход потерял владельца.
  expect(counters.fogRenderPasses + counters.postprocessPasses).toBe(bench.renderer.renders);
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
  shots: 4,
};

interface ScalingSize {
  /** Величина оси — то единственное, чем размеры и различаются. */
  readonly magnitude: number;
  readonly pillarStep: number;
  readonly resolution: number;
  readonly load: SyntheticLoad;
  /**
   * Документ пресета размера; нет — базовый ультра-документ стенда. Отличаться
   * от него вправе ровно та ось, чья величина ЕСТЬ значение ручки: у террейна
   * плотность разбиения приходит только потолком пресета (QUAL-1) — авторское
   * значение живёт конфигом рендера и осью быть не может.
   */
  readonly preset?: QualityPreset;
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
 * Документ оси разбиения террейна: базовый ультра плюс потолок (QUAL-1). Ручка
 * потолочная, поэтому действующая плотность — min(конфига рендера, потолка), и
 * величиной оси служит именно потолок: он один и приходит извне подсистемы.
 */
function tessellationCeiling(ceiling: number): QualityPreset {
  return Object.freeze({ ...BENCH_PRESETS.ultra, 'terrain.curvatureTessellation': ceiling });
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
  {
    // Число событий одноразового эффекта в доставке (REND-24): выстрелы —
    // единственная работа частиц, которую двигает СВОЯ величина, а не состав
    // сущностей; оболочки типов при этом стоят на месте, и отношение L/S
    // приписывается частицам целиком.
    axis: 'particleShots',
    small: size(4, { load: { ...BASE_LOAD, shots: 4 } }),
    large: size(32, { load: { ...BASE_LOAD, shots: 32 } }),
  },
  {
    // Потолок плотности разбиения клеток с кривизной (REND-9, QUAL-1): пол
    // растёт его КВАДРАТОМ, стенки — линейно, и обе зависимости читаются
    // отношением L/S. Авторская плотность конфига рендера у обоих размеров одна.
    axis: 'terrainTessellation',
    small: size(2, { preset: tessellationCeiling(2) }),
    large: size(4, { preset: tessellationCeiling(4) }),
  },
];

/**
 * Одна доставка и один кадр синтетической нагрузки под снятым замером.
 *
 * Базовый документ осей — ультра, то есть без потолков (стенд без пресета берёт
 * его сам): ось «разрешение маски» ДВИГАЕТ ту самую величину, которую потолок
 * ограничивает, и второй пресет мерил бы здесь не рост стоимости от разрешения,
 * а работу min() — она проверена на матчах (QUAL-4) и в `render-ts`. Ось
 * разбиения террейна — исключение по механике, а не по вкусу: авторская
 * плотность приходит конфигом рендера, и подвинуть её снаружи можно только
 * потолком; документ этой оси называет ОДНУ ручку сверх базовой, поэтому
 * рассуждение про маску остаётся в силе.
 */
function measureSize(config: ScalingSize): RenderCostCounters {
  const bench = new PresentationBench({
    grid: benchGrid(SCALING_EXTENT, config.pillarStep),
    resolution: config.resolution,
    ...(config.preset !== undefined ? { preset: config.preset } : {}),
  });
  const ext = syntheticTick(config.load);
  const counters = createCostCounters();
  withCostSink(counters, () => {
    bench.deliver(ext);
  });
  expect(counters.fogRenderPasses + counters.postprocessPasses).toBe(bench.renderer.renders);
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
    // Полномасочная работа ПЕРЕСТРОЙКИ растёт квадратом разрешения — вдвое
    // грубее маска вчетверо дешевле, и ровно эту строку диффа гейт и заводился
    // стеречь. Перестроек у двух пресетов поровну: их каденс задаёт доставка.
    expect(ultra.render.fogMaskClearTexels).toBe(4 * performance.render.fogMaskClearTexels);
    expect(ultra.render.fogMaskSmoothTexels).toBe(4 * performance.render.fogMaskSmoothTexels);
    // ОДНА загрузка текстуры — тоже ровно вчетверо (растр уезжает целиком), а
    // вот самих загрузок у грубой маски меньше: кадр рассеивания заводится
    // только там, где растр ДЕЙСТВИТЕЛЬНО изменился, и грубый от мелкого шага
    // наблюдателя нередко не меняется вовсе (design D5). Отсюда неравенство.
    expect(ultra.render.fogMaskUploadBytes).toBeGreaterThanOrEqual(
      4 * performance.render.fogMaskUploadBytes,
    );
    // Блит миникарты дорожает вместе с разрешением, но РОВНО вчетверо больше не
    // выходит: он идёт по грязным блокам окна рассеивания (change
    // `fog-mask-budgeted-rebuild`, design D5), а блок — фиксированные 16×16
    // текселей. Грубая маска целиком укладывается в четыре блока, тонкая — в
    // шестнадцать, и отношение задаёт зернистость окна, а не площадь растра.
    expect(ultra.render.fogMinimapTexels).toBeGreaterThan(performance.render.fogMinimapTexels);
    // Доставка и кадр от пресета не зависят: сущностей столько же, подсистем
    // столько же — качество меняет подачу картинки, а не состав состояния (QUAL-2).
    expect(ultra.render.syncTickInstances).toBe(performance.render.syncTickInstances);
    expect(ultra.render.frameInstances).toBe(performance.render.frameInstances);
  });

  it('QUAL-1: значения ручек приезжают стенду контроллером, а не мимо него', () => {
    const bench = matchBench(BENCH_PRESETS.performance);

    // Реестр стенда собран из деклараций ЕГО подсистем (design D1) в порядке
    // регистрации: пост-обработка (три ручки — выключатель bloom, потолок
    // разрешения его пирамиды и выключатель LUT, REND-34), освещение (три
    // ручки — две теневые и потолок локальных источников, REND-33), туман,
    // террейн, вода (три ручки — источники ряби, слои детали и плотность
    // выборки глубины, REND-35), модели (две ручки), частицы. Подсистема
    // позиций ручек не имеет и в реестре не появляется — реестр собирается из
    // того, что подсистемы объявили, а не из состава документа.
    expect(bench.quality.knobs.map((knob) => knob.name)).toEqual([
      'postprocess.bloom',
      'postprocess.bloomResolution',
      'postprocess.lut',
      'lighting.shadowMode',
      'lighting.shadowMapSize',
      'lighting.maxLocalLights',
      'fog.maskResolution',
      'terrain.curvatureTessellation',
      'water.rippleSources',
      'water.detailLayers',
      'water.depthTexelsPerCell',
      'models.lodThresholdScale',
      'models.defaultTier',
      'particles.density',
    ]);
    const effective = bench.quality.effective();
    for (const [name, value] of Object.entries(BENCH_PRESETS.performance)) {
      expect(effective.get(name), name).toBe(value);
    }
    expect(bench.maskResolution).toBe(BENCH_PRESETS.performance['fog.maskResolution']);
  });

  it('стенд собран без предупреждений: фикстуры доехали, заглушек в счётчиках нет', () => {
    // Заглушка вместо модели (ASSET-4), неразвёрнутый эффект или карта кривизны
    // не той сетки (ASSET-7) дали бы счётчики МЕНЬШЕЙ работы, и эталон принял бы
    // деградацию фикстуры за норму. Тишина подсистем — часть гейта.
    for (const preset of BENCH_PRESET_NAMES) {
      const bench = matchBench(BENCH_PRESETS[preset]);
      playRecording(loadRecording('match-walk'), { onTick: (result) => { bench.step(result); } });
      expect(bench.warnings, preset).toEqual([]);
    }
  });
});

// ------- счётчики подсистем стенда (lighting/models/particles/terrain)

/**
 * Префиксы счётчиков подсистем стенда (change `bench-stand-subsystems`, D1):
 * имя счётчика начинается с имени его подсистемы. Набор имён читается из
 * ОБЪЯВЛЕНИЯ пакета (`COST_COUNTER_STAGES`), а не выписывается здесь: новый
 * счётчик подсистемы обязан попасть под эти проверки сам, без правки теста.
 */
const SUBSYSTEM_PREFIXES = ['lighting', 'models', 'particles', 'terrain', 'water'] as const;

function countersOf(prefix: string): (keyof RenderCostCounters)[] {
  const names = Object.keys(COST_COUNTER_STAGES) as (keyof RenderCostCounters)[];
  return names.filter((name) => name.startsWith(prefix));
}

describe('PERF-4: работа освещения, моделей, частиц, террейна и воды видна эталону', () => {
  for (const prefix of SUBSYSTEM_PREFIXES) {
    it(`${prefix}: счётчики объявлены и на записанном матче не мёртвые`, () => {
      const names = countersOf(prefix);
      // Пустой набор — не «нечего проверять», а необъявленная подсистема: без
      // счётчиков её удорожание проходит гейт зелёным (PERF-4).
      expect(names.length, `${prefix}: счётчики не объявлены`).toBeGreaterThan(0);
      const run = runMatch('match-walk', 'ultra');
      const moved = names.filter((name) => run.render[name] > 0);
      expect(moved.length, `${prefix}: ни один счётчик не сдвинулся`).toBeGreaterThan(0);
    });
  }

  it('модели: инстансы обеих записей манифеста созданы и рисуются каждый кадр', () => {
    const run = runMatch('match-walk', 'ultra');
    const ticks = loadRecording('match-walk').ticks;
    // Обе сущности записи получили инстанс (REND-3) — и запись с явным ярусом,
    // и запись, ярус не назвавшая: `models.defaultTier` не остался без работы.
    expect(run.render.modelsInstancesCreated).toBe(2);
    expect(run.render.modelsInstancesSynced).toBe(2 * ticks);
    // Кадр платит за оба инстанса и отсекает ноль: камера стенда держит арену
    // целиком, иначе выбор уровня не исполнялся бы вовсе (REND-21, REND-22).
    expect(run.render.modelsPoseWrites).toBe(2 * ticks);
    expect(run.render.modelsCulled).toBe(0);
    expect(run.render.modelsLodSelections).toBe(2 * ticks);
  });

  it('частицы: оболочка типа живёт всеми тиками, экземпляр берётся из пула один раз', () => {
    const run = runMatch('match-walk', 'ultra');
    const ticks = loadRecording('match-walk').ticks;
    // Запись `particles.byKind` есть у одной из двух записей манифеста: сведение
    // считает источники сущностей С ЗАПИСЬЮ, а не весь состав доставки.
    expect(run.render.particlesShellsSynced).toBe(ticks);
    // Оболочка живёт весь матч: экземпляр взят однажды и в пул не возвращался.
    expect(run.render.particlesInstancesAcquired).toBe(1);
    expect(run.render.particlesShellsPosed).toBe(ticks);
    expect(run.render.particlesSystemsStepped).toBe(ticks);
  });

  it('освещение: full платит обоими ярусами кастеров покадрово, hybrid — перерисовками кэша', () => {
    const performance = runMatch('match-walk', 'performance').render; // потолок hybrid
    const ultra = runMatch('match-walk', 'ultra').render; // авторский full
    const ticks = loadRecording('match-walk').ticks;

    // В `full` карта одна и покадровая: оба яруса — чанк террейна и батчи
    // моделей — попадают в неё каждым кадром, а перерисовок кэша нет вовсе:
    // кэш — механика `hybrid`, и его счётчик в `full` не двигается (REND-30).
    expect(ultra.lightingStaticCasters).toBeGreaterThan(0);
    expect(ultra.lightingDynamicCasters).toBeGreaterThan(0);
    expect(ultra.lightingStaticRebuilds).toBe(0);
    // В `hybrid` кэш статики устаревает КАЖДЫМ кадром: импульс пола стенда
    // пересобирает чанк, пересборка перерегистрирует его кастером. Перерисовка
    // кэша при этом НЕ голодит динамическую карту (REND-30): фазы чередуются,
    // и на непрерывном потоке событий инвалидации каждая карта получает свой
    // кадр через один. Отсюда половина перерисовок от числа кадров и ненулевая
    // динамика — именно это число раньше лежало нулём (PERF-2, proposal «Why»).
    expect(performance.lightingStaticRebuilds).toBe(Math.ceil(ticks / 2));
    expect(performance.lightingDynamicCasters).toBeGreaterThan(0);
    // Статика рисуется в `full` каждым кадром, а в `hybrid` — через кадр: те же
    // корни, вдвое реже.
    expect(performance.lightingStaticCasters * 2).toBe(ultra.lightingStaticCasters);
  });

  it('террейн: импульс пола помечает чанк каждой доставкой, кадр его пересобирает', () => {
    const run = runMatch('match-walk', 'ultra');
    const ticks = loadRecording('match-walk').ticks;
    // Арена матчевого стенда — один чанк, и обе перещёлкнутые клетки лежат в
    // нём: пометок две на доставку, пересборка одна на кадр (REND-7, ED-15).
    expect(run.render.terrainChunksMarked).toBe(2 * ticks);
    expect(run.render.terrainChunksRebuilt).toBe(ticks);
    expect(run.render.terrainFloorQuads).toBeGreaterThan(0);
    // Укрытия арены дают cliff-отрезки, и стенки строятся вместе с полом (TERR-5).
    expect(run.render.terrainWallQuads).toBeGreaterThan(0);
  });

  it('QUAL-4: пресеты расходятся на работе моделей и террейна, состав доставки — нет', () => {
    const performance = runMatch('match-walk', 'performance').render;
    const ultra = runMatch('match-walk', 'ultra').render;

    // Множитель порогов LOD (REND-22): вдвое ранние пороги уводят обе записи на
    // соседний уровень цепочки, и кадр отдаёт батчам вчетверо меньше
    // треугольников — ровно ту величину, ради которой ручка и заведена.
    expect(ultra.modelsBatchTriangles).toBe(4 * performance.modelsBatchTriangles);
    // Выбор уровня при этом исполняется одинаково часто: дешевеет не решение, а
    // геометрия, которую оно выбирает.
    expect(ultra.modelsLodSelections).toBe(performance.modelsLodSelections);
    // Потолок разбиения (REND-9): пол пересобранных чанков растёт КВАДРАТОМ
    // плотности, стенки — линейно, поэтому вдвое больший потолок дорожает полу
    // сильнее, чем стенкам.
    expect(ultra.terrainFloorQuads).toBeGreaterThan(2 * performance.terrainFloorQuads);
    expect(ultra.terrainWallQuads).toBeGreaterThan(performance.terrainWallQuads);
    expect(ultra.terrainWallQuads).toBeLessThanOrEqual(2 * performance.terrainWallQuads);
    // Пересборок при этом столько же: потолок меняет ЦЕНУ пересборки, а не её
    // повод — поводом остаётся мутация пола (TERR-6).
    expect(ultra.terrainChunksRebuilt).toBe(performance.terrainChunksRebuilt);

    // Частицы от пресета не зависят НАМЕРЕННО (design D3): множитель плотности
    // правит эмиссию ВНУТРИ систем, а объём нашей работы — оболочки, взятия из
    // пула, шаги систем — от него не меняется. Читать число живых частиц
    // эталону запрещено: эмиссия three.quarks стохастична, и счётчик по ней
    // нарушил бы машинную независимость (PERF-3). Равенство здесь поэтому —
    // утверждение, а не пропуск проверки.
    for (const name of countersOf('particles')) {
      expect(ultra[name], name).toBe(performance[name]);
    }
    // Состав доставленного состояния тоже общий: качество меняет подачу
    // картинки, а не то, что в ней есть (QUAL-2).
    expect(ultra.modelsInstancesCreated).toBe(performance.modelsInstancesCreated);
    expect(ultra.modelsInstancesSynced).toBe(performance.modelsInstancesSynced);
    expect(ultra.modelsPoseWrites).toBe(performance.modelsPoseWrites);
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
    // Обнуление, блюр кромки, загрузка в текстуру и блит миникарты идут по
    // всему растру: удвоение разрешения — четырёхкратное удорожание (FOW-10).
    // Это ровно половина той регрессии, ради которой заведён гейт.
    expect(high.fogMaskClearTexels).toBe(4 * low.fogMaskClearTexels);
    expect(high.fogMaskSmoothTexels).toBe(4 * low.fogMaskSmoothTexels);
    expect(high.fogMaskUploadBytes).toBe(4 * low.fogMaskUploadBytes);
    expect(high.fogMinimapTexels).toBe(4 * low.fogMinimapTexels);
    // А вот теневой путь от разрешения больше НЕ зависит: полярный depth-буфер
    // строится по углу (бинов фиксированное число), и тексель платит за тень
    // O(1) вместо теста против каждого отрезка (FOW-9, design D3). Равенство
    // здесь — не слабая проверка, а утверждение: подняв разрешение, за тени
    // доплачивать не приходится, и эталон покраснеет, если это перестанет быть
    // правдой.
    expect(low.fogShadowRayTests).toBeGreaterThan(0);
    expect(high.fogShadowRayTests).toBe(low.fogShadowRayTests);
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
    // Полярная растеризация теней растёт вместе с числом ОТОБРАННЫХ в радиус
    // укрытий: каждое платит своей дугой бинов (FOW-9, design D3).
    expect(few.fogShadowRayTests).toBeGreaterThan(0);
    expect(many.fogShadowRayTests).toBeGreaterThan(few.fogShadowRayTests);
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

  it('число сущностей: работа моделей и оболочек частиц растёт вместе с ним', () => {
    const axis = AXES.find((item) => item.axis === 'entities')!;
    const few = measureSize(axis.small);
    const many = measureSize(axis.large);
    const ratio = axis.large.magnitude / axis.small.magnitude;
    // Инстанс на сущность (REND-3): и сведение пула, и поза кадра, и тест
    // отсечения растут ровно составом доставки.
    expect(many.modelsInstancesSynced).toBe(ratio * few.modelsInstancesSynced);
    expect(many.modelsInstancesCreated).toBe(ratio * few.modelsInstancesCreated);
    expect(many.modelsPoseWrites).toBe(ratio * few.modelsPoseWrites);
    expect(many.modelsCullTests).toBe(ratio * few.modelsCullTests);
    // Треугольники батчей — тоже: камера стенда держит все инстансы на одном
    // уровне цепочки, поэтому растёт их ЧИСЛО, а не геометрия каждого (REND-22).
    expect(many.modelsBatchTriangles).toBe(ratio * few.modelsBatchTriangles);
    // Оболочка эмиттера есть у половины сущностей — у записи с эмиттерным
    // ключом манифеста (REND-24); растёт она тем же составом доставки.
    expect(many.particlesShellsSynced).toBe(ratio * few.particlesShellsSynced);
    expect(many.particlesShellsPosed).toBe(ratio * few.particlesShellsPosed);
    // А террейну толпа безразлична: его работа приходит мутацией пола, а не
    // составом сущностей (TERR-6 → REND-7).
    expect(many.terrainChunksRebuilt).toBe(few.terrainChunksRebuilt);
    expect(many.terrainFloorQuads).toBe(few.terrainFloorQuads);
  });

  it('число событий эффекта: выстрелы кратны ему, оболочки типов — нет', () => {
    const axis = AXES.find((item) => item.axis === 'particleShots')!;
    const few = measureSize(axis.small);
    const many = measureSize(axis.large);
    // Событие честного прохода заводит выстрел (REND-24): их ровно столько,
    // сколько событий, и каждый берёт экземпляр из пула.
    expect(few.particlesShotsStepped).toBe(axis.small.magnitude);
    expect(many.particlesShotsStepped).toBe(axis.large.magnitude);
    expect(many.particlesInstancesAcquired - few.particlesInstancesAcquired).toBe(
      axis.large.magnitude - axis.small.magnitude,
    );
    // Оболочки типов событиями не заводятся — состав сущностей тот же.
    expect(many.particlesShellsSynced).toBe(few.particlesShellsSynced);
    expect(many.particlesShellsPosed).toBe(few.particlesShellsPosed);
    // И моделям события манифест не адресует: работа кадра у них та же.
    expect(many.modelsPoseWrites).toBe(few.modelsPoseWrites);
  });

  it('потолок разбиения террейна: пол дорожает квадратом, стенки — линейно', () => {
    const axis = AXES.find((item) => item.axis === 'terrainTessellation')!;
    const coarse = measureSize(axis.small);
    const fine = measureSize(axis.large);
    // Клетка с кривизной даёт `tessellation²` подклеток (REND-9): вдвое больший
    // потолок дорожает полу БОЛЬШЕ чем вдвое — плоские клетки чанка платят
    // по-прежнему один квад, и потому не ровно вчетверо.
    expect(fine.terrainFloorQuads).toBeGreaterThan(2 * coarse.terrainFloorQuads);
    // Кромка обрыва разбивается вдоль, а не по площади: рост не больше двойного.
    expect(fine.terrainWallQuads).toBeGreaterThan(coarse.terrainWallQuads);
    expect(fine.terrainWallQuads).toBeLessThanOrEqual(2 * coarse.terrainWallQuads);
    // Пересобранных чанков столько же: потолок меняет цену пересборки, а не её
    // повод — им остаётся импульс пола стенда (TERR-6).
    expect(fine.terrainChunksRebuilt).toBe(coarse.terrainChunksRebuilt);
    // Ни моделям, ни частицам потолок террейна не адресован вовсе.
    expect(fine.modelsBatchTriangles).toBe(coarse.modelsBatchTriangles);
    expect(fine.particlesSystemsStepped).toBe(coarse.particlesSystemsStepped);
  });
});

/**
 * Стоимость NPC-части тика под массой агентов (`npc-behavior` NPC-9): двести
 * массовых крипов, режиссёр волн, маршрут и двое героев в центре.
 *
 * Стадия здесь ОДНА — `tick`: у нагрузки нет ни клиента, ни кадра, а мерить
 * она заведена именно симуляцию. Эталон в общем гейте затем, чтобы удорожание
 * решения агента краснело диффом на ревью, а не обнаруживалось на плейтесте;
 * принятие удорожания — та же явная регенерация `npm run golden:cost`.
 *
 * Побитового эталона состояния у нагрузки нет намеренно — основание в
 * `benchLoad.ts` рядом с её загрузчиком.
 */
function measureNpcStress(): unknown {
  const { sink, total } = tickCostCollector();
  runScenario(loadNpcStress(), sink);
  return { tick: sorted(total) };
}

/**
 * Стоимость навигационной части тика (`pathfinding` NAV-5, PERF-4): сцена, где
 * NPC идут по `findPath` через узкий проход, вдоль обрыва и по рампе.
 *
 * Стадия здесь ОДНА — `tick`: ни клиента, ни кадра у нагрузки нет, а мерить она
 * заведена именно работу поиска. Эталон в общем гейте затем, чтобы подорожавший
 * поиск краснел диффом на ревью, а не обнаруживался на плейтесте; принятие
 * удорожания — та же явная регенерация `npm run golden:cost`.
 */
function measureNavPath(): unknown {
  const { sink, total } = tickCostCollector();
  runScenario(loadNavPath(), sink);
  return { tick: sorted(total) };
}

describe('NAV-5: эталон стоимости поиска пути', () => {
  it('счётчики стадии тика совпадают с эталоном', () => {
    checkGolden(`${NAV_PATH}.cost.json`, measureNavPath());
  });

  it('нагрузка не мёртвая: поиск пути сделал работу и повторяется побитово', () => {
    const document = measureNavPath() as { tick: TickCost };
    expect(document.tick.ticks).toBe(loadNavPath().ticks);
    // Своя строка эталона (PERF-3): работа навигации видна отдельно от работы
    // сетки соседей и от кандидатов broad-phase — в общей сумме удорожание
    // поиска утонуло бы.
    expect(document.tick.navNodes).toBeGreaterThan(0);
    expect(measureNavPath()).toEqual(document);
  });
});

describe('NPC-9: эталон стоимости массы NPC', () => {
  it('счётчики стадии тика совпадают с эталоном', () => {
    checkGolden(`${NPC_STRESS}.cost.json`, measureNpcStress());
  });

  it('нагрузка не мёртвая: работа тика сделана каждым счётчиком объёма', () => {
    const document = measureNpcStress() as { tick: TickCost };
    expect(document.tick.ticks).toBe(loadNpcStress().ticks);
    expect(document.tick.commandsApplied).toBeGreaterThan(0);
    // Выборка соседей платформы поведения — СВОЯ строка эталона (NPC-6, NPC-9),
    // и разделение это не косметическое: вся выборка нагрузки приходится на
    // сетку агентов, а broad-phase физики на ней не делает ничего (коллайдеры
    // крипов никого не блокируют). В общем счётчике удорожание луча утонуло бы
    // в этих девяноста тысячах бесследно.
    expect(document.tick.npcNeighbors).toBeGreaterThan(0);
    expect(document.tick.broadPhasePairs).toBe(0);
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

  it('стресс-нагрузка NPC повторяется так же (NPC-9)', () => {
    const first = measureNpcStress();
    expect(measureNpcStress()).toEqual(first);
    expect(canonical(measureNpcStress())).toBe(canonical(first));
  });
});
