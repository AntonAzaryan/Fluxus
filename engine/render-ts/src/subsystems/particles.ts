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
import { FIXED_ONE, type EntityId } from '@game-mvp/core';
import {
  resolveParticlesByEvent,
  resolveParticlesByKind,
  resolveParticlesByState,
  resolveVisualEmitter,
  type AssetState,
  type ParticleEffectDocument,
  type VisualManifest,
} from '@game-mvp/assets';
import type { EntityView, QualityDeclaration, QualityValues, RenderContext, RenderSubsystem, TickView } from '../types.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { VisualSurface } from '../visualSurface.js';
import {
  ParticleEffectPool,
  instanceFinished,
  instanceParticles,
  restartInstance,
  setInstanceDensity,
  type EffectInstance,
} from '../particleEffects.js';
import {
  dropSocketCache,
  resolveSocketNode,
  type SocketSource,
} from '../particleSockets.js';
import { createWarnOnce } from '../warnOnce.js';
import { createShellPose, createStateReader, poseShell } from './shellSupport.js';

export type { SocketSource } from '../particleSockets.js';

/** Пустой список имён состояний — чтобы тик без таблицы `byState` не аллоцировал. */
const NO_STATE_NAMES: readonly string[] = [];

/** Вид эмиттерного ассета в реестре загрузчиков (ASSET-14). */
const EFFECT_ASSET_KIND = 'particle-effect';

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1): множитель плотности
 * частиц. Авторского источника у неё нет — документ эффекта задаёт эмиссию, а
 * множитель живёт поверх него, — поэтому семантика прямая, а не потолок
 * (design D3).
 */
const PARTICLES_DENSITY = 'particles.density';

// Переиспользуемые между кадрами объекты — аллокаций на эмиттер на кадр нет.
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();

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
   * (REND-8): контракт подсистем от сокетов не меняется.
   */
  readonly sockets?: SocketSource;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/** Запрошенный эмиттерный ассет; `doc` пуст, пока он едет либо недоступен. */
interface EffectAsset {
  doc: ParticleEffectDocument | null;
}

/**
 * Что подсистеме нужно от записи любого рода: ссылка на эффект, необязательный
 * сокет и множитель масштаба. Записи двух родов — эмиттер секции `particles`
 * (ASSET-14) и эмиттерный decoration-вид (ASSET-9) — подходят сюда обе, и
 * сведение оболочек оттого одно на оба набора.
 */
interface EmitterRecord {
  readonly effect: string;
  readonly socket?: string;
  readonly scale?: number;
}

/**
 * Оболочка: эмиттер, привязанный к сущности доставленного состояния либо к
 * размещённой декорации. Записи манифеста она не держит — только разобранные
 * поля: сравнивать по ссылке нечего, редактор отдаёт документ разобранным
 * заново после каждой правки (REND-17).
 */
interface Shell {
  instance: EffectInstance;
  /** Ассет эффекта, которым оболочка играет сейчас. */
  effect: string;
  socketName: string | undefined;
  scale: number;
  /** Кэш найденного узла-сокета и корня, из которого он взят (`particleSockets.ts`). */
  socket: THREE.Object3D | null;
  socketRoot: THREE.Object3D | null;
  view: EntityView;
  readonly decoration: boolean;
}

/** Ключ оболочки: сущность плюс имя источника (тип или состояние). */
function shellKey(entity: EntityId, source: string): string {
  return `${String(entity)}|${source}`;
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
  private readonly hasState: (view: EntityView, name: string) => boolean;
  /** О недоступном ассете и битом документе сказано один раз, а не на кадр. */
  private readonly warnOnce: (key: string, message: string) => void;

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  /** Один батч-рендерер на сцену (REND-24): батчи — его дети. */
  private readonly batchRenderer = new BatchedRenderer();
  /** Скольким батчам уже отключён луч (REND-15); новые появляются по мере эффектов. */
  private shieldedBatches = 0;

  /** Оболочки presentation-состояния по ключу «сущность + источник». */
  private readonly shells = new Map<string, Shell>();
  /**
   * Оболочки декораций — ВТОРОЙ и независимый набор (REND-18): смена продюсера
   * гасит presentation-состояние, а декорации гасить нельзя.
   */
  private readonly decorationShells = new Map<string, Shell>();
  /** Переиспользуемый набор живых ключей: сведение без аллокаций на кадр. */
  private readonly liveShells = new Set<string>();
  /** Проигрываемые выстрелы; отыгравшие возвращаются в пул тем же проходом. */
  private shots: EffectInstance[] = [];

  /** Документы эффектов по asset id (ASSET-3, ASSET-6). */
  private readonly assets = new Map<string, EffectAsset>();
  /** Разворачивание документов и пул экземпляров (`particleEffects.ts`). */
  private readonly pool: ParticleEffectPool;
  /** Переиспользуемая поза оболочки: аллокаций на оболочку на кадр нет. */
  private readonly pose = createShellPose();

  /** Последнее доставленное состояние: по нему считается поза кадра (REND-2). */
  private view: TickView | null = null;
  /** Последний набор декораций: по нему пересводятся оболочки (REND-17). */
  private decorations: ReadonlyMap<EntityId, EntityView> | null = null;
  /** Множитель плотности от пресета качества (QUAL-1); 1 — эмиссия документа. */
  private density = 1;

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
    this.group.name = 'particles';
    this.batchRenderer.name = 'particle-batches';
    this.pool = new ParticleEffectPool(this.batchRenderer, (key, message) => {
      this.warnOnce(key, message);
    });
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    ctx.scene.add(this.group);
    ctx.scene.add(this.batchRenderer);
  }

  /**
   * Сведение с доставленным тиком (REND-24): оболочки — с набором сущностей,
   * выстрелы — с событиями честного прохода. Разрыв непрерывности гасит
   * проигрываемое и живые частицы: доигрывать выстрел через перемотку нечего.
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (view.snapAll) this.dropShots();
    this.syncShells(view);
    if (view.snapAll) this.restartShells();
    if (!view.freshEvents) return;
    for (const event of view.events) {
      const record = resolveParticlesByEvent(this.manifest, event.type);
      if (record === undefined) continue;
      this.spawnShot(record.effect, record.scale ?? 1, event.data, view);
    }
  }

  /**
   * Полный набор decoration-инстансов (REND-18). Рисуются этой подсистемой
   * ровно эмиттерные виды (REND-24): вид, чьё изображение — модель, разрешается
   * в `resolveVisualEmitter` пустым и остаётся подсистеме моделей.
   */
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    this.decorations = entities;
    const live = this.liveShells;
    live.clear();
    for (const view of entities.values()) {
      if (view.kind === null) continue;
      const record = resolveVisualEmitter(this.manifest, view.kind);
      if (record === undefined) continue;
      this.ensureShell(this.decorationShells, view, 'deco', record, live, true);
    }
    this.sweep(this.decorationShells, live);
  }

  updateFrame(dt: number, alpha: number): void {
    this.poseShells(alpha);
    // Мировые матрицы эмиттеров — ДО симуляции: библиотека берёт позу эмиттера
    // из `matrixWorld`, а обновляет её сама только на первом кадре системы.
    this.group.updateMatrixWorld();
    // Симуляция частиц необратима — обратный ход часов презентации (REND-25)
    // её ЗАМОРАЖИВАЕТ: отмотать эмиссию назад библиотеке нечем, а идти вперёд
    // в стоящем мире значило бы показывать движение, которого в нём нет.
    this.batchRenderer.update(dt > 0 ? dt : 0);
    this.collectShots();
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
    // Кэш сокетов сбрасывается ЗАРАНЕЕ: правленая запись меняет ярус и модель
    // инстанса (REND-20, REND-3), а с ними и дерево узлов, — держаться за узел,
    // найденный в прежнем дереве, после переподачи нельзя (REND-17).
    this.dropSocketCaches();
    if (this.view !== null) this.syncShells(this.view);
    if (this.decorations !== null) this.syncDecorations(this.decorations);
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
          min: 0,
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
  }

  /** Сколько эмиттеров играет сейчас — вход отладки и тестов. */
  get activeCount(): number {
    return this.shells.size + this.decorationShells.size + this.shots.length;
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
    return total;
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
    if (source !== undefined) return publicShell(this.shells.get(shellKey(entity, source)));
    for (const [key, shell] of this.shells) {
      if (key.startsWith(`${String(entity)}|`)) return publicShell(shell);
    }
    return null;
  }

  /** Эмиттер размещённой декорации (REND-18); нумерация набора своя. */
  decorationEmitterFor(
    entity: EntityId,
  ): { readonly effect: string; readonly object: THREE.Object3D } | null {
    return publicShell(this.decorationShells.get(shellKey(entity, 'deco')));
  }

  // ------------------------------------------------------------- оболочки

  private syncShells(view: TickView): void {
    const live = this.liveShells;
    live.clear();
    const states = this.manifest.particles?.byState;
    // Имена таблицы состояний снимаются один раз на тик, а не на сущность.
    // Пустой словарь сборки — ЛЕГАЛЬНАЯ сборка без доставленных состояний
    // (вьюпорт редактора: тика в кадре правки нет, ED-15), а не забытая
    // прокидка: оболочек состояния в ней не бывает по построению, и таблица
    // пропускается целиком — молча. Предупреждает `hasState` о другом: о списке,
    // который есть, но названного состояния не несёт.
    const stateNames =
      states === undefined || this.stateComponents.length === 0
        ? NO_STATE_NAMES
        : Object.keys(states);
    for (const entityView of view.entities.values()) {
      if (entityView.kind !== null) {
        const record = resolveParticlesByKind(this.manifest, entityView.kind);
        if (record !== undefined) {
          this.ensureShell(this.shells, entityView, `kind:${entityView.kind}`, record, live, false);
        }
      }
      for (const name of stateNames) {
        if (!this.hasState(entityView, name)) continue;
        const record = resolveParticlesByState(this.manifest, name);
        if (record === undefined) continue;
        this.ensureShell(this.shells, entityView, `state:${name}`, record, live, false);
      }
    }
    this.sweep(this.shells, live);
  }

  /** Оболочки, не помеченные живыми в этом сведении, гаснут и уходят в пул. */
  private sweep(shells: Map<string, Shell>, live: ReadonlySet<string>): void {
    for (const [key, shell] of shells) {
      if (live.has(key)) continue;
      this.pool.release(shell.instance);
      shells.delete(key);
    }
  }

  /** Создаёт оболочку источника либо обновляет существующую; помечает её живой. */
  private ensureShell(
    shells: Map<string, Shell>,
    view: EntityView,
    source: string,
    record: EmitterRecord,
    live: Set<string>,
    decoration: boolean,
  ): void {
    const key = shellKey(view.id, source);
    let shell = shells.get(key);
    // Другой эффект в записи — другой ассет и другой экземпляр: играть его
    // прежним нечем, и это не «мигание» (REND-17).
    if (shell !== undefined && shell.effect !== record.effect) {
      this.pool.release(shell.instance);
      shells.delete(key);
      shell = undefined;
    }
    if (shell === undefined) {
      const instance = this.acquire(record.effect);
      if (instance === null) return; // ассет не доехал или невалиден — пропуск
      shell = {
        instance,
        effect: record.effect,
        socketName: record.socket,
        scale: record.scale ?? 1,
        socket: null,
        socketRoot: null,
        view,
        decoration,
      };
      shells.set(key, shell);
    }
    shell.view = view;
    shell.scale = record.scale ?? 1;
    if (shell.socketName !== record.socket) {
      shell.socketName = record.socket;
      shell.socketRoot = null; // имя сокета правлено — ищем узел заново
      shell.socket = null;
    }
    live.add(key);
  }

  /**
   * Поза эмиттеров в кадре. Привязанный к сокету следует МИРОВОЙ позе своего
   * узла (REND-24), прочие — интерполированной позиции сущности плюс опорная
   * высота поверхности, ровно как оболочки эффектов (REND-2, REND-9).
   */
  private poseShells(alpha: number): void {
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    for (const shell of this.shells.values()) this.poseShell(shell, alpha, heightStep, surface);
    for (const shell of this.decorationShells.values()) {
      this.poseShell(shell, alpha, heightStep, surface);
    }
  }

  private poseShell(
    shell: Shell,
    alpha: number,
    heightStep: number,
    surface: VisualSurface | null,
  ): void {
    const object = shell.instance.object;
    // Масштаб — множитель ЗАПИСИ (ASSET-14) поверх множителя размещения
    // (REND-11, REND-18), и от сокета он не зависит: нормализация модели по
    // высоте — свойство инстанса, а размер эффекта назначает автор эффекта.
    object.scale.setScalar(shell.scale * (shell.view.scale ?? 1));
    const node = resolveSocketNode(shell, shell.view.id, this.options.sockets, (key, message) => {
      this.warnOnce(key, message);
    });
    if (node !== null) {
      // Мировая поза узла инстанса — каждый кадр: инстанс уже поставлен
      // подсистемой моделей, а мировая матрица узла обновляется по цепочке
      // родителей, не обходом сцены.
      node.updateWorldMatrix(true, false);
      node.matrixWorld.decompose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
      object.position.copy(SCRATCH_POSITION);
      object.quaternion.copy(SCRATCH_QUATERNION);
      return;
    }
    // Горизонталь — интерполяция двух доставленных тиков (REND-2), высота —
    // опорная высота визуальной поверхности либо ступень уровня (REND-7): то же
    // общее правило оболочек, что у эффектов (`shellSupport.ts`).
    const pose = this.pose;
    poseShell(shell.view, alpha, heightStep, surface, pose);
    object.position.set(pose.x, pose.y, pose.base);
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
   * Выстрел по событию (REND-24). Точка — координатные поля события; их
   * fixed-point приходится делить здесь, потому что схему события задаёт
   * контент (см. `RenderEvent.data` в `types.ts`). Нет координат — берётся
   * позиция сущности события, а нет и её — играть выстрел негде.
   */
  private spawnShot(
    effect: string,
    scale: number,
    data: Readonly<Record<string, number>>,
    view: TickView,
  ): void {
    let x: number;
    let y: number;
    if (data.x !== undefined && data.y !== undefined) {
      x = data.x / FIXED_ONE;
      y = data.y / FIXED_ONE;
    } else {
      const entity = data.entity ?? data.source;
      const entityView = entity === undefined ? undefined : view.entities.get(entity);
      if (entityView === undefined) return;
      x = entityView.currX;
      y = entityView.currY;
    }
    const instance = this.acquire(effect);
    if (instance === null) return;
    const surface = this.options.surface?.current ?? null;
    instance.object.position.set(x, y, surface === null ? 0 : surface.heightAt(x, y));
    instance.object.quaternion.identity();
    instance.object.scale.setScalar(scale);
    // Зацикленный документ, поставленный на событие, одноразовым не станет сам:
    // зацикливание снимается с ЭКЗЕМПЛЯРА выстрела, документ не трогается.
    for (const entry of instance.systems) entry.system.looping = false;
    this.shots.push(instance);
  }

  /**
   * Отыгравшие выстрелы — в пул. Выстрел кончился, когда все его системы
   * доэмитировали свою длительность и последняя частица умерла; длительность
   * идёт по часам КАДРА (SHELL-7), а не по тикам.
   */
  private collectShots(): void {
    if (this.shots.length === 0) return;
    let alive = 0;
    for (const shot of this.shots) {
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
  private acquire(effect: string): EffectInstance | null {
    const doc = this.document(effect);
    if (doc === null) return null;
    const instance = this.pool.acquire(effect, doc, this.group);
    // Экземпляр из пула хранит эмиссию прошлого употребления, а свежий клон —
    // документную: множитель плотности ставится здесь обоим (QUAL-1).
    if (instance !== null) setInstanceDensity(instance, this.density);
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
    for (const batch of batches) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
      batch.raycast = () => {};
    }
    this.shieldedBatches = batches.length;
  }
}

/** Публичный вид оболочки — эффект и его узел; null, если оболочки нет. */
function publicShell(
  shell: Shell | undefined,
): { readonly effect: string; readonly object: THREE.Object3D } | null {
  return shell === undefined ? null : { effect: shell.effect, object: shell.instance.object };
}


