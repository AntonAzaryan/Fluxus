/**
 * Подсистема тумана войны (FOW-7, FOW-9, FOW-10) за контрактом REND-8: владеет
 * маской видимости, конфигурацией картинки и полноэкранным пост-проходом.
 *
 * ## Что она делает
 *
 * - На доставке (`syncTick`) собирает СИГНАТУРУ входов маски (design D4):
 *   наблюдатели СВОЕЙ команды берутся из доставленного состояния по именам
 *   статов (design D4, HUD-8) — радиус обзора и команда; команду игрока задаёт
 *   стат его героя. Видимые враги несут те же статы, и их круги в маску не
 *   попадают: фильтр по команде обязателен. Растра доставка не трогает вовсе
 *   (change `fog-mask-budgeted-rebuild`, design D3): новый вход кладётся
 *   отложенным, а перестройка идёт порциями в кадре. Совпала сигнатура — не
 *   происходит вообще ничего. Уровень наблюдателя — доставленный
 *   `EntityView.currLevel` (TERR-4): тени маски направленные (FOW-9, PHYS-13).
 * - Кадр (`updateFrame`) достраивает маску под ТЕКСЕЛЬНЫЙ БЮДЖЕТ и ведёт
 *   рассеивание по грязным блокам (design D1, D5). Перестройка в полёте никогда
 *   не перезапускается доставкой: она достраивается, публикуется атомарным
 *   свопом растров и только потом берёт последний отложенный вход — конфляция
 *   «важен только последний», как в канале (SHELL-4). Разрыв истории
 *   (`snapAll`, REND-2) — исключение: маска строится синхронно прямо в
 *   доставке, без порций и без рассеивания.
 * - Кадр рисует пост-проходом (design D2): сцена уходит в render target, затем
 *   полноэкранный шейдер по глубине и обратной view-projection восстанавливает
 *   мировые XY фрагмента, сэмплирует маску и затемняет силой/цветом из
 *   конфигурации (FOW-7, FOW-10). Юнитов в туманной зоне нет по построению —
 *   их вырезал фильтр снапшота (NET-12), и прятать рендеру некого.
 * - При АКТИВНОЙ пост-обработке кадра (REND-34) сцену подсистема не рисует
 *   вовсе: вход маскирующего прохода — цвет (выход сведения яркости) и глубина
 *   сцены — приезжает портом `ScenePostSource` (change `bloom-tone-mapping`,
 *   design D2). Маска остаётся ФИНАЛЬНЫМ проходом кадра, а bloom и tone mapping
 *   ложатся под неё и затемняются наравне с остальным кадром (FOW-7). Порта
 *   нет либо цепочка неактивна — всё ровно как было: своя LDR-цель и свой
 *   прямой рендер.
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
import type { EntityId, TerrainGrid } from '@fluxus/core';
import type { PresentationFog } from '@fluxus/assets';
import type {
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  ScenePostFrame,
  ScenePostSource,
  TickView,
} from '../types.js';
import { costSink, type RenderCostCounters } from '../cost.js';
import type { DebugSource } from '../debug/contract.js';
import { fogMaskDebugSource } from '../debug/fogSource.js';
import { resolveFogConfig, type FogRenderConfig } from '../fog/config.js';
import type { FogRendererLike, FogStatNames, FogSubsystemOptions } from '../fog/contract.js';
import { POST_FRAGMENT, POST_VERTEX, createMaskTexture } from '../fog/postPass.js';
import { FogMinimapSurface, type FogMinimapLayer } from '../fog/layer.js';
import { FogBlitCadence, FogDirtyBlocks, dissolveWindow } from '../fog/dirty.js';
import {
  MaskRebuild,
  REBUILD_BUDGET_MASK_AREAS,
  SIGNATURE_PREFIX,
} from '../fog/rebuild.js';
import {
  VisibilityMask,
  fogLevelsOf,
  fogRectOf,
  fogSegmentsOf,
  type FogLevelField,
  type FogWorldRect,
} from '../fog/mask.js';
import type { FogSegment } from '../fog/shadowDepth.js';
import { own, peak } from '../footprint.js';

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1, FOW-10): разрешение маски
 * — ПОТОЛОК над сценным значением, а не значение вместо него (design D3).
 * Действующее разрешение = min(сценного, потолка): пресет вправе удешевить
 * картинку, но не поднять её выше авторской и не тронуть документ сцены.
 *
 * Верхняя граница диапазона — та же, что у здравого смысла авторского значения:
 * маска строится на CPU порциями кадров каденсом доставки, и её стоимость
 * растёт КВАДРАТОМ разрешения (обнуление, reveal, блюр кромки, загрузка в
 * текстуру, блит миникарты). Бюджет порции нарезку удешевляет ЛАТЕНТНОСТЬЮ, а
 * не объёмом: полная перестройка стоит столько же, как её ни режь, — рычагом
 * объёма остаётся этот потолок.
 */
const FOG_MASK_RESOLUTION = 'fog.maskResolution';

export class FogSubsystem implements RenderSubsystem {
  readonly name = 'fog';

  private readonly grid: TerrainGrid;
  private readonly statNames: FogStatNames;
  private readonly heroOf: () => EntityId | null;
  /** Порт пост-обработки кадра (REND-34, design D2); null — её в сборке нет. */
  private readonly post: ScenePostSource | null;

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
  /** Карта уровней пола сетки — срез reveal по высоте (FOW-9, design D4). */
  private field: FogLevelField;
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
  /**
   * Грязное окно рассеивания (design D5): блоки растра, в которых показанная
   * маска ещё не сошлась с целевой. Устоявшаяся сцена держит его пустым и не
   * платит за туман в кадре ничего.
   */
  private dirty: FogDirtyBlocks;
  /**
   * Каденс блита миникарты в окне рассеивания (`FOG_MINIMAP_BLIT_SECONDS`):
   * канвас перерисовывается не каждым кадром, окна пропущенных копятся.
   */
  private readonly minimapCadence = new FogBlitCadence();

  /**
   * Перестройка маски (change `fog-mask-budgeted-rebuild`, design D1–D3): три
   * сигнатуры входов, фазовая машина порций и бюджет. Подсистема отдаёт ей
   * доставленные входы и кадры, а публикацию узнаёт возвратом `advance`.
   */
  private readonly rebuild: MaskRebuild;
  /** Буфер сборки сигнатуры текущей доставки — вход конфляции (design D3). */
  private candidate: Float64Array = new Float64Array(SIGNATURE_PREFIX + 4 * 8);
  /** Бюджет из опций сборки; не задан — считается от площади маски. */
  private readonly authoredBudget: number | undefined;
  /**
   * Тон тумана числом — кэш для блита миникарты (он вбивает его в канвас).
   * В сигнатуру растра тон НЕ входит (`SIGNATURE_PREFIX`): в растре его нет
   * вовсе, и правка тона перекрашивает слой событием (`applyResolved`), а не
   * перестройкой.
   */
  private colorHex: number;
  /** Буфер наблюдателя синхронного снапа: он тоже не аллоцирует по объекту. */
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
    this.post = options.post ?? null;
    // Авторская секция хранится как есть (FOW-10, QUAL-1): действующая
    // конфигурация — уже под потолком пресета, если он приехал.
    this.section = options.config;
    this.current = this.effective();
    this.colorHex = new THREE.Color(this.current.color).getHex();
    // Приём сетки — точка входной границы (REND-1, TERR-2): дальше только float.
    this.rect = fogRectOf(this.grid);
    this.segments = fogSegmentsOf(this.grid);
    this.field = fogLevelsOf(this.grid);
    this.mask = new VisibilityMask(this.rect, this.current.resolution, this.field);
    this.shown = new Uint8Array(this.mask.data.length);
    this.dirty = new FogDirtyBlocks(this.mask.width, this.mask.height);
    this.authoredBudget = options.rebuildBudget;
    this.rebuild = new MaskRebuild(this.budgetFor(this.mask));
    this.maskTexture = createMaskTexture(this.mask, this.shown);
    // Фабрику канваса приносит сборка (в браузере — `document.createElement`):
    // пакет рендера DOM не трогает, и слой миникарты без фабрики просто не
    // существует — маска и пост-проход от этого не зависят.
    this.minimap = new FogMinimapSurface(this.rect, () => this.current.strength, options.createCanvas);

    this.postMaterial = own('material', 'fog', new THREE.ShaderMaterial({
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
    }));
    this.postQuad = new THREE.Mesh(own('geometry', 'fog', new THREE.PlaneGeometry(2, 2)), this.postMaterial);
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
    this.releaseTarget();
    this.postMaterial.dispose();
    this.postQuad?.geometry.dispose();
    this.postQuad?.removeFromParent();
    this.postQuad = null;
    // Растр маски больше не показывается ничем: канвас слоя миникарты (HUD-6)
    // принесла сборка и отпускает его она же.
    this.minimap.reset();
    this.built = false;
    // Перестройка в полёте и её отложенный вход уходят вместе с подсистемой:
    // кадров у неё больше не будет, а достраивать нечего и некуда.
    this.rebuild.abort();
    this.dirty.clear();
    this.settling = false;
    this.minimapCadence.reset();
  }

  /**
   * Приём доставки (design D3, D4): наблюдатели своей команды из доставленного
   * состояния по именам статов складываются в сигнатуру входов. Пока команда
   * игрока не доставлена (нет героя или его статов), прежняя маска остаётся как
   * есть — консервативнее мигания «всё открыто/всё закрыто».
   *
   * Растра доставка не трогает: новый вход становится ОТЛОЖЕННЫМ, а строит его
   * кадр порциями. Сигнатура сравнивается с последним ИЗВЕСТНЫМ желаемым входом
   * — отложенным, затем полётным, затем опубликованным: совпала — не происходит
   * ничего вовсе, стоя на месте кадр за туман не платит (design D4). Отрезки в
   * сигнатуру не входят: их набор фиксируется конструктором и не меняется за
   * жизнь подсистемы, а смена разрешения инвалидирует сигнатуру явно
   * (`applyConfig`).
   *
   * Разрыв истории (`snapAll`, REND-2) — синхронный снап прямо здесь: перемотку
   * и смену режима размазывать по кадрам нечем.
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

    const length = this.collect(view, team);
    if (view.snapAll) {
      this.snap(length, cost);
      return;
    }
    // Совпал с последним известным желаемым входом — доставке делать нечего;
    // иначе она становится последним отложенным (конфляция, design D3).
    if (this.rebuild.matches(this.candidate, length)) return;
    this.rebuild.defer(this.candidate, length);
  }

  /**
   * Сигнатура входов текущей доставки в буфер кандидата; возвращает её длину.
   * Значения конфига, влияющие на РАСТР: ширина градиента и консервативность —
   * последняя через эффективные радиусы наблюдателей. Тон в сигнатуру не входит
   * (см. `SIGNATURE_PREFIX`): он живёт в канвасе миникарты, а не в растре.
   */
  private collect(view: TickView, team: number): number {
    let candidate = this.candidate;
    candidate[0] = this.current.edgeWidth;
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
    return length;
  }

  /**
   * Синхронный снап маски (REND-2, design D3): перестройка целиком на ПЕРЕДНЕМ
   * растре и публикация в той же доставке. Начатая порционная перестройка
   * бросается — её вход устарел вместе с историей, и достраивать её значило бы
   * показать после телепорта маску прежнего мира.
   */
  private snap(length: number, cost: RenderCostCounters | undefined): void {
    this.mask.clear();
    const observer = this.observerScratch;
    for (let at = SIGNATURE_PREFIX; at < length; at += 4) {
      observer.x = this.candidate[at]!;
      observer.y = this.candidate[at + 1]!;
      observer.radius = this.candidate[at + 2]!;
      observer.level = this.candidate[at + 3]!;
      this.mask.reveal(observer, this.candidate[0]!, this.segments);
    }
    // Полутон кромки — один блюр после всех reveal (FOW-7): полярный срез
    // жёсткий и на фронте, и на сторонах конуса, полутон делает smooth().
    this.mask.smooth();
    this.rebuild.publishSync(this.candidate, length);
    // Снап — без рассеивания: показанная маска становится целевой сразу.
    this.shown.set(this.mask.data);
    this.settling = false;
    this.dirty.clear();
    this.publishTexture(cost);
    this.built = true;
  }

  /**
   * ПОЛНАЯ публикация показанной маски: загрузка растра в текстуру и блит слоя
   * миникарты целиком — первая перестройка, снап (REND-2) и выключенное
   * рассеивание. Полный блит накрывает всё, что могло копиться в окне каденса,
   * — накопитель и счёт времени сбрасываются вместе с ним.
   */
  private publishTexture(cost: RenderCostCounters | undefined): void {
    this.uploadTexture(cost);
    this.minimap.blit(this.mask, this.shown, this.colorHex, cost, null);
    this.minimapCadence.reset();
  }

  /**
   * Загрузка растра в текстуру. Байт на тексель (RedFormat, UnsignedByteType):
   * весь растр уезжает в текстуру — цена разрешения маски, а не наблюдателей.
   * Точка счёта ОДНА на загрузку и живёт здесь, у поднятого флага версии:
   * создание текстуры (`createMaskTexture`) своего трафика не имеет — три
   * сливает его флаг с этим в одну загрузку.
   *
   * Частичной загрузки нет намеренно (Non-Goals change
   * `fog-mask-budgeted-rebuild`, FOW-11 «принятый остаток»): окно правит блит
   * миникарты и проход рассеивания, а растр уезжает целиком —
   * `copyTextureToTexture` потребовал бы расширения `FogRendererLike` и всех
   * тестовых дублей.
   */
  private uploadTexture(cost: RenderCostCounters | undefined): void {
    this.maskTexture.needsUpdate = true;
    if (cost !== undefined) cost.fogMaskUploadBytes += this.mask.data.length;
    // Байты растра маски (PERF-8): опубликованный и задний растры плюс копия
    // показанного. Величина — функция разрешения (FOW-10), и потолок пресета
    // качества виден в эталоне памяти той же строкой, что и в эталоне работы.
    peak('fogMaskBytes', this.mask.byteLength + this.shown.byteLength);
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
   * Число ОПУБЛИКОВАННЫХ перестроек маски с создания подсистемы — пробник кэша
   * сигнатуры (design D4) и коалесинга (design D3) для тестов; картинка от него
   * не зависит. Начатая, но не закоммиченная перестройка сюда не входит: её
   * растра ещё никто не видел.
   */
  get rebuilds(): number {
    return this.rebuild.rebuilds;
  }

  /**
   * Идёт ли перестройка маски прямо сейчас — пробник фазовой машины (design
   * D1) для тестов и диагностики.
   */
  get rebuilding(): boolean {
    return this.rebuild.running;
  }

  /** Рост кандидата сигнатуры: редкость (наблюдателей прибыло), не горячий путь. */
  private growCandidate(occupied: number): Float64Array {
    const grown = new Float64Array(this.candidate.length * 2);
    grown.set(this.candidate.subarray(0, occupied));
    this.candidate = grown;
    return grown;
  }

  /**
   * Кадр тумана: сперва порции перестройки под бюджет (design D1), затем
   * сходимость показанной маски к целевой по грязным блокам (design D5).
   * Порядок именно такой: свежая публикация размечает окно, и рассеивание в том
   * же кадре уже ведёт показанную маску к только что опубликованной.
   *
   * `dt` — со знаком хода мира (REND-25): в замороженном мире туман тоже стоит.
   * Перестройка от него не зависит вовсе — она про доставку, а не про ход мира.
   */
  updateFrame(dt: number, _alpha: number): void {
    const cost = costSink();
    // Рассеивание не мгновенное (FOW-7); нулевое время — снап показанной маски:
    // плавность — про ход мира, а не про выключенное автором рассеивание. Окно
    // при таком снапе не размечается вовсе — сравнивать растры незачем.
    const instant = this.current.dissolveSeconds <= 0;
    if (this.rebuild.advance(this.mask, this.segments, instant ? null : this.dirty)) {
      this.onPublished(instant, cost);
    }
    this.dissolve(dt, cost);
  }

  /**
   * Публикация построенного растра свершилась (design D2): показанная маска
   * начинает догонять целевую, а на первой перестройке и при выключенном
   * рассеивании — становится ею сразу.
   */
  private onPublished(instant: boolean, cost: RenderCostCounters | undefined): void {
    const first = !this.built;
    this.built = true;
    // Публикация открыла СВЕЖЕЕ окно (устоявшаяся сцена пришла в движение)?
    // Тогда первый его кадр рассеивания блитует миникарту сразу, не дожидаясь
    // каденса: слой не должен запаздывать на треть каденса от начала скачка.
    // Окно, открытое поверх идущего рассеивания, каденс не сбивает.
    let fresh = false;
    if (instant) {
      this.shown.set(this.mask.data);
      this.dirty.clear();
      this.settling = false;
    } else {
      fresh = !this.settling && !this.dirty.empty;
      this.settling = !this.dirty.empty;
    }
    // Текстура и слой миникарты отражают ПОКАЗАННУЮ маску — а её эта публикация
    // изменила только при выключенном рассеивании: иначе показанную ведёт
    // рассеивание кадрами, и загрузка неизменных байтов здесь была бы платой ни
    // за что (PERF-3). Исключение — первая перестройка: слой миникарты обязан
    // существовать с неё (design D6).
    if (instant || first) this.publishTexture(cost);
    // Засев — ПОСЛЕ полного блита первой перестройки: он сбрасывает каденс, а
    // свежее окно обязано блитовать первым же кадром рассеивания.
    if (fresh) this.minimapCadence.prime();
  }

  /**
   * Сходимость показанной маски к целевой (FOW-7) по ГРЯЗНЫМ БЛОКАМ (design
   * D5): линейный шаг по времени рассеивания, открытие и закрытие зоны
   * симметричны. Работа кадра пропорциональна ещё не устоявшейся области, а не
   * всему растру, и по мере схождения окно сжимается; сошлось — кадры перестают
   * платить и за проход, и за загрузку текстуры, и за блит миникарты.
   *
   * Показанная маска и её текстура двигаются КАЖДЫМ кадром окна — рассеивание
   * на экране плавное; канвас миникарты перерисовывается каденсом
   * (`MINIMAP_BLIT_SECONDS`), а окна пропущенных кадров копятся общим
   * прямоугольником. Схождение окна блитует накопленное немедленно — последнее
   * значение каждого блока в канвасе оказывается всегда.
   */
  private dissolve(dt: number, cost: RenderCostCounters | undefined): void {
    if (!this.settling) return;
    const elapsed = Math.abs(dt);
    if (elapsed <= 0) return;
    const step = Math.max(1, Math.round((255 * elapsed) / this.current.dissolveSeconds));
    const dirty = this.dirty;
    dissolveWindow(this.mask.data, this.shown, this.mask.width, this.mask.height, dirty, step);
    this.uploadTexture(cost);
    const due = this.minimapCadence.advance(dirty, elapsed);
    dirty.flushSettled();
    this.settling = !dirty.empty;
    // Финальный блит по схождении окна обязателен, каденс набран или нет.
    if (due || !this.settling) {
      this.minimap.blit(this.mask, this.shown, this.colorHex, cost, this.minimapCadence.region);
      this.minimapCadence.reset();
    }
  }

  /** Бюджет порции: авторский из опций либо от площади маски (design D1). */
  private budgetFor(mask: VisibilityMask): number {
    const authored = this.authoredBudget;
    if (authored !== undefined) return authored;
    return Math.max(1, Math.ceil(mask.width * mask.height * REBUILD_BUDGET_MASK_AREAS));
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
        observers: () => this.rebuild.observers,
        authoredResolution: () => resolveFogConfig(this.section).resolution,
        ceilingResolution: () => this.ceiling,
        rebuilds: () => this.rebuild.rebuilds,
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
    const tone = new THREE.Color(next.color).getHex();
    const repaint = tone !== this.colorHex;
    this.colorHex = tone;
    (this.postMaterial.uniforms.uStrength as { value: number }).value = next.strength;
    (this.postMaterial.uniforms.uColor as { value: THREE.Color }).value.set(next.color);
    if (next.resolution !== previous.resolution) {
      this.mask = new VisibilityMask(this.rect, next.resolution, this.field);
      this.shown = new Uint8Array(this.mask.data.length);
      // Растр другого разрешения — другая блочная сетка и другой бюджет; порции
      // в полёте писали в прежний растр, и достраивать их некуда (design D3).
      this.dirty = new FogDirtyBlocks(this.mask.width, this.mask.height);
      this.rebuild.budget = this.budgetFor(this.mask);
      this.rebuild.abort();
      this.settling = false;
      // Накопленное окно каденса — координаты прежнего растра: не переносится.
      this.minimapCadence.reset();
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
      this.rebuild.forget();
      return; // растр и слой заведутся заново ближайшей перестройкой
    }
    // Смена тона — СОБЫТИЕ правки конфигурации, а не перестройка (FOW-10,
    // HUD-6): тон вбит в пиксели канваса миникарты и в растр не входит вовсе,
    // поэтому перестройка вернула бы байт в байт тот же растр, пустое грязное
    // окно — и слой остался бы старого тона навсегда. Перекрашивается он здесь
    // же и целиком; текстуру маски это событие не трогает — там тона нет, его
    // держит униформа пост-прохода выше.
    if (repaint && this.built) {
      this.minimap.blit(this.mask, this.shown, this.colorHex, costSink(), null);
      // Полный блит перекраски накрыл и всё накопленное окно каденса.
      this.minimapCadence.reset();
    }
    // Смена ширины градиента и консервативности доедет ближайшей перестройкой:
    // они — слоты сигнатуры входов (design D4); длительность fade читают
    // потребители через `config` (design D7).
  }

  /**
   * Кадр с туманом (design D2): сцена в render target, затем полноэкранный
   * проход затемнения. Пока маска не построена — вклада тумана в кадре нет
   * вовсе: при неактивной пост-обработке это ровно прямой рендер, при активной
   * — ровно её проходы без маскирующего (FOW-7).
   *
   * При активной цепочке пост-обработки (REND-34) сцену рисует ОНА, а маска
   * ложится поверх её выхода: свечение и сведённая яркость затемняются наравне
   * с остальным кадром, и скрытого маской bloom не открывает (FOW-7, QUAL-2).
   */
  render(renderer: FogRendererLike, camera: THREE.Camera): void {
    const ctx = this.ctx;
    if (ctx === null) throw new Error('FogSubsystem: init() не вызван (REND-8)');
    // Проходы рендерера — стадия кадра (PERF-2): их число подсистема знает
    // сама, и структурный спай теста обязан видеть ровно столько же. Проходы
    // цепочки в это число не входят — их считает её собственный счётчик.
    const cost = costSink();
    // Порт берётся только при АКТИВНОЙ цепочке: неактивная — это «делай как до
    // REND-34», и сцену подсистема тумана рисует сама, в свою LDR-цель.
    const chain = this.post?.active === true ? this.post : null;
    // Цепочка взяла отрисовку сцены на себя — своя цель тумана больше не нужна
    // ни одному проходу и отдаётся сразу, а не доживает до сноса (REND-31).
    if (chain !== null) this.releaseTarget();
    if (!this.built) {
      if (chain !== null) {
        chain.renderToScreen(renderer, camera);
        return;
      }
      renderer.render(ctx.scene, camera);
      if (cost !== undefined) cost.fogRenderPasses++;
      return;
    }
    const frame =
      chain !== null ? chain.renderToTexture(renderer, camera) : this.renderScene(renderer, ctx, camera);

    camera.updateMatrixWorld();
    (this.postMaterial.uniforms.uInvViewProj as { value: THREE.Matrix4 }).value
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .invert();
    (this.postMaterial.uniforms.tScene as { value: THREE.Texture | null }).value = frame.color;
    (this.postMaterial.uniforms.tDepth as { value: THREE.Texture | null }).value = frame.depth;
    renderer.render(this.postScene, this.postCamera);
    // Маскирующий проход — один; отрисовка сцены сюда добавляется только тогда,
    // когда её сделала САМА подсистема (неактивная цепочка).
    if (cost !== undefined) cost.fogRenderPasses += chain !== null ? 1 : 2;
  }

  /**
   * Своя отрисовка сцены в промежуточную LDR-цель — путь без пост-обработки,
   * ровно тот же, что был до REND-34. Возвращает вход маскирующего прохода в
   * той же форме, в какой его отдаёт порт цепочки (design D2).
   */
  private renderScene(
    renderer: FogRendererLike,
    ctx: RenderContext,
    camera: THREE.Camera,
  ): ScenePostFrame {
    const size = renderer.getDrawingBufferSize(this.sizeScratch);
    const target = this.ensureTarget(size.x, size.y);
    renderer.setRenderTarget(target);
    renderer.render(ctx.scene, camera);
    renderer.setRenderTarget(null);
    // ponytail (REND-26): та же запись на кадр, что отдаёт порт цепочки, и по
    // тому же основанию — одна на кадр с построенной маской, а не на инстанс.
    // Форма ответа общая намеренно: два пути входа маски различаются тем, КТО
    // нарисовал сцену, а не тем, что получает маскирующий проход.
    return { color: target.texture, depth: target.depthTexture };
  }

  /**
   * Отдаёт промежуточную цель кадра вместе с её текстурой глубины (REND-31).
   * Текстуру заводит ПОДСИСТЕМА, а не цель: `dispose()` цели рассылает только
   * собственное событие, поэтому без этой строки текстура пережила бы и смену
   * размера окна, и снос подсистемы — молча, по одной на каждый ресайз.
   */
  private releaseTarget(): void {
    if (this.target === null) return;
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.target = null;
  }

  /** Render target кадра с текстурой глубины; пересоздаётся при смене размера окна. */
  private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.target !== null && this.target.width === w && this.target.height === h) {
      return this.target;
    }
    this.releaseTarget();
    const depthTexture = own('texture', 'fog', new THREE.DepthTexture(w, h));
    this.target = own('renderTarget', 'fog', new THREE.WebGLRenderTarget(w, h, { depthTexture, depthBuffer: true }));
    return this.target;
  }

  /**
   * ОПУБЛИКОВАННЫЙ растр маски — для тестов геометрии; потребители картинки
   * ходят не сюда. Полупостроенного растра он не показывает никогда (design
   * D2): порции пишут задний буфер, а `commit` меняет ссылки местами.
   */
  get visibility(): VisibilityMask {
    return this.mask;
  }
}
