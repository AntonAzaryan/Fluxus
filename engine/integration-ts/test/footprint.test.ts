/**
 * Голден-гейт занятой памяти (`performance-budget` PERF-8) — точная сверка
 * детерминированных величин с закоммиченным эталоном, по процедуре PERF-4.
 *
 * ## Что сверяется
 *
 * - На каждом записанном матче (CLI-10) — `engine/tests/golden/<матч>.footprint.json`:
 *   секция `tick` (пики записей `TICK_FOOTPRINT` ядра, DIAG-1 уровень `systems`),
 *   секция `history` (снапшотов в кольце × ёмкость мира — байты полных копий
 *   SNAP-4) и по секции на пресет качества (QUAL-4) с живыми ресурсами GPU по
 *   владельцу и виду и величинами состояния. Секции `tick` и `history` — по
 *   одной: симуляция пресета не знает (QUAL-2), и равенство между прогонами
 *   двух пресетов здесь проверяется, а не предполагается.
 * - На осях PERF-6 — те же шесть документов, что у стоимости: `scaling`
 *   (величины рендера на двух размерах каждой оси), `npc-stress`, `nav-path`,
 *   `ability-stress`, `dsl-scale` и `extract` (величины ядра на двух размерах).
 *
 * ## Почему отдельный документ, а не секция в `*.cost.json`
 *
 * «Подорожала работа» и «выросла память» — разные решения на ревью, и сливать
 * их в один дифф значило бы принимать одно вместо другого (design D5). Команда
 * регенерации при этом ОДНА — `npm run golden:cost` (UPDATE_COST=1): жест
 * «принять удорожание» один, и разводить его на две команды значило бы удвоить
 * то, что и так забывают.
 *
 * ## Чего в этом эталоне нет
 *
 * Байтов кучи среды исполнения — ни одного (PERF-8): они меняются с версией
 * среды при неизменном коде, и гейт краснел бы, ничего не поймав. Их рост
 * стережёт сторож PERF-10 (`memory.test.ts`), у которого нет эталона вовсе.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RingHistory, runScenario, type DiagnosticRecord, type DiagnosticsSink } from '@fluxus/core';
import {
  createFootprint,
  footprintPeakLive,
  withFootprintSink,
  type RenderFootprint,
} from '@fluxus/render';
import {
  ABILITY_STRESS,
  BENCH_PRESETS,
  BENCH_PRESET_NAMES,
  DSL_SCALE,
  GOLDEN_DIR,
  NAV_PATH,
  NPC_STRESS,
  RECORDED_MATCHES,
  abilityStressSizes,
  benchGrid,
  dslScaleSizes,
  extractSizes,
  loadRecording,
  matchBench,
  navPathSizes,
  npcStressSizes,
  playExtraction,
  playRecording,
  syntheticTick,
  type AxisSize,
  type BenchPresetName,
} from './benchLoad.js';
import { SCALING_AXES, SCALING_EXTENT, benchFor, type ScalingSize } from './benchAxes.js';

const UPDATE = process.env.UPDATE_COST === '1';

/** Плоский набор именованных величин — то, что лежит в секции эталона. */
type StateFootprint = Record<string, number>;

// ------------------------------------------------------- величины ядра (PERF-8)

/**
 * Величины занятой памяти тика — ПИКИ записей `TICK_FOOTPRINT` за прогон
 * (PERF-8): память есть состояние, и сумма для неё бессмысленна. `ticks` считает
 * сами записи — без него по эталону не прочесть, на скольких тиках пик снят.
 */
interface TickFootprint extends StateFootprint {
  commandsPeak: number;
  entitiesAlive: number;
  entitiesFree: number;
  eventsPeak: number;
  navBytes: number;
  navHeapCapacity: number;
  tagEntries: number;
  ticks: number;
  worldBytes: number;
}

/** Поля записи, по которым берётся максимум; `ticks` считается отдельно. */
const TICK_FIELDS = [
  'commandsPeak',
  'entitiesAlive',
  'entitiesFree',
  'eventsPeak',
  'navBytes',
  'navHeapCapacity',
  'tagEntries',
  'worldBytes',
] as const;

function tickFootprintCollector(): {
  readonly sink: DiagnosticsSink;
  readonly total: TickFootprint;
} {
  const total: TickFootprint = {
    commandsPeak: 0,
    entitiesAlive: 0,
    entitiesFree: 0,
    eventsPeak: 0,
    navBytes: 0,
    navHeapCapacity: 0,
    tagEntries: 0,
    ticks: 0,
    worldBytes: 0,
  };
  const sink: DiagnosticsSink = {
    trace: 'systems',
    record: (entry: DiagnosticRecord) => {
      if (entry.code !== 'TICK_FOOTPRINT') return;
      total.ticks++;
      for (const field of TICK_FIELDS) {
        const value = Number(entry.data?.[field] ?? 0);
        if (value > total[field]) total[field] = value;
      }
    },
  };
  return { sink, total };
}

// ------------------------------------------------------------- история (SNAP-4)

/**
 * Интервал и глубина кольца истории стенда — ФИКСТУРА, а не политика игры
 * (SNAP-4 оставляет обе величины провайдеру). Взяты так, чтобы кольцо
 * заполнялось на КАЖДОЙ записи набора (самая короткая — шестнадцать тиков) и
 * переполнялось хотя бы на одной: секция, лежащая нулями, стерегла бы пустоту,
 * а незаполненное кольцо не показало бы, что ёмкость вообще ограничивает.
 */
const HISTORY_INTERVAL = 4;
const HISTORY_CAPACITY = 8;

/** Занятость истории (SNAP-4): снапшотов в кольце и их байты — копий полного мира. */
interface HistoryFootprint extends StateFootprint {
  snapshots: number;
  bytes: number;
}

// ------------------------------------------------------- сборка документа

/** Ключи по алфавиту: порядок эталона не должен зависеть от порядка объявления. */
function sorted(values: StateFootprint): StateFootprint {
  const out: StateFootprint = {};
  for (const name of Object.keys(values).sort()) out[name] = values[name]!;
  return out;
}

/**
 * Владельцы, живущие дольше ПРОЦЕССА замера, а не стенда: заглушки модели и
 * вариантов скина (ASSET-4) строятся один раз на процесс и переиспользуются
 * всеми сценами. В эталон они не идут — и это не пропуск, а условие его
 * воспроизводимости: попали бы они в документ, тот зависел бы от того, какой
 * замер в процессе оказался первым, то есть от порядка тестов, а не от нагрузки
 * (PERF-8 требует побитовой воспроизводимости). Их занятость константна,
 * измеряется единицами ресурсов и стережётся сторожем кучи (PERF-10).
 */
const PROCESS_WIDE_OWNERS = new Set(['placeholders']);

/** Секция рендера: пики живых ресурсов по владельцу и виду плюс величины состояния. */
function renderSection(sink: RenderFootprint): unknown {
  const resources: Record<string, Record<string, number>> = {};
  for (const [owner, kinds] of Object.entries(footprintPeakLive(sink))) {
    if (PROCESS_WIDE_OWNERS.has(owner)) continue;
    resources[owner] = kinds;
  }
  return { resources, state: sorted({ ...sink.state }) };
}

interface MatchRun {
  readonly tick: TickFootprint;
  readonly history: HistoryFootprint;
  readonly render: RenderFootprint;
}

/**
 * Прогон записанного матча со снятыми величинами обеих сторон: тот же тик кормит
 * и запись ядра, и презентационный тракт — иначе стороны считались бы на разных
 * мирах.
 *
 * Стенд строится ВНУТРИ замера, в отличие от гейта стоимости: там сборка вынесена
 * из замера намеренно (её работа — не доставка), а здесь ресурсы, заведённые
 * сборкой подсистем, И ЕСТЬ занятая память — вынести их значило бы мерить память
 * сцены без самой сцены.
 */
function runMatch(name: string, preset: BenchPresetName): MatchRun {
  const def = loadRecording(name);
  const { sink, total } = tickFootprintCollector();
  const history = new RingHistory({
    interval: HISTORY_INTERVAL,
    capacity: HISTORY_CAPACITY,
  });
  const footprint = createFootprint();
  withFootprintSink(footprint, () => {
    const bench = matchBench(BENCH_PRESETS[preset]);
    playRecording(def, {
      diagnostics: sink,
      onTick: (result) => {
        bench.step(result);
        // История ведётся наблюдателем ПОСЛЕ тика (OBS-2), как её ведёт сервер
        // матча: снапшот — чтение, а не шаг симуляции.
        history.record(result.state);
      },
    });
  });
  return {
    tick: total,
    // Байты истории — полные копии мира (SNAP-1): снапшотов в кольце × ёмкость
    // хранилища. Ёмкость приезжает записью тика, число снапшотов — у провайдера;
    // второй формулы для этого числа в репозитории нет.
    history: { snapshots: history.count, bytes: history.count * total.worldBytes },
    render: footprint,
  };
}

/**
 * Документ эталона матча (design D5): секции `tick` и `history` ОДИН раз,
 * секции рендера — на пресет. Разложение такое, потому что таково положение дел:
 * симуляция пресета не знает (QUAL-2), а доставка и кадр знают.
 */
function measureMatch(name: string): unknown {
  const presets: Record<string, unknown> = {};
  let tick: StateFootprint | null = null;
  let history: StateFootprint | null = null;
  for (const preset of BENCH_PRESET_NAMES) {
    const run = runMatch(name, preset);
    const core = sorted(run.tick);
    // Инвариантность симуляции к пресету — проверка, а не декларация (QUAL-2):
    // величины мира двух прогонов обязаны совпасть до единицы, иначе пресет
    // как-то дотянулся до симуляции.
    if (tick === null) tick = core;
    else expect(core, `${name}/${preset}: секция tick`).toEqual(tick);
    const kept = sorted(run.history);
    if (history === null) history = kept;
    else expect(kept, `${name}/${preset}: секция history`).toEqual(history);
    presets[preset] = renderSection(run.render);
  }
  return { tick, history, ...presets };
}

// ------------------------------------------- оси масштабирования (PERF-6)

/**
 * Величины рендера одного размера синтетической оси. Стенд строится ВНУТРИ
 * замера, в отличие от гейта стоимости: ресурсы, заведённые сборкой подсистем,
 * и есть занятая память — вынести их из замера значило бы мерить память сцены
 * без самой сцены.
 */
function measureScalingSize(config: ScalingSize): unknown {
  const footprint = createFootprint();
  withFootprintSink(footprint, () => {
    benchFor(config).deliver(syntheticTick(config.load));
  });
  return renderSection(footprint);
}

function scalingDocument(): unknown {
  return {
    axes: SCALING_AXES.map((axis) => ({
      axis: axis.axis,
      small: axis.small.magnitude,
      large: axis.large.magnitude,
      footprint: {
        small: measureScalingSize(axis.small),
        large: measureScalingSize(axis.large),
      },
    })),
  };
}

/** Величины ядра одного размера оси, чья нагрузка описана документом прогона. */
function measureTickSize(size: AxisSize): StateFootprint {
  const { sink, total } = tickFootprintCollector();
  runScenario(size.def, sink);
  return sorted(total);
}

/** Величины ядра одного размера оси экстракции: та же запись, свой путь прогона. */
function measureExtractSize(size: AxisSize): StateFootprint {
  const { sink, total } = tickFootprintCollector();
  playExtraction(size.def, sink);
  return sorted(total);
}

/**
 * Документ оси (PERF-6) — той же формы, что у стоимости: величины обоих
 * размеров рядом с величинами обоих, «сначала S, потом L». Отношение L/S
 * читается диффом одинаково у любой оси, и второй формы документа в репозитории
 * не заводится.
 */
function axisDocument(
  axis: string,
  sizes: { readonly small: AxisSize; readonly large: AxisSize },
  measure: (size: AxisSize) => StateFootprint,
): unknown {
  return {
    axis,
    small: sizes.small.magnitude,
    large: sizes.large.magnitude,
    footprint: { small: { tick: measure(sizes.small) }, large: { tick: measure(sizes.large) } },
  };
}

/** Документ оси стадии тика, разобранный на части, — вход проверок роста. */
interface AxisDocument {
  readonly axis: string;
  readonly small: number;
  readonly large: number;
  readonly footprint: {
    readonly small: { readonly tick: TickFootprint };
    readonly large: { readonly tick: TickFootprint };
  };
}

function measureNpcStress(): unknown {
  return axisDocument('npcAgents', npcStressSizes(), measureTickSize);
}

function measureNavPath(): unknown {
  return axisDocument('navAgents', navPathSizes(), measureTickSize);
}

function measureExtract(): unknown {
  return axisDocument('extractEntities', extractSizes(), measureExtractSize);
}

/**
 * Величины памяти на оси платформы способностей (PERF-6, PERF-8): та же
 * нагрузка и та же ось, на которой снимается её стоимость, — второй копии
 * нагрузки рядом не заводится.
 */
function measureAbilityStress(): unknown {
  return axisDocument('abilityCasters', abilityStressSizes(), measureTickSize);
}

/**
 * Величины памяти на оси data-driven слоя (`data-driven-systems` SYS-1, PERF-6,
 * PERF-8): та же нагрузка, что у стоимости, и по той же причине — вторая копия
 * сцены рядом расходилась бы с первой молча.
 */
function measureDslScale(): unknown {
  return axisDocument('dslEntities', dslScaleSizes(), measureTickSize);
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
  // Структурная сверка первой: её дифф называет величину и обе стороны — «во
  // сколько раз выросло» видно без чтения строк файла (PERF-4).
  if (produced !== expected) {
    expect(JSON.parse(produced)).toEqual(JSON.parse(expected) as unknown);
  }
  expect(produced).toBe(expected);
}

describe('PERF-8: голден-гейт памяти на записанных матчах (CLI-10)', () => {
  for (const match of RECORDED_MATCHES) {
    it(`${match}: величины занятой памяти совпадают с эталоном`, () => {
      checkGolden(`${match}.footprint.json`, measureMatch(match));
    });
  }

  it('величины не мёртвые: и ядро, и история, и обе секции рендера непусты', () => {
    const document = measureMatch('match-fuzz') as Record<string, StateFootprint>;
    for (const section of ['tick', 'history']) {
      const moved = Object.values(document[section]!).filter((value) => value > 0);
      expect(moved.length, section).toBeGreaterThan(0);
    }
    for (const preset of BENCH_PRESET_NAMES) {
      const render = document[preset] as unknown as {
        resources: Record<string, Record<string, number>>;
        state: StateFootprint;
      };
      // Владельцы у стенда обязаны быть — иначе гейт стерёг бы пустую таблицу.
      expect(Object.keys(render.resources).length, `${preset}: владельцы`).toBeGreaterThan(0);
      const moved = Object.values(render.state).filter((value) => value > 0);
      expect(moved.length, `${preset}: величины состояния`).toBeGreaterThan(0);
    }
  });

  it('процессные заглушки в эталон не попадают — иначе он зависел бы от порядка тестов', () => {
    const document = measureMatch('match-walk') as Record<
      string,
      { resources: Record<string, unknown> }
    >;
    for (const preset of BENCH_PRESET_NAMES) {
      for (const owner of PROCESS_WIDE_OWNERS) {
        expect(Object.keys(document[preset]!.resources), preset).not.toContain(owner);
      }
    }
  });

  it('в эталоне нет ни одного поля с байтами кучи среды исполнения (PERF-8)', () => {
    // Формулировка требования прямая: байты кучи эталоном быть MUST NOT. Здесь
    // это проверяется по ИМЕНАМ величин: `worldBytes` и байты истории — длины
    // типизированных массивов, а `heapUsed`/`rss`/`external` — среда.
    const text = canonical(measureMatch('match-walk'));
    for (const forbidden of ['heapUsed', 'heapTotal', 'rss', 'arrayBuffers', 'external']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('QUAL-4: потолок производительного пресета виден и в памяти — маска грубее', () => {
    const document = measureMatch('match-walk') as Record<string, { state: StateFootprint }>;
    const performance = document.performance!.state.fogMaskBytes!;
    const ultra = document.ultra!.state.fogMaskBytes!;
    // Растр — площадь, и вдвое грубее маска занимает вчетверо меньше байт
    // (FOW-10, QUAL-1): та же зависимость, что у полномасочной работы.
    expect(ultra).toBe(4 * performance);
  });
});

describe('PERF-6: оси масштабирования — величины памяти на двух размерах', () => {
  it('scaling.footprint.json: величины обоих размеров совпадают с эталоном', () => {
    checkGolden('scaling.footprint.json', scalingDocument());
  });

  it(`${NPC_STRESS}.footprint.json: величины ядра совпадают с эталоном`, () => {
    checkGolden(`${NPC_STRESS}.footprint.json`, measureNpcStress());
  });

  it(`${NAV_PATH}.footprint.json: величины ядра совпадают с эталоном`, () => {
    checkGolden(`${NAV_PATH}.footprint.json`, measureNavPath());
  });

  it(`${ABILITY_STRESS}.footprint.json: величины ядра совпадают с эталоном`, () => {
    checkGolden(`${ABILITY_STRESS}.footprint.json`, measureAbilityStress());
  });

  it(`${DSL_SCALE}.footprint.json: величины ядра совпадают с эталоном`, () => {
    checkGolden(`${DSL_SCALE}.footprint.json`, measureDslScale());
  });

  it('extract.footprint.json: величины ядра совпадают с эталоном', () => {
    checkGolden('extract.footprint.json', measureExtract());
  });

  it('число сущностей: записи приёма доставки растут ровно отношением оси', () => {
    const axis = SCALING_AXES.find((item) => item.axis === 'entities')!;
    const small = measureScalingSize(axis.small) as { state: StateFootprint };
    const large = measureScalingSize(axis.large) as { state: StateFootprint };
    const ratio = axis.large.magnitude / axis.small.magnitude;
    // Ради ЭТОЙ строки ось и заведена (PERF-8, сценарий «Квадратичная память по
    // оси сущностей»): структура, держащая запись на ПАРУ сущностей, сломала бы
    // равенство при первом же прогоне.
    expect(large.state.viewRecords).toBe(ratio * small.state.viewRecords!);
    expect(large.state.modelsInstances).toBe(ratio * small.state.modelsInstances!);
    // А маска от числа сущностей не растёт: её размер — функция разрешения.
    expect(large.state.fogMaskBytes).toBe(small.state.fogMaskBytes);
  });

  it('оси симуляции: населённость мира растёт вместе с осью, ёмкость — нет', () => {
    const npc = measureNpcStress() as AxisDocument;
    expect(npc.footprint.large.tick.entitiesAlive).toBeGreaterThan(
      npc.footprint.small.tick.entitiesAlive,
    );
    // Ёмкость хранилища — константа мира: она задана сценой, а не населённостью
    // (PERF-8), и обе стороны оси обязаны показать одно число.
    expect(npc.footprint.large.tick.worldBytes).toBe(npc.footprint.small.tick.worldBytes);
  });

  it('ось поиска пути: рабочие структуры одни на сборку, а не на ищущего (NAV-5)', () => {
    const nav = measureNavPath() as AxisDocument;
    // Куча и массивы по клетке живут на СБОРКЕ навигации и переиспользуются
    // между запросами: агентов вчетверо больше, а рабочие структуры те же —
    // ровно это ось и обязана показать в диффе.
    expect(nav.footprint.small.tick.navHeapCapacity).toBeGreaterThan(0);
    expect(nav.footprint.large.tick.navHeapCapacity).toBe(
      nav.footprint.small.tick.navHeapCapacity,
    );
    // Байты — не только куча: пять массивов по клетке плюс запечённая сетка, и
    // они на порядки больше её (по одной ёмкости кучи рост памяти навигации на
    // большей арене не читался бы вовсе).
    expect(nav.footprint.small.tick.navBytes).toBeGreaterThan(
      nav.footprint.small.tick.navHeapCapacity * 4,
    );
    expect(nav.footprint.large.tick.navBytes).toBe(nav.footprint.small.tick.navBytes);
  });

  it('ось JSON-систем: населённость растёт осью, ёмкость мира — нет (SYS-1)', () => {
    const dsl = measureDslScale() as AxisDocument;
    // Сущности оси не спавнятся и не гибнут: расстановка прогона и есть его
    // населённость, и величина оси читается в эталоне памяти прямо числом.
    expect(dsl.footprint.small.tick.entitiesAlive).toBe(dsl.small);
    expect(dsl.footprint.large.tick.entitiesAlive).toBe(dsl.large);
    // Ёмкость хранилища задана сценой и у размеров ОДНА (PERF-8): подобранная
    // под размер, она двигалась бы вместе с осью и мерила бы вторую величину.
    expect(dsl.footprint.large.tick.worldBytes).toBe(dsl.footprint.small.tick.worldBytes);
    // Записи тегов, наоборот, принадлежат сущностям и растут ровно осью.
    const ratio = dsl.large / dsl.small;
    expect(dsl.footprint.large.tick.tagEntries).toBe(ratio * dsl.footprint.small.tick.tagEntries);
  });

  it('ось экстракции: живых сущностей ровно столько, сколько в нагрузке', () => {
    const extract = measureExtract() as AxisDocument;
    expect(extract.footprint.small.tick.entitiesAlive).toBe(extract.small);
    expect(extract.footprint.large.tick.entitiesAlive).toBe(extract.large);
  });
});

describe('PERF-8: величины машинно-независимы', () => {
  it('повторный прогон в одном процессе даёт побитово тот же документ', () => {
    for (const match of RECORDED_MATCHES) {
      const first = measureMatch(match);
      expect(canonical(measureMatch(match))).toBe(canonical(first));
    }
  });

  it('оси повторяются так же', () => {
    const scaling = canonical(scalingDocument());
    expect(canonical(scalingDocument())).toBe(scaling);
    const axes = canonical(measureNpcStress()) + canonical(measureNavPath()) + canonical(measureExtract());
    expect(canonical(measureNpcStress()) + canonical(measureNavPath()) + canonical(measureExtract())).toBe(
      axes,
    );
  });

  it('история равна снапшотам × ёмкость мира — второй формулы у неё нет', () => {
    const run = runMatch('match-fuzz', 'ultra');
    expect(run.history.snapshots).toBeGreaterThan(0);
    expect(run.history.bytes).toBe(run.history.snapshots * run.tick.worldBytes);
    // Кольцо ограничивает глубину (SNAP-3): снапшотов не больше его ёмкости,
    // сколько бы тиков ни шёл матч.
    expect(run.history.snapshots).toBeLessThanOrEqual(HISTORY_CAPACITY);
  });

  it('синтетическая арена осей и арена матчей — разные нагрузки, а не одна', () => {
    // Сторона синтетической арены объявлена осями, а не подобрана здесь: если
    // стенд осей однажды переедет на арену матчей, эталоны совпадут, и дифф
    // перестанет различать нагрузки.
    expect(benchGrid(SCALING_EXTENT, 4).width).toBe(SCALING_EXTENT);
  });
});
