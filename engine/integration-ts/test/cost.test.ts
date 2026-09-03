/**
 * Голден-гейт стоимости (`performance-budget` PERF-4, PERF-6) — точная сверка
 * детерминированных счётчиков объёма работы с закоммиченным эталоном.
 *
 * ## Что сверяется
 *
 * - На каждом записанном матче (CLI-10) — `engine/tests/golden/<матч>.cost.json`:
 *   счётчики четырёх стадий конвейера (PERF-2). Стадия `tick` приезжает записями
 *   диагностики ядра (DIAG-1, уровень `systems`), стадии `extract`, `syncTick` и
 *   `frame` — стоком счётчиков рендера; принадлежность счётчика стадии объявляет
 *   сам рендер (`COST_COUNTER_STAGES`), а не догадка этого файла.
 *   Одна и та же запись прогоняется ДВАЖДЫ — на пресетах «производительность» и
 *   «ультра» (`render-quality` QUAL-4, design D5): у каждого своя секция
 *   документа, поэтому удорожание пути, работающего и на слабых устройствах,
 *   краснеет отдельной строкой диффа, а не тонет в общем. Стадии `tick` и
 *   `extract` в документе по ОДНОЙ: ни симуляция, ни копирование мира в плоскую
 *   форму от пресета не зависят (QUAL-2), и равенство их счётчиков между двумя
 *   прогонами — часть проверки, а не допущение.
 * - На синтетических осях стоимости рендера (PERF-6) —
 *   `engine/tests/golden/scaling.cost.json`: два размера на ось (число сущностей,
 *   наблюдателей, сегментов укрытий, разрешение маски, число событий эффекта,
 *   потолок разбиения террейна), чтобы суперлинейный рост читался отношением L/S
 *   прямо в диффе эталона.
 * - На осях стороны симуляции (PERF-6) — `npc-stress.cost.json` (число агентов
 *   платформы поведения, NPC-9), `nav-path.cost.json` (число агентов поиска
 *   пути, NAV-5), `ability-stress.cost.json` (число кастующих агентов платформы
 *   способностей, ABIL-5) и `dsl-scale.cost.json` (число сущностей, которые
 *   обрабатывают JSON-системы, SYS-1): те же два размера и та же форма
 *   документа, только стадия одна — `tick`.
 * - На оси экстракции (PERF-6) — `extract.cost.json` (число сущностей
 *   доставки): та же форма, стадия `extract`. Записанные матчи стадию эту
 *   меряют, но осью не являются — их состав фиксирован, и линейность экстракции
 *   по сущности видна только вторым размером.
 * - На проводе сервера (PERF-12) — секция `wire` тех же `match-*.cost.json`, ПО
 *   СЛОТУ: байты и число ушедших слоту персональных снапшотов приезжают отчётом
 *   хоста (`netcode-transport` NTR-11), состав доставленного — применёнными
 *   снапшотами и потоком событий клиента. Запись прогоняется тем же
 *   loopback-стендом, которым она и записана (`MATCH_RECORDINGS`), а осью
 *   провода служит число соединений одного матча — `wire-clients.cost.json`.
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
import { runScenario, type DiagnosticsSink, type ScenarioDef, type ScenarioSpawn } from '@fluxus/core';
import {
  COST_COUNTER_STAGES,
  createCostCounters,
  withCostSink,
  type CostStage,
  type RenderCostCounters,
} from '@fluxus/render';
import {
  BASE_LOAD,
  SCALING_AXES,
  benchFor,
  type ScalingSize,
} from './benchAxes.js';
import {
  ABILITY_STRESS,
  BENCH_PRESETS,
  BENCH_PRESET_NAMES,
  DSL_SCALE,
  NAV_PATH,
  NPC_STRESS,
  WIRE_CLIENTS,
  abilityStressSizes,
  dslScaleSizes,
  loadNavPath,
  loadNpcStress,
  GOLDEN_DIR,
  MATCH_STAND,
  RECORDED_MATCHES,
  extractSizes,
  loadRecording,
  matchBench,
  navPathSizes,
  npcStressSizes,
  playExtraction,
  playRecording,
  playWire,
  playWireClients,
  syntheticTick,
  wireClientsSizes,
  wireEventsSizes,
  type AxisSize,
  type BenchPresetName,
  type WireRun,
} from './benchLoad.js';

const UPDATE = process.env.UPDATE_COST === '1';

/** Плоский набор именованных счётчиков одной стадии — то, что лежит в эталоне. */
type StageCost = Record<string, number>;

// --------------------------------------------------------- счётчики стадии tick

/**
 * Сводка стоимости тика (PERF-3) — сумма записей `TICK_COST` за прогон. `ticks`
 * считает сами записи: без него по эталону не прочесть, во сколько обошёлся
 * тик, а «сколько всего» и «сколько на тик» на ревью нужны оба.
 *
 * Именованное поле здесь ровно одно — то, которого в записи нет. Остальные
 * приезжают из самой записи и потому не перечислены: перечень пришлось бы
 * править на каждую платформу ядра, получившую свою строку сводки (PERF-3), а
 * забытая строка выглядела бы зелёным гейтом вместо диффа.
 */
interface TickCost extends StageCost {
  ticks: number;
}

function tickCostCollector(): { readonly sink: DiagnosticsSink; readonly total: TickCost } {
  const total: TickCost = { ticks: 0 };
  const sink: DiagnosticsSink = {
    // Границы систем достаточно: сводка стоимости — штатная телеметрия DIAG-3,
    // полного потока команд ей не нужно, а он стоил бы прогону на порядок.
    trace: 'systems',
    record: (entry) => {
      if (entry.code !== 'TICK_COST') return;
      total.ticks++;
      // Секция `tick` собирается ПРОХОДОМ по числовым полям записи, а не
      // перечнем: новый счётчик ядра попадает в эталон новой строкой диффа сам,
      // без правки гейта, а забытая калитка видна отсутствием строки, а не
      // молчанием. Данные записи объявлены как «число или строка» (DIAG-2);
      // счётчики стоимости — всегда числа, нечисловое поле в сводке сложить не
      // с чем, и такое поле пропускается.
      for (const [name, value] of Object.entries(entry.data ?? {})) {
        if (typeof value !== 'number') continue;
        total[name] = (total[name] ?? 0) + value;
      }
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
  const stages: Record<CostStage, StageCost> = { extract: {}, frame: {}, syncTick: {} };
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
 * Документ эталона матча (design D5): стадии тика и экстракции ОДИН раз, стадии
 * доставки и кадра — секцией на пресет. Разложение именно такое, потому что
 * таково положение дел: симуляция пресета не знает (QUAL-2), экстракция — тем
 * более (она читает мир, а не картинку), а доставка и кадр знают.
 */
function measureMatch(name: string): unknown {
  const presets: Record<string, unknown> = {};
  let tick: StageCost | null = null;
  let extract: StageCost | null = null;
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
    // Экстракция стоит ПЕРЕД качеством (PERF-2): она копирует мир в плоскую
    // форму, а пресет управляет подачей картинки (QUAL-2). Равенство её
    // счётчиков между пресетами — такая же проверка, как у стадии тика:
    // разойдись они, значит пресет дотянулся до состава доставки.
    if (extract === null) extract = stages.extract;
    else expect(stages.extract, `${name}/${preset}: стадия extract`).toEqual(extract);
    presets[preset] = { frame: stages.frame, syncTick: stages.syncTick };
  }
  return { tick, extract, ...presets };
}

// ------------------------------------------------ стоимость провода (PERF-12)

/**
 * Секция `wire` документа записи: величины ПО СЛОТУ, ключи по алфавиту.
 *
 * По слоту, а не суммой (PERF-12): снапшоты слотов различаются фильтром
 * видимости (NET-12), и рост одного слота при неизменном другом обязан быть
 * отдельной строкой диффа — в сумме он утонул бы.
 */
function wireSection(run: WireRun): Record<string, StageCost> {
  const section: Record<string, StageCost> = {};
  for (const slot of Object.keys(run.slots).sort()) section[slot] = sorted(run.slots[slot]!);
  return section;
}

/** Величины одного слота прогона; отсутствующий слот — отказ, а не пустая секция. */
function wireSlot(run: WireRun, player: string): StageCost {
  const cost = run.slots[player];
  if (cost === undefined) throw new Error(`эталон провода: слота "${player}" в прогоне нет`);
  return sorted(cost);
}

/** Сумма по всем слотам прогона — то, чем меряется ось числа клиентов (PERF-6). */
function wireTotal(run: WireRun): StageCost {
  const total: StageCost = {};
  for (const cost of Object.values(run.slots)) {
    for (const [name, value] of Object.entries(cost)) total[name] = (total[name] ?? 0) + value;
  }
  return sorted(total);
}

/**
 * Полный документ записи: стадии конвейера (PERF-2) плюс секция провода
 * (PERF-12). Провод приезжает отдельным прогоном ЖИВОГО матча, а не тем же
 * прогоном записи, которым считаются стадии: байты провода снимаются на стороне
 * хоста (NTR-11), а хост есть только у матча — прогон записи сетевого слоя не
 * поднимает вовсе.
 */
async function measureMatchDocument(name: string): Promise<unknown> {
  const stages = measureMatch(name) as Record<string, unknown>;
  const wire = await playWire(name);
  return { ...stages, wire: wireSection(wire) };
}

// -------------------------------------------------- оси масштабирования (PERF-6)
//
// Сами оси — общие данные двух гейтов (`benchAxes.ts`): гейт памяти (PERF-8)
// снимает величины на ТОЙ ЖЕ нагрузке, и вторая её копия рядом разошлась бы с
// первой молча.

const AXES = SCALING_AXES;

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
  const bench = benchFor(config);
  const ext = syntheticTick(config.load);
  const counters = createCostCounters();
  withCostSink(counters, () => {
    bench.deliver(ext);
  });
  expect(counters.fogRenderPasses + counters.postprocessPasses).toBe(bench.renderer.renders);
  return counters;
}

/**
 * Стадии, которые СИНТЕТИЧЕСКАЯ нагрузка осей действительно меряет: доставка и
 * кадр. Экстрактор в ней не участвует вовсе — плоскую форму собирает
 * `syntheticTick` руками, — и секция `extract` лежала бы в эталоне нулями, то
 * есть выглядела бы замером, которого не было (PERF-2: стадия следует месту,
 * где работа ДЕЙСТВИТЕЛЬНО исполняется).
 */
function deliveryStages(counters: RenderCostCounters): Record<'frame' | 'syncTick', StageCost> {
  const stages = renderStages(counters);
  return { frame: stages.frame, syncTick: stages.syncTick };
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
        small: deliveryStages(measureSize(axis.small)),
        large: deliveryStages(measureSize(axis.large)),
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
    it(`${match}: счётчики стадий совпадают с эталоном`, async () => {
      checkGolden(`${match}.cost.json`, await measureMatchDocument(match));
    });
  }

  it('счётчики бенча не мёртвые: каждая стадия сделала работу на каждом пресете', () => {
    const document = measureMatch('match-fuzz') as Record<string, StageCost | Record<string, StageCost>>;
    // Стадии, не зависящие от пресета, — сводка тика и экстракция (PERF-2):
    // обе обязаны быть непустыми, иначе стадия конвейера стоит в эталоне
    // нулями и гейт стережёт пустоту.
    const stages: [string, StageCost][] = [
      ['tick', document.tick as StageCost],
      ['extract', document.extract as StageCost],
    ];
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

  /**
   * Стенд матча не вправе МОЛЧА выродиться: арена стенда синтетическая, а
   * позиции наблюдателей приезжают записью, и достаточно одного из двух
   * сдвинуться, чтобы туман на матче перестал делать работу — эталон при этом
   * останется зелёным, потому что ноль сходится с нулём (PERF-4).
   *
   * Четыре пути маски поэтому проверяются на КАЖДОЙ записи и КАЖДОМ пресете
   * отдельно: отбор укрытий в радиус (тени вообще исполняются), запись света
   * (круг не выброшен целиком), обращения текселя к полярному буферу и срез по
   * уровню пола (FOW-9). Последний виден отдельным счётчиком именно затем,
   * чтобы стенд, на котором наблюдатель стоит «внутри» столба или, наоборот,
   * не видит ни одной высоты, краснел здесь, а не проходил эталоном из нулей.
   */
  it('PERF-4: пути тумана на каждой записи живые — вырождение стенда не проходит молча', () => {
    for (const match of RECORDED_MATCHES) {
      for (const preset of BENCH_PRESET_NAMES) {
        const where = `${match}/${preset}`;
        const render = runMatch(match, preset).render;
        expect(render.fogNearSegments, `${where}: тени`).toBeGreaterThan(0);
        expect(render.fogMaskTexelsWritten, `${where}: запись света`).toBeGreaterThan(0);
        expect(render.fogShadowTexelTests, `${where}: обращения к буферу теней`).toBeGreaterThan(0);
        expect(render.fogMaskTexelsCut, `${where}: срез по уровню (FOW-9)`).toBeGreaterThan(0);
      }
    }
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
    // регистрации: пост-обработка (четыре ручки — выключатель bloom, потолок
    // разрешения его пирамиды, выключатель LUT и число сэмплов цели сцены,
    // REND-34), освещение (три ручки — две теневые и потолок локальных
    // источников, REND-33), туман, террейн (две ручки — плотность разбиения
    // кривизны и потолок числа смешиваемых слотов текстурирования, REND-39),
    // вода (три ручки — источники ряби, слои детали и плотность выборки
    // глубины, REND-35), модели (две ручки), транзиентные эффекты (одна —
    // потолок дробления наземных фигур, REND-43), частицы (две — множитель
    // плотности и предел расстояния отсечения). Подсистема
    // позиций ручек не имеет и в реестре не появляется — реестр собирается из
    // того, что подсистемы объявили, а не из состава документа.
    expect(bench.quality.knobs.map((knob) => knob.name)).toEqual([
      'postprocess.bloom',
      'postprocess.bloomResolution',
      'postprocess.lut',
      'postprocess.antialias',
      'lighting.shadowMode',
      'lighting.shadowMapSize',
      'lighting.maxLocalLights',
      'fog.maskResolution',
      'terrain.curvatureTessellation',
      'terrain.textureSlots',
      'water.rippleSources',
      'water.detailLayers',
      'water.depthTexelsPerCell',
      'models.lodThresholdScale',
      'models.defaultTier',
      'effects.shapeDetail',
      'particles.density',
      // Предел расстояния отсечения эмиттеров (REND-24): вторая ручка частиц,
      // объявленная той же декларацией. Умолчание — «предела нет», и документы
      // стенда её не называют.
      'particles.cullDistance',
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
const SUBSYSTEM_PREFIXES = [
  'effects',
  'lighting',
  'models',
  'particles',
  'terrain',
  'water',
] as const;

function countersOf(prefix: string): (keyof RenderCostCounters)[] {
  const names = Object.keys(COST_COUNTER_STAGES) as (keyof RenderCostCounters)[];
  return names.filter((name) => name.startsWith(prefix));
}

describe('PERF-4: работа освещения, моделей, эффектов, частиц, террейна и воды видна эталону', () => {
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
    // А стенки обрывов мутация пола не двигает ВОВСЕ: cliff-геометрию ядро
    // выводит из карты УРОВНЕЙ (TERR-5), и пол в неё не входит (TERR-6). Чанк,
    // помеченный только полом, пересобирает пол и юбку, а меш стенок переживает
    // пересборку вместе со своим местом в реестре теневых кастеров. Ноль здесь
    // — величина, а не пропуск проверки: работа, которой в кадре больше нет.
    expect(run.render.terrainWallQuads).toBe(0);
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
    // Стенок в записи не пересобирается ни одной ни при одном пресете: их повод
    // — правка ФОРМЫ, а единственная работа террейна в матче — импульс пола
    // (TERR-6). Линейный рост кромки от потолка меряется там, где стенки
    // действительно строятся, — на сборке арены (ось `terrainTessellation`).
    expect(ultra.terrainWallQuads).toBe(0);
    expect(performance.terrainWallQuads).toBe(0);
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

  it('отсечение: хвост доставки за кадром не платит ни одной подсистеме', () => {
    // Три отсечения кадра, три подсистемы, одна причина — объекта нет в кадре:
    // инстансы (REND-21), оболочки эмиттеров (REND-24) и наземные фигуры
    // (REND-43). Хвост доставки стоит за ареной (`syntheticTick`), и без него
    // все три счётчика лежали бы нулями — экономию эталон бы не пинял (PERF-4).
    const axis = AXES.find((item) => item.axis === 'entities')!;
    const few = measureSize(axis.small);
    const many = measureSize(axis.large);
    const ratio = axis.large.magnitude / axis.small.magnitude;

    // Отсечённое есть на ОБОИХ размерах и растёт вместе с доставкой: хвост —
    // её доля, а отсечение — работа по числу объектов.
    expect(few.modelsCulled).toBeGreaterThan(0);
    expect(few.particlesShellsCulled).toBeGreaterThan(0);
    expect(few.effectsShapesCulled).toBeGreaterThan(0);
    expect(many.modelsCulled).toBe(ratio * few.modelsCulled);
    expect(many.particlesShellsCulled).toBe(ratio * few.particlesShellsCulled);
    expect(many.effectsShapesCulled).toBe(ratio * few.effectsShapesCulled);

    // И это ИМЕННО экономия, а не второй счётчик той же работы: отсечённый
    // инстанс не выбирает уровня детализации вовсе (REND-21, REND-22), и тест
    // отсечения каждого инстанса раскладывается на эти два исхода без остатка.
    for (const run of [few, many]) {
      expect(run.modelsCullTests).toBe(run.modelsCulled + run.modelsLodSelections);
    }

    // Оболочка эмиттера и наземная фигура есть у РАЗНЫХ видов манифеста
    // (`benchContent.ts`), и хвост доставки несёт оба: отсечённых оболочек
    // ровно столько же, сколько отсечённых фигур.
    expect(many.effectsShapesCulled).toBe(many.particlesShellsCulled);
    // Обе половины хвоста вместе — отсечённые инстансы: модель есть у каждого.
    expect(many.modelsCulled).toBe(many.particlesShellsCulled + many.effectsShapesCulled);
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
    // В ДОСТАВКЕ стенок нет ни одной: её повод — мутация пола, а пол
    // cliff-геометрию изменить не может (TERR-6, TERR-5).
    expect(coarse.terrainWallQuads).toBe(0);
    expect(fine.terrainWallQuads).toBe(0);
    // Линейный рост кромки от потолка виден там, где стенки СТРОЯТСЯ, — на
    // пересборке арены сменой пресета (QUAL-1): она метит все чанки формой, и
    // клетка с кривизной делит и пол (по площади), и кромку стенки под ним
    // (вдоль). Замер идёт от ДРУГОГО потолка: тот же документ пересборки не
    // вызывает вовсе — потолок не изменился.
    const atCeiling = (from: typeof axis.small, to: typeof axis.small): RenderCostCounters => {
      const bench = benchFor(from);
      const counters = createCostCounters();
      withCostSink(counters, () => {
        bench.quality.apply(to.preset!);
      });
      return counters;
    };
    const coarseBuild = atCeiling(axis.large, axis.small);
    const fineBuild = atCeiling(axis.small, axis.large);
    expect(fineBuild.terrainFloorQuads).toBeGreaterThan(2 * coarseBuild.terrainFloorQuads);
    expect(fineBuild.terrainWallQuads).toBeGreaterThan(coarseBuild.terrainWallQuads);
    expect(fineBuild.terrainWallQuads).toBeLessThanOrEqual(2 * coarseBuild.terrainWallQuads);
    // Пересобранных чанков столько же: потолок меняет цену пересборки, а не её
    // повод — им остаётся импульс пола стенда (TERR-6).
    expect(fine.terrainChunksRebuilt).toBe(coarse.terrainChunksRebuilt);
    // Ни моделям, ни частицам потолок террейна не адресован вовсе.
    expect(fine.modelsBatchTriangles).toBe(coarse.modelsBatchTriangles);
    expect(fine.particlesSystemsStepped).toBe(coarse.particlesSystemsStepped);
  });
});

// --------------------------- оси, чья нагрузка описана документом прогона (PERF-6)

/** Стоимость одного размера нагрузки симуляции: сводка стадии тика. */
function measureTickSize(size: AxisSize): StageCost {
  const { sink, total } = tickCostCollector();
  runScenario(size.def, sink);
  return sorted(total);
}

/** Стоимость одного размера нагрузки экстракции: счётчики стадии `extract`. */
function measureExtractSize(size: AxisSize): StageCost {
  const counters = createCostCounters();
  withCostSink(counters, () => {
    playExtraction(size.def);
  });
  return sorted(renderStages(counters).extract);
}

/**
 * Документ оси (PERF-6) — той же формы, что у осей рендера: величины обоих
 * размеров рядом со счётчиками обоих, «сначала S, потом L». Второй формы
 * документа стоимости в репозитории не заводится: отношение L/S читается в
 * диффе одинаково у любой оси.
 *
 * Стадия у такой оси ОДНА и названа именем секции: у нагрузок симуляции это
 * `tick` (ни клиента, ни кадра у них нет), у нагрузки экстракции — `extract`, у
 * оси числа клиентов — `wire` (PERF-12). Эталон в общем гейте затем, чтобы
 * удорожание краснело диффом на ревью, а не обнаруживалось на плейтесте;
 * принятие удорожания — та же явная регенерация `npm run golden:cost`.
 *
 * Размер оси параметризован, а не назван `AxisSize`, потому что нагрузка оси
 * описывается не всегда документом прогона: у оси провода размер — конфиг
 * матча. Общее у всех размеров одно — величина оси, и ровно её тип и требует.
 */
function axisDocument<Size extends { readonly magnitude: number }>(
  axis: string,
  stage: 'tick' | 'extract' | 'wire',
  sizes: { readonly small: Size; readonly large: Size },
  measure: (size: Size) => unknown,
): unknown {
  return {
    axis,
    small: sizes.small.magnitude,
    large: sizes.large.magnitude,
    cost: {
      small: { [stage]: measure(sizes.small) },
      large: { [stage]: measure(sizes.large) },
    },
  };
}

/** Документ оси стадии тика, разобранный на части, — вход проверок роста. */
interface SimAxisDocument {
  readonly axis: string;
  readonly small: number;
  readonly large: number;
  readonly cost: {
    readonly small: { readonly tick: TickCost };
    readonly large: { readonly tick: TickCost };
  };
}

/** То же для оси стадии экстракции: секция называется `extract`. */
interface ExtractAxisDocument {
  readonly axis: string;
  readonly small: number;
  readonly large: number;
  readonly cost: {
    readonly small: { readonly extract: StageCost };
    readonly large: { readonly extract: StageCost };
  };
}

/**
 * Стоимость NPC-части тика на двух размерах оси «число агентов» (`npc-behavior`
 * NPC-9, PERF-6): массовые крипы, режиссёр волн, маршрут и двое героев в центре;
 * малый размер — каждый второй агент (см. `npcStressSizes`).
 *
 * Побитового эталона состояния у нагрузки нет намеренно — основание в
 * `benchLoad.ts` рядом с её загрузчиком.
 */
function measureNpcStress(): unknown {
  return axisDocument('npcAgents', 'tick', npcStressSizes(), measureTickSize);
}

/**
 * Стоимость навигационной части тика на двух размерах оси «число агентов поиска
 * пути» (`pathfinding` NAV-5, PERF-6): сцена, где NPC идут по `findPath` через
 * узкий проход, вдоль обрыва и по рампе; большой размер размножает агента
 * маршрута (см. `navPathSizes`).
 */
function measureNavPath(): unknown {
  return axisDocument('navAgents', 'tick', navPathSizes(), measureTickSize);
}

describe('NAV-5: эталон стоимости поиска пути', () => {
  it('счётчики стадии тика совпадают с эталоном', () => {
    checkGolden(`${NAV_PATH}.cost.json`, measureNavPath());
  });

  it('нагрузка не мёртвая: поиск пути сделал работу и повторяется побитово', () => {
    const document = measureNavPath() as SimAxisDocument;
    expect(document.cost.large.tick.ticks).toBe(loadNavPath().ticks);
    // Своя строка эталона (PERF-3): работа навигации видна отдельно от работы
    // сетки соседей и от кандидатов broad-phase — в общей сумме удорожание
    // поиска утонуло бы.
    expect(document.cost.small.tick.navNodes).toBeGreaterThan(0);
    expect(measureNavPath()).toEqual(document);
  });

  it('PERF-6: второй размер оси — рост поиска виден отношением, а не одним числом', () => {
    const document = measureNavPath() as SimAxisDocument;
    const small = document.cost.small.tick;
    const large = document.cost.large.tick;

    // Размеры различаются РОВНО величиной оси, и тиков у них поровну: иначе
    // отношение L/S мерило бы длину прогона.
    expect(document.large).toBeGreaterThan(document.small);
    expect(large.ticks).toBe(small.ticks);
    // Каждый агент ищет путь сам (NAV-5): вчетверо больше ищущих — заметно
    // больше раскрытых узлов. Порог мягкий намеренно: эталон держит точные
    // числа, а тест держит СМЫСЛ оси — что она вообще двигает работу поиска.
    expect(large.navNodes).toBeGreaterThan(small.navNodes!);
  });
});

/**
 * Стоимость платформы способностей на двух размерах оси «число кастующих
 * агентов» (`ability-system` ABIL-5, ABIL-9, `buff-system` BUFF-3, PERF-6):
 * кастеры сеткой подтверждают шаг прицеливания по фигуре, кладут баффы на общие
 * цели, выпускают снаряды и наблюдают друг друга сквозь туман.
 *
 * Ось заведена ради строк, которых иначе в эталонах нет вовсе: ни записанные
 * матчи, ни нагрузки NPC и навигации платформ способностей, баффов, твинов и
 * видимости не поднимают, и все их счётчики лежали бы нулями (PERF-3).
 */
function measureAbilityStress(): unknown {
  return axisDocument('abilityCasters', 'tick', abilityStressSizes(), measureTickSize);
}

/** Счётчики платформ, ради которых ось и заведена: пусты они быть не вправе. */
const ABILITY_AXIS_COUNTERS = [
  'abilityCandidates',
  'buffCandidates',
  'buffSteps',
  'projectileSteps',
  'tweenSteps',
  'visibilityPairs',
  'eventsEmitted',
] as const;

/** Различимых пар «цель шага × сторона» у нагрузки: четыре цели, две стороны. */
const ABILITY_AXIS_GROUPS = 4;

describe('PERF-6: эталон стоимости платформы способностей', () => {
  it('счётчики стадии тика совпадают с эталоном', () => {
    checkGolden(`${ABILITY_STRESS}.cost.json`, measureAbilityStress());
  });

  it('нагрузка не мёртвая: каждая платформа оси сделала работу на ОБОИХ размерах', () => {
    const document = measureAbilityStress() as SimAxisDocument;
    // Ноль на любом из размеров означал бы, что нагрузка перестала поднимать
    // платформу, а эталон при этом остался бы зелёным: ноль сходится с нулём.
    for (const size of ['small', 'large'] as const) {
      const cost = document.cost[size].tick;
      for (const name of ABILITY_AXIS_COUNTERS) {
        expect(cost[name], `${size}/${name}`).toBeGreaterThan(0);
      }
    }
    expect(measureAbilityStress()).toEqual(document);
  });

  it('PERF-6: ось двигает ровно одну величину — различается только число кастеров', () => {
    const { small, large } = abilityStressSizes();
    const spawns = (def: ScenarioDef, caster: boolean): ScenarioSpawn[] =>
      (def.scene.initial ?? []).filter((spawn) => (spawn.prefab === 'Caster') === caster);

    // Всё, что не кастер, — цели шага и укрытия — совпадает записью в запись, а
    // сцена без расстановки (компоненты, prefab'ы, системы, таблицы, террейн) —
    // целиком: ось не вправе двигать ничего, кроме числа кастующих агентов.
    expect(spawns(small.def, false)).toEqual(spawns(large.def, false));
    expect({ ...small.def.scene, initial: [] }).toEqual({ ...large.def.scene, initial: [] });

    const thin = spawns(small.def, true);
    const full = spawns(large.def, true);
    expect(thin).toHaveLength(small.magnitude);
    expect(full).toHaveLength(large.magnitude);

    // Охват сетки у размеров один и тот же: прореживание идёт по столбцам и
    // строкам и оставляет её углы на местах. Иначе радиус обзора и радиус скана
    // ловили бы разную геометрию, и отношение L/S мерило бы её, а не ось.
    const extent = (list: readonly ScenarioSpawn[]): readonly number[] => {
      const xs = list.map((spawn) => spawn.overrides!.Position!.x!);
      const ys = list.map((spawn) => spawn.overrides!.Position!.y!);
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    };
    expect(extent(thin)).toEqual(extent(full));

    // Набор «точка прицела × сторона» тоже один и тот же: цели наложения и
    // стороны тумана — свойства блока сетки, а не порядкового номера кастера.
    const spread = (list: readonly ScenarioSpawn[]): string[] =>
      [...new Set(list.map((spawn) => JSON.stringify([spawn.overrides!.Input, spawn.overrides!.Player])))].sort();
    expect(spread(thin)).toEqual(spread(full));
    expect(spread(thin)).toHaveLength(ABILITY_AXIS_GROUPS);
  });

  it('PERF-6: скан таргетинга и пары видимости растут БЫСТРЕЕ числа кастеров', () => {
    const document = measureAbilityStress() as SimAxisDocument;
    const small = document.cost.small.tick;
    const large = document.cost.large.tick;
    const casters = document.large / document.small;

    // Размеры отличаются ровно величиной оси: тиков поровну, растёт только
    // число кастующих агентов.
    expect(large.ticks).toBe(small.ticks);
    expect(casters).toBeGreaterThan(1);
    // Скан кандидатов идёт запросом к миру на КАЖДОЕ подтверждение шага, а сам
    // мир растёт кастерами: работа растёт произведением, и отношение L/S это
    // показывает — по одному числу суперлинейность не видна (ABIL-5).
    expect(large.abilityCandidates).toBeGreaterThan(casters * small.abilityCandidates!);
    // Пары «наблюдатель × цель» — та же квадратичность по построению FoW:
    // каждый добавленный кастер и сам наблюдает, и попадает в чужие выборки.
    expect(large.visibilityPairs).toBeGreaterThan(casters * small.visibilityPairs!);
    // Шаги снарядов, наоборот, линейны числу кастеров: один каст — один снаряд.
    // Строка рядом с квадратичными и нужна затем, чтобы отличать одно от другого.
    expect(large.projectileSteps).toBe(casters * small.projectileSteps!);
  });
});

/**
 * Стоимость data-driven слоя на двух размерах оси «число сущностей, которые
 * обрабатывают JSON-системы» (`data-driven-systems` SYS-1, PERF-6): четыре
 * системы сцены — движение, ветвление, запрос с фильтрами и эмиссия события —
 * над сеткой сущностей одного prefab'а.
 *
 * Набор систем у размеров ФИКСИРОВАН, и двигается только число сущностей: ось
 * проверяет ровно то, чего по одному размеру не видно, — линейна ли работа
 * evaluator'а по обработанной сущности. На записанных матчах `expressions`
 * набирает несколько сотен за прогон, а на осях NPC и навигации он ноль вовсе:
 * их нагрузки собраны нативными системами.
 */
function measureDslScale(): unknown {
  return axisDocument('dslEntities', 'tick', dslScaleSizes(), measureTickSize);
}

/** Счётчики, ради которых ось и заведена: пусты они быть не вправе. */
const DSL_AXIS_COUNTERS = ['commandsApplied', 'eventsEmitted', 'expressions'] as const;

describe('SYS-1, PERF-6: эталон стоимости data-driven слоя', () => {
  it('счётчики стадии тика совпадают с эталоном', () => {
    checkGolden(`${DSL_SCALE}.cost.json`, measureDslScale());
  });

  it('нагрузка не мёртвая: выражения, команды и события непусты на ОБОИХ размерах', () => {
    const document = measureDslScale() as SimAxisDocument;
    // Ноль на любом из размеров означал бы, что нагрузка перестала поднимать
    // evaluator, а эталон при этом остался бы зелёным: ноль сходится с нулём.
    for (const size of ['small', 'large'] as const) {
      const cost = document.cost[size].tick;
      expect(cost.ticks, size).toBe(dslScaleSizes().small.def.ticks);
      for (const name of DSL_AXIS_COUNTERS) {
        expect(cost[name], `${size}/${name}`).toBeGreaterThan(0);
      }
    }
    expect(measureDslScale()).toEqual(document);
  });

  it('работа идёт на КАЖДОМ тике прогона, а не только на первом', () => {
    // Сумма за прогон этого не показывает: нагрузка, отработавшая один тик и
    // высохшая, дала бы непустой эталон и мерила бы дальше пустоту.
    const rows: StageCost[] = [];
    const sink: DiagnosticsSink = {
      trace: 'systems',
      record: (entry) => {
        if (entry.code !== 'TICK_COST') return;
        const row: StageCost = {};
        for (const [name, value] of Object.entries(entry.data ?? {})) {
          if (typeof value === 'number') row[name] = value;
        }
        rows.push(row);
      },
    };
    const { small } = dslScaleSizes();
    runScenario(small.def, sink);
    expect(rows).toHaveLength(small.def.ticks);
    for (const [index, row] of rows.entries()) {
      expect(row.expressions, `тик ${index}: выражения`).toBeGreaterThan(0);
      expect(row.commandsApplied, `тик ${index}: команды`).toBeGreaterThan(0);
    }
  });

  it('PERF-6: ось двигает ровно одну величину — различается только число сущностей', () => {
    const { small, large } = dslScaleSizes();
    const spawns = (def: ScenarioDef): readonly ScenarioSpawn[] => def.scene.initial ?? [];

    // Сцена без расстановки — компоненты, prefab, системы, ёмкость — совпадает
    // целиком: набор JSON-систем оси фиксирован (PERF-6), и двигать его вместе
    // с числом сущностей значило бы мерить две величины одним отношением.
    expect({ ...small.def.scene, initial: [] }).toEqual({ ...large.def.scene, initial: [] });
    expect(large.def.ticks).toBe(small.def.ticks);
    expect(large.def.seed).toBe(small.def.seed);
    // Ни физики, ни видимости, ни навигации у прогона нет: их счётчики растут
    // плотностью расстановки и геометрией арены, а не числом обработанных
    // сущностей, и на этой оси двигали бы вторую величину.
    for (const def of [small.def, large.def]) {
      expect(def.physics).toBeUndefined();
      expect(def.visibility).toBeUndefined();
      expect(def.navigation).toBeUndefined();
      expect(def.locomotion).toBeUndefined();
    }

    // Малый размер — ПРЕФИКС расстановки большого, запись в запись. Префикс, а
    // не прореживание сетки (как у оси NPC), законен здесь потому, что
    // пространственного запроса у нагрузки нет вовсе: позиции она пишет и
    // никогда не читает соседством, поэтому охват сетки ни одного счётчика не
    // касается.
    expect(spawns(small.def)).toHaveLength(small.magnitude);
    expect(spawns(large.def)).toHaveLength(large.magnitude);
    expect(spawns(large.def).slice(0, small.magnitude)).toEqual(spawns(small.def));

    // Доля каждого варианта начальных значений у размеров одна и та же: иначе
    // отношение L/S мерило бы заодно и состав ветвей, вычисленных односторонним
    // действием `if` (ACT-1), — то есть вторую величину под видом первой.
    const variants = (list: readonly ScenarioSpawn[]): Record<string, number> => {
      const seen: Record<string, number> = {};
      for (const spawn of list) {
        const key = JSON.stringify([spawn.prefab, spawn.overrides?.Health, spawn.overrides?.Velocity]);
        seen[key] = (seen[key] ?? 0) + 1;
      }
      return seen;
    };
    const ratio = large.magnitude / small.magnitude;
    const thin = variants(spawns(small.def));
    const full = variants(spawns(large.def));
    expect(Object.keys(full).sort()).toEqual(Object.keys(thin).sort());
    for (const [key, count] of Object.entries(thin)) expect(full[key], key).toBe(ratio * count);
  });

  it("PERF-6: работа evaluator'а линейна — счётчики оси растут РОВНО её отношением", () => {
    const document = measureDslScale() as SimAxisDocument;
    const small = document.cost.small.tick;
    const large = document.cost.large.tick;
    const ratio = document.large / document.small;

    // Размеры отличаются ровно величиной оси: тиков поровну, растёт только
    // число обрабатываемых сущностей.
    expect(large.ticks).toBe(small.ticks);
    expect(ratio).toBeGreaterThan(1);
    // Ради ЭТИХ строк ось и заведена (PERF-6, сценарий «Evaluator вычисляет
    // выражение на каждую пару сущностей»): работа evaluator'а на сущность от
    // числа сущностей не зависит, поэтому счётчики ОСИ обязаны вырасти ровно её
    // отношением. Обход запроса заново на каждую обработанную сущность или
    // повторное вычисление выражения на шаг сломали бы равенство первым же
    // прогоном — по одному числу этого не видно вовсе. Сильная форма (точное
    // равенство, а не порог) взята с оси экстракции: линейность там тоже
    // свойство построения нагрузки, а не пожелание к ней.
    //
    // Проверка адресована ИМЕННО счётчикам оси, а не всей записи: счётчик,
    // чей вклад в эту нагрузку постоянен на тик или на систему, растёт с осью
    // сублинейно — по PERF-6 это законно («отдельный счётчик ВНУТРИ стадии, у
    // которой ось есть, вправе ни одной осью не двигаться»), и общий цикл
    // краснел бы на нём диффом, которого не снимает никакая регенерация.
    for (const name of DSL_AXIS_COUNTERS) {
      expect(large[name], name).toBe(ratio * small[name]!);
    }
  });

  it('нагрузка поднимает ТОЛЬКО evaluator: счётчики прочих платформ ядра пусты', () => {
    // Утверждение о форме нагрузки, а не о линейности: ни физики, ни видимости,
    // ни навигации, ни платформ способностей у прогона нет (их работа росла бы
    // плотностью и геометрией, то есть второй величиной), и потому их строки в
    // эталоне — нули. Появление ненулевой строки означает, что в нагрузку
    // приехала чужая платформа, и ось перестала быть осью одной величины.
    const document = measureDslScale() as SimAxisDocument;
    const axis = new Set<string>([...DSL_AXIS_COUNTERS, 'ticks']);
    for (const size of ['small', 'large'] as const) {
      for (const [name, value] of Object.entries(document.cost[size].tick)) {
        if (axis.has(name)) continue;
        expect(value, `${size}/${name}`).toBe(0);
      }
    }
  });
});

describe('NPC-9: эталон стоимости массы NPC', () => {
  it('счётчики стадии тика совпадают с эталоном', () => {
    checkGolden(`${NPC_STRESS}.cost.json`, measureNpcStress());
  });

  it('нагрузка не мёртвая: работа тика сделана каждым счётчиком объёма', () => {
    const document = measureNpcStress() as SimAxisDocument;
    const large = document.cost.large.tick;
    expect(large.ticks).toBe(loadNpcStress().ticks);
    expect(large.commandsApplied).toBeGreaterThan(0);
    // Выборка соседей платформы поведения — СВОЯ строка эталона (NPC-6, NPC-9),
    // и разделение это не косметическое: вся выборка нагрузки приходится на
    // сетку агентов, а broad-phase физики на ней не делает ничего (коллайдеры
    // крипов никого не блокируют). В общем счётчике удорожание луча утонуло бы
    // в этих девяноста тысячах бесследно.
    expect(large.npcNeighbors).toBeGreaterThan(0);
    expect(large.broadPhasePairs).toBe(0);
  });

  it('PERF-6: выборка соседей растёт БЫСТРЕЕ числа агентов — квадратичность видна', () => {
    const document = measureNpcStress() as SimAxisDocument;
    const small = document.cost.small.tick;
    const large = document.cost.large.tick;
    const agents = document.large / document.small;

    // Размеры отличаются ровно величиной оси: тиков поровну, растёт только
    // число агентов.
    expect(large.ticks).toBe(small.ticks);
    expect(agents).toBeGreaterThan(1);
    // Ради ЭТОЙ строки PERF-6 и требует двух размеров: осмотренные соседи
    // растут быстрее, чем сами агенты (каждый добавленный агент и сам ищет
    // соседей, и попадает в чужие выборки), и суперлинейность читается
    // отношением L/S прямо в диффе эталона — по одному числу её не видно.
    expect(large.npcNeighbors).toBeGreaterThan(agents * small.npcNeighbors!);
  });
});

/**
 * Стоимость экстракции на двух размерах оси «число сущностей доставки» (PERF-2,
 * PERF-6). Стадия `extract` есть у каждого записанного матча, но записи — это
 * нагрузка, а не ось: их состав фиксирован, и по одному размеру не видно,
 * линейна ли экстракция по числу сущностей. Ось отвечает на это вторым
 * размером — и она же закрывает обязанность PERF-6 иметь ось у КАЖДОЙ стадии,
 * для которой синтетическую нагрузку построить можно.
 */
function measureExtract(): unknown {
  return axisDocument('extractEntities', 'extract', extractSizes(), measureExtractSize);
}

describe('PERF-2, PERF-6: эталон стоимости экстракции на двух размерах', () => {
  it('счётчики стадии экстракции совпадают с эталоном', () => {
    checkGolden('extract.cost.json', measureExtract());
  });

  it('экстракция линейна по числу сущностей — отношение L/S равно отношению осей', () => {
    const document = measureExtract() as ExtractAxisDocument;
    const small = document.cost.small.extract;
    const large = document.cost.large.extract;
    const ratio = document.large / document.small;

    // Тиков поровну: величина оси — сущности, а не длина прогона.
    expect(large.extractCalls).toBe(small.extractCalls);
    // Обход мира, копирование колонок, статы и объём, отданный каналу, растут
    // РОВНО отношением осей: экстракция линейна по сущности. Поиск по сущности
    // в чужом списке (классическая квадратичность этого шва) сломал бы равенство
    // на первом же прогоне — ради этого ось и заведена.
    expect(large.extractEntitiesScanned).toBe(ratio * small.extractEntitiesScanned!);
    expect(large.extractEntitiesCopied).toBe(ratio * small.extractEntitiesCopied!);
    expect(large.extractStatPairs).toBe(ratio * small.extractStatPairs!);
    expect(large.extractChannelValues).toBe(ratio * small.extractChannelValues!);
  });

  it('нагрузка не мёртвая: обход, статы и объём канала непусты', () => {
    const document = measureExtract() as ExtractAxisDocument;
    const small = document.cost.small.extract;
    expect(small.extractCalls!).toBeGreaterThan(0);
    expect(small.extractEntitiesCopied!).toBeGreaterThan(0);
    expect(small.extractStatPairs!).toBeGreaterThan(0);
    expect(small.extractChannelValues!).toBeGreaterThan(0);
  });
});

// ------------------------------------------- провод сервера (PERF-12, PERF-6)

/**
 * Слот, чьи величины лежат в документе оси рядом с суммой. Именованной
 * константой, а не литералом по месту: тот же слот читают проверки роста, и
 * «сумма и слот» обязаны говорить об одном и том же соединении.
 *
 * Это слот ПЕРВОЙ команды нагрузки. Второй в документе нет намеренно: слоты
 * одной команды у нагрузки совпадают до байта (это утверждает тест), а обе
 * команды разом видны суммой — по слоту на каждую документ раздувал бы вдвое,
 * ничего не добавляя к диффу.
 */
const AXIS_SLOT = 'p1';

/**
 * Документ оси «число соединений одного матча» (PERF-6, PERF-12): по размеру —
 * сумма по всем слотам и тот же набор величин по слоту `p1`.
 *
 * Двумя наборами, а не одним: сумма отвечает на вопрос оси (растёт ли провод
 * быстрее числа клиентов), слот — на вопрос «за чей счёт». Работа на слот
 * растёт населённостью мира, а не числом слотов, и расхождение этих двух строк
 * в диффе и есть то самое «клиенты × сущности», которое PERF-6 велит читать
 * отношением L/S.
 *
 * Размеры меряются ДО построения документа: прогон провода асинхронен
 * (loopback доставляет через микрозадачи, NTR-2), а форма документа у всех осей
 * одна и синхронна — второй формы ради одной оси не заводится.
 */
async function measureWireClients(): Promise<unknown> {
  const sizes = wireClientsSizes();
  const runs = new Map<number, WireRun>();
  for (const size of [sizes.small, sizes.large]) runs.set(size.magnitude, await playWireClients(size));
  return axisDocument('clients', 'wire', sizes, (size) => {
    const run = runs.get(size.magnitude)!;
    return { [AXIS_SLOT]: wireSlot(run, AXIS_SLOT), total: wireTotal(run) };
  });
}

/** Документ оси провода, разобранный на части, — вход проверок роста. */
interface WireAxisDocument {
  readonly axis: string;
  readonly small: number;
  readonly large: number;
  readonly cost: {
    readonly small: { readonly wire: Record<string, StageCost> };
    readonly large: { readonly wire: Record<string, StageCost> };
  };
}

describe('PERF-12: эталон стоимости провода на записанных матчах (CLI-10)', () => {
  it('NTR-22: пропусков рассылки на loopback-стенде нет ни у одного соединения', async () => {
    // Пропуск на стенде без очереди — дефект стенда, а не стоимость (PERF-12):
    // потому это утверждение теста, а не поле эталона. Попади оно в эталон —
    // пропуски принимались бы регенерацией наравне с байтами.
    for (const match of RECORDED_MATCHES) {
      const run = await playWire(match);
      for (const [slot, skipped] of Object.entries(run.skipped)) {
        expect(skipped, `${match}/${slot}: пропущенные снапшоты`).toBe(0);
      }
    }
  });

  it('провод не мёртвый: снапшот на тик каждому слоту, и доставленное непусто', async () => {
    for (const match of RECORDED_MATCHES) {
      const def = loadRecording(match);
      const { sink, total } = tickCostCollector();
      playRecording(def, { diagnostics: sink });
      const run = await playWire(match);
      // Слотов у записи столько же, сколько игроков: молчаливо выродившийся до
      // одного слота стенд дал бы эталон вдвое дешевле — и зелёный.
      expect(Object.keys(run.slots).sort()).toEqual([...(def.players ?? [])].sort());
      for (const [slot, cost] of Object.entries(run.slots)) {
        const where = `${match}/${slot}`;
        // Темп рассылки записей — снапшот на тик (`duelConfig`): равенство
        // числа снапшотов числу тиков и есть проверка, что провод работал весь
        // прогон, а не первые кадры.
        expect(cost.snapshots, `${where}: снапшоты`).toBe(def.ticks);
        // Две половины секции сходятся: сколько хост отправил (NTR-11), столько
        // клиент и применил. Без этой строки состав доставленного в эталоне мог
        // бы относиться к другому числу снапшотов, чем байты рядом с ним.
        expect(run.applied[slot], `${where}: применённые снапшоты`).toBe(cost.snapshots);
        expect(cost.snapshotBytes, `${where}: байты снапшотов`).toBeGreaterThan(0);
        expect(cost.entitiesDelivered, `${where}: сущности`).toBeGreaterThan(0);
        // Хендшейк (NTR-4) ушёл каждому соединению: ноль означал бы, что матч
        // не начинался вовсе.
        expect(cost.bytesOther, `${where}: байты помимо снапшотов`).toBeGreaterThan(0);
        // Ноль доставленных фактов — не молчание стенда, а свойство записи:
        // сцена дуэли событий не порождает вовсе, и это видно СВОДКОЙ ТИКА
        // рядом. Начни запись их порождать — ноль здесь станет красным.
        expect(cost.eventsDelivered > 0, `${where}: факты`).toBe(total.eventsEmitted! > 0);
      }
    }
  });

  it('PERF-12: доставленные факты — весь поток за прогон, а не хвост очереди', async () => {
    // Записи набора событий не порождают вовсе, и счётчик фактов на них
    // законно нулевой — то есть зелёный одинаково и когда он верен, и когда
    // сломан. Отдельная нагрузка с публикацией на каждого героя каждый тик и
    // существует затем, чтобы величина хоть раз была проверена НЕНУЛЕВОЙ.
    //
    // Считать факты по концу прогона нельзя: очередь фактов сливает каждый шаг
    // клиентского хоста (NTR-15), и в ней остаются лишь пачки последнего шага.
    // Равенство «доставлено = опубликовано» — проверка ровно этого: сойтись оно
    // может только у счётчика, снимаемого по ходу матча.
    const { publishing, silent } = wireEventsSizes();
    const { sink, total } = tickCostCollector();
    const run = await playWireClients(publishing, sink);
    const quiet = await playWireClients(silent);
    expect(total.eventsEmitted).toBeGreaterThan(0);
    for (const [slot, cost] of Object.entries(run.slots)) {
      // Тумана на сцене нет: каждый опубликованный факт видим обоим слотам
      // (NET-13), и потому доставленное слоту равно опубликованному целиком.
      expect(cost.eventsDelivered, `${slot}: факты`).toBe(total.eventsEmitted);
      // Молчащий близнец нагрузки фактов не доставляет ни одного.
      expect(wireSlot(quiet, slot).eventsDelivered, `${slot}: молчащая нагрузка`).toBe(0);
      // Байты потока видны РАЗНОСТЬЮ, а не порогом: `bytesOther` несёт ещё и
      // хендшейк, и «больше нуля» у него верно и без единого факта. Строгое
      // превосходство над молчащим близнецом и означает, что поток на проводе.
      expect(cost.bytesOther, `${slot}: байты потока`).toBeGreaterThan(
        wireSlot(quiet, slot).bytesOther!,
      );
    }
  });
});

describe('PERF-6, PERF-12: эталон стоимости провода на двух размерах числа клиентов', () => {
  it('счётчики провода совпадают с эталоном', async () => {
    checkGolden(`${WIRE_CLIENTS}.cost.json`, await measureWireClients());
  });

  it('PERF-6: всё, кроме расстановки героев по слотам, у размеров совпадает', () => {
    const { small, large } = wireClientsSizes();

    // Что именно эта проверка утверждает: размеры различаются числом слотов и
    // порождённой им расстановкой — по герою на слот, — и БОЛЬШЕ ничем. Мир при
    // этом населённостью не фиксирован и фиксирован быть не может: слот без
    // своей сущности — не слот (NET-15, ему нечего показать в собственном
    // снапшоте), и «число клиентов при неизменном населении» осью не бывает.
    // Ровно поэтому сумма провода и растёт произведением, а не числом слотов.
    //
    // Сцена без расстановки — компоненты, prefab'ы, системы, ёмкость — совпадает
    // целиком: ось не вправе двигать ни одну ДРУГУЮ величину.
    expect({ ...small.config.scene, initial: [] }).toEqual({ ...large.config.scene, initial: [] });
    // Темп рассылки, буфер задержки ввода и seed — те же: иначе отношение L/S
    // мерило бы частоту снапшотов или длину прогона под видом числа клиентов.
    expect(large.config.seed).toBe(small.config.seed);
    expect(large.config.tickRate).toBe(small.config.tickRate);
    expect(large.config.snapshotRate).toBe(small.config.snapshotRate);
    expect(large.config.inputDelay).toBe(small.config.inputDelay);

    // Расстановка равна величине оси: игроков, команд и героев ровно столько
    // же, сколько соединений, — по одному на слот, ни одного лишнего.
    for (const size of [small, large]) {
      expect(size.config.players, `${size.magnitude}: игроки`).toHaveLength(size.magnitude);
      expect(size.config.teams, `${size.magnitude}: команды`).toHaveLength(size.magnitude);
      expect(size.config.initial, `${size.magnitude}: расстановка`).toHaveLength(size.magnitude);
    }
    // Малый размер — ПРЕФИКС большого запись в запись: ни имена игроков, ни
    // позиции героев, ни раскладка команд у размеров не разъезжаются.
    expect(large.config.players.slice(0, small.magnitude)).toEqual(small.config.players);
    expect(large.config.teams!.slice(0, small.magnitude)).toEqual(small.config.teams);
    expect(large.config.initial!.slice(0, small.magnitude)).toEqual(small.config.initial);
  });

  it('нагрузка не мёртвая: слоты команды симметричны, и величины провода непусты', async () => {
    const sizes = wireClientsSizes();
    for (const size of [sizes.small, sizes.large]) {
      const run = await playWireClients(size);
      expect(Object.keys(run.slots), `${size.magnitude}: слоты`).toHaveLength(size.magnitude);
      const first = wireSlot(run, AXIS_SLOT);
      expect(first.snapshotBytes, `${size.magnitude}: байты`).toBeGreaterThan(0);
      expect(first.entitiesDelivered, `${size.magnitude}: сущности`).toBeGreaterThan(0);
      for (const [slot, skipped] of Object.entries(run.skipped)) {
        expect(skipped, `${size.magnitude}/${slot}: пропущенные снапшоты (NTR-22)`).toBe(0);
      }
      // Симметрия у нагрузки ПО КОМАНДЕ, а не по всем слотам: линии команд
      // стоят напротив друг друга, и место в линии на видимость не влияет —
      // свою команду сущность видит всегда (FOW-3), чужая за радиусом обзора.
      // Расхождение слотов ОДНОЙ команды означало бы, что работа на слот стала
      // зависеть от номера слота, то есть ось перестала двигать одну величину;
      // расхождение команд между собой законно и ожидаемо — их снапшоты режет
      // фильтр по разным точкам обзора (NET-12).
      const teams = new Map<number, string[]>();
      for (const [index, player] of size.config.players.entries()) {
        const team = index % 2;
        teams.set(team, [...(teams.get(team) ?? []), player]);
      }
      for (const [team, players] of teams) {
        const head = wireSlot(run, players[0]!);
        for (const player of players) {
          expect(wireSlot(run, player), `${size.magnitude}/команда ${team}/${player}`).toEqual(head);
        }
      }
    }
  });

  it('PERF-12: фильтр видимости ДЕЙСТВИТЕЛЬНО вырезает — слоту едет не весь мир', async () => {
    // Без этой проверки ось мерила бы фильтр, которому нечего резать: на сцене
    // без масок персональный снапшот равен полному миру, сценарий PERF-12
    // «Фильтр перестал вырезать невидимое» становится пустым, а разложение по
    // слотам — одним числом, записанным дважды.
    //
    // Населённость мира приезжает записью тика (`TICK_FOOTPRINT`, PERF-8), а не
    // пересчётом расстановки в тесте: сравнивать доставленное надо с тем, что
    // в мире ДЕЙСТВИТЕЛЬНО было, включая носителей сцены (TERR-6, ARENA-1).
    for (const size of [wireClientsSizes().small, wireClientsSizes().large]) {
      let alive = 0;
      const sink: DiagnosticsSink = {
        trace: 'systems',
        record: (entry) => {
          if (entry.code !== 'TICK_FOOTPRINT') return;
          alive = Math.max(alive, Number(entry.data?.entitiesAlive ?? 0));
        },
      };
      const run = await playWireClients(size, sink);
      expect(alive, `${size.magnitude}: населённость мира`).toBeGreaterThan(size.magnitude);
      for (const [slot, cost] of Object.entries(run.slots)) {
        expect(
          cost.entitiesDelivered,
          `${size.magnitude}/${slot}: доставлено против полного мира`,
        ).toBeLessThan(cost.snapshots * alive);
      }
    }
  });

  it('PERF-6: суммарный провод растёт БЫСТРЕЕ числа клиентов', async () => {
    const document = (await measureWireClients()) as WireAxisDocument;
    const small = document.cost.small.wire;
    const large = document.cost.large.wire;
    const clients = document.large / document.small;

    // Прогон один по длине: снапшотов слоту поровну на обоих размерах — иначе
    // отношение L/S мерило бы длину матча, а не число соединений.
    expect(large[AXIS_SLOT]!.snapshots).toBe(small[AXIS_SLOT]!.snapshots);
    expect(clients).toBeGreaterThan(1);
    // Ради ЭТОЙ строки ось и заведена (PERF-6, сценарий «Провод растёт быстрее
    // числа клиентов»): каждый добавленный клиент и сам получает снапшот, и
    // попадает в снапшоты своей команды, поэтому суммарные величины растут
    // произведением «клиенты × сущности», а не числом клиентов. По одному
    // размеру этого не видно вовсе.
    expect(large.total!.entitiesDelivered).toBeGreaterThan(
      clients * small.total!.entitiesDelivered!,
    );
    expect(large.total!.snapshotBytes).toBeGreaterThan(clients * small.total!.snapshotBytes!);
    // И медленнее квадрата. У сущностей строгое «<» держит ПОСТОЯННЫЙ член:
    // носители сцены — террейн (TERR-6) и арена (ARENA-1) — едут каждому слоту в
    // каждом снапшоте независимо от населённости, и с ними сумма N·(C + N/2)
    // растёт медленнее N². Фильтр видимости (NET-12), вырезающий слоту чужую
    // команду, сам по себе на границу не влияет — при C = 0 «половина прироста»
    // даёт ровно N², — он лишь расширяет запас. Рост между линейным и
    // квадратичным и есть то, что эталон обязан показывать числом.
    expect(large.total!.entitiesDelivered).toBeLessThan(
      clients * clients * small.total!.entitiesDelivered!,
    );
    // У байтов постоянный член свой: помимо носителей сцены у кадра есть часть,
    // не зависящая от населённости вовсе, — номер тика, схема идентификаторов,
    // машина состояний (NET-18).
    expect(large.total!.snapshotBytes).toBeLessThan(clients * clients * small.total!.snapshotBytes!);
    // А работа НА СЛОТ растёт населённостью мира, а не числом слотов: строка
    // слота рядом с суммой и отличает «клиенты × сущности» от квадратичности
    // внутри одного слота — там её нет и быть не должно.
    expect(large[AXIS_SLOT]!.entitiesDelivered).toBeGreaterThan(
      small[AXIS_SLOT]!.entitiesDelivered!,
    );
    expect(large[AXIS_SLOT]!.entitiesDelivered).toBeLessThan(
      clients * small[AXIS_SLOT]!.entitiesDelivered!,
    );
  });
});

describe('PERF-3: счётчики машинно-независимы', () => {
  it('повторный прогон в одном процессе даёт побитово тот же документ', async () => {
    // Документ целиком, вместе с секцией провода (PERF-12): байты персональных
    // снапшотов воспроизводимы ровно потому, что фильтр — чистая функция
    // состояния и точки обзора, а кодек — чистая функция сообщения; ни времени,
    // ни транспорта в них нет.
    for (const match of RECORDED_MATCHES) {
      const first = await measureMatchDocument(match);
      const second = await measureMatchDocument(match);
      expect(second).toEqual(first);
      expect(canonical(second)).toBe(canonical(first));
    }
  });

  it('оси масштабирования повторяются так же', () => {
    const first = scalingDocument();
    expect(scalingDocument()).toEqual(first);
    expect(canonical(scalingDocument())).toBe(canonical(first));
  });

  it('оси экстракции повторяются так же — на обоих размерах (PERF-2)', () => {
    const first = measureExtract();
    expect(measureExtract()).toEqual(first);
    expect(canonical(measureExtract())).toBe(canonical(first));
  });

  it('стресс-нагрузка NPC повторяется так же (NPC-9) — на обоих размерах', () => {
    const first = measureNpcStress();
    expect(measureNpcStress()).toEqual(first);
    expect(canonical(measureNpcStress())).toBe(canonical(first));
  });

  it('ось числа клиентов повторяется так же (PERF-12) — на обоих размерах', async () => {
    const first = await measureWireClients();
    expect(await measureWireClients()).toEqual(first);
    expect(canonical(await measureWireClients())).toBe(canonical(first));
  });
});
