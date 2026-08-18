/**
 * Бенч-нагрузка гейта стоимости (`performance-budget` PERF-4, PERF-6) — общая
 * часть двух прогонов: точного гейта счётчиков (`cost.test.ts`) и сторожа
 * реального времени (`bench.test.ts`).
 *
 * ## Что здесь за нагрузка
 *
 * Записанные матчи (`cli-testing` CLI-10, `engine/tests/golden/match-*`): готовая
 * воспроизводимая нагрузка, за парностью которой живому матчу следит
 * `matchGolden.test.ts`. Запись прогоняется тем же путём сборки, что и матч
 * (`buildSimulation`, NTR-5/CLI-2), тик за тиком — и каждый `TickResult` уходит
 * в презентационный тракт: Extractor → ViewBuffer → PresentationStage. Так одна
 * нагрузка даёт обе стороны разбивки PERF-2: объём работы тика приезжает
 * записями диагностики (DIAG-1, уровень `systems`), объём работы доставки и
 * кадра — стоком счётчиков рендера.
 *
 * Ни браузера, ни GPU здесь нет и быть не должно (PERF-4): рендерер — спай
 * структурного минимума `FogRendererLike`, канвас слоя миникарты — стаб, часы
 * презентации инжектированы. Всё, что считается, — собственный код движка.
 *
 * Чужих `test/` этот стенд не импортирует (CLI-9): вертикаль собирается из
 * публичных поверхностей пакетов, и спай с сеткой поэтому свои, а не взятые из
 * фикстур `render-ts`.
 *
 * `content/` бенч не читает (CONT-4): сцены приезжают записью матча, сетка
 * террейна строится здесь.
 *
 * ## Пресет качества — параметр стенда
 *
 * Тот же тракт собирается под документом пресета (`render-quality` QUAL-1):
 * стенд заводит `QualityController` над своей сценой, и подсистемы получают
 * значения ручек ровно тем же путём, что в игре. Отсюда две вещи разом —
 * пресетные эталоны стоимости (QUAL-4, design D5) и проверка инвариантности
 * симуляции к пресету (QUAL-2, design D6): нагрузка одна, документов два.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  buildSimulation,
  createTerrainGrid,
  tick,
  type DiagnosticsSink,
  type EntityId,
  type InputFrame,
  type ScenarioDef,
  type TerrainGrid,
  type TickResult,
} from '@game-mvp/core';
import { AssetService } from '@game-mvp/assets';
import {
  Extractor,
  FogSubsystem,
  PresentationStage,
  QualityController,
  ViewBuffer,
  type ExtractedTick,
  type FogLayerCanvas,
  type PresentationProducer,
  type QualityPreset,
  type RenderContext,
  type StatSource,
  type TickView,
} from '@game-mvp/render';
import { PositionsSubsystem, TICK_RATE } from './fixtures.js';

/** Эталоны стоимости лежат рядом с парами матчей — там же, где вся golden-культура. */
export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

/**
 * Записанные матчи бенча — ровно те записи, что стережёт `matchGolden.test.ts`
 * (CLI-10). Список здесь именами, а не сценариями: нагрузка гейта стоимости
 * обязана быть той же самой записью, а не похожим на неё свежим матчем.
 */
export const RECORDED_MATCHES = ['match-walk', 'match-fuzz', 'match-props'] as const;

export function loadRecording(name: string): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.scenario.json`), 'utf8')) as ScenarioDef;
}

/** Крючки прогона записи: сток диагностики ядра и наблюдатель тиков. */
export interface RecordingHooks {
  readonly diagnostics?: DiagnosticsSink;
  /** Зовётся после каждого тика — вход презентационного тракта (SHELL-2). */
  readonly onTick?: (result: TickResult) => void;
}

/** Подготовленный к прогону мир записи: сборка позади, тики впереди. */
export interface PreparedRecording {
  /** Тиков в записи — знаменатель сторожа «тиков в секунду» (PERF-5). */
  readonly ticks: number;
  /** Прогон записи: её тики с её же каноническими вводами (TICK-2). */
  run(): void;
}

/**
 * Мир записанного матча, поднятый общим путём сборки (`buildSimulation`,
 * NTR-5/CLI-2), и цикл его тиков — врозь: сторож реального времени (PERF-5)
 * мерит симуляцию, а не разбор сцены, и сборка обязана остаться вне замера.
 *
 * Своим циклом, а не `runScenario`, потому что бенчу нужен КАЖДЫЙ `TickResult`
 * (его читает Extractor), а прогон сценария отдаёт снапшоты — и платит за их
 * построение временем, которое сторожу мерить незачем.
 */
export function prepareRecording(def: ScenarioDef, hooks: RecordingHooks = {}): PreparedRecording {
  const { sim, state } = buildSimulation(
    {
      scene: def.scene,
      seed: def.seed,
      ...(def.players !== undefined ? { players: def.players } : {}),
      ...(def.initial !== undefined ? { initial: def.initial } : {}),
      ...(def.physics !== undefined ? { physics: def.physics } : {}),
      ...(def.locomotion !== undefined ? { locomotion: def.locomotion } : {}),
      ...(def.visibility !== undefined ? { visibility: def.visibility } : {}),
    },
    {
      where: `бенч-запись "${def.name}"`,
      ...(hooks.diagnostics !== undefined ? { diagnostics: hooks.diagnostics } : {}),
    },
  );

  const byTick = new Map<number, InputFrame[]>();
  for (const frame of def.inputs ?? []) {
    const list = byTick.get(frame.tick);
    if (list === undefined) byTick.set(frame.tick, [frame]);
    else list.push(frame);
  }

  return {
    ticks: def.ticks,
    run: () => {
      for (let i = 0; i < def.ticks; i++) {
        const result = tick(sim, state, byTick.get(state.tick + 1) ?? []);
        hooks.onTick?.(result);
      }
    },
  };
}

/** Сборка и прогон разом — вход гейта стоимости, которому время безразлично. */
export function playRecording(def: ScenarioDef, hooks: RecordingHooks = {}): void {
  prepareRecording(def, hooks).run();
}

// ------------------------------------------------------------- стенд рендера

/**
 * Рендерер глазами бенча — структурный минимум `FogRendererLike` (design D2):
 * считает проходы, ничего не рисуя. Вторая бухгалтерия к счётчику подсистемы:
 * тест сверяет её с `fogRenderPasses`.
 */
export class RendererSpy {
  renders = 0;
  targets = 0;
  render(): void {
    this.renders++;
  }
  setRenderTarget(): void {
    this.targets++;
  }
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(64, 48);
  }
}

/** Канвас слоя миникарты без DOM: блит исполняется, наружу не смотрит (design D6). */
function benchCanvas(width: number, height: number): FogLayerCanvas {
  return {
    width,
    height,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => {},
    }),
  };
}

/**
 * Арена `size`×`size` по клетке в мировую единицу с решёткой возвышенных клеток
 * шагом `step`: каждая даёт cliff-отрезки по периметру (TERR-5) — ось «число
 * сегментов укрытий» (PERF-6). Шаг 0 — ровная арена без укрытий.
 *
 * Укрытия бенчу нужны не для красоты: без них теневой путь маски (FOW-9,
 * полярный depth-буфер `mask.ts`) не исполняется вовсе, и эталон не стерёг бы
 * ровно ту регрессию, ради которой заведён. Клетки подняты на уровень 1, а
 * наблюдатели доставки идут нулевым (`level` синтетики и `currLevel` записи):
 * рёбра выше наблюдателя, значит тень они отбрасывают (`segmentCasts`, PHYS-13).
 * Наблюдатель на плато сделал бы рёбра прозрачными, и ось мерила бы пустоту.
 */
export function benchGrid(size: number, step: number): TerrainGrid {
  const levels = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => (step > 0 && x % step === 0 && y % step === 0 ? '1' : '0')).join(''),
  );
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: 65536,
    levels,
    flags: Array.from({ length: size }, () => '.'.repeat(size)),
  });
}

/** Имена статов доставки, по которым туман отбирает наблюдателей (HUD-8, FOW-7). */
export const FOG_STATS = { visionRadius: 'vision', team: 'team' } as const;

/**
 * Статы доставки бенча (HUD-8): команда — слот игрока, радиус обзора — радиус
 * коллайдера. Ни того, ни другого записанные матчи под своими именами не несут
 * (сцена дуэли — без тумана), а туману нужны наблюдатели: объявление статов и
 * есть тот механизм, которым сборка называет источники величин, не трогая
 * контент. Радиус мал (0.3 мировых единицы) — таков коллайдер героя, и работа
 * маски на матче поэтому определяется полномасочными счётчиками, а не кругами.
 */
const MATCH_STAT_SOURCES: readonly StatSource[] = [
  { name: FOG_STATS.team, component: 'Player', field: 'slot' },
  { name: FOG_STATS.visionRadius, component: 'Collider', field: 'radius' },
];

const PRODUCER: PresentationProducer = { name: 'bench' };

/** Кадров на доставку: один — каденс кадра от каденса тика бенч не отвязывает. */
const FRAMES_PER_TICK = 1;

// ------------------------------------------------------- пресеты качества бенча

/**
 * Документы пресетов бенча (`render-quality` QUAL-1, QUAL-4) — ФИКСТУРЫ, а не
 * политика игры. Уровни качества игры живут её JSON-документами (design D4:
 * `game/demo-ts/app/presets/`) и правятся дизайнером без ревью движка; здесь
 * закреплён МЕХАНИЗМ — что ручки объявлены, что потолок ограничивает авторское
 * значение и что бюджет каждого из двух режимов виден отдельной строкой эталона
 * (QUAL-4). Совпадать с числами демо они не обязаны и намеренно не совпадают:
 * эталон стоимости, зависящий от политики игры, краснел бы от каждой правки
 * баланса картинки.
 *
 * Имена ручек — собранного реестра (design D1). Стенд регистрирует туман и
 * подсистему позиций, поэтому в счётчиках отзывается только `fog.maskResolution`;
 * остальные ручки выписаны, чтобы документ пресета оставался документом ПОЛНОГО
 * набора осей, а не подмножеством, случайно совпавшим с составом стенда.
 */
const PERFORMANCE_PRESET: QualityPreset = Object.freeze({
  // Потолок ниже сценного разрешения стенда (`MATCH_STAND.resolution`): min()
  // срабатывает, и грубая маска — то, чем производительный режим и отличается.
  'fog.maskResolution': 4,
  'models.defaultTier': 'batched',
  // Больше единицы — пороги LOD читаются раньше, инстанс уходит на грубый
  // уровень ближе к камере (REND-22).
  'models.lodThresholdScale': 2,
  'particles.density': 0.5,
  'terrain.curvatureTessellation': 2,
});

/**
 * Ультра: потолков нет вовсе. Их отсутствие и есть «действует авторское
 * значение» (design D3) — умолчание ceiling-ручки бесконечно, а бесконечности в
 * JSON не написать. Прямые значения выписаны своими документированными
 * умолчаниями (QUAL-1), чтобы пара документов читалась диффом.
 */
const ULTRA_PRESET: QualityPreset = Object.freeze({
  'models.defaultTier': 'batched',
  'models.lodThresholdScale': 1,
  'particles.density': 1,
});

export const BENCH_PRESETS = Object.freeze({
  performance: PERFORMANCE_PRESET,
  ultra: ULTRA_PRESET,
});

/** Имя пресета — ключ секции эталона стоимости (QUAL-4, design D5). */
export type BenchPresetName = keyof typeof BENCH_PRESETS;

/** Порядок секций эталона: сперва бюджет слабых устройств, следом авторский. */
export const BENCH_PRESET_NAMES: readonly BenchPresetName[] = ['performance', 'ultra'];

export interface PresentationBenchOptions {
  readonly grid: TerrainGrid;
  /**
   * АВТОРСКОЕ разрешение маски, текселей на мировую единицу (FOW-10) — секция
   * `fog` сцены глазами стенда и ось PERF-6. Действующее — под потолком пресета
   * (design D3), и его читает `fog.config.resolution`.
   */
  readonly resolution: number;
  /** Источники статов доставки; пусто — синтетическая нагрузка кладёт статы сама. */
  readonly stats?: readonly StatSource[];
  /** Документ пресета качества (QUAL-1); нет — ультра, то есть без потолков. */
  readonly preset?: QualityPreset;
}

/**
 * Презентационный тракт бенча: Extractor (воркер-сторона) → ViewBuffer
 * (main-сторона, часы инжектированы) → PresentationStage с подсистемой тумана и
 * подсистемой позиций. Ровно тот шов, на котором сняты счётчики стадий
 * `syncTick` и `frame` (PERF-2).
 */
export class PresentationBench {
  readonly stage: PresentationStage;
  readonly buffer: ViewBuffer;
  readonly fog: FogSubsystem;
  readonly renderer = new RendererSpy();
  /** Контроллер качества сцены стенда (QUAL-1): реестр ручек и их значения. */
  readonly quality: QualityController;

  private readonly extractor: Extractor;
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly clock: { ms: number };
  /**
   * Герой игрока — источник команды, чьи наблюдатели открывают маску (FOW-7).
   * Берётся первой доставкой: ID приезжает из мира, а не из конфигурации.
   */
  private hero: EntityId | null = null;

  constructor(options: PresentationBenchOptions) {
    const clock = { ms: 0 };
    this.clock = clock;
    this.extractor = new Extractor({
      kindOf: () => 'hero',
      ...(options.stats !== undefined ? { stats: options.stats } : {}),
    });
    this.buffer = new ViewBuffer({ tickSeconds: 1 / TICK_RATE, clock: () => clock.ms });
    // Ассеты бенчу не нужны: ни туман, ни подсистема позиций их не читают —
    // источник падает при первом же обращении, чтобы это оставалось правдой.
    const context: RenderContext = {
      scene: new THREE.Scene(),
      assets: new AssetService({
        read: () => Promise.reject(new Error('бенч стоимости не читает ассетов')),
      }),
      config: { heightStep: 1 },
    };
    this.fog = new FogSubsystem({
      grid: options.grid,
      stats: FOG_STATS,
      hero: () => this.hero,
      config: { resolution: options.resolution },
      createCanvas: benchCanvas,
    });
    this.stage = new PresentationStage(context);
    // Контроллер заводится ДО регистрации: значения ручек уезжают подсистеме
    // тем же путём, что в игре, — регистрацией (QUAL-1, design D2), а не
    // отдельным вызовом «примени пресет» после сборки сцены.
    this.quality = new QualityController(this.stage, options.preset ?? BENCH_PRESETS.ultra);
    this.stage.register(this.fog).register(new PositionsSubsystem());
  }

  /** Действующее разрешение маски — сценное под потолком пресета (FOW-10, design D3). */
  get maskResolution(): number {
    return this.fog.config.resolution;
  }

  /** Тик мира — доставка и кадры презентации. Часы идут ровно по каденсу тика. */
  step(result: TickResult): void {
    this.deliver(this.extractor.extract(result));
  }

  /** Та же доставка от синтетической плоской формы — ось масштабирования (PERF-6). */
  deliver(ext: ExtractedTick): void {
    this.clock.ms += 1000 / TICK_RATE;
    this.buffer.apply(ext);
    this.hero ??= observerOf(this.buffer.view);
    this.stage.publish(PRODUCER, this.buffer.view);
    for (let i = 0; i < FRAMES_PER_TICK; i++) this.frame();
  }

  private frame(): void {
    // Полтика между доставкой и кадром: альфа интерполяции 0.5 — кадр посреди
    // тика, а не вырожденный на его границе.
    this.clock.ms += 500 / TICK_RATE;
    const timing = this.buffer.frame(this.clock.ms);
    if (timing !== null) this.stage.frame(timing.dt, timing.alpha, timing.realDt);
    this.fog.render(this.renderer, this.camera);
  }
}

/** Первая сущность доставки со статом команды — герой стенда (FOW-7). */
function observerOf(view: TickView): EntityId | null {
  for (const [id, entity] of view.entities) {
    if (entity.stats?.get(FOG_STATS.team) !== undefined) return id;
  }
  return null;
}

/**
 * Стенд записанного матча: арена 8×8 клеток, укрытия решёткой шагом 2 и
 * АВТОРСКОЕ разрешение маски 8 текселей на мировую единицу. Разрешение выбрано
 * ВЫШЕ потолка производительного пресета намеренно (design D3): иначе min() не
 * срабатывал бы, оба эталона стоимости совпадали бы до счётчика, и гейт QUAL-4
 * стерёг бы один бюджет под двумя именами.
 */
export const MATCH_STAND = { extent: 8, pillarStep: 2, resolution: 8 } as const;

/** Презентационный стенд матча под одним документом пресета (QUAL-4). */
export function matchBench(preset: QualityPreset): PresentationBench {
  return new PresentationBench({
    grid: benchGrid(MATCH_STAND.extent, MATCH_STAND.pillarStep),
    resolution: MATCH_STAND.resolution,
    stats: MATCH_STAT_SOURCES,
    preset,
  });
}

// ------------------------------------------------- синтетическая нагрузка осей

export interface SyntheticLoad {
  /** Сущностей в доставке — ось «число сущностей» (PERF-6). */
  readonly entities: number;
  /** Сколько из них несут статы наблюдателя своей команды — ось «наблюдатели». */
  readonly observers: number;
  /** Радиус обзора наблюдателя, мировые единицы. */
  readonly vision: number;
  /** Сторона арены в клетках — по ней раскладываются сущности. */
  readonly extent: number;
}

/**
 * Плоская форма доставки нужного размера (SHELL-2) — синтетика осей
 * масштабирования. Сущности раскладываются решёткой по арене, первые
 * `observers` из них несут статы «команда 0 + радиус обзора»: остальные — вес
 * доставки без вклада в маску, ровно как видимые враги настоящего матча.
 */
export function syntheticTick(load: SyntheticLoad): ExtractedTick {
  const count = load.entities;
  const ext: ExtractedTick = {
    tick: 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: true,
    count,
    id: new Float64Array(count),
    kind: new Int32Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    level: new Uint8Array(count),
    flags: new Uint8Array(count),
    facingYaw: new Float32Array(count),
    aimYaw: new Float32Array(count),
    motion: new Uint8Array(count),
    motionPhase: new Float32Array(count),
    flightPhase: new Float32Array(count),
    statNames: [FOG_STATS.team, FOG_STATS.visionRadius],
    statCount: new Uint8Array(count),
    statIndex: new Int32Array(count * 2),
    statValue: new Float64Array(count * 2),
    statPairs: 0,
    events: [],
    floorDelta: [],
    kindTable: ['hero'],
  };
  for (let i = 0; i < count; i++) {
    ext.id[i] = i + 1;
    ext.kind[i] = 0;
    ext.x[i] = (i % load.extent) + 0.5;
    ext.y[i] = (Math.floor(i / load.extent) % load.extent) + 0.5;
    ext.facingYaw[i] = Number.NaN;
    ext.aimYaw[i] = Number.NaN;
    ext.motionPhase[i] = Number.NaN;
    ext.flightPhase[i] = Number.NaN;
    if (i >= load.observers) {
      ext.statCount[i] = 0;
      continue;
    }
    ext.statCount[i] = 2;
    ext.statIndex[ext.statPairs] = 0;
    ext.statValue[ext.statPairs] = 0;
    ext.statPairs++;
    ext.statIndex[ext.statPairs] = 1;
    ext.statValue[ext.statPairs] = load.vision;
    ext.statPairs++;
  }
  return ext;
}
