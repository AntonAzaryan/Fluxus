/**
 * Подсистема тумана войны (FOW-7, FOW-9, FOW-10) за контрактом REND-8: владеет
 * маской видимости, конфигурацией картинки и полноэкранным пост-проходом.
 *
 * ## Что она делает
 *
 * - На доставке (`syncTick`) перестраивает маску видимости (design D1):
 *   наблюдатели СВОЕЙ команды берутся из доставленного состояния по именам
 *   статов (design D4, HUD-8) — радиус обзора и команда; команду игрока задаёт
 *   стат его героя. Видимые враги несут те же статы, и их круги в маску не
 *   попадают: фильтр по команде обязателен. Перестройка — только при изменении
 *   сигнатуры входов (design D4 change `fow-directional-cliff-vision`):
 *   наблюдатели (позиция, радиус, уровень) в порядке доставки плюс значения
 *   конфига; совпала — ни растра, ни загрузки текстуры, ни блита миникарты.
 *   Уровень наблюдателя — доставленный `EntityView.currLevel` (TERR-4):
 *   тени маски направленные (FOW-9, PHYS-13).
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
 * (`fog/config.ts`: `DEFAULT_FOG_CONFIG`, `resolveFogConfig`). Обновление в
 * рантайме — `applyConfig`: значения применяются без пересоздания подсистемы и
 * рендера; смена разрешения пересобирает только растр маски.
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
import { costSink, type RenderCostCounters } from '../cost.js';
import type { DebugSource } from '../debug/contract.js';
import { fogMaskDebugSource } from '../debug/fogSource.js';
import { resolveFogConfig, type FogRenderConfig } from '../fog/config.js';
import { POST_FRAGMENT, POST_VERTEX } from '../fog/postPass.js';
import { FogMinimapSurface, type FogLayerCanvas, type FogMinimapLayer } from '../fog/layer.js';
import {
  VisibilityMask,
  fogRectOf,
  fogSegmentsOf,
  type FogSegment,
  type FogWorldRect,
} from '../fog/mask.js';

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

/** Имена статов доставки (HUD-8, design D4): радиус обзора и команда сущности. */
export interface FogStatNames {
  readonly visionRadius: string;
  readonly team: string;
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

/**
 * Слоты конфига в голове сигнатуры входов (design D4): ширина градиента и тон
 * тумана; дальше — по четыре числа на наблюдателя в порядке доставки.
 */
const SIGNATURE_PREFIX = 2;

/** Совпадение занятых префиксов двух сигнатур — сравнение чисел, не JSON (D4). */
function samePrefix(a: Float64Array, b: Float64Array, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class FogSubsystem implements RenderSubsystem {
  readonly name = 'fog';

  private readonly grid: TerrainGrid;
  private readonly statNames: FogStatNames;
  private readonly heroOf: () => EntityId | null;

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
  /**
   * Показанная маска — то, что сэмплируют пост-проход и миникарта. Сходится к
   * целевой `mask.data` со временем `dissolveSeconds`: рассеивание тумана не
   * мгновенное (FOW-7). Именно этот буфер обёрнут текстурой.
   */
  private shown: Uint8Array;
  /** Показанная маска ещё догоняет целевую: `updateFrame` ведёт сходимость. */
  private settling = false;
  /** Маска построена хотя бы раз: до этого конвейер прежний (прямой рендер). */
  private built = false;

  // ------------------------------------------- сигнатура входов (design D4)
  /**
   * Сигнатура входов последней перестройки: значения конфига, влияющие на
   * растр и блит, затем наблюдатели в порядке доставки — по четыре числа
   * (x, y, эффективный радиус, уровень). Числа в переиспользуемом массиве,
   * а не JSON: сравнение — дешёвый проход по префиксу длиной `signatureLength`.
   */
  private signature: Float64Array = new Float64Array(SIGNATURE_PREFIX + 4 * 8);
  /** Буфер сборки сигнатуры текущей доставки; при перестройке копируется в `signature`. */
  private candidate: Float64Array = new Float64Array(SIGNATURE_PREFIX + 4 * 8);
  /** Длина занятого префикса; −1 — сигнатуры нет, ближайшая доставка строит. */
  private signatureLength = -1;
  /** Счётчик перестроек — дешёвый пробник для тестов кэша (design D4). */
  private rebuildCount = 0;
  /** Тон тумана числом — слот сигнатуры: блит миникарты вбивает его в канвас. */
  private colorHex: number;
  /** Буфер наблюдателя для `reveal`: перестройка не аллоцирует по объекту. */
  private readonly observerScratch = { x: 0, y: 0, radius: 0, level: 0 };

  // ------------------------------------------------------------ пост-проход
  private maskTexture: THREE.DataTexture;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly postScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postMaterial: THREE.ShaderMaterial;
  /** Полноэкранный квад пост-прохода: своя геометрия, отдаётся на сносе (REND-31). */
  private postQuad: THREE.Mesh | null = null;
  private readonly sizeScratch = new THREE.Vector2();

  /** Слой миникарты (HUD-6, design D6): канвас, буфер пикселей и блит растра. */
  private readonly minimap: FogMinimapSurface;

  constructor(options: FogSubsystemOptions) {
    this.grid = options.grid;
    this.statNames = options.stats;
    this.heroOf = options.hero;
    // Авторская секция хранится как есть (FOW-10, QUAL-1): действующая
    // конфигурация — уже под потолком пресета, если он приехал.
    this.section = options.config;
    this.current = this.effective();
    this.colorHex = new THREE.Color(this.current.color).getHex();
    // Приём сетки — точка входной границы (REND-1, TERR-2): дальше только float.
    this.rect = fogRectOf(this.grid);
    this.segments = fogSegmentsOf(this.grid);
    this.mask = new VisibilityMask(this.rect, this.current.resolution);
    this.shown = new Uint8Array(this.mask.data.length);
    this.maskTexture = createMaskTexture(this.mask, this.shown);
    // Фабрику канваса приносит сборка (в браузере — `document.createElement`):
    // пакет рендера DOM не трогает, и слой миникарты без фабрики просто не
    // существует — маска и пост-проход от этого не зависят.
    this.minimap = new FogMinimapSurface(this.rect, () => this.current.strength, options.createCanvas);

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
        uMaskTexel: { value: new THREE.Vector2(1 / this.mask.width, 1 / this.mask.height) },
        uStrength: { value: this.current.strength },
        uColor: { value: new THREE.Color(this.current.color) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);
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
    return this.built && this.minimap.ready ? this.minimap.layer : null;
  }

  /**
   * Объекты финального прохода (FOW-7) — вход тестов и диагностики: сцена с
   * единственным полноэкранным квадом, растровая текстура маски и промежуточная
   * цель кадра (null — кадра ещё не было). После сноса (REND-31) не остаётся
   * ни одного из них живым.
   */
  get postPass(): {
    readonly scene: THREE.Scene;
    readonly mask: THREE.DataTexture;
    readonly target: THREE.WebGLRenderTarget | null;
  } {
    return { scene: this.postScene, mask: this.maskTexture, target: this.target };
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
  }

  /**
   * Снос подсистемы (REND-31): всё, что она положила в GPU, — растр маски,
   * промежуточная цель кадра с её текстурой глубины, материал пост-прохода и
   * геометрия его полноэкранного квада (FOW-7). Сцена подсистеме не
   * принадлежит: рисует она в чужую, а своя у неё одна — `postScene`.
   */
  dispose(): void {
    this.maskTexture.dispose();
    this.target?.dispose();
    this.target = null;
    this.postMaterial.dispose();
    this.postQuad?.geometry.dispose();
    this.postQuad?.removeFromParent();
    this.postQuad = null;
    // Растр маски больше не показывается ничем: канвас слоя миникарты (HUD-6)
    // принесла сборка и отпускает его она же.
    this.minimap.reset();
    this.built = false;
  }

  /**
   * Перестройка маски на каденсе доставки (design D1): наблюдатели своей
   * команды из доставленного состояния по именам статов. Пока команда игрока
   * не доставлена (нет героя или его статов), прежняя маска остаётся как есть —
   * консервативнее мигания «всё открыто/всё закрыто».
   *
   * Перестройка — только при изменении входов (design D4): сигнатура доставки
   * собирается в числа кандидата и сравнивается с сигнатурой последней
   * перестройки. Совпала — маска, текстура и слой миникарты не трогаются:
   * стоя на месте, кадр не платит за туман ничего. Отрезки в сигнатуру не
   * входят: их набор фиксируется конструктором и не меняется за жизнь
   * подсистемы, а смена разрешения инвалидирует сигнатуру явно (`applyConfig`).
   */
  syncTick(view: TickView): void {
    const hero = this.heroOf();
    if (hero === null) return;
    const team = view.entities.get(hero)?.stats?.get(this.statNames.team);
    if (team === undefined) return;

    // Отбор наблюдателей просматривает всё доставленное состояние — стоимость
    // перестройки растёт и от числа сущностей, не только от маски (PERF-3).
    // Сток читается один раз на доставку, до сравнения сигнатуры: просмотр
    // состояния идёт в любом случае, а вся работа растра — только за ним.
    const cost = costSink();
    if (cost !== undefined) cost.fogEntitiesScanned += view.entities.size;

    // Значения конфига, влияющие на растр и блит: ширина градиента, тон
    // (вбит в канвас миникарты) и консервативность — последняя через
    // эффективные радиусы наблюдателей ниже.
    let candidate = this.candidate;
    candidate[0] = this.current.edgeWidth;
    candidate[1] = this.colorHex;
    let length = SIGNATURE_PREFIX;
    for (const entity of view.entities.values()) {
      const stats = entity.stats;
      if (stats === undefined) continue;
      // Фильтр по команде обязателен (design D4): у видимого врага тоже есть
      // Vision, но его круг маску игрока открывать не должен.
      if (stats.get(this.statNames.team) !== team) continue;
      const radius = stats.get(this.statNames.visionRadius);
      if (radius === undefined || radius <= 0) continue;
      if (length + 4 > candidate.length) candidate = this.growCandidate(length);
      // Радиус статов уже во float мировых единицах (REND-1, `statSources.ts`);
      // визуал консервативнее геймплея на коэффициент конфига (FOW-9). Уровень
      // — доставленный `currLevel` (TERR-4): слот сигнатуры и поле наблюдателя.
      candidate[length] = entity.currX;
      candidate[length + 1] = entity.currY;
      candidate[length + 2] = radius * this.current.conservatism;
      candidate[length + 3] = entity.currLevel;
      length += 4;
    }
    if (length === this.signatureLength && samePrefix(this.signature, candidate, length)) {
      return; // входы прежние: ни растра, ни загрузки текстуры, ни блита (D4)
    }
    // Копия, а не обмен буферами: одно хранимое состояние вместо двух массивов
    // с расходящимися ёмкостями; копия десятков чисел не дороже только что
    // выполненного сравнения тех же данных.
    if (this.signature.length < length) this.signature = new Float64Array(candidate.length);
    this.signature.set(candidate.subarray(0, length));
    this.signatureLength = length;
    this.rebuildCount++;

    this.mask.clear();
    const observer = this.observerScratch;
    for (let at = SIGNATURE_PREFIX; at < length; at += 4) {
      observer.x = candidate[at]!;
      observer.y = candidate[at + 1]!;
      observer.radius = candidate[at + 2]!;
      observer.level = candidate[at + 3]!;
      this.mask.reveal(observer, this.current.edgeWidth, this.segments);
    }
    // Полутон кромки — один блюр после всех reveal (FOW-7): полярный срез
    // жёсткий и на фронте, и на сторонах конуса, полутон делает smooth().
    this.mask.smooth();
    // Рассеивание не мгновенное (FOW-7): показанная маска догоняет целевую в
    // updateFrame. Разрыв непрерывности мира (REND-2) и нулевое время — снап:
    // плавность — про ход мира, а не про телепорт или выключенное рассеивание.
    const snap = view.snapAll || this.current.dissolveSeconds <= 0;
    if (snap) {
      this.shown.set(this.mask.data);
      this.settling = false;
    } else {
      this.settling = true;
    }
    // Текстура и слой миникарты отражают ПОКАЗАННУЮ маску — а её эта доставка
    // изменила только при снапе: при рассеивании показанную ведёт updateFrame,
    // он же поднимает флаг версии и повторяет блит, и загрузка или блит
    // неизменных байтов здесь были бы платой ни за что (PERF-3). Исключение —
    // первая перестройка: слой миникарты обязан существовать с неё (design D6).
    if (snap || !this.built) {
      this.maskTexture.needsUpdate = true;
      // Байт на тексель (RedFormat, UnsignedByteType): весь растр уезжает в
      // текстуру — цена разрешения маски, а не наблюдателей. Точка счёта ОДНА
      // на загрузку и живёт здесь, у поднятого флага версии: создание текстуры
      // (`createMaskTexture`) своего трафика не имеет — три сливает его флаг с
      // этим в одну загрузку.
      if (cost !== undefined) cost.fogMaskUploadBytes += this.mask.data.length;
      this.blitLayer(cost);
    }
    this.built = true;
  }

  /**
   * Доля света ПОКАЗАННОЙ маски в мировой точке [0, 1] — то, что сейчас на
   * экране, в отличие от `visibility.valueAt` (целевая маска). Пробник
   * рассеивания (FOW-7) для тестов.
   */
  shownAt(worldX: number, worldY: number): number {
    const mask = this.mask;
    const tx = Math.floor((worldX - mask.rect.x) * mask.texelsPerUnit);
    const ty = Math.floor((worldY - mask.rect.y) * mask.texelsPerUnit);
    if (tx < 0 || ty < 0 || tx >= mask.width || ty >= mask.height) return 0;
    return this.shown[ty * mask.width + tx]! / 255;
  }

  /**
   * Число перестроек маски с создания подсистемы — пробник кэша сигнатуры
   * (design D4) для тестов; картинка от него не зависит.
   */
  get rebuilds(): number {
    return this.rebuildCount;
  }

  /** Рост кандидата сигнатуры: редкость (наблюдателей прибыло), не горячий путь. */
  private growCandidate(occupied: number): Float64Array {
    const grown = new Float64Array(this.candidate.length * 2);
    grown.set(this.candidate.subarray(0, occupied));
    this.candidate = grown;
    return grown;
  }

  /**
   * Сходимость показанной маски к целевой (FOW-7): линейный шаг по времени
   * рассеивания, открытие и закрытие зоны симметричны. `dt` — со знаком хода
   * мира (REND-25): в замороженном мире туман тоже стоит. Сошлось — кадры
   * перестают платить и за копию, и за загрузку текстуры (design D4).
   */
  updateFrame(dt: number, _alpha: number): void {
    if (!this.settling) return;
    const elapsed = Math.abs(dt);
    if (elapsed <= 0) return;
    const target = this.mask.data;
    const shown = this.shown;
    // Кадр сходимости — единственная работа тумана, растущая с площадью маски
    // НЕ на доставке, а на кадре (PERF-2, стадия `frame`): проход по всему
    // показанному растру, а следом — та же загрузка текстуры и тот же блит
    // слоя миникарты тем же объёмом. Одним числом описан объём всех трёх:
    // отдельные поля повторяли бы длину растра трижды, а разойтись они не
    // могут. Сошлось — кадры перестают платить вовсе, и счётчик обнуляется
    // сам собой (design D4). Ручки качества это не требует (QUAL-3): объём
    // правит тот же потолок `fog.maskResolution` (FOW-10).
    const cost = costSink();
    if (cost !== undefined) cost.fogDissolveTexels += shown.length;
    const step = Math.max(1, Math.round((255 * elapsed) / this.current.dissolveSeconds));
    let settled = true;
    for (let i = 0; i < shown.length; i++) {
      const want = target[i]!;
      const have = shown[i]!;
      if (have === want) continue;
      const diff = want - have;
      if (diff > step) {
        shown[i] = have + step;
        settled = false;
      } else if (diff < -step) {
        shown[i] = have - step;
        settled = false;
      } else {
        shown[i] = want;
      }
    }
    this.settling = !settled;
    this.maskTexture.needsUpdate = true;
    // Сток блиту не отдаётся намеренно: объём этого блита уже посчитан
    // `fogDissolveTexels` выше, а `fogMinimapTexels` — счётчик стадии доставки
    // (PERF-2), и приписывать ему кадровую работу значило бы врать стадией.
    this.blitLayer(undefined);
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
   * Отладочный источник маски (`render-debug` RDBG-1, REND-27): подсистема
   * объявляет его в точке своей регистрации — данные маски принадлежат ей, и
   * никто, кроме неё, не знает, что у неё внутри. Доступ узкий и только на
   * чтение: счётчиков стоимости отладка не двигает (RDBG-8), а действующее
   * разрешение показывается вместе с авторским и потолком пресета (FOW-10).
   */
  debugSources(): readonly DebugSource[] {
    return [
      fogMaskDebugSource({
        mask: () => this.mask,
        shown: () => this.shown,
        // Наблюдатели последней перестройки лежат в сигнатуре по четыре числа.
        observers: () => (this.signatureLength < 0 ? 0 : (this.signatureLength - SIGNATURE_PREFIX) / 4),
        authoredResolution: () => resolveFogConfig(this.section).resolution,
        ceilingResolution: () => this.ceiling,
        rebuilds: () => this.rebuildCount,
        dissolving: () => this.settling,
        levels: () => this.grid.levels,
        heightStep: () => this.ctx?.config.heightStep ?? 1,
        built: () => this.built,
      }),
    ];
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
    this.colorHex = new THREE.Color(next.color).getHex();
    (this.postMaterial.uniforms.uStrength as { value: number }).value = next.strength;
    (this.postMaterial.uniforms.uColor as { value: THREE.Color }).value.set(next.color);
    if (next.resolution !== previous.resolution) {
      this.mask = new VisibilityMask(this.rect, next.resolution);
      this.shown = new Uint8Array(this.mask.data.length);
      this.settling = false;
      this.maskTexture.dispose();
      this.maskTexture = createMaskTexture(this.mask, this.shown);
      (this.postMaterial.uniforms.tMask as { value: THREE.Texture }).value = this.maskTexture;
      (this.postMaterial.uniforms.uMaskTexel as { value: THREE.Vector2 }).value.set(
        1 / this.mask.width,
        1 / this.mask.height,
      );
      // Прежний растр другого разрешения не переносится: маска перестроится
      // ближайшей доставкой, а до неё прежняя картинка честнее растянутой.
      this.built = false;
      this.minimap.reset();
      // Разрешение в сигнатуру входов не входит — пустой растр честно требует
      // перестройки ближайшей доставкой (design D4).
      this.signatureLength = -1;
    }
    // Смена ширины градиента/консервативности/тона доедет ближайшей
    // перестройкой: они — слоты сигнатуры входов (design D4); длительность
    // fade читают потребители через `config` (design D7).
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
   * Блит растра в канвас слоя миникарты (HUD-6, design D6) — его дело. Тон —
   * кэшированным sRGB-числом (`colorHex`, слот сигнатуры): блит не парсит
   * строку цвета на каждый вызов.
   */
  private blitLayer(cost: RenderCostCounters | undefined): void {
    this.minimap.blit(this.mask, this.shown, this.colorHex, cost);
  }

  /** Растр маски — для тестов геометрии; потребители картинки ходят не сюда. */
  get visibility(): VisibilityMask {
    return this.mask;
  }
}

/** Одноканальная текстура поверх растра маски; фильтрация билинейная (design D2). */
function createMaskTexture(mask: VisibilityMask, shown: Uint8Array): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    shown,
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
