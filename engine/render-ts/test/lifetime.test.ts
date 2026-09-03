/**
 * Время жизни ресурсов подсистемы (REND-31): необязательная точка освобождения
 * рядом с контрактом REND-8, снос сцены обратным порядком регистрации и
 * пересмотр кэша батчей на переподаче манифеста (REND-17, REND-20).
 *
 * Всё headless, как и остальной пакет: живого WebGL нет, а «отдали ли объект»
 * видно шпионом на его `dispose` — у геометрий, материалов, текстур и целей
 * отрисовки THREE эта форма одна и та же.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ParticleEmitter, type ParticleSystem } from 'three.quarks';
import { FIXED_ONE, createTerrainGrid, type EntityId } from '@fluxus/core';
import type {
  NormalizedMesh,
  ParticleEffectDocument,
  PresentationWater,
  VisualManifest,
} from '@fluxus/assets';
import {
  EffectsSubsystem,
  FogSubsystem,
  LightingSubsystem,
  ModelBatch,
  ModelsSubsystem,
  OverlaySubsystem,
  ParticlesSubsystem,
  PostprocessSubsystem,
  PresentationStage,
  TerrainSubsystem,
  ViewBuffer,
  VisualSurfaceSource,
  WaterSubsystem,
  batchLevels,
  createCostCounters,
  createFootprint,
  footprintLive,
  geometryFromMesh,
  withCostSink,
  withFootprintSink,
  type RenderContext,
  type RenderFootprint,
  type RenderSubsystem,
  type SharedMeshData,
  type TickView,
} from '../src/index.js';
import {
  buildFogMask,
  fogCanvasFactory,
  flatGrid,
  makeAssets,
  makeEntityView,
  makeExtractedTick,
  makeModel,
  makeRenderContext,
  makeTickView,
  type AssetsStub,
} from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
const HERO: EntityId = 1;

/** Подсистема-пробник: записывает свой снос в общий журнал порядка. */
function probe(name: string, log: string[], withDispose = true): RenderSubsystem {
  const subsystem: RenderSubsystem = {
    name,
    init: () => {},
    syncTick: () => {
      log.push(`sync:${name}`);
    },
    updateFrame: () => {
      log.push(`frame:${name}`);
    },
  };
  if (!withDispose) return subsystem;
  return {
    ...subsystem,
    dispose: () => {
      log.push(`dispose:${name}`);
    },
  };
}

function emptyView(): TickView {
  return makeTickView([]);
}

// ------------------------------------------------------------- снос сцены

describe('снос сцены подсистем (REND-31)', () => {
  it('подсистемы сносятся в порядке, обратном регистрации', () => {
    const log: string[] = [];
    const stage = new PresentationStage(makeRenderContext());
    stage.register(probe('lighting', log)).register(probe('terrain', log)).register(probe('models', log));

    stage.dispose();

    expect(log).toEqual(['dispose:models', 'dispose:terrain', 'dispose:lighting']);
  });

  it('подсистема без точки освобождения снос переживает — это не дефект', () => {
    const log: string[] = [];
    const stage = new PresentationStage(makeRenderContext());
    stage.register(probe('overlays', log, false)).register(probe('models', log));

    expect(() => {
      stage.dispose();
    }).not.toThrow();
    expect(log).toEqual(['dispose:models']);
  });

  it('после сноса реестр пуст: ни кадра, ни доставки, ни счётных величин', () => {
    const log: string[] = [];
    const producer = { name: 'test' };
    const stage = new PresentationStage(makeRenderContext());
    stage.register(probe('models', log));
    stage.publish(producer, emptyView());
    expect(log).toContain('sync:models');

    stage.dispose();
    log.length = 0;

    const counters = createCostCounters();
    withCostSink(counters, () => {
      stage.publish(producer, emptyView());
      stage.frame(1 / 60, 0, 1 / 60);
    });
    expect(log).toEqual([]);
    // Доставка и кадр посчитаны, а подсистем в них ноль: реестр пуст (PERF-3).
    expect(counters.syncTickSubsystems).toBe(0);
    expect(counters.frameSubsystems).toBe(0);
  });
});

// ---------------------------------------------- собственные ресурсы подсистем

describe('подсистемы отдают свои ресурсы GPU (REND-31)', () => {
  it('туман отдаёт маску, цель отрисовки и материал пост-прохода (FOW-7)', () => {
    const subsystem = new FogSubsystem({
      grid: flatGrid(),
      stats: { visionRadius: 'vision', team: 'team' },
      hero: () => HERO,
      createCanvas: fogCanvasFactory(),
    });
    subsystem.init(makeRenderContext());
    subsystem.syncTick(
      makeTickView([
        makeEntityView(HERO, {
          currX: 4,
          currY: 4,
          stats: new Map([
            ['team', 1],
            ['vision', 3],
          ]),
        }),
      ]),
    );
    const renderer = {
      render: () => {},
      setRenderTarget: () => {},
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(32, 24),
    };
    // Растр строит кадр порциями (change `fog-mask-budgeted-rebuild`, design
    // D1): до публикации подсистема рисует прямым проходом и цели не заводит.
    buildFogMask(subsystem);
    subsystem.render(renderer, new THREE.PerspectiveCamera());

    const pass = subsystem.postPass;
    const quad = pass.scene.children[0] as THREE.Mesh;
    // Промежуточная цель кадра заведена первым же проходом с построенной маской.
    expect(pass.target).not.toBeNull();
    const quadGeometry = vi.spyOn(quad.geometry, 'dispose');
    const material = vi.spyOn(quad.material as THREE.Material, 'dispose');
    const mask = vi.spyOn(pass.mask, 'dispose');
    const target = vi.spyOn(pass.target!, 'dispose');

    subsystem.dispose();

    expect(quadGeometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledTimes(1);
    expect(target).toHaveBeenCalledTimes(1);
    expect(subsystem.postPass.target).toBeNull();
    expect(pass.scene.children).toHaveLength(0);
    // Прямая отрисовка после сноса: маски больше нет, и лишнего прохода тоже.
    const passes: unknown[] = [];
    subsystem.render(
      { ...renderer, render: (target: THREE.Object3D) => passes.push(target) },
      new THREE.PerspectiveCamera(),
    );
    expect(passes).toHaveLength(1);
  });

  it('террейн отдаёт геометрии чанков и свои материалы', () => {
    const ctx = makeRenderContext();
    const subsystem = new TerrainSubsystem(
      createTerrainGrid({
        width: 2,
        height: 2,
        tileSize: FIXED_ONE,
        levels: ['01', '01'],
        flags: ['..', '..'],
      }),
    );
    subsystem.init(ctx);
    const meshes = ctx.scene.children.filter((node): node is THREE.Mesh => node instanceof THREE.Mesh);
    expect(meshes.length).toBeGreaterThan(0);
    const geometries = meshes.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
    const materials = new Set(meshes.map((mesh) => mesh.material as THREE.Material));
    const materialSpies = [...materials].map((material) => vi.spyOn(material, 'dispose'));

    subsystem.dispose();

    for (const spy of geometries) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of materialSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(ctx.scene.children.filter((node) => node instanceof THREE.Mesh)).toHaveLength(0);
  });

  it('наложения отдают разделяемые геометрии ручек и общие материалы (REND-16)', () => {
    const ctx = makeRenderContext();
    const subsystem = new OverlaySubsystem();
    subsystem.init(ctx);
    subsystem.apply([{ kind: 'grid', key: 'grid', x0: 0, y0: 0, x1: 1, y1: 1 }]);
    expect(subsystem.objectCount).toBe(1);

    const before = ctx.scene.children.length;
    subsystem.dispose();

    expect(subsystem.size).toBe(0);
    expect(subsystem.objectCount).toBe(0);
    expect(ctx.scene.children.length).toBeLessThan(before);
    // Повторный снос ничего не ломает: отдавать больше нечего.
    expect(() => {
      subsystem.dispose();
    }).not.toThrow();
  });

  it('освещение отдаёт карты теней и снимает источники со сцены (REND-30)', () => {
    const ctx = makeRenderContext();
    const subsystem = new LightingSubsystem({ config: { shadows: { mode: 'full' } } });
    subsystem.init(ctx);
    const { sun, ambient } = subsystem.lights;
    expect(sun.parent).not.toBeNull();

    subsystem.dispose();

    expect(sun.parent).toBeNull();
    expect(sun.target.parent).toBeNull();
    expect(ambient.parent).toBeNull();
    expect(subsystem.casterCount('static')).toBe(0);
    expect(subsystem.casterCount('dynamic')).toBe(0);
  });

  it('эффекты и частицы снимают свои группы со сцены (REND-23, REND-24)', () => {
    const ctx = makeRenderContext();
    const manifest: VisualManifest = { entities: {} };
    const effects = new EffectsSubsystem(manifest);
    const particles = new ParticlesSubsystem(manifest);
    effects.init(ctx);
    particles.init(ctx);
    const before = ctx.scene.children.length;
    expect(before).toBe(3);

    effects.dispose();
    particles.dispose();

    expect(ctx.scene.children).toHaveLength(0);
  });
});

// ------------------------------------------------- подсистема моделей и батчи

/** Запись батчевого яруса: контроля костей нет, значит ярус по умолчанию. */
function manifestFor(model: string): VisualManifest {
  return { entities: { Runner: { model, scale: 1 } } };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  readonly ctx: RenderContext;
  readonly assets: AssetsStub;
}

function makeRig(manifest: VisualManifest = manifestFor(MODEL_ID)): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(manifest, { warn: () => {} });
  subsystem.init(ctx);
  subsystem.syncTick(makeTickView([makeEntityView(HERO)]));
  assets.resolve('model', MODEL_ID, makeModel());
  return { subsystem, ctx, assets };
}

describe('пересмотр кэша батчей на переподаче манифеста (REND-31, REND-17)', () => {
  it('цикл переподач не растит число батчей: граница — документ, а не сессия', () => {
    const { subsystem, assets } = makeRig();
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });

    // Автор раз за разом перенаправляет запись на другую модель: ключ батча
    // производен от неё, и без пересмотра кэш рос бы на каждую правку.
    for (let i = 0; i < 8; i++) {
      const model = `models/gen-${String(i)}.mdx`;
      subsystem.applyManifest(manifestFor(model));
      assets.resolve('model', model, makeModel());
      expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });
    }
  });

  it('освобождённый батч отдан вместе со своими буферами', () => {
    const { subsystem, assets } = makeRig();
    const retired = subsystem.batchMeshes().map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
    expect(retired.length).toBeGreaterThan(0);

    subsystem.applyManifest(manifestFor('models/other.mdx'));
    assets.resolve('model', 'models/other.mdx', makeModel());

    for (const spy of retired) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('переподача без правок кэш не трогает', () => {
    const { subsystem } = makeRig();
    const before = subsystem.batchMeshes();
    const spies = before.map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));

    subsystem.applyManifest(manifestFor(MODEL_ID));

    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('правка одной записи не трогает батч соседней на той же модели', () => {
    const two: VisualManifest = {
      entities: { Runner: { model: MODEL_ID, scale: 1 }, Keeper: { model: MODEL_ID, scale: 2 } },
    };
    const { subsystem, assets } = makeRig(two);
    subsystem.syncTick(
      makeTickView([makeEntityView(HERO), makeEntityView(2, { kind: 'Keeper' })]),
    );
    expect(subsystem.batchStats()).toMatchObject({ batches: 2, records: 2 });
    // Батчи в порядке заведения: первым — `Runner`, вторым — сосед `Keeper`.
    const keeper = vi.spyOn(subsystem.batchMeshes()[1]!.geometry, 'dispose');

    const edited: VisualManifest = {
      entities: { Runner: { model: 'models/other.mdx', scale: 1 }, Keeper: two.entities.Keeper! },
    };
    subsystem.applyManifest(edited);
    assets.resolve('model', 'models/other.mdx', makeModel());

    expect(subsystem.batchStats()).toMatchObject({ batches: 2, records: 2 });
    expect(keeper).not.toHaveBeenCalled();
  });

  it('опустевший батч БЕЗ переподачи остаётся в кэше — игровой путь прежний (REND-20)', () => {
    const { subsystem } = makeRig();
    const spies = subsystem.batchMeshes().map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));

    // Сущность ушла из доставки: батч опустел, но переподачи не было.
    subsystem.syncTick(makeTickView([]));

    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 0 });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------- владение уровнями батча

/** Часть модели глазами батча: буферы принадлежат ассету (REND-3). */
function assetPart(): SharedMeshData {
  return { geometry: geometryFromMesh(makeModel().meshes[0]!), partId: 0, materialIndex: 0 };
}

/** Уровень цепочки (ASSET-12): те же части, упрощённая геометрия. */
function lodLevel(): { readonly meshes: readonly NormalizedMesh[] } {
  return { meshes: [makeModel().meshes[0]!] };
}

describe('владение уровнями батча (REND-22 → REND-31)', () => {
  it('batchLevels отдаёт владение цепочкой и не претендует на части модели', () => {
    const base = [assetPart()];
    const { levels, owned } = batchLevels(base, [lodLevel(), lodLevel()], undefined);

    expect(levels).toHaveLength(3);
    // Своё — ровно геометрии уровней цепочки, построенные здесь же.
    expect(owned).toHaveLength(2);
    expect(owned).toContain(levels[1]![0]!.geometry);
    expect(owned).toContain(levels[2]![0]!.geometry);
    // Часть модели — чужая: её буферы переживают батч (REND-3).
    expect(owned).not.toContain(base[0]!.geometry);
    expect(levels[0]![0]!.geometry).toBe(base[0]!.geometry);
  });

  it('снос батча отдаёт геометрии цепочки — и ПОСЛЕ обёрток', () => {
    const base = [assetPart()];
    const { levels, owned } = batchLevels(base, [lodLevel()], undefined);
    const batch = new ModelBatch({
      materials: [],
      partVisibility: { parts: [0], wordsPerFrame: 1, mask: new Uint32Array([0xffffffff]) },
      levels,
      ownedGeometries: owned,
    });
    const source = vi.spyOn(owned[0]!, 'dispose');
    const asset = vi.spyOn(base[0]!.geometry, 'dispose');
    // Обёртка уровня цепочки: у уровня 0 своя, у уровня 1 — вторая по порядку.
    const wrapper = vi.spyOn(batch.meshes[1]!.geometry, 'dispose');

    batch.dispose();

    expect(source).toHaveBeenCalledTimes(1);
    // Порядок несущий: обёртка отпускает атрибуты уровня, и только после этого
    // освобождение геометрии уровня попадает по её собственным буферам.
    expect(wrapper.mock.invocationCallOrder[0]!).toBeLessThan(
      source.mock.invocationCallOrder[0]!,
    );
    // Буферы ассета батч не трогает ни при каком порядке (REND-3).
    expect(asset).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------ разобранный граф эффекта

const SUB_EFFECT = 'vfx/sub-emitter.effect.json';

/** Документ с ДВУМЯ системами на одном материале и одной геометрии (ASSET-14). */
function subEffectDoc(): ParticleEffectDocument {
  const path = fileURLToPath(new URL('./fixtures/sub-emitter.effect.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ParticleEffectDocument;
}

describe('снос подсистемы частиц отдаёт разобранный граф (REND-24 → REND-31)', () => {
  it('ресурсы документа освобождаются, и каждый ровно один раз', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const manifest: VisualManifest = {
      entities: {},
      particles: { byKind: { Flame: { effect: SUB_EFFECT } } },
    };
    const subsystem = new ParticlesSubsystem(manifest, { warn: () => {} });
    subsystem.init(ctx);
    assets.resolve('particle-effect', SUB_EFFECT, subEffectDoc());
    subsystem.syncTick(makeTickView([makeEntityView(HERO, { kind: 'Flame' })]));

    // Клон делит материал и геометрию с образцом, а обе системы документа —
    // между собой: разных объектов здесь по одному, сколько бы систем ни было.
    const resources = new Set<{ uuid: string; dispose: () => void }>();
    let systems = 0;
    ctx.scene.traverse((node) => {
      if (!(node instanceof ParticleEmitter)) return;
      systems++;
      const system = node.system as ParticleSystem;
      resources.add(system.material);
      resources.add(system.instancingGeometry);
    });
    expect(systems).toBeGreaterThan(1);
    expect(resources.size).toBe(2);
    const spies = [...resources].map((resource) => vi.spyOn(resource, 'dispose'));

    subsystem.dispose();

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    // Повторный снос ничего не отдаёт заново: uuid документа уже израсходованы.
    subsystem.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('снос подсистемы моделей (REND-31)', () => {
  it('отдаёт батчи, разделяемые буферы модели и VAT-текстуру', () => {
    const { subsystem, ctx } = makeRig();
    const batchGeometries = subsystem.batchMeshes().map((mesh) => vi.spyOn(mesh.geometry, 'dispose'));
    expect(batchGeometries.length).toBeGreaterThan(0);

    subsystem.dispose();

    for (const spy of batchGeometries) expect(spy).toHaveBeenCalledTimes(1);
    expect(subsystem.batchStats()).toMatchObject({ batches: 0, records: 0 });
    expect(subsystem.instanceFor(HERO)).toBeNull();
    expect(ctx.scene.children).toHaveLength(0);
  });

  it('снос детального яруса убирает поддерево инстанса из сцены (REND-3)', () => {
    const manifest: VisualManifest = {
      entities: { Runner: { model: MODEL_ID, scale: 1, tier: 'detailed' } },
    };
    const { subsystem, ctx } = makeRig(manifest);
    expect(ctx.scene.children.length).toBeGreaterThan(0);

    subsystem.dispose();

    expect(ctx.scene.children).toHaveLength(0);
  });
});

/**
 * Fade-копии материалов (FOW-8) живут дольше эпизода угасания — их держит пул
 * ради скомпилированной программы, — но не дольше своего ОРИГИНАЛА: пул
 * ключуется им, и копия, пережившая оригинал, осталась бы в кэше навсегда.
 */
describe('время жизни fade-копий материалов (FOW-8 → REND-31)', () => {
  const FADE = 0.5;
  /** Детальный ярус: только у него угасание идёт копиями материалов. */
  const detailed: VisualManifest = {
    entities: { Runner: { model: MODEL_ID, scale: 1, tier: 'detailed' } },
  };
  /** Тот же вид со скином: подмена слота переводит материалы в СВОИ (REND-6). */
  const skinned: VisualManifest = {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        tier: 'detailed',
        defaultSkin: 'red',
        skins: { red: { '0': 'tex/red.png' } },
      },
    },
  };

  function makeFadingRig(manifest: VisualManifest): Rig {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const subsystem = new ModelsSubsystem(manifest, { warn: () => {}, fadeSeconds: FADE });
    subsystem.init(ctx);
    subsystem.syncTick(makeTickView([makeEntityView(HERO)]));
    assets.resolve('model', MODEL_ID, makeModel());
    return { subsystem, ctx, assets };
  }

  /** Копии, которыми инстанс нарисован в идущем эпизоде угасания. */
  function fadeClones(ctx: RenderContext): THREE.Material[] {
    const clones: THREE.Material[] = [];
    ctx.scene.traverse((node) => {
      const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
      if (mesh.isMesh !== true || mesh.material === undefined) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material.transparent) clones.push(material);
      }
    });
    expect(clones.length).toBeGreaterThan(0);
    return clones;
  }

  it('копии разделяемого материала ассета отдаются сносом подсистемы', () => {
    const { subsystem, ctx } = makeFadingRig(detailed);
    subsystem.updateFrame(1 / 60, 1); // fade-in появления: копии выданы
    const spies = fadeClones(ctx).map((clone) => vi.spyOn(clone, 'dispose'));
    // Эпизод доигран: копии в пуле, оригинал — материал ассета, ещё живой.
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    subsystem.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('копии СВОИХ материалов инстанса (REND-6) уходят вместе с инстансом', () => {
    const { subsystem, ctx } = makeFadingRig(skinned);
    subsystem.updateFrame(1 / 60, 1);
    const spies = fadeClones(ctx).map((clone) => vi.spyOn(clone, 'dispose'));
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    // Разрыв непрерывности убирает инстанс сразу (FOW-8), а с ним — его свои
    // материалы: их копиям в пуле держаться больше не за что.
    subsystem.syncTick(makeTickView([], { snapAll: true }));
    expect(subsystem.instanceFor(HERO)).toBeNull();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('копии ЗАГЛУШКИ модели без материалов уходят с инстансом, хоть он их и не «owns»', () => {
    // Модель без материалов даёт каждому инстансу СВОЙ материал по умолчанию
    // (`createModelInstance`), и `ownsMaterials` при этом остаётся ложью. Копию
    // такого оригинала нужно отпустить всё равно: инстанс освободит его своим
    // сносом, и копия пережила бы его — по одному мёртвому ключу пула на
    // каждый спавн (REND-31).
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const subsystem = new ModelsSubsystem(detailed, { warn: () => {}, fadeSeconds: FADE });
    subsystem.init(ctx);
    subsystem.syncTick(makeTickView([makeEntityView(HERO)]));
    assets.resolve('model', MODEL_ID, { ...makeModel(), materials: [], textureSlots: [] });

    subsystem.updateFrame(1 / 60, 1);
    const spies = fadeClones(ctx).map((clone) => vi.spyOn(clone, 'dispose'));
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    subsystem.syncTick(makeTickView([], { snapAll: true }));
    expect(subsystem.instanceFor(HERO)).toBeNull();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------ инвариант освобождения по учёту (PERF-8, PERF-9)

/**
 * Цикл «собрать тракт → отыграть доставки → снести», повторённый десять раз, —
 * ровно так живёт вьюпорт авторинга (`editor` ED-15), и ровно на нём видна
 * утечка, которую шпион не поймает: шпион проверяет то, что автор теста
 * вспомнил заранее, а учёт (PERF-8) — ВСЁ, что было создано.
 *
 * Проверяются две вещи, и ни одной из них не нужен эталон (PERF-9):
 *
 * - после каждого сноса живых ресурсов GPU у каждой подсистемы ноль;
 * - величины состояния после десятого цикла равны величинам после первого.
 *
 * Полноту учёта — что всякое создание вообще проходит через `own` — стережёт
 * `guard.test.ts` по исходнику: без него этот инвариант проверял бы только
 * учтённое.
 */
const CYCLES = 10;
const DELIVERIES_PER_CYCLE = 4;
/** Сущностей в доставке цикла: состав сменяется целиком на каждой (PERF-9). */
const CYCLE_ENTITIES = 6;
const CYCLE_MODEL = 'models/cycle.mdx';
const CYCLE_EFFECT = 'vfx/cycle.effect.json';

/**
 * Владелец, живущий ДОЛЬШЕ стенда, — процессные заглушки (ASSET-4): геометрия и
 * материал незагруженной модели и текстура-заглушка вариантов скина строятся
 * один раз на процесс и сносом сцены не отдаются по устройству, а не по
 * недосмотру. Инвариант PERF-9 — про подсистемы, и их этот владелец не
 * освобождает ни одной.
 *
 * Из инварианта он не ВЫЧЁРКИВАЕТСЯ, а проверяется отдельно (см.
 * `expectPlaceholders`): молчаливое исключение сделало бы единственного
 * владельца, который сноса не переживает по замыслу, ещё и единственным, кого
 * никто не считает, — и новый синглтон под этим именем прошёл бы гейт молча.
 */
const PLACEHOLDER_OWNER = 'placeholders';

/**
 * Заглушки процесса поимённо: вид ресурса → чем он является. Каждая — ОДНА на
 * процесс, поэтому живых у каждого вида не больше единицы; чего в этом списке
 * нет — тому под этим владельцем не место, и новый синглтон обязан появиться в
 * диффе вместе с причиной.
 */
const PLACEHOLDER_SINGLETONS: Readonly<Record<string, string>> = {
  geometry: 'коробка заглушки незагруженной модели (ASSET-4)',
  material: 'материал той же заглушки',
  texture: 'массив вариантов скина до прихода текстур (REND-6)',
};

/** Живые заглушки процесса: вид известен списку, и их не больше одной на вид. */
function expectPlaceholders(sink: RenderFootprint, where: string): void {
  const live = footprintLive(sink)[PLACEHOLDER_OWNER] ?? {};
  for (const [kind, count] of Object.entries(live)) {
    expect(PLACEHOLDER_SINGLETONS[kind], `${where}: незнакомая заглушка "${kind}"`).toBeDefined();
    expect(count, `${where}: заглушек вида "${kind}"`).toBeLessThanOrEqual(1);
  }
  expect(
    Object.values(live).reduce((sum, count) => sum + count, 0),
    `${where}: всего живых заглушек процесса`,
  ).toBeLessThanOrEqual(Object.keys(PLACEHOLDER_SINGLETONS).length);
}

/** Манифест цикла: обе подсистемы получают по записи — модель и эмиттер. */
function cycleManifest(): VisualManifest {
  return {
    entities: { Runner: { model: CYCLE_MODEL, scale: 1 } },
    particles: { byKind: { Runner: { effect: CYCLE_EFFECT } } },
  };
}

/** Секция воды под сетку стенда: ряды карты совпадают с сеткой клетка в клетку. */
function cycleWater(size: number): PresentationWater {
  return {
    cells: Array.from({ length: size }, () => '0'.repeat(size)),
    bodies: [
      {
        surfaceLevel: 0.5,
        shallowColor: '#4db8c4',
        deepColor: '#16505e',
        maxDepth: 0.5,
        detail: { source: 'procedural', layers: 2 },
      },
    ],
  };
}

/** Собранный тракт одного цикла: сцена подсистем и приём доставки перед ней. */
interface CycleStand {
  readonly stage: PresentationStage;
  /**
   * Приём доставки цикла (SHELL-2). Доставки идут ЧЕРЕЗ него, а не мимо:
   * величины состояния приёмника (`viewRecords`, `viewFacingMemory`) — часть
   * того, что цикл обязан вернуть, и стенд без него проверял бы только
   * подсистемы.
   */
  readonly buffer: ViewBuffer;
}

function buildCycleStand(): CycleStand {
  const grid = flatGrid(8);
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const manifest = cycleManifest();
  const warn = (): void => {};
  const surface = new VisualSurfaceSource(grid, { warn });
  const postprocess = new PostprocessSubsystem({
    config: { toneMapping: { operator: 'aces' }, bloom: { enabled: true } },
  });
  const lighting = new LightingSubsystem({ grid, config: { shadows: { mode: 'full' } } });
  const fog = new FogSubsystem({
    grid,
    stats: { visionRadius: 'vision', team: 'team' },
    hero: () => HERO,
    createCanvas: fogCanvasFactory(),
  });
  const stage = new PresentationStage(ctx);
  stage
    .register(postprocess)
    .register(lighting)
    .register(fog)
    .register(new TerrainSubsystem(grid, { chunkSize: 8, surface, shadows: lighting }))
    .register(new WaterSubsystem({ grid, config: cycleWater(8), surface, warn }))
    .register(new ModelsSubsystem(manifest, { warn, shadows: lighting }))
    .register(new ParticlesSubsystem(manifest, { warn }))
    .register(new EffectsSubsystem(manifest, { warn }))
    .register(new OverlaySubsystem());
  // Ассеты приезжают ПОСЛЕ регистрации — тем же путём, что в игре (ASSET-4):
  // подсистемы успевают завести заглушки, а потом получают настоящие данные.
  assets.resolve('model', CYCLE_MODEL, makeModel());
  assets.resolve('particle-effect', CYCLE_EFFECT, subEffectDoc());
  return { stage, buffer: new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 }) };
}

/**
 * Одна доставка цикла — плоской формой через приём (SHELL-2), как в игре: так в
 * цикл входят и величины приёмника, а не только пулы подсистем.
 *
 * Идентификаторы сменяются от доставки к доставке (`base` растёт): цикл обязан
 * возвращать записи исчезнувших сущностей, а не копить их (PERF-9).
 */
function deliverCycle(stand: CycleStand, tick: number): void {
  const ext = makeExtractedTick(CYCLE_ENTITIES, tick * CYCLE_ENTITIES);
  ext.tick = tick;
  stand.buffer.apply(ext);
  stand.stage.publish({ name: 'cycle' }, stand.buffer.view);
  stand.stage.frame(1 / 60, 0.5, 1 / 60);
}

/** Живые ресурсы подсистем — процессные заглушки в счёт инварианта не идут. */
function subsystemLive(sink: RenderFootprint): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [owner, kinds] of Object.entries(footprintLive(sink))) {
    if (owner === PLACEHOLDER_OWNER) continue;
    const nonzero = Object.fromEntries(Object.entries(kinds).filter(([, value]) => value !== 0));
    if (Object.keys(nonzero).length > 0) out[owner] = nonzero;
  }
  return out;
}

describe('PERF-9: цикл сборки и сноса тракта не оставляет живых ресурсов', () => {
  it(`${String(CYCLES)} циклов: после каждого сноса живых ноль, величины состояния не растут`, () => {
    const sink = createFootprint();
    let first: Record<string, number> | null = null;
    withFootprintSink(sink, () => {
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const stand = buildCycleStand();
        for (let i = 0; i < DELIVERIES_PER_CYCLE; i++) deliverCycle(stand, i + 1);
        // Учёт обязан был увидеть работу цикла: пустой сток прошёл бы проверку
        // ниже молча, и инвариант стерёг бы пустоту.
        expect(Object.keys(footprintLive(sink)).length, 'учёт пуст').toBeGreaterThan(0);

        stand.stage.dispose();

        // Ноль — по КАЖДОМУ владельцу и виду: текст находки называет подсистему
        // и вид ресурса, а не «где-то что-то течёт».
        expect(subsystemLive(sink), `цикл ${String(cycle + 1)}`).toEqual({});
        // Заглушки процесса сноса не переживают по недосмотру, а по замыслу —
        // и потому считаются отдельно, а не пропускаются молча.
        expectPlaceholders(sink, `цикл ${String(cycle + 1)}`);

        const state = { ...sink.state };
        if (first === null) first = state;
        // Величины состояния — пики за прогон: цикл, который что-то не
        // возвращает, поднял бы их выше первого цикла (PERF-9).
        else expect(state, `цикл ${String(cycle + 1)}`).toEqual(first);
      }
    });
  });
});

// ------------------- владелец текстуры в учёте памяти (PERF-8, T-8)

describe('PERF-8: текстуру записывает тот, кто ею владеет', () => {
  const image = { width: 1, height: 1, format: 'rgba8' as const, pixels: new Uint8Array(4) };

  it('деталь воды учтена владельцем water, а не model', () => {
    const sink = createFootprint();
    const assets = makeAssets();
    const grid = flatGrid(8);
    let before = 0;
    withFootprintSink(sink, () => {
      const water = new WaterSubsystem({
        grid,
        config: {
          cells: Array.from({ length: 8 }, () => '0'.repeat(8)),
          bodies: [
            {
              surfaceLevel: 0.5,
              shallowColor: '#4db8c4',
              deepColor: '#16505e',
              detail: {
                source: 'textured',
                normalMap: 'visuals/water-normal.png',
                foamNoise: 'visuals/water-foam.png',
              },
            },
          ],
        },
        warn: () => {},
      });
      water.init({
        scene: new THREE.Scene(),
        assets: assets.service,
        config: { heightStep: 0.5 },
      });
      // Глубинная текстура тела уже учтена подсистемой — считается ПРИРОСТ от
      // приезда карт детали, а не итог.
      before = footprintLive(sink).water?.texture ?? 0;
      assets.resolve('texture', 'visuals/water-normal.png', image);
      assets.resolve('texture', 'visuals/water-foam.png', image);
    });
    const live = footprintLive(sink);
    // Две карты детали — обе за подсистемой воды: в эталоне памяти деталь воды
    // обязана стоять своей строкой, а не растить строку моделей.
    expect((live.water?.texture ?? 0) - before).toBe(2);
    expect(live.model?.texture ?? 0).toBe(0);
  });

  it('покрытие террейна учтено владельцем terrain, а не model', () => {
    const sink = createFootprint();
    const assets = makeAssets();
    const grid = flatGrid(8);
    withFootprintSink(sink, () => {
      const terrain = new TerrainSubsystem(grid, {
        chunkSize: 8,
        floorCover: { texture: 'visuals/grass.png', period: 4 },
      });
      terrain.init({
        scene: new THREE.Scene(),
        assets: assets.service,
        config: { heightStep: 0.5 },
      });
      assets.resolve('texture', 'visuals/grass.png', image);
    });
    const live = footprintLive(sink);
    expect(live.terrain?.texture).toBe(1);
    expect(live.model?.texture ?? 0).toBe(0);
  });
});
