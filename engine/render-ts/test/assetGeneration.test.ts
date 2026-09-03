/**
 * Поколение ассетов (REND-1, REND-31): ре-экспорт модели по тому же адресу —
 * вход подсистемы, а не догадка.
 *
 * Кэш разделяемой части ключуется АДРЕСОМ модели (ASSET-2): при `--watch`
 * импортёра (`blender-pipeline` BLND-12) и при подмене сервиса ассетов
 * редактором адрес прежний, байты другие, и без объявленного входа вьюпорт
 * рисовал бы устаревшую модель до переоткрытия сцены (ED-15).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { NormalizedModel, VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem, type RenderContext } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

function makeManifest(): VisualManifest {
  return {
    entities: {
      // Детальный ярус назван явно: тест смотрит на построенное из ассета
      // поддерево, а не только на габариты (ASSET-13).
      Runner: { model: MODEL_ID, scale: 1, tier: 'detailed' },
      Keeper: { model: MODEL_ID, scale: 1 },
    },
  };
}

/** Модель того же адреса, но другой высоты: пересборку видно по габаритам. */
function taller(): NormalizedModel {
  return { ...makeModel(), height: 4 };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  /** Сервис ассетов, которым отвечает контекст сейчас (ED-12, ASSET-2). */
  assets: AssetsStub;
  readonly scene: THREE.Scene;
}

function makeRig(): Rig {
  const state = { assets: makeAssets() };
  const scene = new THREE.Scene();
  const ctx: RenderContext = {
    scene,
    // Сервис спрашивается на КАЖДОМ обращении — так его отдаёт и редактор:
    // модуль ассетов выбрасывает сервис целиком (ASSET-2).
    get assets() { return state.assets.service; },
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(makeManifest(), { warn: () => {} });
  subsystem.init(ctx);
  return {
    subsystem,
    get assets(): AssetsStub { return state.assets; },
    set assets(next: AssetsStub) { state.assets = next; },
    scene,
  };
}

describe('ModelsSubsystem.refreshAssets (REND-1, REND-31)', () => {
  it('перезапрашивает модель у нового сервиса и рисует её заново', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const before = rig.subsystem.instanceFor(1)!.bounds!;
    // Габарит инстанса нормализован по высоте модели: у фикстуры она 2.
    expect(before.maxX).toBeCloseTo(0.5, 6);

    // Ассет переэкспортирован: адрес тот же, байты другие, сервис новый.
    rig.assets = makeAssets();
    rig.subsystem.refreshAssets();
    expect(rig.assets.requests).toContainEqual({ kind: 'model', id: MODEL_ID });
    // Пока новый ассет едет, инстанс рисуется заглушкой (ASSET-4) — а не
    // поддеревом, построенным из выброшенных данных.
    expect(rig.subsystem.instanceFor(1)!.placeholder).toBe(true);

    rig.assets.resolve('model', MODEL_ID, taller());
    const after = rig.subsystem.instanceFor(1)!.bounds!;
    // Модель другая — и габарит инстанса другой: он производен от её высоты
    // (REND-3), а высота у переэкспортированной вдвое больше.
    expect(after.maxX).toBeCloseTo(0.25, 6);
    expect(rig.subsystem.instanceFor(1)!.model).not.toBeNull();
    // Инстанс тот же объект набора (REND-11): пересобрано построенное, а не он.
    expect(rig.scene.children.length).toBe(1);
  });

  it('батчевый ярус пересобирается тем же входом (REND-20)', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Keeper' })]));
    rig.assets.resolve('model', MODEL_ID, makeModel());
    expect(rig.subsystem.instanceFor(1)!.tier).toBe('batched');
    expect(rig.subsystem.batchStats().batches).toBe(1);
    const meshes = rig.subsystem.batchMeshes();
    const disposed = vi.spyOn(meshes[0]!.geometry, 'dispose');

    rig.assets = makeAssets();
    rig.subsystem.refreshAssets();
    // Батч производен от МОДЕЛИ (геометрия уровней, VAT-текстура, материалы) —
    // и уходит вместе с ней: держать его на прежних байтах нечем (REND-31).
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(rig.subsystem.batchStats().batches).toBe(0);

    rig.assets.resolve('model', MODEL_ID, taller());
    expect(rig.subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });
    expect(rig.subsystem.batchMeshes()[0]).not.toBe(meshes[0]);
  });

  it('отдаёт то, что построено из прежних данных (REND-31)', () => {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, makeModel());
    const model = rig.subsystem.instanceFor(1)!.model!;
    const geometry = vi.spyOn(model.meshes[0]!.geometry, 'dispose');

    rig.assets = makeAssets();
    rig.subsystem.refreshAssets();

    // Буферы прежнего ассета освобождены: держать их незачем — адрес теперь
    // отвечает другими байтами.
    expect(geometry).toHaveBeenCalledTimes(1);
  });

  it('декорации проходят тем же входом (REND-18)', () => {
    const rig = makeRig();
    rig.subsystem.syncDecorations(new Map([[1, makeEntityView(1)]]));
    rig.assets.resolve('model', MODEL_ID, makeModel());
    expect(rig.subsystem.instanceFor(1, true)!.model).not.toBeNull();

    rig.assets = makeAssets();
    rig.subsystem.refreshAssets();
    rig.assets.resolve('model', MODEL_ID, taller());

    expect(rig.subsystem.instanceFor(1, true)!.model).not.toBeNull();
  });
});
