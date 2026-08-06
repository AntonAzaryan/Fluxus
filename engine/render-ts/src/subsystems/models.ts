/**
 * Подсистема моделей (REND-3..6): пул инстансов по сущностям снапшота.
 *
 * Появление сущности в presentation-состоянии создаёт инстанс, исчезновение —
 * убирает. Разделяемая часть ассета (геометрия, клипы) строится один раз и
 * кэшируется здесь; скелет, материалы и анимационное состояние — свои на
 * инстанс. Всё поведение — из манифеста визуалов (ASSET-6): модель, скины,
 * маппинг анимаций, параметры bone-контроля.
 */
import * as THREE from 'three';
import type { EntityId } from '@game-mvp/core';
import {
  resolveSurfaceAlign,
  type AssetState,
  type EntityVisual,
  type NormalizedModel,
  type VisualManifest,
} from '@game-mvp/assets';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from '../types.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { SurfaceNormal } from '../visualSurface.js';
import { smoothTilt, tiltTarget, type TiltVector } from '../model/surfaceAlign.js';
import {
  buildSharedModel,
  createModelInstance,
  type ModelInstance,
  type SharedModelData,
} from '../model/build.js';
import { AnimationController } from '../model/animation.js';
import { BoneControlState } from '../model/boneControl.js';
import { smoothYaw } from '../model/boneControl.js';
import { applySkin, skinTexturePaths, type SkinApplication } from '../model/skins.js';

export interface ModelsOptions {
  /** Тип события смерти — конвенция ядра. */
  readonly deathEvent?: string;
  /** Длительность кроссфейда клипов, секунды (REND-4). */
  readonly crossfade?: number;
  /** Скорость доворота корпуса инстанса к курсу движения, 1/с. */
  readonly turnRate?: number;
  /** Поворот модели относительно atan2-курса; у MDX «перёд» вдоль +X → 0. */
  readonly facingOffset?: number;
  /** Источник визуальной поверхности — высота и наклон по рельефу (REND-9, REND-10). */
  readonly surface?: VisualSurfaceSource;
  /** Скорость сглаживания наклона по поверхности, 1/с (REND-10). */
  readonly tiltRate?: number;
  /** Визуальная глубина полного падения, мировые единицы (REND-12). */
  readonly fallDepth?: number;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

const DEFAULT_TURN_RATE = 12;
const DEFAULT_TILT_RATE = 10;
const DEFAULT_FALL_DEPTH = 4;
const PLACEHOLDER_COLOR = 0xd040d0;

// Переиспользуемые между кадрами объекты — аллокаций на инстанс на кадр нет.
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const SCRATCH_NORMAL: SurfaceNormal = { x: 0, y: 0, z: 1 };
const SCRATCH_TILT: TiltVector = { x: 0, y: 0 };
const SCRATCH_AXIS = new THREE.Vector3();
const SCRATCH_Q_TILT = new THREE.Quaternion();
const SCRATCH_Q_YAW = new THREE.Quaternion();

/** Состояния локомоции MVP — производные от компонент движения (REND-4). */
const STATE_IDLE = 'idle';
const STATE_MOVE = 'move';

interface SharedEntry {
  data: SharedModelData | null;
  failed: string | null;
  /** Инстансы, ждущие готовности ассета. */
  readonly waiting: Set<InstanceRecord>;
}

interface InstanceRecord {
  readonly entity: EntityId;
  readonly kind: string | null;
  readonly visual: EntityVisual | undefined;
  view: EntityView;
  /** Узел позиции/курса; под ним либо заглушка, либо модель. */
  readonly holder: THREE.Group;
  placeholder: THREE.Mesh | null;
  model: ModelInstance | null;
  controller: AnimationController | null;
  boneControl: BoneControlState | null;
  skinApp: SkinApplication | null;
  skin: string | undefined;
  yaw: number;
  snapPending: boolean;
  /** Параметры наклона записи (ASSET-6): factor 0 выключает наклон. */
  readonly tiltFactor: number;
  readonly tiltMaxRad: number | null;
  /** Сглаженный наклон «ось × угол» (REND-10). */
  readonly tilt: TiltVector;
}

export class ModelsSubsystem implements RenderSubsystem {
  readonly name = 'models';

  private readonly manifest: VisualManifest;
  private readonly options: ModelsOptions;
  private readonly warn: (message: string) => void;
  private ctx: RenderContext | null = null;
  private readonly instances = new Map<EntityId, InstanceRecord>();
  private readonly shared = new Map<string, SharedEntry>();
  private readonly warnedKinds = new Set<string>();

  constructor(manifest: VisualManifest, options: ModelsOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемой террейна источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
  }

  // ------------------------------------------------------------- syncTick

  syncTick(view: TickView): void {
    const ctx = this.requireCtx();

    // Появившиеся и живые сущности (REND-3).
    for (const entityView of view.entities.values()) {
      let record = this.instances.get(entityView.id);
      if (record === undefined) {
        record = this.create(ctx, entityView);
        this.instances.set(entityView.id, record);
      }
      record.view = entityView;
      record.snapPending ||= entityView.snap;
      record.controller?.setState(entityView.moving ? STATE_MOVE : STATE_IDLE);
    }

    // Исчезнувшие: инстанс убирается, разделяемый ассет остаётся в кэше (REND-3).
    for (const [entity, record] of this.instances) {
      if (!view.entities.has(entity)) {
        this.remove(ctx, record);
        this.instances.delete(entity);
      }
    }

    // События тика → one-shot клипы (REND-4); дедуп на потребителе (OBS-5):
    // при rewind/replay и на замороженных тиках события не переигрываются.
    if (view.freshEvents) {
      for (const event of view.events) {
        const caster = event.data['entity'] ?? event.data['source'];
        if (caster === undefined) continue;
        this.instances.get(caster)?.controller?.handleEvent(event.type);
      }
    }
  }

  // ---------------------------------------------------------- updateFrame

  updateFrame(dt: number, alpha: number): void {
    const heightStep = this.requireCtx().config.heightStep;
    const turnRate = this.options.turnRate ?? DEFAULT_TURN_RATE;
    const tiltRate = this.options.tiltRate ?? DEFAULT_TILT_RATE;
    const fallDepth = this.options.fallDepth ?? DEFAULT_FALL_DEPTH;
    const facingOffset = this.options.facingOffset ?? 0;
    const surface = this.options.surface?.current ?? null;

    for (const record of this.instances.values()) {
      const view = record.view;
      // Интерполяция между двумя последними тиками; snap-тик рисуется без неё (REND-2).
      const t = view.snap ? 1 : alpha;
      const x = view.prevX + (view.currX - view.prevX) * t;
      const y = view.prevY + (view.currY - view.prevY) * t;
      // Сущность на поверхности стоит на визуальной поверхности (рампы и
      // кривизна, REND-9); с override уровня (TERR-4) — на высоте уровня.
      let z =
        surface !== null && !view.levelOverride
          ? surface.heightAt(x, y)
          : (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
      // Снижение падающей сущности (REND-12): прогресс интерполируется, как
      // позиция; квадрат прогресса — визуальное ускорение «гравитации», сама
      // кривая и глубина в симуляцию не попадают.
      const fallT = view.falling ? view.prevFall + (view.currFall - view.prevFall) * t : 0;
      if (fallT > 0) z -= fallDepth * fallT * fallT;
      record.holder.position.set(x, y, z);

      // Курс: цель из данных тика, доворот сглажен по кадрам; при snap — мгновенно.
      const targetYaw = view.facingYaw + facingOffset;
      record.yaw = record.snapPending ? targetYaw : smoothYaw(record.yaw, targetYaw, turnRate, dt);

      // Наклон по нормали поверхности (REND-10): только для сущностей на
      // поверхности; сглажен по кадрам, при snap — мгновенно (REND-2).
      // Падающая сущность на поверхности не стоит — наклона нет (REND-12).
      if (surface !== null && record.tiltFactor > 0 && !view.levelOverride && !view.falling) {
        surface.normalAt(x, y, SCRATCH_NORMAL);
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
      this.applyOrientation(record);

      record.controller?.update(dt);
      // Bone-контроль строго после mixer.update и до отрисовки (REND-5).
      if (record.model !== null && record.boneControl !== null) {
        record.boneControl.apply(
          record.model,
          view.aimYaw,
          record.yaw - facingOffset,
          dt,
          this.warn,
        );
      }
    }
  }

  /** Ориентация holder'а: сперва курс вокруг вертикали, поверх — наклон в мировых осях. */
  private applyOrientation(record: InstanceRecord): void {
    const angle = Math.hypot(record.tilt.x, record.tilt.y);
    if (angle < 1e-6) {
      record.holder.rotation.set(0, 0, record.yaw);
      return;
    }
    SCRATCH_AXIS.set(record.tilt.x / angle, record.tilt.y / angle, 0);
    SCRATCH_Q_TILT.setFromAxisAngle(SCRATCH_AXIS, angle);
    SCRATCH_Q_YAW.setFromAxisAngle(WORLD_UP, record.yaw);
    record.holder.quaternion.multiplyQuaternions(SCRATCH_Q_TILT, SCRATCH_Q_YAW);
  }

  // ------------------------------------------------------------ публичное

  /**
   * Смена скина инстанса без перезагрузки модели (REND-6): подменяются только
   * текстуры материалов этого инстанса. Возвращает false, если сущности нет.
   */
  setSkin(entity: EntityId, skin: string | undefined): boolean {
    const record = this.instances.get(entity);
    if (record === undefined) return false;
    record.skin = skin;
    if (record.model !== null) this.applyInstanceSkin(record, record.model);
    return true;
  }

  /** Инстанс сущности — для тестов и отладки. */
  instanceFor(entity: EntityId): {
    readonly holder: THREE.Group;
    readonly model: ModelInstance | null;
    readonly controller: AnimationController | null;
  } | null {
    const record = this.instances.get(entity);
    if (record === undefined) return null;
    return { holder: record.holder, model: record.model, controller: record.controller };
  }

  // ------------------------------------------------------------ внутреннее

  private requireCtx(): RenderContext {
    if (this.ctx === null) throw new Error('ModelsSubsystem: init() не вызван (REND-8)');
    return this.ctx;
  }

  private create(ctx: RenderContext, view: EntityView): InstanceRecord {
    const holder = new THREE.Group();
    holder.name = `entity:${view.id}`;
    ctx.scene.add(holder);

    const visual = view.kind === null ? undefined : this.manifest.entities[view.kind];
    const align = resolveSurfaceAlign(this.manifest, visual);
    const record: InstanceRecord = {
      entity: view.id,
      kind: view.kind,
      visual,
      view,
      holder,
      placeholder: null,
      model: null,
      controller: null,
      boneControl: null,
      skinApp: null,
      skin: visual?.defaultSkin,
      yaw: view.facingYaw,
      snapPending: true,
      tiltFactor: align.factor,
      tiltMaxRad: align.maxAngleDeg === undefined ? null : (align.maxAngleDeg * Math.PI) / 180,
      tilt: { x: 0, y: 0 },
    };

    if (view.kind === null) {
      // Резолвер явно отнёс сущность к невизуальным — не рисуем и не шумим.
      return record;
    }
    if (visual === undefined) {
      // Сущность без записи в манифесте: заглушка и предупреждение один раз (ASSET-6).
      if (!this.warnedKinds.has(view.kind)) {
        this.warnedKinds.add(view.kind);
        this.warn(`render: для типа "${view.kind}" нет записи в манифесте визуалов — заглушка (ASSET-6)`);
      }
      record.placeholder = this.makePlaceholder(holder);
      return record;
    }

    // Модель грузится асинхронно; до готовности — заглушка (ASSET-4).
    record.placeholder = this.makePlaceholder(holder);
    const entry = this.ensureShared(ctx, visual.model);
    if (entry.data !== null) {
      this.attachModel(record, entry.data);
    } else if (entry.failed === null) {
      entry.waiting.add(record);
    }
    return record;
  }

  private makePlaceholder(holder: THREE.Group): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(0.4, 0.4, 0.9);
    geometry.translate(0, 0, 0.45); // стоит на земле, а не тонет в ней
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

    const controllerOptions: { crossfade?: number; deathEvent?: string } = {};
    if (this.options.crossfade !== undefined) controllerOptions.crossfade = this.options.crossfade;
    if (this.options.deathEvent !== undefined) controllerOptions.deathEvent = this.options.deathEvent;
    record.controller = new AnimationController(
      model.mixer,
      shared.clips,
      record.visual?.animations ?? {},
      controllerOptions,
    );
    record.controller.setState(record.view.moving ? STATE_MOVE : STATE_IDLE);

    record.boneControl =
      record.visual?.boneControls === undefined
        ? null
        : new BoneControlState(record.visual.boneControls);

    this.applyInstanceSkin(record, model);
  }

  private applyInstanceSkin(record: InstanceRecord, model: ModelInstance): void {
    const entry = record.visual === undefined ? undefined : this.shared.get(record.visual.model);
    if (entry?.data === undefined || entry.data === null) return;
    record.skinApp?.dispose();
    record.skinApp = applySkin(
      model.textureTargets,
      skinTexturePaths(entry.data.model, record.visual, record.skin),
      this.requireCtx().assets,
    );
  }

  private remove(ctx: RenderContext, record: InstanceRecord): void {
    ctx.scene.remove(record.holder);
    this.disposePlaceholder(record);
    record.skinApp?.dispose();
    record.model?.dispose();
    for (const entry of this.shared.values()) entry.waiting.delete(record);
  }

  private disposePlaceholder(record: InstanceRecord): void {
    if (record.placeholder === null) return;
    record.placeholder.removeFromParent();
    record.placeholder.geometry.dispose();
    (record.placeholder.material as THREE.Material).dispose();
    record.placeholder = null;
  }
}
