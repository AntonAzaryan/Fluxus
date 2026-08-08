/**
 * Набор decoration-инстансов (REND-18): декларативное сведение по ключам,
 * сосуществование с любым продюсером presentation-состояния, отсутствие всего
 * производного от `TickResult`, участие в picking'е (REND-15) и в подсветке
 * выделения (REND-16).
 *
 * Подсистема здесь настоящая, как и в тесте документного источника: проверяется
 * связка «набор → подсистема → кадр», а не внутренности набора. Второго пути
 * отрисовки не должно быть, и способ это увидеть — общий с REND-11 путь.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FIXED_ONE,
  createTerrainGrid,
  dispatch,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type Scene,
  type Simulation,
  type System,
  type TerrainGrid,
} from '@game-mvp/core';
import type { VisualManifest } from '@game-mvp/assets';
import {
  DecorationSet,
  DocumentSource,
  ModelsSubsystem,
  OverlaySubsystem,
  PresentationStage,
  RenderHost,
  ViewportPicking,
  VisualSurfaceSource,
  kindByTags,
  type CameraPose,
  type DecorationInstance,
  type RenderContext,
  type ViewportPoint,
} from '../src/index.js';
import { makeAssets, makeModel, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/rock.mdx';
const GRASS_ID = 'models/grass.mdx';

function makeManifest(): VisualManifest {
  return {
    entities: {
      // Один и тот же камень — и prop, и декорация: запись одна (ASSET-9).
      Rock: {
        model: MODEL_ID,
        scale: 1,
        defaultSkin: 'grey',
        skins: { grey: { '0': 'tex/grey.png' }, mossy: { '0': 'tex/mossy.png' } },
        animations: { states: { idle: 'Stand', move: 'Walk' }, events: { EntityDied: 'Death' } },
        // Неприменимые к decoration части записи (ASSET-9): валидны, но смысла
        // не получают — проверяется ниже.
        verticalOffset: { jumpArc: 5, fallSpeed: 9, fallDepth: 9 },
        boneControls: { head: { bone: 'Bone_Chest', maxYawDeg: 45, smoothing: 0.2 } },
      },
      Runner: { model: MODEL_ID, scale: 1 },
    },
    decorations: {
      Grass: { model: GRASS_ID, scale: 1, animations: { states: { idle: 'Stand' } } },
    },
  };
}

interface Rig {
  readonly stage: PresentationStage;
  readonly models: ModelsSubsystem;
  readonly decorations: DecorationSet;
  readonly ctx: RenderContext;
  readonly assets: AssetsStub;
  frame(dt: number): void;
}

function makeRig(manifest: VisualManifest = makeManifest()): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const models = new ModelsSubsystem(manifest, { warn: () => {} });
  const stage = new PresentationStage(ctx).register(models);
  return {
    stage,
    models,
    decorations: new DecorationSet(stage),
    ctx,
    assets,
    frame: (dt) => stage.frame(dt, 1),
  };
}

/** Запись набора: обязательные поля один раз, остальное — правкой. */
function decoration(key: string, partial: Partial<DecorationInstance> = {}): DecorationInstance {
  return { key, kind: 'Rock', x: 0, y: 0, ...partial };
}

function instanceOf(rig: Rig, key: string): ReturnType<ModelsSubsystem['instanceFor']> {
  const entity = rig.decorations.entityOf(key);
  return entity === undefined ? null : rig.models.instanceFor(entity, true);
}

// -------------------------------------------------------- сведение набора

describe('декларативное сведение набора decoration (REND-18)', () => {
  it('новый ключ создаёт инстанс, исчезнувший — убирает, сохранившийся — обновляет', () => {
    const rig = makeRig();

    rig.decorations.apply([decoration('a', { x: 1 }), decoration('b', { x: 2 })]);
    expect(rig.models.decorationCount).toBe(2);
    expect(rig.ctx.scene.children.length).toBe(2);

    rig.decorations.apply([decoration('a', { x: 3 }), decoration('c', { x: 4 })]);
    expect(rig.models.decorationCount).toBe(2);
    expect(rig.decorations.entityOf('b')).toBeUndefined();

    rig.frame(0.016);
    expect(instanceOf(rig, 'a')!.holder.position.x).toBeCloseTo(3, 6);
    expect(instanceOf(rig, 'c')!.holder.position.x).toBeCloseTo(4, 6);
  });

  it('ключ устойчив к правке полей: инстанс обновляется, а не пересоздаётся', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const before = instanceOf(rig, 'a')!;

    // Правка позиции, курса, масштаба и скина — всё это одна и та же запись.
    rig.decorations.apply([decoration('a', { x: 5, y: 6, yaw: 0.7, scale: 2, skin: 'mossy' })]);
    const after = instanceOf(rig, 'a')!;
    expect(after.holder).toBe(before.holder);
    expect(after.model).toBe(before.model);
    rig.frame(0.016);
    expect(after.holder.position.x).toBeCloseTo(5, 6);
    expect(after.holder.scale.x).toBeCloseTo(2, 6);
  });

  it('смена вида пересоздаёт инстанс — это другая модель, а не правка поля', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a')]);
    const before = instanceOf(rig, 'a')!.holder;
    rig.decorations.apply([decoration('a', { kind: 'Grass' })]);
    expect(instanceOf(rig, 'a')!.holder).not.toBe(before);
    expect(rig.models.decorationCount).toBe(1);
  });

  it('вид разрешается в обоих разделах манифеста одним способом (ASSET-9)', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('rock'), decoration('grass', { kind: 'Grass' })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.assets.resolve('model', GRASS_ID, makeModel());
    const requested = rig.assets.requests.filter((r) => r.kind === 'model').map((r) => r.id);
    expect(requested).toContain(MODEL_ID);
    expect(requested).toContain(GRASS_ID);
    expect(instanceOf(rig, 'grass')!.model).not.toBeNull();
  });

  it('повторный ключ в одном наборе — отказ, а не молчаливая победа последнего', () => {
    const rig = makeRig();
    expect(() => rig.decorations.apply([decoration('a'), decoration('a')])).toThrow(/REND-18/);
  });

  it('пустой набор гасит декорации, разделяемый ассет остаётся в кэше (REND-3)', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a'), decoration('b')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const before = rig.assets.requests.filter((r) => r.kind === 'model').length;

    rig.decorations.clear();
    expect(rig.models.decorationCount).toBe(0);
    expect(rig.ctx.scene.children.length).toBe(0);

    rig.decorations.apply([decoration('a')]);
    expect(rig.assets.requests.filter((r) => r.kind === 'model').length).toBe(before);
  });

  it('сцена без парного документа даёт пустой набор и прежний кадр', () => {
    const rig = makeRig();
    rig.decorations.apply([]);
    expect(rig.models.decorationCount).toBe(0);
    expect(rig.ctx.scene.children.length).toBe(0);
  });
});

// ---------------------------------------- чего у decoration нет (REND-18)

describe('производного от TickResult у decoration нет (REND-18)', () => {
  it('поза ровно документная: интерполяции между обновлениями нет', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a', { x: 0 })]);
    rig.frame(0.016);
    expect(instanceOf(rig, 'a')!.holder.position.x).toBeCloseTo(0, 6);

    rig.decorations.apply([decoration('a', { x: 10, yaw: 1 })]);
    // Первый же кадр после правки — в новой позе целиком, без «доезжания».
    rig.frame(0.016);
    const holder = instanceOf(rig, 'a')!.holder;
    expect(holder.position.x).toBeCloseTo(10, 6);
    expect(holder.rotation.z).toBeCloseTo(1, 6);
  });

  it('клип — состояние покоя записи манифеста; событийных клипов нет', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    expect(instanceOf(rig, 'a')!.controller!.currentClipName).toBe('Stand - 1');
  });

  it('вертикального смещения нет, хотя запись его несёт (REND-12 к decoration не применяется)', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.frame(0.5);
    // Инстанс на нуле: ни дуги прыжка, ни снижения — манёвров у него не бывает.
    expect(instanceOf(rig, 'a')!.holder.position.z).toBeCloseTo(0, 6);
  });
});

// -------------------------------------- сосуществование с продюсерами

describe('набор сосуществует с любым продюсером (REND-18)', () => {
  function makeSim(): { scene: Scene; sim: Simulation } {
    const scene = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [{ name: 'Runner', components: { Position: {} }, tags: ['Runner'] }],
      terrain: { width: 2, height: 2, tileSize: FIXED_ONE, levels: ['00', '00'], flags: ['..', '..'] },
    });
    const idle: System = { name: 'Idle', order: 10, run: () => {} };
    scene.systems.register(idle);
    return {
      scene,
      sim: {
        systems: scene.systems,
        worldSeed: 7,
        math: mathApi,
        ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
      },
    };
  }

  it('вход в превью и выход из него декорации в кадре оставляют (ED-9)', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const models = new ModelsSubsystem(makeManifest(), { warn: () => {} });
    const stage = new PresentationStage(ctx).register(models);
    const source = new DocumentSource(stage, { clock: () => 0 });
    const decorations = new DecorationSet(stage);

    const { scene, sim } = makeSim();
    worldInitSpawn(scene.world, 'Runner', {
      Position: { x: fixed.fromFloat(0.5), y: fixed.fromFloat(0.5) },
    });
    const state = initialState(scene.world, 7);
    const host = new RenderHost(ctx, {
      tickSeconds: 0.05,
      kindOf: kindByTags(['Runner']),
      stage,
      clock: () => 0,
    });

    // Режим правки: один документный инстанс и одна декорация.
    decorations.apply([decoration('grass', { kind: 'Grass', x: 1, y: 1 })]);
    source.apply([{ key: 'unit', kind: 'Runner', x: 0.5, y: 0.5 }]);
    expect(ctx.scene.children.length).toBe(2);
    const decorationHolder = instanceHolder(models, decorations, 'grass');

    // Вход в превью: документные инстансы гасятся сменой продюсера…
    dispatch(tick(sim, state), [host]);
    expect(stage.activeProducer).toBe(host);
    // …а декорация остаётся тем же самым инстансом — её набор от смены не зависит.
    expect(models.decorationCount).toBe(1);
    expect(instanceHolder(models, decorations, 'grass')).toBe(decorationHolder);
    expect(ctx.scene.children.length).toBe(2);

    // Выход из превью: тоже без удвоения и без гашения декорации.
    source.apply([{ key: 'unit', kind: 'Runner', x: 0.5, y: 0.5 }]);
    expect(stage.activeProducer).toBe(source);
    expect(models.decorationCount).toBe(1);
    expect(instanceHolder(models, decorations, 'grass')).toBe(decorationHolder);
    expect(ctx.scene.children.length).toBe(2);
  });

  it('detach гасит набор продюсера и декораций не касается', () => {
    const rig = makeRig();
    const source = new DocumentSource(rig.stage, { clock: () => 0 });
    rig.decorations.apply([decoration('a')]);
    source.apply([{ key: 'unit', kind: 'Runner', x: 0, y: 0 }]);
    expect(rig.ctx.scene.children.length).toBe(2);

    rig.stage.detach(source);
    expect(rig.stage.activeProducer).toBeNull();
    expect(rig.models.decorationCount).toBe(1);
    expect(rig.ctx.scene.children.length).toBe(1);
  });

  it('нумерация наборов своя: одно число адресует разные инстансы', () => {
    const rig = makeRig();
    const source = new DocumentSource(rig.stage, { clock: () => 0 });
    rig.decorations.apply([decoration('deco')]);
    source.apply([{ key: 'unit', kind: 'Runner', x: 0, y: 0 }]);
    // Оба набора нумеруют с единицы — и это не коллизия: пулы разные.
    expect(rig.decorations.entityOf('deco')).toBe(source.entityOf('unit'));
    expect(rig.models.instanceFor(1, true)).not.toBe(rig.models.instanceFor(1, false));
    expect(rig.decorations.keyOf(1)).toBe('deco');
  });
});

// ---------------------------------- переподача манифеста (REND-17, ASSET-9)

describe('переподача манифеста действует и на decoration (REND-17)', () => {
  it('правка записи вида доезжает до размещённой декорации', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a', { kind: 'Grass' })]);
    rig.assets.resolve('model', GRASS_ID, makeModel());
    const before = instanceOf(rig, 'a')!;
    expect(before.model).not.toBeNull();

    const next = makeManifest();
    next.decorations!['Grass'] = { model: 'models/flower.mdx', scale: 1 };
    rig.models.applyManifest(next);
    // Другая модель — инстанс пересобран под новую запись (REND-3, REND-17).
    expect(rig.assets.requests.some((r) => r.id === 'models/flower.mdx')).toBe(true);
    expect(instanceOf(rig, 'a')!.model).toBeNull();
  });
});

// ---------------------------------------- picking и наложения (REND-15/16)

const VIEWPORT: ViewportPoint = { x: 50, y: 50, width: 100, height: 100 };

function lookDown(x: number, y: number, z = 10): CameraPose {
  return { posX: x, posY: y, posZ: z, yaw: 0, pitch: Math.PI / 2, roll: 0, fovDeg: 45 };
}

function instanceHolder(
  models: ModelsSubsystem,
  set: DecorationSet,
  key: string,
): THREE.Group | null {
  const entity = set.entityOf(key);
  return entity === undefined ? null : (models.instanceFor(entity, true)?.holder ?? null);
}

function curvedGrid(): TerrainGrid {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: FIXED_ONE,
    levels: ['0011', '0011', '0011', '0011'],
    flags: ['....', '....', '....', '....'],
  });
}

interface PickRig {
  readonly ctx: RenderContext;
  readonly models: ModelsSubsystem;
  readonly overlays: OverlaySubsystem;
  readonly decorations: DecorationSet;
  readonly source: DocumentSource;
  readonly picking: ViewportPicking;
  readonly assets: AssetsStub;
  frame(): void;
}

function makePickRig(): PickRig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 2 },
  };
  const surface = new VisualSurfaceSource(curvedGrid());
  const models = new ModelsSubsystem(makeManifest(), { surface, warn: () => {} });
  const overlays = new OverlaySubsystem({ surface, instances: models });
  const stage = new PresentationStage(ctx).register(models).register(overlays);
  const picking = new ViewportPicking({ surface, instances: models, handles: overlays });
  return {
    ctx,
    models,
    overlays,
    decorations: new DecorationSet(stage),
    source: new DocumentSource(stage, { clock: () => 0 }),
    picking,
    assets,
    frame: () => stage.frame(0.016, 1),
  };
}

describe('picking и наложения по decoration-инстансам (REND-18, ED-17)', () => {
  it('клик по декорации на склоне разрешается так же, как по размещённому объекту', () => {
    const rig = makePickRig();
    // Клетка (2,1) — плато уровня 1 при шаге высоты 2, то есть z = 2.
    rig.decorations.apply([decoration('rock', { x: 2.5, y: 1.5 })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.frame();

    const hit = rig.picking.pick(lookDown(2.5, 1.5, 12), VIEWPORT)!;
    expect(hit.kind).toBe('entity');
    expect(hit.decoration).toBe(true);
    expect(rig.decorations.keyOf(hit.entity)).toBe('rock');
  });

  it('при совпадающей дистанции побеждает инстанс presentation-состояния', () => {
    const rig = makePickRig();
    // Один и тот же объём в одной и той же точке: декорация идёт после (REND-18).
    rig.source.apply([{ key: 'unit', kind: 'Rock', x: 2.5, y: 1.5 }]);
    rig.decorations.apply([decoration('rock', { x: 2.5, y: 1.5 })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.frame();

    const hit = rig.picking.pick(lookDown(2.5, 1.5, 12), VIEWPORT)!;
    expect(hit.decoration).toBe(false);
    expect(rig.source.keyOf(hit.entity)).toBe('unit');
  });

  it('подсветка выделения работает по декорации тем же наложением', () => {
    const rig = makePickRig();
    rig.decorations.apply([decoration('rock', { x: 2.5, y: 1.5 })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.frame();

    const entity = rig.decorations.entityOf('rock')!;
    rig.overlays.apply([{ kind: 'highlight', key: 'selection:rock', entity, decoration: true }]);
    rig.frame();
    expect(rig.overlays.size).toBe(1);
    expect(rig.overlays.objectCount).toBe(1);

    // Тот же номер без признака адресует ПУСТОЙ набор presentation-состояния:
    // подсветить нечего, и рамка гасится, а не встаёт на чужой инстанс.
    rig.overlays.apply([{ kind: 'highlight', key: 'selection:rock', entity }]);
    rig.frame();
    const outline = findOutline(rig.ctx.scene);
    expect(outline?.visible).toBe(false);
  });
});

function findOutline(scene: THREE.Scene): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  scene.traverse((node) => {
    if (node.name.startsWith('highlight:')) found = node;
  });
  return found;
}
