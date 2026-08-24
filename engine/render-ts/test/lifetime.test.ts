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
import type { NormalizedMesh, ParticleEffectDocument, VisualManifest } from '@fluxus/assets';
import {
  EffectsSubsystem,
  FogSubsystem,
  LightingSubsystem,
  ModelBatch,
  ModelsSubsystem,
  OverlaySubsystem,
  ParticlesSubsystem,
  PresentationStage,
  TerrainSubsystem,
  batchLevels,
  createCostCounters,
  geometryFromMesh,
  withCostSink,
  type RenderContext,
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
