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
 * террейна строится здесь, а манифест визуалов, модель, документ эффекта и
 * карта кривизны — синтетические фикстуры (`benchContent.ts`, change
 * `bench-stand-subsystems`, решение D2).
 *
 * ## Состав стенда
 *
 * Подсистем на сцене шесть: освещение (REND-8, REND-29..30), туман (FOW-7..10),
 * подсистема позиций (минимальный потребитель доставки), террейн (REND-7,
 * REND-9), модели (REND-3, REND-20, REND-22) и частицы (REND-24). Туман и
 * позиции стерегли стоимость с самого появления гейта; террейн, модели и
 * частицы добавлены потому, что без них шестнадцатикратное удорожание выбора
 * LOD, шага эмиттеров или пересборки чанков проходило бы гейт зелёным (PERF-4),
 * а ручки `models.*`/`particles.*`/`terrain.*` не двигали бы ни одного
 * эталонного числа (QUAL-4). Освещение — по той же причине: его счётчики
 * (`lighting*`) без подсистемы на стенде лежали нулями во всех эталонах, и ни
 * удорожание теневого прохода, ни потолок `lighting.shadowMode` гейту видны не
 * были. Регистрируется оно первым — тем же порядком, что в сборках (REND-8):
 * террейн и модели ниже отдают ему свои корни теневыми кастерами.
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
  FIXED_ONE,
  buildSimulation,
  createTerrainGrid,
  fixed,
  tick,
  world as coreWorld,
  type Action,
  type DiagnosticsSink,
  type EntityId,
  type InputFrame,
  type SceneDef,
  type ScenarioDef,
  type ScenarioSpawn,
  type SystemDef,
  type TerrainGrid,
  type TickResult,
} from '@fluxus/core';
import type {
  PresentationLighting,
  PresentationPostprocess,
  PresentationWater,
} from '@fluxus/assets';
import type { MatchConfig, MatchTrace, PresentedState } from '@fluxus/net';
import {
  Extractor,
  FogSubsystem,
  LightingSubsystem,
  PostprocessSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  PresentationStage,
  QualityController,
  RenderDebugLayer,
  TerrainSubsystem,
  ViewBuffer,
  VisualSurfaceSource,
  WaterSubsystem,
  costCountersDebugSource,
  deliveryDebugSource,
  type ExtractedTick,
  type FogLayerCanvas,
  type PresentationProducer,
  type QualityPreset,
  type RenderContext,
  type RenderEvent,
  type StatSource,
  type TickView,
} from '@fluxus/render';
import {
  BENCH_BURST_EVENT,
  BENCH_KINDS,
  benchAssets,
  benchCurvature,
  benchManifest,
} from './benchContent.js';
import {
  PositionsSubsystem,
  TICK_RATE,
  connectClient,
  duelConfig,
  duelScene,
  fogScene,
  fuzzInput,
  harness,
  playMatch,
  propScene,
  settle,
  walkRight,
  type ConnectedClient,
  type Harness,
  type MatchStepObserver,
  type PlayedMatch,
} from './fixtures.js';

/** Эталоны стоимости лежат рядом с парами матчей — там же, где вся golden-культура. */
export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

/** Файл канонического лога записи (CLI-2, CLI-10): пара golden-набора зовётся именем записи. */
export function recordingFile(name: string): string {
  return `${name}.scenario.json`;
}

/**
 * ОПРЕДЕЛЕНИЕ записанного матча (CLI-10): имя пары golden-набора и живой прогон,
 * которым эта пара снимается, — генератор ввода, число тиков и конфиг вместе.
 *
 * Определение лежит здесь, а не в тесте записи, потому что стендов у записи
 * ДВА: `matchGolden.test.ts` снимает ею канонический лог, а гейт стоимости
 * провода (`performance-budget` PERF-12) прогоняет ту же запись ради байтов
 * персональных снапшотов. Разойдись они генератором ввода или числом тиков —
 * эталон провода мерил бы матч, которого в golden-наборе нет, и обе стороны
 * при этом остались бы зелёными.
 */
export interface MatchRecording {
  /** Имя записи — оно же имя пары файлов golden-набора. */
  readonly name: string;
  /** Живой прогон записи на loopback-стенде; наблюдатель итераций — по надобности. */
  readonly play: (onStep?: MatchStepObserver) => Promise<PlayedMatch>;
}

/** Длина и seed фазз-записи: ввод предвычисляется с запасом на подстановку кадров. */
const FUZZ_TICKS = 60;
const FUZZ_SEED = 977;

export const MATCH_RECORDINGS: readonly MatchRecording[] = [
  {
    // Движение одного игрока при молчащем втором: виден и ввод, и подстановка
    // predicted-кадров молчащего слота (TICK-2) в каноническом логе.
    name: 'match-walk',
    play: (onStep) => playMatch(24, { a: walkRight(16) }, duelConfig({ name: 'match-walk' }), onStep),
  },
  {
    // Seeded-фазз обоих слотов: пространство сценариев шире рукописного.
    name: 'match-fuzz',
    play: (onStep) =>
      playMatch(
        FUZZ_TICKS,
        {
          a: fuzzInput(FUZZ_SEED, 'record-p1', FUZZ_TICKS + 64),
          b: fuzzInput(FUZZ_SEED, 'record-p2', FUZZ_TICKS + 64),
        },
        duelConfig({ name: 'match-fuzz', seed: FUZZ_SEED }),
        onStep,
      ),
  },
  {
    // Сцена с непустой расстановкой (SER-7, SER-8): реквизит сцены занимает
    // первые ID, герои матча идут за ним. Забытая в прологе `buildMatchWorld`
    // расстановка сцены краснеет здесь и в паре ядра к этому сценарию (NTR-8).
    name: 'match-props',
    play: (onStep) =>
      playMatch(16, { a: walkRight(12) }, duelConfig({ name: 'match-props', scene: propScene() }), onStep),
  },
];

/**
 * Записанные матчи бенча — ровно те записи, что стережёт `matchGolden.test.ts`
 * (CLI-10). Список ВЫВОДИТСЯ из определений выше, а не выписывается рядом:
 * нагрузка гейта стоимости обязана быть той же самой записью, а не похожим на
 * неё свежим матчем.
 */
export const RECORDED_MATCHES: readonly string[] = MATCH_RECORDINGS.map((recording) => recording.name);

/** Определение записи по имени; неизвестное имя — отказ, а не молчаливый пропуск. */
function recordingOf(name: string): MatchRecording {
  const recording = MATCH_RECORDINGS.find((entry) => entry.name === name);
  if (recording === undefined) throw new Error(`запись матча "${name}" не объявлена в MATCH_RECORDINGS`);
  return recording;
}

export function loadRecording(name: string): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, recordingFile(name)), 'utf8')) as ScenarioDef;
}

/**
 * Синтетическая стресс-нагрузка массы NPC (`npc-behavior` NPC-9): двести
 * массовых крипов на арене, режиссёр волн, маршрут и двое героев в центре.
 * Записью матча она не является — участников у неё нет вовсе, — поэтому и лежит
 * не парой `*.scenario.json`/`*.golden.json`, а отдельным документом нагрузки.
 *
 * Расширение `.load.json`, а не `.scenario.json`, выбрано намеренно: пары
 * golden-набора авто-обнаруживаются по второму имени (CLI-5), и побитовый
 * эталон на двести сущностей за два десятка тиков весил бы мегабайты — то есть
 * стоил бы репозиторию больше, чем стережёт. Побитовую воспроизводимость этой
 * нагрузки закрывает прогон-сравнение в ядре (`test/npcStress.test.ts`), а её
 * СТОИМОСТЬ — эталон `npc-stress.cost.json` в этом гейте (PERF-3, PERF-4).
 */
export const NPC_STRESS = 'npc-stress';

export function loadNpcStress(): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${NPC_STRESS}.load.json`), 'utf8')) as ScenarioDef;
}

/**
 * Навигационная нагрузка (`pathfinding` NAV-5, NAV-7): сцена с террейном, где
 * маршрут NPC идёт через узкий проход, вдоль обрыва и по рампе, а навигация
 * собрана вместе с физикой. Записью матча она не является — участников у неё
 * нет, — но, в отличие от стресса NPC, у неё есть побитовый эталон: сценарий
 * лежит обычной парой golden-набора (`nav-path.scenario.json`, CLI-5), потому
 * что сущностей в ней единицы. Здесь эта же пара служит нагрузкой ГЕЙТА
 * СТОИМОСТИ: удорожание поиска пути обязано краснеть диффом (PERF-4).
 */
export const NAV_PATH = 'nav-path';

export function loadNavPath(): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${NAV_PATH}.scenario.json`), 'utf8')) as ScenarioDef;
}

// ------------------------------------- размеры осей стороны симуляции (PERF-6)

/**
 * Один размер оси стоимости, нагрузка которой описывается документом прогона
 * (PERF-6): величина оси и документ этой величины. Размеры получаются ИЗ ТОЙ ЖЕ
 * нагрузки — прореживанием, размножением агентов либо порождением по числу, — а
 * не вторым документом рядом: два рукописных документа разошлись бы молча, а
 * размеры одной оси обязаны отличаться ровно её величиной.
 */
export interface AxisSize {
  /** Величина оси — то единственное, чем размеры и различаются. */
  readonly magnitude: number;
  readonly def: ScenarioDef;
}

/** Prefab массового агента нагрузки NPC — им и меряется величина её оси. */
const NPC_STRESS_AGENT = 'Creep';

/**
 * Два размера оси «число агентов платформы поведения» (NPC-9, PERF-6).
 *
 * Малый размер — КАЖДЫЙ ВТОРОЙ агент документа, а не его первая половина:
 * агенты разложены по арене порядком записей, и отрезание хвоста двигало бы
 * заодно и плотность толпы — то есть ось двигала бы две величины сразу, и
 * отношение L/S нечему было бы приписать (выборка соседей растёт именно
 * плотностью). Прочие сущности — герои, точки маршрута, режиссёр волн —
 * остаются на местах у обоих размеров: они не агенты оси.
 */
export function npcStressSizes(): { readonly small: AxisSize; readonly large: AxisSize } {
  const full = loadNpcStress();
  const initial = full.scene.initial ?? [];
  let agent = 0;
  const thinned = initial.filter((spawn) => {
    if (spawn.prefab !== NPC_STRESS_AGENT) return true;
    return agent++ % 2 === 0;
  });
  const agents = initial.filter((spawn) => spawn.prefab === NPC_STRESS_AGENT).length;
  const small: ScenarioDef = { ...full, scene: { ...full.scene, initial: thinned } };
  return {
    small: { magnitude: agents - Math.floor(agents / 2), def: small },
    large: { magnitude: agents, def: full },
  };
}

/**
 * Агенты маршрута, добавляемые большому размеру навигационной оси: свободные
 * клетки нижнего уровня арены (`nav-path.scenario.json` — колонки 0..3 несут
 * уровень 0, рампа лежит третьим рядом). Координаты в Q16.16, как их пишет
 * сам документ нагрузки.
 */
const NAV_EXTRA_AGENTS: readonly { readonly x: number; readonly y: number }[] = Object.freeze([
  { x: 32768, y: 32768 },
  { x: 163840, y: 32768 },
  { x: 32768, y: 98304 },
]);

/**
 * Два размера оси «число агентов поиска пути» (NAV-5, PERF-6).
 *
 * Большой размер получается РАЗМНОЖЕНИЕМ агента маршрута: своя запись у каждого
 * с собственной клеткой старта, поведение и маршрут — те же. Прореживать здесь
 * нечего (агент маршрута в документе один), а растить прогон приходится тем,
 * что и растёт в контенте: числом ищущих путь.
 */
export function navPathSizes(): { readonly small: AxisSize; readonly large: AxisSize } {
  const base = loadNavPath();
  const initial = base.scene.initial ?? [];
  // Агент маршрута — запись с маршрутной привязкой (`NpcRoute`); её и копируем
  // целиком, чтобы у клонов совпало всё, кроме клетки старта.
  const walker = initial.find((spawn) => spawn.overrides?.NpcRoute !== undefined);
  if (walker === undefined) {
    throw new Error(`${NAV_PATH}: в нагрузке нет агента маршрута — размеры оси построить не из чего`);
  }
  const clones = NAV_EXTRA_AGENTS.map((at) => ({
    ...walker,
    overrides: { ...walker.overrides, Position: { x: at.x, y: at.y } },
  }));
  const large: ScenarioDef = {
    ...base,
    scene: { ...base.scene, initial: [...initial, ...clones] },
  };
  return {
    small: { magnitude: 1, def: base },
    large: { magnitude: 1 + clones.length, def: large },
  };
}

// ------------------------------------------- ось стадии экстракции (PERF-6)

/**
 * Тиков в синтетической нагрузке экстракции. Число фиксировано у ОБОИХ
 * размеров: величина оси — сущности, и длина прогона двигаться вместе с ней не
 * должна, иначе отношение L/S мерило бы две величины сразу.
 */
const EXTRACT_TICKS = 8;

/** Сущностей в ряду раскладки: сетка, а не линия, — позиции разложены по арене. */
const EXTRACT_ROW = 16;

/**
 * Синтетическая нагрузка стадии `extract` на N сущностей (PERF-6): документ
 * прогона, поднимаемый ОБЩИМ путём сборки (`prepareRecording`), как и записанные
 * матчи. Систем у сцены нет вовсе: экстракция читает состояние мира, и её
 * стоимость определяется составом сущностей, а не тем, что с ними делает тик, —
 * а лишняя работа систем только зашумила бы прогон.
 *
 * Сущности несут поля обоих статов доставки (`MATCH_STAT_SOURCES`), поэтому ось
 * двигает и пары статов: стат — колонка плоской формы, и рост её объёма обязан
 * читаться той же осью, что и рост числа сущностей.
 */
function extractLoad(entities: number): ScenarioDef {
  const initial: ScenarioSpawn[] = [];
  for (let i = 0; i < entities; i++) {
    initial.push({
      prefab: 'Runner',
      overrides: {
        Position: { x: (i % EXTRACT_ROW) * FIXED_ONE, y: Math.floor(i / EXTRACT_ROW) * FIXED_ONE },
        Player: { slot: i % 2 },
        Collider: { radius: FIXED_ONE / 4 },
      },
    });
  }
  return {
    name: `extract-${entities}`,
    seed: 20260901,
    ticks: EXTRACT_TICKS,
    scene: {
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: 'Player', fields: { slot: 'i32' } },
        { name: 'Collider', fields: { radius: 'fixed' } },
      ],
      prefabs: [
        {
          name: 'Runner',
          tags: ['Runner'],
          components: { Position: { x: 0, y: 0 }, Player: { slot: 0 }, Collider: { radius: 0 } },
        },
      ],
      initial,
    },
  };
}

/**
 * Два размера оси «число сущностей доставки» (PERF-6) для стадии `extract`.
 * Восьмикратный разрыв — тот же порядок, что у оси сущностей рендера: линейную
 * экстракцию он показывает ровным отношением, а любую суперлинейность (поиск по
 * сущности в чужом списке) — непропорциональным.
 */
export function extractSizes(): { readonly small: AxisSize; readonly large: AxisSize } {
  return {
    small: { magnitude: 32, def: extractLoad(32) },
    large: { magnitude: 256, def: extractLoad(256) },
  };
}

/**
 * Прогон нагрузки экстракции: тики строит общий путь сборки, каждый читает
 * `Extractor` — ровно тот шов, на котором сняты счётчики стадии `extract`
 * (PERF-2). Презентационного тракта здесь нет: ось меряет экстракцию, и
 * доставка с кадром только смешали бы в документ чужие стадии.
 *
 * Каждый кадр объявляется ДОСТАВЛЕННЫМ (`markDelivered`, SHELL-3): без этого
 * зеркало последнего доставленного кадра осталось бы пустым, и ось мерила бы
 * канал, которого не бывает, — тот, где ни один кадр не уехал. С ним ось
 * показывает обе величины отбора сразу: сравнение строк растёт числом
 * сущностей (`extractRowsCompared`), а объём канала на стоящей сцене — нет.
 */
export function playExtraction(def: ScenarioDef, diagnostics?: DiagnosticsSink): void {
  const kindOf = benchKinds();
  const extractor = new Extractor({
    kindOf: (_state, entity) => kindOf(entity),
    stats: MATCH_STAT_SOURCES,
  });
  playRecording(def, {
    // Сток диагностики — необязателен: гейту стоимости он не нужен вовсе
    // (стадию `extract` считает сток рендера), а гейту памяти нужен — величины
    // мира приезжают записью тика (PERF-8).
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    onTick: (result) => {
      extractor.extract(result);
      extractor.markDelivered();
    },
  });
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
  /**
   * Прогон РОВНО `count` тиков того же мира — вход окна без сборки мусора
   * (PERF-11): ширина окна меряется тиками, и укорачивать её кратно длине
   * записи сторож не вправе.
   */
  runTicks(count: number): void;
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

  const runTicks = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const result = tick(sim, state, byTick.get(state.tick + 1) ?? []);
      hooks.onTick?.(result);
    }
  };

  return {
    ticks: def.ticks,
    run: () => {
      runTicks(def.ticks);
    },
    runTicks,
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
class RendererSpy {
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

/** Форма арены стенда сверх её размера в клетках — по умолчанию прежняя. */
export interface BenchArenaShape {
  /** Сторона клетки в мировых единицах (по умолчанию 1). */
  readonly tile?: number;
  /** Сдвиг решётки укрытий от нулевой клетки, в клетках (по умолчанию 0). */
  readonly offset?: number;
  /**
   * Пометить рампами РЯДЫ, соседние со столбами (по умолчанию нет). Переход
   * «пол → столб» через такой ряд становится проходимым, cliff-отрезка на нём
   * не возникает вовсе (TERR-5) — это ПРОЁМ, в котором верхний пол держит под
   * туманом один лишь срез reveal по уровню (FOW-9), а не тень. Флаг стоит на
   * НИЖНЕЙ клетке пары, как того требует TERR-5, и ряд идёт целиком: одиночная
   * рампа запрещена (TERR-7), а сосед по ряду — рампа того же уровня.
   *
   * Проём открыт по вертикали, а боковые рёбра столбов остаются обрывами: на
   * стенде обязаны исполняться ОБА пути маски — и тени, и срез. Ряды выбраны, а
   * не колонки, потому что герои записей ходят вдоль оси x (`MATCH_STAND`), и
   * проём попадает в их круг обзора, а не остаётся за его краем.
   */
  readonly ramps?: boolean;
}

/**
 * Арена `size`×`size` клеток со стороной `tile` в мировых единицах и решёткой
 * возвышенных клеток шагом `step`, сдвинутой на `offset`: каждая даёт
 * cliff-отрезки по периметру (TERR-5) — ось «число сегментов укрытий» (PERF-6).
 * Шаг 0 — ровная арена без укрытий.
 *
 * Укрытия бенчу нужны не для красоты: без них теневой путь маски (FOW-9,
 * полярный depth-буфер `mask.ts`) не исполняется вовсе, и эталон не стерёг бы
 * ровно ту регрессию, ради которой заведён. Клетки подняты на уровень 1, а
 * наблюдатели доставки идут НУЛЕВЫМ уровнем (`level` синтетики и `currLevel`
 * записи): рёбра выше наблюдателя, значит тень они отбрасывают (`segmentCasts`,
 * PHYS-13). Наблюдатель на плато сделал бы рёбра прозрачными, и ось мерила бы
 * пустоту — поэтому под наблюдателем обязан быть пол, а не столб.
 *
 * Отсюда `tile` и `offset` у матчевого стенда (`MATCH_STAND`): записанные матчи
 * держат героев в паре юнитов от начала координат с радиусом обзора в 0.3
 * юнита, и на решётке из клеток по юниту с началом в клетке (0, 0) герой стоял
 * бы ВНУТРИ столба — уровень пола под ним был бы выше его собственного, и срез
 * reveal по уровню (FOW-9) выбросил бы каждый тексель его круга. Клетка мельче
 * радиуса плюс сдвиг решётки дают обратное: под героем пол, а рёбра и верхушки
 * столбов — внутри круга, то есть и тень, и срез исполняются на каждом матче.
 * Синтетика осей своих наблюдателей раскладывает сама и обеих ручек не просит.
 */
export function benchGrid(size: number, step: number, shape: BenchArenaShape = {}): TerrainGrid {
  const tile = shape.tile ?? 1;
  const offset = shape.offset ?? 0;
  const raised = (value: number): boolean => step > 0 && value % step === offset % step;
  // Ряд рампы — соседний со столбовым; при шаге 2 это все остальные ряды, и
  // столб открыт с севера и с юга, а рёбра запада и востока остаются обрывами.
  const rampRow = (y: number): boolean => (shape.ramps ?? false) && step > 0 && !raised(y);
  const levels = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => (raised(x) && raised(y) ? '1' : '0')).join(''),
  );
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: fixed.fromFloat(tile),
    levels,
    flags: Array.from({ length: size }, (_unused, y) =>
      (rampRow(y) ? '^' : '.').repeat(size),
    ),
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

/**
 * Секция `lighting` стенда (PRES-2) — авторский режим теней `full`. Выше
 * потолка производительного пресета намеренно, как разрешение маски
 * (design D3): min() по рангу режима срабатывает, и две секции эталона несут
 * РАЗНЫЕ теневые бюджеты — покадровый обоих ярусов против кэша статики (QUAL-4,
 * REND-30). Сторона карты авторская и тоже выше потолка производительного
 * пресета; счётчиков она не двигает — работу min() по ней стерегут юнит-тесты
 * `render-ts`, а не эталон.
 */
const BENCH_LIGHTING: PresentationLighting = Object.freeze({
  shadows: { mode: 'full', mapSize: 1024 },
} as const);

/**
 * Секция `postprocess` стенда (PRES-2, REND-34) — АКТИВНАЯ цепочка: оператор
 * сведения и включённый bloom. Выключенной ей быть нельзя по тому же
 * основанию, по какому у стенда есть свет: без активной цепочки счётчики
 * `postprocess*` лежали бы нулями во всех эталонах, и семь полноэкранных
 * проходов кадра гейт бы не стерёг (PERF-4) — а это самая дорогая работа,
 * которую REND-34 добавляет.
 *
 * Числа bloom авторски не названы: счётчиков они не двигают вовсе (работа
 * прохода — его цель, а не сила свечения), и написать их значило бы притворить
 * фикстуру настройкой. Двигают счётчики ровно два рычага, и оба под гейтом:
 * флаг `enabled` (потолок пресета гасит пирамиду) и разрешение её вершины.
 */
const BENCH_POSTPROCESS: PresentationPostprocess = Object.freeze({
  toneMapping: { operator: 'aces' },
  bloom: { enabled: true },
} as const);

/**
 * Секция `water` стенда (PRES-2, REND-35) — водоём С ВЫРЕЗОМ намеренно: карта
 * из одного прямоугольника давала бы один квад, и greedy-объединение (design
 * D1) в эталоне не читалось бы вовсе. Урез 0.5 стоит между полом нулевого
 * уровня и вершинами решётки укрытий (`benchGrid` поднимает их на уровень 1):
 * вода заливает низину и обрывается у столбов — берег, который считает
 * фрагмент, а не карта.
 *
 * Карта строится ПО СЕТКЕ, а не пишется константой: арены стенда разного
 * размера (матчевая 8×8, синтетическая 16×16), а ряды карты обязаны совпадать с
 * сеткой клетка в клетку — дополнять их умолчанием REND-35 запрещает.
 *
 * Числа детали и ряби названы авторски и ВЫШЕ потолков производительного
 * пресета (`PERFORMANCE_PRESET` ниже) — по тому же основанию, по какому у
 * стенда авторский режим теней `full`: иначе min() не срабатывал бы, и обе
 * секции эталона несли бы один бюджет под двумя именами (QUAL-4, design D3).
 * Источник детали — `procedural`: текстурных ассетов у стенда нет вовсе (CONT-4).
 */
function benchWater(grid: TerrainGrid): PresentationWater {
  const holeX = Math.floor(grid.width / 2);
  const holeY = Math.floor(grid.height / 2);
  const cells = Array.from({ length: grid.height }, (_, y) =>
    Array.from({ length: grid.width }, (_, x) =>
      x >= holeX && x < holeX + 2 && y >= holeY && y < holeY + 2 ? '.' : '0',
    ).join(''),
  );
  return {
    cells,
    bodies: [
      {
        surfaceLevel: 0.5,
        shallowColor: '#4db8c4',
        deepColor: '#16505e',
        maxDepth: 0.5,
        detail: { source: 'procedural', layers: 4 },
        // Порог скорости почти нулевой: сущности записанных матчей идут медленно,
        // а без источников счётчик ряби лежал бы нулём во всех эталонах.
        ripples: { sources: 16, minSpeed: 0.0001 },
      },
    ],
  };
}

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
 * Имена ручек — собранного реестра (design D1). Эталон двигают четыре ручки:
 * разрешение маски — полномасочными счётчиками тумана, множитель порогов LOD —
 * треугольниками скомпактованных записей батчей (REND-22), потолок разбиения —
 * квадами пола пересобранных чанков (REND-9), выключатель bloom — проходами и
 * текселями пирамиды (REND-34). Ярус по умолчанию оба документа
 * держат `batched` (дефолт) осознанно: пресет применяется при регистрации, до
 * первого инстанса, `modelsRebuilds` в эталоне — ноль, а `detailed` в одной из
 * секций обнулил бы батч-счётчики безъярусной записи и сломал закон x4 по
 * треугольникам; рычаг яруса стережёт юнит-тест render-ts, не эталон. Множитель плотности частиц счётчиков не
 * двигает намеренно (change `bench-stand-subsystems`, design D3): он правит
 * эмиссию ВНУТРИ систем, а объём нашей работы — оболочки, взятия из пула, шаги
 * систем — от него не меняется, и читать состояние three.quarks эталону
 * запрещено (PERF-3: машинная независимость).
 */
const PERFORMANCE_PRESET: QualityPreset = Object.freeze({
  // Потолок ниже сценного разрешения стенда (`MATCH_STAND.resolution`): min()
  // срабатывает, и грубая маска — то, чем производительный режим и отличается.
  'fog.maskResolution': 4,
  // Потолок ниже авторского `full` секции стенда (`BENCH_LIGHTING`): действует
  // `hybrid`, и разница режимов — какой ярус кастеров платит кадром — читается
  // диффом двух секций эталона (REND-30, QUAL-4).
  'lighting.shadowMode': 'hybrid',
  'lighting.shadowMapSize': 512,
  'models.defaultTier': 'batched',
  // Больше единицы — пороги LOD читаются раньше, инстанс уходит на грубый
  // уровень ближе к камере (REND-22).
  'models.lodThresholdScale': 2,
  'particles.density': 0.5,
  // Потолок-выключатель поверх авторски включённого bloom секции стенда
  // (`BENCH_POSTPROCESS`): min() срабатывает, пирамиды в кадре нет, и разница
  // двух секций эталона — пять полноэкранных проходов и их тексели (REND-34,
  // QUAL-4). Оператор сведения при этом действует на обоих пресетах: это один
  // проход постоянной стоимости, и гасить его значило бы менять облик кадра, а
  // не его цену (QUAL-2).
  'postprocess.bloom': false,
  // Мультисэмплинга цели сцены слабое устройство не платит (REND-34): вместо
  // него в конец цепочки встаёт ЭКРАННОЕ сглаживание — один полноэкранный
  // проход по готовому кадру. Обмен виден диффом двух секций эталона: у
  // производительной на проход больше, а многосэмпловой цели нет вовсе.
  'postprocess.antialias': 0,
  'terrain.curvatureTessellation': 2,
  // Потолки воды ниже авторских чисел секции стенда (`benchWater`): рябь
  // выключена вовсе, слоёв детали вдвое меньше, выборка глубины вчетверо
  // дешевле — три строки диффа, которых на ультра-пресете нет (REND-35, QUAL-4).
  'water.rippleSources': 0,
  'water.detailLayers': 2,
  'water.depthTexelsPerCell': 2,
});

/**
 * Ультра: потолков нет вовсе. Их отсутствие и есть «действует авторское
 * значение» (design D3) — умолчание ceiling-ручки бесконечно, а бесконечности в
 * JSON не написать. Отсюда же отсутствие обеих ручек `lighting.*` — действует
 * авторский `full` секции стенда — и `terrain.curvatureTessellation`:
 * действует плотность конфига рендера, и её же ограничивает вдвое
 * производительный документ. Прямые значения выписаны своими документированными
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
  /**
   * Подключить отладочный слой рендера со ВСЕМИ источниками включёнными
   * (`render-debug` RDBG-8). Стенд с ним и стенд без него обязаны давать
   * побитово одинаковые счётчики стоимости — это и есть проверяемая форма
   * требования «отладка невидима счётчикам».
   */
  readonly debug?: boolean;
  /**
   * Размер чанка террейна в клетках; нет — `TERRAIN_CHUNK`. Матчевый стенд
   * задаёт его стороной своей арены: клеток у неё вчетверо больше (клетка
   * мельче радиуса обзора, см. `MATCH_STAND`), а чанк по-прежнему один.
   */
  readonly terrainChunk?: number;
  /**
   * Сдвиг решётки узлов карты кривизны, в клетках; нет — ноль. Матчевый стенд
   * двигает её вместе с решёткой укрытий (`MATCH_STAND.offset`): иначе столбы
   * оказались бы на плоских клетках, и потолок разбиения перестал бы двигать
   * работу стенок (`benchCurvature`, REND-9).
   */
  readonly curvatureOffset?: number;
}

/**
 * Размер чанка террейна в клетках по умолчанию. Восьмёрка выбрана под
 * синтетическую арену осей (16×16): она укладывается в ЧЕТЫРЕ чанка, и
 * локальность пересборки (REND-7) перестаёт быть декларацией — правка в одном
 * углу арены не трогает геометрию другого, а `terrainChunksRebuilt` считает
 * ровно затронутые чанки, а не всю арену. Матчевый стенд свой чанк называет
 * сам (`terrainChunk`): его арена — один чанк намеренно, и счётчик пометок на
 * ней читается как «две мутации пола на доставку», а не как раскладка чанков.
 */
const TERRAIN_CHUNK = 8;

/**
 * Высота камеры стенда над ареной, мировые единицы. Камера смотрит на центр
 * арены сверху вниз — так все инстансы попадают в пирамиду видимости (REND-21;
 * отсечённый инстанс уровня не выбирает вовсе), а экранный размер у них
 * примерно один, и множитель порогов LOD пресета переводит на соседний уровень
 * ВСЕ записи разом, а не случайную их долю. Значение согласовано с порогами
 * записи манифеста (`benchContent.ts`): при множителе 1 инстансы держатся
 * нулевого уровня, при 2 уходят на первый (REND-22, ASSET-13).
 */
const CAMERA_HEIGHT = 24;

/**
 * Клеток пола, которые стенд перещёлкивает каждой доставкой (TERR-6 → REND-7).
 *
 * Работа террейна вся событийная: чанк пересобирается по мутации пола, правке
 * документа или смене поверхности, а «просто кадр» подсистеме террейна не стоит
 * ничего. Записанные матчи же идут на сценах БЕЗ террейна вовсе, и без своей
 * мутации счётчики `terrain*` лежали бы нулями на всех трёх записях — гейт
 * стерёг бы пустоту. Поэтому стенд объявляет мутацию сам — тем же механизмом,
 * которым он объявляет статы наблюдателей тумана (`MATCH_STAT_SOURCES`):
 * нагрузка, которой сцена дуэли не несёт, но которую тракт обязан уметь.
 *
 * Две клетки берутся с шагом по всей арене (см. `floorPulse`) — чтобы на
 * многочанковой арене они пришлись на разные чанки, — и щёлкают между «пол
 * выбит» и «пол на месте» через доставку: значение, а не переключение,
 * переживает conflation (SHELL-4), и дельта каждой доставки непуста.
 */
const FLOOR_PULSE_CELLS = 2;

/**
 * Презентационный тракт бенча: Extractor (воркер-сторона) → ViewBuffer
 * (main-сторона, часы инжектированы) → PresentationStage с подсистемами тумана,
 * позиций, террейна, моделей и частиц. Ровно тот шов, на котором сняты счётчики
 * стадий `syncTick` и `frame` (PERF-2).
 */
export class PresentationBench {
  readonly stage: PresentationStage;
  readonly buffer: ViewBuffer;
  readonly fog: FogSubsystem;
  /** Освещение стенда (REND-8) — сток теневых кастеров террейна и моделей. */
  readonly lighting: LightingSubsystem;
  /** Пост-обработка кадра стенда (REND-34) — владелец проходов кадра и порт тумана. */
  readonly postprocess: PostprocessSubsystem;
  readonly renderer = new RendererSpy();
  /** Контроллер качества сцены стенда (QUAL-1): реестр ручек и их значения. */
  readonly quality: QualityController;
  /** Отладочный слой стенда (RDBG-1); null — стенд собран без отладки вовсе. */
  readonly debug: RenderDebugLayer | null;
  /**
   * Предупреждения подсистем стенда. Пустой список — часть проверки, а не
   * отладка: заглушка вместо модели, неразвёрнутый эффект или карта кривизны не
   * той сетки дали бы счётчики МЕНЬШЕЙ работы, и эталон стерёг бы деградацию
   * фикстуры, приняв её за норму.
   */
  readonly warnings: string[] = [];

  private readonly extractor: Extractor;
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly clock: { ms: number };
  /** Клетки арены — знаменатель шага импульса пола. */
  private readonly floorCells: number;
  /** Номер доставки: им чередуется значение бита пола в импульсе. */
  private deliveries = 0;
  /** Переиспользуемая дельта пола: пар «клетка, бит» ровно `FLOOR_PULSE_CELLS`. */
  private readonly floorDelta = new Int32Array(FLOOR_PULSE_CELLS * 2);
  /**
   * Герой игрока — источник команды, чьи наблюдатели открывают маску (FOW-7).
   * Берётся первой доставкой: ID приезжает из мира, а не из конфигурации.
   */
  private hero: EntityId | null = null;

  constructor(options: PresentationBenchOptions) {
    const clock = { ms: 0 };
    this.clock = clock;
    const { grid } = options;
    this.floorCells = grid.width * grid.height;
    const kindOf = benchKinds();
    this.extractor = new Extractor({
      kindOf: (_state, entity) => kindOf(entity),
      ...(options.stats !== undefined ? { stats: options.stats } : {}),
    });
    this.buffer = new ViewBuffer({
      tickSeconds: 1 / TICK_RATE,
      clock: () => clock.ms,
      // Зеркало карты пола арены (SHELL-2): без него дельта пола доставки
      // отбрасывается буфером, и мутация до террейна не доезжает.
      floorBits: new Uint8Array(grid.floor),
    });
    const context: RenderContext = {
      scene: new THREE.Scene(),
      // Ассеты стенда — синтетические фикстуры, готовые немедленно (CONT-4,
      // design D2): дерева контента бенч не читает, а асинхронная готовность
      // не доехала бы до синхронного прогона записи вовсе.
      assets: benchAssets(),
      config: { heightStep: 1 },
    };
    // Пост-обработка — ДО тумана: её порт туман берёт опцией `post`, а объявляет
    // порт тот, кто зарегистрирован раньше и снесён будет позже (REND-31).
    this.postprocess = new PostprocessSubsystem({ config: BENCH_POSTPROCESS });
    this.fog = new FogSubsystem({
      grid,
      stats: FOG_STATS,
      hero: () => this.hero,
      config: { resolution: options.resolution },
      // Порт цепочки (REND-34, FOW-7): при активной цепочке сцену рисует она, а
      // туман кладёт маску поверх её выхода — то самое пересечение владений,
      // которое эталон и обязан стеречь.
      post: this.postprocess,
      // Бюджет порционной перестройки снят (change `fog-mask-budgeted-rebuild`,
      // design D1): стенд крутит РОВНО ОДИН кадр на доставку, а игра — три-четыре,
      // и под бюджетом эталон мерил бы каденс стенда (сколько доставок съела
      // конфляция), а не работу растеризации. Гейт стоимости стережёт объём
      // ПОЛНОЙ перестройки — величину, от нарезки не зависящую (PERF-3, PERF-4);
      // саму нарезку и коалесинг стерегут юнит-тесты `render-ts`.
      rebuildBudget: Number.POSITIVE_INFINITY,
      createCanvas: benchCanvas,
    });
    // Свет — подсистемой с авторским режимом теней стенда: без неё счётчики
    // `lighting*` лежали бы нулями во всех эталонах, и теневой проход гейт бы
    // не стерёг (PERF-4). Сетка та же, что у террейна, — по ней обтянуты
    // фрустумы теневых камер (design D6).
    //
    // Порт теневых проходов стенду обязателен: в `hybrid` подсистема ведёт их
    // сама — рисует глубину яруса кадра и сводит ярусы в карту источника
    // (REND-30), — а без порта исполняла бы режим как `full`, и эталон мерил бы
    // не тот режим, что назван секцией. Живого WebGL двойнику не нужно: он
    // повторяет единственное наблюдаемое следствие настоящего прохода — снятый
    // флаг `needsUpdate` у нарисованного источника.
    this.lighting = new LightingSubsystem({
      grid,
      config: BENCH_LIGHTING,
      renderer: {
        render: () => {},
        setRenderTarget: () => {},
        shadowMap: {
          enabled: true,
          render: (lights) => {
            for (const light of lights) {
              (light as THREE.DirectionalLight).shadow.needsUpdate = false;
            }
          },
        },
      },
    });
    // Визуальная поверхность (REND-9) — общая на подсистемы; карта кривизны
    // ставится ДО регистрации, поэтому первая же сборка чанков идёт с рельефом,
    // а не пересобирает арену вторым проходом.
    const surface = new VisualSurfaceSource(grid, { warn: (message) => this.warnings.push(message) });
    surface.setCurvature(benchCurvature(grid, options.curvatureOffset ?? 0));
    this.surface = surface;
    this.camera.position.set(grid.width / 2, grid.height / 2, CAMERA_HEIGHT);
    this.camera.lookAt(grid.width / 2, grid.height / 2, 0);
    this.camera.updateMatrixWorld(true);
    this.stage = new PresentationStage(context);
    // Контроллер заводится ДО регистрации: значения ручек уезжают подсистеме
    // тем же путём, что в игре, — регистрацией (QUAL-1, design D2), а не
    // отдельным вызовом «примени пресет» после сборки сцены.
    this.quality = new QualityController(this.stage, options.preset ?? BENCH_PRESETS.ultra);
    const warn = (message: string): void => {
      this.warnings.push(message);
    };
    // Отладочный слой заводится ДО регистрации подсистем — тем же порядком, что
    // контроллер качества: объявления источников он спрашивает при регистрации
    // (REND-27). В список подсистем он при этом не входит, и счётные величины
    // доставки и кадра (PERF-3) от его присутствия не меняются (RDBG-8).
    this.debug = options.debug === true ? new RenderDebugLayer(this.stage, { scene: context.scene, surface }) : null;
    // Пост-обработка первой, освещение следом — порядок сборок (REND-8):
    // проходами кадра владеет цепочка, а корни нарисованного подсистемы ниже
    // отдают свету теневыми кастерами через опцию `shadows`.
    this.stage
      .register(this.postprocess)
      .register(this.lighting)
      .register(this.fog)
      .register(new PositionsSubsystem())
      .register(
        new TerrainSubsystem(grid, {
          chunkSize: options.terrainChunk ?? TERRAIN_CHUNK,
          surface,
          shadows: this.lighting,
        }),
      )
      // Вода — сразу за террейном, как в сборках (REND-8): глубину она берёт из
      // той же визуальной поверхности. Без неё счётчики `water*` лежали бы
      // нулями во всех эталонах, и ни удорожание фрагмента, ни потолки
      // `water.*` гейту видны не были бы (PERF-4, QUAL-4).
      .register(new WaterSubsystem({ grid, config: benchWater(grid), surface, warn }))
      .register(new ModelsSubsystem(benchManifest(), { camera: this.camera, warn, shadows: this.lighting }))
      .register(new ParticlesSubsystem(benchManifest(), { warn }));
    if (this.debug !== null) {
      // Источники сборки — рядом с объявленными подсистемами (RDBG-1): стенду
      // нужны ВСЕ, иначе «включено = выключено» проверялось бы на половине.
      this.debug.register(deliveryDebugSource()).register(costCountersDebugSource());
      for (const source of this.debug.sources) this.debug.setEnabled(source.id, true);
    }
  }

  /** Визуальная поверхность стенда (REND-9) — общая с подсистемами и отладкой. */
  readonly surface: VisualSurfaceSource;

  /** Действующее разрешение маски — сценное под потолком пресета (FOW-10, design D3). */
  get maskResolution(): number {
    return this.fog.config.resolution;
  }

  /**
   * Тик мира — доставка и кадры презентации. Часы идут ровно по каденсу тика.
   *
   * Доставка объявляется состоявшейся сразу за `apply` — так и делает
   * однопоточная сборка (`RenderHost`, SHELL-3): зеркало последнего
   * доставленного кадра двигает факт доставки, и без этого объявления стенд
   * платил бы каналу полным состоянием каждый тик, чего ни одна сборка не
   * делает.
   */
  step(result: TickResult): void {
    this.deliver(this.extractor.extract(result));
    this.extractor.markDelivered();
  }

  /** Та же доставка от синтетической плоской формы — ось масштабирования (PERF-6). */
  deliver(ext: ExtractedTick): void {
    this.clock.ms += 1000 / TICK_RATE;
    ext.floorDelta = this.floorPulse();
    this.buffer.apply(ext);
    this.hero ??= observerOf(this.buffer.view);
    this.stage.publish(PRODUCER, this.buffer.view);
    for (let i = 0; i < FRAMES_PER_TICK; i++) this.frame();
  }

  /**
   * Дельта пола этой доставки — пары «клетка, бит» (TERR-6). Клетки берутся с
   * шагом по всей арене, бит чередуется через доставку: каждая доставка
   * действительно меняет карту, и террейн получает пометку чанка, а не пустой
   * список.
   */
  private floorPulse(): Int32Array {
    const stride = Math.max(1, Math.floor(this.floorCells / FLOOR_PULSE_CELLS));
    const bit = this.deliveries % 2 === 0 ? 0 : 1;
    for (let k = 0; k < FLOOR_PULSE_CELLS; k++) {
      this.floorDelta[k * 2] = (k * stride) % this.floorCells;
      this.floorDelta[k * 2 + 1] = bit;
    }
    this.deliveries++;
    return this.floorDelta;
  }

  private frame(): void {
    // Полтика между доставкой и кадром: кадр посреди интервала доставки, а не
    // вырожденный на его границе. Сама альфа при этом — доля НАБЛЮДАЕМОГО
    // каденса доставок (REND-2, change `fog-observer-inputs`): цикл стенда
    // занимает полтора тика по часам (тик до доставки плюс полтика до кадра),
    // и кадр приходится на его треть. Величина стенду безразлична — важно,
    // что она постоянна от прогона к прогону: счётчики остаются
    // воспроизводимыми (PERF-3).
    this.clock.ms += 500 / TICK_RATE;
    const timing = this.buffer.frame(this.clock.ms);
    if (timing !== null) this.stage.frame(timing.dt, timing.alpha, timing.realDt);
    this.fog.render(this.renderer, this.camera);
  }
}

/**
 * Визуальный тип сущности стенда (ASSET-9) — чередованием в порядке ПЕРВОЙ
 * встречи: первая сущность получает запись с явным батчевым ярусом, вторая —
 * запись, ярус не назвавшую (`models.defaultTier`, REND-20), и так далее. Обе
 * записи стенду нужны на любой нагрузке, а записанные матчи несут всего по паре
 * сущностей — чередование по порядку появления даёт обе даже на них, тогда как
 * чётность самого ID зависела бы от раскладки поколений в ядре.
 *
 * Свой словарь на каждый Extractor: порядок доставки детерминирован, поэтому
 * назначение воспроизводится побитово, а два стенда одной записи не делят
 * состояние.
 */
function benchKinds(): (entity: EntityId) => string {
  const assigned = new Map<EntityId, string>();
  return (entity) => {
    let kind = assigned.get(entity);
    if (kind === undefined) {
      kind = assigned.size % 2 === 0 ? BENCH_KINDS.runner : BENCH_KINDS.prop;
      assigned.set(entity, kind);
    }
    return kind;
  };
}

/** Первая сущность доставки со статом команды — герой стенда (FOW-7). */
function observerOf(view: TickView): EntityId | null {
  for (const [id, entity] of view.entities) {
    if (entity.stats?.get(FOG_STATS.team) !== undefined) return id;
  }
  return null;
}

/**
 * Стенд записанного матча: арена 32×32 клетки по восьмушке юнита (четыре юнита
 * в стороне), укрытия решёткой шагом 4 со сдвигом на клетку, проёмы рампы по
 * рядам и АВТОРСКОЕ разрешение маски 8 текселей на мировую единицу. Разрешение
 * выбрано ВЫШЕ потолка производительного пресета намеренно (design D3): иначе
 * min() не срабатывал бы, оба эталона стоимости совпадали бы до счётчика, и
 * гейт QUAL-4 стерёг бы один бюджет под двумя именами.
 *
 * Все четыре величины подобраны под ЗАПИСИ, а не по вкусу. Герои трёх записей
 * ходят по прямоугольнику примерно 2×3 юнита от начала координат с радиусом
 * обзора 0.3 юнита, и уровень им доставляется НУЛЕВОЙ — террейна у записи нет
 * вовсе. Клетка поэтому вшестеро мельче радиуса, а решётка сдвинута с нулевой
 * клетки: под героем пол своего уровня, а в круг попадают и боковые рёбра
 * столбов (тень), и верхушки столбов за проёмом рампы (срез по уровню). Шаг 4,
 * а не 2, потому что при плотной решётке круг на грубой маске
 * производительного пресета выбрасывался бы целиком: там тексель вдвое крупнее
 * клетки. Все четыре счётчика — `fogNearSegments`, `fogMaskTexelsWritten`,
 * `fogShadowTexelTests`, `fogMaskTexelsCut` — на каждой записи и каждом пресете
 * ненулевые, и это утверждение теста, а не свойство эталона.
 *
 * Сторона арены накрывает весь ход героев и остаётся ОДНИМ чанком террейна:
 * размер чанка стенд называет сам (`terrainChunk`), как прежняя арена 8×8 при
 * чанке 8. Решётка узлов кривизны сдвинута тем же `offset` (`curvatureOffset`):
 * стенка обрыва разбивается плотностью подпираемого пола (REND-9), и столбы
 * обязаны стоять на клетках С кривизной, иначе потолок разбиения перестал бы
 * двигать `terrainWallQuads`.
 */
export const MATCH_STAND = {
  extent: 32,
  tile: 0.125,
  pillarStep: 4,
  offset: 1,
  resolution: 8,
} as const;

/** Презентационный стенд матча под одним документом пресета (QUAL-4). */
export function matchBench(preset: QualityPreset, debug = false): PresentationBench {
  return new PresentationBench({
    grid: benchGrid(MATCH_STAND.extent, MATCH_STAND.pillarStep, {
      tile: MATCH_STAND.tile,
      offset: MATCH_STAND.offset,
      ramps: true,
    }),
    resolution: MATCH_STAND.resolution,
    stats: MATCH_STAT_SOURCES,
    terrainChunk: MATCH_STAND.extent,
    curvatureOffset: MATCH_STAND.offset,
    preset,
    debug,
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
  /**
   * Событий одноразового эффекта в доставке — ось «число эффектов» (PERF-6,
   * REND-24). Не задано — ни одного: стенд проверки маски (`qualityInvariance`)
   * меряет туман, и выстрелы частиц ему только шум. Событие несёт координату в
   * Q16.16, как эмитируют её системы контента (REND-1).
   */
  readonly shots?: number;
}

/**
 * Плоская форма доставки нужного размера (SHELL-2) — синтетика осей
 * масштабирования. Сущности раскладываются решёткой по арене, первые
 * `observers` из них несут статы «команда 0 + радиус обзора»: остальные — вес
 * доставки без вклада в маску, ровно как видимые враги настоящего матча.
 *
 * Визуальный тип чередуется теми же двумя записями манифеста, что и на матчах
 * (`benchKinds`): чётные — явный батчевый ярус, нечётные — ярус по умолчанию
 * пресета (REND-20). Работа моделей поэтому растёт вместе с числом сущностей,
 * а не остаётся мёртвой на синтетике.
 */
export function syntheticTick(load: SyntheticLoad): ExtractedTick {
  const count = load.entities;
  const shots = load.shots ?? 0;
  // Нагрузка синтетическая и строится СРАЗУ в плоской форме, то есть за
  // входной границей рендера (REND-1): координаты события здесь float в
  // мировых единицах — ровно такие, какими их отдаёт `renderEventData`.
  const events: RenderEvent[] = Array.from({ length: shots }, (_, i) => ({
    type: BENCH_BURST_EVENT,
    tick: 1,
    data: {
      x: (i % load.extent) + 0.5,
      y: Math.floor(i / load.extent) + 0.5,
    },
  }));
  const ext: ExtractedTick = {
    tick: 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    branchChanged: false,
    freshEvents: true,
    full: true,
    removed: new Float64Array(0),
    removedCount: 0,
    count,
    id: new Float64Array(count),
    kind: new Int32Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    level: new Uint8Array(count),
    simLevel: new Uint8Array(count),
    flags: new Uint8Array(count),
    facingYaw: new Float32Array(count),
    aimYaw: new Float32Array(count),
    motion: new Uint8Array(count),
    motionPhase: new Float32Array(count),
    flightPhase: new Float32Array(count),
    // Обычный темп у всей нагрузки: персональной шкалы стенд не заводит (REND-38).
    timeScale: new Float32Array(count).fill(1),
    statNames: [FOG_STATS.team, FOG_STATS.visionRadius],
    statCount: new Uint8Array(count),
    statIndex: new Int32Array(count * 2),
    statValue: new Float64Array(count * 2),
    statPairs: 0,
    events,
    // Импульс пола кладёт сама доставка стенда (`PresentationBench.deliver`):
    // мутация — свойство стенда, а не размера нагрузки.
    floorDelta: [],
    kindTable: [BENCH_KINDS.runner, BENCH_KINDS.prop],
  };
  for (let i = 0; i < count; i++) {
    ext.id[i] = i + 1;
    ext.kind[i] = i % 2;
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

// ------------------- ось платформы способностей (PERF-6, ABIL-5, ABIL-9, BUFF-3)

/**
 * Синтетическая нагрузка платформы способностей: N кастеров, каждый со своим
 * слотом, каждые четыре тика подтверждают шаг прицеливания по фигуре, кладут
 * бафф на общую цель и выпускают снаряд, и все они наблюдают друг друга сквозь
 * туман войны. Записью матча она не является — участников у неё нет, — поэтому
 * лежит не парой golden-набора, а строится здесь, как и её размеры.
 *
 * Нагрузка эта заведена ровно затем, зачем PERF-6 требует оси: без неё
 * счётчики платформ способностей, баффов, твинов и видимости лежали бы во ВСЕХ
 * эталонах нулями (записанные матчи их платформ не поднимают вовсе), и гейт
 * стоимости не видел бы ни квадратичного поиска хозяина баффа, ни скана всего
 * мира на каждый каст — то есть ровно тех регрессий, ради которых счётчики
 * заведены (PERF-3).
 *
 * Документом на диске она не лежит по той же причине, по какой им не лежит ось
 * DSL: сцена есть ФУНКЦИЯ размера оси, и держать два рукописных документа с
 * шестьюдесятью четырьмя расстановками значило бы держать два документа,
 * расходящихся молча.
 */
export const ABILITY_STRESS = 'ability-stress';

/**
 * Полный размер оси: кастеров сеткой `ABILITY_GRID × ABILITY_GRID`. Сторона
 * НЕЧЁТНАЯ намеренно: малый размер берёт каждую вторую линию сетки, и только у
 * нечётной стороны в него попадают обе крайние — то есть охват арены у размеров
 * совпадает ТОЧНО, а не с точностью до шага сетки.
 */
const ABILITY_GRID = 9;
const ABILITY_CASTERS = ABILITY_GRID * ABILITY_GRID;

/**
 * Прореживание малого размера: каждый второй СТОЛБЕЦ и каждая вторая СТРОКА
 * сетки (см. `abilityStressSizes`), то есть вчетверо меньше кастеров при том же
 * охвате арены. Оно же — сторона блока сетки, внутри которого кастеры делят
 * цель шага и сторону: в прореженном размере от каждого блока остаётся ровно
 * один кастер, поэтому набор целей и сторон у обоих размеров один и тот же.
 */
const ABILITY_THIN = 2;

/** Блоков сетки по стороне — они же кастеры малого размера по стороне. */
const ABILITY_BLOCKS = Math.ceil(ABILITY_GRID / ABILITY_THIN);

/** Тиков в прогоне — столько же, сколько у соседних осей стороны симуляции. */
const ABILITY_STRESS_TICKS = 24;

/** Цели шага прицеливания: их число НЕ зависит от оси — ось двигает кастеров. */
const ABILITY_ANCHORS = 4;

/** Укрытия линии видимости: тоже вне оси — иначе она двигала бы две величины. */
const ABILITY_COVERS = 4;

/** Сторона арены в тайлах; сетка ровная — обрывов у нагрузки нет. */
const ABILITY_ARENA = 16;

/** Шаг сетки кастеров и её начало, в тайлах. */
const ABILITY_STEP = 1.75;
const ABILITY_ORIGIN = 1;

/** Биты сцены (INP-4): каст — 0, подтверждение шага — 1. */
const ABILITY_CAST_BIT = 0;
const ABILITY_CONFIRM_BIT = 1;

const F = (value: number): number => fixed.fromFloat(value);

/** Центр сетки кастеров — точка прицела всех: цель шага у них общая (BUFF-3). */
const ABILITY_CENTER = ABILITY_ORIGIN + ((ABILITY_GRID - 1) * ABILITY_STEP) / 2;

/**
 * Полураствор конуса шага — 90°. Угол здесь — Q16.16-ДОЛЯ ОБОРОТА (EXPR-2,
 * FP-7), а не радианы: 16384 и есть четверть оборота.
 */
const ABILITY_HALF_ANGLE = 16384;

/** Цель шага номер `i`: их четыре, стоят рядом в середине сетки кастеров. */
function anchorAt(i: number): { readonly x: number; readonly y: number } {
  return { x: ABILITY_CENTER + (i % 2) * 0.5, y: ABILITY_CENTER + Math.floor(i / 2) * 0.5 };
}

/**
 * Расстановка нагрузки: сначала кастеры сеткой (их и прореживает малый размер),
 * затем цели и укрытия. Порядок записей нормативен (SER-8, ID-2), поэтому
 * прореживание только выбрасывает записи, а не переставляет их.
 */
function abilityStressSpawns(): ScenarioSpawn[] {
  const spawns: ScenarioSpawn[] = [];
  for (let i = 0; i < ABILITY_CASTERS; i++) {
    const col = i % ABILITY_GRID;
    const row = Math.floor(i / ABILITY_GRID);
    // Номер блока сетки: цель шага и сторона — свойства БЛОКА, а не
    // порядкового номера кастера. Прореживание оставляет от каждого блока ровно
    // одного кастера, поэтому у обоих размеров одни и те же четыре цели и обе
    // стороны: иначе ось двигала бы заодно разброс наложений по целям и состав
    // сторон, а наложения сводились бы не в четыре инстанса, а в один (BUFF-3).
    const block = Math.floor(col / ABILITY_THIN) + Math.floor(row / ABILITY_THIN) * ABILITY_BLOCKS;
    const aim = anchorAt(block % ABILITY_ANCHORS);
    spawns.push({
      prefab: 'Caster',
      overrides: {
        Position: { x: F(ABILITY_ORIGIN + col * ABILITY_STEP), y: F(ABILITY_ORIGIN + row * ABILITY_STEP) },
        Input: { targetX: F(aim.x), targetY: F(aim.y) },
        // Стороны чередуются теми же блоками: у одной стороны пересчёт
        // видимости не доходил бы до линии видимости вовсе — свой всегда виден
        // своему (FOW-2).
        Player: { slot: block % 2 },
        Team: { id: block % 2 },
      },
    });
  }
  for (let i = 0; i < ABILITY_ANCHORS; i++) {
    const at = anchorAt(i);
    spawns.push({ prefab: 'Anchor', overrides: { Position: { x: F(at.x), y: F(at.y) } } });
  }
  for (let i = 0; i < ABILITY_COVERS; i++) {
    spawns.push({
      prefab: 'Cover',
      overrides: { Position: { x: F(ABILITY_CENTER - 2 - i), y: F(ABILITY_CENTER - 2) } },
    });
  }
  return spawns;
}

/**
 * Ввод кастера — не кадрами протокола, а системой сцены: величина оси здесь
 * число КАСТУЮЩИХ агентов, и заводить под неё шестьдесят четыре игрока с
 * потоком кадров значило бы двигать заодно и раскладку ввода (TICK-2, TICK-5).
 * Цикл в четыре тика: фронт бита каста, фронт бита подтверждения при удержанном
 * бите каста (иначе отпускание прервало бы каст, ABIL-4), и два тика покоя.
 */
function abilityDriveSystem(): SystemDef {
  // Фаза цикла читается БИТАМИ номера тика: остатка от деления в словаре
  // выражений нет (арифметика там Q16.16, EXPR-2), а `bitTest` над сырым целым
  // есть — и четвёрка цикла ровно два младших бита и занимает.
  const low = { bitTest: [{ tick: [] }, 0] };
  const high = { bitTest: [{ tick: [] }, 1] };
  const cast = 1 << ABILITY_CAST_BIT;
  const confirm = 1 << ABILITY_CONFIRM_BIT;
  return {
    name: 'Drive',
    order: -900,
    query: { all: ['Input'] },
    as: 'e',
    do: [
      {
        modifyComponent: {
          entity: { var: 'e' },
          component: 'Input',
          values: {
            // Прежняя маска — та же, что читает платформа (ABIL-3, TICK-4):
            // обе записи видят мир до flush, поэтому фронт считается верно.
            prevButtons: { getComponent: [{ var: 'e' }, 'Input', 'buttons'] },
            buttons: {
              if: [
                // Тик ≡ 1 (mod 4) — фронт бита каста.
                { and: [low, { '!': [high] }] },
                cast,
                // Тик ≡ 2 (mod 4) — фронт подтверждения при удержанном касте.
                { and: [{ '!': [low] }, high] },
                cast | confirm,
                0,
              ],
            },
          },
        },
      },
    ],
  };
}

/** Полный документ прогона нагрузки: сцена целиком плюс расстановка. */
function abilityStressScenario(): ScenarioDef {
  const row = '0'.repeat(ABILITY_ARENA);
  const flags = '.'.repeat(ABILITY_ARENA);
  return {
    name: ABILITY_STRESS,
    seed: 20260903,
    ticks: ABILITY_STRESS_TICKS,
    physics: {},
    visibility: {},
    scene: {
      capacity: 1024,
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
        {
          name: 'Collider',
          fields: {
            blockMask: 'i32',
            cliffRise: 'i32',
            halfX: 'fixed',
            halfY: 'fixed',
            hitMask: 'i32',
            layer: 'i32',
            radius: 'fixed',
            shape: 'i32',
          },
        },
        {
          name: 'Input',
          fields: {
            aimDir: 'fixed',
            buttons: 'i32',
            moveX: 'fixed',
            moveY: 'fixed',
            prevButtons: 'i32',
            seq: 'i32',
            targetX: 'fixed',
            targetY: 'fixed',
          },
        },
        { name: 'Player', fields: { slot: 'i32' } },
        { name: 'Health', fields: { hp: 'fixed' } },
        // Маркер цели шага: предикат шага — политика контента (ABIL-5), и
        // «во что целиться» описывается компонентом сцены, а не платформой.
        { name: 'Anchor', fields: { flag: 'i32' } },
        { name: 'Granted', fields: { atTick: 'i32' } },
      ],
      prefabs: [
        {
          name: 'Caster',
          components: {
            Position: { x: 0, y: 0 },
            // Точку прицела задаёт расстановка (`abilityStressSpawns`): у
            // каждого кастера она своя из четырёх целей сцены.
            Input: {},
            Player: { slot: 0 },
            Health: { hp: FIXED_ONE },
            Vision: { radius: fixed.fromInt(8) },
            Visibility: { visibleTo: 0 },
            Team: { id: 0 },
            VisionModifier: {},
            StealthSources: {},
            DetectionSources: {},
          },
        },
        { name: 'Anchor', components: { Position: { x: 0, y: 0 }, Health: { hp: FIXED_ONE }, Anchor: { flag: 1 } } },
        {
          name: 'Cover',
          components: {
            Position: { x: 0, y: 0 },
            Collider: {
              blockMask: 0,
              cliffRise: 0,
              halfX: F(0.5),
              halfY: F(0.5),
              hitMask: 0,
              layer: 0,
              radius: F(0.5),
              shape: 1,
            },
          },
          tags: ['blocksVision'],
        },
        { name: 'Slot', components: { AbilitySlot: { abilityId: 0, slotIndex: 0 }, AbilityCooldown: { remaining: 0, total: 0 } } },
        { name: 'Buff', components: { BuffInstance: {} } },
        { name: 'Bolt', components: { Position: { x: 0, y: 0 }, AbilityProjectile: { abilityId: 0, range: 0, ticksLeft: 6 } } },
      ],
      systems: [
        // Слот выдаётся обычным спавном (ABIL-1) — тем же приёмом, каким его
        // выдаёт сцена дуэли: платформа своего канала «дать способность» не имеет.
        {
          name: 'Grant',
          order: -950,
          query: { all: ['Input', 'Player'], not: ['Granted'] },
          as: 'e',
          do: [
            { spawnEntity: { prefab: 'Slot', overrides: { AbilitySlot: { owner: { var: 'e' } } } } },
            { addComponent: { entity: { var: 'e' }, component: 'Granted', values: { atTick: { tick: [] } } } },
          ],
        },
        abilityDriveSystem(),
        // Твин на каждом носителе здоровья: величина оси двигает и его — твинов
        // столько же, сколько кастеров плюс постоянные цели (TWEEN-1).
        {
          name: 'Pulse',
          order: 30,
          query: { all: ['Health'], not: ['Tween'] },
          as: 'e',
          do: [
            {
              addTween: {
                entity: { var: 'e' },
                def: 0,
                from: 0,
                to: FIXED_ONE,
                duration: FIXED_ONE,
                easing: 0,
                ignoreTimeScale: 1,
              },
            },
          ],
        },
      ],
      tweens: [{ target: 'Health.hp' }],
      abilities: [
        {
          id: 'mark',
          trigger: { input: { bit: ABILITY_CAST_BIT } },
          confirmBit: ABILITY_CONFIRM_BIT,
          // Шаг `unit` с направленной фигурой — это и есть скан кандидатов
          // (ABIL-5): запрос к миру в радиусе, фигура-гейт, предикат контента.
          targeting: {
            steps: [
              {
                kind: 'unit',
                range: fixed.fromInt(24),
                filter: { hasComponent: [{ var: 'candidate' }, 'Anchor'] },
                shape: { kind: 'circle', radius: fixed.fromInt(24), halfAngle: ABILITY_HALF_ANGLE },
              },
            ],
          },
          phases: [{ id: 'aim', trigger: 'commit', durationTicks: 8, timeout: { then: 'cancel' } }],
          effects: [
            { spawnEntity: { prefab: 'Buff', overrides: { BuffInstance: { target: { var: 'unit0' }, source: { var: 'owner' }, buffId: 0 } } } },
            {
              spawnEntity: {
                prefab: 'Bolt',
                overrides: {
                  AbilityProjectile: {
                    owner: { var: 'owner' },
                    originX: { getComponent: [{ var: 'owner' }, 'Position', 'x'] },
                    originY: { getComponent: [{ var: 'owner' }, 'Position', 'y'] },
                  },
                  Position: {
                    x: { getComponent: [{ var: 'owner' }, 'Position', 'x'] },
                    y: { getComponent: [{ var: 'owner' }, 'Position', 'y'] },
                  },
                },
              },
            },
          ],
          projectile: {
            onFade: [{ emitEvent: { type: 'BoltFaded', data: { entity: { var: 'self' } } } }],
          },
        },
      ],
      buffs: [
        // `refresh` на общей цели — то самое наложение, поиск хозяина которого
        // перебирает живые инстансы (BUFF-3): ось делает его квадратичность числом.
        { id: 'marked', class: 'negative', durationTicks: 6, stacking: 'refresh' },
      ],
      abilityRuntime: { teamField: ['Player', 'slot'] },
      terrain: {
        width: ABILITY_ARENA,
        height: ABILITY_ARENA,
        tileSize: FIXED_ONE,
        levels: Array.from({ length: ABILITY_ARENA }, () => row),
        flags: Array.from({ length: ABILITY_ARENA }, () => flags),
      },
      fog: true,
      initial: abilityStressSpawns(),
    },
  };
}

/**
 * Два размера оси «число кастующих агентов» (ABIL-5, BUFF-3, PERF-6).
 *
 * Малый размер — каждый второй СТОЛБЕЦ и каждая вторая СТРОКА сетки, а не
 * каждый четвёртый кастер по порядку и тем более не первая четверть сетки: ось
 * обязана двигать ровно одну величину (PERF-6), а оба этих прореживания сжимали
 * бы заодно охват сетки — при радиусе обзора в восемь тайлов геометрия двигала
 * бы `visibilityPairs` и `abilityCandidates` наравне с числом кастеров, и
 * отношение L/S нечему было бы приписать. Прореживание по сетке оставляет её
 * углы на местах: охват по обеим осям, цели шага, укрытия, сетка террейна и все
 * таблицы у размеров одни и те же, а различается только число кастующих
 * агентов — вчетверо.
 */
export function abilityStressSizes(): { readonly small: AxisSize; readonly large: AxisSize } {
  const full = abilityStressScenario();
  const initial = full.scene.initial ?? [];
  let caster = 0;
  const thinned = initial.filter((spawn) => {
    if (spawn.prefab !== 'Caster') return true;
    const i = caster++;
    return (i % ABILITY_GRID) % ABILITY_THIN === 0 && Math.floor(i / ABILITY_GRID) % ABILITY_THIN === 0;
  });
  return {
    small: {
      magnitude: ABILITY_BLOCKS * ABILITY_BLOCKS,
      def: { ...full, scene: { ...full.scene, initial: thinned } },
    },
    large: { magnitude: ABILITY_CASTERS, def: full },
  };
}

// ------------------- ось data-driven слоя (PERF-6, SYS-1, ACT-1, EXPR-8)

/**
 * Синтетическая нагрузка evaluator'а JSON-систем (`data-driven-systems` SYS-1):
 * N сущностей одного prefab'а, разложенных сеткой, и ЧЕТЫРЕ системы сцены над
 * ними — движение по скорости, ветвление по здоровью, запрос с фильтрами и
 * эмиссия события по условию. Набор систем фиксирован (PERF-6), и величина оси
 * у неё ровно одна: число сущностей, которые эти системы обрабатывают.
 *
 * Ось заведена затем, что data-driven слой — неснимаемый принцип ядра, а мерился
 * он ОДНИМ размером: на записанных матчах `expressions` набирает несколько сотен
 * за прогон, а на обеих прежних осях стороны симуляции (`npcAgents`, `navAgents`)
 * он ноль вовсе — их нагрузки собраны нативными системами. Линейно ли растёт
 * работа evaluator'а по обработанной сущности, по одному числу не видно: обход
 * запроса заново на каждую сущность или повторное вычисление выражения на шаг
 * дали бы то же самое число, только большее. Отвечает на это второй размер
 * отношением L/S (PERF-4).
 *
 * Нагрузка — фикстура ДВИЖКА, а не контент (`game-content` CONT-4): `content/`
 * бенч не читает вовсе, и сцена строится здесь ФУНКЦИЕЙ размера — по той же
 * причине, по какой ею строятся оси экстракции и способностей: два рукописных
 * документа с двумя с половиной сотнями расстановок расходились бы молча.
 *
 * Ни физики, ни видимости, ни навигации у прогона нет намеренно: их счётчики
 * растут ПЛОТНОСТЬЮ и геометрией, а не числом обработанных сущностей, и на этой
 * оси двигали бы вторую величину. Отсюда же роль позиций: здесь они инертные
 * данные — их пишет система движения и не читает ни один пространственный
 * запрос (ни `withinRadius`, ни `nearestTo`, ни луч), — поэтому малый размер
 * берётся ПРЕФИКСОМ расстановки, а не прореживанием сетки. У оси NPC
 * прореживание обязательно ровно потому, что там выборка соседей растёт
 * плотностью толпы; здесь плотности не читает никто, и префикс оставляет
 * различие размеров одним-единственным — числом сущностей.
 */
export const DSL_SCALE = 'dsl-scale';

/** Тиков в прогоне — столько же, сколько у соседних осей стороны симуляции. */
const DSL_TICKS = 24;

/** Сущностей в ряду сетки: раскладка сеткой, а не линией. */
const DSL_ROW = 16;

/**
 * Вариантов начальных значений четыре, и вариант сущности — остаток её
 * порядкового номера. Оба размера кратны четырём, поэтому префикс держит ровно
 * ту же ДОЛЮ каждого варианта, что и полная расстановка, а работа evaluator'а
 * на сущность зависит только от её варианта и номера тика — не от того, сколько
 * сущностей стоит рядом. Отсюда ожидание оси: счётчики растут РОВНО отношением
 * размеров, и всякое отклонение означает работу, зависящую не от самой
 * сущности, а от их числа.
 *
 * Доля вариантов важна именно потому, что вклад систем в счётчик выражений у
 * них РАЗНЫЙ: односторонний `if` системы 3 (ACT-1) вычисляет тело не на каждой
 * сущности, и сдвиг долей между размерами двигал бы отношение L/S сам по себе.
 */
const DSL_VARIANTS = 4;

/**
 * Ёмкость мира — ОДНА на оба размера и с запасом над большим: `worldBytes`
 * эталона памяти есть константа мира (PERF-8), и ёмкость, подобранная под
 * размер, двигала бы её вместе с осью.
 */
const DSL_CAPACITY = 512;

/** Порог ветвления и шаг здоровья: около порога значение и колеблется. */
const DSL_HALF = F(0.5);
const DSL_PULSE = F(0.125);

/**
 * Расстановка нагрузки: сущности одного prefab'а сеткой шириной `DSL_ROW`.
 * Начальные здоровье и скорость — свойства ВАРИАНТА, а не порядкового номера,
 * и потому одинаково распределены у обоих размеров.
 */
function dslSpawns(entities: number): ScenarioSpawn[] {
  const spawns: ScenarioSpawn[] = [];
  for (let i = 0; i < entities; i++) {
    const variant = i % DSL_VARIANTS;
    spawns.push({
      prefab: 'Mote',
      overrides: {
        Position: { x: F(i % DSL_ROW), y: F(Math.floor(i / DSL_ROW)) },
        Velocity: { x: F((variant + 1) / 16), y: F(-(variant + 1) / 16) },
        Health: { hp: F(0.25 * (variant + 1)) },
      },
    });
  }
  return spawns;
}

/**
 * Четыре системы нагрузки (design D1) — по одной на способ, которым контент
 * тратит evaluator: арифметика над полями, ветвление по условию, запрос с
 * фильтрами и структурной командой, эмиссия события.
 *
 * Запросов ВНУТРИ действий нет ни одного (ни `forEach`, ни `nearestTo`):
 * линейность по обработанной сущности — то самое ожидаемое свойство нагрузки,
 * которое ось и проверяет, а вложенный запрос сделал бы квадратичность
 * свойством самой нагрузки, и отличить её от квадратичности evaluator'а было бы
 * нечем.
 *
 * `order` — из свободной полосы 1…49 между `LocomotionSystem` и `TweenSystem`
 * (`determinism-core` DET-9): нативных систем у этого прогона нет вовсе, но
 * шкала общая, и занимать чужие якоря незачем.
 */
function dslSystems(): SystemDef[] {
  const e = { var: 'e' };
  const hp = { getComponent: [e, 'Health', 'hp'] };
  const field = (component: string, name: string): unknown => ({ getComponent: [e, component, name] });
  const pulse = (op: '+' | '-'): Action => ({
    modifyComponent: { entity: e, component: 'Health', values: { hp: { [op]: [hp, DSL_PULSE] } } },
  });
  return [
    // 1. Движение: чистая арифметика над двумя полями компонента — самый частый
    //    вид работы контентной системы и нижняя граница стоимости сущности.
    {
      name: 'Drift',
      order: 10,
      query: { all: ['Position', 'Velocity'] },
      as: 'e',
      do: [
        {
          modifyComponent: {
            entity: e,
            component: 'Position',
            values: {
              x: { '+': [field('Position', 'x'), field('Velocity', 'x')] },
              y: { '+': [field('Position', 'y'), field('Velocity', 'y')] },
            },
          },
        },
      ],
    },
    // 2. Ветвление: обе ветви живые на обоих размерах — здоровье колеблется
    //    вокруг порога. Ветви действия `if` (ACT-1) здесь структурно одинаковы,
    //    поэтому вычисленных узлов у системы поровну при любом исходе условия:
    //    вклад её в счётчик выражений ПОСТОЯНЕН на сущность. Рядом с переменным
    //    вкладом системы 3 он и нужен — набор оси держит оба.
    {
      name: 'Pulse',
      order: 20,
      query: { all: ['Health'] },
      as: 'e',
      do: [{ if: { cond: { '<': [hp, DSL_HALF] }, then: [pulse('+')], else: [pulse('-')] } }],
    },
    // 3. Запрос с фильтрами и структурная команда: выборка сужена и негативным
    //    фильтром, и тегом (`ecs-foundation` QUERY-1), а тело добавляет
    //    компонент — то есть работа идёт не только через запись поля. `else` у
    //    действия `if` здесь нет вовсе: ACT-1 его не требует (в отличие от
    //    одноимённого ОПЕРАТОРА выражений, у которого ветвь `else` обязательна,
    //    EXPR-8), и потому число вычисленных узлов на сущность — свойство её
    //    варианта и номера тика, а не константа. Переменный вклад в счётчик
    //    выражений даёт именно эта система.
    {
      name: 'Charge',
      order: 30,
      query: { all: ['Health'], not: ['Tag'], withTag: 'Mote' },
      as: 'e',
      do: [
        {
          if: {
            cond: { '>=': [hp, DSL_HALF] },
            then: [{ addComponent: { entity: e, component: 'Tag', values: { atTick: { tick: [] } } } }],
          },
        },
      ],
    },
    // 4. Эмиссия события по условию раз в два тика плюс снятие компонента:
    //    шина тика — тоже работа контента (`eventsEmitted`, PERF-3), а снятие
    //    возвращает нагрузку в исходное состояние, иначе выборка системы 3
    //    высохла бы к третьему тику и ось мерила бы мёртвую систему.
    {
      name: 'Spark',
      order: 40,
      query: { all: ['Tag'] },
      as: 'e',
      do: [
        {
          if: {
            cond: { bitTest: [{ tick: [] }, 0] },
            then: [
              { emitEvent: { type: 'DslSpark', data: { entity: e, atTick: field('Tag', 'atTick') } } },
              { removeComponent: { entity: e, component: 'Tag' } },
            ],
          },
        },
      ],
    },
  ];
}

/**
 * Сцена нагрузки на N сущностей: компоненты, единственный prefab и те же четыре
 * системы. Всё, кроме расстановки, у размеров совпадает — это и есть условие
 * «ось двигает ровно одну величину» (PERF-6).
 *
 * `Tag` в prefab'е не объявлен намеренно: он появляется и снимается командами
 * (`ecs-foundation` CMD-4), и именно на нём держится негативный фильтр запроса.
 */
function dslScene(entities: number): SceneDef {
  return {
    capacity: DSL_CAPACITY,
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Health', fields: { hp: 'fixed' } },
      { name: 'Tag', fields: { atTick: 'i32' } },
    ],
    prefabs: [
      {
        name: 'Mote',
        tags: ['Mote'],
        components: { Position: { x: 0, y: 0 }, Velocity: { x: 0, y: 0 }, Health: { hp: FIXED_ONE } },
      },
    ],
    systems: dslSystems(),
    initial: dslSpawns(entities),
  };
}

/** Полный документ прогона нагрузки: сцена размера плюс длина прогона. */
function dslLoad(entities: number): ScenarioDef {
  return { name: `${DSL_SCALE}-${entities}`, seed: 20260904, ticks: DSL_TICKS, scene: dslScene(entities) };
}

/**
 * Размер оси по числу: величина и документ прогона получаются из ОДНОГО числа,
 * и разойтись им негде — расстановка сцены есть населённость мира целиком
 * (спавнов и гибели у нагрузки нет вовсе).
 */
function dslSize(entities: number): AxisSize {
  return { magnitude: entities, def: dslLoad(entities) };
}

/**
 * Два размера оси «число сущностей, обрабатываемых JSON-системами» (SYS-1,
 * PERF-6). Четырёхкратный разрыв — тот же, что у оси способностей: линейную
 * работу evaluator'а он показывает ровным отношением, а любую суперлинейность
 * (обход запроса на каждую обработанную сущность) — непропорциональным. Оба
 * числа кратны числу вариантов: доля каждого варианта у размеров обязана
 * совпадать, иначе ось двигала бы заодно состав вычисленных ветвей.
 */
export function dslScaleSizes(): { readonly small: AxisSize; readonly large: AxisSize } {
  return { small: dslSize(64), large: dslSize(256) };
}

// --------------------------------------------- стоимость провода (PERF-12)
//
// Провод сервера — персональный снапшот каждому соединению после фильтра
// видимости (`netcode` NET-12) и кодека (`netcode-transport` NTR-13). Стенд
// здесь ОДИН на две нагрузки: записанные матчи (CLI-10) прогоняются тем же
// `playMatch`, которым они и записаны, а ось числа клиентов поднимает такой же
// loopback-матч на N соединений. Байты берутся из отчёта хоста (NTR-11), а не
// повторным кодированием снапшота в тесте: второй кодек мерил бы себя (PERF-12).

/** Имя документа оси провода. */
export const WIRE_CLIENTS = 'wire-clients';

/**
 * Стоимость провода ОДНОГО слота (PERF-12). Источников у величин два:
 * `snapshotBytes`, `snapshots` и `bytesOther` считает хост по соединению
 * (NTR-11), `entitiesDelivered` и `eventsDelivered` — состав того, что клиент
 * слота действительно принял. Поля перечислены по алфавиту — тем же порядком,
 * каким они лягут в эталон.
 *
 * Наследование от плоского набора именованных счётчиков — то же, что у сводки
 * тика: секция эталона обязана подставляться туда же, куда подставляются
 * счётчики стадий, и проходить общую сортировку ключей.
 */
interface WireSlotCost extends Record<string, number> {
  /**
   * Байты соединения ПОМИМО персональных снапшотов: поток событий (NTR-15) и
   * хендшейк (NTR-4). Хендшейк отчётом не выделяется и потому назван честно —
   * это не «байты событий», а «байты всего остального»; он константен, и рост
   * этой строки при неизменном числе соединений означает поток событий.
   */
  readonly bytesOther: number;
  /** Сущности, попавшие в применённые слотом снапшоты, — размер выхода фильтра (NET-12). */
  readonly entitiesDelivered: number;
  /**
   * Факты, доставленные слоту (NET-13, NTR-15). Считаются по потоку `Events`, а
   * не по шине внутри снапшота: презентационная поверхность клиента шины не
   * отдаёт вовсе (`PresentedState`), и единственный источник фактов для
   * потребителя — этот поток.
   */
  readonly eventsDelivered: number;
  /** Байты ушедших слоту персональных снапшотов (NTR-11). */
  readonly snapshotBytes: number;
  /** Число ушедших слоту персональных снапшотов (NTR-11). */
  readonly snapshots: number;
}

/** Прогон провода: секции эталона по слоту и наблюдения стенда рядом с ними. */
export interface WireRun {
  /** Ключ — идентификатор игрока конфига матча (`p1`, `p2`, …). */
  readonly slots: Readonly<Record<string, WireSlotCost>>;
  /**
   * Пропуски рассылки по слоту (NTR-22). В эталоне их нет и быть не должно:
   * пропуск на стенде без очереди — дефект стенда, а не стоимость (PERF-12), и
   * утверждает это тест.
   */
  readonly skipped: Readonly<Record<string, number>>;
  /**
   * Применённых слотом снапшотов — половина эталона, снятая на КЛИЕНТЕ, рядом с
   * половиной, снятой на хосте (`snapshots`). Полем эталона не является: это
   * сверка двух источников, а не стоимость.
   */
  readonly applied: Readonly<Record<string, number>>;
}

/**
 * Состав ДОСТАВЛЕННОГО по слотам (PERF-12), считаемый по ходу матча.
 *
 * По ходу, а не по концу, и это не удобство, а единственная возможность —
 * причём у обеих величин по своей причине. Снапшоты: буфер интерполяции держит
 * последние, а не все (NET-3), и сумма после прогона складывалась бы из того,
 * что уцелело. Факты: очередь фактов сливает КАЖДЫЙ шаг клиентского хоста
 * (`ClientHost.step` → `takeEvents`, NTR-15), и к концу прогона в ней лежат
 * только пачки последнего шага — «доставлено» пришлось бы считать по хвосту.
 *
 * Замер стоит между доставкой и следующим сливом: обе величины снимаются в
 * конце итерации, когда доставка этого тика осела, а слив следующей итерации
 * ещё не случился. Каждая пачка поэтому считается ровно один раз, повторы окон
 * рассылки клиент отбрасывает сам курсором (NTR-15).
 *
 * Применённым считается снапшот, которого на прошлой итерации в `latest` не
 * было: `latest` — ссылка на принятый кадр, и смена ссылки есть факт доставки.
 */
class DeliveredComposition {
  private readonly last: (PresentedState | undefined)[];
  private readonly entities: number[];
  private readonly events: number[];
  private readonly applied: number[];

  constructor(slots: number) {
    this.last = Array.from({ length: slots }, () => undefined);
    this.entities = Array.from({ length: slots }, () => 0);
    this.events = Array.from({ length: slots }, () => 0);
    this.applied = Array.from({ length: slots }, () => 0);
  }

  /** Досчитывает слоты по итогу ИТЕРАЦИИ матча — доставка этого тика уже осела. */
  observe(clients: readonly ConnectedClient[]): void {
    for (const [slot, connected] of clients.entries()) {
      // Факты считаются НЕЗАВИСИМО от смены состояния: единица потока — факт, а
      // не кадр (NTR-15), и пачка вправе приехать к тику, состояние которого
      // клиент уже держит.
      for (const batch of connected.client.pendingEvents) {
        this.events[slot] = this.events[slot]! + batch.events.length;
      }
      const latest = connected.client.latest;
      if (latest === undefined || latest === this.last[slot]) continue;
      this.last[slot] = latest;
      this.applied[slot] = this.applied[slot]! + 1;
      this.entities[slot] = this.entities[slot]! + coreWorld.listAlive(latest.world).length;
    }
  }

  entitiesOf(slot: number): number {
    return this.entities[slot]!;
  }

  eventsOf(slot: number): number {
    return this.events[slot]!;
  }

  /** Применённых слотом снапшотов — вторая половина сверки с отчётом хоста. */
  appliedOf(slot: number): number {
    return this.applied[slot]!;
  }
}

/**
 * Сводит прогон в секции эталона: наблюдаемые хоста по соединению слота
 * (NTR-11) плюс состав доставленного. Соединение слота берётся у сервера
 * (`slotLease`), а не порядком подключения: слот назначается по имени игрока
 * (`config.players.indexOf`), и порядок — не свойство провода.
 */
function wireRun(match: Harness, delivered: DeliveredComposition): WireRun {
  const report = match.host.report();
  const byConnection = new Map(report.connections.map((metrics) => [metrics.id, metrics]));
  const slots: Record<string, WireSlotCost> = {};
  const skipped: Record<string, number> = {};
  const applied: Record<string, number> = {};
  match.config.players.forEach((player, slot) => {
    const connection = match.server.slotLease(slot).connection;
    const metrics = connection === undefined ? undefined : byConnection.get(connection);
    // Слот без живого соединения означает, что матч развалился на стенде:
    // считать по нему нечего, и молчаливый ноль был бы эталоном пустоты.
    if (metrics === undefined) {
      throw new Error(`стенд провода: слот ${slot} ("${player}") не занят соединением к концу прогона`);
    }
    // Две половины секции приезжают с РАЗНЫХ сторон провода: байты и число
    // ушедших снапшотов — с хоста (NTR-11), состав доставленного — с клиента.
    // Сойтись они обязаны на общей величине: сколько хост отправил, столько
    // клиент и применил. Расхождение означает, что одна из половин мерит не тот
    // прогон, и состав доставленного в эталоне относится к другим байтам.
    const applications = delivered.appliedOf(slot);
    if (applications !== metrics.snapshots) {
      throw new Error(
        `стенд провода: слот ${slot} ("${player}") применил ${applications} снапшотов, ` +
          `а хост отправил ${metrics.snapshots} (NTR-11)`,
      );
    }
    slots[player] = {
      bytesOther: metrics.bytes - metrics.snapshotBytes,
      entitiesDelivered: delivered.entitiesOf(slot),
      eventsDelivered: delivered.eventsOf(slot),
      snapshotBytes: metrics.snapshotBytes,
      snapshots: metrics.snapshots,
    };
    skipped[player] = metrics.snapshotsSkipped;
    applied[player] = applications;
  });
  return { slots, skipped, applied };
}

/**
 * Стоимость провода на ЗАПИСАННОМ матче (PERF-12): та же запись, тот же стенд,
 * что у `matchGolden.test.ts`, — определение одно (`MATCH_RECORDINGS`).
 */
export async function playWire(name: string): Promise<WireRun> {
  const recording = recordingOf(name);
  // Слотов у стенда записи ровно два: `playMatch` поднимает клиентов `a` и `b`.
  const delivered = new DeliveredComposition(2);
  const match = await recording.play(({ a, b }) => {
    delivered.observe([a, b]);
  });
  return wireRun(match, delivered);
}

// ------------------------------------- ось числа клиентов (PERF-6, PERF-12)

/** Длина прогона оси — та же, что у записи `match-walk`: провод меряется, а не история. */
const WIRE_TICKS = 24;
/** Ввод оси — тот же непрерывный шаг вправо, одинаковый всем слотам. */
const WIRE_WALK_UNTIL = 16;
/**
 * Ёмкость сцены оси: с запасом над большим размером и носителями сцены.
 * Одна и та же у обоих размеров — иначе ось двигала бы заодно ёмкость мира,
 * то есть вторую величину.
 */
const WIRE_CAPACITY = 32;
/**
 * Расстояние между линиями команд. БОЛЬШЕ радиуса обзора сцены (`fogScene`
 * выдаёт герою `Vision` радиуса 1) — и это условие нагрузки, а не оформление:
 * чужая команда обязана оставаться в тумане на ОБОИХ размерах, иначе фильтр
 * ничего не вырезает и его отказ (сценарий PERF-12 «Фильтр перестал вырезать
 * невидимое») эталон провода пройдёт зелёным.
 */
const WIRE_TEAM_GAP = 4;
/**
 * Шаг вдоль линии команды. На видимость он не влияет вовсе — свою команду
 * сущность видит всегда (FOW-3, NET-15), — и нужен только затем, чтобы герои
 * стояли врозь, а не друг в друге.
 */
const WIRE_ROW_STEP = 1;

/** Один размер оси провода: число соединений матча и конфиг этого числа. */
export interface WireSize {
  /** Величина оси — число клиентов; героев в мире столько же (слот приходит со своим). */
  readonly magnitude: number;
  readonly config: MatchConfig;
}

/**
 * Место героя слота: две линии команд напротив друг друга, по линии на команду,
 * шаг вдоль линии — по номеру пары. Позиция есть чистая функция НОМЕРА СЛОТА,
 * поэтому меньший размер оси — префикс большего запись в запись, и геометрия
 * между размерами не разъезжается.
 */
function wireHeroAt(slot: number): { readonly x: number; readonly y: number } {
  return {
    x: fixed.fromInt((slot % 2) * WIRE_TEAM_GAP),
    y: fixed.fromInt(Math.floor(slot / 2) * WIRE_ROW_STEP),
  };
}

/**
 * Конфиг матча на N слотов: арена дуэли С ТУМАНОМ (`fogScene`), N героев двумя
 * линиями команд и N игроков, команды через одну. Всё, кроме числа слотов и
 * порождённой им расстановки, совпадает у размеров запись в запись.
 *
 * Туман здесь — предмет замера, а не декорация: провод есть персональный
 * снапшот ПОСЛЕ фильтра видимости (NET-12), и на сцене без масок фильтру нечего
 * вырезать — он оставляет всем один и тот же мир, а эталон по слотам мерит одно
 * число, записанное дважды. С туманом каждый слот получает свою команду и не
 * получает чужую: линии стоят дальше радиуса обзора друг от друга, и снапшот
 * слота ровно вдвое беднее мира.
 */
function wireClientsConfig(clients: number): MatchConfig {
  return duelConfig({
    name: `${WIRE_CLIENTS}-${clients}`,
    scene: { ...fogScene(), capacity: WIRE_CAPACITY },
    players: Array.from({ length: clients }, (_unused, slot) => `p${slot + 1}`),
    // Точка зрения слота (NET-12) названа конфигом и обязана совпасть с командой
    // его сущности в мире — иначе сборка матча откажет до первого тика.
    teams: Array.from({ length: clients }, (_unused, slot) => slot % 2),
    initial: Array.from({ length: clients }, (_unused, slot) => ({
      prefab: 'Hero',
      overrides: { Player: { slot }, Team: { id: slot % 2 }, Position: wireHeroAt(slot) },
    })),
  });
}

/**
 * Два размера оси «число соединений одного матча» (PERF-6, PERF-12). Разрыв
 * вчетверо, оба числа — в пределах продуктовых «до 10 игроков»: суммарные байты
 * растут произведением «клиенты × сущности», и отношение L/S суммы против L/S
 * оси (4) и есть то, ради чего ось заведена.
 */
export function wireClientsSizes(): { readonly small: WireSize; readonly large: WireSize } {
  return {
    small: { magnitude: 2, config: wireClientsConfig(2) },
    large: { magnitude: 8, config: wireClientsConfig(8) },
  };
}

/**
 * Сток диагностики — СЕРВЕРНОМУ миру матча (DI-5): величины занятой памяти
 * (PERF-8) и сводка стоимости тика снимаются с той стороны, которая тикает.
 * Отметки ветви истории (DIAG-9) стенду не нужны — перемотки у него нет, — а
 * отказов записи не бывает: сток тестовый, в файл не пишет.
 */
function benchTrace(sink: DiagnosticsSink): MatchTrace {
  return { sink, mark: () => {}, failure: undefined };
}

/**
 * Система-публикатор нагрузки фактов: событие на каждого героя каждый тик.
 * Единственное, чем «говорящая» нагрузка отличается от «молчащей».
 */
const WIRE_PING_SYSTEM: SystemDef = {
  name: 'Ping',
  order: 20,
  query: { all: ['Player'] },
  as: 'e',
  do: [{ emitEvent: { type: 'WirePing', data: { entity: { var: 'e' } } } }],
};

function wireEventsConfig(name: string, systems: readonly SystemDef[]): WireSize {
  const scene = duelScene();
  return {
    magnitude: 2,
    config: duelConfig({
      name: `${WIRE_CLIENTS}-${name}`,
      scene: { ...scene, systems: [...(scene.systems ?? []), ...systems] },
    }),
  };
}

/**
 * ПАРА нагрузок провода, различающихся ровно публикацией фактов: дуэль на двух
 * слотах с системой, публикующей событие на каждого героя каждый тик, и та же
 * дуэль без неё.
 *
 * Заведена не ради эталона, а ради проверки счётчика `eventsDelivered`: на
 * записанных матчах он законно ноль (события их сцены не порождают вовсе), и
 * величина, которую ни одна нагрузка не двигает, зелёная одинаково и когда она
 * верна, и когда сломана. Парой, а не одной нагрузкой, потому что байты потока
 * фактов видны только РАЗНОСТЬЮ: `bytesOther` несёт ещё и хендшейк, и «больше
 * нуля» у него верно и без единого факта.
 *
 * Тумана на этих сценах нет намеренно — в отличие от оси, где он предмет
 * замера: здесь предмет — счёт фактов, и без фильтра событий (NET-13) каждый
 * опубликованный факт видим обоим слотам, поэтому «доставлено» обязано сойтись
 * с «опубликовано» точным равенством, а не неравенством.
 */
export function wireEventsSizes(): { readonly publishing: WireSize; readonly silent: WireSize } {
  return {
    publishing: wireEventsConfig('events', [WIRE_PING_SYSTEM]),
    silent: wireEventsConfig('silent', []),
  };
}

/**
 * Прогон оси: loopback-матч на N клиентов с одинаковым вводом. Моста рендера у
 * него нет намеренно — меряется провод, а не кадр, и восьмой презентационный
 * тракт добавил бы к прогону работу, к проводу не относящуюся.
 *
 * Сток диагностики необязателен ровно по образцу прогона записи: гейту
 * стоимости провода он не нужен (величины приезжают отчётом хоста), гейту
 * памяти нужен — пики мира приезжают записью тика (PERF-8).
 */
export async function playWireClients(size: WireSize, diagnostics?: DiagnosticsSink): Promise<WireRun> {
  const config =
    diagnostics === undefined ? size.config : { ...size.config, trace: benchTrace(diagnostics) };
  const build = {
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  };
  const fixture = harness(config);
  const clients = config.players.map((player) =>
    connectClient(fixture.hub, player, fixture.clock, config.scene, walkRight(WIRE_WALK_UNTIL), build),
  );
  const delivered = new DeliveredComposition(clients.length);
  await settle();

  for (let i = 0; i < WIRE_TICKS; i++) {
    fixture.clock.ms += 1000 / TICK_RATE;
    for (const connected of clients) connected.host.step();
    await settle();
    fixture.host.step();
    await settle();
    delivered.observe(clients);
  }
  return wireRun(fixture, delivered);
}
