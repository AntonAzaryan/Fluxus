/**
 * Уровни детализации (REND-22): выбор уровня по экранному размеру, пороги из
 * записи манифеста (ASSET-13), устойчивость выбора у порога, сохранение
 * состояния записи при переключении и независимость picking'а от уровня.
 *
 * Цепочку уровней даёт МОДЕЛЬ (`assets` ASSET-12): децимации в запекании нет —
 * упрощение геометрии авторская работа. Поэтому фикстура несёт цепочку явно, а
 * модель без неё проверяется отдельно: её поведение обязано быть прежним.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { NormalizedMesh, NormalizedModel, VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem, createPickProxy, type RenderContext } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
/** Пороги записи (ASSET-13): доли высоты кадра, строго убывающие. */
const THRESHOLDS = [0.2, 0.05];

function makeManifest(thresholds: number[] = THRESHOLDS): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        animations: { states: { idle: 'Stand', move: 'Walk' } },
        lodThresholds: thresholds,
      },
    },
  };
}

/** Та же модель с цепочкой из двух упрощённых уровней (ASSET-12). */
function modelWithChain(): NormalizedModel {
  const base = makeModel();
  const mesh = base.meshes[0]!;
  const coarse = (): readonly NormalizedMesh[] => [{ ...mesh }];
  return { ...base, lodMeshes: [coarse(), coarse()] };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  readonly assets: AssetsStub;
  readonly camera: THREE.PerspectiveCamera;
  /** Ставит камеру на дистанцию `d` от начала координат и рисует кадр. */
  frameAt(distance: number): void;
}

function makeRig(manifest: VisualManifest = makeManifest()): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  const subsystem = new ModelsSubsystem(manifest, { warn: () => {}, camera });
  subsystem.init(ctx);
  return {
    subsystem,
    assets,
    camera,
    frameAt(distance: number): void {
      camera.position.set(-distance, 0, 0);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      subsystem.updateFrame(1 / 60, 1);
    },
  };
}

/** Дистанция, на которой инстанс впервые уходит на уровень `level`. */
function distanceForLevel(rig: Rig, level: number): number {
  for (let distance = 1; distance < 4000; distance *= 1.02) {
    rig.frameAt(distance);
    if (rig.subsystem.instanceFor(1)!.lodLevel >= level) return distance;
  }
  throw new Error(`уровень ${level} не достигнут`);
}

describe('выбор уровня по экранному размеру (REND-22)', () => {
  it('отъезд камеры переводит инстанс на более грубые уровни, наезд — обратно', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, modelWithChain());

    rig.frameAt(1);
    expect(rig.subsystem.instanceFor(1)!.lodLevel).toBe(0);

    rig.frameAt(1000);
    expect(rig.subsystem.instanceFor(1)!.lodLevel).toBe(2);

    rig.frameAt(1);
    expect(rig.subsystem.instanceFor(1)!.lodLevel).toBe(0);
  });

  it('пороги — данные записи, а не константа кода (ASSET-13)', () => {
    // Две записи на одну модель с порогами, различающимися на порядок: запись с
    // крупным порогом уходит на грубый уровень заметно раньше по дистанции.
    const place = (thresholds: number[]): Rig => {
      const rig = makeRig(makeManifest(thresholds));
      rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
      rig.assets.resolve('model', MODEL_ID, modelWithChain());
      return rig;
    };
    const early = distanceForLevel(place([0.2, 0.05]), 1);
    const late = distanceForLevel(place([0.02, 0.005]), 1);
    expect(late).toBeGreaterThan(early * 5);
  });

  it('колебание экранного размера у порога уровень не переключает', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, modelWithChain());

    const edge = distanceForLevel(rig, 1);
    const level = rig.subsystem.instanceFor(1)!.lodLevel;
    // Дрожание в проценте от дистанции — заведомо внутри зоны нечувствительности.
    for (const factor of [0.99, 1.01, 0.995, 1.005, 0.99, 1.01]) {
      rig.frameAt(edge * factor);
      expect(rig.subsystem.instanceFor(1)!.lodLevel).toBe(level);
    }
  });
});

describe('переключение уровня не трогает состояние записи (REND-22)', () => {
  it('инстанс тот же, фаза клипа и скин целы, объём-прокси не меняется', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    rig.assets.resolve('model', MODEL_ID, modelWithChain());

    rig.frameAt(1);
    const before = rig.subsystem.instanceFor(1)!;
    const clip = before.controller!.currentClipName;
    const near = createPickProxy();
    rig.subsystem.proxyOf(1, near);

    rig.frameAt(1000);
    const after = rig.subsystem.instanceFor(1)!;
    expect(after).toBe(before); // запись не пересоздана
    expect(after.lodLevel).toBe(2);
    expect(after.controller!.currentClipName).toBe(clip);
    // Записи батча столько же: переключение уровня — это выбор набора мешей,
    // а не новая запись.
    expect(rig.subsystem.batchStats().records).toBe(1);

    // Picking производен от границ МОДЕЛИ, а не от геометрии уровня (REND-15).
    const far = createPickProxy();
    rig.subsystem.proxyOf(1, far);
    expect(far.maxX).toBeCloseTo(near.maxX, 6);
    expect(far.minZ).toBeCloseTo(near.minZ, 6);
  });

  it('рисует ровно один уровень: инстанс не попадает сразу в два набора мешей', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, modelWithChain());
    rig.frameAt(1);

    const drawn = rig.subsystem.batchMeshes().filter((mesh) => mesh.count > 0);
    expect(drawn.length).toBe(1);
    expect(rig.subsystem.batchStats().drawnMeshes).toBe(1);
  });
});

describe('модель без цепочки уровней (REND-22)', () => {
  it('рисуется единственной геометрией на любой дистанции — поведение прежнее', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, makeModel());

    rig.frameAt(1);
    expect(rig.subsystem.instanceFor(1)!.lodLevel).toBe(0);
    rig.frameAt(2000);
    expect(rig.subsystem.instanceFor(1)!.lodLevel).toBe(0);
    // Мешей столько же, сколько частей у модели: слота уровня не появилось.
    expect(rig.subsystem.batchMeshes().length).toBe(1);
  });
});
