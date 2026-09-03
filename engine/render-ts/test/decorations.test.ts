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
import { describe, expect, it, vi } from 'vitest';
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
} from '@fluxus/core';
import type { VisualManifest } from '@fluxus/assets';
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
  type ModelInstanceView,
  type RenderContext,
  type ViewportPoint,
} from '../src/index.js';
import { KeyedInstanceSet, type KeyedInstance } from '../src/keyedInstanceSet.js';
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
    frame: (dt) => { stage.frame(dt, 1); },
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
    expect(instanceOf(rig, 'a')!.pose.x).toBeCloseTo(3, 6);
    expect(instanceOf(rig, 'c')!.pose.x).toBeCloseTo(4, 6);
  });

  it('ключ устойчив к правке полей: инстанс обновляется, а не пересоздаётся', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a')]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const before = instanceOf(rig, 'a')!;

    // Правка позиции, курса, масштаба и скина — всё это одна и та же запись.
    rig.decorations.apply([decoration('a', { x: 5, y: 6, yaw: 0.7, scale: 2, skin: 'mossy' })]);
    const after = instanceOf(rig, 'a')!;
    // Вид инстанса стабилен на всё время его жизни: тот же объект — тот же
    // инстанс, пересоздания не было (REND-3, REND-18).
    expect(after).toBe(before);
    expect(after.model).toBe(before.model);
    rig.frame(0.016);
    expect(after.pose.x).toBeCloseTo(5, 6);
    expect(after.pose.scale).toBeCloseTo(2, 6);
  });

  it('смена вида пересоздаёт инстанс — это другая модель, а не правка поля', () => {
    const rig = makeRig();
    rig.decorations.apply([decoration('a')]);
    const before = instanceOf(rig, 'a')!;
    rig.decorations.apply([decoration('a', { kind: 'Grass' })]);
    expect(instanceOf(rig, 'a')).not.toBe(before);
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
    // Запись `Grass` без контроля костей — батчевый ярус (REND-20): модели
    // детального яруса у неё нет, а заглушка снята — модель доехала.
    expect(instanceOf(rig, 'grass')!.tier).toBe('batched');
    expect(instanceOf(rig, 'grass')!.placeholder).toBe(false);
  });

  it('повторный ключ в одном наборе — отказ, а не молчаливая победа последнего', () => {
    const rig = makeRig();
    expect(() => { rig.decorations.apply([decoration('a'), decoration('a')]); }).toThrow(/REND-18/);
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
    expect(instanceOf(rig, 'a')!.pose.x).toBeCloseTo(0, 6);

    rig.decorations.apply([decoration('a', { x: 10, yaw: 1 })]);
    // Первый же кадр после правки — в новой позе целиком, без «доезжания».
    rig.frame(0.016);
    const pose = instanceOf(rig, 'a')!.pose;
    expect(pose.x).toBeCloseTo(10, 6);
    expect(pose.yaw).toBeCloseTo(1, 6);
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
    expect(instanceOf(rig, 'a')!.pose.z).toBeCloseTo(0, 6);
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
    const decorationInstance = instanceView(models, decorations, 'grass');

    // Вход в превью: документные инстансы гасятся сменой продюсера…
    dispatch(tick(sim, state), [host]);
    expect(stage.activeProducer).toBe(host);
    // …а декорация остаётся тем же самым инстансом — её набор от смены не зависит.
    expect(models.decorationCount).toBe(1);
    expect(instanceView(models, decorations, 'grass')).toBe(decorationInstance);
    expect(ctx.scene.children.length).toBe(2);

    // Выход из превью: тоже без удвоения и без гашения декорации.
    source.apply([{ key: 'unit', kind: 'Runner', x: 0.5, y: 0.5 }]);
    expect(stage.activeProducer).toBe(source);
    expect(models.decorationCount).toBe(1);
    expect(instanceView(models, decorations, 'grass')).toBe(decorationInstance);
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
    expect(before.placeholder).toBe(false);

    const next = makeManifest();
    next.decorations!.Grass = { model: 'models/flower.mdx', scale: 1 };
    rig.models.applyManifest(next);
    // Другая модель — инстанс пересобран под новую запись (REND-3, REND-17).
    expect(rig.assets.requests.some((r) => r.id === 'models/flower.mdx')).toBe(true);
    expect(instanceOf(rig, 'a')!.placeholder).toBe(true);
  });
});

// ---------------------------------------- picking и наложения (REND-15/16)

const VIEWPORT: ViewportPoint = { x: 50, y: 50, width: 100, height: 100 };

function lookDown(x: number, y: number, z = 10): CameraPose {
  return { posX: x, posY: y, posZ: z, yaw: 0, pitch: Math.PI / 2, roll: 0, fovDeg: 45 };
}

function instanceView(
  models: ModelsSubsystem,
  set: DecorationSet,
  key: string,
): ModelInstanceView | null {
  const entity = set.entityOf(key);
  return entity === undefined ? null : models.instanceFor(entity, true);
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
    frame: () => { stage.frame(0.016, 1); },
  };
}

describe('picking и наложения по decoration-инстансам (REND-18, ED-17)', () => {
  it('клик по декорации на склоне разрешается так же, как по размещённому объекту', () => {
    const rig = makePickRig();
    // Клетка (2,1) — плато уровня 1 при шаге высоты 2, то есть z = 2.
    rig.decorations.apply([decoration('rock', { x: 2.5, y: 1.5 })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.frame();

    // Согласованность попадания с изображением держится на том, что декорация
    // посажена на визуальную поверхность тем же путём, что сим-объект (REND-9,
    // REND-10): плато уровня 1 при шаге высоты 2 — это z = 2, и разрешись
    // picking по «документной» позе на нуле, попадание разошлось бы с картинкой.
    const pose = instanceView(rig.models, rig.decorations, 'rock')!.pose;
    expect(pose.z).toBeCloseTo(2, 6);

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

/**
 * Переподача набора декораций приходит на КАЖДУЮ правку документа (ED-15), а
 * работа поодаль от неё дорогая: перезапекание кэшированной карты статических
 * теней (REND-8) и перестройка walkable-вклада поля высот (REND-9). Платить ими
 * за правку, размещения не касающуюся, нельзя.
 */
describe('цена переподачи набора декораций (REND-18 → REND-8, REND-9)', () => {
  /** Запись без анимаций — статический ярус кастера; с ними — динамический (design D3). */
  function costManifest(): VisualManifest {
    return {
      entities: {},
      decorations: {
        Stone: { model: MODEL_ID, scale: 1, skins: { grey: {}, mossy: {} } },
        Torch: { model: GRASS_ID, scale: 1, animations: { states: { idle: 'Stand' } } },
      },
    };
  }

  interface CostRig {
    readonly decorations: DecorationSet;
    readonly assets: AssetsStub;
    readonly surface: VisualSurfaceSource;
    /** Сколько раз кэшированная карта статики объявлена устаревшей. */
    invalidations(): number;
    walkableCalls(): number;
  }

  function makeCostRig(): CostRig {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    let invalidations = 0;
    const surface = new VisualSurfaceSource(
      createTerrainGrid({
        width: 4,
        height: 4,
        tileSize: FIXED_ONE,
        levels: Array.from({ length: 4 }, () => '0000'),
        flags: Array.from({ length: 4 }, () => '....'),
      }),
    );
    const walkable = vi.spyOn(surface, 'setWalkable');
    const models = new ModelsSubsystem(costManifest(), {
      surface,
      warn: () => {},
      shadows: {
        setCaster: () => {},
        dropCaster: () => {},
        invalidateStatic: () => { invalidations++; },
      },
    });
    const stage = new PresentationStage(ctx).register(models);
    return {
      decorations: new DecorationSet(stage),
      assets,
      surface,
      invalidations: () => invalidations,
      walkableCalls: () => walkable.mock.calls.length,
    };
  }

  const stone = (partial: Partial<DecorationInstance> = {}): DecorationInstance => ({
    key: 'stone',
    kind: 'Stone',
    x: 1,
    y: 1,
    ...partial,
  });

  it('тот же набор второй раз не перезапекает статику и не трогает реестр поля', () => {
    const rig = makeCostRig();
    rig.decorations.apply([stone({ walkable: true })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const invalidated = rig.invalidations();
    const registered = rig.walkableCalls();
    expect(invalidated).toBeGreaterThan(0); // появление статики — переезд
    expect(registered).toBeGreaterThan(0);

    // Редактор отдаёт документ ЦЕЛИКОМ на каждую правку (REND-17, ED-15), в том
    // числе на правку, этой декорации не касавшуюся вовсе.
    rig.decorations.apply([stone({ walkable: true })]);

    expect(rig.invalidations()).toBe(invalidated);
    expect(rig.walkableCalls()).toBe(registered);
  });

  it('сдвиг и разворот статической декорации перезапекают статику', () => {
    const rig = makeCostRig();
    rig.decorations.apply([stone()]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const invalidated = rig.invalidations();

    rig.decorations.apply([stone({ x: 2 })]);
    expect(rig.invalidations()).toBe(invalidated + 1);

    rig.decorations.apply([stone({ x: 2, yaw: 0.25 })]);
    expect(rig.invalidations()).toBe(invalidated + 2);

    // Исчезнувшая статика — тоже переезд: её тень запечена в карте.
    rig.decorations.apply([]);
    expect(rig.invalidations()).toBe(invalidated + 3);
  });

  it('правка не-размещающего поля статику не трогает', () => {
    const rig = makeCostRig();
    rig.decorations.apply([stone({ skin: 'grey' })]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const invalidated = rig.invalidations();
    const registered = rig.walkableCalls();

    // Скин к карте теней и к полю высот отношения не имеет (REND-6).
    rig.decorations.apply([stone({ skin: 'mossy' })]);
    expect(rig.invalidations()).toBe(invalidated);
    expect(rig.walkableCalls()).toBe(registered);
  });

  it('переехавшая ДИНАМИЧЕСКАЯ декорация кэш статики не устаревает', () => {
    const rig = makeCostRig();
    const torch = (x: number): DecorationInstance => ({ key: 'torch', kind: 'Torch', x, y: 0 });
    rig.decorations.apply([torch(0)]);
    rig.assets.resolve('model', GRASS_ID, makeModel());
    const invalidated = rig.invalidations();

    // Анимированная декорация рисуется покадровой картой (design D3): в
    // кэшированной статике её тени нет, и перезапекать из-за неё нечего.
    rig.decorations.apply([torch(2)]);
    expect(rig.invalidations()).toBe(invalidated);
  });

  it('правка флага walkable доводит поле, но статику не перезапекает', () => {
    const rig = makeCostRig();
    rig.decorations.apply([stone()]);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const invalidated = rig.invalidations();
    const registered = rig.walkableCalls();

    rig.decorations.apply([stone({ walkable: true })]);
    // Вклад в поле высот появился (REND-9)…
    expect(rig.walkableCalls()).toBeGreaterThan(registered);
    // …а силуэт тени не сдвинулся ни на йоту (REND-8).
    expect(rig.invalidations()).toBe(invalidated);
  });
});

/**
 * Отчёт сведения (REND-3): наборы с дорогими следствиями обязаны уметь спросить
 * «а изменилось ли вообще что-нибудь».
 */
describe('KeyedInstanceSet.apply сообщает об изменении набора', () => {
  interface Placed extends KeyedInstance {
    readonly yaw?: number;
  }

  /** Набор, чей `write` о правках ОТЧИТЫВАЕТСЯ: курс сравнивается по значению. */
  function reporting(): KeyedInstanceSet<Placed> {
    return new KeyedInstanceSet<Placed>({
      owner: 'Стенд',
      requirement: 'REND-3',
      write: (view, instance) => {
        const yaw = instance.yaw ?? 0;
        if (view.facingYaw === yaw && view.currX === instance.x) return false;
        view.facingYaw = yaw;
        view.prevX = view.currX = instance.x;
        return true;
      },
    });
  }

  it('появление, правка, смена вида и исчезновение — изменения; повтор — нет', () => {
    const set = reporting();
    expect(set.apply([{ key: 'a', kind: 'Rock', x: 0, y: 0 }])).toBe(true);
    expect(set.apply([{ key: 'a', kind: 'Rock', x: 0, y: 0 }])).toBe(false);
    expect(set.apply([{ key: 'a', kind: 'Rock', x: 0, y: 0, yaw: 1 }])).toBe(true);
    // Смена вида — пересоздание инстанса под тем же ключом.
    expect(set.apply([{ key: 'a', kind: 'Grass', x: 0, y: 0, yaw: 1 }])).toBe(true);
    expect(set.apply([])).toBe(true);
    expect(set.apply([])).toBe(false);
  });

  it('набор, чей write молчит, объявляет изменением каждое сведение', () => {
    const silent = new KeyedInstanceSet<KeyedInstance>({
      owner: 'Стенд',
      requirement: 'REND-3',
      write: () => {},
    });
    const instance: KeyedInstance = { key: 'a', kind: 'Rock', x: 0, y: 0 };
    expect(silent.apply([instance])).toBe(true);
    // Отчёт консервативен: механизм знает только поля `KeyedInstance`, а что
    // сделал с инстансом сам набор, знает набор — и молчание нельзя читать как
    // «ничего не изменилось».
    expect(silent.apply([instance])).toBe(true);
  });
});
