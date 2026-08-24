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
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ParticleEffectDocument, VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem, ParticlesSubsystem, type RenderContext } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
const TORCH = 'vfx/torch.effect.json';
const BURST = 'vfx/burst.effect.json';

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

    // Образец детального вида стоит ВНЕ сцены: в кадр прогрев не входит.
    expect(warm.roots.length).toBe(1);
    expect(warm.roots[0]!.parent).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
    warm.finish();

    // Первое появление вида монтирует модель СРАЗУ: разделяемая часть уже в
    // кэше, и заглушка (ASSET-4) не строится вовсе — ей нечего пережидать.
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const instance = subsystem.instanceFor(1)!;
    expect(instance.model).not.toBeNull();
    expect(instance.placeholder).toBe(false);
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
