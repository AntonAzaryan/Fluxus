/**
 * Прогрев подсистем до первого кадра: всплеск открытия обзора (FOW-8)
 * монтирует уже построенное — модели, батчи и эффекты частиц строятся во
 * время загрузки, а не в кадре первого появления вида. Наблюдаемое состояние
 * прогрев не меняет: тёплые корни стоят вне сцены (REND-11, REND-18) и
 * возвращаются `finish()`; не доехавший ассет остаётся ленивому пути
 * (ASSET-4).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { DecodedImage, ParticleEffectDocument, VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem, ParticlesSubsystem, type RenderContext } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
/** Слот 0 модели-фикстуры: путь, который прогрев ждёт перед компиляцией. */
const BASE_TEXTURE = 'tex/base.png';
const TORCH = 'vfx/torch.effect.json';
const BURST = 'vfx/burst.effect.json';

function image(): DecodedImage {
  return { width: 1, height: 1, format: 'rgba8', pixels: Uint8Array.from([1, 2, 3, 255]) };
}

/** Материалы, которыми нарисованы меши тёплого корня. */
function rootMaterials(root: THREE.Object3D): THREE.Material[] {
  const materials: THREE.Material[] = [];
  root.traverse((node) => {
    const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
    if (mesh.isMesh !== true || mesh.material === undefined) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.push(material);
    }
  });
  return materials;
}

function effectFixture(name: string): ParticleEffectDocument {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as ParticleEffectDocument;
}

/** Запись с контролем костей — детальный ярус (REND-5 → REND-20). */
function detailedManifest(): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        boneControls: { torso: { bone: 'Bone_Chest', maxYawDeg: 72, smoothing: 18 } },
      },
    },
  };
}

/** Запись без контроля костей — батчевый ярус по умолчанию (ASSET-13). */
function batchedManifest(): VisualManifest {
  return { entities: { Runner: { model: MODEL_ID } } };
}

function makeModelsRig(manifest: VisualManifest): {
  subsystem: ModelsSubsystem;
  ctx: RenderContext;
  assets: ReturnType<typeof makeAssets>;
} {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(manifest, { warn: () => {} });
  subsystem.init(ctx);
  return { subsystem, ctx, assets };
}

describe('прогрев подсистемы моделей (FOW-8, ASSET-12)', () => {
  it('детальный вид: образец строится вне сцены, монтаж после прогрева — без заглушки', async () => {
    const { subsystem, ctx, assets } = makeModelsRig(detailedManifest());
    const pending = subsystem.prewarm();
    // Прогрев сам запросил модель и ждёт исхода загрузки (ASSET-4).
    expect(assets.requests).toContainEqual({ kind: 'model', id: MODEL_ID });
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    // Первая ступень — один образец детального вида, ВНЕ сцены: в кадр прогрев
    // не входит.
    expect(warm.roots.length).toBe(1);
    for (const root of warm.roots) expect(root.parent).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
    warm.finish();

    // Первое появление вида монтирует модель СРАЗУ: разделяемая часть уже в
    // кэше, и заглушка (ASSET-4) не строится вовсе — ей нечего пережидать.
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const instance = subsystem.instanceFor(1)!;
    expect(instance.model).not.toBeNull();
    expect(instance.placeholder).toBe(false);
  });

  it('первая ступень не ждёт текстур: застрявший слот не отменяет батчи и VAT', async () => {
    // Модель для батчевого вида доехала, текстура слота детального — нет и
    // никогда не доедет (ASSET-4 разрешает `loading` неограниченно). Прогрев
    // обязан отдать всё, чему хватило моделей.
    const manifest: VisualManifest = {
      ...batchedManifest(),
      decorations: {
        Statue: { model: MODEL_ID, tier: 'detailed' },
      },
    };
    const { subsystem, assets } = makeModelsRig(manifest);
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    // Первая ступень разрешилась, хотя текстура слота так и стоит в `loading`.
    expect(subsystem.batchMeshes().length).toBeGreaterThan(0);
    expect(warm.textures.length).toBe(1); // VAT-текстура батча — на месте
    expect(warm.roots.length).toBe(2); // батч-группа и образец декорации

    // А вторая — ждёт: её вход ещё не приехал, и это её дело, не общее.
    const settled = await Promise.race([
      warm.anchoredRoots().then(() => 'вторая ступень'),
      Promise.resolve('ещё ждёт'),
    ]);
    expect(settled).toBe('ещё ждёт');
    warm.finish();
  });

  it('вторая ступень: прогреваются ОБА варианта материала — и прозрачный тоже (FOW-8)', async () => {
    const { subsystem, assets } = makeModelsRig(detailedManifest());
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    // Вторая ступень ждёт СВОИХ текстур (REND-6): наличие карты входит в ключ
    // программы, и компилировать якорь до её приезда бессмысленно.
    assets.resolve('texture', BASE_TEXTURE, image());
    const anchored = await warm.anchoredRoots();
    expect(assets.requests).toContainEqual({ kind: 'texture', id: BASE_TEXTURE });

    // Прозрачность — бит ключа программы three: у копии, которой идёт угасание,
    // программа ДРУГАЯ, и компилировать её обязан прогрев, а не кадр открытия
    // обзора. Поэтому у вида сущности образца два — по варианту на каждый.
    expect(anchored.length).toBe(2);
    const variants = anchored.map((root) => rootMaterials(root).every((m) => m.transparent));
    expect(variants).toContain(true);
    expect(variants).toContain(false);

    // Карта слота стоит в ОБОИХ вариантах: пустой слот — тоже другая программа,
    // и якорь без текстуры прогрел бы то, чем матч не рисует (REND-6).
    const anchors = anchored.flatMap((root) => rootMaterials(root));
    for (const anchor of anchors) expect((anchor as THREE.MeshStandardMaterial).map).not.toBeNull();

    // Снос образцов якорей НЕ трогает: пока материал жив, three держит его
    // программу (`usedTimes` ≥ 1) — в этом вся страховка прогрева.
    const disposed = anchors.map((anchor) => vi.spyOn(anchor, 'dispose'));
    warm.finish();
    for (const spy of disposed) expect(spy).not.toHaveBeenCalled();

    // Отдаются якоря сносом подсистемы, вместе с ассетом, которому принадлежат
    // их оригиналы (REND-31).
    subsystem.dispose();
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('detailed-декорация прозрачного варианта не получает: она не угасает (REND-18)', async () => {
    const manifest: VisualManifest = {
      entities: {},
      decorations: { Statue: { model: MODEL_ID, tier: 'detailed' } },
    };
    const { subsystem, assets } = makeModelsRig(manifest);
    const pending = subsystem.prewarm();
    assets.resolve('texture', BASE_TEXTURE, image());
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    // Один образец, и тот непрозрачный: у decoration доля проявленности всегда
    // единица, и прозрачную программу не нарисует ни один кадр — компилировать
    // её во время загрузки и держать её материалы всю сессию не за что.
    const anchored = await warm.anchoredRoots();
    expect(anchored.length).toBe(1);
    expect(rootMaterials(anchored[0]!).some((material) => material.transparent)).toBe(false);
    warm.finish();
  });

  it('вторая ступень после `finish` ничего не строит: сносить это было бы уже нечем', async () => {
    const { subsystem, assets } = makeModelsRig(detailedManifest());
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    const anchored = warm.anchoredRoots();
    warm.finish(); // прогрев свёрнут, пока текстура ещё в пути
    assets.resolve('texture', BASE_TEXTURE, image());
    expect(await anchored).toEqual([]);
  });

  it('две записи одной модели с разной занятостью слотов греются каждая своим набором', async () => {
    // Модель сама слот 0 ничем не занимает (`textureSlots` пуст), но её материал
    // на него ссылается. Запись `Bare` рисуется без карты, запись `Painted`
    // занимает слот скином (REND-6) — программы у них РАЗНЫЕ, и один набор
    // якорей на модель грел бы только одну из двух.
    const manifest: VisualManifest = {
      entities: {
        Bare: { model: MODEL_ID, boneControls: { torso: { bone: 'Bone_Chest', maxYawDeg: 72, smoothing: 18 } } },
        Painted: {
          model: MODEL_ID,
          boneControls: { torso: { bone: 'Bone_Chest', maxYawDeg: 72, smoothing: 18 } },
          defaultSkin: 'paint',
          skins: { paint: { '0': 'tex/paint.png' } },
        },
      },
    };
    const { subsystem, assets } = makeModelsRig(manifest);
    const pending = subsystem.prewarm();
    assets.resolve('texture', 'tex/paint.png', image());
    assets.resolve('model', MODEL_ID, { ...makeModel(), textureSlots: [] });
    const warm = await pending;

    // Четыре образца второй ступени: по паре вариантов на запись.
    const anchored = await warm.anchoredRoots();
    expect(anchored.length).toBe(4);
    const faded = anchored
      .flatMap((root) => rootMaterials(root))
      .filter((material) => material.transparent)
      .map((material) => (material as THREE.MeshStandardMaterial).map !== null);
    // Прогреты ОБЕ занятости: и «слот пуст», и «слот занят».
    expect(faded).toContain(true);
    expect(faded).toContain(false);
    warm.finish();
  });

  it('батчевый вид: батч и VAT-текстура построены прогревом, а не первым появлением', async () => {
    const { subsystem, ctx, assets } = makeModelsRig(batchedManifest());
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    // Батч записи существует до единственного инстанса (REND-20), его группа —
    // тёплый корень вне сцены, VAT-текстура — вход `initTexture`.
    expect(subsystem.batchMeshes().length).toBeGreaterThan(0);
    expect(warm.roots.length).toBe(1);
    expect(warm.textures.length).toBe(1);
    expect(ctx.scene.children.length).toBe(0);

    // Гонка прогрева: запись привязалась, ПОКА группа стояла в тёплой сцене, —
    // свою точку входа в сцену (`attachBatched`) она пропустила, и группу
    // возвращает `finish()`: батч с живой записью обязан рисоваться.
    const warmScene = new THREE.Scene();
    for (const root of warm.roots) warmScene.add(root);
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    expect(warm.roots[0]!.parent).toBe(warmScene);
    warm.finish();
    expect(warm.roots[0]!.parent).toBe(ctx.scene);
  });

  it('не доехавшая модель прогрев не держит: ленивый путь с заглушкой как был', async () => {
    const { subsystem, assets } = makeModelsRig(detailedManifest());
    const pending = subsystem.prewarm();
    assets.fail('model', MODEL_ID, 'нет файла');
    const warm = await pending;
    expect(warm.roots.length).toBe(0);
    warm.finish();

    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    expect(subsystem.instanceFor(1)!.placeholder).toBe(true);
  });
});

describe('прогрев подсистемы частиц (FOW-8, REND-24)', () => {
  function makeParticlesRig(): {
    subsystem: ParticlesSubsystem;
    assets: ReturnType<typeof makeAssets>;
  } {
    const manifest: VisualManifest = {
      entities: {},
      decorations: { Torch: { effect: TORCH } },
      particles: {
        byKind: { Fireball: { effect: TORCH } },
        byEvent: { FireballExploded: { effect: BURST } },
      },
    };
    const assets = makeAssets();
    const subsystem = new ParticlesSubsystem(manifest, { warn: () => {} });
    subsystem.init({ scene: new THREE.Scene(), assets: assets.service, config: { heightStep: 0.5 } });
    return { subsystem, assets };
  }

  it('каждый эффект манифеста развёрнут и получил пул-экземпляр, не сыграв ни кадра', async () => {
    const { subsystem, assets } = makeParticlesRig();
    const pending = subsystem.prewarm();
    assets.resolve('particle-effect', TORCH, effectFixture('torch.effect.json'));
    assets.resolve('particle-effect', BURST, effectFixture('burst.effect.json'));
    await pending;

    // Развёртка, клон и батч конвейера созданы; играть ничего не начало.
    expect(subsystem.pooledCount).toBe(2); // TORCH и BURST — по экземпляру
    expect(subsystem.batchCount).toBeGreaterThan(0);
    expect(subsystem.activeCount).toBe(0);
    expect(subsystem.particleCount).toBe(0);

    // Первое появление эмиттера берёт прогретый экземпляр из пула — клона нет.
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.pooledCount).toBe(2);
  });

  it('не доехавший документ прогрев не держит и записи не ломает (ASSET-4)', async () => {
    const { subsystem, assets } = makeParticlesRig();
    const pending = subsystem.prewarm();
    assets.resolve('particle-effect', TORCH, effectFixture('torch.effect.json'));
    assets.fail('particle-effect', BURST, 'нет файла');
    await pending;
    expect(subsystem.pooledCount).toBe(1); // только доехавший TORCH
  });
});
