/**
 * Подсистема освещения сцены за контрактом REND-8: она владеет источниками
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
 * Поэтому режим `hybrid` — ПАРА направленных источников с одинаковым
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
 * Сама подсистема ярусов не назначает: их сообщают владельцы объектов
 * (`ShadowCasterSink`) — подсистема моделей по происхождению инстанса и
 * анимации записи вида, подсистема террейна статикой своих чанков. Здесь только
 * реестр корней, флаги и решение, чью карту рисовать в этом кадре.
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
} from '../types.js';
import { costSink } from '../cost.js';
import {
  minShadowMode,
  resolveLightingConfig,
  type LightingRenderConfig,
  type ShadowMode,
} from '../lighting/config.js';

/**
 * Ручки качества подсистемы (QUAL-1, QUAL-3). Обе — ПОТОЛКИ над авторскими
 * значениями секции: пресет вправе удешевить тени, но не поднять их выше
 * авторских и не тронуть документ сцены (та же семантика, что у потолка
 * разрешения маски тумана, FOW-10).
 */
const LIGHTING_SHADOW_MODE = 'lighting.shadowMode';
const LIGHTING_SHADOW_MAP_SIZE = 'lighting.shadowMapSize';

/**
 * Фаза теневого прохода: чью карту подсистема рисует в этом кадре и, значит,
 * чьи кастеры сейчас подняты флагом. `none` — теней нет вовсе.
 */
type ShadowPhase = 'none' | 'static' | 'dynamic' | 'full';

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
  /** Перерисовки кэша статики — пробник для тестов; картинка от него не зависит. */
  private rebuilds = 0;

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

  /** Свет от тика не зависит: доставка presentation-состояния ему не адресована. */
  syncTick(): void {
    // намеренно пусто (REND-8): источники сцены живут конфигурацией, а не тиком
  }

  /**
   * Кадр подсистемы: решает, чья теневая карта рисуется, и расставляет флаги
   * кастеров под неё. Работа тут — событийная по природе: в установившемся
   * кадре это два присваивания `needsUpdate` и инкремент счётчика, обход
   * реестра идёт только при смене фазы или правке реестра.
   */
  updateFrame(): void {
    if (this.ctx === null) return;
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
      this.applyPhase('static');
      this.sun.shadow.needsUpdate = true;
      this.sunDynamic.shadow.needsUpdate = false;
      this.staticStale = false;
      this.rebuilds++;
      if (cost !== undefined) {
        cost.lightingStaticCasters += this.staticRoots.size;
        cost.lightingStaticRebuilds++;
      }
      return;
    }
    this.applyPhase('dynamic');
    this.sun.shadow.needsUpdate = false;
    this.sunDynamic.shadow.needsUpdate = true;
    if (cost !== undefined) cost.lightingDynamicCasters += this.dynamicRoots.size;
  }

  // ------------------------------------------------------- реестр кастеров

  setCaster(root: THREE.Object3D, tier: ShadowCasterTier): void {
    const mine = tier === 'static' ? this.staticRoots : this.dynamicRoots;
    const other = tier === 'static' ? this.dynamicRoots : this.staticRoots;
    if (other.delete(root)) this.staticStale = true;
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
  }

  /** Позиция, цель, тон и фрустум теневой камеры одного источника (design D6). */
  private aimLight(
    light: THREE.DirectionalLight,
    config: LightingRenderConfig,
    intensity: number,
  ): void {
    light.color.set(config.directionalColor);
    light.intensity = intensity;
    const length = Math.hypot(config.directionX, config.directionY, config.directionZ);
    // Нулевое направление — вырожденная секция: источник тогда светит сверху,
    // а не исчезает; отвергать её — дело валидации формата (PRES-2).
    const unit = length > 0 ? 1 / length : 0;
    const distance = this.extent.radius * 2;
    light.position.set(
      this.extent.centerX + config.directionX * unit * distance,
      this.extent.centerY + config.directionY * unit * distance,
      length > 0 ? config.directionZ * unit * distance : distance,
    );
    light.target.position.set(this.extent.centerX, this.extent.centerY, 0);
    light.target.updateMatrixWorld();

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
  }

  /**
   * Флаги кастеров под фазу кадра. Обход реестра идёт ТОЛЬКО при смене фазы или
   * правке реестра: в `hybrid` фаза меняется на перерисовке кэша и обратно, то
   * есть на событии, а не на кадре.
   */
  private applyPhase(next: ShadowPhase): void {
    if (next === this.phase && !this.flagsStale) return;
    this.phase = next;
    this.flagsStale = false;
    const receive = next !== 'none';
    const staticCasts = next === 'static' || next === 'full';
    const dynamicCasts = next === 'dynamic' || next === 'full';
    for (const root of this.staticRoots) applyShadowFlags(root, staticCasts, receive);
    for (const root of this.dynamicRoots) applyShadowFlags(root, dynamicCasts, receive);
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
