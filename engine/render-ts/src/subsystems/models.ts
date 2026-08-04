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
import type {
  AssetState,
  EntityVisual,
  NormalizedModel,
  VisualManifest,
} from '@game-mvp/assets';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from '../types.js';
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
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

const DEFAULT_TURN_RATE = 12;
const PLACEHOLDER_COLOR = 0xd040d0;

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
    const facingOffset = this.options.facingOffset ?? 0;

    for (const record of this.instances.values()) {
      const view = record.view;
      // Интерполяция между двумя последними тиками; snap-тик рисуется без неё (REND-2).
      const t = view.snap ? 1 : alpha;
      const x = view.prevX + (view.currX - view.prevX) * t;
      const y = view.prevY + (view.currY - view.prevY) * t;
      const z = (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
      record.holder.position.set(x, y, z);

      // Курс: цель из данных тика, доворот сглажен по кадрам; при snap — мгновенно.
      const targetYaw = view.facingYaw + facingOffset;
      record.yaw = record.snapPending ? targetYaw : smoothYaw(record.yaw, targetYaw, turnRate, dt);
      record.snapPending = false;
      record.holder.rotation.z = record.yaw;

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
      model.materialsBySlot,
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
