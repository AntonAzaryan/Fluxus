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
  ViewBuffer,
  type ExtractedTick,
  type FogLayerCanvas,
  type PresentationProducer,
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
 * `litSubsamples`) не исполняется вовсе, и эталон не стерёг бы ровно ту
 * регрессию, ради которой заведён.
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
export const MATCH_STAT_SOURCES: readonly StatSource[] = [
  { name: FOG_STATS.team, component: 'Player', field: 'slot' },
  { name: FOG_STATS.visionRadius, component: 'Collider', field: 'radius' },
];

const PRODUCER: PresentationProducer = { name: 'bench' };

/** Кадров на доставку: один — каденс кадра от каденса тика бенч не отвязывает. */
const FRAMES_PER_TICK = 1;

export interface PresentationBenchOptions {
  readonly grid: TerrainGrid;
  /** Разрешение маски, текселей на мировую единицу (FOW-10) — ось PERF-6. */
  readonly resolution: number;
  /** Источники статов доставки; пусто — синтетическая нагрузка кладёт статы сама. */
  readonly stats?: readonly StatSource[];
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
    this.stage.register(this.fog).register(new PositionsSubsystem());
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
