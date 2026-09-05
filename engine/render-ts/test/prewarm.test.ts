/**
 * Точка прогрева подсистемы (REND-45): всплеск открытия обзора (FOW-8)
 * монтирует уже построенное — модели, батчи, эффекты частиц и квад пост-прохода
 * тумана строятся во время загрузки, а не в кадре первого появления вида.
 *
 * Форма результата у всех подсистем ОДНА (REND-45): ступень `first` — из того,
 * что уже есть, `settled` — по доезду входов, которых первой недоставало,
 * `finish` — возврат тёплого владельцу. Проверяется здесь, что каждая подсистема
 * отдаёт своё в правильном списке ступени (мировые корни против экранных) и что
 * наблюдаемое состояние прогрев не меняет: тёплые корни стоят вне сцены
 * (REND-11, REND-18) и возвращаются `finish()`; не доехавший ассет остаётся
 * ленивому пути (ASSET-4).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { DecodedImage, ParticleEffectDocument, VisualManifest } from '@fluxus/assets';
import {
  EffectsSubsystem,
  FogSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  createCostCounters,
  createFootprint,
  footprintLive,
  withCostSink,
  withFootprintSink,
  type RenderContext,
  type RenderCostCounters,
} from '../src/index.js';
import {
  flatGrid,
  makeAssets,
  makeEntityView,
  makeModel,
  makeRenderContext,
  makeTickView,
} from './fixtures.js';

/** Имена статов тумана — вход подсистемы, объявляемый сборкой (FOW-9). */
const FOG_STATS = { visionRadius: 'vision', team: 'team' } as const;

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
    // не входит. Экранных корней у моделей нет: в мир они и рисуются (REND-45).
    expect(warm.first.roots.length).toBe(1);
    expect(warm.first.screenRoots).toHaveLength(0);
    for (const root of warm.first.roots) expect(root.parent).toBeNull();
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
    expect(warm.first.textures.length).toBe(1); // VAT-текстура батча — на месте
    expect(warm.first.roots.length).toBe(2); // батч-группа и образец декорации

    // А вторая — ждёт: её вход ещё не приехал, и это её дело, не общее
    // (REND-45, сценарий «Две ступени моделей»).
    const settled = await Promise.race([
      warm.settled.then(() => 'вторая ступень'),
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
    const anchored = (await warm.settled).roots;
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
    const anchored = (await warm.settled).roots;
    expect(anchored.length).toBe(1);
    expect(rootMaterials(anchored[0]!).some((material) => material.transparent)).toBe(false);
    warm.finish();
  });

  it('вторая ступень после `finish` ничего не строит: сносить это было бы уже нечем', async () => {
    const { subsystem, assets } = makeModelsRig(detailedManifest());
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    warm.finish(); // прогрев свёрнут, пока текстура ещё в пути
    assets.resolve('texture', BASE_TEXTURE, image());
    expect((await warm.settled).roots).toEqual([]);
  });

  it('`finish` на застрявшей второй ступени возвращает батч в сцену и идемпотентен', async () => {
    // Так стадию сворачивает таймаут (`game-boot` BOOT-4): текстура скина
    // вправе стоять в `loading` неограниченно (ASSET-4), а батч, к которому за
    // время прогрева привязалась живая запись, обязан вернуться в сцену кадра —
    // иначе её сущности не нарисуются за всю сессию.
    const { subsystem, ctx, assets } = makeModelsRig(batchedManifest());
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;
    const warmScene = new THREE.Scene();
    for (const root of warm.first.roots) warmScene.add(root);
    subsystem.syncTick(makeTickView([makeEntityView(1)]));

    warm.finish();
    expect(warm.first.roots[0]!.parent).toBe(ctx.scene);
    // Второй `finish` — no-op: сняв группу со сцены и вернув её обратно, он
    // сделал бы то же самое, но проверка избавляет от «сделал бы» вовсе.
    warm.finish();
    expect(warm.first.roots[0]!.parent).toBe(ctx.scene);
    expect(ctx.scene.children.filter((child) => child === warm.first.roots[0])).toHaveLength(1);
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
    const anchored = (await warm.settled).roots;
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
    expect(warm.first.roots.length).toBe(1);
    expect(warm.first.textures.length).toBe(1);
    expect(ctx.scene.children.length).toBe(0);

    // Гонка прогрева: запись привязалась, ПОКА группа стояла в тёплой сцене, —
    // свою точку входа в сцену (`attachBatched`) она пропустила, и группу
    // возвращает `finish()`: батч с живой записью обязан рисоваться.
    const warmScene = new THREE.Scene();
    for (const root of warm.first.roots) warmScene.add(root);
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    expect(warm.first.roots[0]!.parent).toBe(warmScene);
    warm.finish();
    expect(warm.first.roots[0]!.parent).toBe(ctx.scene);
  });

  it('прогретый батч несёт программу С КАНАЛОМ ТИНТА, если запись его объявила (REND-40)', async () => {
    // Маска команд-цвета входит в ключ программы материала батча (ASSET-18):
    // не грей прогрев эту программу — первый же покрашенный инстанс
    // компилировал бы шейдер прямо в кадре открытия обзора, ровно тем всплеском,
    // ради которого прогрев и заведён (FOW-8).
    const manifest: VisualManifest = { entities: { Runner: { model: MODEL_ID, tint: {} } } };
    const { subsystem, assets } = makeModelsRig(manifest);
    const pending = subsystem.prewarm();
    assets.resolve('model', MODEL_ID, makeModel());
    const warm = await pending;

    const keys = subsystem
      .batchMeshes()
      .map((mesh) => (mesh.material as THREE.Material).customProgramCacheKey());
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.endsWith(':tint'))).toBe(true);
    warm.finish();

    // Живая запись рисуется ТЕМИ ЖЕ материалами, а не вторым их набором.
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const live = subsystem
      .batchMeshes()
      .map((mesh) => (mesh.material as THREE.Material).customProgramCacheKey());
    expect(live).toEqual(keys);
  });

  it('не доехавшая модель прогрев не держит: ленивый путь с заглушкой как был', async () => {
    const { subsystem, assets } = makeModelsRig(detailedManifest());
    const pending = subsystem.prewarm();
    assets.fail('model', MODEL_ID, 'нет файла');
    const warm = await pending;
    expect(warm.first.roots.length).toBe(0);
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

  it('прогрев отдаёт текстуры образцов — вход `initTexture` (V-6)', async () => {
    // Заливка текстуры на GPU — работа ПЕРВОГО draw'а, и без этого списка она
    // ложится на кадр первого появления эмиттера. Документ без картинок —
    // законный случай: список тогда пуст, а обещание разрешается сразу.
    const { subsystem, assets } = makeParticlesRig();
    const pending = subsystem.prewarm();
    assets.resolve('particle-effect', TORCH, effectFixture('torch.effect.json'));
    assets.resolve('particle-effect', BURST, effectFixture('burst.effect.json'));
    const warm = await pending;

    expect(Array.isArray(warm.first.textures)).toBe(true);
    // Мировых корней частицы не отдают: образцы и батчи уже стоят в сцене
    // подсистемы и компилируются вместе с ней (REND-45).
    expect(warm.first.roots).toHaveLength(0);
    expect(warm.first.screenRoots).toHaveLength(0);
    // Вторая ступень разрешается и на документе без картинок: ждать её
    // собирающему безопасно.
    await expect(warm.settled).resolves.toBeDefined();
  });
});

describe('прогрев подсистемы транзиентных эффектов (REND-23)', () => {
  function makeEffectsRig(): { subsystem: EffectsSubsystem; scene: THREE.Scene } {
    const manifest: VisualManifest = {
      entities: {},
      effects: {
        byKind: { Fireball: { primitive: 'sphere', color: '#ff8a3c', radius: 0.2 } },
        byEvent: {
          FireballExploded: { primitive: 'sphere', color: '#ff4020', radius: 0.3, durationMs: 400 },
        },
      },
    };
    const scene = new THREE.Scene();
    const assets = makeAssets();
    const subsystem = new EffectsSubsystem(manifest, { warn: () => {} });
    subsystem.init({ scene, assets: assets.service, config: { heightStep: 0.5 } });
    return { subsystem, scene };
  }

  it('тёплый узел строится до первого кадра и возвращается в пул (V-6)', async () => {
    const { subsystem, scene } = makeEffectsRig();
    expect(subsystem.pooledCount).toBe(0);

    const warm = await subsystem.prewarm();

    // Узел один на ПРИМИТИВ: обе записи манифеста рисуются сферой, и программа
    // у них одна и та же.
    expect(warm.first.roots).toHaveLength(1);
    // Второй ступени у эффектов нет: ассетов у них нет и ждать нечего (REND-45).
    expect((await warm.settled).roots).toHaveLength(0);
    // Наблюдаемого состояния прогрев не меняет: нарисованных эффектов нет —
    // тёплый узел не оболочка и не вспышка, он просто существует.
    expect(subsystem.activeCount).toBe(0);

    warm.finish();
    // И после возврата в пул тоже: `finish` отдаёт узлы владельцу, а не рисует.
    expect(subsystem.activeCount).toBe(0);
    // Идемпотентность (REND-45): второй `finish` пул не удваивает.
    warm.finish();
    expect(subsystem.pooledCount).toBe(1);
    // Тёплый узел вернулся в пул — первая вспышка возьмёт ЕГО, а не заведёт
    // второй меш с новой программой.
    expect(subsystem.pooledCount).toBe(1);
    expect(scene.children.some((child) => child.name === 'effects')).toBe(true);
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Fireball' })]));
    expect(subsystem.activeCount).toBe(1);
    expect(subsystem.pooledCount).toBe(1);
  });

  it('греется по узлу на КАЖДЫЙ примитив манифеста, а не только на сферу', async () => {
    // Наземная фигура, луч и лента несут свой материал (`vertexColors` — бит
    // ключа программы three) и свою сетку: прогрев обязан построить каждый,
    // иначе первая же зона урона компилирует программу в кадре боя (REND-43).
    const scene = new THREE.Scene();
    const assets = makeAssets();
    const subsystem = new EffectsSubsystem(
      {
        entities: {},
        effects: {
          byKind: {
            Ball: { primitive: 'sphere', color: '#fff', radius: 1 },
            Zone: { primitive: 'disc', color: '#fff', radius: 2 },
            Link: { primitive: 'beam', color: '#fff', width: 0.3 },
          },
          byState: { Rush: { primitive: 'ribbon', color: '#fff', width: 0.3 } },
        },
      },
      { warn: () => {} },
    );
    subsystem.init({ scene, assets: assets.service, config: { heightStep: 1 } });

    const warm = await subsystem.prewarm();

    expect(warm.first.roots).toHaveLength(4);
    warm.finish();
    expect(subsystem.pooledCount).toBe(4);
  });

  it('неизвестный примитив прогрев не роняет: предупреждение и пропуск', async () => {
    const scene = new THREE.Scene();
    const assets = makeAssets();
    const warnings: string[] = [];
    const subsystem = new EffectsSubsystem(
      {
        entities: {},
        effects: { byKind: { Ghost: { primitive: 'cube', color: '#fff', radius: 1 } } },
      },
      { warn: (m) => warnings.push(m) },
    );
    subsystem.init({ scene, assets: assets.service, config: { heightStep: 1 } });

    const warm = await subsystem.prewarm();

    expect(warm.first.roots).toHaveLength(0);
    expect(warnings.join('\n')).toContain('cube');
  });
});

describe('точка прогрева подсистемы тумана (REND-45, FOW-7)', () => {
  it('пост-проход едет ЭКРАННЫМ корнем, мировых у тумана нет (сценарий «Экранный корень тумана»)', async () => {
    const fog = new FogSubsystem({ grid: flatGrid(), stats: FOG_STATS, hero: () => null });
    fog.init(makeRenderContext());

    const warm = await fog.prewarm();

    // Полноэкранный квад рисует НА КАНВАС и сам (FOW-7): компилировать его под
    // цель кадра значило бы собрать программу, которой не нарисован ни один
    // кадр, — цель входит в ключ программы three.
    expect(warm.first.screenRoots).toEqual([fog.postPass.scene]);
    expect(warm.first.roots).toHaveLength(0);
    expect(warm.first.textures).toHaveLength(0);
    // Ступень одна: маска подъезжает готовой текстурой и ключа не меняет.
    expect(await warm.settled).toEqual({ roots: [], screenRoots: [], textures: [] });
    // Возвращать нечего — квад своей сцены не покидал: `finish` идемпотентен и
    // состава пост-прохода не трогает (REND-45).
    warm.finish();
    warm.finish();
    expect(fog.postPass.scene.children).toHaveLength(1);
  });
});


// ---------------------------- прогрев не меняет наблюдаемого (REND-45)

/**
 * Состав сцены кадра: тип и имя каждого узла в порядке обхода. Именно он и есть
 * «что нарисовано» глазами теста без живого WebGL — материалы и программы
 * меряет стенд (PERF-7), а сюда попадает то, что прогрев мог бы сдвинуть:
 * лишний корень, недовозвращённая группа, потерянный инстанс.
 */
function sceneShape(scene: THREE.Object3D): string[] {
  const out: string[] = [];
  scene.traverse((node) => {
    out.push(`${node.type}:${node.name}`);
  });
  return out;
}

/** Манифест обоих ярусов: батчевая сущность и детальная декорация (REND-20). */
function bothTiersManifest(): VisualManifest {
  return {
    entities: { Runner: { model: MODEL_ID } },
    decorations: { Statue: { model: MODEL_ID, tier: 'detailed' } },
    effects: { byKind: { Runner: { primitive: 'sphere', color: '#fff', radius: 0.2 } } },
  };
}

describe('прогрев не меняет наблюдаемого состояния (REND-45)', () => {
  /**
   * Один и тот же прогон: подсистемы, доставка, кадр. Разница между стендами
   * ровно одна — прогрев со своим `finish` между сборкой и первой доставкой.
   */
  async function run(warmed: boolean): Promise<{
    shape: string[];
    counters: RenderCostCounters;
    live: Record<string, Record<string, number>>;
  }> {
    const footprint = createFootprint();
    const counters = createCostCounters();
    const scene = new THREE.Scene();
    const assets = makeAssets();
    const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
    const models = new ModelsSubsystem(bothTiersManifest(), { warn: () => {} });
    const effects = new EffectsSubsystem(bothTiersManifest(), { warn: () => {} });
    let shape: string[] = [];
    await withFootprintSink(footprint, async () => {
      models.init(ctx);
      effects.init(ctx);
      assets.resolve('model', MODEL_ID, makeModel());
      assets.resolve('texture', BASE_TEXTURE, image());
      if (warmed) {
        const warm = await Promise.all([models.prewarm(), effects.prewarm()]);
        // Тёплая сцена сборки — своя, как у демо: в кадр тёплые корни не входят.
        const warmScene = new THREE.Scene();
        for (const stage of warm) {
          for (const root of [...stage.first.roots, ...(await stage.settled).roots]) {
            warmScene.add(root);
          }
        }
        for (const stage of warm) stage.finish();
      }
      withCostSink(counters, () => {
        const view = makeTickView([makeEntityView(1, { kind: 'Runner' })]);
        models.syncTick(view);
        effects.syncTick(view);
        models.updateFrame(0.016, 1);
        effects.updateFrame(0.016, 1);
      });
      shape = sceneShape(scene);
      models.dispose();
      effects.dispose();
    });
    return { shape, counters, live: footprintLive(footprint) };
  }

  it('состав кадра и счётчики стоимости — те же, что без прогрева (сценарий «Прогрев и кадр»)', async () => {
    const warm = await run(true);
    const cold = await run(false);

    // Прогрев меняет не то, ЧТО нарисовано, а лишь момент, когда первое
    // появление вида перестаёт платить в кадре: состав сцены совпадает узел в
    // узел.
    expect(warm.shape).toEqual(cold.shape);
    // И счётных величин стоимости (PERF-3) прогрев не двигает: он живёт во
    // времени загрузки, а счётчики меряют доставку и кадр.
    expect(warm.counters).toEqual(cold.counters);
  });

  it('после сноса живых ресурсов прогрева ноль (REND-31, PERF-9)', async () => {
    const warm = await run(true);
    // Якоря программ (FOW-8) прогрев держит до сноса ассета — и отдаёт вместе с
    // ним: непогашенный якорь пережил бы подсистему, которой принадлежит.
    for (const owner of ['models', 'effects']) {
      for (const [kind, count] of Object.entries(warm.live[owner] ?? {})) {
        expect(count, `${owner}.${kind} после сноса`).toBe(0);
      }
    }
  });
});
