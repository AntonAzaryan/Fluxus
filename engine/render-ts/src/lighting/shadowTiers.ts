/**
 * Ярусы теневых кастеров (REND-30): реестр корней, флаги фазы и чередование
 * карт — механика, которую подсистема освещения ведёт своими РЕШЕНИЯМИ.
 *
 * Отдельным модулем тем же швом, каким рядом живут пул локальных источников
 * (`localLights.ts`), часы цикла (`cycle.ts`) и цели сведения
 * (`shadowComposite.ts`): подсистема (`subsystems/lighting.ts`) решает, какой
 * режим действует и сдвинул ли кадр источник, а ЧТО из этого следует для двух
 * реестров, флага `castShadow` каждого корня и очерёдности двух карт — здесь.
 *
 * Разделять кастеров между ярусами приходится флагом `castShadow`, а не слоями:
 * теневой проход three.js проверяет слои ГЛАВНОЙ камеры кадра
 * (`WebGLShadowMap.renderObject`), и слой на объекте различал бы его видимость в
 * кадре, а не в теневой карте. Механизм здесь такой: `shadow.autoUpdate`
 * выключен (его снимает подсистема), флаги кастеров расставляются под ярус
 * ЭТОГО кадра, а глубину этого яруса рисует сам three — вызовом своего теневого
 * прохода в подменённую цель. Кадр перерисовки кэша поэтому пропускает
 * обновление динамической глубины: она остаётся кадром старше, и это
 * единственное наблюдаемое следствие.
 *
 * Сама подсистема ярусов не назначает (REND-30): их сообщают владельцы объектов
 * (`ShadowCasterSink`) — подсистема моделей по происхождению инстанса и
 * анимации записи вида, подсистема террейна статикой своих чанков.
 */
import type * as THREE from 'three';
import type { RenderCostCounters } from '../cost.js';
import type { ShadowCasterTier, ShadowPhase } from '../types.js';
import { ShadowComposite, type ShadowRendererLike } from './shadowComposite.js';
import { applyShadowFlags } from './shadowMaps.js';

/** Постоянные входы ярусов: источник сцены и порты сборки (REND-8, REND-30). */
export interface ShadowTiersOptions {
  /**
   * Порт рендерера для теневых проходов режима `hybrid` (REND-30); нет —
   * `hybrid` исполняется как `full`: карта одна, кастеры обоих ярусов, проход
   * ведёт сам three.
   */
  readonly renderer?: ShadowRendererLike;
  /**
   * Камера кадра — вход теневого прохода three: ему она нужна только для
   * проверки слоёв объектов. Нет камеры — годится камера самого источника.
   */
  readonly camera?: THREE.Camera;
}

export class ShadowTiers {
  /** Реестр корней нарисованного по ярусам — вход флагов и счётчиков. */
  private readonly staticRoots = new Set<THREE.Object3D>();
  private readonly dynamicRoots = new Set<THREE.Object3D>();
  /**
   * Цели ярусов и проход сведения режима `hybrid` (REND-30) — механика в
   * `shadowComposite.ts`. Заводятся лениво, первым кадром режима с портом
   * рендерера: сцена другого режима не платит за них ни целью, ни материалом.
   */
  private readonly targets = new ShadowComposite();

  private phaseNow: ShadowPhase = 'none';
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
  private rebuildCount = 0;
  /** Сцена подсистемы; null — `init` ещё не звался либо прошёл снос. */
  private scene: THREE.Object3D | null = null;
  /** Направленный источник сцены — ОДИН во всех режимах (REND-30). */
  private readonly sun: THREE.DirectionalLight;
  private readonly options: ShadowTiersOptions;

  // Поля объявлены и присвоены отдельно, а не параметрами конструктора: снятие
  // типов Node (`--experimental-strip-types`, им запускаются бины демо и
  // редактора) не поддерживает parameter properties — они не стираются, а
  // требуют кодогенерации. В пакете их нет ни одной по этой же причине.
  constructor(sun: THREE.DirectionalLight, options: ShadowTiersOptions = {}) {
    this.sun = sun;
    this.options = options;
  }

  init(scene: THREE.Object3D): void {
    this.scene = scene;
  }

  /**
   * Снос (REND-31): цели сведения и проход — собственность подсистемы, и карту
   * источника держали они же, поэтому ссылка на неё снимается ВРУЧНУЮ. Корни
   * реестров принадлежат подсистемам-владельцам, а ссылки на них — этой.
   */
  dispose(): void {
    this.targets.dispose();
    this.sun.shadow.map = null;
    this.staticRoots.clear();
    this.dynamicRoots.clear();
    this.scene = null;
  }

  /** Цели и карта сведения (REND-30) — вход тестов, диагностики и подсистемы. */
  get composite(): ShadowComposite {
    return this.targets;
  }

  /** Фаза теневого прохода этого кадра — вход отладки (RDBG-2). */
  get phase(): ShadowPhase {
    return this.phaseNow;
  }

  /** Перерисовки кэшированной карты статики с создания подсистемы (design D2). */
  get rebuilds(): number {
    return this.rebuildCount;
  }

  /** Устарел ли кэш статики — вход отладки (RDBG-2). */
  get stale(): boolean {
    return this.staticStale;
  }

  /** Сколько корней яруса в реестре — пробник классификации кастеров. */
  count(tier: ShadowCasterTier): number {
    return tier === 'static' ? this.staticRoots.size : this.dynamicRoots.size;
  }

  /**
   * Значения света сменились (или сменилась сетка арены): кэш статики устарел
   * вместе с ними, а фаза пересчитывается заново — прежняя могла принадлежать
   * другому режиму.
   */
  reset(): void {
    this.phaseNow = 'none';
    this.staticStale = true;
    this.flagsStale = true;
    this.dynamicIdle = false;
  }

  /**
   * Режим без сведения (`full`, `blob`, `none` — и `hybrid` без порта
   * рендерера) не вправе держать в памяти три карты глубины. Карта источника
   * при этом снимается ВРУЧНУЮ: её отдал не three, а сведение, и оставить
   * ссылку значило бы отдать материалам сцены снесённую текстуру.
   */
  dropComposite(): void {
    if (this.targets.map !== null) this.sun.shadow.map = null;
    this.targets.dispose();
  }

  invalidate(): void {
    this.staticStale = true;
  }

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

  /**
   * Кадр режима с картами теней: чья карта рисуется и какие флаги подняты.
   * Режимы без карт (`none`, `blob`) сюда не приходят вовсе — их подсистема
   * закрывает фазой `none` (`applyPhase`).
   */
  updateFrame(
    mode: 'hybrid' | 'full',
    mapSize: number,
    cycleMoved: boolean,
    cost: RenderCostCounters | undefined,
  ): void {
    if (mode === 'full') {
      this.updateFull(cost);
      return;
    }
    this.updateHybrid(mapSize, cycleMoved, cost);
  }

  /**
   * Кадр режима `full`: карта одна и покадровая — оба яруса платят каждым
   * кадром, и ровно эта разница с `hybrid` читается диффом эталона (PERF-2).
   */
  private updateFull(cost: RenderCostCounters | undefined): void {
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
  private updateHybrid(
    mapSize: number,
    cycleMoved: boolean,
    cost: RenderCostCounters | undefined,
  ): void {
    // Сведение исполняется рендерером подсистемы (REND-30); нет порта — нет и
    // кэша статики: кадр идёт как `full` — оба яруса в одну карту теневым
    // проходом самого three. Картинка та же, цена другая, и видна она теми же
    // счётчиками (PERF-3).
    if (this.options.renderer === undefined) {
      this.updateFull(cost);
      return;
    }
    if (this.staticStale && (this.phaseNow !== 'static' || this.dynamicRoots.size === 0)) {
      this.rebuildStatic(mapSize, cycleMoved, cost);
      return;
    }
    const reflagged = this.applyPhase('dynamic');
    // Пустой реестр динамики — глубину рисовать не за чем: её цель уже пуста
    // (последний ушедший кастер стёрт завершающим проходом), а сведение всё
    // равно идёт — карта источника обязана нести кэш статики.
    const hasDynamic = this.dynamicRoots.size > 0;
    this.drawTier('dynamic', hasDynamic || !this.dynamicIdle, mapSize);
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
  private rebuildStatic(
    mapSize: number,
    cycleMoved: boolean,
    cost: RenderCostCounters | undefined,
  ): void {
    const reflagged = this.applyPhase('static');
    // Устаревание снимает не РЕШЕНИЕ перепечь, а состоявшийся проход: теневая
    // машинерия потребителя бывает выключена, а контекст — потерян, и заказ, о
    // котором нельзя сказать, что он исполнен, оставляет кэш устаревшим. Иначе
    // статика молча оставалась бы старой до следующего события инвалидации,
    // которого может не быть вовсе.
    const drawn = this.drawTier('static', true, mapSize);
    this.staticStale = !drawn;
    if (!drawn) return;
    this.rebuildCount++;
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
  private drawTier(tier: ShadowCasterTier, draw: boolean, mapSize: number): boolean {
    const renderer = this.options.renderer;
    const scene = this.scene;
    if (renderer === undefined || scene === null) return false;
    this.targets.resize(mapSize);
    // Камера кадра нужна теневому проходу three только для проверки слоёв
    // объектов; её нет — годится камера самого источника (слои по умолчанию).
    const camera = this.options.camera ?? this.sun.shadow.camera;
    if (!this.targets.primed) {
      const other: ShadowCasterTier = tier === 'static' ? 'dynamic' : 'static';
      this.applyPhase(other === 'static' ? 'static' : 'dynamic');
      this.targets.renderTier(renderer, scene, camera, this.sun, other);
      this.applyPhase(tier === 'static' ? 'static' : 'dynamic');
    }
    const drawn = draw ? this.targets.renderTier(renderer, scene, camera, this.sun, tier) : true;
    this.targets.composite(renderer, this.sun);
    return drawn;
  }

  /**
   * Флаги кастеров под фазу кадра; `true` — реестры обойдены этим вызовом.
   * Обход идёт ТОЛЬКО при смене фазы или правке реестра: в `hybrid` без потока
   * событий фаза меняется на перерисовке кэша и обратно, то есть на событии, а
   * не на кадре. Там же, где устаревание приходит каждым кадром — переход цикла
   * (REND-32) или непрерывная мутация пола (TERR-6), — ворота чередования
   * REND-30 меняют ярусы местами покадрово, и этот обход становится покадровой
   * работой. Долю, вызванную циклом, объявляет `quality` подсистемы и
   * показывают счётчики `lightingStaticCasters`/`lightingDynamicCasters`
   * (ветви `hybrid` выше, под `reflagged && cycleMoved`).
   */
  applyPhase(next: ShadowPhase): boolean {
    if (next === this.phaseNow && !this.flagsStale) return false;
    this.phaseNow = next;
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
    const phase = this.phaseNow;
    const receive = phase !== 'none';
    const casts =
      tier === 'static'
        ? phase === 'static' || phase === 'full'
        : phase === 'dynamic' || phase === 'full';
    applyShadowFlags(root, casts, receive);
  }
}
