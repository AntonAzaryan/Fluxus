/**
 * Величины занятой памяти рендера (`performance-budget` PERF-8): инжектируемый
 * сток учёта ресурсов GPU и величин состояния.
 *
 * Проверяется то же, чего требует PERF-8 от учёта: без стока он не исполняется,
 * живое число — разность созданных и освобождённых (REND-31), а величины
 * состояния — пик за прогон, а не сумма.
 *
 * WebGL здесь нет и не нужно: `dispose()` геометрий, материалов, текстур и целей
 * отрисовки THREE рассылает событие `dispose` без всякого рендерера — на этом
 * держится и учёт, и соседний `lifetime.test.ts`.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FIXED_ONE, createTerrainGrid, type EntityId } from '@fluxus/core';
import type { VisualManifest } from '@fluxus/assets';
import {
  FOOTPRINT_RESOURCE_KINDS,
  ModelsSubsystem,
  TerrainSubsystem,
  ViewBuffer,
  attachFootprintSink,
  createFootprint,
  footprintLive,
  footprintSink,
  own,
  peak,
  releaseFootprintSink,
  withFootprintSink,
  type RenderFootprint,
} from '../src/index.js';
import {
  makeAssets,
  makeEntityView,
  makeExtractedTick,
  makeModel,
  makeTickView,
} from './fixtures.js';

const HERO: EntityId = 1;

/** Живое число вида у владельца — то, что читает инвариант PERF-9. */
function live(sink: RenderFootprint, owner: string, kind: string): number {
  return footprintLive(sink)[owner]?.[kind] ?? 0;
}

describe('PERF-8: учёт ресурсов GPU — разность созданных и освобождённых', () => {
  it('без стока `own` возвращает ресурс и ничего не считает', () => {
    expect(footprintSink()).toBeUndefined();
    const geometry = new THREE.BufferGeometry();
    expect(own('geometry', 'terrain', geometry)).toBe(geometry);
    // Учёт не исполнялся вовсе: подключённый следом сток пуст, а не «нашёл»
    // ресурс задним числом (PERF-8, сценарий «Учёт без стока бесплатен»).
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      geometry.dispose();
    });
    expect(footprintLive(sink)).toEqual({});
  });

  it('живое число растёт на создании и падает на dispose()', () => {
    const sink = createFootprint();
    let geometry: THREE.BufferGeometry | null = null;
    withFootprintSink(sink, () => {
      geometry = own('geometry', 'terrain', new THREE.BufferGeometry());
      expect(live(sink, 'terrain', 'geometry')).toBe(1);
    });
    geometry!.dispose();
    expect(live(sink, 'terrain', 'geometry')).toBe(0);
  });

  it('повторный dispose() не уводит живое число в минус', () => {
    const sink = createFootprint();
    const material = withFootprintSink(sink, () =>
      own('material', 'fog', new THREE.MeshBasicMaterial()),
    );
    material.dispose();
    material.dispose();
    material.dispose();
    expect(live(sink, 'fog', 'material')).toBe(0);
  });

  it('счёт идёт по виду И по владельцу — их пары не сливаются', () => {
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      own('geometry', 'terrain', new THREE.BufferGeometry());
      own('geometry', 'terrain', new THREE.BufferGeometry());
      own('material', 'terrain', new THREE.MeshBasicMaterial());
      own('geometry', 'models', new THREE.BufferGeometry());
      own('texture', 'fog', new THREE.DataTexture(new Uint8Array(4), 1, 1));
      own('renderTarget', 'fog', new THREE.WebGLRenderTarget(1, 1));
    });
    expect(footprintLive(sink)).toEqual({
      fog: { texture: 1, renderTarget: 1 },
      models: { geometry: 1 },
      terrain: { geometry: 2, material: 1 },
    });
  });

  it('ресурс, отданный под ЧУЖИМ замером, уменьшает счёт своего стока', () => {
    const first = createFootprint();
    const second = createFootprint();
    const geometry = withFootprintSink(first, () =>
      own('geometry', 'terrain', new THREE.BufferGeometry()),
    );
    withFootprintSink(second, () => {
      geometry.dispose();
    });
    expect(live(first, 'terrain', 'geometry')).toBe(0);
    expect(footprintLive(second)).toEqual({});
  });

  it('владельцы документа отсортированы, а виды перечислены объявленным порядком', () => {
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      own('material', 'water', new THREE.MeshBasicMaterial());
      own('geometry', 'effects', new THREE.BufferGeometry());
    });
    expect(Object.keys(footprintLive(sink))).toEqual(['effects', 'water']);
    expect(FOOTPRINT_RESOURCE_KINDS).toEqual(['geometry', 'material', 'texture', 'renderTarget']);
  });
});

describe('PERF-8: величины состояния — пик, а не сумма', () => {
  it('peak держит максимум и не падает вслед за величиной', () => {
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      peak('viewRecords', 4);
      peak('viewRecords', 9);
      peak('viewRecords', 2);
    });
    expect(sink.state.viewRecords).toBe(9);
  });

  it('без стока peak не пишет никуда', () => {
    const sink = createFootprint();
    peak('viewRecords', 100);
    expect(sink.state.viewRecords).toBe(0);
  });

  it('доставка K сущностей даёт записи приёма и память курсов', () => {
    const sink = createFootprint();
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    withFootprintSink(sink, () => {
      buffer.apply(makeExtractedTick(12));
    });
    expect(sink.state.viewRecords).toBe(12);
    expect(sink.state.viewFacingMemory).toBe(12);
  });

  it('пересборка кэша батчей двигает число батчей и записей (REND-20)', () => {
    const assets = makeAssets();
    const manifest: VisualManifest = { entities: { Runner: { model: 'models/a.mdx', scale: 1 } } };
    const subsystem = new ModelsSubsystem(manifest, { warn: () => {} });
    subsystem.init({
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    });
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      subsystem.syncTick(makeTickView([makeEntityView(HERO)]));
      assets.resolve('model', 'models/a.mdx', makeModel());
      subsystem.syncTick(makeTickView([makeEntityView(HERO)]));
    });
    expect(sink.state.modelsInstances).toBe(1);
    expect(sink.state.modelsBatches).toBe(1);
    expect(sink.state.modelsBatchRecords).toBe(1);
  });

  it('чанки террейна считаются сеткой, а не числом пересборок', () => {
    const grid = createTerrainGrid({
      width: 16,
      height: 16,
      tileSize: FIXED_ONE,
      levels: Array.from({ length: 16 }, () => '0'.repeat(16)),
      flags: Array.from({ length: 16 }, () => '.'.repeat(16)),
    });
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      const subsystem = new TerrainSubsystem(grid, { chunkSize: 8 });
      subsystem.init({
        scene: new THREE.Scene(),
        assets: makeAssets().service,
        config: { heightStep: 0.5 },
      });
      subsystem.updateFrame(1 / 60, 1);
    });
    // Арена 16×16 при чанке 8 — ровно четыре чанка (REND-7).
    expect(sink.state.terrainChunks).toBe(4);
  });
});

describe('PERF-8: три формы владения стоком — те же, что у счётчиков стоимости', () => {
  it('сток снимается после замера — и при обрыве тела исключением', () => {
    const sink = createFootprint();
    withFootprintSink(sink, () => {
      expect(footprintSink()).toBe(sink);
    });
    expect(footprintSink()).toBeUndefined();

    expect(() =>
      withFootprintSink(sink, () => {
        throw new Error('обрыв замера');
      }),
    ).toThrow('обрыв замера');
    expect(footprintSink()).toBeUndefined();
  });

  it('ручное подключение возвращает предыдущий сток', () => {
    const sink = createFootprint();
    const previous = attachFootprintSink(sink);
    expect(previous).toBeUndefined();
    expect(footprintSink()).toBe(sink);
    expect(attachFootprintSink(previous)).toBe(sink);
    expect(footprintSink()).toBeUndefined();
  });

  it('отпущенный долгоживущий сток не воскресает восстановлением чужого замера', () => {
    const longLived = createFootprint();
    attachFootprintSink(longLived);
    const measured = createFootprint();
    withFootprintSink(measured, () => {
      releaseFootprintSink(longLived);
      expect(footprintSink()).toBe(measured);
    });
    expect(footprintSink()).toBeUndefined();
  });
});
