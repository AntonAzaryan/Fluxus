/**
 * Подсистема освещения сцены (REND-29) за контрактом REND-8: она владеет источниками
 * света арены и теневыми картами, а потребители рендера — демо-клиент и вьюпорт
 * редактора — своего света больше не заводят. Тождество их кадров (`editor`
 * ED-1) выполняется отсюда по построению, а не дисциплиной копирования чисел.
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
 * ## Один источник и одна карта — даже в `hybrid`
 *
 * Направленный источник сцены ОДИН во всех режимах, и карта теней у него одна.
 * Ярусы `hybrid` (REND-30) живут не в двух источниках, а в двух ЦЕЛЯХ ГЛУБИНЫ:
 * кэшированная глубина статики и покадровая глубина динамики сводятся в карту
 * источника поэлементным минимумом (`lighting/shadowComposite.ts`). Затенение в
 * `hybrid` от этого совпадает с `full` в точности — тень от одного лишь здания
 * так же темна, как от юнита, — а кэш статики остаётся событийным.
 *
 * Прежняя пара источников с делением интенсивности (`staticShare`) снята: она
 * давала половинную тень там, где ярус был один, и стоила каждому фрагменту
 * второго PCF-сэмплера и второго круга по источникам в каждом материале.
 *
 * Разделять кастеров между ярусами приходится флагом `castShadow`, а не слоями:
 * теневой проход three.js проверяет слои ГЛАВНОЙ камеры кадра
 * (`WebGLShadowMap.renderObject`), и слой на объекте различал бы его видимость в
 * кадре, а не в теневой карте. Механизм здесь такой: `shadow.autoUpdate`
 * выключен, флаги кастеров расставляются под ярус ЭТОГО кадра, а глубину этого
 * яруса рисует сам three — вызовом своего теневого прохода в подменённую цель.
 * Кадр перерисовки кэша поэтому пропускает обновление динамической глубины: она
 * остаётся кадром старше, и это единственное наблюдаемое следствие.
 *
 * ## Без порта рендерера `hybrid` исполняется как `full`
 *
 * Проходы сведения идут в кадре ПОДСИСТЕМЫ, до отрисовки сцены потребителем,
 * поэтому рендерер приходит опцией сборки (REND-8), как и камера кадра. Сборка,
 * которая его не дала, кэша статики не получает: подсистема поднимает флаги
 * ОБОИХ ярусов и отдаёт карту теневому проходу самого three — картинка та же,
 * что в `full`, и цена та же. Молчаливой разницы в картинке при этом нет ни на
 * кадр, а разница в цене видна счётчиками (PERF-3).
 *
 * ## Ярус кастера — производная данных
 *
 * Сама подсистема ярусов не назначает (REND-30): их сообщают владельцы объектов
 * (`ShadowCasterSink`) — подсистема моделей по происхождению инстанса и
 * анимации записи вида, подсистема террейна статикой своих чанков. Здесь только
 * реестр корней, флаги и решение, чью карту рисовать в этом кадре.
 *
 * ## Что живёт рядом, а не здесь
 *
 * Подсистема держит РЕШЕНИЯ — режим, фазу теневого прохода, ход цикла, — а
 * механика их исполнения разложена по соседним модулям тем же швом, каким там
 * же живут пул локальных источников (REND-33) и часы цикла (REND-32):
 * `lighting/optionalLights.ts` — полусферная подсветка и контровой источник
 * (REND-29), `lighting/blobShadows.ts` — контактные пятна режима `blob`
 * (REND-30), `lighting/shadowMaps.ts` — карты теней, их фрустумы и флаги
 * кастеров, `lighting/shadowComposite.ts` — цели ярусов и проход сведения
 * (REND-30), `lighting/arena.ts` — границы арены и наводка направленных
 * источников по ним.
 *
 * ## Цикл времени суток
 *
 * Необязательная подсекция `cycle` (REND-32) исполняется здесь же: часы и фазы —
 * в `lighting/cycle.ts`, а этот файл ставит значения кадра на ЖИВЫЕ источники,
 * мимо `applyResolved` (design D2). Покадровый вызов применения объявлял бы
 * событие перерисовки кэша статики и пересчитывал бы всё подряд; здесь же кадр
 * перехода трогает ровно то, что от направления зависит: фрустум теневой камеры
 * обтянут по коробке арены В ПРОСТРАНСТВЕ СВЕТА (design D6, L-9), поэтому
 * поехавшее направление его переобтягивает — и тем же событием устаревает кэш
 * статики. От тона и интенсивности не зависят ни фрустум, ни глубина (design D3).
 * Собственного чередования карт цикл при этом не ведёт — кадры делят между
 * ярусами ворота REND-30 в `updateFrame`, те же, что под потоком инвалидаций
 * пола.
 */
import * as THREE from 'three';
import type { TerrainGrid } from '@fluxus/core';
import type { PresentationLighting } from '@fluxus/assets';
import type {
  BlobCaster,
  BlobCasterSink,
  LightCarrier,
  LightCarrierSink,
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  ShadowCasterSink,
  ShadowCasterTier,
  ShadowPhase,
} from '../types.js';
import { costSink, type RenderCostCounters } from '../cost.js';
import { LIGHTING_MAX_LOCAL_LIGHTS, LocalLightPool, localLightsKnob } from '../lighting/localLights.js';
import type { DebugSource } from '../debug/contract.js';
import { lightingSceneDebugSource, type DebugLightingState } from '../debug/lightingSource.js';
import {
  minShadowMode,
  resolveLightingConfig,
  resolveLightingCycle,
  sameLightingConfig,
  sameLightingCycle,
  type LightingCycleConfig,
  type LightingRenderConfig,
  type ShadowMode,
} from '../lighting/config.js';
import { LightingCycle, type LightingCycleSample } from '../lighting/cycle.js';
import { fillLightingDebugState } from '../lighting/debugState.js';
import { ShadowComposite, type ShadowRendererLike } from '../lighting/shadowComposite.js';
import { aimDirectional, arenaExtent, type ArenaExtent } from '../lighting/arena.js';
import { BlobShadowField } from '../lighting/blobShadows.js';
import { OptionalLights } from '../lighting/optionalLights.js';
import {
  aimShadowLight,
  applyShadowBias,
  applyShadowFlags,
  fitShadowFrustum,
  isShadowMode,
  releaseShadowMap,
  shadowMapSizeKnob,
  shadowModeKnob,
  LIGHTING_SHADOW_MAP_SIZE,
  LIGHTING_SHADOW_MODE,
} from '../lighting/shadowMaps.js';

export interface LightingOptions {
  /**
   * Сетка террейна сцены — по её границам обтягиваются ортографические теневые
   * камеры (design D6): арена мала, и стабильный фрустум не даёт мерцания
   * текселей при движении камеры кадра. Нет сетки — умолчательный радиус.
   */
  readonly grid?: TerrainGrid;
  /** Секция `lighting` парного документа (PRES-2); нет — умолчания. */
  readonly config?: PresentationLighting;
  /**
   * Камера кадра — вход отбора активных локальных источников (REND-33, design
   * D3): важность источника меряется расстоянием до ТОЧКИ ВЗГЛЯДА камеры. Не
   * задана — точкой берётся центр арены: отбор остаётся определённым и
   * воспроизводимым, просто не следит за игроком (сборка без камеры — тесты,
   * вьюпорт авторинга, headless).
   *
   * Приходит опцией, а не контекстом (REND-8), по тому же основанию, что у
   * подсистемы моделей: контракт подсистем от отбора не меняется, а знать позу
   * камеры нужно ровно ей.
   */
  readonly camera?: THREE.Camera;
  /**
   * Рендерер — вход теневых проходов режима `hybrid` (REND-30): их подсистема
   * исполняет в СВОЁМ кадре, до отрисовки сцены потребителем, и своего рендерера
   * у неё нет. Приходит опцией по тому же основанию, что камера.
   *
   * Не задан — `hybrid` исполняется как `full`: карта одна, кастеры оба яруса,
   * теневой проход ведёт сам three. Картинка та же, кэша статики нет.
   */
  readonly renderer?: ShadowRendererLike;
}

export class LightingSubsystem
  implements RenderSubsystem, ShadowCasterSink, LightCarrierSink, BlobCasterSink
{
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
   * Необязательные источники секции (REND-29) — полусферная подсветка и
   * контровой свет: и их значения, и правило «нет подсекции — нет источника»
   * живут в `lighting/optionalLights.ts`.
   */
  private readonly optional = new OptionalLights();
  /**
   * Направленный источник сцены — ОДИН во всех режимах (REND-30). В `hybrid` он
   * несёт карту сведения двух ярусов, в `full` — покадровую карту всех кастеров,
   * в `none` и `blob` теней не несёт вовсе.
   */
  private readonly sun = new THREE.DirectionalLight();
  /**
   * Цели ярусов и проход сведения режима `hybrid` (REND-30) — механика в
   * `lighting/shadowComposite.ts`. Заводятся лениво, первым кадром режима с
   * портом рендерера: сцена другого режима не платит за них ни целью, ни
   * материалом.
   */
  private readonly composite = new ShadowComposite();
  /** Порт рендерера для теневых проходов (REND-30); нет — `hybrid` идёт как `full`. */
  private readonly renderer: ShadowRendererLike | undefined;
  /** Сетка арены — вход коробки, по которой обтянут фрустум (design D6, L-9). */
  private grid: TerrainGrid | undefined;

  /** Реестр корней нарисованного по ярусам — вход флагов и счётчиков. */
  private readonly staticRoots = new Set<THREE.Object3D>();
  private readonly dynamicRoots = new Set<THREE.Object3D>();
  /**
   * Контактные пятна режима `blob` (REND-30): реестр носителей, геометрия,
   * материал и инстанс-буфер — всё в `lighting/blobShadows.ts`.
   */
  private readonly blobs = new BlobShadowField();

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
   * Фазы, которые сейчас крутит цикл, — вход сравнения на применении (REND-32).
   * Правка секции, не тронувшая круг, часы не перезапускает: в редакторе
   * `applyConfig` зовётся после КАЖДОГО `submit()` любого документа (ED-15), и
   * перезапуск круга там означал бы возврат к «утру» на каждое нажатие клавиши.
   */
  private cycleConfig: LightingCycleConfig | undefined;
  /** Круг хоть раз применялся: до первого применения сравнивать не с чем. */
  private cycleApplied = false;
  /**
   * Локальные источники инстансов (REND-33): реестр носителей, пул источников
   * и отбор активных живут в `lighting/localLights.ts` — здесь только их
   * жизненный цикл вместе с подсистемой и порт, которым носители приходят.
   */
  private readonly local = new LocalLightPool();
  /** Камера кадра — точка взгляда для отбора активных источников (design D3). */
  private readonly camera: THREE.Camera | undefined;
  /** Переиспользуемая пирамида теневой камеры — выход порта (REND-21, REND-26). */
  private readonly frustum = new THREE.Frustum();

  constructor(options: LightingOptions = {}) {
    this.section = options.config;
    this.current = this.effective();
    this.grid = options.grid;
    // Шаг высоты приезжает конфигом рендера на `init`; до него коробка арены
    // знает только план — фрустум всё равно обтягивается заново применением.
    this.extent = arenaExtent(options.grid);
    this.camera = options.camera;
    this.renderer = options.renderer;
    this.ambient.name = 'lighting:ambient';
    this.sun.name = 'lighting:sun';
    // Кадром теневых карт правит подсистема, а не three: `needsUpdate` она
    // поднимает сама, и кэш статики между событиями не трогается.
    this.sun.shadow.autoUpdate = false;
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

  /** Пул локальных источников (REND-33) — вход тестов и диагностики. */
  get localLights(): LocalLightPool {
    return this.local;
  }

  /** Источники сцены — вход тестов и диагностики; сцене они принадлежат отсюда. */
  get lights(): {
    readonly ambient: THREE.AmbientLight;
    readonly hemisphere: THREE.HemisphereLight;
    readonly rim: THREE.DirectionalLight;
    readonly sun: THREE.DirectionalLight;
  } {
    return {
      ambient: this.ambient,
      hemisphere: this.optional.hemisphere,
      rim: this.optional.rim,
      sun: this.sun,
    };
  }

  /**
   * Сведение ярусов режима `hybrid` (REND-30) — вход тестов и диагностики: цели
   * ярусов, карта сведения и проход. Пусто, пока режим с портом рендерера не
   * пришёл ни разу.
   */
  get shadowComposite(): ShadowComposite {
    return this.composite;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Коробка арены знает мировую высоту только с шагом конфига рендера
    // (REND-7): по ней обтягивается фрустум теневой камеры (design D6, L-9).
    this.extent = arenaExtent(this.grid, ctx.config.heightStep);
    this.local.init(ctx.scene);
    // Инстанс-меш пятен встанет в сцену первым кадром режима `blob`, а не
    // сейчас: сцена другого режима не платит за него ни узлом, ни буфером.
    this.blobs.init(ctx.scene);
    ctx.scene.add(this.ambient);
    ctx.scene.add(this.sun);
    // Цель направленного источника — объект сцены: без неё матрица цели не
    // обновляется, и направление считалось бы от мирового нуля.
    ctx.scene.add(this.sun.target);
    // Первое применение — БЕЗУСЛОВНОЕ: значения конфигурации на источники ещё
    // не ставились, и сравнивать их с ней самой было бы сравнением с тем, чего
    // в сцене нет (`applyResolved` иначе решил бы, что делать нечего).
    this.applyResolved(this.current, true);
  }

  /**
   * Снос подсистемы (REND-31): построенные карты теней обоих источников с их
   * текстурами глубины — их three строит на первом теневом проходе и сам
   * никогда не освобождает (см. `releaseShadowMap`), — и сами источники со
   * сцены. Реестры кастеров чистятся здесь же: корни в них принадлежат
   * подсистемам-владельцам, а ссылки на них — этой (REND-30).
   *
   * Тем же порядком уходит пул локальных источников с реестром носителей
   * (REND-33, design D6): носители принадлежат подсистемам-владельцам
   * инстансов, снесённым позже, — снимутся они сами, а здесь отдаётся то, чем
   * владеет эта подсистема.
   */
  dispose(): void {
    this.local.dispose();
    // Поле пятен владеет мешем, буфером инстансов, материалом, геометрией и
    // сгенерированной текстурой — всё это его точка освобождения (REND-31).
    this.blobs.dispose();
    // Цели сведения и проход — собственность подсистемы (REND-31); карту
    // источника они же и держали, поэтому отдаются до `releaseShadowMap`.
    this.composite.dispose();
    this.sun.shadow.map = null;
    releaseShadowMap(this.sun);
    this.sun.target.removeFromParent();
    this.sun.removeFromParent();
    this.ambient.removeFromParent();
    this.optional.dispose();
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
    // Сдвинул ли цикл источник ЭТИМ кадром. От этого — и устаревание кэша, и то,
    // платит ли кадр за ярус, чью карту он не рисовал: перестановка флагов от
    // ПОТОКА СОБЫТИЙ (мутация пола TERR-6, перетаскивание декорации) бывает
    // покадровой и без всякого цикла, и записывать её на цикл значило бы
    // удваивать счётчики там, где он ничего не сделал (PERF-3).
    const cycleMoved = sample?.directionMoved === true;
    if (sample !== null) this.applyCycleSample(sample);
    // Локальные источники (REND-33) — до ветвей режима теней: теней они не
    // отбрасывают, от режима не зависят вовсе, а ветка `none` до конца кадра не
    // доходит. Точка взгляда — камера кадра, нет её — центр арены (design D3).
    this.local.updateFrame(this.camera, this.extent.centerX, this.extent.centerY);
    const cost = costSink();
    const mode = this.current.shadowMode;
    if (mode !== 'blob') this.blobs.hide();
    if (mode === 'none' || mode === 'blob') {
      // Карт теней в обоих режимах нет вовсе: фаза `none` снимает флаги кастеров
      // обоих ярусов. В `blob` статика теней не отбрасывает, а динамика
      // рисуется пятнами (REND-30); приёмник пятен — террейн, и приходит
      // изображение к нему основным проходом сцены, а не теневым.
      //
      // Сами пятна пишутся не здесь, а в `blobCastersPosed`: позы кадра ставит
      // владелец инстансов, зарегистрированный ПОЗЖЕ этой подсистемы, и написать
      // пятна сейчас значило бы поставить их по позам прошлого кадра.
      this.applyPhase('none');
      return;
    }
    if (mode === 'full') {
      this.updateFullShadows(cost);
      return;
    }
    this.updateHybridShadows(cost, cycleMoved);
  }

  /**
   * Кадр режима `full`: карта одна и покадровая — оба яруса платят каждым
   * кадром, и ровно эта разница с `hybrid` читается диффом эталона (PERF-2).
   */
  private updateFullShadows(cost: RenderCostCounters | undefined): void {
    this.applyPhase('full');
    this.sun.shadow.needsUpdate = true;
    this.staticStale = false;
    if (cost === undefined) return;
    cost.lightingStaticCasters += this.staticRoots.size;
    cost.lightingDynamicCasters += this.dynamicRoots.size;
  }

  /**
   * Кадр режима `hybrid`: кэш статики и покадровая карта динамики чередуются.
   *
   * Перерисовка кэша MUST NOT голодить динамическую карту (REND-30): кадр
   * статики допустим, только если предыдущий ею не был или динамики нет
   * вовсе. Под непрерывным потоком событий инвалидации (мутация пола каждый
   * тик, TERR-6, перетаскивание декорации в редакторе) фазы чередуются, и
   * каждая карта отстаёт не более чем на один свой пропущенный кадр. Без этих
   * ворот статика вытесняла бы динамику каждым кадром, и тени юнитов
   * застывали бы на всё время мутаций (`lightingDynamicCasters = 0` в
   * perf-секциях эталонов стоимости).
   */
  private updateHybridShadows(cost: RenderCostCounters | undefined, cycleMoved: boolean): void {
    // Сведение исполняется рендерером подсистемы (REND-30); нет порта — нет и
    // кэша статики: кадр идёт как `full` — оба яруса в одну карту теневым
    // проходом самого three. Картинка та же, цена другая, и видна она теми же
    // счётчиками (PERF-3).
    if (this.renderer === undefined) {
      this.updateFullShadows(cost);
      return;
    }
    if (this.staticStale && (this.phase !== 'static' || this.dynamicRoots.size === 0)) {
      this.rebuildStaticShadow(cost, cycleMoved);
      return;
    }
    const reflagged = this.applyPhase('dynamic');
    // Пустой реестр динамики — глубину рисовать не за чем: её цель уже пуста
    // (последний ушедший кастер стёрт завершающим проходом), а сведение всё
    // равно идёт — карта источника обязана нести кэш статики.
    const hasDynamic = this.dynamicRoots.size > 0;
    this.drawShadowTier('dynamic', hasDynamic || !this.dynamicIdle);
    this.dynamicIdle = !hasDynamic;
    if (cost === undefined) return;
    cost.lightingDynamicCasters += this.dynamicRoots.size;
    // Та же добавка с другой стороны: кадр, сдвинувший источник, обошёл и реестр
    // статики. Перестановка флагов, вызванная не циклом (правка реестра, смена
    // режима, поток инвалидаций пола), сюда не попадает — за неё платят те же
    // счётчики яруса, чья карта в этом кадре и рисуется.
    if (reflagged && cycleMoved) cost.lightingStaticCasters += this.staticRoots.size;
  }

  /**
   * Кадр перерисовки кэша статики: покадровая глубина динамики его пропускает и
   * остаётся кадром старше — «двигая декорацию, автор видит её тень» (ED-15).
   */
  private rebuildStaticShadow(cost: RenderCostCounters | undefined, cycleMoved: boolean): void {
    const reflagged = this.applyPhase('static');
    // Устаревание снимает не РЕШЕНИЕ перепечь, а состоявшийся проход: теневая
    // машинерия потребителя бывает выключена, а контекст — потерян, и заказ, о
    // котором нельзя сказать, что он исполнен, оставляет кэш устаревшим. Иначе
    // статика молча оставалась бы старой до следующего события инвалидации,
    // которого может не быть вовсе.
    const drawn = this.drawShadowTier('static', true);
    this.staticStale = !drawn;
    if (!drawn) return;
    this.rebuilds++;
    if (cost === undefined) return;
    cost.lightingStaticCasters += this.staticRoots.size;
    cost.lightingStaticRebuilds++;
    // Кадр, на котором цикл сдвинул источник, переставил флаги и ярусу, чью
    // карту не рисовал: работа по числу его корней реальная, и эталон её
    // видит (PERF-3, см. `quality`).
    if (reflagged && cycleMoved) cost.lightingDynamicCasters += this.dynamicRoots.size;
  }

  /**
   * Глубина яруса ЭТОГО кадра в его цель и сведение обоих в карту источника
   * (REND-30). Флаги кастеров уже расставлены вызывающим — здесь только проходы.
   *
   * `draw` — рисовать ли глубину этого яруса вообще: пустой реестр динамики
   * перерисовывать не за чем, а сведение идёт всё равно, иначе карта источника
   * осталась бы от прошлого кадра.
   *
   * Первый кадр целей рисует ОБА яруса: во второй цели до её первого прохода
   * лежит не «пустая глубина», а то, что оставил драйвер, и сводить её нельзя.
   * Стоит это одного лишнего прохода на создание целей — то есть на смену
   * стороны карты или режима, а не на кадр.
   */
  private drawShadowTier(tier: ShadowCasterTier, draw: boolean): boolean {
    const renderer = this.renderer;
    const ctx = this.ctx;
    if (renderer === undefined || ctx === null) return false;
    this.composite.resize(this.current.shadowMapSize);
    // Камера кадра нужна теневому проходу three только для проверки слоёв
    // объектов; её нет — годится камера самого источника (слои по умолчанию).
    const camera = this.camera ?? this.sun.shadow.camera;
    if (!this.composite.primed) {
      const other: ShadowCasterTier = tier === 'static' ? 'dynamic' : 'static';
      this.applyPhase(other === 'static' ? 'static' : 'dynamic');
      this.composite.renderTier(renderer, ctx.scene, camera, this.sun, other);
      this.applyPhase(tier === 'static' ? 'static' : 'dynamic');
    }
    const drawn = draw ? this.composite.renderTier(renderer, ctx.scene, camera, this.sun, tier) : true;
    this.composite.composite(renderer, this.sun);
    return drawn;
  }

  // ------------------------------------------------------- реестр кастеров

  setCaster(root: THREE.Object3D, tier: ShadowCasterTier): void {
    const mine = tier === 'static' ? this.staticRoots : this.dynamicRoots;
    const other = tier === 'static' ? this.dynamicRoots : this.staticRoots;
    const moved = other.delete(root);
    if (!moved && tier === 'dynamic') {
      // Динамический корень — точечный путь и на повторном объявлении, и на
      // ПЕРВОМ: повторное — обычный ход всплеска открытия обзора (FOW-8, у
      // записи сменилось поддерево «заглушка → модель», а не ярус), первое —
      // спавн юнита. В обоих случаях флаги ставятся адресно пришедшему корню по
      // текущей фазе, а глобальный обход реестра (`applyPhase`) был бы работой
      // по числу ВСЕХ кастеров вместо одного (design D7). Динамическую карту
      // следующий кадр и так перерисует.
      //
      // Фаза `none` исключением НЕ является, хотя её значение двойное — и «фазы
      // ещё не было» (умолчание, сброс на смене конфигурации), и установившийся
      // режим `none` пресета (QUAL-1). Адресный путь верен для обоих: флаги
      // снимаются (`applyFlagsTo` при `none` даёт cast = receive = false), а до
      // первого кадра реестр всё равно обходит первый же `applyPhase` — он
      // приходит с другой фазой и обход не пропускает.
      mine.add(root);
      this.applyFlagsTo(root, tier);
      return;
    }
    // Статический корень повторной регистрации идёт общим путём намеренно:
    // его сменившееся поддерево обязано попасть в перерисовку кэша статики.
    // Тем же путём идёт и смена яруса: флаги обеих карт пересчитываются.
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

  /**
   * Пирамида теневой камеры источника (REND-30, REND-21): по ней владелец
   * объектов решает судьбу инстанса, ушедшего за край кадра, — тень его обязана
   * остаться, если он попадает в теневую пирамиду.
   *
   * `null` — карт теней в режиме нет (`none`, `blob`): отсекать по ним нечего, и
   * владелец объектов остаётся с одной камерой кадра.
   *
   * Пирамида считается ЗДЕСЬ, а не берётся у прошедшего теневого прохода: до
   * первого прохода её у three ещё нет, а решение об отсечении принимается
   * раньше — в кадре владельца инстансов. Матрицы источника при этом
   * обновляются его же способом (`LightShadow.updateMatrices`), чтобы пирамида
   * была ровно та, из которой рисуется карта.
   */
  shadowFrustum(): THREE.Frustum | null {
    const mode = this.current.shadowMode;
    if (mode === 'none' || mode === 'blob') return null;
    // Мировые матрицы источника и его цели — вход `updateMatrices`: позиции им
    // ставит наводка (`aimDirectional`), а матрицы обновляются здесь.
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.updateMatrices(this.sun);
    // Своя копия, а не внутренняя пирамида three: та переписывается его же
    // теневым проходом на каждом кадре, и отданная наружу ссылка на неё
    // менялась бы под читателем. Копия переиспользуется (REND-26).
    return this.frustum.copy(this.sun.shadow.getFrustum());
  }

  // ------------------------------------------ носители контактных пятен

  /** Носитель контактного пятна (REND-30): инстанс динамического яруса. */
  setBlobCaster(caster: BlobCaster): void {
    this.blobs.add(caster);
  }

  dropBlobCaster(caster: BlobCaster): void {
    this.blobs.remove(caster);
  }

  /**
   * Позы кадра поставлены владельцем инстансов (REND-3) — момент, когда пятна
   * можно писать. Режим решается здесь и только здесь: владелец инстансов о
   * режиме теней не знает и знать не должен, он лишь называет момент.
   */
  blobCastersPosed(): void {
    if (this.ctx === null || this.current.shadowMode !== 'blob') return;
    // Число пятен за кадр — детерминированный счётчик (PERF-2): он растёт
    // составом доставки, а не временем и не состоянием GPU.
    const cost = costSink();
    const drawn = this.blobs.updateFrame();
    if (cost !== undefined) cost.lightingBlobDecals += drawn;
  }

  /** Носителей пятен в реестре — пробник тестов и диагностики (REND-30). */
  get blobCasterCount(): number {
    return this.blobs.casterCount;
  }

  /** Инстанс-меш контактных пятен; `null` — режима `blob` в этой сцене не было. */
  get blobShadows(): THREE.InstancedMesh | null {
    return this.blobs.instances;
  }

  // ------------------------------------------- носители локального света

  /**
   * Носитель локального света (REND-33): инстанс записи с блоком `light`
   * (ASSET-16). В реестр теневых кастеров он НЕ попадает ни при каком роде
   * источника — тени принадлежат направленному источнику (REND-30).
   */
  setLightCarrier(carrier: LightCarrier): void {
    this.local.add(carrier);
  }

  dropLightCarrier(carrier: LightCarrier): void {
    this.local.remove(carrier);
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
    // Применение БЕЗУСЛОВНОЕ: изменилась не конфигурация, а границы арены —
    // сравнение конфигураций про них ничего не знает, а наводка источников и
    // фрустумы теневых камер обтянуты именно по ним (design D6). Круга суток
    // это не касается: фазы те же, и часы идут дальше.
    this.applyResolved(this.current, true);
  }

  /**
   * Ручки подсистемы (QUAL-1). Новой ручки цикл времени суток (REND-32) не
   * заводит, но и константной вся его покадровая работа не объявляется — это
   * было бы неправдой (QUAL-3):
   *
   * - установившаяся фаза не делает ничего, а кадр перехода интерполирует
   *   фиксированный набор значений — это работа постоянного размера;
   * - НО в `hybrid` переход с движущимся направлением устаревает кэш статики
   *   КАЖДЫМ кадром, и ворота чередования REND-30 (см. `updateFrame`) делят
   *   кадры между картами ярусов. Смена яруса переставляет флаги ОБОИМ реестрам
   *   кастеров (`applyPhase`) — и это уже работа по числу корней сцены, на
   *   каждом кадре перехода. Она видна счётчиками обоих ярусов —
   *   `lightingStaticCasters` и `lightingDynamicCasters` растут в `updateFrame`
   *   под условием `reflagged && cycleMoved`, — а не спрятана от эталона
   *   (PERF-3).
   *
   * Своей ручки эта работа не требует, потому что уже управляется объявленными:
   * `lighting.shadowMode` снимает её вовсе (`none` — теней нет, `full` — карта
   * одна и делить кадры не с чем), то есть потолок режима — тот самый рычаг, а
   * длина перехода и направления фаз — данные сцены (design D3, D5).
   */
  quality(): QualityDeclaration {
    // Сами объявления — у механики, которую они меряют: режим и сторона карты
    // рядом с картами (`lighting/shadowMaps.ts`), потолок числа активных
    // локальных источников — рядом с пулом (REND-33, QUAL-3).
    return {
      subsystem: this.name,
      knobs: [shadowModeKnob(), shadowMapSizeKnob(), localLightsKnob()],
    };
  }

  applyQuality(values: QualityValues): void {
    const mode = values.get(LIGHTING_SHADOW_MODE);
    this.modeCeiling = isShadowMode(mode) ? mode : 'full';
    const size = values.get(LIGHTING_SHADOW_MAP_SIZE);
    this.sizeCeiling = typeof size === 'number' ? size : Number.POSITIVE_INFINITY;
    const locals = values.get(LIGHTING_MAX_LOCAL_LIGHTS);
    if (typeof locals === 'number') this.local.setCeiling(locals);
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
   * Состояние освещения в переиспользуемую запись отладки (RDBG-2). Что именно
   * туда кладётся, знает `lighting/debugState.ts` — здесь только то, ЧЕМ
   * нарисован кадр: живые источники, действующая конфигурация, авторская секция
   * и решения этой подсистемы.
   */
  private fillDebugState(out: DebugLightingState): void {
    fillLightingDebugState(
      {
        inScene: this.ctx !== null,
        section: this.section,
        config: this.current,
        ambient: this.ambient,
        sun: this.sun,
        optional: this.optional,
        cycle: this.cycle,
        extent: this.extent,
        modeCeiling: this.modeCeiling,
        sizeCeiling: this.sizeCeiling,
        phase: this.phase,
        staticRoots: this.staticRoots.size,
        dynamicRoots: this.dynamicRoots.size,
        staticRebuilds: this.rebuilds,
        staticStale: this.staticStale,
        // Цели сведения: две ярусов плюс карта — либо ноль, если сведения нет.
        compositeTargets: this.composite.map === null ? 0 : 3,
      },
      out,
    );
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

  /**
   * Общий шов применения: и правка секции автором, и потолки пресета — сюда.
   *
   * ПРИМЕНЕНИЕ ИДЕМПОТЕНТНО (REND-32, путь редактора ED-15): вход, ничего не
   * изменивший, не делает ничего. Это не оптимизация, а условие корректности:
   * применение метит кэш статики устаревшим, сбрасывает фазу теневого прохода и
   * перезапускает круг суток, а зовётся оно в редакторе после КАЖДОГО `submit()`
   * ЛЮБОГО документа — на сцене с четырёхфазным циклом каждое нажатие клавиши
   * возвращало бы «утро» и в `hybrid` форсировало бы перезапекание статики. Тем
   * же путём идёт смена пресета качества в матче: она не обязана трогать сутки.
   *
   * Сравниваются РАЗОБРАННЫЕ конфигурации, а не авторские секции: порядок
   * ключей документа и «поле не написано против поля с умолчанием» на кадр не
   * влияют, и различать их значило бы считать правкой то, что правкой не
   * является.
   *
   * `force` — применить, не сравнивая: первое применение (значений на
   * источниках ещё нет) и смена сетки арены (изменилась не конфигурация, а
   * границы, которых сравнение не видит).
   */
  private applyResolved(next: LightingRenderConfig, force = false): void {
    const cycle = resolveLightingCycle(this.section);
    // Круг суток сравнивается ОТДЕЛЬНО от остальной конфигурации: часы —
    // состояние, а не значение, и правка соседнего поля секции (или смена
    // сетки) не вправе их перезапускать.
    const sameCycle = this.cycleApplied && sameLightingCycle(cycle, this.cycleConfig);
    if (!force && sameCycle && sameLightingConfig(next, this.current)) return;
    this.current = next;
    this.ambient.color.set(next.ambientColor);
    this.ambient.intensity = next.ambientIntensity;
    this.optional.apply(this.ctx?.scene, this.extent, next.hemisphere, next.rim);

    // Интенсивность источника — АВТОРСКАЯ целиком (REND-30): делить её между
    // ярусами больше нечем и не за чем — карта одна, и тень в `hybrid` так же
    // темна, как в `full`.
    aimShadowLight(this.sun, this.extent, next, next.directionalIntensity);
    // Карты теней есть ровно у `hybrid` и `full` (REND-30): в `blob` их нет —
    // тени там рисуются контактными пятнами, — и источник их не несёт наравне с
    // режимом `none`.
    const composited = next.shadowMode === 'hybrid' && this.renderer !== undefined;
    this.sun.castShadow = next.shadowMode === 'hybrid' || next.shadowMode === 'full';
    // Источник, переставший нести тени, отдаёт и свою карту: three держит её у
    // `shadow.map` до пересоздания и сам не освобождает, а пресет теней `none`
    // (QUAL-1) иначе оставлял бы в памяти текстуру глубины, которую больше
    // никто не рисует и не читает. Смена режима — событие, и пересоздать карту
    // на возврате дешевле, чем возить её выключенной.
    //
    // Цели сведения уходят тем же правилом и по той же причине: режим, в
    // котором сведения нет (`full`, `blob`, `none` — и `hybrid` без порта
    // рендерера), не вправе держать в памяти три карты глубины. Карта источника
    // при этом снимается ВРУЧНУЮ: её отдал не three, а сведение, и оставить
    // ссылку значило бы отдать материалам сцены снесённую текстуру.
    if (!composited) {
      if (this.composite.map !== null) this.sun.shadow.map = null;
      this.composite.dispose();
    }
    if (!this.sun.castShadow) releaseShadowMap(this.sun);
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
    //
    // Но начинается он заново ТОЛЬКО когда изменились сами фазы. Круг с теми же
    // фазами продолжается с того места, где шёл, — а значения его текущего
    // положения переставляются на источники здесь же: выше на них легла
    // статическая часть секции, а установившаяся фаза кадром значений не отдаёт
    // (`step` вернёт `null`), и сцена осталась бы покрашенной мимо круга.
    this.cycleConfig = cycle;
    this.cycleApplied = true;
    const sample = sameCycle ? this.cycle.resample() : this.cycle.reset(cycle);
    if (sample !== null) this.applyCycleSample(sample);
  }

  /**
   * Значения кадра цикла — на живые источники (REND-32, design D2). Сторона
   * карты и смещения выборки здесь не трогаются — от направления они не зависят;
   * ФРУСТУМ зависит (design D6, L-9: он обтянут по коробке арены в пространстве
   * света) и переобтягивается ровно на кадре, где направление поехало.
   */
  private applyCycleSample(sample: LightingCycleSample): void {
    this.ambient.color.copy(sample.ambientColor);
    this.ambient.intensity = sample.ambientIntensity;
    // Необязательные источники ведёт фаза, но ЗАВОДИТ их статическая часть
    // (REND-32): источник уже в сцене, кадр меняет только числа — ни добавления,
    // ни снятия здесь не бывает, и пересборки программ материалов кадром тоже.
    this.optional.applySample(sample, this.extent);
    this.sun.color.copy(sample.directionalColor);
    // Интенсивность фазы — целиком на единственный источник (REND-30): делить
    // её между ярусами нечем, карта одна.
    this.sun.intensity = sample.directionalIntensity;
    const { directionX: dx, directionY: dy, directionZ: dz } = sample;
    aimDirectional(this.sun, this.extent, dx, dy, dz);
    // Фрустум — функция направления и коробки арены: поехало направление —
    // переобтягиваем, иначе кастеры у края арены уехали бы за его границу.
    // Смещения выборки следуют за фрустумом: тексель у него свой.
    if (sample.directionMoved) {
      fitShadowFrustum(this.sun, this.extent);
      applyShadowBias(this.sun, this.current.shadowMapSize);
    }
    // Карта глубины зависит от направления, а не от тона: кэш статики устаревает
    // ровно тогда, когда источник ПОЕХАЛ, — и на каждом таком кадре, включая
    // последний, добивающий кэш точным направлением установившейся фазы.
    //
    // Своего чередования цикл при этом не ведёт: делят кадры между картами
    // ворота REND-30 в `updateFrame` — кадр статики допустим, только если
    // предыдущий ею не был либо динамики нет вовсе. Устаревание липкое, поэтому
    // отклонённый воротами запрос не теряется, а ждёт своего кадра; собственное
    // чередование поверх ворот лишь вдвое разредило бы обновление кэша там, где
    // динамики нет, и жгло бы кадры на перестановку флагов ни за чем.
    if (sample.directionMoved) this.staticStale = true;
  }

  /**
   * Флаги кастеров под фазу кадра; `true` — реестры обойдены этим вызовом.
   * Обход идёт ТОЛЬКО при смене фазы или правке реестра: в `hybrid` без потока
   * событий фаза меняется на перерисовке кэша и обратно, то есть на событии, а
   * не на кадре. Там же, где устаревание приходит каждым кадром — переход цикла
   * (REND-32) или непрерывная мутация пола (TERR-6), — ворота чередования
   * REND-30 меняют ярусы местами покадрово, и этот обход становится покадровой
   * работой. Долю, вызванную циклом, объявляет `quality` и показывают счётчики
   * `lightingStaticCasters`/`lightingDynamicCasters` (`updateFrame`, ветви
   * `hybrid`, под `reflagged && cycleMoved`).
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
