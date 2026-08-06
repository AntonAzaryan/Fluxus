/**
 * Визуальное снижение падающей сущности (REND-12): нормировка прогресса в
 * Extractor'е (политика — имя компонента в конфиге), скольжение prev/curr в
 * ViewBuffer, смещение по z и отключение наклона в подсистеме моделей.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FIXED_ONE,
  createTerrainGrid,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type EntityId,
  type Simulation,
  type TickResult,
} from '@game-mvp/core';
import { validateCurvatureMap, type VisualManifest } from '@game-mvp/assets';
import {
  Extractor,
  ModelsSubsystem,
  ViewBuffer,
  VisualSurfaceSource,
  type ExtractedTick,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView } from './fixtures.js';

const FALL = { component: 'Falling', progressField: 'progress', durationField: 'duration' };

// ------------------------------------------------------------- Extractor

function tickWithFalling(progress: number, duration: number): {
  result: TickResult;
  walker: EntityId;
  faller: EntityId;
} {
  const scene = loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Falling', fields: { progress: 'i32', duration: 'i32' } },
    ],
    prefabs: [
      { name: 'Walker', components: { Position: {} }, tags: ['Walker'] },
      { name: 'Faller', components: { Position: {}, Falling: {} }, tags: ['Faller'] },
    ],
  });
  const at = { x: fixed.fromFloat(1), y: fixed.fromFloat(1) };
  const walker = worldInitSpawn(scene.world, 'Walker', { Position: at });
  const faller = worldInitSpawn(scene.world, 'Faller', {
    Position: at,
    Falling: { progress, duration },
  });
  const sim: Simulation = { systems: scene.systems, worldSeed: 1, math: mathApi };
  const state = initialState(scene.world, 1);
  return { result: tick(sim, state), walker, faller };
}

function columnOf(ext: ExtractedTick, entity: EntityId): number {
  for (let i = 0; i < ext.count; i++) {
    if (ext.id[i] === entity) return ext.fall[i]!;
  }
  throw new Error(`сущность ${entity} не попала в плоскую форму`);
}

describe('Extractor: колонка fall (REND-12)', () => {
  it('нормирует прогресс по порогу; сущность без компонента — NaN', () => {
    const { result, walker, faller } = tickWithFalling(15, 45);
    const ext = new Extractor({ kindOf: () => null, fall: FALL }).extract(result);
    expect(columnOf(ext, faller)).toBeCloseTo(15 / 45, 6);
    expect(Number.isNaN(columnOf(ext, walker))).toBe(true);
  });

  it('прогресс за порогом клампится в 1; нулевой порог — сразу 1', () => {
    const over = tickWithFalling(90, 45);
    const ext = new Extractor({ kindOf: () => null, fall: FALL }).extract(over.result);
    expect(columnOf(ext, over.faller)).toBe(1);

    const zero = tickWithFalling(0, 0);
    const extZero = new Extractor({ kindOf: () => null, fall: FALL }).extract(zero.result);
    expect(columnOf(extZero, zero.faller)).toBe(1);
  });

  it('без конфига fall колонка — сплошной NaN: сцена без падения рисуется как прежде', () => {
    const { result, faller } = tickWithFalling(15, 45);
    const ext = new Extractor({ kindOf: () => null }).extract(result);
    expect(Number.isNaN(columnOf(ext, faller))).toBe(true);
  });
});

// ------------------------------------------------------------- ViewBuffer

function syntheticTick(tickNumber: number, fall: number, snapAll = false): ExtractedTick {
  return {
    tick: tickNumber,
    mode: 'Running',
    isReplay: false,
    snapAll,
    freshEvents: true,
    count: 1,
    id: new Float64Array([7]),
    kind: new Int32Array([-1]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    level: new Uint8Array([0]),
    flags: new Uint8Array([0]),
    facingYaw: new Float32Array([Number.NaN]),
    aimYaw: new Float32Array([Number.NaN]),
    fall: new Float32Array([fall]),
    events: [],
    floorDelta: [],
    kindTable: [],
  };
}

describe('ViewBuffer: prev/curr прогресса падения (REND-12)', () => {
  it('прогресс скользит между тиками, как позиция; NaN — falling false и нули', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(syntheticTick(1, Number.NaN));
    const view = buffer.view.entities.get(7)!;
    expect(view.falling).toBe(false);
    expect(view.prevFall).toBe(0);
    expect(view.currFall).toBe(0);

    buffer.apply(syntheticTick(2, 0.25));
    expect(view.falling).toBe(true);
    expect(view.prevFall).toBe(0);
    expect(view.currFall).toBeCloseTo(0.25, 6);

    buffer.apply(syntheticTick(3, 0.5));
    expect(view.prevFall).toBeCloseTo(0.25, 6);
    expect(view.currFall).toBeCloseTo(0.5, 6);
  });

  it('snapAll обрывает интерполяцию прогресса: prev = curr', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(syntheticTick(1, 0.25));
    buffer.apply(syntheticTick(2, 0.75, true));
    const view = buffer.view.entities.get(7)!;
    expect(view.prevFall).toBeCloseTo(0.75, 6);
    expect(view.currFall).toBeCloseTo(0.75, 6);
  });
});

// ----------------------------------------------------------------- модели

const HERO: EntityId = 1;
const STEP = 0.5;

function makeModelsRig(options: { fallDepth?: number; surface?: boolean } = {}): {
  subsystem: ModelsSubsystem;
  source: VisualSurfaceSource | null;
} {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  let source: VisualSurfaceSource | null = null;
  if (options.surface === true) {
    // Бугор в центре — заметный наклон на склоне (как в surfaceAlign.test.ts).
    const map = validateCurvatureMap({ width: 4, height: 4, rows: ['....', '.77.', '.77.', '....'] });
    if (!map.ok) throw new Error(map.errors.join('; '));
    const grid = createTerrainGrid({
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0000', '0000', '0000', '0000'],
      flags: ['....', '....', '....', '....'],
    });
    source = new VisualSurfaceSource(grid, { curvatureMapId: 'visuals/curve.json' });
    const manifest: VisualManifest = { entities: { Runner: { model: 'models/runner.mdx' } } };
    const subsystem = new ModelsSubsystem(manifest, {
      surface: source,
      warn: () => {},
      ...(options.fallDepth !== undefined ? { fallDepth: options.fallDepth } : {}),
    });
    subsystem.init(ctx);
    assets.resolve('terrain-curvature', 'visuals/curve.json', map.map);
    return { subsystem, source };
  }
  const manifest: VisualManifest = { entities: { Runner: { model: 'models/runner.mdx' } } };
  const subsystem = new ModelsSubsystem(manifest, {
    warn: () => {},
    ...(options.fallDepth !== undefined ? { fallDepth: options.fallDepth } : {}),
  });
  subsystem.init(ctx);
  return { subsystem, source };
}

describe('ModelsSubsystem: снижение падающей сущности (REND-12)', () => {
  it('z опускается на fallDepth·t² от интерполированного прогресса', () => {
    const { subsystem } = makeModelsRig({ fallDepth: 2 });
    const view = makeEntityView(HERO, { falling: true, prevFall: 0.2, currFall: 0.4 });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(1 / 60, 0.5);
    const t = 0.2 + (0.4 - 0.2) * 0.5; // 0.3
    expect(subsystem.instanceFor(HERO)!.holder.position.z).toBeCloseTo(-2 * t * t, 6);
  });

  it('не падает — смещения нет', () => {
    const { subsystem } = makeModelsRig({ fallDepth: 2 });
    subsystem.syncTick(makeTickView([makeEntityView(HERO)]));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(HERO)!.holder.position.z).toBeCloseTo(0, 6);
  });

  it('наклон по поверхности к падающей сущности не применяется', () => {
    const { subsystem } = makeModelsRig({ surface: true });
    const onSlope = { currX: 0.8, currY: 2.0, prevX: 0.8, prevY: 2.0 };
    subsystem.syncTick(makeTickView([makeEntityView(HERO, { ...onSlope, falling: true, prevFall: 0.1, currFall: 0.2 })]));
    subsystem.updateFrame(1 / 60, 1);
    const holder = subsystem.instanceFor(HERO)!.holder;
    const up = new THREE.Vector3(0, 0, 1).applyQuaternion(holder.quaternion);
    expect(Math.acos(Math.min(Math.max(up.z, -1), 1))).toBeCloseTo(0, 6);
    // Та же точка без падения даёт ненулевой наклон — проверка не вырождена.
    subsystem.syncTick(makeTickView([makeEntityView(2, onSlope)]));
    subsystem.updateFrame(1 / 60, 1);
    const upStanding = new THREE.Vector3(0, 0, 1).applyQuaternion(
      subsystem.instanceFor(2)!.holder.quaternion,
    );
    expect(Math.acos(Math.min(Math.max(upStanding.z, -1), 1))).toBeGreaterThan(0.01);
  });
});
