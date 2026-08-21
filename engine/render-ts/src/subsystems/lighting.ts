/**
 * Подсистема освещения сцены (REND-29) за контрактом REND-8: она владеет источниками
 * света арены и теневыми картами, а потребители рендера — демо-клиент и вьюпорт
 * редактора — своего света больше не заводят. Тождество их кадров (`editor`
 * ED-22) выполняется отсюда по построению, а не дисциплиной копирования чисел.
 *
 * ## Конфигурация — данные
 *
 * Значения приходят секцией `lighting` парного presentation-документа (PRES-2);
 * отсутствие секции или поля — документированные умолчания (`lighting/config.ts`),
 * равные тому свету, что раньше стоял в коде потребителей. Правка секции в
 * рантайме — `applyConfig`: применяется на живых источниках, без пересоздания
 * подсистемы и рендера (ED-15), тем же порядком, что конфигурация тумана
 * (FOW-10).
 *
 * ## Два источника вместо одного, и почему
 *
 * Карта теней у источника three.js одна, и выборочно кэшировать её часть нечем.
 * Поэтому режим `hybrid` (REND-30) — ПАРА направленных источников с одинаковым
 * направлением и тоном: `sun` несёт кэшированную карту статики, `sunDynamic` —
 * покадровую карту динамики, а суммарная интенсивность делится между ними долей
 * `staticShare`. В режимах `none` и `full` источник один: пара не нужна, и
 * второй источник из сцены снимается.
 *
 * Разделять кастеров между двумя картами приходится флагом `castShadow`, а не
 * слоями: теневой проход three.js проверяет слои ГЛАВНОЙ камеры кадра
 * (`WebGLShadowMap.renderObject`), одной на оба источника, и слой на объекте
 * различал бы их видимость в кадре, а не в теневой карте. Механизм здесь такой:
 * `shadow.autoUpdate` выключен у обоих источников, а `needsUpdate` подсистема
 * поднимает сама — ровно одному источнику за кадр, предварительно расставив
 * флаги кастеров того яруса, чья карта в этом кадре и рисуется. Кадр
 * перерисовки кэша поэтому пропускает обновление динамической карты: она
 * остаётся кадром старше, и это единственное наблюдаемое следствие.
 *
 * ## Ярус кастера — производная данных
 *
 * Сама подсистема ярусов не назначает (REND-30): их сообщают владельцы объектов
 * (`ShadowCasterSink`) — подсистема моделей по происхождению инстанса и
 * анимации записи вида, подсистема террейна статикой своих чанков. Здесь только
 * реестр корней, флаги и решение, чью карту рисовать в этом кадре.
 *
 * ## Цикл времени суток
 *
 * Необязательная подсекция `cycle` (REND-32) исполняется здесь же: часы и фазы —
 * в `lighting/cycle.ts`, а этот файл ставит значения кадра на ЖИВЫЕ источники,
 * мимо `applyResolved` (design D2). Покадровый вызов применения объявлял бы
 * событие перерисовки кэша статики и пересчитывал бы фрустумы теневых камер, а
 * фрустум от направления не зависит вовсе — он обтянут по арене (design D6).
 * Кэш статики на переходе трогается ровно тогда, когда поехало НАПРАВЛЕНИЕ:
 * карта глубины не зависит ни от тона, ни от интенсивности (design D3).
 */
import * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import { PRESENTATION_SHADOW_MODES, type PresentationLighting } from '@game-mvp/assets';
import type {
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  ShadowCasterSink,
  ShadowCasterTier,
  ShadowPhase,
} from '../types.js';
import { costSink } from '../cost.js';
import type { DebugSource } from '../debug/contract.js';
import { lightingSceneDebugSource, type DebugLightingState } from '../debug/lightingSource.js';
import {
  minShadowMode,
  resolveLightingConfig,
  resolveLightingCycle,
  type LightingRenderConfig,
  type ShadowMode,
} from '../lighting/config.js';
import { LightingCycle, type LightingCycleSample } from '../lighting/cycle.js';

/**
 * Ручки качества подсистемы (QUAL-1, QUAL-3). Обе — ПОТОЛКИ над авторскими
 * значениями секции: пресет вправе удешевить тени, но не поднять их выше
 * авторских и не тронуть документ сцены (та же семантика, что у потолка
 * разрешения маски тумана, FOW-10).
 */
const LIGHTING_SHADOW_MODE = 'lighting.shadowMode';
const LIGHTING_SHADOW_MAP_SIZE = 'lighting.shadowMapSize';

/**
 * Радиус арены, когда сетки террейна подсистеме не дали (превью ассета ED-20,
 * тесты): фрустумы теневых камер обтягивать нечего, и берётся величина порядка
 * демо-арены — тени тогда есть, но качество их подсистеме не обещано.
 */
const DEFAULT_ARENA_RADIUS = 32;

/**
 * Запас фрустума теневой камеры над ареной, доля её радиуса: модели стоят выше
 * пола, и обтянутый ровно по сетке фрустум срезал бы тень высокой декорации.
 */
const FRUSTUM_MARGIN = 0.25;

/**
 * Смещения выборки карты теней — в ТЕКСЕЛЯХ этой карты, а не в мировых
 * единицах и не авторским числом секции (REND-29).
 *
 * Поверхность, освещённая вкось, за один тексель карты меняет глубину на
 * `тексель · tg(угол между нормалью и светом)`, и без смещения она затеняет
 * сама себя: половина текселя оказывается «за» собственной глубиной, половина
 * перед ней. На арене это читалось РЕБРИСТОЙ СЕТКОЙ на боках клифов — они
 * стоят почти вдоль лучей, и угол там наибольший.
 *
 * Смещение поэтому и меряется текселями: величина дефекта — свойство
 * ПЛОТНОСТИ карты, а плотность меняют и автор сцены (`shadows.mapSize`), и
 * потолок пресета (QUAL-1), и размер арены. Мировое число, поставленное под
 * одну из этих троек, под остальными либо не спасало бы от сетки, либо
 * отрывало бы тень от ног. Отсюда и место расчёта — `aimLight`, где фрустум и
 * сторона карты известны обе.
 *
 * Двух смещений именно два, потому что они лечат разное: `normalBias` сдвигает
 * точку выборки ВДОЛЬ НОРМАЛИ приёмника (то есть ровно поперёк ошибки наклона)
 * и делает основную работу, `bias` — постоянная поправка глубины, добавка
 * против остатка на самых косых поверхностях. Больше текселя-двух ни то, ни
 * другое брать нельзя: смещение — это и есть отрыв тени от контакта.
 */
const NORMAL_BIAS_TEXELS = 2;
const DEPTH_BIAS_TEXELS = 1;

export interface LightingOptions {
  /**
   * Сетка террейна сцены — по её границам обтягиваются ортографические теневые
   * камеры (design D6): арена мала, и стабильный фрустум не даёт мерцания
   * текселей при движении камеры кадра. Нет сетки — умолчательный радиус.
   */
  readonly grid?: TerrainGrid;
  /** Секция `lighting` парного документа (PRES-2); нет — умолчания. */
  readonly config?: PresentationLighting;
}

/** Границы арены, по которым обтянуты теневые камеры. */
interface ArenaExtent {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}

export class LightingSubsystem implements RenderSubsystem, ShadowCasterSink {
  readonly name = 'lighting';

  /**
   * Авторская секция как есть (PRES-2) — она здесь только читается: пресет
   * качества документ не правит ни байтом (QUAL-1), а `current` — уже
   * действующая конфигурация под потолками.
   */
  private section: PresentationLighting | undefined;
  /** Потолок режима теней от пресета; `full` — потолка нет (QUAL-1). */
  private modeCeiling: ShadowMode = 'full';
  /** Потолок стороны карты теней; бесконечность — потолка нет. */
  private sizeCeiling = Number.POSITIVE_INFINITY;
  private current: LightingRenderConfig;
  private ctx: RenderContext | null = null;
  private extent: ArenaExtent;

  private readonly ambient = new THREE.AmbientLight();
  /**
   * Направленный источник сцены. В `hybrid` он несёт КЭШИРОВАННУЮ карту
   * статики, в `full` — единственную покадровую, в `none` — теней не несёт.
   */
  private readonly sun = new THREE.DirectionalLight();
  /**
   * Второй источник того же направления — покадровая карта динамики в `hybrid`.
   * Вне этого режима из сцены снят: лишний источник в сцене менял бы число
   * направленных светов и пересобирал бы программы всех материалов.
   */
  private readonly sunDynamic = new THREE.DirectionalLight();

  /** Реестр корней нарисованного по ярусам — вход флагов и счётчиков. */
  private readonly staticRoots = new Set<THREE.Object3D>();
  private readonly dynamicRoots = new Set<THREE.Object3D>();

  private phase: ShadowPhase = 'none';
  /** Кэш статики устарел: ближайший кадр перерисует его (design D2). */
  private staticStale = true;
  /** Реестр кастеров изменился: флаги фазы надо расставить заново. */
  private flagsStale = true;
  /**
   * Карта динамики пуста и уже очищена завершающим проходом: перерисовку можно
   * пропускать, пока в реестре динамики никого. Сбрасывается событием
   * конфигурации — та освобождает карты, и очистку надо провести заново.
   */
  private dynamicIdle = false;
  /** Перерисовки кэша статики — пробник для тестов; картинка от него не зависит. */
  private rebuilds = 0;
  /**
   * Цикл времени суток (REND-32): один экземпляр на всю жизнь подсистемы, фазы
   * в нём переставляет применение секции. Пустой цикл — сцена без подсекции:
   * кадр тогда байт-в-байт тот же, что до появления REND-32.
   */
  private readonly cycle = new LightingCycle();
  /**
   * Чей ход на кадре перехода: кэш статики или карта динамики. Карта у источника
   * одна на кадр, и переход делит кадры между ними через один (`applyCycleSample`).
   */
  private cycleStaleFrame = false;

  constructor(options: LightingOptions = {}) {
    this.section = options.config;
    this.current = this.effective();
    this.extent = arenaExtent(options.grid);
    this.ambient.name = 'lighting:ambient';
    this.sun.name = 'lighting:sun';
    this.sunDynamic.name = 'lighting:sun-dynamic';
    // Кадром теневых карт правит подсистема, а не three: ровно один источник за
    // кадр получает `needsUpdate`, и кэш статики между событиями не трогается.
    this.sun.shadow.autoUpdate = false;
    this.sunDynamic.shadow.autoUpdate = false;
  }

  /** Действующая конфигурация — авторская секция под потолками пресета. */
  get config(): LightingRenderConfig {
    return this.current;
  }

  /** Перерисовки кэшированной карты статики с создания подсистемы (design D2). */
  get staticRebuilds(): number {
    return this.rebuilds;
  }

  /** Сколько корней каждого яруса в реестре — пробник классификации кастеров. */
  casterCount(tier: ShadowCasterTier): number {
    return tier === 'static' ? this.staticRoots.size : this.dynamicRoots.size;
  }

  /** Источники сцены — вход тестов и диагностики; сцене они принадлежат отсюда. */
  get lights(): {
    readonly ambient: THREE.AmbientLight;
    readonly sun: THREE.DirectionalLight;
    readonly sunDynamic: THREE.DirectionalLight;
  } {
    return { ambient: this.ambient, sun: this.sun, sunDynamic: this.sunDynamic };
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.scene.add(this.ambient);
    ctx.scene.add(this.sun);
    // Цель направленного источника — объект сцены: без неё матрица цели не
    // обновляется, и направление считалось бы от мирового нуля.
    ctx.scene.add(this.sun.target);
    this.applyResolved(this.current);
  }

  /**
   * Снос подсистемы (REND-31): построенные карты теней обоих источников с их
   * текстурами глубины — их three строит на первом теневом проходе и сам
   * никогда не освобождает (см. `releaseShadowMap`), — и сами источники со
   * сцены. Реестры кастеров чистятся здесь же: корни в них принадлежат
   * подсистемам-владельцам, а ссылки на них — этой (REND-30).
   */
  dispose(): void {
    for (const light of [this.sun, this.sunDynamic]) {
      releaseShadowMap(light);
      light.target.removeFromParent();
      light.removeFromParent();
    }
    this.ambient.removeFromParent();
    this.staticRoots.clear();
    this.dynamicRoots.clear();
  }

  /** Свет от тика не зависит: доставка presentation-состояния ему не адресована. */
  syncTick(): void {
    // намеренно пусто (REND-8): источники сцены живут конфигурацией, а не тиком
  }

  /**
   * Кадр подсистемы: продвигает цикл времени суток, решает, чья теневая карта
   * рисуется, и расставляет флаги кастеров под неё. Работа тут — событийная по
   * природе: в установившемся кадре это два присваивания `needsUpdate` и
   * инкремент счётчика, обход реестра идёт только при смене фазы или правке
   * реестра, а цикл на установившейся фазе не отдаёт даже значений.
   *
   * Цикл идёт ПЕРЕД решением теневого прохода: кадр перехода, сдвинувший
   * направление, обязан застать свой же `staticStale` этим кадром, а не
   * следующим (REND-32, design D3).
   */
  updateFrame(_dt: number, _alpha: number, realDt: number): void {
    if (this.ctx === null) return;
    const sample = this.cycle.step(realDt);
    if (sample !== null) this.applyCycleSample(sample);
    const cost = costSink();
    const mode = this.current.shadowMode;
    if (mode === 'none') {
      this.applyPhase('none');
      return;
    }
    if (mode === 'full') {
      this.applyPhase('full');
      this.sun.shadow.needsUpdate = true;
      this.staticStale = false;
      if (cost !== undefined) {
        // Карта одна и покадровая: оба яруса платят каждым кадром — ровно эта
        // разница с `hybrid` и читается диффом эталона (PERF-2).
        cost.lightingStaticCasters += this.staticRoots.size;
        cost.lightingDynamicCasters += this.dynamicRoots.size;
      }
      return;
    }
    if (this.staticStale) {
      // Кадр перерисовки кэша: динамическая карта его пропускает и остаётся
      // кадром старше — «двигая декорацию, автор видит её тень» (ED-15).
      const reflagged = this.applyPhase('static');
      this.sun.shadow.needsUpdate = true;
      this.sunDynamic.shadow.needsUpdate = false;
      this.staticStale = false;
      this.rebuilds++;
      if (cost !== undefined) {
        cost.lightingStaticCasters += this.staticRoots.size;
        cost.lightingStaticRebuilds++;
        // Кадр перехода переставил флаги и ярусу, чью карту не рисовал: работа
        // по числу его корней реальная, и эталон её видит (PERF-3, см. `quality`).
        if (reflagged && this.cycle.inTransition) {
          cost.lightingDynamicCasters += this.dynamicRoots.size;
        }
      }
      return;
    }
    const reflagged = this.applyPhase('dynamic');
    this.sun.shadow.needsUpdate = false;
    // Пустой реестр динамики — проход не рисуется вовсе: перерисовывать пустую
    // карту каждый кадр значило бы платить бинд и очистку цели ни за что. Один
    // завершающий проход после ухода последнего кастера карту очищает — иначе
    // в ней остался бы след ушедшего.
    const hasDynamic = this.dynamicRoots.size > 0;
    this.sunDynamic.shadow.needsUpdate = hasDynamic || !this.dynamicIdle;
    this.dynamicIdle = !hasDynamic;
    if (cost === undefined) return;
    cost.lightingDynamicCasters += this.dynamicRoots.size;
    // Та же добавка с другой стороны: кадр перехода обошёл и реестр статики.
    // Событийная перестановка флагов (правка реестра, смена режима) сюда не
    // попадает — она бывает раз на событие, а не каждым кадром.
    if (reflagged && this.cycle.inTransition) cost.lightingStaticCasters += this.staticRoots.size;
  }

  // ------------------------------------------------------- реестр кастеров

  setCaster(root: THREE.Object3D, tier: ShadowCasterTier): void {
    const mine = tier === 'static' ? this.staticRoots : this.dynamicRoots;
    const other = tier === 'static' ? this.dynamicRoots : this.staticRoots;
    const moved = other.delete(root);
    if (!moved && tier === 'dynamic' && mine.has(root)) {
      // Повторное объявление динамического корня в том же ярусе — обычный ход
      // всплеска открытия обзора (FOW-8): у записи сменилось поддерево
      // (заглушка → модель), а не ярус. Флаги ставятся точечно этому корню по
      // текущей фазе — глобальный обход реестра (`applyPhase`) на каждый такой
      // вызов был бы работой по числу ВСЕХ кастеров, а не пришедшего одного.
      // Динамическую карту следующий кадр и так перерисует.
      this.applyFlagsTo(root, tier);
      return;
    }
    // Статический корень повторной регистрации идёт общим путём намеренно:
    // его сменившееся поддерево обязано попасть в перерисовку кэша статики.
    mine.add(root);
    if (tier === 'static') this.staticStale = true;
    this.flagsStale = true;
  }

  dropCaster(root: THREE.Object3D): void {
    if (this.staticRoots.delete(root)) this.staticStale = true;
    this.dynamicRoots.delete(root);
  }

  invalidateStatic(): void {
    this.staticStale = true;
  }

  // ------------------------------------------------------- конфигурация

  /**
   * Правленая секция документа (PRES-2, ED-15). Смена значений света — событие
   * перерисовки кэша статики (design D2): в `hybrid` глобальный свет между
   * событиями статичен по построению.
   */
  applyConfig(section?: PresentationLighting): void {
    this.section = section;
    this.applyResolved(this.effective());
  }

  /**
   * Правленая сетка террейна (REND-14, ED-10): фрустумы теневых камер обтянуты
   * по границам арены, и другая сетка — другие границы и устаревший кэш.
   */
  applyGrid(grid: TerrainGrid): void {
    this.extent = arenaExtent(grid);
    this.applyResolved(this.current);
  }

  /**
   * Ручки подсистемы (QUAL-1). Новой ручки цикл времени суток (REND-32) не
   * заводит, но и константной вся его покадровая работа не объявляется — это
   * было бы неправдой (QUAL-3):
   *
   * - установившаяся фаза не делает ничего, а кадр перехода интерполирует
   *   фиксированный набор значений — это работа постоянного размера;
   * - НО в `hybrid` переход с движущимся направлением делит кадры между картами
   *   ярусов (`applyCycleSample`), а смена яруса переставляет флаги ОБОИМ
   *   реестрам кастеров (`applyPhase`) — и это уже работа по числу корней сцены,
   *   на каждом кадре перехода. Она видна счётчиками обоих ярусов —
   *   `lightingStaticCasters` и `lightingDynamicCasters` растут в `updateFrame`
   *   под условием `reflagged && this.cycle.inTransition`, — а не спрятана от
   *   эталона (PERF-3).
   *
   * Своей ручки эта работа не требует, потому что уже управляется объявленными:
   * `lighting.shadowMode` снимает её вовсе (`none` — теней нет, `full` — карта
   * одна и делить кадры не с чем), то есть потолок режима — тот самый рычаг, а
   * длина перехода и направления фаз — данные сцены (design D3, D5).
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: LIGHTING_SHADOW_MODE,
          cost: 'теневые проходы кадра: `none` — их нет, `hybrid` — покадрово рисуется только динамический ярус, `full` — все кастеры каждым кадром',
          semantics: 'ceiling',
          // Потолка нет — действует авторский режим секции: самый дорогой из
          // объявленных и есть «не ограничивать».
          default: 'full',
          values: PRESENTATION_SHADOW_MODES,
        },
        {
          name: LIGHTING_SHADOW_MAP_SIZE,
          cost: 'тексели карт теней: стоимость теневого прохода растёт квадратом стороны карты',
          semantics: 'ceiling',
          default: Number.POSITIVE_INFINITY,
          min: 256,
          max: 8192,
        },
      ],
    };
  }

  applyQuality(values: QualityValues): void {
    const mode = values.get(LIGHTING_SHADOW_MODE);
    this.modeCeiling = isShadowMode(mode) ? mode : 'full';
    const size = values.get(LIGHTING_SHADOW_MAP_SIZE);
    this.sizeCeiling = typeof size === 'number' ? size : Number.POSITIVE_INFINITY;
    this.applyResolved(this.effective());
  }

  // ------------------------------------------------------------- отладка

  /**
   * Отладочный источник освещения (`render-debug` RDBG-1, REND-27): подсистема
   * объявляет его в точке своей регистрации — свет сцены и решение теневого
   * прохода принадлежат ей, и никто, кроме неё, не знает, чья карта рисуется в
   * этом кадре.
   *
   * Доступ узкий и только на чтение: своей работы источник не заказывает и
   * счётчиков стоимости не двигает (RDBG-8) — он читает уже посчитанное кадром.
   */
  debugSources(): readonly DebugSource[] {
    return [
      lightingSceneDebugSource({
        state: (out) => {
          this.fillDebugState(out);
        },
      }),
    ];
  }

  /**
   * Состояние освещения в переиспользуемую запись отладки (RDBG-2). Позиции и
   * интенсивности берутся с ЖИВЫХ источников сцены — тех самых, которыми
   * нарисован кадр, а не вторым расчётом по конфигурации; тон берётся из
   * действующей конфигурации: `getHexString()` аллоцировал бы строку каждым
   * кадром (REND-26).
   *
   * На сцене без цикла (REND-32) это одно и то же — тоном конфигурации источники
   * и покрашены. С циклом покраска идёт фазами, и тон кадра расходится с тоном
   * конфигурации; дамп поэтому не выдаёт второй за первый, а называет рядом
   * авторские тона идущей фазы и долю перехода (`LightingCycle.fillDebug`).
   */
  private fillDebugState(out: DebugLightingState): void {
    // Без `init` источники в сцену не отданы, и кадр они не освещают: показывать
    // тогда нечего, и источник скажет это вслух (RDBG-6).
    out.inScene = this.ctx !== null;
    out.authoredSection = this.section !== undefined;
    if (this.ctx === null) return;
    const authored = resolveLightingConfig(this.section);
    const paired = this.sunDynamic.parent !== null;
    out.ambientLights = 1;
    out.directionalLights = paired ? 2 : 1;
    out.ambientColor = this.current.ambientColor;
    out.ambientIntensity = this.ambient.intensity;
    out.directionalColor = this.current.directionalColor;
    // Фаза цикла (REND-32, design D5) — своими полями и своим тоном поверх
    // статического: числа круга знает он, а не подсистема.
    this.cycle.fillDebug(out);
    out.sunIntensity = this.sun.intensity;
    out.sunDynamicIntensity = paired ? this.sunDynamic.intensity : 0;
    out.lightWorldX = this.sun.position.x;
    out.lightWorldY = this.sun.position.y;
    out.lightWorldZ = this.sun.position.z;
    out.targetWorldX = this.sun.target.position.x;
    out.targetWorldY = this.sun.target.position.y;
    out.targetWorldZ = this.sun.target.position.z;
    out.arenaRadiusWorldUnits = this.extent.radius;
    out.shadowFrustumHalfWorldUnits = this.sun.shadow.camera.right;
    out.shadowMode = this.current.shadowMode;
    out.authoredShadowMode = authored.shadowMode;
    out.ceilingShadowMode = this.modeCeiling;
    // Действующая сторона карты — та, что стоит у камеры источника: конфиг
    // округляется при применении, и показывать надо применённое.
    out.shadowMapTexels = this.sun.shadow.mapSize.x;
    out.authoredShadowMapTexels = authored.shadowMapSize;
    out.ceilingShadowMapTexels = this.sizeCeiling;
    out.staticShare = this.current.staticShare;
    out.shadowPhase = this.phase;
    out.staticCasterRoots = this.staticRoots.size;
    out.dynamicCasterRoots = this.dynamicRoots.size;
    out.staticRebuilds = this.rebuilds;
    out.staticStale = this.staticStale;
    // Карту строит теневой проход three: ноль — прохода ещё не было (headless-
    // прогон, режим `none`), и это ответ на «тени настроены, а их нет».
    out.builtShadowMaps =
      (this.sun.shadow.map === null ? 0 : 1) +
      (paired && this.sunDynamic.shadow.map !== null ? 1 : 0);
  }

  /**
   * Действующая конфигурация = авторская секция, ограниченная сверху потолками
   * пресета: `min` по рангу режима и `min` по стороне карты — и только они.
   * Потолок ВЫШЕ авторского значения картинку не улучшает.
   */
  private effective(): LightingRenderConfig {
    const authored = resolveLightingConfig(this.section);
    return {
      ...authored,
      shadowMode: minShadowMode(authored.shadowMode, this.modeCeiling),
      shadowMapSize: Math.min(authored.shadowMapSize, this.sizeCeiling),
    };
  }

  /** Общий шов применения: и правка секции автором, и потолки пресета — сюда. */
  private applyResolved(next: LightingRenderConfig): void {
    this.current = next;
    this.ambient.color.set(next.ambientColor);
    this.ambient.intensity = next.ambientIntensity;

    const hybrid = next.shadowMode === 'hybrid';
    const share = hybrid ? next.staticShare : 1;
    this.aimLight(this.sun, next, next.directionalIntensity * share);
    this.aimLight(this.sunDynamic, next, next.directionalIntensity * (1 - share));
    this.sun.castShadow = next.shadowMode !== 'none';
    this.sunDynamic.castShadow = hybrid;
    // Источник, переставший нести тени, отдаёт и свою карту: three держит её у
    // `shadow.map` до пересоздания и сам не освобождает, а пресет теней `none`
    // (QUAL-1) иначе оставлял бы в памяти текстуру глубины, которую больше
    // никто не рисует и не читает. Смена режима — событие, и пересоздать карту
    // на возврате дешевле, чем возить её выключенной.
    if (!this.sun.castShadow) releaseShadowMap(this.sun);
    if (!this.sunDynamic.castShadow) releaseShadowMap(this.sunDynamic);

    const scene = this.ctx?.scene;
    if (scene !== undefined) {
      // Второй источник существует ровно в `hybrid`: смена режима — событие, и
      // пересборка программ материалов на ней допустима, на кадре — нет.
      if (hybrid && this.sunDynamic.parent === null) {
        scene.add(this.sunDynamic);
        scene.add(this.sunDynamic.target);
      } else if (!hybrid && this.sunDynamic.parent !== null) {
        this.sunDynamic.removeFromParent();
        this.sunDynamic.target.removeFromParent();
      }
    }
    // Значения света сменились — кэш статики устарел вместе с ними, а фаза
    // пересчитывается заново: прежняя могла принадлежать другому режиму.
    this.phase = 'none';
    this.staticStale = true;
    this.flagsStale = true;
    this.dynamicIdle = false;

    // Применение секции — единственный событийный шов цикла (REND-32): круг
    // начинается с начала первой фазы, и её значения встают на источники сразу,
    // а не первым кадром — иначе сцена с циклом показала бы один кадр
    // статической частью секции.
    this.cycleStaleFrame = false;
    const first = this.cycle.reset(resolveLightingCycle(this.section));
    if (first !== null) this.applyCycleSample(first);
  }

  /**
   * Значения кадра цикла — на живые источники (REND-32, design D2). Фрустум
   * теневой камеры, сторона карты и смещения выборки здесь не трогаются: от
   * направления света они не зависят, а пересчитывать их кадром значило бы
   * платить событием за картинку.
   */
  private applyCycleSample(sample: LightingCycleSample): void {
    this.ambient.color.copy(sample.ambientColor);
    this.ambient.intensity = sample.ambientIntensity;
    this.sun.color.copy(sample.directionalColor);
    this.sunDynamic.color.copy(sample.directionalColor);
    // Доля статики применяется к УЖЕ слерпленной суммарной интенсивности: пара
    // ярусов светит как один источник на любом кадре перехода (REND-30).
    const share = this.current.shadowMode === 'hybrid' ? this.current.staticShare : 1;
    this.sun.intensity = sample.directionalIntensity * share;
    this.sunDynamic.intensity = sample.directionalIntensity * (1 - share);
    const { directionX: dx, directionY: dy, directionZ: dz } = sample;
    this.aimDirection(this.sun, dx, dy, dz);
    this.aimDirection(this.sunDynamic, dx, dy, dz);
    // Карта глубины зависит от направления, а не от тона: кэш статики устаревает
    // ровно тогда, когда источник поехал, и стоимость этого видна счётчиками
    // (PERF-3), а не спрятана от них.
    if (!sample.directionMoved) return;
    if (!this.cycle.inTransition) {
      // Установившаяся фаза добивает кэш ТОЧНЫМ направлением фазы — один кадр на
      // границу слота, и дальше кэш снова событиен, как без цикла (REND-30).
      this.cycleStaleFrame = false;
      this.staticStale = true;
      return;
    }
    // Кадр перехода поднимает устаревание ЧЕРЕЗ ОДИН, а не каждым: карта у
    // источника одна на кадр (см. заголовок), и кадр перерисовки кэша пропускает
    // обновление динамической. Подними мы устаревание каждым кадром перехода,
    // покадровая карта динамики не рисовалась бы весь переход — тени бойцов
    // застыли бы на всю его длину, а это и есть та самая оторвавшаяся от кадра
    // тень, которой REND-32 быть не велит. Через один обе карты отстают не
    // больше чем на кадр: за кадр направление проходит сотые доли дуги перехода.
    this.cycleStaleFrame = !this.cycleStaleFrame;
    if (this.cycleStaleFrame) this.staticStale = true;
  }

  /**
   * Позиция и цель источника по направлению — то единственное, что переставляет
   * кадр перехода (design D2): работа фиксированного размера, без аллокаций.
   * Числа приходят врозь, а не записью: наводится источник одним путём и от
   * статической части секции, и от кадра цикла (REND-32), а общего им — ровно
   * эта тройка.
   */
  private aimDirection(light: THREE.DirectionalLight, dx: number, dy: number, dz: number): void {
    const length = Math.hypot(dx, dy, dz);
    // Нулевое направление — вырожденная секция: источник тогда светит сверху,
    // а не исчезает; отвергать её — дело валидации формата (PRES-2).
    const unit = length > 0 ? 1 / length : 0;
    const distance = this.extent.radius * 2;
    light.position.set(
      this.extent.centerX + dx * unit * distance,
      this.extent.centerY + dy * unit * distance,
      length > 0 ? dz * unit * distance : distance,
    );
    light.target.position.set(this.extent.centerX, this.extent.centerY, 0);
    light.target.updateMatrixWorld();
  }

  /** Позиция, цель, тон и фрустум теневой камеры одного источника (design D6). */
  private aimLight(
    light: THREE.DirectionalLight,
    config: LightingRenderConfig,
    intensity: number,
  ): void {
    light.color.set(config.directionalColor);
    light.intensity = intensity;
    this.aimDirection(light, config.directionX, config.directionY, config.directionZ);

    const distance = this.extent.radius * 2;
    const radius = this.extent.radius * (1 + FRUSTUM_MARGIN);
    const camera = light.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.near = 0.5;
    camera.far = distance + radius * 2;
    camera.updateProjectionMatrix();
    resizeShadowMap(light, config.shadowMapSize);

    // Смещения выборки — производная фрустума и стороны карты (см. константы):
    // тексель камеры ортографический, то есть один и тот же по всей арене.
    const side = Math.max(1, Math.round(config.shadowMapSize));
    const texel = (radius * 2) / side;
    light.shadow.normalBias = texel * NORMAL_BIAS_TEXELS;
    // `bias` три складывает с нормированной глубиной приёмника, а глубина
    // ортографической камеры линейна по `far − near`: мировая поправка
    // становится долей этого отрезка. Знак отрицательный — приёмник надо
    // подвинуть К свету, иначе сравнение оставит его в собственной тени.
    light.shadow.bias = -((texel * DEPTH_BIAS_TEXELS) / (camera.far - camera.near));
  }

  /**
   * Флаги кастеров под фазу кадра; `true` — реестры обойдены этим вызовом.
   * Обход идёт ТОЛЬКО при смене фазы или правке реестра: в `hybrid` вне перехода
   * фаза меняется на перерисовке кэша и обратно, то есть на событии, а не на
   * кадре. На кадрах перехода цикла (REND-32) ярусы меняются местами каждым
   * кадром — этот обход и есть та покадровая работа, которую объявляет `quality`
   * и показывают счётчики `lightingStaticCasters`/`lightingDynamicCasters`
   * (`updateFrame`, ветви `hybrid`).
   */
  private applyPhase(next: ShadowPhase): boolean {
    if (next === this.phase && !this.flagsStale) return false;
    this.phase = next;
    this.flagsStale = false;
    const receive = next !== 'none';
    const staticCasts = next === 'static' || next === 'full';
    const dynamicCasts = next === 'dynamic' || next === 'full';
    for (const root of this.staticRoots) applyShadowFlags(root, staticCasts, receive);
    for (const root of this.dynamicRoots) applyShadowFlags(root, dynamicCasts, receive);
    return true;
  }

  /** Флаги одного корня по ТЕКУЩЕЙ фазе — точечный путь `setCaster` без обхода реестра. */
  private applyFlagsTo(root: THREE.Object3D, tier: ShadowCasterTier): void {
    const phase = this.phase;
    const receive = phase !== 'none';
    const casts =
      tier === 'static'
        ? phase === 'static' || phase === 'full'
        : phase === 'dynamic' || phase === 'full';
    applyShadowFlags(root, casts, receive);
  }
}

/** Значение ручки — режим теней; иначе потолка нет (QUAL-1). */
function isShadowMode(value: unknown): value is ShadowMode {
  return value === 'none' || value === 'hybrid' || value === 'full';
}

/**
 * Флаги теней всему поддереву корня: `castShadow`/`receiveShadow` три проверяет
 * на каждом меше, а корень — это то, что подсистема-владелец объявила кастером
 * (узел детального инстанса, группа батча, меш чанка террейна).
 */
function applyShadowFlags(root: THREE.Object3D, cast: boolean, receive: boolean): void {
  root.traverse((node) => {
    node.castShadow = cast;
    node.receiveShadow = receive;
  });
}

/**
 * Сторона карты теней. Смена — событие (правка секции, пресет): готовую карту
 * three по изменившемуся `mapSize` не пересоздаёт, поэтому прежняя
 * освобождается здесь вместе с её текстурой глубины.
 */
function resizeShadowMap(light: THREE.DirectionalLight, size: number): void {
  const side = Math.max(1, Math.round(size));
  if (light.shadow.mapSize.x === side && light.shadow.mapSize.y === side) return;
  light.shadow.mapSize.set(side, side);
  releaseShadowMap(light);
}

/**
 * Освобождает построенную карту теней источника вместе с её текстурой глубины.
 * Пустая карта (`null`) — обычное состояние источника, который ещё не рисовали:
 * three строит её на первом теневом проходе и сам никогда не освобождает.
 */
function releaseShadowMap(light: THREE.DirectionalLight): void {
  const map = light.shadow.map;
  if (map === null) return;
  map.depthTexture?.dispose();
  map.dispose();
  light.shadow.map = null;
}

/**
 * Границы арены из сетки террейна — точка входной границы (REND-1, TERR-2):
 * `tileSize` приходит в Q16.16, дальше только float.
 */
function arenaExtent(grid: TerrainGrid | undefined): ArenaExtent {
  if (grid === undefined) {
    return { centerX: 0, centerY: 0, radius: DEFAULT_ARENA_RADIUS };
  }
  const tile = grid.tileSize / FIXED_ONE;
  const width = grid.width * tile;
  const height = grid.height * tile;
  // Вырожденная сетка (нулевые размеры) не должна схлопывать фрустум в точку:
  // источник тогда стоял бы в центре арены и не светил бы вовсе.
  const radius = Math.max(Math.hypot(width, height) / 2, 1);
  return { centerX: width / 2, centerY: height / 2, radius };
}
