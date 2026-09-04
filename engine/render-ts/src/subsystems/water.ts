/**
 * Подсистема воды (`rendering` REND-35, REND-36) за общим контрактом REND-8.
 *
 * Вход — секция `water` парного presentation-документа сцены (PRES-2): одна
 * клеточная карта и список тел. Сцена без секции не получает НИ ОДНОГО
 * сценового объекта и не двигает ни одного счётчика (PERF-2): кадр остаётся
 * байт-в-байт таким, каким был до появления подсистемы.
 *
 * Глубина воды производна от единого поля высот (REND-9): порт источника
 * поверхности приходит опцией сборки — тот же, которым пользуются геометрия
 * террейна, посадка инстансов и наложения. Второй реализации поверхности не
 * появляется, нового порта рендерера не заводится (REND-1): вода читает поле
 * ровно так же, как его читают соседи, и о них самих ничего не знает (REND-8).
 *
 * Симуляции подсистема не касается ни байтом (`presentation-scene` PRES-4):
 * поле высот она не меняет, посадка инстансов (REND-10) и picking (REND-15) её
 * не видят — юнит в воде стоит на дне.
 */
import * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import {
  validateWater,
  type AssetState,
  type DecodedImage,
  type PresentationWater,
} from '@fluxus/assets';
import { costSink } from '../cost.js';
import { textureFromImage } from '../model/skins.js';
import { levelFieldSampler } from '../visualSurface.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { UNLIMITED_FRAME_BUDGET } from '../types.js';
import type {
  FrameBudget,
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  TickView,
} from '../types.js';
import { WaterBodyView, type WaterBodyLimits } from '../water/body.js';
import {
  MAX_DEPTH_TEXELS_PER_CELL,
  MAX_DETAIL_LAYERS,
  MAX_RIPPLE_SOURCES,
  WATER_DEPTH_TEXELS_PER_CELL,
  WATER_DETAIL_LAYERS,
  WATER_RIPPLE_SOURCES,
  waterQualityDeclaration,
} from './waterQuality.js';
import {
  DEFAULT_WATER_DEPTH_TEXELS_PER_CELL,
  resolveWaterConfig,
  type WaterBodyConfig,
  type WaterRenderConfig,
} from '../water/config.js';
import type { WaterFieldSampler } from '../water/depth.js';
import { waterRegionsOf } from '../water/region.js';

// Имена ручек объявлены рядом с их декларацией (`waterQuality.ts`), а видны
// по-прежнему отсюда: публичная поверхность подсистемы от переноса не меняется.
export { WATER_DEPTH_TEXELS_PER_CELL, WATER_DETAIL_LAYERS, WATER_RIPPLE_SOURCES };

/** Запрошенная анизотропия текстур детали; фактическую зажимает потолок устройства. */
const WATER_DETAIL_ANISOTROPY = 8;

export interface WaterOptions {
  /** Сетка террейна сцены: карта воды адресует её клетки (REND-35). */
  readonly grid: TerrainGrid;
  /** Секция `water` парного документа (PRES-2); нет — сцена без воды. */
  readonly config?: PresentationWater;
  /** Источник визуальной поверхности (REND-9); нет — полем служит уровень (REND-7). */
  readonly surface?: VisualSurfaceSource;
  /** Канал предупреждений; не задан — `console.warn` (недоступная деталь, REND-35). */
  readonly warn?: (message: string) => void;
}

export class WaterSubsystem implements RenderSubsystem {
  readonly name = 'water';

  private grid: TerrainGrid;
  private readonly surfaceSource: VisualSurfaceSource | undefined;
  private readonly warn: (message: string) => void;
  private tile: number;
  /** Авторская секция как есть — ИСТОЧНИК: пресет её не правит ни байтом (QUAL-3). */
  private section: PresentationWater | undefined;
  /**
   * Канонический текст применённой секции — им `applyConfig` отличает правку
   * воды от чужой правки того же документа (ED-15). `null` до первой подачи:
   * секция конструктора уже применена сборкой, и подать её ещё раз — не
   * пересборка, а подтверждение.
   */
  private signature: string | null;
  private current: WaterRenderConfig | null;
  private ctx: RenderContext | null = null;
  private heightStep = 1;
  /**
   * Собственная копия карты пола (TERR-6) — та же причина, что у террейна:
   * мутация приезжает дельтой тика, а сетка документа её снимает (ED-9), и
   * сверять надо с СОБСТВЕННЫМ состоянием, а не с прежней сеткой.
   */
  private floor: Uint8Array;
  /** Отписка от источника поверхности; снос обязан её снять (REND-31). */
  private unsubscribeSurface: (() => void) | null = null;
  private readonly bodies: WaterBodyView[] = [];
  private view: TickView | null = null;
  /** Презентационные часы воды (REND-25): идут со знаком хода мира. */
  private clock = 0;
  /** Потолки пресета; бесконечность — потолка нет, действует авторское (QUAL-1). */
  private ceilings = {
    ripples: Number.POSITIVE_INFINITY,
    layers: Number.POSITIVE_INFINITY,
    texels: Number.POSITIVE_INFINITY,
  };
  /** Загруженные текстуры детали по ID ассета; `null` — ассет не доехал. */
  private readonly textures = new Map<string, THREE.Texture | null>();
  /** Подписки на ассеты детали ПО ID: снятая секция снимает и свою подписку. */
  private readonly unsubscribes = new Map<string, () => void>();
  /** ID, о недоступности которых уже сказано: предупреждение одно на причину. */
  private readonly warned = new Set<string>();
  /**
   * Бюджетная фаза этого кадра уже прошла (REND-44) — та же развилка, что у
   * террейна: сцена с бюджетом перезаполняет глубину фазой, прямой драйв
   * подсистемы (тесты, вьюпорт) — покадровым обновлением, как было до бюджета.
   */
  private budgetedThisFrame = false;

  constructor(options: WaterOptions) {
    this.grid = options.grid;
    this.surfaceSource = options.surface;
    this.section = options.config;
    this.signature = JSON.stringify(options.config ?? null);
    this.current = resolveWaterConfig(this.section);
    this.warn =
      options.warn ??
      ((message): void => {
        console.warn(message);
      });
    // Приём `tileSize` — точка входной границы рендера (REND-1, TERR-2).
    this.tile = options.grid.tileSize / FIXED_ONE;
    this.floor = new Uint8Array(options.grid.floor);
  }

  /** Тела в кадре — вход тестов и диагностики (REND-35). */
  get drawnBodies(): readonly WaterBodyView[] {
    return this.bodies;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.heightStep = ctx.config.heightStep;
    // Источник поверхности инициализируется и подписывается ВСЕГДА, а не только
    // при уже известной секции: вьюпорт редактора поднимает подсистему пустой и
    // подаёт секцию позже (ED-15), а канал затронутых клеток — единственное, чем
    // до воды доезжают асинхронные правки поля (догрузка карты кривизны,
    // walkable-вклад доехавшей модели, REND-9/REND-14). Подписка за проверкой
    // секции означала бы воду, навсегда отставшую от дна (REND-35).
    // Сам вызов идемпотентен: его делают все, кто пользуется источником.
    this.surfaceSource?.init(ctx);
    this.unsubscribeSurface =
      this.surfaceSource?.onChange((cells) => {
        this.invalidate(cells);
      }) ?? null;
    this.requestTextures();
    this.build();
  }

  /**
   * Снос (REND-31): геометрии, материалы и глубинные текстуры тел плюс
   * подписки на ассеты детали. Источник поверхности сюда не входит — он
   * приходит опцией сборки и принадлежит ей, а не подсистеме (REND-8).
   */
  dispose(): void {
    this.clearBodies();
    this.releaseTextures(() => false);
    this.warned.clear();
    // Подписка на источник поверхности снимается, и контекст сцены забывается:
    // снесённая подсистема не метит тел, а поданная после сноса секция не
    // строит мешей в чужую сцену (REND-31). Сам источник сюда не входит — он
    // приходит опцией сборки и принадлежит ей, а не подсистеме (REND-8).
    this.unsubscribeSurface?.();
    this.unsubscribeSurface = null;
    this.ctx = null;
  }

  /**
   * Доставленное состояние (REND-8): вода читает из него только излучателей
   * ряби (REND-36) — интерполированные позиции движущихся сущностей, в которых
   * рождаются кольца. Разрыв непрерывности мира (REND-2) сбрасывает живые
   * кольца всех тел.
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (view.snapAll) for (const body of this.bodies) body.resetRipples();
    // Мутация пола (TERR-6) меняет глубину: под выбитой клеткой дна нет, и
    // вода там не рисуется (REND-35). Карта — своя копия, дельта — та же, что
    // читает террейн: два потребителя одного канала, не два источника правды.
    if (view.floorBits === null || view.floorChangedCells.length === 0) return;
    const { width } = this.grid;
    for (const cell of view.floorChangedCells) {
      this.floor[cell] = view.floorBits[cell]!;
      const x = cell % width;
      const y = Math.floor(cell / width);
      for (const body of this.bodies) body.markCell(x, y);
    }
  }

  /**
   * Кадр (REND-2, REND-25): перезаполнение помеченных глубинных текстур, часы
   * презентации и кольца ряби. Сцена без воды не платит ничем — счётчики
   * остаются нулевыми (PERF-2).
   */
  /**
   * Отложимая работа подсистемы (REND-44): перезаполнение глубинных текстур
   * помеченных тел. Часы презентации и кольца ряби сюда не входят — они
   * кадровые, и фазы может не случиться вовсе (design D2).
   */
  updateBudgeted(budget: FrameBudget): void {
    this.budgetedThisFrame = true;
    if (this.bodies.length === 0) return;
    const cost = costSink();
    const texels = this.refill(budget);
    if (cost !== undefined) cost.waterDepthTexels += texels;
  }

  updateFrame(dt: number, alpha: number): void {
    if (this.bodies.length === 0) return;
    this.clock += dt;
    // Сток читается один раз на кадр (PERF-3): дальше только сложения в
    // захваченную переменную.
    const cost = costSink();
    // Бюджетная фаза сцены (REND-44) уже перезаполнила, сколько уместилось, и
    // остаток отложила осознанно; без фазы работа делается здесь целиком —
    // «не позже следующего кадра» (REND-35) держится и без сцены с бюджетом.
    let texels = 0;
    if (this.budgetedThisFrame) this.budgetedThisFrame = false;
    else texels = this.refill(UNLIMITED_FRAME_BUDGET);
    let sources = 0;
    let quads = 0;
    for (const body of this.bodies) {
      sources += body.updateFrame(this.clock, this.view, alpha, dt);
      quads += body.quads;
    }
    if (cost === undefined) return;
    cost.waterBodiesDrawn += this.bodies.length;
    cost.waterQuads += quads;
    cost.waterRippleSources += sources;
    cost.waterDepthTexels += texels;
  }

  /**
   * Перезаполнение помеченных тел под бюджетом (REND-44, REND-35). Выборка поля
   * берётся ТОЛЬКО когда есть что заполнять: устоявшаяся сцена не платит за
   * перезаполнение ничем, включая замыкание сэмплера (REND-26).
   *
   * Отложение считается один раз на проход, а не на тело: величина меряет
   * перерывы, а не длину очереди (design D7).
   */
  private refill(budget: FrameBudget): number {
    let texels = 0;
    let field: WaterFieldSampler | null = null;
    for (const body of this.bodies) {
      if (!body.needsRefill()) continue;
      // Выборка поля берётся ЛЕНИВО: устоявшаяся сцена не платит за неё вовсе.
      field ??= this.field();
      // Бюджет спрашивает САМО тело — порция здесь полоса клеток, а не тело
      // целиком (design D9); спроси мы его тут, гарантия прогресса бюджета
      // (первая порция прохода начинается всегда) тратилась бы на вопрос «можно
      // ли начать», и при малом потолке не заполнялось бы ни одной полосы.
      texels += body.flush(field, this.floor, budget);
      // Тело недозаполнено: бюджет кончился на его полосах.
      if (body.needsRefill()) {
        budget.defer();
        return texels;
      }
    }
    return texels;
  }

  /**
   * Сетка редактируемого документа целиком (REND-14, ED-10): карта воды
   * адресует её клетки, поэтому смена размеров арены пересобирает тела заново.
   * Правка уровней в пределах прежних размеров тел не двигает: их форму задаёт
   * карта, а глубину — поле, и об изменении поля подсистеме сообщает источник
   * поверхности (REND-9) — тем же каналом затронутых клеток, что и кисть
   * кривизны.
   */
  applyGrid(next: TerrainGrid): void {
    const previous = this.grid;
    this.grid = next;
    if (
      next.width === previous.width &&
      next.height === previous.height &&
      next.tileSize === previous.tileSize
    ) {
      // Пол документа возвращает мутацию превью (ED-9, TERR-6): сверяется с
      // СОБСТВЕННОЙ копией, как у террейна, — поэтому повторная подача той же
      // сетки не пустая операция.
      this.applyFloor(next.floor);
      // Сборка БЕЗ источника поверхности (REND-35): полем служит уровень
      // (REND-7), новые уровни уже читаются `field()`, а сказать телам о смене
      // поля некому — источника, который метит клетки, здесь нет. Глубина иначе
      // осталась бы от прежней арены до первой правки кривизны.
      if (this.surfaceSource === undefined) for (const body of this.bodies) body.markAll();
      return;
    }
    // Приём `tileSize` — вторая точка той же входной границы (REND-1, TERR-2).
    this.tile = next.tileSize / FIXED_ONE;
    this.floor = new Uint8Array(next.floor);
    // Причина «карта не ложится на сетку» названа размерами сетки: другая арена
    // — другой повод, и молчать о нём нельзя (REND-35).
    this.warned.clear();
    if (this.ctx !== null) this.build();
  }

  /**
   * Обновление секции в рантайме без пересборки рендера (`editor` ED-15):
   * подсистема переживает правку документа — старые меши и текстуры уходят,
   * новые встают их местом (REND-31).
   *
   * Секция, не изменившаяся с прошлой подачи, НЕ пересобирает ничего. Подают её
   * каждым грязным черновиком вьюпорта (правка декорации, мазок кисти), а
   * пересборка тела — это новые геометрия, `ShaderMaterial` и глубинная
   * текстура в десяток тысяч текселей: платить ими за чужую правку значило бы
   * складывать в кадр авторинга работу, которой в нём нет (ED-15, PERF-2).
   * Сравнение идёт каноническим текстом секции, а не ссылкой: документ
   * разбирается заново на каждую правку, и ссылка менялась бы всегда.
   */
  applyConfig(section?: PresentationWater): void {
    const signature = JSON.stringify(section ?? null);
    if (signature === this.signature) return;
    this.signature = signature;
    this.section = section;
    this.current = resolveWaterConfig(section);
    // Причины предупреждений привязаны к ПРЕЖНЕЙ секции: та же поломка после
    // правки обязана прозвучать заново, иначе автор, сломавший карту второй раз,
    // остаётся без воды и без единой строки о том, почему (REND-35).
    this.warned.clear();
    if (this.ctx === null) return;
    // Текстуры снятой секции отдаются GPU (REND-31): в редакторе секция
    // приезжает каждой правкой (ED-15), и автор, перебирающий ID карты нормалей,
    // иначе копил бы по текстуре на каждый набранный вариант до конца сессии.
    this.releaseTextures((id) => this.referenced(id));
    this.requestTextures();
    this.build();
  }

  /**
   * Ручки качества (QUAL-1, QUAL-3; design D7) — по рычагу на каждую ось
   * стоимости воды, и осей три:
   *
   * - число одновременных КОЛЕЦ ряби: каждое считается на КАЖДОМ фрагменте
   *   воды, и это самая дорогая часть фрагмента (REND-36); 0 выключает рябь;
   * - число слоёв детали: семплы нормалей либо октавы шума — линейный
   *   множитель фрагментной работы;
   * - плотность выборки глубины на клетку: тексели глубинной текстуры растут
   *   её КВАДРАТОМ, и платит за них перезаполнение поля (REND-35).
   */
  quality(): QualityDeclaration {
    return waterQualityDeclaration(this.name);
  }

  /**
   * Потолки пресета (QUAL-1): документ сцены не меняется — потолки живут в
   * подсистеме, а тела пересобираются событием смены пресета, а не кадром.
   * Смена потолка меняет `#define` материала и размер глубинной текстуры,
   * поэтому пересборка здесь полная и осознанная.
   */
  applyQuality(values: QualityValues): void {
    const next = {
      ripples: ceilingOf(values.get(WATER_RIPPLE_SOURCES)),
      layers: ceilingOf(values.get(WATER_DETAIL_LAYERS)),
      texels: ceilingOf(values.get(WATER_DEPTH_TEXELS_PER_CELL)),
    };
    if (
      next.ripples === this.ceilings.ripples &&
      next.layers === this.ceilings.layers &&
      next.texels === this.ceilings.texels
    ) {
      return;
    }
    this.ceilings = next;
    if (this.ctx === null || this.current === null) return;
    this.build();
  }

  /** Действующие потолки тела: `min(авторское, потолок)` и только он (QUAL-1). */
  limitsOf(body: WaterBodyConfig): WaterBodyLimits {
    return {
      rippleSources: clampCeiling(body.ripples.sources, this.ceilings.ripples, 0, MAX_RIPPLE_SOURCES),
      detailLayers: clampCeiling(body.detail.layers, this.ceilings.layers, 1, MAX_DETAIL_LAYERS),
      depthTexelsPerCell: clampCeiling(
        DEFAULT_WATER_DEPTH_TEXELS_PER_CELL,
        this.ceilings.texels,
        1,
        MAX_DEPTH_TEXELS_PER_CELL,
      ),
    };
  }

  /**
   * Поле высот для глубинной текстуры (REND-9): единый источник поверхности,
   * а без него — высота уровня (REND-7), как опорная высота REND-12.
   */
  private field(): WaterFieldSampler {
    const surface = this.surfaceSource?.current;
    if (surface === undefined || surface === null) {
      return levelFieldSampler(this.grid, this.heightStep);
    }
    return (wx, wy) => surface.heightAt(wx, wy);
  }

  /**
   * Пол сетки документа против собственной копии (TERR-6, ED-9): разошедшиеся
   * клетки метятся телам — под выбитой клеткой воды нет, а вернувшийся пол
   * возвращает и её.
   */
  private applyFloor(next: Uint8Array): void {
    const { width } = this.grid;
    for (let cell = 0; cell < next.length; cell++) {
      if (this.floor[cell] === next[cell]) continue;
      this.floor[cell] = next[cell]!;
      const x = cell % width;
      const y = Math.floor(cell / width);
      for (const body of this.bodies) body.markCell(x, y);
    }
  }

  /** Изменение поля (REND-9, REND-14): помеченные клетки — на перезаполнение. */
  private invalidate(cells: readonly number[] | null): void {
    if (this.bodies.length === 0) return;
    if (cells === null) {
      for (const body of this.bodies) body.markAll();
      return;
    }
    const { width } = this.grid;
    for (const cell of cells) {
      const x = cell % width;
      const y = Math.floor(cell / width);
      for (const body of this.bodies) body.markCell(x, y);
    }
  }

  /** Пересборка тел по действующей конфигурации и действующим потолкам. */
  private build(): void {
    this.clearBodies();
    const ctx = this.ctx;
    const config = this.current;
    if (ctx === null || config === null || !this.mapFitsGrid()) return;
    const regions = waterRegionsOf(config.cells, this.grid.width, this.grid.height, config.bodies.length);
    config.bodies.forEach((body, index) => {
      const region = regions[index]!;
      if (region.cells === 0) return;
      const view = new WaterBodyView({
        region,
        config: body,
        limits: this.limitsOf(body),
        tile: this.tile,
        heightStep: this.heightStep,
        gridWidth: this.grid.width,
        gridHeight: this.grid.height,
        ...this.detailTextures(body, index),
      });
      this.bodies.push(view);
      ctx.scene.add(view.mesh);
    });
  }

  /**
   * Ложится ли клеточная карта на сетку ЭТОЙ сцены (REND-35). Проверка идёт
   * ТЕМ ЖЕ валидатором, что и в редакторе (`validateWater`), только с сеткой на
   * руках: второй реализации правила «ряды по сетке» не заводится (ED-1,
   * CORE-3), а её вердикт здесь — предупреждение и сцена без воды, не отказ
   * кадра (по образцу карты кривизны не той сетки, ASSET-7).
   *
   * Нужна она затем, что валидация загрузчика ассета сетки не видит (ASSET-3), а
   * молча подогнать карту под сетку значило бы дополнить недостающие ряды
   * значением по умолчанию — ровно то, что REND-35 запрещает.
   */
  private mapFitsGrid(): boolean {
    const section = this.section;
    if (section === undefined) return true;
    const errors: string[] = [];
    validateWater(section, errors, { width: this.grid.width, height: this.grid.height });
    // Первая находка — и признак того, что секция не легла, и текст причины:
    // спросить длину, а потом ещё раз элемент, значило бы два вопроса об одном.
    const reason = errors[0];
    if (reason === undefined) return true;
    this.warnOnce(
      `grid:${this.grid.width}x${this.grid.height}`,
      `render: секция water не ложится на сетку террейна ${this.grid.width}×${this.grid.height}: ` +
        `${reason} — сцена рисуется без воды (REND-35)`,
    );
    return false;
  }

  /**
   * Текстуры детали тела (REND-35): `procedural` их не спрашивает вовсе — тело
   * без блока `detail` не обращается к модулю ассетов ни разу. У `textured`
   * недоступная или ещё не доехавшая карта означает procedural-деталь и
   * предупреждение с причиной, а не отказ кадра (по образцу LUT, REND-34).
   */
  private detailTextures(
    body: WaterBodyConfig,
    index: number,
  ): { detailNormal: THREE.Texture | null; detailFoam: THREE.Texture | null; detailFlow: THREE.Texture | null } {
    if (body.detail.source !== 'textured') {
      return { detailNormal: null, detailFoam: null, detailFlow: null };
    }
    const normal = this.textureOf(body.detail.normalMap);
    const foam = this.textureOf(body.detail.foamNoise);
    if (normal === null || foam === null) {
      // Ещё не доехавший ассет предупреждением НЕ является (ASSET-4): он
      // доедет и пересоберёт материал сам. Причину недоступного называет
      // подписка (`subscribeTexture`), а здесь остаётся авторская находка —
      // источник `textured` без ID, которого ждать неоткуда.
      if (body.detail.normalMap === null || body.detail.foamNoise === null) {
        this.warnOnce(
          `water:${index}`,
          `render: тело воды ${index}: источник детали "textured" не назвал normalMap либо foamNoise — деталь procedural (REND-35)`,
        );
      }
      return { detailNormal: null, detailFoam: null, detailFlow: null };
    }
    return { detailNormal: normal, detailFoam: foam, detailFlow: this.textureOf(body.detail.flowMap) };
  }

  private textureOf(id: string | null): THREE.Texture | null {
    return id === null ? null : (this.textures.get(id) ?? null);
  }

  /**
   * Запрос текстур детали (ASSET-2, ASSET-4). Спрашиваются только ID, названные
   * телами с источником `textured`: программная вода не трогает модуль ассетов
   * вовсе — это и есть «ноль текстурных ассетов» (REND-35).
   */
  private requestTextures(): void {
    const ctx = this.ctx;
    const config = this.current;
    if (ctx === null || config === null) return;
    for (const body of config.bodies) {
      if (body.detail.source !== 'textured') continue;
      for (const id of [body.detail.normalMap, body.detail.foamNoise, body.detail.flowMap]) {
        if (id === null || this.textures.has(id)) continue;
        this.textures.set(id, null);
        this.subscribeTexture(ctx, id);
      }
    }
  }

  /** Назван ли ID действующей секцией: снятый ассет держать незачем (REND-31). */
  private referenced(id: string): boolean {
    const config = this.current;
    if (config === null) return false;
    return config.bodies.some(
      (body) =>
        body.detail.source === 'textured' &&
        (body.detail.normalMap === id ||
          body.detail.foamNoise === id ||
          body.detail.flowMap === id),
    );
  }

  /**
   * Отпускает текстуры детали, которых `keep` не удержал: снимает подписку и
   * отдаёт саму текстуру GPU (REND-31). Снос подсистемы зовёт её с `keep`,
   * который не держит ничего.
   */
  private releaseTextures(keep: (id: string) => boolean): void {
    for (const id of [...this.textures.keys()]) {
      if (keep(id)) continue;
      this.unsubscribes.get(id)?.();
      this.unsubscribes.delete(id);
      this.textures.get(id)?.dispose();
      this.textures.delete(id);
    }
  }

  private subscribeTexture(ctx: RenderContext, id: string): void {
    const handle = ctx.assets.request<DecodedImage>('texture', id);
    this.unsubscribes.set(
      id,
      ctx.assets.subscribe(handle, (state: AssetState<DecodedImage>) => {
        if (state.status === 'failed') {
          this.warnOnce(id, `render: текстура детали воды "${id}" не загрузилась: ${state.reason} — деталь procedural (REND-35)`);
          return;
        }
        if (state.status !== 'ready' || this.textures.get(id) !== null) return;
        // Владелец текстуры — подсистема воды, а не модели (PERF-8): в эталоне
        // памяти деталь воды обязана стоять своей строкой.
        const texture = textureFromImage(state.data, 'normal', this.name);
        // Деталь воды тайлится по мировым координатам — иначе tileable-карта
        // размазалась бы на весь водоём одним экземпляром.
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        // Мип-цепочка и трилинейная выборка: под изометрией период детали
        // занимает десятки пикселей, и без мипов сотни текселей на пиксель
        // сворачиваются в искрящий шум (`DataTexture` по умолчанию берёт
        // ближайший тексель и мипов не строит). Анизотропия — плоскость воды
        // лежит под углом к взгляду, и изотропный мип размывал бы её вдоль
        // взгляда; величину рендерер сам зажимает потолком устройства.
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = WATER_DETAIL_ANISOTROPY;
        this.textures.set(id, texture);
        // Приезд текстуры меняет `#define` источника детали — материал тела
        // пересобирается событием, а не кадром (ED-15).
        this.build();
      }),
    );
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  private clearBodies(): void {
    const ctx = this.ctx;
    for (const body of this.bodies) {
      ctx?.scene.remove(body.mesh);
      body.dispose();
    }
    this.bodies.length = 0;
  }
}

/** Значение потолка из документа пресета; не число — потолка нет (QUAL-1). */
function ceilingOf(value: unknown): number {
  return typeof value === 'number' ? value : Number.POSITIVE_INFINITY;
}

/** Действующее значение: `min(авторское, потолок)`, зажатое в границы ручки. */
function clampCeiling(authored: number, ceiling: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Math.min(authored, ceiling))));
}
