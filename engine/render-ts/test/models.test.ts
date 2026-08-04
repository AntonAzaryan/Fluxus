/**
 * Подсистема моделей: пул инстансов по снапшоту (REND-3), заглушки на время
 * загрузки и при отсутствии записи в манифесте (ASSET-4, ASSET-6), скины
 * пер-инстанс (REND-6), смерть по событию (REND-4), интерполяция позиции.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ModelsSubsystem, type RenderContext } from '../src/index.js';
import type { VisualManifest } from '@game-mvp/assets';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

function makeManifest(): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        defaultSkin: 'red',
        skins: {
          red: { '0': 'tex/red.png' },
          blue: { '0': 'tex/blue.png' },
        },
        animations: {
          states: { idle: 'Stand', move: 'Walk' },
          events: { CastFireball: 'Attack', EntityDied: 'Death' },
        },
        boneControls: {
          torso: { bone: 'Bone_Chest', maxYawDeg: 72, smoothing: 18 },
        },
      },
    },
  };
}

function makeRig(): {
  subsystem: ModelsSubsystem;
  ctx: RenderContext;
  assets: AssetsStub;
  warnings: string[];
} {
  const assets = makeAssets();
  const warnings: string[] = [];
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(makeManifest(), {
    warn: (message) => warnings.push(message),
  });
  subsystem.init(ctx);
  return { subsystem, ctx, assets, warnings };
}

describe('пул инстансов по снапшоту (REND-3)', () => {
  it('появление сущности создаёт инстанс (сначала заглушку), исчезновение — убирает', () => {
    const { subsystem, ctx, assets } = makeRig();

    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    expect(ctx.scene.children.length).toBe(1); // holder сущности
    expect(assets.requests).toContainEqual({ kind: 'model', id: MODEL_ID });
    const holder = subsystem.instanceFor(1)!.holder;
    expect(holder.children.length).toBe(1); // заглушка на время загрузки (ASSET-4)
    expect(subsystem.instanceFor(1)!.model).toBeNull();

    subsystem.syncTick(makeTickView([])); // сущность исчезла
    expect(subsystem.instanceFor(1)).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
  });

  it('готовый ассет подменяет заглушку; геометрия разделяется между инстансами', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    // Одна модель — один запрос ассета на двоих (ASSET-2 на стороне рендера).
    expect(assets.requests.filter((request) => request.kind === 'model').length).toBe(1);

    assets.resolve('model', MODEL_ID, makeModel());
    const a = subsystem.instanceFor(1)!.model!;
    const b = subsystem.instanceFor(2)!.model!;
    expect(a).not.toBeNull();
    expect(a.meshes[0]!.geometry).toBe(b.meshes[0]!.geometry); // общие буферы
    expect(a.skeleton).not.toBe(b.skeleton); // скелет свой на инстанс
    expect(a.materialsBySlot.get(0)).not.toBe(b.materialsBySlot.get(0));
  });

  it('сущность без записи в манифесте — заглушка и предупреждение один раз (ASSET-6)', () => {
    const { subsystem, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' })]));
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' }), makeEntityView(2, { kind: 'Ghost' })]));
    expect(warnings.filter((message) => message.includes('Ghost')).length).toBe(1);
    expect(subsystem.instanceFor(1)!.holder.children.length).toBe(1); // заглушка
    expect(subsystem.instanceFor(1)!.model).toBeNull();
  });

  it('kind === null — сущность не рисуется и не шумит', () => {
    const { subsystem, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: null })]));
    expect(subsystem.instanceFor(1)!.holder.children.length).toBe(0);
    expect(warnings.length).toBe(0);
  });
});

describe('скины пер-инстанс (REND-6)', () => {
  it('скин по умолчанию запрашивает подмену слота; смена скина не трогает соседа', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());

    // defaultSkin 'red': подмена слота 0 перекрывает базовый путь модели.
    const redRequests = assets.requests.filter((request) => request.id === 'tex/red.png');
    expect(redRequests.length).toBe(2); // по одному на инстанс
    expect(assets.requests.some((request) => request.id === 'tex/base.png')).toBe(false);

    subsystem.setSkin(1, 'blue');
    const blueRequests = assets.requests.filter((request) => request.id === 'tex/blue.png');
    expect(blueRequests.length).toBe(1); // только перекрашенный инстанс
  });
});

describe('анимации по данным тика (REND-4)', () => {
  it('idle/move из скорости и one-shot по событию каста', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;
    expect(controller.currentClipName).toBe('Stand - 1');

    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    expect(controller.currentClipName).toBe('Walk Fast');

    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true })], {
        freshEvents: true,
        events: [{ type: 'CastFireball', data: { entity: 1 } }],
      }),
    );
    expect(controller.currentClipName).toBe('Attack - 1');
  });

  it('EntityDied — смерть с фиксацией кадра; на replay события не переигрываются (OBS-5)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;

    // Replay-тик: freshEvents false — событие игнорируется.
    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: false,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    expect(controller.isDead).toBe(false);

    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
  });
});

describe('покадровое обновление (REND-2, REND-5)', () => {
  it('позиция интерполируется по альфе, уровень поднимает на heightStep', () => {
    const { subsystem } = makeRig();
    const view = makeEntityView(1, {
      prevX: 0,
      currX: 1,
      prevY: 0,
      currY: 0,
      prevLevel: 1,
      currLevel: 1,
    });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(0.016, 0.5);
    const holder = subsystem.instanceFor(1)!.holder;
    expect(holder.position.x).toBeCloseTo(0.5, 6);
    expect(holder.position.z).toBeCloseTo(0.5, 6); // уровень 1 × heightStep 0.5

    // snap-тик рисуется без интерполяции.
    view.snap = true;
    view.prevX = 5;
    view.currX = 5;
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(0.016, 0.25);
    expect(holder.position.x).toBeCloseTo(5, 6);
  });

  it('торс доворачивается к aimYaw после mixer.update (REND-5)', () => {
    const { subsystem, assets } = makeRig();
    const view = makeEntityView(1, { aimYaw: Math.PI / 2 });
    subsystem.syncTick(makeTickView([view]));
    assets.resolve('model', MODEL_ID, makeModel());

    const model = subsystem.instanceFor(1)!.model!;
    const chest = model.bonesByName.get('Bone_Chest')!;
    // Много кадров: сглаживание (smoothing 18) успевает довернуть до лимита.
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    const euler = new THREE.Euler().setFromQuaternion(chest.quaternion, 'ZYX');
    // Лимит манифеста 72°; клип Stand сам крутит кость, поэтому проверяем
    // только знак и заметность доворота, а не точный угол.
    expect(euler.z).toBeGreaterThan(0.3);
  });
});
