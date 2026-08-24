/**
 * Наклон инстансов по нормали визуальной поверхности (REND-10): коэффициент
 * k из манифеста, лимит угла, snap при разрыве непрерывности, пропуск для
 * сущностей с override уровня, порядок «позиция → наклон».
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type EntityId } from '@fluxus/core';
import { validateCurvatureMap, type VisualManifest } from '@fluxus/assets';
import {
  ModelsSubsystem,
  VisualSurfaceSource,
  tiltTarget,
  type RenderContext,
  type SurfaceNormal,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView, type AssetsStub } from './fixtures.js';

const STEP = 0.5;
const HERO: EntityId = 1;

/** 4×4, уровень 0, сильный бугор в центре — заметные наклоны склонов. */
function bumpyGrid() {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: FIXED_ONE,
    levels: ['0000', '0000', '0000', '0000'],
    flags: ['....', '....', '....', '....'],
  });
}

function makeSurface(): VisualSurfaceSource {
  // Узлы 5×5: центральный блок 3×3 поднят — бугор посреди арены.
  const map = validateCurvatureMap({
    width: 4,
    height: 4,
    rows: [
      [0, 0, 0, 0, 0],
      [0, 14, 14, 14, 0],
      [0, 14, 14, 14, 0],
      [0, 14, 14, 14, 0],
      [0, 0, 0, 0, 0],
    ],
  });
  if (!map.ok) throw new Error(map.errors.join('; '));
  const source = new VisualSurfaceSource(bumpyGrid(), { curvatureMapId: 'visuals/curve.json' });
  return Object.assign(source, { __map: map.map });
}

function makeManifest(surfaceAlign?: VisualManifest['entities'][string]['surfaceAlign']): VisualManifest {
  return {
    entities: {
      Runner: { model: 'models/runner.mdx', ...(surfaceAlign !== undefined ? { surfaceAlign } : {}) },
    },
  };
}

function makeRig(manifest: VisualManifest): {
  subsystem: ModelsSubsystem;
  source: VisualSurfaceSource;
  assets: AssetsStub;
} {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  const source = makeSurface();
  const subsystem = new ModelsSubsystem(manifest, { surface: source, warn: () => {} });
  subsystem.init(ctx);
  assets.resolve(
    'terrain-curvature',
    'visuals/curve.json',
    (source as unknown as { __map: unknown }).__map,
  );
  return { subsystem, source, assets };
}

/** Угол up-вектора инстанса от вертикали, радианы. */
function tiltAngleOf(subsystem: ModelsSubsystem, entity: EntityId): number {
  const pose = subsystem.instanceFor(entity)!.pose;
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(
    new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw),
  );
  return Math.acos(Math.min(Math.max(up.z, -1), 1));
}

/** Наклон нормали поверхности в точке — эталон для сравнения. */
function surfaceAngleAt(source: VisualSurfaceSource, x: number, y: number): number {
  const n: SurfaceNormal = { x: 0, y: 0, z: 1 };
  source.current!.normalAt(x, y, n);
  return Math.acos(Math.min(Math.max(n.z, -1), 1));
}

/** Точка на склоне бугра с ненулевым наклоном нормали. */
const SLOPE_X = 0.8;
const SLOPE_Y = 2.0;

describe('наклон по нормали поверхности (REND-10)', () => {
  it('k = 1 (дефолт): после snap-кадра инстанс перпендикулярен поверхности', () => {
    const { subsystem, source } = makeRig(makeManifest());
    const view = makeEntityView(HERO, { currX: SLOPE_X, currY: SLOPE_Y, prevX: SLOPE_X, prevY: SLOPE_Y });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(1 / 60, 1); // spawn → snap: наклон применяется мгновенно
    const expected = surfaceAngleAt(source, SLOPE_X, SLOPE_Y);
    expect(expected).toBeGreaterThan(0.01); // точка действительно на склоне
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(expected, 5);
  });

  it('k = 0: инстанс вертикален независимо от рельефа', () => {
    const { subsystem } = makeRig(makeManifest({ factor: 0 }));
    const view = makeEntityView(HERO, { currX: SLOPE_X, currY: SLOPE_Y, prevX: SLOPE_X, prevY: SLOPE_Y });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(1 / 60, 1);
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(0, 6);
  });

  it('промежуточный k — доля угла нормали (slerp)', () => {
    const { subsystem, source } = makeRig(makeManifest({ factor: 0.5 }));
    const view = makeEntityView(HERO, { currX: SLOPE_X, currY: SLOPE_Y, prevX: SLOPE_X, prevY: SLOPE_Y });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(1 / 60, 1);
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(surfaceAngleAt(source, SLOPE_X, SLOPE_Y) * 0.5, 5);
  });

  it('лимит угла ограничивает наклон при любом k', () => {
    const maxAngleDeg = 2;
    const { subsystem, source } = makeRig(makeManifest({ factor: 1, maxAngleDeg }));
    const view = makeEntityView(HERO, { currX: SLOPE_X, currY: SLOPE_Y, prevX: SLOPE_X, prevY: SLOPE_Y });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(1 / 60, 1);
    const maxRad = (maxAngleDeg * Math.PI) / 180;
    expect(surfaceAngleAt(source, SLOPE_X, SLOPE_Y)).toBeGreaterThan(maxRad); // лимит действительно активен
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(maxRad, 5);
  });

  it('override уровня (TERR-4): наклон не применяется', () => {
    const { subsystem } = makeRig(makeManifest());
    const view = makeEntityView(HERO, {
      currX: SLOPE_X,
      currY: SLOPE_Y,
      prevX: SLOPE_X,
      prevY: SLOPE_Y,
      levelOverride: true,
    });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(1 / 60, 1);
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(0, 6);
  });

  it('без snap наклон сглаживается по кадрам, а не скачет', () => {
    const { subsystem, source } = makeRig(makeManifest());
    // Кадр 1: почти ровное место, snap спавна съеден.
    const flat = makeEntityView(HERO, { currX: 0.1, currY: 0.1, prevX: 0.1, prevY: 0.1 });
    subsystem.syncTick(makeTickView([flat]));
    subsystem.updateFrame(1 / 60, 1);
    const before = tiltAngleOf(subsystem, HERO);
    const target = surfaceAngleAt(source, SLOPE_X, SLOPE_Y);
    expect(before).toBeLessThan(target / 4);
    // Кадр 2: перенос данных без snap-флага — цель наклона изменилась.
    const slope = makeEntityView(HERO, { currX: SLOPE_X, currY: SLOPE_Y, prevX: SLOPE_X, prevY: SLOPE_Y });
    subsystem.syncTick(makeTickView([slope], { tick: 2 }));
    subsystem.updateFrame(1 / 60, 1);
    const after = tiltAngleOf(subsystem, HERO);
    expect(after).toBeGreaterThan(before); // движется к цели...
    expect(after).toBeLessThan(target); // ...но за один кадр не долетает
  });

  it('перемотка (snap): наклон применяется мгновенно, без доворота', () => {
    const { subsystem, source } = makeRig(makeManifest());
    const flat = makeEntityView(HERO, { currX: 0.5, currY: 0.5, prevX: 0.5, prevY: 0.5 });
    subsystem.syncTick(makeTickView([flat]));
    subsystem.updateFrame(1 / 60, 1);
    const slope = makeEntityView(HERO, {
      currX: SLOPE_X,
      currY: SLOPE_Y,
      prevX: SLOPE_X,
      prevY: SLOPE_Y,
      snap: true,
    });
    subsystem.syncTick(makeTickView([slope], { tick: 2, snapAll: true }));
    subsystem.updateFrame(1 / 60, 1);
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(surfaceAngleAt(source, SLOPE_X, SLOPE_Y), 5);
  });

  it('позиция по высоте визуальной поверхности: инстанс стоит на бугре', () => {
    const { subsystem, source } = makeRig(makeManifest());
    const center = makeEntityView(HERO, { currX: 2, currY: 2, prevX: 2, prevY: 2 });
    subsystem.syncTick(makeTickView([center]));
    subsystem.updateFrame(1 / 60, 1);
    const pose = subsystem.instanceFor(HERO)!.pose;
    const height = source.current!.heightAt(2, 2);
    expect(height).toBeGreaterThan(0);
    expect(pose.z).toBeCloseTo(height, 6);
  });
});

describe('tiltTarget — чистая математика наклона', () => {
  it('вертикальная нормаль — нулевой наклон; наклонная — ось поперёк градиента', () => {
    const out = { x: 0, y: 0 };
    tiltTarget({ x: 0, y: 0, z: 1 }, 1, null, out);
    expect(out).toEqual({ x: 0, y: 0 });
    // Нормаль валится на запад (x < 0) → ось наклона вдоль +Y... проверяем длину и перпендикулярность.
    const n = { x: -0.3, y: 0.1, z: Math.sqrt(1 - 0.09 - 0.01) };
    tiltTarget(n, 1, null, out);
    const angle = Math.hypot(out.x, out.y);
    expect(angle).toBeCloseTo(Math.acos(n.z), 6);
    // Ось перпендикулярна горизонтальной проекции нормали.
    expect(out.x * n.x + out.y * n.y).toBeCloseTo(0, 6);
  });

  it('factor масштабирует угол, maxAngle ограничивает его', () => {
    const out = { x: 0, y: 0 };
    const n = { x: 0.5, y: 0, z: Math.sqrt(0.75) };
    const full = Math.acos(n.z);
    tiltTarget(n, 0.25, null, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(full * 0.25, 6);
    tiltTarget(n, 1, full / 3, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(full / 3, 6);
  });
});
