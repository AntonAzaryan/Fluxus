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
  WATER_MAX_RIPPLE_SOURCES,
  validateWater,
  type AssetState,
  type DecodedImage,
  type PresentationWater,
} from '@fluxus/assets';
import { costSink } from '../cost.js';
import { textureFromImage } from '../model/skins.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type {
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  TickView,
} from '../types.js';
import { WaterBodyView, type WaterBodyLimits } from '../water/body.js';
import {
  DEFAULT_WATER_DEPTH_TEXELS_PER_CELL,
  resolveWaterConfig,
  type WaterBodyConfig,
  type WaterRenderConfig,
} from '../water/config.js';
import { levelFieldSampler, type WaterFieldSampler } from '../water/depth.js';
import { waterRegionsOf } from '../water/region.js';

/**
 * Ручки качества подсистемы (`render-quality` QUAL-1, QUAL-3; design D7) — все
 * три ПОТОЛКИ с семантикой `min(авторское, потолок)`: пресет вправе удешевить
 * воду, но MUST NOT поднять её выше авторской и MUST NOT тронуть документ сцены.
 */
export const WATER_RIPPLE_SOURCES = 'water.rippleSources';
export const WATER_DETAIL_LAYERS = 'water.detailLayers';
export const WATER_DEPTH_TEXELS_PER_CELL = 'water.depthTexelsPerCell';

/**
 * Верхняя граница потолка источников — предел uniform-векторов (REND-36, D5).
 * Число берётся у формата секции (`@fluxus/assets`), а не набирается здесь
 * заново: тем же числом валидация ограничивает АВТОРСКОЕ значение, и разойдись
 * они — потолок пресета и предел документа стали бы двумя разными правилами.
 */
const MAX_RIPPLE_SOURCES = WATER_MAX_RIPPLE_SOURCES;
/** Выше четырёх слоёв деталь перестаёт читаться, а фрагмент дорожает линейно. */
const MAX_DETAIL_LAYERS = 4;
/** Шестнадцать текселей на клетку — предел, за которым берег уже не уточняется. */
const MAX_DEPTH_TEXELS_PER_CELL = 16;

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
    this.surfaceSource?.onChange((cells) => {
      this.invalidate(cells);
    });
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
  }

  /**
   * Доставленное состояние (REND-8): вода читает из него только источники ряби
   * (REND-36) — интерполированные позиции движущихся сущностей. Разрыв
   * непрерывности мира (REND-2) сбрасывает накопленные кольца.
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (!view.snapAll) return;
    for (const body of this.bodies) body.resetRipples();
  }

  /**
   * Кадр (REND-2, REND-25): перезаполнение помеченных глубинных текстур, часы
   * презентации и источники ряби. Сцена без воды не платит ничем — счётчики
   * остаются нулевыми (PERF-2).
   */
  updateFrame(dt: number, alpha: number): void {
    if (this.bodies.length === 0) return;
    this.clock += dt;
    // Сток читается один раз на кадр (PERF-3): дальше только сложения в
    // захваченную переменную.
    const cost = costSink();
    const field = this.field();
    let texels = 0;
    let sources = 0;
    let quads = 0;
    for (const body of this.bodies) {
      texels += body.flush(field);
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
      return;
    }
    // Приём `tileSize` — вторая точка той же входной границы (REND-1, TERR-2).
    this.tile = next.tileSize / FIXED_ONE;
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
   * - число одновременных источников ряби: каждый считается на КАЖДОМ фрагменте
   *   воды, и это самая дорогая часть фрагмента (REND-36); 0 выключает рябь;
   * - число слоёв детали: семплы нормалей либо октавы шума — линейный
   *   множитель фрагментной работы;
   * - плотность выборки глубины на клетку: тексели глубинной текстуры растут
   *   её КВАДРАТОМ, и платит за них перезаполнение поля (REND-35).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: WATER_RIPPLE_SOURCES,
          cost: 'источники ряби: каждое кольцо считается на каждом фрагменте воды (REND-36)',
          semantics: 'ceiling',
          default: Number.POSITIVE_INFINITY,
          min: 0,
          max: MAX_RIPPLE_SOURCES,
        },
        {
          name: WATER_DETAIL_LAYERS,
          cost: 'слои детали поверхности: семплы карты нормалей либо октавы шума на фрагмент (REND-35)',
          semantics: 'ceiling',
          default: Number.POSITIVE_INFINITY,
          min: 1,
          max: MAX_DETAIL_LAYERS,
        },
        {
          name: WATER_DEPTH_TEXELS_PER_CELL,
          cost: 'тексели глубинных текстур тел: работа перезаполнения растёт квадратом плотности (REND-35)',
          semantics: 'ceiling',
          default: Number.POSITIVE_INFINITY,
          min: 1,
          max: MAX_DEPTH_TEXELS_PER_CELL,
        },
      ],
    };
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
    if (errors.length === 0) return true;
    this.warnOnce(
      `grid:${this.grid.width}x${this.grid.height}`,
      `render: секция water не ложится на сетку террейна ${this.grid.width}×${this.grid.height}: ` +
        `${errors[0]} — сцена рисуется без воды (REND-35)`,
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
        const texture = textureFromImage(state.data, 'normal');
        // Деталь воды тайлится по мировым координатам — иначе tileable-карта
        // размазалась бы на весь водоём одним экземпляром.
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
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
