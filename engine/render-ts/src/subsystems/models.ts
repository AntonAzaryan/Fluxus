/* eslint-disable max-lines --
   Подсистема моделей — самый большой модуль рендера, и метрика права: делить
   его пора. Но деление здесь — не перенос функций, а разбор ЖИЗНЕННОГО ЦИКЛА
   записи инстанса (`InstanceRecord`), вокруг которой в одном классе сошлись пул
   и сведение с доставкой (REND-3), два яруса отрисовки (REND-20), скины
   (REND-6), анимация с событиями (REND-4), поза с посадкой на поверхность
   (REND-9..REND-13), отсечение с выбором уровня (REND-22), fade (FOW-8),
   контактные пятна (REND-30) и прогрев программ (REND-31). Все они пишут в ОДНУ
   запись и читают её поля друг у друга, и граница между модулями прошла бы
   прямо по ней — сделав внутренность записи межмодульным контрактом. Это
   отдельная работа со своим планом и ревью, а не побочный результат прохода по
   линту: модуль оставлен целым намеренно, а его функции при этом приведены под
   порог когнитивной сложности.
*/
/**
 * Подсистема моделей (REND-3..6, REND-20..22): пул инстансов по сущностям
 * presentation-состояния.
 *
 * Появление сущности в presentation-состоянии создаёт инстанс, исчезновение —
 * убирает. Разделяемая часть ассета (геометрия, клипы, материалы, запечённые
 * производные `assets` ASSET-12) строится один раз и кэшируется здесь; инстансу
 * принадлежит только его состояние — трансформ, скин, анимационная фаза.
 *
 * Наружу инстанс виден ПРЕОБРАЗОВАНИЕМ И ГРАНИЦАМИ, а не узлом сцены (REND-3):
 * объём-прокси picking'а (REND-15), подсветка (REND-16) и `instanceFor` отдают
 * числа. Узел — представление детального яруса, и обещать его наружу нельзя:
 * у батчевой записи (REND-20) его не существует.
 *
 * ## Два яруса (REND-20)
 *
 * Ярус выбирает ЗАПИСЬ МАНИФЕСТА (ASSET-13), а не код: батчевый достаётся всем,
 * кроме записей с процедурным контролем костей (REND-5), и явное поле записи
 * это переопределяет. Умолчание для записей, ЯРУС НЕ НАЗВАВШИХ, — ручка пресета
 * качества (`render-quality` QUAL-1, `declaredTier` ниже); авторского выбора и
 * требования механизма пресет не касается.
 *
 * - **батчевый**: запись в разделяемом `InstancedMesh` (`model/batch.ts`),
 *   скиннинг на GPU по VAT-текстуре модели (`model/vatMaterial.ts`), анимация —
 *   пара скаляров (`model/vatAnimation.ts`), скин — индекс слоя (REND-6).
 *   Пер-инстансного скелета, микшера и материалов нет;
 * - **детальный**: сегодняшнее поддерево со скелетом (`model/build.ts`) —
 *   для контроля костей и для записей, которым художник назначил его явно.
 *
 * Модель без запечённых производных рисуется ДЕТАЛЬНЫМ ярусом с предупреждением
 * один раз на модель: отсутствие запекания — деградация стоимости, а не отказ
 * отрисовки (REND-20). Всё наблюдаемое — состояния и one-shot клипы (REND-4),
 * скины (REND-6), посадка и наклон (REND-9, REND-10), смещение (REND-12), перёд
 * (REND-13), picking (REND-15) — у ярусов одинаково: машина состояний, поза и
 * границы считаются ОДНИМ кодом, различается только носитель.
 *
 * Инстансы, целиком вне пирамиды видимости камеры, гасятся (REND-21). Это
 * стоимость кадра и только она: набор, picking и сведение отсечения не видят.
 * Границы отсечения — консервативные по всем клипам (ASSET-12), а не по
 * bind-позе: выпад у края экрана не должен исчезать раньше юнита.
 *
 * Кто наполнил presentation-состояние — поток тиков или документный набор
 * инстансов редактора (REND-11), — подсистеме не видно и знать не положено:
 * вход у неё один, и правило жизненного цикла инстанса тоже одно (REND-3).
 * Поля, которые заполняет только набор (`clip`, `skin`, `scale`), на пути тика
 * приходят пустыми, и ветки под них не работают.
 *
 * ## Второй пул: decoration-инстансы (REND-18)
 *
 * Набор decoration приходит своим входом (`syncDecorations`) и живёт в СВОЁМ
 * пуле — рядом с пулом presentation-состояния, а не внутри него. Причина одна и
 * несущая: смена продюсера гасит presentation-состояние (REND-11), а декорации
 * гасить нельзя — сцена, которую автор украсил, украшена и в прогоне. Общий пул
 * означал бы, что «погасить набор ушедшего продюсера» и «оставить декорации» —
 * одно действие с двумя разными результатами.
 *
 * Рисуются они ТЕМ ЖЕ путём и теми же ветками: запись манифеста (ASSET-6,
 * ASSET-9), ярус записи (REND-20) с тем же `syncPool` и тем же батчем, скин
 * (REND-6), перёд (REND-13), посадка на визуальную поверхность (REND-9) и
 * наклон по её нормали (REND-10). Второго пути отрисовки не появляется — этого
 * требуют и REND-18, и REND-11. Разница ровно в том, чего у декорации нет:
 * вертикального смещения (REND-12), контроля костей (REND-5) и событийных
 * клипов (REND-4) — производить их не от чего.
 *
 * Сам манифест — второй вход подсистемы и тоже переподаваемый (REND-17): в
 * матче он приезжает загруженным ассетом один раз (ASSET-6), а редактор правит
 * его непрерывно (ED-14) и обязан показать результат не позже следующего кадра
 * (ED-15). Вход для этого один — `applyManifest`, декларативный по образцу
 * `TerrainSubsystem.applyGrid` и `DocumentSource.apply`: потребитель отдаёт
 * документ ЦЕЛИКОМ, а решать, что пересобрать, — дело подсистемы. Императивной
 * правки поля записи здесь нет по той же причине, по какой её нет у инстансов и
 * у сетки: картинка обязана быть функцией документа, а не истории вызовов.
 */
import * as THREE from 'three';
import {
  type EntityId,
} from '@fluxus/core';
import {
  resolveSurfaceAlign,
  resolveVisual,
  resolveVisualClaim,
  type AssetService,
  type EntityVisual,
  type VisualManifest,
  type VisualTier,
} from '@fluxus/assets';
import type {
  EntityView,
  FrameBudget,
  LightingSink,
  QualityDeclaration,
  QualityValues,
  RenderContext,
  RenderSubsystem,
  TickView,
} from '../types.js';
import { costSink, type RenderCostCounters } from '../cost.js';
import { createStateReader } from './shellSupport.js';
import { createWarnOnce } from '../warnOnce.js';
import type { DebugSource } from '../debug/contract.js';
import { modelsInstancesDebugSource, type DebugInstanceRow } from '../debug/modelsSource.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { VisualSurface } from '../visualSurface.js';
import { createPickProxy, type InstanceProxySource, type PickProxy, type PickProxyVisitor } from '../picking.js';
import {
  normalizedScale,
  type SharedModelData,
} from '../model/build.js';
import { BoneControlState } from '../model/boneControl.js';
import {
} from '../model/skins.js';
import {
} from '../model/vatMaterial.js';
import { footprintSink, peak } from '../footprint.js';
import { FadeClonePool, advanceDissolve, advanceFade } from './models/instanceFade.js';
import { poseInstance } from './models/instancePose.js';
import {
  advanceTint,
  armFlash,
  makeTint,
  resolveTintEntry,
  setBaseTint,
  type InstanceTintInput,
} from './models/instanceTint.js';
import { DEFAULT_CULL_MARGIN, InstanceCuller } from './models/instanceCull.js';
import { LightingPorts } from './models/lightingPorts.js';
import { BatchCache } from './models/batchCache.js';
import { SharedModelCache } from './models/sharedModels.js';
import {
  EMITTER_CARRIER,
  attachPlaceholder,
  disposePlaceholder,
} from './models/carrier/placeholder.js';
import { attachDetailed, rescaleCull } from './models/carrier/detailed.js';
import { attachBatched } from './models/carrier/batched.js';
import { releaseHolder, type ControllerOptions } from './models/carrier/support.js';
import { Prewarmer, type ModelsPrewarm } from './models/prewarm.js';
import { SpawnQueue } from './models/spawnQueue.js';
import { nodePoseOf, type NodePose } from './models/nodePose.js';
import {
  DEFAULT_FACING_RAD,
  DEG_TO_RAD,
  NONE_CARRIER,
  PLACEMENT_MOVED,
  STATE_FALL,
  animationStateOf,
  boundsOf,
  casterTierOf,
  declaredTier,
  descends,
  placementChange,
  rebuildsInstance,
  sameSkinSlots,
  viewOf,
  type BatchEntry,
  type CarrierDeps,
  type InstanceRecord,
  type ModelInstanceView,
  type SharedEntry,
} from './models/instanceRecord.js';

export interface ModelsOptions {
  /** Тип события смерти — конвенция ядра. */
  readonly deathEvent?: string;
  /**
   * Тип события возрождения — то, чем снимается фиксация последнего кадра клипа
   * смерти (REND-4). Умолчания нет: смерть — конвенция ядра, а возрождение
   * описывает сцена, и назвать его вправе только сборка (в демо — `HeroRespawned`
   * системы `Respawn`). Не названо — путь снятия остаётся один, разрыв
   * непрерывности (REND-2).
   */
  readonly reviveEvent?: string;
  /** Тип события провала в клетку без пола (ARENA-5) — вход снижения (REND-12). */
  readonly fallEvent?: string;
  /** Длительность кроссфейда клипов, секунды (REND-4). */
  readonly crossfade?: number;
  /** Скорость доворота корпуса инстанса к курсу движения, 1/с. */
  readonly turnRate?: number;
  /** Источник визуальной поверхности — высота и наклон по рельефу (REND-9, REND-10). */
  readonly surface?: VisualSurfaceSource;
  /** Скорость сглаживания наклона по поверхности, 1/с (REND-10). */
  readonly tiltRate?: number;
  /**
   * Камера, которой рисуется кадр, — вход отсечения невидимых инстансов
   * (REND-21) и выбора уровня детализации (REND-22). Не задана — отсечения нет,
   * все инстансы остаются в кадре и рисуются нулевым уровнем: стоимость, а не
   * поведение, и сборка без камеры (тесты, headless) обязана рисовать то же.
   *
   * Камера приходит опцией подсистемы, а не контекстом (REND-8): контракт
   * подсистем от отсечения не меняется, а знать позу камеры нужно ровно ей.
   * Собирающий обязан посадить позу на камеру ДО кадра подсистем — тем же
   * `applyCameraPose`, которым рисуется кадр (CAM-1).
   */
  readonly camera?: THREE.Camera;
  /**
   * Запас консервативности границ отсечения — доля радиуса габаритов инстанса
   * (REND-21). Берётся ВСЕГДА, а не только там, где запечённых границ по клипам
   * нет (`assets` ASSET-12): границы bind-позы анимация выводит за себя, и без
   * запаса выпад у края экрана срезался бы вместе с мечом, — но и запечённые
   * границы описывают ровно позы клипов, а не оверлеи над инстансом (REND-16),
   * доворот костей (REND-5) и погрешность объемлющей сферы.
   */
  readonly cullMargin?: number;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
  /**
   * Порты подсистемы освещения (REND-8) — ОДНОЙ ссылкой, потому что владелец у
   * них один: приёмник теневых кастеров (REND-30) и приёмник носителей
   * локального света (REND-33). Подсистема моделей — единственная, кто знает и
   * происхождение инстанса (доставка против набора декораций), и запись его
   * вида, поэтому ярус кастера и носителя света считает она, а что с ними
   * делать, решает свет. Нет порта — сцена без света: ни флагов теней, ни
   * локальных источников инстансы не получают вовсе.
   *
   * Имя опции историческое — теней порт был раньше света; второй опции под свет
   * не заводится намеренно (см. `LightingSink`): она заставила бы каждого
   * собирающего писать ту же ссылку дважды, а вьюпорт редактора получил бы
   * локальный свет только правкой своего кода — ровно то, чего `editor` ED-1 не
   * допускает.
   */
  readonly shadows?: LightingSink;
  /**
   * Компоненты-состояния в порядке, которым Extractor сборки выставляет биты
   * `EntityView.states` (CAM-6, SHELL-2) — тот же список, что у подсистем
   * эффектов и частиц (REND-23, REND-24). Нужен ровно затем, чтобы найти бит
   * `deadState`; без него имени состояния соответствовать нечему.
   */
  readonly stateComponents?: readonly string[];
  /**
   * Имя состояния, которым доставленное состояние называет сущность мёртвой
   * (REND-4). Умолчания нет по тем же основаниям, что у `reviveEvent`: смерть —
   * конвенция ядра, а МАРКЕР смерти описывает сцена, и назвать его вправе только
   * сборка. Не названо — фиксация клипа смерти живёт как прежде, событием и
   * событием возрождения; названо — она следует доставленному состоянию в обе
   * стороны, и сцена с двумя видами возрождения перестаёт зависеть от того,
   * сколько имён событий сборка успела перечислить.
   */
  readonly deadState?: string;
  /**
   * Длительность fade-out «ушла в туман» в секундах (FOW-8, design D7) — из
   * конфигурации тумана (FOW-10), а не константа кода. Ноль или отсутствие —
   * fade выключен, исчезновение убирает инстанс сразу (прежнее поведение;
   * сборка без тумана этой опции не передаёт).
   *
   * С ней исчезновение сущности из доставленного состояния БЕЗ события смерти
   * читается как «ушла в туман»: инстанс доживает до конца анимации угасания,
   * появление получает короткий fade-in, а `EntityDied` идёт существующим
   * путём смерти — рендер отличает туман от гибели (FOW-8).
   */
  readonly fadeSeconds?: number;
}

const DEFAULT_TURN_RATE = 12;
const DEFAULT_TILT_RATE = 10;

/**
 * Ручки качества подсистемы (`render-quality` QUAL-1). Множитель порогов LOD —
 * прямое значение поверх ПОРОГОВ ЗАПИСИ (ASSET-13, REND-22): больше единицы —
 * уровень переключается раньше и треугольников в кадре меньше. Ярус по
 * умолчанию (REND-20) — тоже прямое значение: авторского источника у него нет,
 * умолчание живёт в коде, и пресет заменяет именно его.
 */
const MODELS_LOD_SCALE = 'models.lodThresholdScale';
const MODELS_DEFAULT_TIER = 'models.defaultTier';

/** Конвенция арены ядра (ARENA-5); имя переопределяется опцией. */
const DEFAULT_FALL_EVENT = 'FellThroughFloor';
/** Конвенция смерти ядра — та же, что у `AnimationController` (REND-4, FOW-8). */
const DEFAULT_DEATH_EVENT = 'EntityDied';

export class ModelsSubsystem implements RenderSubsystem, InstanceProxySource {
  readonly name = 'models';

  /** Текущий манифест визуалов (ASSET-6); переподаётся целиком (REND-17). */
  private manifest: VisualManifest;
  private readonly options: ModelsOptions;
  private readonly warn: (message: string) => void;
  private ctx: RenderContext | null = null;
  private readonly instances = new Map<EntityId, InstanceRecord>();
  /**
   * Пул decoration-инстансов (REND-18) — второй и независимый: смена продюсера
   * гасит `instances` и этого пула не касается.
   */
  private readonly decorations = new Map<EntityId, InstanceRecord>();

  /** Пул прозрачных копий материалов на время угасания (FOW-8). */
  private readonly fade = new FadeClonePool();
  /** Отсечение и выбор уровня кадра (REND-21, REND-22) — своё хозяйство. */
  private readonly culler = new InstanceCuller();
  /** Порты к подсистеме освещения: ярус кастера, свет записи, пятно (REND-8). */
  private readonly lighting: LightingPorts;
  /** Кэш батчей по ключу записи манифеста (REND-20, REND-31). */
  private readonly batches: BatchCache;
  /** Кэш разделяемой части ассетов моделей (REND-3). */
  private readonly shared: SharedModelCache;
  /**
   * Узкий порт носителей яруса к хозяйству подсистемы (REND-20): один объект на
   * подсистему, а не на инстанс и не на вызов.
   */
  private readonly carrierDeps: CarrierDeps;
  /** Опции анимационного контроллера от сборки (REND-4) — те же обоим ярусам. */
  private readonly controllerOptions: ControllerOptions;
  /** Прогрев программ и ассетов до первого кадра (FOW-8, REND-31). */
  private readonly prewarmer: Prewarmer;
  /** Очередь отложенного монтирования инстансов волны спавна (REND-44). */
  private readonly spawn = new SpawnQueue();
  /**
   * Фаза отложимой работы (REND-44) отработала В ЭТОМ кадре. Подсистема,
   * которую крутят без сцены, фазы не видит вовсе — и доделывает отложенное
   * покадровым обновлением, как делала бы без бюджета совсем.
   */
  private budgetedThisFrame = false;
  /**
   * Монтирование одной записи для очереди — ОДНО замыкание на подсистему, а не
   * на вызов: кадровый путь не аллоцирует (REND-26).
   */
  private readonly mountOne = (record: InstanceRecord): void => {
    this.mountVisual(this.requireCtx(), record);
  };
  private readonly warnedKinds = new Set<string>();
  /**
   * Несёт ли доставленное состояние сущности маркер смерти (REND-4); null —
   * сборка состояния смерти не назвала, и фиксация остаётся событийной.
   */
  private readonly isDeadState: ((view: EntityView) => boolean) | null;
  /** Переиспользуемая запись прокси обхода (REND-15): валидна внутри визита. */
  private readonly proxy: PickProxy = createPickProxy();

  /** Множитель порогов LOD от пресета качества (QUAL-1, REND-22); 1 — пороги записи. */
  private lodScale = 1;
  /** Ярус записей, не назвавших его (QUAL-1, REND-20) — умолчание кода до пресета. */
  private defaultTier: VisualTier = 'batched';

  constructor(manifest: VisualManifest, options: ModelsOptions = {}) {
    // Порт носителей замыкается на подсистему, а не копирует её поля: контекст
    // рендера приходит только с `init` (REND-8), а сток, кэши и манифест живут
    // дольше конструктора.
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- порт держит саму подсистему
    const self = this;
    this.manifest = manifest;
    this.options = options;
    this.lighting = new LightingPorts(options.shadows);
    this.controllerOptions = {
      ...(options.crossfade === undefined ? {} : { crossfade: options.crossfade }),
      ...(options.deathEvent === undefined ? {} : { deathEvent: options.deathEvent }),
      ...(options.reviveEvent === undefined ? {} : { reviveEvent: options.reviveEvent }),
    };
    this.carrierDeps = {
      get assets(): AssetService { return self.requireCtx().assets; },
      get scene(): THREE.Scene { return self.requireCtx().scene; },
      warn: (message) => { self.warn(message); },
      markCaster: (record) => { self.lighting.markCaster(record); },
      ensureBaseSkin: (entry) => { self.shared.ensureBaseSkin(entry); },
      sharedOf: (record) =>
        record.visual === undefined ? undefined : self.shared.get(record.visual.model),
      disposeFadeClones: (originals) => { self.fade.disposeClonesOf(originals); },
      dropCaster: (root) => { self.lighting.dropCaster(root); },
    };
    this.prewarmer = new Prewarmer({
      ctx: () => this.requireCtx(),
      manifest: () => this.manifest,
      get shared(): SharedModelCache { return self.shared; },
      get batches(): BatchCache { return self.batches; },
      defaultTier: () => this.defaultTier,
    });
    this.shared = new SharedModelCache(
      () => this.requireCtx().assets,
      (message) => { this.warn(message); },
      (record, data) => { this.attachModel(record, data); },
      (originals) => { this.fade.disposeClonesOf(originals); },
    );
    this.batches = new BatchCache(
      () => this.requireCtx().assets,
      (modelId, derivatives) => this.shared.vatTexture(modelId, derivatives),
      (entry) => { this.reindexBatchSkins(entry); },
    );
    this.warn = options.warn ?? ((message) => { console.warn(message); });
    // Читатель бита состояния смерти — тот же общий словарь, которым читают
    // свои состояния оболочки (`shellSupport.ts`, CAM-6). Строится один раз и
    // только когда сборка назвала И состояние, И порядок битов: без любого из
    // двух отвечать не на что, и путь остаётся прежним, событийным.
    const deadState = options.deadState;
    const warnOnce = createWarnOnce(this.warn);
    this.isDeadState =
      deadState === undefined
        ? null
        : ((reader) => (view: EntityView): boolean => reader(view, deadState))(
            createStateReader(options.stateComponents ?? [], (name) => {
              // Читатель зовётся на каждую сущность каждой доставки, а опечатка
              // в имени состояния — одно явление: говорим о нём один раз, тем же
              // приёмом, что и оболочки (REND-23, REND-24).
              warnOnce(
                `deadState:${name}`,
                `render: состояние смерти "${name}" не зеркалируется Extractor'ом сборки — ` +
                  `фиксация клипа смерти остаётся событийной (REND-4)`,
              );
            }),
          );
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемой террейна источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
  }

  /**
   * Снос подсистемы (REND-31). Порядок несущий: сперва инстансы обоих пулов
   * обычным удалением (REND-3) — с ними уходят fade-копии материалов, скины и
   * записи батчей, — затем сами батчи, и только потом разделяемые данные
   * ассетов. Обратный порядок сломал бы правило `ModelBatch.dispose`: батч
   * снимает чужие атрибуты с геометрии ассета ДО её освобождения (REND-3), и
   * освободи ассет раньше — снимать было бы уже не с чего.
   *
   * Источник поверхности и приёмник теневых кастеров приходят опцией сборки и
   * принадлежат ей: подсистема лишь сообщает им об ушедших объектах тем же
   * путём, каким сообщает в матче.
   */
  dispose(): void {
    // Отложенное монтирование сносом ОТМЕНЯЕТСЯ, а не доделывается (REND-44):
    // строить изображение записи, которая через строку уйдёт из пула, значит
    // выделить ресурс, чтобы тут же его отдать. Сцена своё «доделать целиком»
    // уже сделала — она зовёт `flushBudget` ПЕРЕД сносом.
    this.spawn.clear();
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) this.remove(record);
      pool.clear();
    }
    this.batches.dispose();
    this.shared.dispose();
    // Пулы, оригинал которых подсистеме НЕ принадлежит, освобождением ассета не
    // закрываются: материал заглушки общий на все инстансы и на все подсистемы
    // (`makePlaceholder`) и переживает снос. Его fade-копии — наши, и держать
    // ими программу дальше сноса нельзя (REND-31).
    this.fade.dispose();
  }

  // ------------------------------------------------------------- syncTick

  syncTick(view: TickView): void {
    const ctx = this.requireCtx();
    // Сток читается ОДИН раз на доставку и уходит вниз параметром (PERF-3):
    // проверять его на каждом инстансе значило бы платить за учёт ровно тем,
    // что он мерит. Без стока это одно сравнение на весь обход.
    const cost = costSink();
    // Разрыв непрерывности (REND-2) снимает необратимость смерти: перемотка
    // через момент смерти оживляет сущность в симуляции, а `EntityDied` в
    // прошлом не разэмитится — без этого живой персонаж навсегда остался бы
    // лежать нулевым кадром клипа смерти (REND-4, REND-25). Раньше сведения
    // пула: клип состояния этого же кадра ставится уже живому контроллеру.
    //
    // Возрождение ИДУЩЕГО мира сюда не попадает и попасть не может: сущность
    // та же, мир непрерывен, `snapAll` не поднимается — а прыжок на точку
    // спавна виден лишь пер-сущностным телепортом, который значит «не
    // интерполировать», а не «этот труп ожил». Снимает фиксацию названное
    // сборкой событие возрождения — ниже, общим разбором событий тика.
    if (view.snapAll) {
      // Фиксация снимается с ЗАПИСИ, а не только с её сегодняшнего контроллера:
      // иначе следующий контроллер того же инстанса (поздняя модель, смена
      // яруса, переподача) поднял бы её обратно из авторитета записи.
      for (const record of this.instances.values()) {
        record.deathLock = false;
        record.controller?.onSnap();
      }
    }
    this.syncPool(ctx, this.instances, view.entities, false, view, cost);

    // События тика → one-shot клипы (REND-4); дедуп на потребителе (OBS-5):
    // при rewind/replay и на замороженных тиках события не переигрываются.
    if (view.freshEvents) this.applyTickEvents(view);
    this.reportFootprint();
  }

  /**
   * События доставки на записях пула (REND-4): провал включает снижение
   * (REND-12), гибель и возрождение двигают фиксацию смерти на ЗАПИСИ, всё
   * прочее уходит в контроллер one-shot клипом.
   */
  private applyTickEvents(view: TickView): void {
    const fallEvent = this.options.fallEvent ?? DEFAULT_FALL_EVENT;
    // Имена событий смерти и возрождения читаются ОДИН раз на доставку: на
    // каждое событие они всё равно понадобятся, а разрешение умолчания
    // платится однажды (та же дисциплина, что у читателя состояния смерти).
    const deathEvent = this.options.deathEvent ?? DEFAULT_DEATH_EVENT;
    const reviveEvent = this.options.reviveEvent;
    for (const event of view.events) {
      const caster = event.data.entity ?? event.data.source;
      if (caster === undefined) continue;
      const record = this.instances.get(caster);
      if (record === undefined) continue;
      // Авторитет смерти — на записи (REND-4): событие фиксирует её и тогда,
      // когда контроллера у инстанса нет вовсе (модель ещё едет, ASSET-4), и
      // тогда фиксацию поставит первый же появившийся контроллер. Событие
      // возрождения снимает её тем же порядком.
      if (event.type === deathEvent) record.deathLock = true;
      else if (event.type === reviveEvent) record.deathLock = false;
      // Провал (ARENA-5) включает снижение и состояние `fall` (REND-12);
      // убьёт ли сущность геймплейная система или вернёт на арену —
      // рендеру неизвестно, и предвосхищать её решение он не пытается.
      if (event.type === fallEvent && descends(record)) {
        record.falling = true;
        record.controller?.setState(STATE_FALL);
      }
      // Вспышка тинта на событие (REND-40, ASSET-18) — тем же разбором событий,
      // что и one-shot клипы: у записи это ДВЕ таблицы одного входа, и «мигнуть
      // на попадании» не требует ни своего канала событий, ни кода игры.
      const flash = record.tintFlashes?.get(event.type);
      if (flash !== undefined) armFlash(record.tint, flash);
      record.controller?.handleEvent(event.type);
    }
  }

  /**
   * Величины занятой памяти подсистемы (PERF-8): инстансы обоих пулов и
   * граница кэша батчей, которую нормирует REND-31. Считаются после сведения —
   * то есть тогда, когда пулы и кэш уже приведены к составу доставки.
   *
   * Без подключённого стока не исполняется вовсе: `batchStats()` строит объект,
   * и звать его на каждой доставке ради выключенного учёта значило бы платить
   * за бенчмарк обычным матчем (PERF-3).
   */
  private reportFootprint(): void {
    if (footprintSink() === undefined) return;
    peak('modelsInstances', this.instances.size + this.decorations.size);
    const stats = this.batches.stats();
    peak('modelsBatches', stats.batches);
    peak('modelsBatchRecords', stats.records);
  }

  /**
   * Полный набор decoration-инстансов (REND-18). Сведение — то же самое, что у
   * presentation-состояния: тот же `syncPool`, то же правило жизненного цикла
   * (REND-3), тот же выбор яруса (REND-20). Событий здесь не разбирается вовсе
   * — их у decoration нет, а не «пока никто не прислал».
   */
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    const movedStatic = this.syncPool(
      this.requireCtx(),
      this.decorations,
      entities,
      true,
      null,
      costSink(),
    );
    this.reportFootprint();
    // Кэшированная карта статических теней устаревает ровно тогда, когда
    // СТАТИЧЕСКАЯ декорация (REND-8, design D3) появилась, исчезла или
    // переехала. Вход событийный (REND-18), а не кадровый: в матче он приходит
    // однажды, в режиме правки — на каждую правку документа (ED-15), и правок,
    // размещения не касающихся вовсе (скин, флаг walkable, соседняя запись),
    // у документа больше, чем переездов. Безусловное перезапекание платило бы
    // полной картой сцены за правку одного поля.
    //
    // Появление и исчезновение корня приёмник видит и сам (`setCaster`,
    // `dropCaster` помечают статику устаревшей), а вот ПЕРЕЕЗД — нет: корень
    // тот же объект, сменилось только его преобразование. Ради него сигнал и
    // остаётся, и потому же он не «на всякий случай».
    if (movedStatic) this.lighting.invalidateStatic();
  }

  /**
   * Сведение пула с поданным набором сущностей (REND-3): появившиеся создают
   * инстанс, исчезнувшие убирают, сохранившиеся обновляются. Одна реализация на
   * оба пула — второй разошёлся бы с первым, а REND-18 требует ровно того же
   * пути отрисовки, что REND-11.
   *
   * `view` приходит только от потока тиков и только он включает ветки fade
   * (FOW-8, design D7): у decoration-набора «ушла в туман» не бывает — его
   * записи не фильтруются видимостью вовсе (REND-18).
   */
  private syncPool(
    ctx: RenderContext,
    pool: Map<EntityId, InstanceRecord>,
    entities: ReadonlyMap<EntityId, EntityView>,
    decoration: boolean,
    view: TickView | null = null,
    cost?: RenderCostCounters,
  ): boolean {
    // Просмотр поданного набора — работа подсистемы на доставке (PERF-3),
    // растущая с числом сущностей и с числом декораций одинаково: путь у обоих
    // пулов один (REND-18). Снятие исчезнувших идёт ниже по пулу и своего поля
    // не имеет: в установившейся сцене пул равен поданному набору.
    if (cost !== undefined) cost.modelsInstancesSynced += entities.size;
    // Fade действует только на непрерывном ходе мира: разрыв (rewind, смена
    // продюсера, гашение набора пустым состоянием) убирает инстансы сразу —
    // плавное угасание нарисовало бы «уход в туман», которого не было (REND-2).
    const fadeSeconds = view !== null && !view.snapAll ? (this.options.fadeSeconds ?? 0) : 0;
    // Маркер смерти доставленного состояния (REND-4) читается ТОЛЬКО у пула
    // сущностей: у decoration-набора состояний нет вовсе (REND-18), и спрашивать
    // его о смерти нечего. Читатель снимается один раз на доставку — на каждую
    // запись он всё равно позовётся, а ветвление по опции платится однажды.
    const isDeadState = decoration ? null : this.isDeadState;
    // Сдвинулась ли статика набора (REND-8): у пула сущностей ответ всегда
    // отрицательный — статических кастеров в нём не бывает по построению
    // (`casterTierOf`), и сравнение на записи короткое.
    let movedStatic = false;
    for (const entityView of entities.values()) {
      let record = pool.get(entityView.id);
      // Тот же идентификатор с ДРУГИМ видом — другой объект, а не правка
      // прежнего: после разветвления истории (NTR-16) освободившийся id
      // достаётся новой сущности, и её вид приезжает вместе с ней. Вид задаёт
      // модель, запись манифеста и ярус (REND-20) — пересобрать их правкой
      // живой записи нечем, поэтому запись пересоздаётся. То же правило и по
      // той же причине применяет к документным наборам `KeyedInstanceSet`
      // (REND-11).
      if (record !== undefined && record.kind !== entityView.kind) {
        this.remove(record);
        pool.delete(entityView.id);
        record = undefined;
      }
      if (record === undefined) {
        record = this.createRecord(ctx, entityView, decoration, fadeSeconds > 0, isDeadState, cost);
        pool.set(entityView.id, record);
      }
      const moved = this.syncRecord(record, entityView, decoration, isDeadState);
      movedStatic ||= moved && casterTierOf(record) === 'static';
    }
    return this.sweepPool(pool, entities, fadeSeconds, view) || movedStatic;
  }

  /**
   * Новый инстанс появившейся сущности (REND-3).
   *
   * «Появился уже мёртвым» — единственный случай, в котором фиксацию смерти
   * ставит СОСТОЯНИЕ, а не событие (REND-4). Разделение несущее: сведение пула
   * идёт до разбора событий тика, и на тике гибели маркер в мире уже стоит —
   * фиксируй мы по состоянию всякий инстанс, гибель на глазах перестала бы
   * играть клип, потому что `handleEvent` под фиксацией no-op.
   *
   * Флаг живёт на записи, а не в локальной переменной, потому что контроллера
   * на создании ещё может не быть: модель — разделяемый ассет и вправе ехать
   * сколько угодно (`assets` ASSET-4), а фиксировать поведение нужно тому
   * контроллеру, который в итоге появится.
   */
  private createRecord(
    ctx: RenderContext,
    entityView: EntityView,
    decoration: boolean,
    fading: boolean,
    isDeadState: ((view: EntityView) => boolean) | null,
    cost: RenderCostCounters | undefined,
  ): InstanceRecord {
    const record = this.create(ctx, entityView, decoration, fading);
    record.deathLock = isDeadState?.(entityView) === true;
    if (cost !== undefined) cost.modelsInstancesCreated++;
    return record;
  }

  /**
   * Существующая запись пула под доставленное состояние (REND-3, REND-11).
   * Возвращает, СДВИНУЛОСЬ ли размещение decoration-инстанса (REND-18): у пула
   * сущностей ответ всегда `false` — там размещение двигает каждый тик.
   */
  private syncRecord(
    record: InstanceRecord,
    entityView: EntityView,
    decoration: boolean,
    isDeadState: ((view: EntityView) => boolean) | null,
  ): boolean {
    // Сущность снова в доставленном состоянии: начатый fade-out отменяется,
    // проявление доигрывается от текущей доли — объект в кадре не мигает.
    record.fadingOut = false;
    record.view = entityView;
    record.snapPending ||= entityView.snap;
    // Разрыв непрерывности возвращает инстанс на поверхность (REND-12):
    // телепорт, респавн, rewind — снижение отменено, а не доигрывается.
    if (entityView.snap) {
      record.falling = false;
      record.fallOffset = 0;
    }
    // Скин и масштаб из набора инстансов (REND-11, REND-18): правка поля
    // обновляет существующий инстанс — материалы скина, фаза анимации и
    // сглаженный наклон при этом не теряются, потому что инстанс тот же.
    if (entityView.skin !== record.viewSkin) {
      record.viewSkin = entityView.skin;
      record.skinChosen = entityView.skin !== undefined;
      this.assignSkin(record, entityView.skin ?? record.visual?.defaultSkin);
    }
    // Масштаб — часть размещения (`PLACEMENT_MOVED`): он двигает и картинку, и
    // след пятна (REND-30), и walkable-вклад поля (REND-9).
    let change = 0;
    if (entityView.scale !== record.viewScale) {
      change = PLACEMENT_MOVED;
      record.viewScale = entityView.scale;
      record.scale = entityView.scale ?? 1;
      // След контактного пятна — производная габарита И масштаба (REND-30):
      // правленый масштаб двигает размер пятна тем же кадром, каким двигает
      // саму картинку и walkable-вклад ниже (REND-17, ED-15). Без этого пятно
      // держало бы прежний радиус до пересборки инстанса.
      this.lighting.syncBlob(record);
    }
    this.applyAnimation(record);
    if (isDeadState !== null) this.syncDeath(record, entityView, isDeadState);
    if (!decoration) return false;
    // Правка walkable-записи (позиция, курс, масштаб, сам флаг) доводит
    // walkable-вклад поля до нового размещения (REND-9, REND-18); правка
    // не-walkable полей (скин) реестр не трогает — вклад тот же, а размещение
    // на КАЖДУЮ правку документа (ED-15) стоило бы записи в реестр и обхода
    // клеток под bbox на каждую декорацию сцены.
    change |= placementChange(record, entityView);
    if (change !== 0) this.syncWalkable(record);
    return (change & PLACEMENT_MOVED) !== 0;
  }

  /**
   * Фиксация смерти следует доставленному состоянию (REND-4): появившийся уже
   * мёртвым встаёт последним кадром клипа смерти, потерявший маркер выходит из
   * фиксации — каким бы событием сцена ни назвала возрождение (FOW-8; событие
   * возрождения продолжает работать и находит контроллер уже живым, что REND-4
   * прямо называет no-op'ом).
   */
  private syncDeath(
    record: InstanceRecord,
    entityView: EntityView,
    isDeadState: (view: EntityView) => boolean,
  ): void {
    if (isDeadState(entityView)) {
      // Маркер, о котором запись ЕЩЁ НЕ ЗНАЕТ, фиксации не ставит: сведение
      // пула идёт до разбора событий тика, и на тике гибели маркер в мире уже
      // стоит — фиксируй мы по нему, гибель на глазах перестала бы играть клип.
      // Фиксацию на этом тике поставит событие (`syncTick`), и с ним же встанет
      // авторитет записи.
      if (!record.deathLock) return;
      // Запись мертва — и мёртв обязан быть КАЖДЫЙ её контроллер, а не только
      // тот, при котором смерть случилась: он вправе появиться позже модели
      // (ASSET-4) и смениться вместе с ярусом (REND-20). Повторная фиксация
      // уже мёртвого — no-op по построению (`enterDeath`), и спрашивать о ней
      // приходится нам, чтобы не ставить её живому контроллеру ОДНОГО кадра
      // гибели дважды.
      const controller = record.controller;
      if (controller !== null && !controller.isDead) controller.enterDeath();
      return;
    }
    record.deathLock = false;
    record.controller?.releaseDeath();
  }

  /**
   * Исчезнувшие: инстанс убирается, разделяемый ассет остаётся в кэше (REND-3).
   * С включённым fade исчезновение БЕЗ события смерти — «ушла в туман»
   * (FOW-8, NET-14): инстанс остаётся дожить fade-out; `EntityDied` того же
   * тика идёт существующим путём смерти — немедленное снятие, как и прежде.
   */
  private sweepPool(
    pool: Map<EntityId, InstanceRecord>,
    entities: ReadonlyMap<EntityId, EntityView>,
    fadeSeconds: number,
    view: TickView | null,
  ): boolean {
    const died = fadeSeconds > 0 && view !== null ? diedIn(view, this.options.deathEvent) : null;
    // Исчезла ли статическая декорация: её тень запечена в кэшированной карте
    // (REND-8), и без инвалидации осталась бы на полу после снятия инстанса.
    let removedStatic = false;
    // `values()` вместо деструктуризации пар: ключ лежит в самой записи, а
    // кортеж на каждую запись пула 30 раз в секунду — мусор на ровном месте
    // (та же дисциплина, что у кадрового пути ниже).
    for (const record of pool.values()) {
      const entity = record.entity;
      if (entities.has(entity)) continue;
      if (fadeSeconds > 0 && died?.has(entity) !== true) {
        record.fadingOut = true;
        continue;
      }
      removedStatic ||= record.decoration && casterTierOf(record) === 'static';
      this.remove(record);
      pool.delete(entity);
    }
    return removedStatic;
  }

  // ---------------------------------------------------------- updateFrame

  /**
   * Кадр подсистемы. `dt` — часы презентации СО ЗНАКОМ (REND-2, REND-25):
   * гейта «вне `Running` время вперёд не идёт» здесь нет и быть не должно —
   * его несёт сам знак, а режим мира подсистеме не виден вовсе (её одинаково
   * зовут оба продюсера presentation-состояния, REND-11). Стоящий мир приходит
   * нулевым dt, и клипы замирают ровно потому, что кадр их не двигает.
   */
  /**
   * Отложимая тяжёлая работа под бюджетом кадра (REND-44): монтирование
   * инстансов волны спавна. Фаза идёт ПЕРЕД покадровым обновлением, поэтому
   * доехавший в ней инстанс рисуется тем же кадром, а не следующим.
   *
   * Ничего кадрового здесь нет и быть не должно: часов у фазы нет, а случиться
   * в кадре она может и не успеть.
   */
  updateBudgeted(budget: FrameBudget): void {
    this.budgetedThisFrame = true;
    // Снесённая подсистема (REND-31) ничего не монтирует: контекста у неё нет.
    if (this.ctx === null) return;
    this.spawn.drain(budget, this.mountOne, this.options.camera);
  }

  updateFrame(dt: number, alpha: number): void {
    const heightStep = this.requireCtx().config.heightStep;
    // Фаза отложимой работы (REND-44) уже смонтировала, сколько успела, и
    // остаток отложила ОСОЗНАННО — доделывать его здесь значило бы отменить
    // бюджет. Подсистема же, которую крутят напрямую (вьюпорт редактора,
    // стенды, тесты), фазы не видит вовсе: там очередь не наполняется, а этот
    // сток остаётся страховкой на случай сцены, переставшей звать фазу.
    if (this.budgetedThisFrame) this.budgetedThisFrame = false;
    else this.spawn.flush(this.mountOne);
    const turnRate = this.options.turnRate ?? DEFAULT_TURN_RATE;
    const tiltRate = this.options.tiltRate ?? DEFAULT_TILT_RATE;
    const surface = this.options.surface?.current ?? null;
    // Сток кадра — один раз на вход и вниз параметром (PERF-3), как на доставке.
    const cost = costSink();

    // Оба пула одним проходом и одними правилами: декорация в кадре автора и
    // декорация в кадре игрока обязаны быть одним изображением (REND-18).
    this.poseAll(this.instances, dt, alpha, heightStep, turnRate, tiltRate, surface, cost);
    this.poseAll(this.decorations, dt, alpha, heightStep, turnRate, tiltRate, surface, cost);

    // Доигравшие fade-out (FOW-8): анимация угасания кончилась — инстанс
    // убирается тем же `remove`, что и обычное исчезновение. После позы кадра:
    // последний кадр угасания ещё нарисован, а не пропущен.
    //
    // Обход идёт по значениям, а не по парам: итерация Map с деструктуризацией
    // заводит массив пары на КАЖДЫЙ инстанс каждого кадра, а ключ у записи и
    // так свой (`entity` — им её в пул и клали) — в установившемся кадре путь
    // не аллоцирует пропорционально инстансам.
    for (const record of this.instances.values()) {
      if (record.fadingOut && record.fade <= 0) {
        this.remove(record);
        this.instances.delete(record.entity);
        continue;
      }
      this.syncDissolved(record);
    }

    // Отсечение — после позы: видимость считается по тому преобразованию,
    // которым инстанс нарисован в ЭТОМ кадре (REND-21). Уровень детализации
    // считается там же — по экранному размеру того же объёма (REND-22).
    //
    // Камеры нет — отсечения не существует вовсе (сборка без неё рисует всё), и
    // счётчики остаются нулевыми: приписывать кадру тесты, которых он не делал,
    // нельзя (PERF-3).
    const camera = this.options.camera;
    if (camera !== undefined) {
      this.culler.beginFrame(
        camera,
        this.options.cullMargin ?? DEFAULT_CULL_MARGIN,
        this.lodScale,
        this.lighting.shadowFrustum(),
      );
      this.culler.cullPool(this.instances, cost);
      this.culler.cullPool(this.decorations, cost);
    }

    // Компактация видимых записей в инстанс-буферы — последним: до неё batch
    // не знает ни позы кадра, ни видимости.
    this.batches.flush(cost);

    // Контактные пятна режима `blob` (REND-30) пишутся ЗДЕСЬ, а не в кадре
    // подсистемы освещения: она зарегистрирована раньше владельца инстансов, её
    // кадр идёт первым, и пятна отставали бы от юнитов на кадр. Что писать и
    // писать ли вообще, решает по-прежнему она — здесь только момент, когда
    // позы и видимость кадра уже посчитаны.
    this.lighting.blobCastersPosed();
  }

  /**
   * Отсечение невидимых инстансов (REND-21): консервативная сфера инстанса
   * против пирамиды видимости камеры. Невидимая запись не попадает в
   * компактацию батча, невидимый holder гасится — а из набора запись не
   * убирается: picking (REND-15) и сведение (REND-3, REND-18) идут по полному
   * набору, и других наблюдаемых последствий у отсечения нет.
   */

  /**
   * Растворившийся труп — вон из кадра, воскресший — обратно в кадр (REND-4).
   *
   * Из КАДРА, а не из набора: сущность в доставленном состоянии осталась —
   * `Dead` с неё снимает сцена своим временем, а не рендер, — и убрать её из
   * пула значило бы пересоздать инстанс следующей же доставкой. Снимается
   * построенное из ассета ровно тем же путём, каким его снимает исчезновение
   * (`remove`): держатель, батчевый слот, локальный свет, контактное пятно.
   *
   * Возврат решается ЦЕЛОСТНОСТЬЮ, а не перечнем событий: `advanceDissolve`
   * ставит её обратно в единицу, как только сущность перестала быть мёртвой, —
   * возрождением, снятым маркером состояния или разрывом непрерывности
   * (`snapAll`, REND-2). Одно место вместо трёх, и новый способ ожить не
   * потребует четвёртого.
   */
  private syncDissolved(record: InstanceRecord): void {
    if (record.dissolved) {
      if (record.dissolve < 1) return;
      record.dissolved = false;
      this.mountVisual(this.requireCtx(), record);
      return;
    }
    if (record.dissolve > 0) return;
    this.remove(record);
    record.dissolved = true;
  }

  /**
   * Изображение записи и её носители света и пятна — общий низ создания
   * инстанса и возврата растворившегося трупа (REND-3, REND-4).
   */
  private mountVisual(ctx: RenderContext, record: InstanceRecord): void {
    this.attachVisual(ctx, record);
    // Свет — свойство ЗАПИСИ, а не построенного из ассета (REND-33): носитель
    // объявляется здесь же, до готовности модели и независимо от того, рисуют
    // инстанс модель, заглушка (ASSET-4) или частицы (ASSET-14).
    this.lighting.syncLight(record, this.manifest);
    // Пятно — свойство ЯРУСА КАСТЕРА (REND-30), и объявляется оно тем же
    // порядком: радиус нулевой, пока габаритов нет, и приезжает вместе с моделью.
    this.lighting.syncBlob(record);
  }

  private poseAll(
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    dt: number,
    alpha: number,
    heightStep: number,
    turnRate: number,
    tiltRate: number,
    surface: VisualSurface | null,
    cost: RenderCostCounters | undefined,
  ): void {
    // Поза кадра — по одной записи на инстанс пула (PERF-2, стадия кадра): счёт
    // снимается разом с размера пула, а не инкрементом внутри цикла.
    if (cost !== undefined) cost.modelsPoseWrites += pool.size;
    // Сходящиеся к цели величины кадра — доворот (REND-5), наклон (REND-10),
    // контроль костей — берут МОДУЛЬ часов: направления у них нет, цель ведёт
    // доставленное состояние, и на обратном ходе сглаживание обязано идти к
    // ней, а не от неё (отрицательный шаг экспоненты уводил бы инстанс прочь).
    const settle = Math.abs(dt);
    const fadeSeconds = this.options.fadeSeconds ?? 0;
    for (const record of pool.values()) {
      this.poseRecord(record, dt, settle, alpha, heightStep, turnRate, tiltRate, surface, fadeSeconds);
    }
  }

  /** Поза одной записи в кадре: место, курс, наклон и время анимации. */
  private poseRecord(
    record: InstanceRecord,
    dt: number,
    settle: number,
    alpha: number,
    heightStep: number,
    turnRate: number,
    tiltRate: number,
    surface: VisualSurface | null,
    fadeSeconds: number,
  ): void {
    advanceFade(record, settle, fadeSeconds);
    // Растворение трупа (REND-4) и тинт (REND-40) идут ДО ветки замершей позы:
    // угасающий в тумане труп продолжает растворяться, а вспышка — гаснуть.
    // Замирает поза, а не часы картинки.
    advanceDissolve(record, settle);
    advanceTint(record.tint, settle);
    const view = record.view;
    // Инстанс в fade-out (FOW-8) держит ПОСЛЕДНЕЕ доставленное состояние, и
    // интерполировать его заново нечем: альфа кадра принадлежит потоку доставок
    // и сбрасывается каждой следующей — ушедший в туман юнит дрожал бы на длину
    // своего последнего шага весь fade, ровно та «череда телепортов», которую
    // REND-2 запрещает. Поза замирает там, где её застало угасание; часы клипа и
    // доля проявленности идут дальше — угасает картинка, а не время.
    if (record.fadingOut && record.posed) {
      record.controller?.update(dt, view.timeScale);
      this.applyRecordPose(record, settle);
      return;
    }
    poseInstance(record, dt, settle, alpha, heightStep, turnRate, tiltRate, surface);

    // Анимационное время — единственное, что берёт ЗНАК: клип идёт вперёд,
    // стоит либо отматывается вместе с миром (REND-25). И единственное, что
    // берёт ПЕРСОНАЛЬНУЮ шкалу сущности (REND-38): замедленная симуляцией
    // сущность обязана и перебирать анимацией во столько же раз медленнее.
    // Сглаживания выше (доворот, наклон, tier-fade) идут на `settle` — они
    // принадлежат картинке, а не миру, и шкале не подчиняются.
    record.controller?.update(dt, view.timeScale);
    this.applyRecordPose(record, settle);
  }

  /**
   * Видимое преобразование записи — в её носитель (REND-20). Доля
   * проявленности (FOW-8) идёт мимо: у держателя это подменённые материалы, у
   * батча — пер-инстансный атрибут альфы, и оба пути ведёт носитель.
   */
  private applyRecordPose(record: InstanceRecord, settle: number): void {
    // Масштаб кадра — семантический `scale` записи (REND-11), без множителей.
    this.fade.applyToHolder(record);
    record.carrier.applyPose(record, record.scale, settle, this.warn);
  }

  /**
   * Видимое преобразование записи — в её носитель. Считается оно ОДНИМ кодом
   * для обоих ярусов (REND-20): узел детального яруса и инстанс-матрица
   * батчевого получают ровно те же числа, а не два похожих расчёта.
   */

  // ------------------------------------------------------------ публичное

  /**
   * АССЕТЫ за манифестом сменились (REND-1, REND-31): ре-экспорт `.glb`
   * (`blender-pipeline` BLND-12), правка текстуры, подмена сервиса ассетов
   * редактором. Второй несимуляционный вход подсистемы рядом с манифестом —
   * и он именно вход, а не догадка: кэш разделяемой части ключуется АДРЕСОМ
   * модели (ASSET-2), адрес при ре-экспорте тот же, и узнать о смене байтов
   * кэшу неоткуда. Не скажи ему — вьюпорт рисовал бы прежнюю модель до
   * переоткрытия сцены (ED-15).
   *
   * Освобождается всё, что построено из СТАРЫХ данных: батчи (их геометрия,
   * материалы и VAT производны от модели), разделяемая часть ассетов и то, что
   * инстансы держат от них. Сами инстансы не пересоздаются — они остаются теми
   * же объектами набора (REND-11): пересобирается только построенное, а
   * позиция, скин, фаза клипа и сглаженные величины переживают вход, как и на
   * переподаче манифеста (REND-17).
   */
  refreshAssets(): void {
    const ctx = this.requireCtx();
    // Смена поколения ассетов — СИНХРОННАЯ точка (REND-44, REND-1): она сносит
    // кэши и монтирует инстансы заново, а запись в очереди построенного ещё не
    // имеет — пересборка прошла бы мимо неё. Отложенное доделывается целиком
    // здесь же, до сноса кэшей.
    this.spawn.flush(this.mountOne);
    // Событие правки, а не кадр (ED-15): сток читается один раз, и счётчик
    // показывает цену — сколько инстансов пересобрано (PERF-3).
    const cost = costSink();
    // Порядок несущий: сперва инстансы отпускают построенное (их применения
    // скина держат текстуры кэша), затем уходят сами кэши, и только потом
    // инстансы монтируются заново — уже на свежих данных.
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) this.detachModel(record);
    }
    this.batches.dispose();
    this.shared.dispose();
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) {
        if (cost !== undefined) cost.modelsRebuilds++;
        this.rebuild(ctx, record);
      }
    }
  }

  /**
   * Прогрев по манифесту до первого кадра (FOW-8, REND-31): что именно
   * строится и почему — в `models/prewarm.ts`. Подсистема отдаёт прогреву своё
   * хозяйство и больше в него не вмешивается.
   */
  prewarm(): Promise<ModelsPrewarm> {
    return this.prewarmer.prewarm();
  }

  /**
   * Ручки качества подсистемы (QUAL-1, QUAL-3): стоимость кадра растёт числом
   * инстансов, и обе ручки правят именно её — множитель порогов LOD (REND-22)
   * решает, сколько треугольников несёт один инстанс, ярус по умолчанию
   * (REND-20) — сколько стоит его носитель.
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: MODELS_LOD_SCALE,
          cost: 'треугольники инстансов: множитель порогов переключения уровней детализации записи (REND-22, ASSET-13)',
          semantics: 'value',
          default: 1,
          // Только вверх от единицы: пресет вправе УДЕШЕВИТЬ картинку —
          // переключить инстанс на грубый уровень раньше, — но не обогатить её
          // сверх порогов автора (ASSET-13). Множитель меньше единицы держал бы
          // детальный уровень дальше, чем задумал автор записи, то есть
          // выправлял бы его данные пресетом. То же соображение, что у потолка
          // разрешения маски тумана (FOW-10): политика ограничивает авторское
          // значение в одну сторону, в другую — авторское значение и есть закон.
          min: 1,
          max: 8,
        },
        {
          name: MODELS_DEFAULT_TIER,
          cost: 'носитель инстанса: батчевый — общий InstancedMesh со скиннингом на GPU, детальный — пер-инстансный скелет, микшер и материалы (REND-20)',
          semantics: 'value',
          default: 'batched',
          values: ['batched', 'detailed'],
        },
      ],
    };
  }

  /**
   * Значения ручек от контроллера качества (QUAL-1). Множитель порогов доедет
   * ближайшим кадром сам — уровень выбирается в кадре (REND-22); смена яруса по
   * умолчанию пересобирает инстансы записей, ярус не назвавших, — это событие
   * уровня меню, а не кадра (design Risks): аллокационная дисциплина
   * кадрового пути ограничивает кадры, а не события.
   */
  applyQuality(values: QualityValues): void {
    const scale = values.get(MODELS_LOD_SCALE);
    if (typeof scale === 'number') this.lodScale = scale;
    const tier = values.get(MODELS_DEFAULT_TIER);
    if (tier === 'batched' || tier === 'detailed') this.applyDefaultTier(tier);
  }

  /**
   * Ярус по умолчанию на живой сцене (REND-20, QUAL-1). Пересобираются ровно
   * записи, ярус НЕ назвавшие: у явной записи и у контроля костей ярус свой, и
   * трогать их пресет не вправе. До `init` пересобирать нечего — инстансов ещё
   * нет, а ярус выберется при их создании.
   */
  private applyDefaultTier(next: VisualTier): void {
    if (next === this.defaultTier) return;
    this.defaultTier = next;
    const ctx = this.ctx;
    if (ctx === null) return;
    // Смена яруса — событие пресета, а не кадра (QUAL-1): сток читается один раз
    // на событие, и счётчик показывает ЦЕНУ переключения — сколько инстансов
    // пересобрано (PERF-3).
    const cost = costSink();
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) {
        if (record.kind === null) continue;
        if (record.visual?.tier !== undefined || record.visual?.boneControls !== undefined) continue;
        if (cost !== undefined) cost.modelsRebuilds++;
        this.rebuild(ctx, record);
      }
    }
  }

  /**
   * Тинт инстанса — порт «цвет на сущность» (REND-40): цвет команды, подсветка
   * выделения, любой другой цвет, который игра назначает КОНКРЕТНОЙ сущности.
   * `null` — тинт снят. Возвращает false, если инстанса нет.
   *
   * Порт один, и «цвета команды» среди его входов нет намеренно (механизм
   * против политики, `docs/architecture.md` §3): что такое команда, сколько их,
   * какого они цвета и по какому стату сущность к ним относится — политика
   * игры, живущая в её документе палитры. Рендер знает только «этой сущности —
   * этот цвет с этой силой», и второй порт, называющий одну из политик по
   * имени, ввёл бы в механизм понятие, которого в нём нет.
   *
   * Тинт живёт на ЗАПИСИ, а не на построенном из ассета: он переживает смену
   * яруса (REND-20), переподачу манифеста (REND-17) и позднюю загрузку модели
   * (ASSET-4) — по тем же основаниям, по каким их переживает выбранный скин.
   */
  setTint(entity: EntityId, tint: InstanceTintInput | null, decoration = false): boolean {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    if (record === undefined) return false;
    if (tint === null) setBaseTint(record.tint, 1, 1, 1, 0);
    else setBaseTint(record.tint, tint.r, tint.g, tint.b, tint.strength);
    return true;
  }

  /**
   * Смена скина инстанса без перезагрузки модели (REND-6): у детального яруса
   * подменяются текстуры его материалов, у батчевого — индекс варианта записи.
   * Возвращает false, если сущности нет.
   */
  setSkin(entity: EntityId, skin: string | undefined): boolean {
    const record = this.instances.get(entity);
    if (record === undefined) return false;
    // Скин назван поимённо: переподача манифеста его не отменит (REND-17).
    record.skinChosen = true;
    this.assignSkin(record, skin);
    return true;
  }

  /**
   * Прогрев по манифесту до первого кадра. Запрашивает модели ВСЕХ модельных
   * видов и, когда они доезжают, строит то, что иначе строил бы кадр первого
   * появления вида — а первое появление в матче с туманом это всплеск
   * открытия обзора (FOW-8): разделяемую часть и запечённые производные
   * (ASSET-12, у демо-модели — десятки миллисекунд запекания VAT), батчи
   * батчевых видов с их материалами и по образцу-инстансу детальных видов.
   * Возвращённые корни стоят ВНЕ сцены — сборка компилирует их программы тёплой
   * сценой (`WebGLRenderer.compile(warm, camera, scene)`) и возвращает
   * прогретое `finish()`; в кадр они не попадают ни на тик (REND-11, REND-18:
   * пустой батч не оставляет в сцене даже узла).
   *
   * Ждёт этот промис ТОЛЬКО модели. Всё, чему нужны ещё и текстуры скина, —
   * якоря программ (FOW-8) — вынесено во вторую ступень (`anchoredRoots`):
   * ассет вправе стоять в `loading` неограниченно (ASSET-4), и застрявшая
   * текстура одного вида не вправе отменить прогрев батчей и VAT-текстур,
   * которым она не нужна вовсе.
   *
   * Наблюдаемого состояния прогрев не меняет и счётчиков стоимости не двигает
   * (PERF-3 меряет доставку и кадр — прогрев живёт во времени загрузки);
   * не доехавшая модель прогрев не держит: её вид смонтируется прежним
   * ленивым путём с заглушкой (ASSET-4).
   */

  /**
   * Правленый манифест визуалов целиком (ED-14, ED-15, REND-17). Подсистема
   * сводит поданное с живыми инстансами сама: пере-инициализировать её или
   * пересобирать сцену ради правки записи не нужно.
   *
   * Пересобирается инстанс ровно тогда, когда изменилось то, что строится из
   * разделяемых данных ассета (REND-3), — модель, набор её рисуемых частей и
   * ярус записи (REND-20); остальное записи применяется на месте, потому что
   * пересоздание потеряло бы материалы скина (REND-6), фазу анимации и
   * сглаженный наклон (REND-10) — ровно то, что перечисляет REND-11, запрещая
   * пересоздание.
   *
   * Записи, не изменившиеся в поданном документе, наблюдаемых последствий не
   * получают: сравниваются ЗНАЧЕНИЯ, а не ссылки, — редактор отдаёт разобранный
   * документ, и после любой правки все объекты в нём новые.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    const ctx = this.requireCtx();
    // Переподача — СИНХРОННАЯ точка (REND-44): она пересобирает построенное из
    // ассета, а у записи в очереди построенного ещё нет, и пересборка прошла бы
    // мимо неё. Отложенное доделывается целиком здесь же — тем же правилом,
    // каким его доделывает разрыв непрерывности.
    this.spawn.flush(this.mountOne);
    // Переподача — событие правки документа (REND-17, ED-15), и сток читается
    // один раз на неё: цена переподачи — число пересобранных инстансов (PERF-3).
    const cost = costSink();
    // Переподача действует на оба пула: раздел decoration-видов — такая же
    // часть манифеста (ASSET-9), и правка записи камня обязана доехать и до
    // размещённой декорации (REND-17, ED-15).
    this.resupply(ctx, this.instances, cost);
    this.resupply(ctx, this.decorations, cost);
    // Переподача — единственная точка, где ключи батчей устаревают, и она же
    // их пересматривает (REND-31): в матче её не зовут ни разу, и кэш батчей
    // ведёт себя ровно как прежде.
    this.batches.retire(this.manifest);
  }

  private resupply(
    ctx: RenderContext,
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    cost: RenderCostCounters | undefined,
  ): void {
    for (const record of pool.values()) {
      // Невизуальная сущность (резолвер отнёс её к нерисуемым) записи не имеет.
      if (record.kind === null) continue;
      const before = record.visual;
      record.visual = resolveVisual(this.manifest, record.kind);
      // Блок света пересматривается раньше решения о пересборке (REND-17,
      // ED-15): свет не строится из разделяемых данных ассета, и появившийся
      // блок зажигает источник живого инстанса, а снятый — гасит.
      this.lighting.syncLight(record, this.manifest);
      if (rebuildsInstance(before, record.visual, this.defaultTier, record.decoration)) {
        if (cost !== undefined) cost.modelsRebuilds++;
        this.rebuild(ctx, record);
        continue;
      }
      // Модельной записи нет ни до, ни после — пересборки не будет, но заявка
      // чужой подсистемы за переподачу могла появиться либо исчезнуть, и
      // заглушка обязана поехать за ней (REND-37).
      if (record.visual === undefined) this.syncClaim(ctx, record);
      this.applyEntryParams(record);
      // Масштаб записи — нормализующая обёртка: переставляется на живом инстансе.
      record.model?.setScale(record.visual?.scale ?? 1);
      rescaleCull(record, this.carrierDeps, null);
      if (record.batch !== null) this.batches.syncEntry(record.batch, record.visual);
      record.controller?.setMapping(record.visual?.animations ?? {});
      this.syncBoneControls(record);
      this.syncSkin(record, before);
      // Правленая запись двигает и след пятна (REND-30): анимация записи меняет
      // ярус кастера, масштаб и габарит — радиус.
      this.lighting.syncBlob(record);
      // Правка записи (масштаб, наклон, перёд) двигает и walkable-поверхность
      // вместе с картинкой (REND-17 → REND-9).
      if (record.decoration) this.syncWalkable(record);
    }
  }

  /**
   * Отладочный источник инстансов (`render-debug` RDBG-1, REND-27): объём-прокси
   * в видимой позе, признак отсечения по пирамиде (REND-21), уровень детализации
   * (REND-22) и ярус представления (REND-20).
   *
   * Обход тот же, что у прокси picking'а, — и это несущее: показывается ТА ЖЕ
   * поза, которой инстанс нарисован, а не второй её расчёт. Инкрементов
   * счётчиков стоимости здесь нет ни одного (RDBG-8): отладка читает уже
   * посчитанное кадром.
   */
  debugSources(): readonly DebugSource[] {
    return [
      modelsInstancesDebugSource({
        each: (out, visit) => {
          for (const record of this.instances.values()) {
            if (this.fillDebugRow(record, out)) visit();
          }
          // Декорации — после сущностей, тем же порядком, что у прокси (REND-18).
          for (const record of this.decorations.values()) {
            if (this.fillDebugRow(record, out)) visit();
          }
        },
      }),
    ];
  }

  /**
   * Инстанс в переиспользуемую запись отладки; false — рендер его не рисует.
   * Поза кладётся ТЕМ ЖЕ `fillProxy`, что и у picking'а (REND-15): запись
   * отладки и есть объём-прокси плюс решения кадра, второго заполнения нет.
   */
  private fillDebugRow(record: InstanceRecord, out: DebugInstanceRow): boolean {
    if (!this.fillProxy(record, out)) return false;
    out.tier = record.carrier.tier;
    out.lodLevel = record.lodLevel;
    out.visible = record.visible;
    out.placeholder = record.placeholder !== null;
    return true;
  }

  /**
   * Объёмы-прокси нарисованных инстансов — вход picking'а вьюпорта (REND-15) и
   * подсветки выделения (REND-16). Подсистема отдаёт ТО САМОЕ ПРЕОБРАЗОВАНИЕ,
   * которым инстанс нарисован в этом кадре, — посадка на визуальную поверхность
   * (REND-9), вертикальное смещение (REND-12), наклон (REND-10), курс с
   * поправкой переда (REND-13) и масштаб (REND-11) уже в нём. Пересчитывать их
   * второй раз было бы вторым ответом на один вопрос, а отдавать узлом — обещать
   * наружу то, чего у батчевой записи (REND-20) нет.
   *
   * Ни отсечение (REND-21), ни выбранный уровень детализации (REND-22) обход не
   * меняют: объём-прокси производен от границ МОДЕЛИ, а невидимый инстанс из
   * набора не исчезает — picking по нему промахивается лучом, а не отсутствием.
   */
  eachProxy(visit: PickProxyVisitor): void {
    for (const record of this.instances.values()) {
      if (this.fillProxy(record, this.proxy)) visit(this.proxy);
    }
    // Decoration-инстансы — после инстансов presentation-состояния (REND-18):
    // правило «первый в порядке набора» (REND-15) при двух наборах остаётся
    // определённым только заданным порядком обхода.
    for (const record of this.decorations.values()) {
      if (this.fillProxy(record, this.proxy)) visit(this.proxy);
    }
  }

  /**
   * Прокси одного инстанса; false — рендер его не рисует, попадать не во что.
   * `decoration` выбирает пул: нумерация у них своя, и одно число значит в них
   * разные инстансы (REND-18).
   */
  proxyOf(entity: EntityId, out: PickProxy, decoration = false): boolean {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    return record === undefined ? false : this.fillProxy(record, out);
  }

  /** Сколько decoration-инстансов нарисовано — по этому видно, что набор доехал. */
  get decorationCount(): number {
    return this.decorations.size;
  }

  /**
   * Диагностика батчевого яруса (REND-20): сколько батчей заведено, сколько
   * инстанс-мешей рисуется в этом кадре и сколько записей в них живёт. По ней и
   * видно главное свойство яруса — число draw calls растёт с числом ЗАПИСЕЙ
   * манифеста, а не с числом инстансов.
   */
  batchStats(): { readonly batches: number; readonly drawnMeshes: number; readonly records: number } {
    return this.batches.stats();
  }

  /** Инстанс-меши всех батчей — вход теста компактации (`count` на меш). */
  batchMeshes(): readonly THREE.InstancedMesh[] {
    return this.batches.meshes();
  }

  /**
   * Попадание только в нарисованное (REND-15): у сущности, отнесённой резолвером
   * к невизуальным, нет ни модели, ни заглушки — и прокси у неё нет. Инстанс,
   * чья модель ещё грузится, участвует объёмом заглушки (ASSET-4): автор видит
   * её и вправе её двигать. Инстанс, созданный `syncTick` и ещё не получивший
   * позы кадра, не участвует: в кадре его нет.
   */
  private fillProxy(record: InstanceRecord, out: PickProxy): boolean {
    if (!record.posed) return false;
    const bounds = boundsOf(record);
    if (bounds === null) return false;
    out.entity = record.entity;
    out.decoration = record.decoration;
    out.handle = null;
    out.posX = record.pos.x;
    out.posY = record.pos.y;
    out.posZ = record.pos.z;
    out.quatX = record.quat.x;
    out.quatY = record.quat.y;
    out.quatZ = record.quat.z;
    out.quatW = record.quat.w;
    out.scaleX = record.scale;
    out.scaleY = record.scale;
    out.scaleZ = record.scale;
    out.minX = bounds.minX;
    out.minY = bounds.minY;
    out.minZ = bounds.minZ;
    out.maxX = bounds.maxX;
    out.maxY = bounds.maxY;
    out.maxZ = bounds.maxZ;
    return true;
  }

  /**
   * Инстанс сущности — для отладки и тестов. Объект стабилен на всё время жизни
   * инстанса: им и наблюдается «инстанс тот же», когда переподача манифеста
   * пересобирает построенное из ассета, а размещённый объект оставляет на месте
   * (REND-17). Узла сцены он не отдаёт (REND-3).
   */
  /**
   * Мировая поза названного узла инстанса (REND-20, REND-24): кость скелета у
   * детального яруса, выборка из VAT у батчевого — ответ ОДИН, потому что
   * наблюдаемое поведение ярусов обязано совпадать. `false` — узла с таким
   * именем у инстанса нет (другое имя, модель ещё едет, вид рисуют частицы).
   *
   * Поза пишется в поданную запись: потребитель спрашивает её на эмиттер
   * каждым кадром (REND-24), и своего объекта у ответа быть не должно.
   */
  nodePose(entity: EntityId, node: string, out: NodePose, decoration = false): boolean {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    if (record === undefined) return false;
    const entry = record.visual === undefined ? undefined : this.shared.get(record.visual.model);
    return nodePoseOf(record, node, entry, out);
  }

  instanceFor(entity: EntityId, decoration = false): ModelInstanceView | null {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    if (record === undefined) return null;
    record.publicView ??= viewOf(record);
    return record.publicView;
  }

  // ------------------------------------------------------------ внутреннее

  private requireCtx(): RenderContext {
    if (this.ctx === null) throw new Error('ModelsSubsystem: init() не вызван (REND-8)');
    return this.ctx;
  }

  /**
   * Набор вариантов скина батча пересобран (REND-6, REND-17): сквозные индексы
   * поехали, и каждой ЖИВОЙ записи этого батча индекс переставляется заново.
   * Записи знает владелец пулов — кэш батчей их не видит вовсе.
   */
  private reindexBatchSkins(entry: BatchEntry): void {
    for (const pool of [this.instances, this.decorations]) {
      for (const record of pool.values()) {
        if (record.batch !== entry) continue;
        record.skinIndex = entry.skins.indexOf(record.skin);
        entry.batch.setSkin(record.slot, record.skinIndex);
      }
    }
  }

  /** Скин инстанса: у детального — текстуры материалов, у батчевого — индекс (REND-6). */
  private assignSkin(record: InstanceRecord, skin: string | undefined): void {
    record.skin = skin;
    record.carrier.applySkin(record, this.carrierDeps);
    const entry = record.batch;
    if (entry !== null) {
      // Смена скина батчевой записи — запись ОДНОГО ЧИСЛА: соседние записи
      // батча и разделяемый набор вариантов не затронуты (REND-6).
      record.skinIndex = entry.skins.indexOf(skin);
      entry.batch.setSkin(record.slot, record.skinIndex);
    }
  }

  /**
   * Величины записи, которые инстанс применяет покадрово: наклон (REND-10),
   * перёд (REND-13), вертикальное смещение (REND-12). Раскладываются в точке
   * приёма записи — при создании инстанса и при переподаче манифеста (REND-17),
   * — а не в кадре: конверсия градусов и разрешение дефолта манифеста делаются
   * один раз. Присваивание того же значения последствий не имеет по построению.
   */
  private applyEntryParams(record: InstanceRecord): void {
    const visual = record.visual;
    const align = resolveSurfaceAlign(this.manifest, visual);
    record.tiltFactor = align.factor;
    record.tiltMaxRad = align.maxAngleDeg === undefined ? null : (align.maxAngleDeg * Math.PI) / 180;
    // Перёд записи описан как направление лица модели; поправка разворота —
    // противоположный угол, см. `InstanceRecord.facingOffset`.
    record.facingOffset =
      visual?.facingDeg === undefined ? DEFAULT_FACING_RAD : -visual.facingDeg * DEG_TO_RAD;
    // Вертикальное смещение (REND-12) у decoration отсутствует: ни дуги прыжка,
    // ни снижения при провале — манёвров у него не бывает (REND-18). Запись с
    // этой секцией остаётся валидной (ASSET-9), но смысла ей здесь не придаётся.
    const offset = record.decoration ? undefined : visual?.verticalOffset;
    record.jumpArcHeight = offset?.jumpArc ?? 0;
    record.maneuverArcHeight = offset?.maneuverArc ?? 0;
    record.flightArcHeight = offset?.flightArc ?? 0;
    record.fallSpeed = offset?.fallSpeed ?? 0;
    record.fallDepth = offset?.fallDepth ?? 0;
    // Снижения у записи больше нет — нет и состояния `fall`: переподача
    // манифеста вправе снять параметры (REND-17), и состояние обязано уйти
    // вместе с ними, а не держаться до разрыва непрерывности.
    record.falling &&= descends(record);
    if (!record.falling) record.fallOffset = 0;
    // Блок тинта записи (ASSET-18, REND-40) раскладывается ЗДЕСЬ, а не в кадре:
    // цвета вспышек разбираются один раз на запись манифеста, а не на инстанс.
    // База канала (то, что поставил порт) переподачу переживает — она свойство
    // сущности, а не записи; уходит с записью только МАСКА и таблица вспышек.
    const tintEntry = resolveTintEntry(visual);
    record.tintMask = tintEntry.materials;
    record.tintFlashes = tintEntry.byEvent;
    // Растворение трупа (REND-4): запись без блока труп не растворяет — он
    // лежит, пока его не снимет сцена. Отсчёт задержки начинается заново,
    // потому что новое число задержки к прошедшему времени не применимо.
    const dissolve = record.decoration ? undefined : visual?.dissolve;
    record.dissolveDelay = dissolve?.delay ?? 0;
    record.dissolveDuration = dissolve?.duration ?? 0;
    record.dissolveHeld = record.dissolveDelay;
  }

  /** Параметры контроля костей записи на живом инстансе (REND-5, REND-17). */
  private syncBoneControls(record: InstanceRecord): void {
    // Процедурный контроль костей производен от цели атаки/каста (REND-5), а у
    // decoration её не бывает: роли записи на него не действуют (ASSET-9).
    const controls = record.decoration ? undefined : record.visual?.boneControls;
    if (controls === undefined) {
      // Роли сняты: пустая таблица заодно вернёт костям то, что было до override.
      record.boneControl?.setControls({});
      return;
    }
    if (record.boneControl === null) record.boneControl = new BoneControlState(controls);
    else record.boneControl.setControls(controls);
  }

  /**
   * Скин после переподачи (REND-17): выбранный поимённо остаётся, невыбранный
   * переезжает на `defaultSkin` новой записи. Текстуры переставляются заново
   * только если изменились подмены самого выбранного скина — правка чужого
   * скина этот инстанс не касается.
   */
  private syncSkin(record: InstanceRecord, before: EntityVisual | undefined): void {
    const skin = record.skinChosen ? record.skin : record.visual?.defaultSkin;
    if (skin !== record.skin) {
      this.assignSkin(record, skin);
      return;
    }
    if (record.model !== null && !sameSkinSlots(before, record.visual, skin)) {
      record.carrier.applySkin(record, this.carrierDeps);
    }
  }

  /**
   * Инстанс строится заново под новую запись (REND-3, REND-17). Поза и место в
   * наборе остаются те же: пересобирается то, что построено из разделяемых
   * данных ассета, а не размещённый объект — его идентичность в документе
   * (REND-11) и попадание picking'а (REND-15) переподачу переживают.
   */
  private rebuild(ctx: RenderContext, record: InstanceRecord): void {
    this.detachModel(record);
    this.applyEntryParams(record);
    if (!record.skinChosen) record.skin = record.visual?.defaultSkin;
    this.attachVisual(ctx, record);
    // Другая модель записи: до её готовности walkable-вклада нет (ASSET-4,
    // REND-9) — кэшированный ассет вернёт его сразу же через attachModel.
    if (record.decoration) this.syncWalkable(record);
  }

  /**
   * Анимация инстанса: состояние из presentation-состояния (REND-4) и клип,
   * назначенный набором инстансов поверх него (REND-11). На пути тика клип не
   * назначается никогда, и override остаётся снятым.
   */
  private applyAnimation(record: InstanceRecord): void {
    const controller = record.controller;
    if (controller === null) return;
    controller.setState(animationStateOf(record));
    controller.setClipOverride(record.view.clip);
  }

  private create(
    ctx: RenderContext,
    view: EntityView,
    decoration: boolean,
    fadeIn = false,
  ): InstanceRecord {
    // Разрешение ключа — одно на оба раздела манифеста (ASSET-9): decoration
    // вправе сослаться и на запись сущности, если камень у неё и prop, и
    // декорация, — второй копии записи для этого не заводится.
    const visual = view.kind === null ? undefined : resolveVisual(this.manifest, view.kind);
    const record: InstanceRecord = {
      entity: view.id,
      kind: view.kind,
      decoration,
      visual,
      view,
      holder: null,
      placeholder: null,
      emitter: false,
      carrier: NONE_CARRIER,
      model: null,
      batch: null,
      slot: -1,
      waitingOn: null,
      vat: null,
      skinIndex: 0,
      lodLevel: 0,
      cullBounds: null,
      controller: null,
      boneControl: null,
      skinApp: null,
      skin: view.skin ?? visual?.defaultSkin,
      skinChosen: view.skin !== undefined,
      viewSkin: view.skin,
      viewScale: view.scale,
      // Масштаб набора — множитель поверх масштаба записи манифеста (REND-11):
      // запись масштабирует модель, набор — конкретное размещение.
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: view.scale ?? 1,
      facingOffset: DEFAULT_FACING_RAD,
      yaw: 0,
      snapPending: true,
      tiltFactor: 0,
      tiltMaxRad: null,
      tilt: { x: 0, y: 0 },
      jumpArcHeight: 0,
      maneuverArcHeight: 0,
      flightArcHeight: 0,
      fallSpeed: 0,
      fallDepth: 0,
      falling: false,
      fallOffset: 0,
      placedX: Number.NaN,
      placedY: Number.NaN,
      placedYaw: Number.NaN,
      placedWalkable: false,
      posed: false,
      visible: true,
      // Появление в наборе с включённым fade — короткий fade-in (FOW-8): вышла
      // ли сущность из тумана или только что заспавнилась, доставленное не
      // различает (NET-14), и мягкое проявление честно для обоих прочтений.
      fade: fadeIn && !decoration ? 0 : 1,
      fadedTargets: null,
      fadingOut: false,
      deathLock: false,
      lightCarrier: null,
      blobCaster: null,
      // Опора до первого кадра — мировой ноль с вертикальной нормалью; позы
      // инстанс ещё не получил, и пятна ему всё равно не полагается (`posed`).
      seatZ: 0,
      seatNormal: { x: 0, y: 0, z: 1 },
      // Канал тинта (REND-40) заводится пустым: сила ноль — множитель
      // единичный, и инстанс без тинта рисуется как рисовался бы без канала.
      tint: makeTint(),
      tintMask: null,
      tintFlashes: null,
      dissolve: 1,
      dissolveHeld: 0,
      dissolved: false,
      dissolveDelay: 0,
      dissolveDuration: 0,
      pendingMount: false,
      publicView: null,
    };
    this.applyEntryParams(record);
    record.yaw = view.facingYaw + record.facingOffset;

    // Дорогая половина создания — монтирование изображения — вправе уехать под
    // бюджет кадра (REND-44): волна спавна кладёт в очередь, а фаза отложимой
    // работы достаёт из неё, пока есть время. Запись пула при этом уже готова:
    // доставка применяется ЦЕЛИКОМ, и режется не она, а построение из ассета.
    //
    // Decoration сюда не попадает намеренно: его набор — документ авторинга
    // (REND-18, PRES-2), и правка автора обязана быть видна в том же кадре
    // (ED-15) — ровно то основание, по которому документный продюсер работает с
    // неограниченным бюджетом.
    if (decoration || !this.spawn.defer(record)) this.mountVisual(ctx, record);
    return record;
  }

  /**
   * Заглушка и модель записи для инстанса, у которого их ещё (или уже) нет:
   * общая часть создания инстанса и его пересборки под новой записью (REND-17).
   */
  private attachVisual(ctx: RenderContext, record: InstanceRecord): void {
    record.emitter = false;
    const kind = record.kind;
    // Резолвер явно отнёс сущность к невизуальным — не рисуем и не шумим.
    if (kind === null) return;

    const visual = record.visual;
    if (visual === undefined) {
      // Модельной записи нет — но изображение у вида может быть чужое (REND-37).
      // Решает это ОДНО место на оба входа: и на создании инстанса, и на
      // переподаче манифеста. Два места пришли бы к одной и той же
      // конфигурации разными следами в сцене — держатель, снятый на одной
      // дороге и оставленный пустым на другой.
      this.syncClaim(ctx, record);
      return;
    }

    // Модель грузится асинхронно; до готовности — заглушка (ASSET-4). Когда
    // разделяемая часть уже в кэше — обычный путь всплеска открытия обзора
    // (FOW-8): пачка инстансов уже виденной модели за одну доставку — заглушка
    // не строится вовсе: `attachModel` снял бы её тем же вызовом, и пара
    // «создать Group с Mesh, объявить кастера — тут же снести» на каждый
    // инстанс всплеска была бы платой ни за что.
    const entry = this.shared.ensure(visual.model);
    if (entry.data !== null) {
      this.attachModel(record, entry.data);
      return;
    }
    attachPlaceholder(record, this.carrierDeps);
    if (entry.failed === null) {
      entry.waiting.add(record);
      record.waitingOn = entry;
    }
  }

  /**
   * Изображение вида, у которого модельной записи нет (REND-37): чужая заявка
   * снимает заглушку, её отсутствие — ставит. Одно место на все входы —
   * создание инстанса, пересборку под новой записью и переподачу манифеста
   * (REND-17), — и зовётся оно на переподаче ОТДЕЛЬНО от `rebuild`: тот идёт
   * от `rebuildsInstance`, а он сравнивает МОДЕЛЬНЫЕ записи и перехода
   * «заявки не было → заявка есть» не видит вовсе.
   *
   * Идемпотентно: повторный вызов на той же конфигурации ничего не меняет.
   * Построенного из ассета у такого инстанса нет, и пересобирать здесь нечего.
   */
  private syncClaim(ctx: RenderContext, record: InstanceRecord): void {
    const kind = record.kind;
    if (kind === null) return;
    const claim = resolveVisualClaim(this.manifest, kind);
    record.emitter = claim === 'particles';
    if (record.emitter) record.carrier = EMITTER_CARRIER;
    if (claim !== null) {
      // Содержимое держателя меняется — сперва конец эпизода угасания, тем же
      // порядком и по той же причине, что в `attachModel` (FOW-8): fade-копии
      // материалов привязаны к прежним мешам, и снятая отсюда заглушка унесла
      // бы выданную копию с собой.
      this.fade.clear(record);
      // Узел заводился под заглушку; чужому изображению он не нужен, и пустым
      // в сцене не остаётся — иначе кастер объявлен, а рисовать им нечего.
      disposePlaceholder(record);
      releaseHolder(record, this.carrierDeps);
      return;
    }
    if (record.placeholder !== null) return;
    this.warnMissingVisual(kind);
    attachPlaceholder(record, this.carrierDeps);
  }

  /** Записи о виде в манифесте нет — предупреждение один раз на тип (ASSET-6). */
  private warnMissingVisual(kind: string): void {
    if (this.warnedKinds.has(kind)) return;
    this.warnedKinds.add(kind);
    this.warn(`render: для типа "${kind}" нет записи в манифесте визуалов — заглушка (ASSET-6)`);
  }

  /**
   * Корень нарисованного инстанса — приёмнику теней вместе с ярусом (REND-8).
   * Корень, а не каждый меш: флаги расставляет обходом сам приёмник, а сменить
   * их у поддерева, которое ещё только строится, здесь было бы нечем.
   */

  /**
   * Ярус записи (REND-20, ASSET-13) с учётом деградации: батчевый требует
   * запечённых производных модели (ASSET-12), и без них запись рисуется
   * детальным ярусом — предупреждение о них выдано один раз на модель там же,
   * где производные и спрашивались.
   */
  private tierOf(record: InstanceRecord, shared: SharedEntry): VisualTier {
    if (declaredTier(record.visual, this.defaultTier) === 'detailed') return 'detailed';
    return shared.derivatives === null ? 'detailed' : 'batched';
  }

  private attachModel(record: InstanceRecord, shared: SharedModelData): void {
    if (record.model !== null || record.batch !== null) return;
    // Смена содержимого держателя (заглушка → модель): fade-копии материалов
    // привязаны к прежним мешам — вернуть разделяемые, копии — в пулы их
    // оригиналов; идущий fade заново возьмёт их по новому поддереву (FOW-8).
    this.fade.clear(record);
    const entry = record.visual === undefined ? undefined : this.shared.get(record.visual.model);
    if (entry === undefined) return;
    const derivatives = entry.derivatives;
    if (this.tierOf(record, entry) === 'batched' && derivatives !== null) {
      attachBatched(
        record,
        this.carrierDeps,
        this.batches.ensure(record, shared, derivatives),
        derivatives,
        this.controllerOptions,
      );
    } else {
      attachDetailed(record, this.carrierDeps, shared, this.controllerOptions);
    }

    // Ярус нарисованного сменился (заглушка → модель либо → запись батча): его
    // корень объявляется приёмнику теней заново.
    this.lighting.markCaster(record);
    // Габариты приехали вместе с моделью (ASSET-4, ASSET-12) — след пятна
    // считается по ним, а не по заглушке (REND-30).
    this.lighting.syncBlob(record);

    // Модель готова — walkable-вклад появляется в поле, и подписчики поверхности
    // узнают о клетках под bbox не позже следующего кадра (ASSET-4 → REND-9).
    if (record.decoration) this.syncWalkable(record);
  }

  /**
   * Снимает с инстанса всё построенное из данных ассета — заглушку, модель или
   * запись батча, анимационный контроллер, контроль костей и текстуры скина.
   * Общая часть удаления инстанса и его пересборки под новой записью (REND-17);
   * разделяемые данные ассета и сам батч остаются в кэше (REND-3).
   *
   * ЧТО именно снимать, знает носитель (REND-20): здесь — только общее у всех
   * носителей и порядок, в котором это делается.
   */
  private detachModel(record: InstanceRecord): void {
    // Конец эпизода угасания ПЕРВЫМ делом (FOW-8): пока копии выданы, они
    // лежат в мешах, а не в пулах, — и снос поддерева ниже унёс бы их вместе с
    // единственной ссылкой, а освобождение материалов инстанса оставило бы
    // выданную копию жить дольше своего оригинала (REND-3, REND-6).
    this.fade.clear(record);
    // Ожидание снимается ПО ССЫЛКЕ записи: инстанс ждёт ровно одну модель
    // (`attachVisual`), и обход всех разделяемых записей стоил бы числом
    // ассетов сцены на каждое снятие инстанса.
    record.waitingOn?.waiting.delete(record);
    record.waitingOn = null;
    // Ярус — свойство НАРИСОВАННОГО (REND-20): пока построенного из ассета у
    // записи нет, рисовать нечем, и наружу (`instanceFor`) уходит носитель
    // пустоты. Настоящий проставит `attachModel`, как только сможет.
    record.carrier.detach(record, this.carrierDeps);
    record.carrier = NONE_CARRIER;
  }

  private remove(record: InstanceRecord): void {
    // Запись, ещё стоявшая в очереди монтирования (REND-44), уходит вместе с
    // пометкой: монтировать исчезнувшую сущность не для чего, и очередь не
    // должна держать мёртвую запись до своего прохода. Единственная точка,
    // через которую запись покидает кадр, — здесь она и снимается.
    this.spawn.cancel(record);
    // Исчезнувшая walkable-декорация забирает свой вклад из поля; подписчики
    // получают клетки под прежним bbox (REND-9, REND-18).
    if (record.decoration) this.options.surface?.setWalkable(record.entity, null);
    // Источник снят вместе с инстансом (REND-33): источники прочих инстансов
    // той же записи горят как горели.
    this.lighting.dropLight(record);
    this.lighting.dropBlob(record);
    this.detachModel(record);
    if (record.holder !== null) this.lighting.dropCaster(record.holder);
    record.holder?.removeFromParent();
    record.holder = null;
  }

  /**
   * Сведение walkable-вклада инстанса с реестром поля (REND-9): вклад есть
   * ровно тогда, когда декорация несёт флаг записи (PRES-2 → REND-18) и её
   * модель готова (ASSET-4). Размещение — те же величины, которыми `poseAll`
   * ставит инстанс в кадре: позиция набора, курс с поправкой переда (REND-13),
   * k/limit наклона записи, итоговый масштаб меша как у `createModelInstance`.
   * Посадку по террейн-форме реестр считает сам — тем же расчётом (REND-9).
   */
  private syncWalkable(record: InstanceRecord): void {
    const source = this.options.surface;
    if (source === undefined) return;
    const visual = record.visual;
    const entry = visual === undefined ? undefined : this.shared.get(visual.model);
    const model = entry?.data?.model;
    const view = record.view;
    if (view.walkable !== true || visual === undefined || model === undefined) {
      source.setWalkable(record.entity, null);
      return;
    }
    source.setWalkable(record.entity, {
      x: view.currX,
      y: view.currY,
      yaw: view.facingYaw + record.facingOffset,
      tiltFactor: record.tiltFactor,
      tiltMaxRad: record.tiltMaxRad,
      // Нормализация — та же, что у `createModelInstance`: высота модели → 1
      // мировая единица × масштаб записи, поверх — масштаб набора (REND-11).
      scale: (view.scale ?? 1) * normalizedScale(visual.scale, model),
      model,
      // Скрытые части записи (ASSET-6) не рисуются — и в поле не попадают:
      // индекс реестра обязан совпадать с нарисованным набором частей (REND-9).
      hiddenParts: visual.hiddenParts,
    });
  }

}

// ------------------------------------------------------------ помощники

/**
 * Сущности, о чьей смерти сказали события ЭТОЙ доставки (FOW-8): для них
 * исчезновение из состояния — гибель, а не уход в туман, и инстанс снимается
 * существующим путём. null — событий смерти в доставке нет.
 */
function diedIn(view: TickView, deathEvent: string | undefined): ReadonlySet<EntityId> | null {
  const type = deathEvent ?? DEFAULT_DEATH_EVENT;
  let died: Set<EntityId> | null = null;
  for (const event of view.events) {
    if (event.type !== type) continue;
    const entity = event.data.entity ?? event.data.source;
    if (entity === undefined) continue;
    died ??= new Set();
    died.add(entity);
  }
  return died;
}
