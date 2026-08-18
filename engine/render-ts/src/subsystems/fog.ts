/**
 * Подсистема тумана войны (FOW-7, FOW-9, FOW-10) за контрактом REND-8: владеет
 * маской видимости, конфигурацией картинки и полноэкранным пост-проходом.
 *
 * ## Что она делает
 *
 * - На каждой доставке (`syncTick`) перестраивает маску видимости (design D1):
 *   наблюдатели СВОЕЙ команды берутся из доставленного состояния по именам
 *   статов (design D4, HUD-8) — радиус обзора и команда; команду игрока задаёт
 *   стат его героя. Видимые враги несут те же статы, и их круги в маску не
 *   попадают: фильтр по команде обязателен.
 * - Кадр рисует пост-проходом (design D2): сцена уходит в render target, затем
 *   полноэкранный шейдер по глубине и обратной view-projection восстанавливает
 *   мировые XY фрагмента, сэмплирует маску и затемняет силой/цветом из
 *   конфигурации (FOW-7, FOW-10). Юнитов в туманной зоне нет по построению —
 *   их вырезал фильтр снапшота (NET-12), и прятать рендеру некого.
 * - Пока маска не построена (нет доставки со статами) — конвейер прежний:
 *   `render` делает ровно прямой рендер, ни одного лишнего прохода. Сцена без
 *   тумана эту подсистему просто не регистрирует (design D3).
 *
 * Чужих материалов подсистема не трогает (REND-8): пост-проход читает готовый
 * кадр, и террейн, модели, эффекты о тумане не знают. Picking и зеркало пола
 * живут своими проходами и маски не видят (design Risks).
 *
 * ## Конфигурация — данные (FOW-10)
 *
 * Значения приходят секцией `fog` парного presentation-документа (PRES-2);
 * отсутствие секции или поля — документированные значения по умолчанию
 * (`DEFAULT_FOG_CONFIG` ниже). Обновление в рантайме — `applyConfig`: значения
 * применяются без пересоздания подсистемы и рендера; смена разрешения
 * пересобирает только растр маски.
 *
 * Регистрирует подсистему сборка игрового клиента; вьюпорт редактора — нет
 * (design D3): превью тумана в редакторе — отдельная будущая работа.
 */
import * as THREE from 'three';
import type { EntityId, TerrainGrid } from '@game-mvp/core';
import type { PresentationFog } from '@game-mvp/assets';
import type {
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  TickView,
} from '../types.js';
import { costSink } from '../cost.js';
import {
  VisibilityMask,
  fogRectOf,
  fogSegmentsOf,
  type FogSegment,
  type FogWorldRect,
} from '../fog/mask.js';

/**
 * Действующая конфигурация рендера тумана — секция `fog` с закрытыми дырами.
 * Значения по умолчанию (FOW-10) документированы у полей `DEFAULT_FOG_CONFIG`.
 */
export interface FogRenderConfig {
  /** Сила затемнения зоны вне видимости, [0, 1] (FOW-7). */
  readonly strength: number;
  /** Тон тумана — во что затемняется кадр. */
  readonly color: string;
  /** Ширина градиента края видимой области, мировые единицы (FOW-7). */
  readonly edgeWidth: number;
  /** Коэффициент консервативности reveal-радиуса, (0, 1] (FOW-9). */
  readonly conservatism: number;
  /** Разрешение маски — текселей на мировую единицу (FOW-10). */
  readonly resolution: number;
  /** Длительность fade-out «ушла в туман» в секундах (FOW-8, design D7). */
  readonly fadeSeconds: number;
}

/**
 * Документированные значения по умолчанию (FOW-10): туман работает и без
 * секции `fog`. Подобраны на глаз по демо-арене (design Open Questions) —
 * политика картинки, которую дизайнер правит данными, а не этим файлом.
 */
export const DEFAULT_FOG_CONFIG: FogRenderConfig = Object.freeze({
  strength: 0.6,
  color: '#0e1420',
  edgeWidth: 1.5,
  conservatism: 0.92,
  resolution: 4,
  fadeSeconds: 0.4,
});

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1, FOW-10): разрешение маски
 * — ПОТОЛОК над сценным значением, а не значение вместо него (design D3).
 * Действующее разрешение = min(сценного, потолка): пресет вправе удешевить
 * картинку, но не поднять её выше авторской и не тронуть документ сцены.
 *
 * Верхняя граница диапазона — та же, что у здравого смысла авторского значения:
 * маска строится на CPU каждой доставкой, и её стоимость растёт КВАДРАТОМ
 * разрешения (обнуление, reveal, загрузка в текстуру, блит миникарты).
 */
const FOG_MASK_RESOLUTION = 'fog.maskResolution';

/** Секция документа поверх умолчаний: отсутствующее поле — умолчание (FOW-10). */
export function resolveFogConfig(section?: PresentationFog): FogRenderConfig {
  return {
    strength: section?.strength ?? DEFAULT_FOG_CONFIG.strength,
    color: section?.color ?? DEFAULT_FOG_CONFIG.color,
    edgeWidth: section?.edgeWidth ?? DEFAULT_FOG_CONFIG.edgeWidth,
    conservatism: section?.conservatism ?? DEFAULT_FOG_CONFIG.conservatism,
    resolution: section?.resolution ?? DEFAULT_FOG_CONFIG.resolution,
    fadeSeconds: section?.fadeSeconds ?? DEFAULT_FOG_CONFIG.fadeSeconds,
  };
}

/** Имена статов доставки (HUD-8, design D4): радиус обзора и команда сущности. */
export interface FogStatNames {
  readonly visionRadius: string;
  readonly team: string;
}

/**
 * Слой тумана для миникарты (HUD-6, design D6): стабильный объект «канвас +
 * прямоугольник мира + сила затемнения». Канвас перерисовывается на месте,
 * объект не пересоздаётся — виджет вправе держать ссылку.
 */
export interface FogMinimapLayer {
  readonly canvas: unknown;
  readonly world: FogWorldRect;
  readonly strength: number;
}

/** 2D-поверхность слоя миникарты — структурный минимум `HTMLCanvasElement`. */
export interface FogLayerCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): FogLayerContext | null;
}

/** Структурный минимум контекста: блит ImageData, ничего больше. */
export interface FogLayerContext {
  createImageData(width: number, height: number): {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  };
  putImageData(image: unknown, dx: number, dy: number): void;
}

/**
 * Рендерер глазами пост-прохода — структурный минимум `THREE.WebGLRenderer`:
 * подсистема не требует живого WebGL в тестах, а в сборке это он и есть.
 */
export interface FogRendererLike {
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
}

export interface FogSubsystemOptions {
  /** Сетка террейна сцены — прямоугольник маски и cliff-отрезки (TERR-5, FOW-9). */
  readonly grid: TerrainGrid;
  /** Имена статов доставки (design D4): их объявляет конфигурация сборки воркера. */
  readonly stats: FogStatNames;
  /**
   * Сущность героя игрока — из неё читается команда, чьи наблюдатели открывают
   * маску (design D4). Функция, а не значение: ID приезжает handshake'ом позже
   * сборки подсистем.
   */
  readonly hero: () => EntityId | null;
  /** Секция `fog` парного документа (PRES-2); нет — умолчания (FOW-10). */
  readonly config?: PresentationFog;
  /**
   * Фабрика канваса слоя миникарты (design D6) — её приносит сборка (в
   * браузере — `document.createElement('canvas')`): пакет рендера DOM не
   * трогает. Без фабрики слоя миникарты нет; маска и пост-проход работают.
   */
  readonly createCanvas?: (width: number, height: number) => FogLayerCanvas;
}

/** Полноэкранный треугольник не нужен: квад 2×2 в NDC, вершины насквозь. */
const POST_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Реконструкция мировых XY по глубине и обратной view-projection (design D2):
 * фрагмент вне прямоугольника маски — туман (консервативность FOW-9 действует
 * и на края арены). Билинейный сэмпл маски сглаживает артефакты реконструкции
 * на кромках геометрии (design Risks).
 */
const POST_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tMask;
uniform mat4 uInvViewProj;
uniform vec4 uMaskRect;
uniform float uStrength;
uniform vec3 uColor;
void main() {
  vec4 scene = texture2D(tScene, vUv);
  float depth = texture2D(tDepth, vUv).x;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  vec2 xy = world.xy / world.w;
  vec2 uv = (xy - uMaskRect.xy) / uMaskRect.zw;
  float lit = 0.0;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    lit = texture2D(tMask, uv).r;
  }
  gl_FragColor = vec4(mix(scene.rgb, uColor, uStrength * (1.0 - lit)), scene.a);
}
`;

export class FogSubsystem implements RenderSubsystem {
  readonly name = 'fog';

  private readonly grid: TerrainGrid;
  private readonly statNames: FogStatNames;
  private readonly heroOf: () => EntityId | null;
  private readonly createCanvas: ((width: number, height: number) => FogLayerCanvas) | null;

  /**
   * Секция `fog` документа сцены как есть (PRES-2) — АВТОРСКИЙ источник. Она
   * здесь только читается: пресет качества документ не правит ни байтом
   * (FOW-10, QUAL-1), а `current` ниже — уже действующая конфигурация.
   */
  private section: PresentationFog | undefined;
  /**
   * Потолок разрешения маски от пресета качества (QUAL-1, design D3);
   * бесконечность — потолка нет, действует сценное значение.
   */
  private ceiling = Number.POSITIVE_INFINITY;
  private current: FogRenderConfig;
  private ctx: RenderContext | null = null;
  private rect: FogWorldRect;
  private segments: readonly FogSegment[];
  private mask: VisibilityMask;
  /** Маска построена хотя бы раз: до этого конвейер прежний (прямой рендер). */
  private built = false;

  // ------------------------------------------------------------ пост-проход
  private maskTexture: THREE.DataTexture;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly postScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postMaterial: THREE.ShaderMaterial;
  private readonly sizeScratch = new THREE.Vector2();

  // --------------------------------------------------------- слой миникарты
  private layerCanvas: FogLayerCanvas | null = null;
  private layerImage: ReturnType<FogLayerContext['createImageData']> | null = null;
  private readonly layerWorld: FogWorldRect;
  private readonly layer: FogMinimapLayer;

  constructor(options: FogSubsystemOptions) {
    this.grid = options.grid;
    this.statNames = options.stats;
    this.heroOf = options.hero;
    // Фабрику канваса приносит сборка (в браузере — `document.createElement`):
    // пакет рендера DOM не трогает, и слой миникарты без фабрики просто не
    // существует — маска и пост-проход от этого не зависят.
    this.createCanvas = options.createCanvas ?? null;
    this.section = options.config;
    this.current = this.effective();
    // Приём сетки — точка входной границы (REND-1, TERR-2): дальше только float.
    this.rect = fogRectOf(this.grid);
    this.segments = fogSegmentsOf(this.grid);
    this.mask = new VisibilityMask(this.rect, this.current.resolution);
    this.maskTexture = createMaskTexture(this.mask);
    this.layerWorld = this.rect;

    this.postMaterial = new THREE.ShaderMaterial({
      vertexShader: POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        tMask: { value: this.maskTexture },
        uInvViewProj: { value: new THREE.Matrix4() },
        uMaskRect: {
          value: new THREE.Vector4(this.rect.x, this.rect.y, this.rect.width, this.rect.height),
        },
        uStrength: { value: this.current.strength },
        uColor: { value: new THREE.Color(this.current.color) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    // Стабильный объект слоя миникарты (design D6): канвас и сила читаются
    // геттерами — правка конфига (FOW-10) видна виджету без пересоздания
    // объекта. Стрелки захватывают this подсистемы лексически.
    const canvasOf = (): unknown => this.layerCanvas;
    const strengthOf = (): number => this.current.strength;
    this.layer = {
      get canvas(): unknown {
        return canvasOf();
      },
      world: this.layerWorld,
      get strength(): number {
        return strengthOf();
      },
    };
  }

  /** Действующая конфигурация — её же читают потребители fade (FOW-8) и миникарты. */
  get config(): FogRenderConfig {
    return this.current;
  }

  /**
   * Слой тумана миникарты (HUD-6, design D6); null — маска ещё не построена
   * либо канвасу неоткуда взяться (нет DOM и фабрики). Объект стабилен.
   */
  get fog(): FogMinimapLayer | null {
    return this.built && this.layerCanvas !== null ? this.layer : null;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
  }

  /**
   * Перестройка маски на каденсе доставки (design D1): наблюдатели своей
   * команды из доставленного состояния по именам статов. Пока команда игрока
   * не доставлена (нет героя или его статов), прежняя маска остаётся как есть —
   * консервативнее мигания «всё открыто/всё закрыто».
   */
  syncTick(view: TickView): void {
    const hero = this.heroOf();
    if (hero === null) return;
    const team = view.entities.get(hero)?.stats?.get(this.statNames.team);
    if (team === undefined) return;

    // Отбор наблюдателей просматривает всё доставленное состояние — стоимость
    // перестройки растёт и от числа сущностей, не только от маски (PERF-3).
    const cost = costSink();
    if (cost !== undefined) cost.fogEntitiesScanned += view.entities.size;

    this.mask.clear();
    for (const entity of view.entities.values()) {
      const stats = entity.stats;
      if (stats === undefined) continue;
      // Фильтр по команде обязателен (design D4): у видимого врага тоже есть
      // Vision, но его круг маску игрока открывать не должен.
      if (stats.get(this.statNames.team) !== team) continue;
      const radius = stats.get(this.statNames.visionRadius);
      if (radius === undefined || radius <= 0) continue;
      // Радиус статов уже во float мировых единицах (REND-1, `statSources.ts`);
      // визуал консервативнее геймплея на коэффициент конфига (FOW-9).
      this.mask.reveal(
        { x: entity.currX, y: entity.currY, radius: radius * this.current.conservatism },
        this.current.edgeWidth,
        this.segments,
      );
    }
    this.built = true;
    this.maskTexture.needsUpdate = true;
    // Байт на тексель (RedFormat, UnsignedByteType): весь растр уезжает в
    // текстуру на каждой доставке — цена разрешения маски, а не наблюдателей.
    // Точка счёта ОДНА на загрузку и живёт здесь, у поднятого флага версии:
    // создание текстуры (`createMaskTexture`) своего трафика не имеет — три
    // сливает его флаг с этим в одну загрузку.
    if (cost !== undefined) cost.fogMaskUploadBytes += this.mask.data.length;
    this.blitLayer();
  }

  updateFrame(): void {
    // Маска живёт каденсом доставки, пост-проход — вызовом render: кадру здесь
    // делать нечего.
  }

  /**
   * Ручки качества подсистемы (QUAL-1, QUAL-3): одна — потолок разрешения
   * маски. Стоимость перестройки растёт квадратом разрешения и линейно числом
   * доставленных сущностей, поэтому рычаг здесь обязателен: именно на нём
   * споткнулась правка 4 → 8 (proposal «Why»).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: FOG_MASK_RESOLUTION,
          cost: 'тексели маски видимости: обнуление, reveal, загрузка в текстуру и блит миникарты растут квадратом разрешения (FOW-7, FOW-10)',
          semantics: 'ceiling',
          // Потолка нет — действует сценное значение (FOW-10, design D3).
          default: Number.POSITIVE_INFINITY,
          min: 0.5,
          max: 32,
        },
      ],
    };
  }

  /**
   * Потолок разрешения от пресета (QUAL-1, FOW-10). Документ сцены не меняется:
   * потолок живёт в подсистеме, а действующее значение считается заново.
   * Консервативность reveal (FOW-9) от разрешения не зависит — коэффициент
   * применяется к радиусу наблюдателя, а грубая маска ошибается в ту же
   * сторону: показать лишний туман можно, скрыть его — нет.
   */
  applyQuality(values: QualityValues): void {
    const ceiling = values.get(FOG_MASK_RESOLUTION);
    this.ceiling = typeof ceiling === 'number' ? ceiling : Number.POSITIVE_INFINITY;
    this.applyResolved(this.effective());
  }

  /**
   * Действующая конфигурация = авторская секция, ограниченная сверху потолком
   * пресета (design D3): `min` — и только он. Потолок ВЫШЕ сценного значения
   * картинку не улучшает: авторский потолок остаётся авторским (FOW-10).
   */
  private effective(): FogRenderConfig {
    const authored = resolveFogConfig(this.section);
    const resolution = Math.min(authored.resolution, this.ceiling);
    return resolution === authored.resolution ? authored : { ...authored, resolution };
  }

  /**
   * Обновление конфигурации в рантайме (FOW-10): значения применяются на живой
   * подсистеме — униформы пост-прохода правятся на месте, смена разрешения
   * пересобирает только растр маски. Пересоздания подсистемы или рендера нет.
   */
  applyConfig(section?: PresentationFog): void {
    this.section = section;
    this.applyResolved(this.effective());
  }

  /** Общий шов применения: и правка секции автором, и потолок пресета — сюда. */
  private applyResolved(next: FogRenderConfig): void {
    const previous = this.current;
    this.current = next;
    (this.postMaterial.uniforms.uStrength as { value: number }).value = next.strength;
    (this.postMaterial.uniforms.uColor as { value: THREE.Color }).value.set(next.color);
    if (next.resolution !== previous.resolution) {
      this.mask = new VisibilityMask(this.rect, next.resolution);
      this.maskTexture.dispose();
      this.maskTexture = createMaskTexture(this.mask);
      (this.postMaterial.uniforms.tMask as { value: THREE.Texture }).value = this.maskTexture;
      // Прежний растр другого разрешения не переносится: маска перестроится
      // ближайшей доставкой, а до неё прежняя картинка честнее растянутой.
      this.built = false;
      this.layerImage = null;
      this.layerCanvas = null;
    }
    // Смена ширины градиента/консервативности доедет ближайшей перестройкой
    // маски; длительность fade читают потребители через `config` (design D7).
  }

  /**
   * Кадр с туманом (design D2): сцена в render target, затем полноэкранный
   * проход затемнения. Пока маска не построена — ровно прямой рендер, без
   * единого лишнего прохода: сцена без активного тумана рисуется по-старому.
   */
  render(renderer: FogRendererLike, camera: THREE.Camera): void {
    const ctx = this.ctx;
    if (ctx === null) throw new Error('FogSubsystem: init() не вызван (REND-8)');
    // Проходы рендерера — стадия кадра (PERF-2): их число подсистема знает
    // сама, и структурный спай теста обязан видеть ровно столько же.
    const cost = costSink();
    if (!this.built) {
      renderer.render(ctx.scene, camera);
      if (cost !== undefined) cost.fogRenderPasses++;
      return;
    }
    const size = renderer.getDrawingBufferSize(this.sizeScratch);
    const target = this.ensureTarget(size.x, size.y);
    renderer.setRenderTarget(target);
    renderer.render(ctx.scene, camera);
    renderer.setRenderTarget(null);

    camera.updateMatrixWorld();
    (this.postMaterial.uniforms.uInvViewProj as { value: THREE.Matrix4 }).value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    (this.postMaterial.uniforms.tScene as { value: THREE.Texture | null }).value = target.texture;
    (this.postMaterial.uniforms.tDepth as { value: THREE.Texture | null }).value =
      target.depthTexture;
    renderer.render(this.postScene, this.postCamera);
    if (cost !== undefined) cost.fogRenderPasses += 2;
  }

  /** Render target кадра с текстурой глубины; пересоздаётся при смене размера окна. */
  private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.target !== null && this.target.width === w && this.target.height === h) {
      return this.target;
    }
    this.target?.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    this.target = new THREE.WebGLRenderTarget(w, h, { depthTexture, depthBuffer: true });
    return this.target;
  }

  /**
   * Блит маски в канвас слоя миникарты (design D6): пиксель — тон тумана с
   * альфой `1 − свет`; силу затемнения виджет применяет сам из того же конфига
   * (HUD-6). Ряды перевёрнуты: у растра ряд 0 — минимальный `y` мира, у канваса
   * — верхняя строка, а миникарта рисует мир `+Y` вверх.
   */
  private blitLayer(): void {
    if (this.createCanvas === null) return;
    const mask = this.mask;
    if (this.layerCanvas === null) {
      this.layerCanvas = this.createCanvas(mask.width, mask.height);
      this.layerImage = null;
    }
    const context = this.layerCanvas.getContext('2d');
    if (context === null) return;
    this.layerImage ??= context.createImageData(mask.width, mask.height);
    const image = this.layerImage;
    // Блит идёт по всему растру: та же квадратичная зависимость от разрешения,
    // что у обнуления и загрузки, но в главном потоке и попиксельно (PERF-3).
    const cost = costSink();
    if (cost !== undefined) cost.fogMinimapTexels += mask.width * mask.height;
    const color = new THREE.Color(this.current.color);
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    for (let row = 0; row < mask.height; row++) {
      const source = (mask.height - 1 - row) * mask.width;
      const dest = row * mask.width * 4;
      for (let column = 0; column < mask.width; column++) {
        const at = dest + column * 4;
        image.data[at] = r;
        image.data[at + 1] = g;
        image.data[at + 2] = b;
        image.data[at + 3] = 255 - mask.data[source + column]!;
      }
    }
    context.putImageData(image, 0, 0);
  }

  /** Растр маски — для тестов геометрии; потребители картинки ходят не сюда. */
  get visibility(): VisibilityMask {
    return this.mask;
  }
}

/** Одноканальная текстура поверх растра маски; фильтрация билинейная (design D2). */
function createMaskTexture(mask: VisibilityMask): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    mask.data,
    mask.width,
    mask.height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Однобайтовые ряды: без выравнивания в 1 байт ряд шириной не кратной 4
  // читался бы со сдвигом (правило распаковки GL, дефолт — 4).
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  // Счётчика здесь нет намеренно (PERF-3). Создание текстуры трафика не
  // порождает: three грузит растр на GPU по ВЕРСИИ, поднятой `needsUpdate`, и
  // взведённый здесь флаг сливается с флагом ближайшей доставки в одну
  // загрузку. Считать её дважды — приписать пустой байт: и на первой доставке,
  // и на смене разрешения (там маска пересобирается и `built` сбрасывается)
  // счёт снимает единственное место — `syncTick`, у самой загрузки.
  return texture;
}
