/**
 * Канал тинта инстанса (REND-40, ASSET-18): цвет команды, вспышка на событие и
 * маска команд-цвета — на обоих ярусах (REND-20).
 *
 * Батчевый ярус проверяется по ПУТИ ДАННЫХ — пер-инстансный атрибут и ключ
 * программы материала: сам GLSL компилируется только рендерером, и его в
 * headless-прогоне нет (известное ограничение `model/vatMaterial.ts`).
 * Детальный ярус проверяется по цвету материалов — там это и есть наблюдаемое.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { NormalizedModel, VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

/** Цвет записи в рабочем пространстве — тем же переводом, каким его берёт рендер. */
function working(hex: string): { r: number; g: number; b: number } {
  const color = new THREE.Color(hex);
  return { r: color.r, g: color.g, b: color.b };
}

/**
 * Модель с ДВУМЯ материалами: маска команд-цвета названа индексами материалов
 * (ASSET-18), и без второго материала маску не на чем показать. Части две —
 * по одной на материал, как у настоящей модели с отдельным «командным» куском.
 */
function twoMaterialModel(): NormalizedModel {
  const model = makeModel();
  const mesh = model.meshes[0]!;
  return {
    ...model,
    meshes: [mesh, { ...mesh, partId: 1, materialIndex: 1 }],
    materials: [model.materials[0]!, { ...model.materials[0]!, baseColorFactor: [1, 1, 1, 1] }],
  };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
}

function makeRig(manifest: VisualManifest, model: NormalizedModel = makeModel()): Rig {
  const assets = makeAssets();
  const subsystem = new ModelsSubsystem(manifest, { warn: () => {} });
  subsystem.init({
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  });
  assets.resolve('model', MODEL_ID, model);
  return { subsystem };
}

/** Инстанс-атрибут тинта первого меша батча: цвет и сила подряд. */
function tintAttribute(subsystem: ModelsSubsystem): Float32Array {
  const mesh = subsystem.batchMeshes()[0]!;
  return mesh.geometry.getAttribute('instanceTint').array as Float32Array;
}

// --------------------------------------------------------------- батчевый

describe('тинт батчевого яруса — пер-инстансный атрибут (REND-40)', () => {
  function batchedManifest(tint: Record<string, unknown> = {}): VisualManifest {
    return { entities: { Runner: { model: MODEL_ID, tint } } };
  }

  it('порт «цвет на сущность» доезжает до атрибута записи', () => {
    const { subsystem } = makeRig(batchedManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const red = working('#ff0000');

    expect(subsystem.setTint(1, { ...red, strength: 0.5 })).toBe(true);
    subsystem.updateFrame(1 / 60, 1);

    const attribute = tintAttribute(subsystem);
    expect(attribute[0]).toBeCloseTo(red.r, 5);
    expect(attribute[1]).toBeCloseTo(red.g, 5);
    expect(attribute[2]).toBeCloseTo(red.b, 5);
    expect(attribute[3]).toBeCloseTo(0.5, 5);
  });

  it('инстанс без тинта несёт единичный множитель', () => {
    const { subsystem } = makeRig(batchedManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.updateFrame(1 / 60, 1);
    // Сила ноль: цвет фрагмента умножается на единицу, то есть не меняется.
    expect([...tintAttribute(subsystem).slice(0, 4)]).toEqual([1, 1, 1, 0]);
  });

  it('снятый тинт возвращает единичный множитель', () => {
    const { subsystem } = makeRig(batchedManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.setTint(1, { ...working('#00ff00'), strength: 1 });
    subsystem.updateFrame(1 / 60, 1);
    expect(tintAttribute(subsystem)[3]).toBeCloseTo(1, 5);

    subsystem.setTint(1, null);
    subsystem.updateFrame(1 / 60, 1);
    expect(tintAttribute(subsystem)[3]).toBeCloseTo(0, 5);
  });

  it('маска команд-цвета входит в ключ программы материала батча (ASSET-18)', () => {
    // Один вид с маской по материалу 1, другой без блока тинта вовсе.
    const manifest: VisualManifest = {
      entities: {
        Runner: { model: MODEL_ID, tint: { materials: [1] } },
        Plain: { model: MODEL_ID },
      },
    };
    const { subsystem } = makeRig(manifest, twoMaterialModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Runner' }), makeEntityView(2, { kind: 'Plain' })]),
    );
    subsystem.updateFrame(1 / 60, 1);

    const keys = subsystem
      .batchMeshes()
      .map((mesh) => (mesh.material as THREE.Material).customProgramCacheKey());
    // Материал 1 записи с маской читает канал, материал 0 — нет; у записи без
    // блока канала нет ни в одном материале.
    expect(keys.filter((key) => key.endsWith(':tint'))).toHaveLength(1);
    expect(keys.filter((key) => !key.endsWith(':tint'))).toHaveLength(3);
  });

  it('запись без блока тинта канала не имеет — порт её атрибута не трогает', () => {
    const manifest: VisualManifest = { entities: { Runner: { model: MODEL_ID } } };
    const { subsystem } = makeRig(manifest);
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.setTint(1, { ...working('#ff0000'), strength: 1 });
    subsystem.updateFrame(1 / 60, 1);
    expect([...tintAttribute(subsystem).slice(0, 4)]).toEqual([1, 1, 1, 0]);
  });

  it('виды одной модели с разными масками не делят батч (REND-20)', () => {
    const manifest: VisualManifest = {
      entities: {
        Runner: { model: MODEL_ID, tint: { materials: [1] } },
        Other: { model: MODEL_ID, tint: { materials: [0] } },
      },
    };
    const { subsystem } = makeRig(manifest, twoMaterialModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { kind: 'Runner' }), makeEntityView(2, { kind: 'Other' })]),
    );
    expect(subsystem.batchStats().batches).toBe(2);
  });
});

// -------------------------------------------------------------- детальный

describe('тинт детального яруса — цвет своих материалов (REND-40, REND-6)', () => {
  function detailedManifest(tint: Record<string, unknown> = {}): VisualManifest {
    return { entities: { Runner: { model: MODEL_ID, tier: 'detailed', tint } } };
  }

  it('множитель кладётся в цвет материала, а базовый цвет не теряется', () => {
    const { subsystem } = makeRig(detailedManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const material = subsystem.instanceFor(1)!.model!.materials[0]!;
    const base = material.color.clone();

    subsystem.setTint(1, { r: 1, g: 0, b: 0, strength: 1 });
    subsystem.updateFrame(1 / 60, 1);
    // Сила единица: множителем стал сам цвет — синий и зелёный погашены.
    expect(subsystem.instanceFor(1)!.model!.materials[0]!.color.g).toBeCloseTo(0, 6);

    subsystem.setTint(1, null);
    subsystem.updateFrame(1 / 60, 1);
    const after = subsystem.instanceFor(1)!.model!.materials[0]!.color;
    expect(after.r).toBeCloseTo(base.r, 6);
    expect(after.g).toBeCloseTo(base.g, 6);
    expect(after.b).toBeCloseTo(base.b, 6);
  });

  it('покраска переводит материалы в собственные — соседи не окрашены (REND-6)', () => {
    const { subsystem } = makeRig(detailedManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    const neighbour = subsystem.instanceFor(2)!.model!.materials[0]!;
    const before = neighbour.color.clone();

    subsystem.setTint(1, { r: 1, g: 0, b: 0, strength: 1 });
    subsystem.updateFrame(1 / 60, 1);

    expect(subsystem.instanceFor(1)!.model!.ownsMaterials).toBe(true);
    // Сосед рисуется прежним цветом: копию завёл только окрашенный инстанс.
    expect(subsystem.instanceFor(2)!.model!.materials[0]!.color.g).toBeCloseTo(before.g, 6);
  });

  it('маска красит названные материалы и не трогает прочие (ASSET-18)', () => {
    const { subsystem } = makeRig(detailedManifest({ materials: [1] }), twoMaterialModel());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const model = subsystem.instanceFor(1)!.model!;
    const untinted = model.materials[0]!.color.clone();

    subsystem.setTint(1, { r: 0, g: 0, b: 1, strength: 1 });
    subsystem.updateFrame(1 / 60, 1);

    const after = subsystem.instanceFor(1)!.model!;
    expect(after.materials[1]!.color.r).toBeCloseTo(0, 6);
    expect(after.materials[0]!.color.r).toBeCloseTo(untinted.r, 6);
  });

  it('запись без блока тинта не переводит материалы в собственные', () => {
    const manifest: VisualManifest = {
      entities: { Runner: { model: MODEL_ID, tier: 'detailed' } },
    };
    const { subsystem } = makeRig(manifest);
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.setTint(1, { r: 1, g: 0, b: 0, strength: 1 });
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.model!.ownsMaterials).toBe(false);
  });
});

// ---------------------------------------------------------------- вспышка

describe('вспышка тинта по событию доставки (REND-40, ASSET-18)', () => {
  const FLASH = { color: '#ffffff', strength: 1, seconds: 0.4 };

  function flashRig(base: { r: number; g: number; b: number; strength: number } | null): Rig {
    const manifest: VisualManifest = {
      entities: { Runner: { model: MODEL_ID, tint: { byEvent: { Damaged: FLASH } } } },
    };
    const rig = makeRig(manifest);
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    if (base !== null) rig.subsystem.setTint(1, base);
    return rig;
  }

  /** Доставка с событием: `freshEvents` — то, чем подсистема отличает переигровку. */
  function damageTick(): ReturnType<typeof makeTickView> {
    return makeTickView([makeEntityView(1)], {
      events: [{ type: 'Damaged', data: { entity: 1 } }],
      freshEvents: true,
    });
  }

  it('зажигается событием и спадает к базе по своей длительности', () => {
    const { subsystem } = flashRig({ r: 1, g: 0, b: 0, strength: 0.4 });
    subsystem.syncTick(damageTick());

    // Первый кадр после события: вспышка почти полная.
    subsystem.updateFrame(0.01, 1);
    expect(tintAttribute(subsystem)[3]).toBeGreaterThan(0.9);

    // Половина длительности — половина пути между базой и вспышкой.
    subsystem.updateFrame(0.19, 1);
    expect(tintAttribute(subsystem)[3]).toBeCloseTo(0.4 + (1 - 0.4) * 0.5, 5);

    // Вспышка догорела: остался цвет команды, а не «без тинта».
    subsystem.updateFrame(0.2, 1);
    expect(tintAttribute(subsystem)[3]).toBeCloseTo(0.4, 5);
    expect(tintAttribute(subsystem)[1]).toBeCloseTo(0, 5);
  });

  it('повторное событие перезапускает вспышку с начала', () => {
    const { subsystem } = flashRig(null);
    subsystem.syncTick(damageTick());
    subsystem.updateFrame(0.3, 1);
    const decayed = tintAttribute(subsystem)[3]!;
    expect(decayed).toBeLessThan(0.3);

    subsystem.syncTick(damageTick());
    subsystem.updateFrame(0.01, 1);
    expect(tintAttribute(subsystem)[3]!).toBeGreaterThan(0.9);
  });

  it('событие, которого в таблице записи нет, вспышки не зажигает', () => {
    const { subsystem } = flashRig(null);
    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        events: [{ type: 'Healed', data: { entity: 1 } }],
        freshEvents: true,
      }),
    );
    subsystem.updateFrame(0.01, 1);
    expect(tintAttribute(subsystem)[3]).toBeCloseTo(0, 6);
  });
});
