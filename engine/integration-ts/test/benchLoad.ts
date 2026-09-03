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
  type DiagnosticsSink,
  type EntityId,
  type InputFrame,
  type ScenarioDef,
  type ScenarioSpawn,
  type TerrainGrid,
  type TickResult,
} from '@fluxus/core';
import type {
  PresentationLighting,
  PresentationPostprocess,
  PresentationWater,
} from '@fluxus/assets';
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

  /** Тик мира — доставка и кадры презентации. Часы идут ровно по каденсу тика. */
  step(result: TickResult): void {
    this.deliver(this.extractor.extract(result));
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
    // Полтика между доставкой и кадром: альфа интерполяции 0.5 — кадр посреди
    // тика, а не вырожденный на его границе.
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
