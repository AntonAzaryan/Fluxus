/* eslint-disable max-lines -- baseline */
/**
 * Подсистема моделей (REND-3..6): пул инстансов по сущностям presentation-
 * состояния.
 *
 * Появление сущности в presentation-состоянии создаёт инстанс, исчезновение —
 * убирает. Разделяемая часть ассета (геометрия, клипы) строится один раз и
 * кэшируется здесь; скелет, материалы и анимационное состояние — свои на
 * инстанс. Всё поведение — из манифеста визуалов (ASSET-6): модель, скины,
 * маппинг анимаций, параметры bone-контроля.
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
 * ASSET-9), скин (REND-6), перёд (REND-13), посадка на визуальную поверхность
 * (REND-9) и наклон по её нормали (REND-10). Второго пути отрисовки не
 * появляется — этого требуют и REND-18, и REND-11. Разница ровно в том, чего у
 * декорации нет: вертикального смещения (REND-12), контроля костей (REND-5) и
 * событийных клипов (REND-4) — производить их не от чего.
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
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_ROLL,
  type EntityId,
} from '@game-mvp/core';
import {
  resolveSurfaceAlign,
  resolveVisual,
  type AssetState,
  type EntityVisual,
  type NormalizedModel,
  type VisualManifest,
} from '@game-mvp/assets';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from '../types.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { SurfaceNormal, VisualSurface } from '../visualSurface.js';
import { createPickProxy, type InstanceProxySource, type PickProxy, type PickProxyVisitor } from '../picking.js';
import type { ModelBounds } from '../model/build.js';
import { orientFromTiltYaw, smoothTilt, tiltTarget, type TiltVector } from '../model/surfaceAlign.js';
import {
  buildSharedModel,
  createModelInstance,
  type ModelInstance,
  type SharedModelData,
} from '../model/build.js';
import {
  advanceFall,
  jumpArc,
  jumpBase,
  maneuverEnds,
  type ManeuverEnds,
} from '../model/verticalOffset.js';
import { AnimationController } from '../model/animation.js';
import { BoneControlState } from '../model/boneControl.js';
import { smoothYaw } from '../model/boneControl.js';
import { applySkin, skinTextureSources, type SkinApplication } from '../model/skins.js';

export interface ModelsOptions {
  /** Тип события смерти — конвенция ядра. */
  readonly deathEvent?: string;
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
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

const DEFAULT_TURN_RATE = 12;
const DEFAULT_TILT_RATE = 10;
/**
 * Перёд модели, когда запись манифеста его не называет (REND-13): соглашение
 * первого поддержанного формата — у MDX лицо вдоль `+X`, то есть 0. Так модели,
 * добавленные до появления параметра, не меняют вид.
 */
const DEFAULT_FACING_RAD = 0;
const DEG_TO_RAD = Math.PI / 180;
const PLACEHOLDER_COLOR = 0xd040d0;
/** Габариты заглушки (ASSET-4) — из них же строится её геометрия. */
const PLACEHOLDER_WIDTH = 0.4;
const PLACEHOLDER_HEIGHT = 0.9;
/**
 * Объём-прокси заглушки (REND-15). Границ модели у неё нет — она сама и есть
 * нарисованное, поэтому прокси производен от её геометрии, а не от размера,
 * назначенного picking'ом отдельно.
 */
const PLACEHOLDER_BOUNDS: ModelBounds = {
  minX: -PLACEHOLDER_WIDTH / 2,
  minY: -PLACEHOLDER_WIDTH / 2,
  minZ: 0,
  maxX: PLACEHOLDER_WIDTH / 2,
  maxY: PLACEHOLDER_WIDTH / 2,
  maxZ: PLACEHOLDER_HEIGHT,
};
/** Конвенция арены ядра (ARENA-5); имя переопределяется опцией. */
const DEFAULT_FALL_EVENT = 'FellThroughFloor';

// Переиспользуемые между кадрами объекты — аллокаций на инстанс на кадр нет.
const SCRATCH_NORMAL: SurfaceNormal = { x: 0, y: 0, z: 1 };
const SCRATCH_TILT: TiltVector = { x: 0, y: 0 };
const SCRATCH_ENDS: ManeuverEnds = { takeoffX: 0, takeoffY: 0, landingX: 0, landingY: 0 };
/** Наименьшая высота нормализации модели — как у `createModelInstance`. */
const MIN_MODEL_HEIGHT = 1e-3;

/**
 * Закрытый словарь состояний анимации (REND-4). Какие состояния бывают —
 * контракт рендера; какой клип на состояние ложится — политика манифеста
 * (ASSET-6), поэтому имён клипов здесь нет и быть не может.
 */
const STATE_IDLE = 'idle';
const STATE_MOVE = 'move';
const STATE_FALL = 'fall';

/** Манёвр машины локомоушена (LOC-3) → состояние; вне таблицы — idle/move по скорости. */
const MOTION_STATE: Readonly<Record<number, string>> = {
  [LOCOMOTION_DODGE]: 'dodge',
  [LOCOMOTION_ROLL]: 'roll',
  [LOCOMOTION_AIRBORNE]: 'jump',
};

/**
 * Состояние анимации инстанса (REND-4): снижение при провале — состояние
 * рендера, манёвр — из машины локомоушена мира, всё остальное — по скорости.
 * Окно даблтапа (LOC-4) в таблице манёвров отсутствует намеренно: ввод в нём
 * рулит скоростью штатно, значит и анимация штатная.
 */
function animationStateOf(record: InstanceRecord): string {
  if (record.falling) return STATE_FALL;
  return MOTION_STATE[record.view.motion] ?? (record.view.moving ? STATE_MOVE : STATE_IDLE);
}

/**
 * Прыжок в этом кадре (REND-12): манёвр `Airborne` с читаемой фазой. Ветка
 * выбирается по манёвру, а не по флагу override уровня: override носят и
 * снаряды, и проваливающиеся сущности (ARENA-6), и им ступенчатая база уместна.
 */
function isAirborne(view: EntityView): boolean {
  return view.motion === LOCOMOTION_AIRBORNE && Number.isFinite(view.currMotionPhase);
}

interface SharedEntry {
  data: SharedModelData | null;
  failed: string | null;
  /** Инстансы, ждущие готовности ассета. */
  readonly waiting: Set<InstanceRecord>;
}

interface InstanceRecord {
  readonly entity: EntityId;
  readonly kind: string | null;
  /**
   * Инстанс — decoration (REND-18), а не сущность presentation-состояния.
   * Признак нужен снаружи (picking REND-15, подсветка REND-16): нумерация у
   * двух пулов своя, и одно число значит в них разные инстансы.
   */
  readonly decoration: boolean;
  /** Запись манифеста этого типа; переподача манифеста её меняет (REND-17). */
  visual: EntityVisual | undefined;
  view: EntityView;
  /** Узел позиции/курса; под ним либо заглушка, либо модель. */
  readonly holder: THREE.Group;
  placeholder: THREE.Mesh | null;
  model: ModelInstance | null;
  controller: AnimationController | null;
  boneControl: BoneControlState | null;
  skinApp: SkinApplication | null;
  skin: string | undefined;
  /**
   * Скин выбран этому инстансу поимённо — полем набора (REND-11) или сменой
   * скина (REND-6), — а не взят из `defaultSkin` записи. Переподача манифеста
   * выбранного не отменяет (REND-17), а невыбранному отдаёт новый умолчательный.
   */
  skinChosen: boolean;
  /**
   * Скин и масштаб, назначенные presentation-состоянием (REND-11): хранятся,
   * чтобы отличить «набор поменял поле» от «набор им не правит вовсе». На пути
   * тика оба всегда `undefined`, поэтому `setSkin` остаётся единственным
   * источником скина и ничем не перебивается.
   */
  viewSkin: string | undefined;
  viewScale: number | undefined;
  yaw: number;
  snapPending: boolean;
  /**
   * Поправка разворота инстанса, радианы (REND-13): курс сущности плюс она даёт
   * угол holder'а. Это ПРОТИВОПОЛОЖНОСТЬ переда модели из манифеста — чтобы
   * лицо, смотрящее под углом `f`, оказалось направлено по курсу, инстанс надо
   * довернуть на `−f`. Конверсия градусов и смена знака сделаны один раз при
   * приёме записи, а не в кадре.
   */
  facingOffset: number;
  /** Параметры наклона записи (ASSET-6): factor 0 выключает наклон. */
  tiltFactor: number;
  tiltMaxRad: number | null;
  /** Сглаженный наклон «ось × угол» (REND-10). */
  readonly tilt: TiltVector;
  /** Параметры вертикального смещения записи (ASSET-6); нули — смещения нет (REND-12). */
  jumpArcHeight: number;
  fallSpeed: number;
  fallDepth: number;
  /**
   * Снижение при провале — presentation-состояние инстанса: в мире состояния
   * «падает» нет, есть событие (ARENA-5). Живёт до разрыва непрерывности.
   */
  falling: boolean;
  fallOffset: number;
  /**
   * Инстанс уже получил позу кадра. До первого `updateFrame` holder стоит в
   * мировом нуле, а не там, где сущность: попадание в него было бы попаданием
   * в ненарисованное (REND-15).
   */
  posed: boolean;
}

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
  private readonly shared = new Map<string, SharedEntry>();
  private readonly warnedKinds = new Set<string>();
  /** Переиспользуемая запись прокси обхода (REND-15): валидна внутри визита. */
  private readonly proxy: PickProxy = createPickProxy();

  constructor(manifest: VisualManifest, options: ModelsOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.warn = options.warn ?? ((message) => { console.warn(message); });
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемой террейна источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
  }

  // ------------------------------------------------------------- syncTick

  syncTick(view: TickView): void {
    const ctx = this.requireCtx();
    this.syncPool(ctx, this.instances, view.entities, false);

    // События тика → one-shot клипы (REND-4); дедуп на потребителе (OBS-5):
    // при rewind/replay и на замороженных тиках события не переигрываются.
    if (view.freshEvents) {
      const fallEvent = this.options.fallEvent ?? DEFAULT_FALL_EVENT;
      for (const event of view.events) {
        const caster = event.data.entity ?? event.data.source;
        if (caster === undefined) continue;
        const record = this.instances.get(caster);
        if (record === undefined) continue;
        // Провал (ARENA-5) включает снижение и состояние `fall` (REND-12);
        // убьёт ли сущность геймплейная система или вернёт на арену —
        // рендеру неизвестно, и предвосхищать её решение он не пытается.
        if (event.type === fallEvent) {
          record.falling = true;
          record.controller?.setState(STATE_FALL);
        }
        record.controller?.handleEvent(event.type);
      }
    }
  }

  /**
   * Полный набор decoration-инстансов (REND-18). Сведение — то же самое, что у
   * presentation-состояния: тот же `syncPool`, то же правило жизненного цикла
   * (REND-3). Событий здесь не разбирается вовсе — их у decoration нет, а не
   * «пока никто не прислал».
   */
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    this.syncPool(this.requireCtx(), this.decorations, entities, true);
  }

  /**
   * Сведение пула с поданным набором сущностей (REND-3): появившиеся создают
   * инстанс, исчезнувшие убирают, сохранившиеся обновляются. Одна реализация на
   * оба пула — второй разошёлся бы с первым, а REND-18 требует ровно того же
   * пути отрисовки, что REND-11.
   */
  private syncPool(
    ctx: RenderContext,
    pool: Map<EntityId, InstanceRecord>,
    entities: ReadonlyMap<EntityId, EntityView>,
    decoration: boolean,
  ): void {
    for (const entityView of entities.values()) {
      let record = pool.get(entityView.id);
      if (record === undefined) {
        record = this.create(ctx, entityView, decoration);
        pool.set(entityView.id, record);
      }
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
      if (entityView.scale !== record.viewScale) {
        record.viewScale = entityView.scale;
        record.holder.scale.setScalar(entityView.scale ?? 1);
      }
      this.applyAnimation(record);
      // Правка walkable-записи (позиция, курс, масштаб, сам флаг) доводит
      // walkable-вклад поля до нового размещения (REND-9, REND-18); правка
      // не-walkable полей (скин) реестр не трогает — вклад тот же.
      if (decoration) this.syncWalkable(record);
    }

    // Исчезнувшие: инстанс убирается, разделяемый ассет остаётся в кэше (REND-3).
    for (const [entity, record] of pool) {
      if (!entities.has(entity)) {
        this.remove(ctx, record);
        pool.delete(entity);
      }
    }
  }

  // ---------------------------------------------------------- updateFrame

  updateFrame(dt: number, alpha: number): void {
    const heightStep = this.requireCtx().config.heightStep;
    const turnRate = this.options.turnRate ?? DEFAULT_TURN_RATE;
    const tiltRate = this.options.tiltRate ?? DEFAULT_TILT_RATE;
    const surface = this.options.surface?.current ?? null;

    // Оба пула одним проходом и одними правилами: декорация в кадре автора и
    // декорация в кадре игрока обязаны быть одним изображением (REND-18).
    this.poseAll(this.instances, dt, alpha, heightStep, turnRate, tiltRate, surface);
    this.poseAll(this.decorations, dt, alpha, heightStep, turnRate, tiltRate, surface);
  }

  private poseAll(
    pool: ReadonlyMap<EntityId, InstanceRecord>,
    dt: number,
    alpha: number,
    heightStep: number,
    turnRate: number,
    tiltRate: number,
    surface: VisualSurface | null,
  ): void {
    for (const record of pool.values()) {
      const view = record.view;
      // Интерполяция между двумя последними тиками; snap-тик рисуется без неё (REND-2).
      const t = view.snap ? 1 : alpha;
      const x = view.prevX + (view.currX - view.prevX) * t;
      const y = view.prevY + (view.currY - view.prevY) * t;
      // Walkable-инстанс сажается и наклоняется по террейн-форме — без
      // walkable-вкладов, в том числе чужих: иначе два моста сажались бы друг
      // на друга по кругу (REND-9). Все прочие читают поле целиком — юнит на
      // настиле стоит на настиле (REND-10).
      const walkableSeat = record.decoration && view.walkable === true;
      // Сущность на поверхности стоит на визуальной поверхности (рампы и
      // кривизна, REND-9); с override уровня (TERR-4) — на высоте уровня.
      // Летящая — на переходе между высотами отрыва и приземления (REND-12):
      // дискретный уровень под ней в высоте прыжка не участвует, иначе
      // пересечение границы обрыва сдвигало бы инстанс на ступень.
      let base: number;
      if (surface !== null && isAirborne(view)) {
        // Фаза манёвра до первого его тика — ноль: на том тике манёвра ещё не
        // было, и `prevMotionPhase` пришла как NaN.
        const phasePrev = Number.isFinite(view.prevMotionPhase) ? view.prevMotionPhase : 0;
        const phase = phasePrev + (view.currMotionPhase - phasePrev) * t;
        maneuverEnds(
          x,
          y,
          view.currX - view.prevX,
          view.currY - view.prevY,
          phase,
          view.currMotionPhase - phasePrev,
          SCRATCH_ENDS,
        );
        base = jumpBase(
          surface.heightAt(SCRATCH_ENDS.takeoffX, SCRATCH_ENDS.takeoffY),
          surface.heightAt(SCRATCH_ENDS.landingX, SCRATCH_ENDS.landingY),
          phase,
        );
      } else if (surface !== null && !view.levelOverride) {
        base = walkableSeat ? surface.terrainFormHeightAt(x, y) : surface.heightAt(x, y);
      } else {
        base = (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
      }
      // Вертикальное смещение — чистое представление (REND-12): дуга прыжка
      // смешивается по тем же двум тикам, что позиция, снижение идёт по кадрам.
      const arcPrev = jumpArc(view.prevMotionPhase, record.jumpArcHeight);
      const arcCurr = jumpArc(view.currMotionPhase, record.jumpArcHeight);
      if (record.falling) {
        record.fallOffset = advanceFall(record.fallOffset, record.fallSpeed, record.fallDepth, dt);
      }
      record.holder.position.set(x, y, base + arcPrev + (arcCurr - arcPrev) * t + record.fallOffset);

      // Курс: цель из данных тика, доворот сглажен по кадрам; при snap —
      // мгновенно. Поправка на перёд модели — своя у каждой записи (REND-13).
      const targetYaw = view.facingYaw + record.facingOffset;
      record.yaw = record.snapPending ? targetYaw : smoothYaw(record.yaw, targetYaw, turnRate, dt);

      // Наклон по нормали поверхности (REND-10): только для сущностей на
      // поверхности; сглажен по кадрам, при snap — мгновенно (REND-2).
      if (surface !== null && record.tiltFactor > 0 && !view.levelOverride) {
        if (walkableSeat) surface.terrainFormNormalAt(x, y, SCRATCH_NORMAL);
        else surface.normalAt(x, y, SCRATCH_NORMAL);
        tiltTarget(SCRATCH_NORMAL, record.tiltFactor, record.tiltMaxRad, SCRATCH_TILT);
        if (record.snapPending) {
          record.tilt.x = SCRATCH_TILT.x;
          record.tilt.y = SCRATCH_TILT.y;
        } else {
          smoothTilt(record.tilt, SCRATCH_TILT, tiltRate, dt);
        }
      } else {
        record.tilt.x = 0;
        record.tilt.y = 0;
      }
      record.snapPending = false;
      record.posed = true;
      this.applyOrientation(record);

      record.controller?.update(dt);
      // Bone-контроль строго после mixer.update и до отрисовки (REND-5).
      if (record.model !== null && record.boneControl !== null) {
        record.boneControl.apply(
          record.model,
          view.aimYaw,
          record.yaw - record.facingOffset,
          dt,
          this.warn,
        );
      }
    }
  }

  /**
   * Ориентация holder'а: сперва курс вокруг вертикали, поверх — наклон в
   * мировых осях. Композиция общая с walkable-реестром поля (REND-9): трансформ
   * walkable-поверхности — тот же, каким инстанс нарисован, а не второй расчёт.
   */
  private applyOrientation(record: InstanceRecord): void {
    orientFromTiltYaw(record.tilt, record.yaw, record.holder.quaternion);
  }

  // ------------------------------------------------------------ публичное

  /**
   * Смена скина инстанса без перезагрузки модели (REND-6): подменяются только
   * текстуры материалов этого инстанса. Возвращает false, если сущности нет.
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
   * Правленый манифест визуалов целиком (ED-14, ED-15, REND-17). Подсистема
   * сводит поданное с живыми инстансами сама: пере-инициализировать её или
   * пересобирать сцену ради правки записи не нужно.
   *
   * Пересобирается инстанс ровно тогда, когда изменилось то, что строится из
   * разделяемых данных ассета (REND-3), — модель и набор её рисуемых частей;
   * остальное записи применяется на месте, потому что пересоздание потеряло бы
   * материалы скина (REND-6), фазу анимации и сглаженный наклон (REND-10) —
   * ровно то, что перечисляет REND-11, запрещая пересоздание.
   *
   * Записи, не изменившиеся в поданном документе, наблюдаемых последствий не
   * получают: сравниваются ЗНАЧЕНИЯ, а не ссылки, — редактор отдаёт разобранный
   * документ, и после любой правки все объекты в нём новые.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    const ctx = this.requireCtx();
    // Переподача действует на оба пула: раздел decoration-видов — такая же
    // часть манифеста (ASSET-9), и правка записи камня обязана доехать и до
    // размещённой декорации (REND-17, ED-15).
    this.resupply(ctx, this.instances);
    this.resupply(ctx, this.decorations);
  }

  private resupply(ctx: RenderContext, pool: ReadonlyMap<EntityId, InstanceRecord>): void {
    for (const record of pool.values()) {
      // Невизуальная сущность (резолвер отнёс её к нерисуемым) записи не имеет.
      if (record.kind === null) continue;
      const before = record.visual;
      record.visual = resolveVisual(this.manifest, record.kind);
      if (rebuildsInstance(before, record.visual)) {
        this.rebuild(ctx, record);
        continue;
      }
      this.applyEntryParams(record);
      // Масштаб записи — нормализующая обёртка: переставляется на живом инстансе.
      record.model?.setScale(record.visual?.scale ?? 1);
      record.controller?.setMapping(record.visual?.animations ?? {});
      this.syncBoneControls(record);
      this.syncSkin(record, before);
      // Правка записи (масштаб, наклон, перёд) двигает и walkable-поверхность
      // вместе с картинкой (REND-17 → REND-9).
      if (record.decoration) this.syncWalkable(record);
    }
  }

  /**
   * Объёмы-прокси нарисованных инстансов — вход picking'а вьюпорта (REND-15) и
   * подсветки выделения (REND-16). Подсистема отдаёт УЗЕЛ, а не позу: то самое
   * преобразование, которым инстанс нарисован в этом кадре, — посадка на
   * визуальную поверхность (REND-9), вертикальное смещение (REND-12), наклон
   * (REND-10), курс с поправкой переда (REND-13) и масштаб (REND-11) уже в нём.
   * Пересчитывать их второй раз было бы вторым ответом на один вопрос.
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
   * Попадание только в нарисованное (REND-15): у сущности, отнесённой резолвером
   * к невизуальным, нет ни модели, ни заглушки — и прокси у неё нет. Инстанс,
   * чья модель ещё грузится, участвует объёмом заглушки (ASSET-4): автор видит
   * её и вправе её двигать. Инстанс, созданный `syncTick` и ещё не получивший
   * позы кадра, не участвует: в кадре его нет.
   */
  private fillProxy(record: InstanceRecord, out: PickProxy): boolean {
    if (!record.posed) return false;
    const bounds = record.model?.bounds ?? (record.placeholder === null ? null : PLACEHOLDER_BOUNDS);
    if (bounds === null) return false;
    out.entity = record.entity;
    out.decoration = record.decoration;
    out.handle = null;
    out.node = record.holder;
    out.minX = bounds.minX;
    out.minY = bounds.minY;
    out.minZ = bounds.minZ;
    out.maxX = bounds.maxX;
    out.maxY = bounds.maxY;
    out.maxZ = bounds.maxZ;
    return true;
  }

  /** Инстанс сущности — для тестов и отладки. */
  instanceFor(
    entity: EntityId,
    decoration = false,
  ): {
    readonly holder: THREE.Group;
    readonly model: ModelInstance | null;
    readonly controller: AnimationController | null;
  } | null {
    const record = (decoration ? this.decorations : this.instances).get(entity);
    if (record === undefined) return null;
    return { holder: record.holder, model: record.model, controller: record.controller };
  }

  // ------------------------------------------------------------ внутреннее

  private requireCtx(): RenderContext {
    if (this.ctx === null) throw new Error('ModelsSubsystem: init() не вызван (REND-8)');
    return this.ctx;
  }

  /** Скин инстанса: подменяются только текстуры его материалов (REND-6). */
  private assignSkin(record: InstanceRecord, skin: string | undefined): void {
    record.skin = skin;
    if (record.model !== null) this.applyInstanceSkin(record, record.model);
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
    record.fallSpeed = offset?.fallSpeed ?? 0;
    record.fallDepth = offset?.fallDepth ?? 0;
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
      this.applyInstanceSkin(record, record.model);
    }
  }

  /**
   * Инстанс строится заново под новую запись (REND-3, REND-17). Holder, его поза
   * и место в сцене остаются те же: пересобирается то, что построено из
   * разделяемых данных ассета, а не размещённый объект — его идентичность в
   * документе (REND-11) и попадание picking'а (REND-15) переподачу переживают.
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

  private create(ctx: RenderContext, view: EntityView, decoration: boolean): InstanceRecord {
    const holder = new THREE.Group();
    holder.name = `${decoration ? 'decoration' : 'entity'}:${view.id}`;
    // Масштаб набора — множитель поверх масштаба записи манифеста (REND-11):
    // запись масштабирует модель, набор — конкретное размещение.
    if (view.scale !== undefined) holder.scale.setScalar(view.scale);
    ctx.scene.add(holder);

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
      holder,
      placeholder: null,
      model: null,
      controller: null,
      boneControl: null,
      skinApp: null,
      skin: view.skin ?? visual?.defaultSkin,
      skinChosen: view.skin !== undefined,
      viewSkin: view.skin,
      viewScale: view.scale,
      facingOffset: DEFAULT_FACING_RAD,
      yaw: 0,
      snapPending: true,
      tiltFactor: 0,
      tiltMaxRad: null,
      tilt: { x: 0, y: 0 },
      jumpArcHeight: 0,
      fallSpeed: 0,
      fallDepth: 0,
      falling: false,
      fallOffset: 0,
      posed: false,
    };
    this.applyEntryParams(record);
    record.yaw = view.facingYaw + record.facingOffset;

    this.attachVisual(ctx, record);
    return record;
  }

  /**
   * Заглушка и модель записи для инстанса, у которого их ещё (или уже) нет:
   * общая часть создания инстанса и его пересборки под новой записью (REND-17).
   */
  private attachVisual(ctx: RenderContext, record: InstanceRecord): void {
    const kind = record.kind;
    // Резолвер явно отнёс сущность к невизуальным — не рисуем и не шумим.
    if (kind === null) return;

    const visual = record.visual;
    if (visual === undefined) {
      // Сущность без записи в манифесте: заглушка и предупреждение один раз (ASSET-6).
      if (!this.warnedKinds.has(kind)) {
        this.warnedKinds.add(kind);
        this.warn(`render: для типа "${kind}" нет записи в манифесте визуалов — заглушка (ASSET-6)`);
      }
      record.placeholder = this.makePlaceholder(record.holder);
      return;
    }

    // Модель грузится асинхронно; до готовности — заглушка (ASSET-4).
    record.placeholder = this.makePlaceholder(record.holder);
    const entry = this.ensureShared(ctx, visual.model);
    if (entry.data !== null) {
      this.attachModel(record, entry.data);
    } else if (entry.failed === null) {
      entry.waiting.add(record);
    }
  }

  private makePlaceholder(holder: THREE.Group): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(PLACEHOLDER_WIDTH, PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT);
    geometry.translate(0, 0, PLACEHOLDER_HEIGHT / 2); // стоит на земле, а не тонет в ней
    const material = new THREE.MeshStandardMaterial({ color: PLACEHOLDER_COLOR });
    const mesh = new THREE.Mesh(geometry, material);
    holder.add(mesh);
    return mesh;
  }

  private ensureShared(ctx: RenderContext, modelId: string): SharedEntry {
    const existing = this.shared.get(modelId);
    if (existing !== undefined) return existing;
    const entry: SharedEntry = { data: null, failed: null, waiting: new Set() };
    this.shared.set(modelId, entry);

    const handle = ctx.assets.request<NormalizedModel>('model', modelId);
    const onState = (state: AssetState<NormalizedModel>): void => {
      if (entry.data !== null) return;
      if (state.status === 'ready') {
        // Разделяемая часть строится один раз на ассет (REND-3).
        const data = buildSharedModel(state.data);
        entry.data = data;
        entry.failed = null;
        for (const record of entry.waiting) this.attachModel(record, data);
        entry.waiting.clear();
      } else if (state.status === 'failed' && entry.failed !== state.reason) {
        entry.failed = state.reason;
        this.warn(`render: модель "${modelId}" не загрузилась: ${state.reason} — остаётся заглушка (ASSET-4)`);
      }
    };
    onState(ctx.assets.state(handle));
    ctx.assets.subscribe(handle, onState);
    return entry;
  }

  private attachModel(record: InstanceRecord, shared: SharedModelData): void {
    if (record.model !== null) return;
    const instanceOptions: { scale?: number; hiddenParts?: readonly number[] } = {};
    if (record.visual?.scale !== undefined) instanceOptions.scale = record.visual.scale;
    if (record.visual?.hiddenParts !== undefined) {
      instanceOptions.hiddenParts = record.visual.hiddenParts;
    }
    const model = createModelInstance(shared, instanceOptions);
    record.holder.add(model.root);
    this.disposePlaceholder(record);
    record.model = model;

    // Неразрешённая запись анимации диагностируется в тот же сток, что и
    // отсутствующая кость (REND-4, REND-5): у подсистемы один адресат жалоб.
    const controllerOptions: {
      crossfade?: number;
      deathEvent?: string;
      warn: (message: string) => void;
    } = { warn: this.warn };
    if (this.options.crossfade !== undefined) controllerOptions.crossfade = this.options.crossfade;
    if (this.options.deathEvent !== undefined) controllerOptions.deathEvent = this.options.deathEvent;
    record.controller = new AnimationController(
      model.mixer,
      shared.clips,
      record.visual?.animations ?? {},
      controllerOptions,
    );
    this.applyAnimation(record);

    // Контроля костей у decoration нет (REND-5, REND-18): доворачивать нечего.
    const controls = record.decoration ? undefined : record.visual?.boneControls;
    record.boneControl = controls === undefined ? null : new BoneControlState(controls);

    this.applyInstanceSkin(record, model);

    // Модель готова — walkable-вклад появляется в поле, и подписчики поверхности
    // узнают о клетках под bbox не позже следующего кадра (ASSET-4 → REND-9).
    if (record.decoration) this.syncWalkable(record);
  }

  private applyInstanceSkin(record: InstanceRecord, model: ModelInstance): void {
    const entry = record.visual === undefined ? undefined : this.shared.get(record.visual.model);
    if (entry?.data === undefined || entry.data === null) return;
    record.skinApp?.dispose();
    record.skinApp = applySkin(
      model.textureTargets,
      skinTextureSources(entry.data.model, record.visual, record.skin),
      this.requireCtx().assets,
    );
  }

  private remove(ctx: RenderContext, record: InstanceRecord): void {
    // Исчезнувшая walkable-декорация забирает свой вклад из поля; подписчики
    // получают клетки под прежним bbox (REND-9, REND-18).
    if (record.decoration) this.options.surface?.setWalkable(record.entity, null);
    ctx.scene.remove(record.holder);
    this.detachModel(record);
  }

  /**
   * Сведение walkable-вклада инстанса с реестром поля (REND-9): вклад есть
   * ровно тогда, когда декорация несёт флаг записи (PRES-2 → REND-18) и её
   * модель готова (ASSET-4). Размещение — те же величины, которыми `poseAll`
   * ставит узел в кадре: позиция набора, курс с поправкой переда (REND-13),
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
      scale: (view.scale ?? 1) * ((visual.scale ?? 1) / Math.max(model.height, MIN_MODEL_HEIGHT)),
      model,
    });
  }

  /**
   * Снимает с инстанса всё построенное из данных ассета — заглушку, модель,
   * анимационный контроллер, контроль костей и текстуры скина, — оставляя сам
   * holder. Общая часть удаления инстанса и его пересборки под новой записью
   * (REND-17); разделяемые данные ассета остаются в кэше (REND-3).
   */
  private detachModel(record: InstanceRecord): void {
    for (const entry of this.shared.values()) entry.waiting.delete(record);
    this.disposePlaceholder(record);
    record.skinApp?.dispose();
    record.skinApp = null;
    record.controller = null;
    record.boneControl = null;
    if (record.model !== null) {
      record.model.root.removeFromParent();
      record.model.dispose();
      record.model = null;
    }
  }

  private disposePlaceholder(record: InstanceRecord): void {
    if (record.placeholder === null) return;
    record.placeholder.removeFromParent();
    record.placeholder.geometry.dispose();
    (record.placeholder.material as THREE.Material).dispose();
    record.placeholder = null;
  }
}

/**
 * Пересобирать ли инстанс под переподанной записью (REND-17). Граница проходит
 * по тому, что построено из разделяемых данных ассета (REND-3): другую модель и
 * другой набор её рисуемых частей правкой построенного не получить, а всё
 * прочее записи применяется на живом инстансе.
 */
function rebuildsInstance(
  before: EntityVisual | undefined,
  after: EntityVisual | undefined,
): boolean {
  if (before === after) return false;
  if (before?.model !== after?.model) return true;
  return !samePartSets(before?.hiddenParts, after?.hiddenParts);
}

/** Один и тот же набор скрытых частей (ASSET-6); порядок и отсутствие — не различия. */
function samePartSets(before?: readonly number[], after?: readonly number[]): boolean {
  if (before === after) return true;
  const a = before ?? [];
  const b = after ?? [];
  return a.length === b.length && a.every((part) => b.includes(part));
}

/**
 * Совпадают ли подмены выбранного скина в двух записях (REND-6). Сравнивается
 * ровно выбранный скин: правка соседнего скина той же записи текстур этого
 * инстанса не меняет и переставлять их не повод (REND-17).
 */
function sameSkinSlots(
  before: EntityVisual | undefined,
  after: EntityVisual | undefined,
  skin: string | undefined,
): boolean {
  // Скина нет — подмен нет ни до, ни после: слоты модели идут как есть.
  if (skin === undefined) return true;
  const a = before?.skins?.[skin];
  const b = after?.skins?.[skin];
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const slots = Object.keys(a);
  return slots.length === Object.keys(b).length && slots.every((slot) => a[slot] === b[slot]);
}
