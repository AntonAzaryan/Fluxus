/**
 * Подсистема частиц (REND-24): ансамбли короткоживущих спрайтов, проигрывающие
 * эффект по его описанию — огонь, дым, искры, частицы дебафа, следы.
 *
 * Отдельная подсистема за общим контрактом (REND-8), а не ветка транзиентных
 * эффектов (REND-23): у частиц свой ассет (эмиттерный документ, `assets`
 * ASSET-14) и свой конвейер отрисовки (батчи three.quarks) — общего с
 * процедурными примитивами у них только ИСТОЧНИКИ. Источники и повторены
 * один-в-один, потому что второго способа связать симуляцию с изображением
 * рендер не заводит:
 *
 * - **оболочка типа** (`particles.byKind`): живёт, пока в доставленном
 *   состоянии есть сущность такого визуального типа (след снаряда);
 * - **оболочка состояния** (`particles.byState`): живёт, пока доставленные
 *   состояния сущности несут названное состояние (частицы отравления). Биты
 *   `EntityView.states` расшифровывает список `stateComponents` сборки — ТОТ ЖЕ,
 *   что у эффектов и камеры (REND-23, `camera` CAM-6): второго словаря
 *   состояний не появляется (REND-24);
 * - **выстрел** (`particles.byEvent`): reliable-событие тика запускает one-shot,
 *   он проигрывает свою длительность по ЧАСАМ КАДРА (SHELL-7) и возвращается в
 *   пул; повторно событие не проигрывается (OBS-5);
 * - **decoration-эмиттер** (REND-18, `presentation-scene` PRES-2): статичный
 *   источник (факел, костёр) приходит набором декораций своим входом. Единый
 *   механизм отрисовки decoration на эмиттерные виды не распространяется
 *   (REND-24): их изображение — частицы, и рисует их эта подсистема, а не
 *   подсистема моделей. Декларативность набора и устойчивость ключа — REND-18
 *   без изменений.
 *
 * Симуляция частиц — чистое представление: идёт по часам кадра, пользуется
 * недетерминированным рандомом библиотеки, и расхождение картинки между
 * клиентами дефектом не считается (REND-24). Симуляции подсистема не читает
 * (её вход — `TickView`, как у всех) и в picking не участвует (REND-15):
 * попасть лучом в частицу нельзя по построению.
 *
 * Часы у эмиттеров при этом РАЗНЫЕ (REND-38): оболочка сущности идёт часами
 * кадра, умноженными на её персональную шкалу времени (`EntityView.timeScale`,
 * `time-system` TIME-2) — замедленный герой и дымит замедленно, — а decoration
 * и выстрелы по событию идут общими часами. Отсюда по-эмиттерный шаг вместо
 * общего `BatchedRenderer.update` (см. `updateFrame`).
 *
 * Разрыв непрерывности (REND-2) гасит выстрелы и живые частицы ОБОЛОЧЕК
 * ПРЕЗЕНТАЦИОННОГО СОСТОЯНИЯ; оболочки восстанавливаются из доставленного
 * состояния сами — собственного игрового состояния у эмиттера нет. Набора
 * декораций разрыв не касается (REND-18): он приходит с потоком тиков, а
 * украшенная автором сцена украшена и по обе стороны переключения режима.
 *
 * ## Один батч-рендерер на сцену
 *
 * `BatchedRenderer` библиотеки один на сцену (REND-24): системы с одинаковым
 * конвейером (геометрия, материал, блендинг) сливаются в один `VFXBatch`, и
 * число draw calls растёт с числом КОНВЕЙЕРОВ, а не эмиттеров. Отсюда же
 * правило разворачивания документа: экземпляры эффекта — КЛОНЫ одного образца
 * (клон делит геометрию и материал), а не повторный разбор документа, который
 * завёл бы каждому экземпляру свой материал и свой батч.
 *
 * ## Ассет, разворачивание и пул
 *
 * Документ эффекта приезжает загруженным ассетом (`RenderContext.assets`,
 * ASSET-3, ASSET-6) — тем же входом, которым подсистема моделей получает
 * модели; библиотеку частиц модуль ассетов не знает (ASSET-14). В объекты
 * three.quarks документ разворачивается ЛЕНИВО, при первом использовании
 * записи, и кэшируется по идентичности документа: переподача манифеста с той же
 * ссылкой отдаёт тот же образец и ничего не пересобирает (REND-17).
 *
 * Экземпляры эффекта живут в пуле своего эффекта: отыгравший выстрел не
 * уничтожается, а гасится и возвращается в пул — аллокаций, растущих с числом
 * событий, нет (`clone()` на выстрел был бы ровно ими). Пул не освобождается
 * НАМЕРЕННО, как и пул мешей у эффектов: он ограничен пиком одновременных
 * эмиттеров сцены, а системы частиц остаются зарегистрированными в батче и
 * ничего не рисуют, пока приостановлены.
 *
 * Недоступный или невалидный эмиттерный ассет — предупреждение один раз и
 * пропуск записи, а не отказ кадра (REND-24, ASSET-6).
 */
import * as THREE from 'three';
import { BatchedRenderer } from 'three.quarks';
import type { EntityId } from '@fluxus/core';
import {
  resolveParticlesByEvent,
  resolveParticlesByKind,
  resolveParticlesByState,
  resolveVisualEmitter,
  type AssetState,
  type ParticleEffectDocument,
  type VisualManifest,
} from '@fluxus/assets';
import type { EntityView, QualityDeclaration, QualityValues, RenderContext, RenderEvent, RenderSubsystem, TickView } from '../types.js';
import { costSink, type RenderCostCounters } from '../cost.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import {
  ParticleEffectPool,
  ageInstance,
  instanceFinished,
  instanceParticles,
  ownBatchMaterials,
  restartInstance,
  setInstanceDensity,
  stepInstance,
  type EffectInstance,
} from '../particleEffects.js';
import { DyingInstances } from './particleDying.js';
import { dropSocketCache, type SocketSource } from '../particleSockets.js';
import { createWarnOnce, type WarnOnce } from '../warnOnce.js';
import { effectIdsOf, settleEffects } from './particlePrewarm.js';
import {
  createEmitterShellSet,
  publicShell,
  stepShells,
  type EmitterRecord,
  type EmitterShell,
} from './particleShell.js';
import {
  ShellSet,
  createStateReader,
  eventAgeSeconds,
  eventPointOf,
  shellKey,
  stateTableNames,
  syncShellSources,
  type EventPoint,
  type StateReader,
} from './shellSupport.js';

export type { SocketSource } from '../particleSockets.js';

/** Вид эмиттерного ассета в реестре загрузчиков (ASSET-14). */
const EFFECT_ASSET_KIND = 'particle-effect';

/**
 * Шаг тика по умолчанию, секунды — знаменатель возраста события (REND-24,
 * SHELL-4). Величина сборки, а не рендера: подсистеме её называет опция.
 */
const DEFAULT_TICK_SECONDS = 1 / 60;

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1): множитель плотности
 * частиц. Авторского источника у неё нет — документ эффекта задаёт эмиссию, а
 * множитель живёт поверх него, — поэтому семантика прямая, а не потолок
 * (design D3).
 */
const PARTICLES_DENSITY = 'particles.density';

/**
 * Пол множителя плотности (QUAL-2 через QUAL-3). Ноль ручка принимать не
 * вправе: эмиттер — ИЗОБРАЖЕНИЕ сущности (REND-37), и запись, у которой кроме
 * него ничего нет (зона урона босса), при нулевой эмиссии исчезла бы с экрана
 * — а состав доступной игроку информации от качества картинки не зависит.
 * Вчетверо реже документа — заметно дешевле и по-прежнему видимо.
 */
const PARTICLES_DENSITY_MIN = 0.25;

export interface ParticlesOptions {
  /**
   * Источник визуальной поверхности (REND-9): по нему эмиттер садится на рельеф,
   * как инстанс. Не задан — опорной высотой служит высота уровня (REND-7).
   */
  readonly surface?: VisualSurfaceSource;
  /**
   * Компоненты-состояния в порядке, которым Extractor сборки выставляет биты
   * `EntityView.states` (CAM-6, SHELL-2): по нему запись `particles.byState`
   * находит свой бит. Список не задан — оболочек состояния не бывает, и запись
   * таблицы получает предупреждение один раз, а не молчание.
   */
  readonly stateComponents?: readonly string[];
  /**
   * Источник узлов-сокетов (REND-24): без него записи с сокетом играют в
   * позиции сущности и говорят об этом один раз. Опцией, а не контекстом
   * (REND-8): контракт подсистем от сокетов не меняется. `undefined` — «не
   * задан», и дальше по конвейеру он и едет им же (`poseEmitterShell`).
   */
  readonly sockets?: SocketSource | undefined;
  /**
   * Длительность тика сборки в секундах — знаменатель возраста, с которым
   * выстрел стартует, когда доставка привозит события нескольких тиков
   * (SHELL-4). Не задана — {@link DEFAULT_TICK_SECONDS}.
   */
  readonly tickSeconds?: number;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/**
 * Результат прогрева подсистемы (REND-24): текстуры образцов для заливки на GPU
 * до первого кадра. Корней прогрев не отдаёт — образцы и батчи уже стоят в
 * сцене подсистемы и компилируются вместе с ней.
 */
export interface ParticlesPrewarm {
  /** Текстуры уже разобранных образцов — вход `WebGLRenderer.initTexture`. */
  readonly textures: readonly THREE.Texture[];
  /**
   * Те же текстуры после загрузки картинок документов (ASSET-4). Ждать этого
   * собирающий не обязан: прогрев тогда сделает меньше, но сделает.
   */
  texturesReady(): Promise<readonly THREE.Texture[]>;
}

/** Запрошенный эмиттерный ассет; `doc` пуст, пока он едет либо недоступен. */
interface EffectAsset {
  doc: ParticleEffectDocument | null;
}

export class ParticlesSubsystem implements RenderSubsystem {
  readonly name = 'particles';

  private manifest: VisualManifest;
  private readonly options: ParticlesOptions;
  /** Порядок состояний сборки — словарь битов `EntityView.states` (CAM-6). */
  private readonly stateComponents: readonly string[];
  /**
   * Несёт ли доставленное состояние сущности названное состояние (REND-24).
   * Читатель общий с подсистемой эффектов (`shellSupport.ts`): словарь битов
   * один на всех; своё здесь только предупреждение. Пустой список сюда не
   * доходит вовсе — его отсекает `syncShells`.
   */
  private readonly hasState: StateReader;
  /** О недоступном ассете и битом документе сказано один раз, а не на кадр. */
  private readonly warnOnce: WarnOnce;
  /** Точка разбираемого события; переиспользуется — аллокаций на выстрел нет. */
  private readonly eventPoint: EventPoint = { x: 0, y: 0 };

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  /** Один батч-рендерер на сцену (REND-24): батчи — его дети. */
  private readonly batchRenderer = new BatchedRenderer();
  /** Скольким батчам уже отключён луч (REND-15); новые появляются по мере эффектов. */
  private shieldedBatches = 0;

  /** Оболочки presentation-состояния — общий набор (`shellSupport.ts`). */
  private readonly shells: ShellSet<EmitterRecord, EffectInstance, EmitterShell>;
  /**
   * Оболочки декораций — ВТОРОЙ и независимый набор (REND-18): смена продюсера
   * гасит presentation-состояние, а декорации гасить нельзя.
   */
  private readonly decorationShells: ShellSet<EmitterRecord, EffectInstance, EmitterShell>;
  /** Проигрываемые выстрелы; отыгравшие возвращаются в пул тем же проходом. */
  private shots: EffectInstance[] = [];
  /**
   * ДОГОРАЮЩИЕ экземпляры погасших оболочек (REND-24, `particleDying.ts`):
   * источник исчез, эмиссия прекращена, а живые частицы доживают своё время.
   */
  private readonly dying = new DyingInstances();

  /** Документы эффектов по asset id (ASSET-3, ASSET-6). */
  private readonly assets = new Map<string, EffectAsset>();
  /** Разворачивание документов и пул экземпляров (`particleEffects.ts`). */
  private readonly pool: ParticleEffectPool;

  /** Последнее доставленное состояние: по нему считается поза кадра (REND-2). */
  private view: TickView | null = null;
  /** Кэш имён таблицы состояний манифеста; null — пересобрать (REND-17). */
  private stateNames: readonly string[] | null = null;
  /** Последний набор декораций: по нему пересводятся оболочки (REND-17). */
  private decorations: ReadonlyMap<EntityId, EntityView> | null = null;
  /** Множитель плотности от пресета качества (QUAL-1); 1 — эмиссия документа. */
  private density = 1;
  /** Длительность тика сборки — знаменатель возраста события (SHELL-4). */
  private readonly tickSeconds: number;

  /** Резолверы записей таблиц: строятся один раз, а не на каждую доставку. */
  private readonly byKind = (kind: string): EmitterRecord | undefined =>
    resolveParticlesByKind(this.manifest, kind);
  private readonly byState = (name: string): EmitterRecord | undefined =>
    resolveParticlesByState(this.manifest, name);

  constructor(manifest: VisualManifest, options: ParticlesOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.stateComponents = options.stateComponents ?? [];
    this.warnOnce = createWarnOnce(options.warn);
    this.hasState = createStateReader(this.stateComponents, (name) => {
      this.warnOnce(
        `state-bit:${name}`,
        `render: состояние "${name}" не зеркалируется Extractor'ом (stateComponents) — эмиттер не появится (REND-24)`,
      );
    });
    this.tickSeconds = options.tickSeconds ?? DEFAULT_TICK_SECONDS;
    this.group.name = 'particles';
    this.batchRenderer.name = 'particle-batches';
    this.pool = new ParticleEffectPool(this.batchRenderer, (key, message) => {
      this.warnOnce(key, message);
    });
    // Набор оболочек — общий механизм (`shellSupport.ts`); своё у подсистемы
    // ровно три ответа, и собраны они в одном месте (`particleShell.ts`).
    const hooks = {
      acquire: (effect: string) => this.acquire(effect, costSink()),
      retire: (instance: EffectInstance) => { this.retire(instance); },
      sockets: () => this.options.sockets,
      warnOnce: this.warnOnce,
    };
    this.shells = createEmitterShellSet(false, hooks);
    this.decorationShells = createEmitterShellSet(true, hooks);
  }

  init(ctx: RenderContext): void {
    // Корень подсистемы обязан быть НАСТОЯЩЕЙ сценой: `ParticleSystem.update`
    // библиотеки само-уничтожает систему, у которой корень эмиттера — не
    // `Scene` (см. шапку `stepInstance`), и пул тогда мёртв навсегда. Провал
    // здесь громкий и на сборке, а не молчаливой потерей частиц в кадре.
    if (!(ctx.scene as Partial<THREE.Scene>).isScene) {
      throw new Error(
        'ParticlesSubsystem: корень подсистемы обязан быть THREE.Scene — библиотека частиц уничтожает системы вне сцены (REND-24)',
      );
    }
    this.ctx = ctx;
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    ctx.scene.add(this.group);
    ctx.scene.add(this.batchRenderer);
  }

  /**
   * Снос подсистемы (REND-31): живые оболочки и выстрелы возвращаются в пул, а
   * он отдаёт экземпляры и батчи средствами библиотеки. Своего в GPU у
   * подсистемы больше нет: сокеты — узлы чужих инстансов (REND-24), а
   * разобранные документы эффектов принадлежат кэшу ассетов.
   */
  dispose(): void {
    this.dropShots();
    // Оболочки заканчиваются ТЕМ ЖЕ путём, что при сведении: пустое множество
    // живых ключей гасит их все, и второго «удалить всё» не заводится.
    this.shells.clear();
    this.decorationShells.clear();
    // Догорающие, которых сведение только что и породило, — в пул: их доживание
    // кончилось сносом, а не концом эмиссии (REND-31).
    this.dying.dropAll((instance) => { this.pool.release(instance); });
    this.pool.dispose();
    this.shieldedBatches = 0;
    this.batchRenderer.removeFromParent();
    this.group.removeFromParent();
  }

  /**
   * Сведение с доставленным тиком (REND-24): оболочки — с набором сущностей,
   * выстрелы — с событиями честного прохода. Разрыв непрерывности гасит
   * проигрываемое и живые частицы: доигрывать выстрел через перемотку нечего.
   */
  syncTick(view: TickView): void {
    // Сток читается ОДИН раз на доставку и уходит вниз параметром (PERF-3):
    // проверять его на каждой оболочке значило бы платить за учёт тем же, что
    // он мерит. Без стока это одно сравнение на весь обход.
    const cost = costSink();
    this.view = view;
    this.syncShells(view, cost);
    if (view.snapAll) {
      // Гашение — ПОСЛЕ сведения, а не до: сама эта доставка вправе убрать
      // сущность, и её оболочка уходит в догорающие ровно здесь (REND-24).
      // Погаси мы их раньше, догорающий, рождённый этим же сведением, пережил
      // бы разрыв непрерывности — а гасить он обязан всё нарисованное (REND-2).
      this.dropShots();
      this.dying.dropAll((instance) => { this.pool.release(instance); });
      this.restartShells();
    }
    if (!view.freshEvents) return;
    for (const event of view.events) {
      const record = resolveParticlesByEvent(this.manifest, event.type);
      if (record === undefined) continue;
      this.spawnShot(record.effect, record.scale ?? 1, event, view, cost);
    }
  }

  /**
   * Полный набор decoration-инстансов (REND-18). Рисуются этой подсистемой
   * ровно эмиттерные виды (REND-24): вид, чьё изображение — модель, разрешается
   * в `resolveVisualEmitter` пустым и остаётся подсистеме моделей.
   */
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    const cost = costSink();
    this.decorations = entities;
    const set = this.decorationShells;
    set.begin();
    let synced = 0;
    for (const view of entities.values()) {
      if (view.kind === null) continue;
      const record = resolveVisualEmitter(this.manifest, view.kind);
      if (record === undefined) continue;
      synced++;
      set.ensure(view, 'deco', record);
    }
    set.sweep();
    // Сведение источника — работа доставки (PERF-2): считаются источники С
    // ЗАПИСЬЮ, а не весь состав набора.
    if (cost !== undefined) cost.particlesShellsSynced += synced;
  }

  updateFrame(dt: number, alpha: number): void {
    // Сток кадра — один раз на вход, как и на доставке (PERF-3).
    const cost = costSink();
    this.poseShells(alpha, cost);
    // Мировые матрицы эмиттеров — ДО симуляции: библиотека берёт позу эмиттера
    // из `matrixWorld`, а обновляет её сама только на первом кадре системы.
    this.group.updateMatrixWorld();
    // Симуляция частиц необратима — обратный ход часов презентации (REND-25)
    // её ЗАМОРАЖИВАЕТ: отмотать эмиссию назад библиотеке нечем, а идти вперёд
    // в стоящем мире значило бы показывать движение, которого в нём нет.
    const step = Math.max(dt, 0);
    // Шаг ПО-ЭМИТТЕРНО, а не общим `BatchedRenderer.update(dt)`: темп есть
    // свойство сущности (REND-38), и одним числом на сцену его не выразить.
    // Чьи часы у какой оболочки, решает она сама (`stepShells`).
    stepShells(this.shells.values(), step, this.warnOnce, cost);
    stepShells(this.decorationShells.values(), step, this.warnOnce, cost);
    // Выстрел по событию (REND-24 byEvent) — образ момента мира, собственный
    // переход картинки: он идёт общими часами, тем более что сущность-источник
    // вправе не пережить тик своего события (REND-38).
    for (const shot of this.shots) stepInstance(shot, step, this.warnOnce);
    // Догорающие экземпляры погасших оболочек — теми же общими часами и по той
    // же причине: сущности за ними уже нет (REND-24, REND-38).
    this.dying.step(step, this.warnOnce);
    // И один проход по батчам — ровно то, чем `BatchedRenderer.update`
    // заканчивает свой цикл: батчирование от по-эмиттерного темпа не меняется
    // (REND-24), число батчей по-прежнему растёт с числом конвейеров.
    for (const batch of this.batchRenderer.batches) batch.update();
    this.collectShots(cost);
    this.dying.collect((instance) => { this.pool.release(instance); }, cost);
    this.shieldBatches();
  }

  /**
   * Правленый манифест целиком (REND-17, ED-15): оболочки пересводятся обычным
   * проходом по последнему доставленному состоянию и последнему набору
   * декораций — правило «какие эмиттеры существуют» одно, и второй его копии
   * для переподачи не заводится. Выстрелы переподача не трогает: они уже
   * проигрываются своим экземпляром.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    this.stateNames = null;
    // Кэш сокетов сбрасывается ЗАРАНЕЕ: правленая запись меняет ярус и модель
    // инстанса (REND-20, REND-3), а с ними и дерево узлов, — держаться за узел,
    // найденный в прежнем дереве, после переподачи нельзя (REND-17).
    this.dropSocketCaches();
    if (this.view !== null) this.syncShells(this.view, costSink());
    if (this.decorations !== null) this.syncDecorations(this.decorations);
  }

  /**
   * Прогрев по манифесту до первого кадра: каждый эффект, на который ссылаются
   * секции частиц (byKind/byState/byEvent) и эмиттерные виды (ASSET-14),
   * запрашивается, разворачивается в образец и получает один пул-экземпляр.
   * Синхронный разбор документа (`QuarksLoader.parse` — геометрии, материалы,
   * текстуры), клон образца и батч конвейера с его шейдером создаются здесь,
   * а не в кадре первого появления эффекта — в матче с туманом это кадр
   * всплеска открытия обзора (FOW-8). Прогретый экземпляр гасится в пул тем же
   * вызовом — не сыграв ни кадра эмиссии; счётчики стоимости не двигаются
   * (PERF-3 меряет доставку и кадр, прогрев живёт во времени загрузки).
   * Не доехавший документ прогрев не держит (ASSET-4): его запись сыграет
   * прежним ленивым путём.
   */
  prewarm(): Promise<ParticlesPrewarm> {
    const ctx = this.ctx;
    if (ctx === null) throw new Error('ParticlesSubsystem: init() не вызван (REND-8)');
    // Сбор ссылок и ожидание исхода загрузки — `particlePrewarm.ts`; здесь
    // только собственность подсистемы: `document` запускает запрос и подписку.
    return settleEffects(
      ctx.assets,
      EFFECT_ASSET_KIND,
      effectIdsOf(this.manifest),
      (id) => this.document(id) !== null,
      (id) => { this.warmEffect(id); },
    ).then(() => ({
      // Текстуры образцов — вход `initTexture` прогрева: заливка на GPU у
      // документа с картинкой (`fire-soft.png`) иначе ложится на первый draw.
      textures: this.pool.templateTextures(),
      texturesReady: () => this.pool.texturesReady(),
    }));
  }

  /** Развёртка, клон и батч эффекта — и сразу в пул, не сыграв ни кадра. */
  private warmEffect(id: string): void {
    const doc = this.assets.get(id)?.doc ?? null;
    if (doc === null) return;
    const instance = this.pool.acquire(id, doc, this.group);
    if (instance !== null) this.pool.release(instance);
    // Свежему батчу конвейера луч отключается той же точкой, что в кадре.
    this.shieldBatches();
  }

  /**
   * Ручки качества подсистемы (QUAL-1, QUAL-3): одна — множитель плотности.
   * Число живых частиц — покадровая работа библиотеки и вершины батча, и растёт
   * оно и с числом эмиттеров, и с эмиссией каждого (REND-24); множитель правит
   * вторую половину, не трогая первую: какие эмиттеры существуют, решают
   * доставленное состояние и манифест, а не пресет.
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: PARTICLES_DENSITY,
          cost: 'живые частицы: множитель эмиссии каждого эмиттера — вершины батчей и покадровая симуляция библиотеки (REND-24)',
          semantics: 'value',
          default: 1,
          min: PARTICLES_DENSITY_MIN,
          max: 4,
        },
      ],
    };
  }

  /**
   * Множитель плотности от контроллера качества (QUAL-1). Применяется ко всем
   * играющим экземплярам сразу и к каждому взятому из пула дальше — событием
   * смены пресета, а не кадром.
   */
  applyQuality(values: QualityValues): void {
    const density = values.get(PARTICLES_DENSITY);
    if (typeof density !== 'number' || density === this.density) return;
    this.density = density;
    for (const shell of this.shells.values()) setInstanceDensity(shell.instance, density);
    for (const shell of this.decorationShells.values()) setInstanceDensity(shell.instance, density);
    for (const shot of this.shots) setInstanceDensity(shot, density);
    // Догорающим множитель не ставится: эмиссии у них уже нет, а множитель
    // правит именно её (QUAL-1).
  }

  /** Сколько эмиттеров играет сейчас — вход отладки и тестов. */
  get activeCount(): number {
    return this.shells.size + this.decorationShells.size + this.shots.length;
  }

  /** Сколько экземпляров догорает сейчас (REND-24) — вход отладки и тестов. */
  get dyingCount(): number {
    return this.dying.size;
  }

  /** Сколько экземпляров заведено всего (пул + живые): по нему видно, что пул работает. */
  get pooledCount(): number {
    return this.pool.created;
  }

  /** Сколько батчей отрисовки завёл рендерер — им и наблюдается батчирование (REND-24). */
  get batchCount(): number {
    return this.batchRenderer.batches.length;
  }

  /**
   * Сколько частиц живо сейчас — вход отладки и тестов. Им и наблюдается
   * гашение живых частиц разрывом непрерывности (REND-2): эмиттер-оболочка
   * остаётся, а нарисованного за ней не остаётся ничего.
   */
  get particleCount(): number {
    let total = 0;
    for (const shell of this.shells.values()) total += instanceParticles(shell.instance);
    for (const shell of this.decorationShells.values()) total += instanceParticles(shell.instance);
    for (const shot of this.shots) total += instanceParticles(shot);
    // Догорающие считаются наравне: они НАРИСОВАНЫ (REND-24), и «частиц живо
    // сейчас» без них было бы неправдой — ровно той, из-за которой мгновенное
    // гашение оболочки и выглядело нормальным.
    return total + this.dying.particles;
  }

  /**
   * Эмиттер сущности — вход отладки и тестов. `source` называет источник
   * (`kind:<тип>` или `state:<состояние>`); без него отдаётся первый эмиттер
   * этой сущности в порядке создания. null — эмиттера нет.
   */
  emitterFor(
    entity: EntityId,
    source?: string,
  ): { readonly effect: string; readonly object: THREE.Object3D } | null {
    return publicShell(
      source === undefined ? this.shells.first(entity) : this.shells.get(shellKey(entity, source)),
    );
  }

  /** Эмиттер размещённой декорации (REND-18); нумерация набора своя. */
  decorationEmitterFor(
    entity: EntityId,
  ): { readonly effect: string; readonly object: THREE.Object3D } | null {
    return publicShell(this.decorationShells.get(shellKey(entity, 'deco')));
  }

  // ------------------------------------------------------------- оболочки

  private syncShells(view: TickView, cost: RenderCostCounters | undefined): void {
    // Имена таблицы состояний снимаются один раз на МАНИФЕСТ (кэш до
    // переподачи, REND-17), а не на доставку; пустой словарь сборки — законная
    // сборка без доставленных состояний, и таблица пропускается молча
    // (`stateTableNames`, та же трактовка, что у эффектов).
    const stateNames = (this.stateNames ??= stateTableNames(
      this.manifest.particles?.byState,
      this.stateComponents,
    ));
    const synced = syncShellSources(
      this.shells,
      view.entities.values(),
      stateNames,
      this.hasState,
      this.byKind,
      this.byState,
    );
    // Сведение источника — работа доставки (PERF-2): считаются источники С
    // ЗАПИСЬЮ, а не весь состав доставки.
    if (cost !== undefined) cost.particlesShellsSynced += synced;
  }

  /**
   * Источник оболочки исчез (REND-24): эмиссия ПРЕКРАЩАЕТСЯ, а живые частицы
   * доживают своё время (`particleDying.ts`). Экземпляр уходит не в пул, а в
   * список догорающих, и возвращается в пул сам — концом эмиссии и смертью
   * последней частицы.
   */
  private retire(instance: EffectInstance): void {
    this.dying.retire(instance);
  }

  /**
   * Поза эмиттеров в кадре. Привязанный к сокету следует МИРОВОЙ позе своего
   * узла (REND-24), прочие — интерполированной позиции сущности плюс опорная
   * высота поверхности, ровно как оболочки эффектов (REND-2, REND-9).
   */
  private poseShells(alpha: number, cost: RenderCostCounters | undefined): void {
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    // Оболочки обоих наборов — по одной позе на оболочку в кадре (REND-18);
    // счёт отдаёт сам набор. Систем частиц, которые шагаются следом, у каждой
    // оболочки СВОЁ число — его складывает шаг (`stepShells`), там же, где эта
    // работа и делается.
    const posed =
      this.shells.poseAll(alpha, heightStep, surface) +
      this.decorationShells.poseAll(alpha, heightStep, surface);
    if (cost !== undefined) cost.particlesShellsPosed += posed;
  }

  /**
   * Разрыв непрерывности гасит и живые частицы оболочек (REND-2, REND-24).
   *
   * Оболочек ПРЕЗЕНТАЦИОННОГО состояния — и только их: разрыв непрерывности
   * приходит с потоком тиков (перемотка, смена продюсера, вход и выход из
   * превью), а набор декораций от него независим (REND-18) — сцена, которую
   * автор украсил, украшена и до, и после переключения режима. Гасить факелы
   * ареной вместе с перемоткой значило бы поджигать их заново на каждом
   * переключении.
   */
  private restartShells(): void {
    for (const shell of this.shells.values()) restartInstance(shell.instance);
  }

  /** Кэш найденных узлов-сокетов обоих наборов — заново (REND-17). */
  private dropSocketCaches(): void {
    for (const shell of this.shells.values()) dropSocketCache(shell);
    for (const shell of this.decorationShells.values()) dropSocketCache(shell);
  }

  // -------------------------------------------------------------- выстрелы

  /**
   * Выстрел по событию (REND-24). Точка — координатные поля события, уже
   * приведённые к float на входной границе рендера (REND-1, `eventData.ts`):
   * делить здесь нечего. Нет координат — берётся позиция сущности события, а
   * нет и её — играть выстрел негде.
   */
  private spawnShot(
    effect: string,
    scale: number,
    event: RenderEvent,
    view: TickView,
    cost: RenderCostCounters | undefined,
  ): void {
    const point = this.eventPoint;
    if (!eventPointOf(event.type, event.data, view, point, this.warnOnce, 'REND-24')) return;
    const x = point.x;
    const y = point.y;
    const instance = this.acquire(effect, cost);
    if (instance === null) return;
    const surface = this.options.surface?.current ?? null;
    // Кватернион сбрасывает `acquire` пула — он же чинит наклон конуса эмиссии
    // у экземпляра, побывавшего сокетной оболочкой; выстрелу остаётся масштаб
    // ЗАПИСИ (ASSET-14) и позиция.
    instance.object.position.set(x, y, surface === null ? 0 : surface.heightAt(x, y));
    instance.object.scale.setScalar(scale);
    // Зацикленный документ, поставленный на событие, одноразовым не станет сам:
    // зацикливание снимается с ЭКЗЕМПЛЯРА выстрела, документ не трогается.
    for (const entry of instance.systems) entry.system.looping = false;
    this.shots.push(instance);
    // Возраст СОБЫТИЯ (SHELL-4): доставка вправе привезти события нескольких
    // тиков, и выстрел обязан начаться уже прожившим своё расстояние. Мировая
    // матрица эмиттера для догона нужна свежая — библиотека берёт позу оттуда,
    // а кадровое обновление матриц будет только в `updateFrame`.
    const age = eventAgeSeconds(view, event.tick, this.tickSeconds);
    if (age > 0) {
      instance.object.updateMatrixWorld(true);
      ageInstance(instance, age, this.warnOnce);
    }
  }

  /**
   * Отыгравшие выстрелы — в пул. Выстрел кончился, когда все его системы
   * доэмитировали свою длительность и последняя частица умерла; длительность
   * идёт по часам КАДРА (SHELL-7), а не по тикам.
   */
  private collectShots(cost: RenderCostCounters | undefined): void {
    if (this.shots.length === 0) return;
    // Проход по живым выстрелам — покадровая работа подсистемы (PERF-2):
    // просмотренные выстрелы и их системы. Отыгравший считается тоже — в этом
    // кадре он ещё шагал.
    if (cost !== undefined) cost.particlesShotsStepped += this.shots.length;
    let alive = 0;
    for (const shot of this.shots) {
      if (cost !== undefined) cost.particlesSystemsStepped += shot.systems.length;
      if (instanceFinished(shot)) {
        this.pool.release(shot);
        continue;
      }
      this.shots[alive++] = shot;
    }
    this.shots.length = alive;
  }

  private dropShots(): void {
    for (const shot of this.shots) this.pool.release(shot);
    this.shots.length = 0;
  }

  // ------------------------------------------------------- эффекты и пул

  /**
   * Экземпляр эффекта, готовый играть; null — ассет ещё не доехал, недоступен
   * или документ не разворачивается (предупреждение один раз и пропуск записи,
   * ASSET-6).
   */
  private acquire(effect: string, cost: RenderCostCounters | undefined): EffectInstance | null {
    const doc = this.document(effect);
    if (doc === null) return null;
    const instance = this.pool.acquire(effect, doc, this.group);
    // Экземпляр из пула хранит эмиссию прошлого употребления, а свежий клон —
    // документную: множитель плотности ставится здесь обоим (QUAL-1).
    if (instance !== null) setInstanceDensity(instance, this.density);
    // Считается ВЗЯТИЕ, а не частицы (design D3): рестарт систем и запись
    // множителя — работа по числу систем документа, и она детерминирована, в
    // отличие от эмиссии внутри них (PERF-3).
    if (instance !== null && cost !== undefined) cost.particlesInstancesAcquired++;
    return instance;
  }

  /**
   * Документ эффекта по asset id (ASSET-3): запрашивается один раз на ссылку и
   * доезжает подпиской — тем же входом, которым подсистема моделей получает
   * модели (ASSET-6). null — ещё грузится либо недоступен: запись пропускается
   * молча до отказа и с предупреждением один раз после него (REND-24).
   */
  private document(id: string): ParticleEffectDocument | null {
    const known = this.assets.get(id);
    if (known !== undefined) return known.doc;
    const asset: EffectAsset = { doc: null };
    this.assets.set(id, asset);
    const ctx = this.ctx;
    if (ctx === null) throw new Error('ParticlesSubsystem: init() не вызван (REND-8)');
    // Сам ЗАПРОС тоже способен отказать синхронно — например, когда тот же
    // адрес уже загружен под другим видом ассета (ASSET-3: ключ реестра — пара
    // «вид + формат», и модель по адресу эффекта — конфликт видов). Для
    // подсистемы это такая же негодная ссылка, как отказ загрузки, и ответ на
    // неё тот же: предупреждение один раз и пропуск записи, а не отказ кадра
    // (REND-24, ASSET-6) — исключение отсюда роняло бы весь кадровый цикл.
    try {
      const handle = ctx.assets.request<ParticleEffectDocument>(EFFECT_ASSET_KIND, id);
      ctx.assets.subscribe(handle, (state: AssetState<ParticleEffectDocument>) => {
        if (state.status === 'ready') {
          asset.doc = state.data;
        } else if (state.status === 'failed') {
          this.warnOnce(
            `effect:${id}`,
            `render: эмиттерный ассет "${id}" недоступен (${state.reason}) — запись пропущена (REND-24)`,
          );
        }
      });
    } catch (e) {
      this.warnOnce(
        `effect:${id}`,
        `render: эмиттерный ассет "${id}" не запрашивается (${e instanceof Error ? e.message : String(e)}) — запись пропущена (REND-24)`,
      );
    }
    // Подписка приносит текущее состояние немедленно (ASSET-4): уже загруженный
    // документ доступен на первом же обращении, а не со следующего кадра.
    return asset.doc;
  }

  /**
   * Луч сцены частиц не видит (REND-15): частица — изображение, а не сущность.
   * Батчи заводятся по мере появления новых конвейеров отрисовки, поэтому
   * проверяется их число, а не факт «один раз при инициализации».
   */
  private shieldBatches(): void {
    const batches = this.batchRenderer.batches;
    if (batches.length === this.shieldedBatches) return;
    // Обход идёт с НОВЫХ батчей, а не со всех: отключение луча идемпотентно, а
    // регистрация материалов в учёте (PERF-8) — нет, и повторная считала бы
    // один и тот же материал дважды.
    for (let i = this.shieldedBatches; i < batches.length; i++) {
      const batch = batches[i]!;
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
      batch.raycast = () => {};
      // Два материала батча строит библиотека, и учёт получает их здесь — по
      // факту появления батча, как ресурсы разобранного графа (REND-31, PERF-8).
      ownBatchMaterials(batch);
    }
    this.shieldedBatches = batches.length;
  }
}


