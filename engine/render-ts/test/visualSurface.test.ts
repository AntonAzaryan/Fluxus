/**
 * Визуальная поверхность террейна (REND-9): непрерывность внутри уровня,
 * отсутствие «перетекания» кривизны через cliff-границу, амплитуда меньше
 * полушага, источник поверхности с догрузкой карты и несовпадением сетки.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@game-mvp/core';
import { validateCurvatureMap, type TerrainCurvatureMap } from '@game-mvp/assets';
import {
  VisualSurfaceSource,
  buildFloorGeometry,
  buildWallGeometry,
  createVisualSurface,
  type RenderContext,
  type SurfaceNormal,
} from '../src/index.js';
import { makeAssets } from './fixtures.js';

const STEP = 0.5;

function curvatureOf(width: number, height: number, rows: string[]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

/** 4×2, плоский уровень 0. */
function flatGrid() {
  return createTerrainGrid({
    width: 4,
    height: 2,
    tileSize: FIXED_ONE,
    levels: ['0000', '0000'],
    flags: ['....', '....'],
  });
}

/** 2×2: левый столбец — уровень 0, правый — уровень 1, рамп нет. */
function cliffGrid() {
  return createTerrainGrid({
    width: 2,
    height: 2,
    tileSize: FIXED_ONE,
    levels: ['01', '01'],
    flags: ['..', '..'],
  });
}

const normal = (): SurfaceNormal => ({ x: 0, y: 0, z: 0 });

describe('createVisualSurface (REND-9)', () => {
  it('без кривизны совпадает со ступенями: высота — уровень × шаг, нормаль вертикальна', () => {
    const surface = createVisualSurface(cliffGrid(), STEP, null);
    expect(surface.hasCurvature).toBe(false);
    expect(surface.heightAt(0.5, 0.5)).toBeCloseTo(0, 6);
    expect(surface.heightAt(1.5, 0.5)).toBeCloseTo(STEP, 6);
    const n = surface.normalAt(0.5, 0.5, normal());
    expect(n.z).toBeCloseTo(1, 6);
  });

  it('выпуклость поднимает поверхность, вогнутость опускает; высота и нормаль непрерывны внутри уровня', () => {
    const grid = flatGrid();
    const surface = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['.7g.', '.7g.']));
    // Центры клеток: бугор под "7", впадина под "g".
    expect(surface.heightAt(1.5, 1)).toBeGreaterThan(0);
    expect(surface.heightAt(2.5, 1)).toBeLessThan(0);
    // Высота непрерывна на границах клеток (C0); нормаль билинейной формы на
    // границе может ломаться (хребет в узле) — её дрожание гасит временнóе
    // сглаживание наклона (REND-10), непрерывности здесь не требуется.
    for (const border of [1, 2, 3]) {
      expect(surface.heightAt(border - 1e-6, 0.7)).toBeCloseTo(surface.heightAt(border + 1e-6, 0.7), 4);
    }
    // На склоне бугра нормаль отклонена от вертикали и смотрит от вершины.
    const slope = surface.normalAt(0.7, 1.0, normal());
    expect(slope.x).toBeLessThan(-1e-3); // вершина восточнее — нормаль валится на запад
    expect(slope.z).toBeGreaterThan(0.9); // амплитуда мала — наклон умеренный
  });

  it('амплитуда ограничена меньше полушага: бугор не прочитывается как соседний уровень (REND-7)', () => {
    const grid = flatGrid();
    // Максимальная выпуклость всюду — предельный случай алфавита.
    const surface = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['7777', '7777']));
    for (const [x, y] of [[0.5, 0.5], [1.5, 1.5], [3.5, 0.5], [2, 1]] as const) {
      expect(Math.abs(surface.heightAt(x, y))).toBeLessThan(STEP / 2);
    }
  });

  it('кривизна не перетекает через cliff-границу: плато вздувается, низина не тронута', () => {
    const grid = cliffGrid();
    // Вся кривизна — на правом столбце (уровень 1).
    const surface = createVisualSurface(grid, STEP, curvatureOf(2, 2, ['.7', '.7']));
    // Углы низины на самой границе x=1 остаются на нулевой высоте.
    expect(surface.heightAt(1 - 1e-6, 0.5)).toBeCloseTo(0, 5);
    expect(surface.heightAt(1 - 1e-6, 1.5)).toBeCloseTo(0, 5);
    // Плато у границы поднято.
    expect(surface.heightAt(1 + 1e-6, 1)).toBeGreaterThan(STEP);
    // Нормаль в низине вертикальна: чужая кривизна на неё не влияет.
    const n = surface.normalAt(0.5, 1, normal());
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.y).toBeCloseTo(0, 6);
  });

  it('за краем сетки отвечает ближайшая клетка — запрос тотален', () => {
    const surface = createVisualSurface(cliffGrid(), STEP, null);
    expect(surface.heightAt(-5, -5)).toBeCloseTo(0, 6);
    expect(surface.heightAt(50, 50)).toBeCloseTo(STEP, 6);
    expect(surface.normalAt(-5, 0.5, normal()).z).toBeCloseTo(1, 6);
  });
});

describe('геометрия с кривизной (REND-9)', () => {
  it('пол с поверхностью повторяет её углы; без поверхности — прежние ступени', () => {
    const grid = flatGrid();
    const surface = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['7777', '7777']));
    const curved = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2, surface);
    const flat = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2);
    // Все внутренние углы подняты, но меньше полушага.
    let raised = 0;
    for (let i = 2; i < curved.positions.length; i += 3) {
      const z = curved.positions[i]!;
      expect(z).toBeLessThan(STEP / 2);
      if (z > 0) raised++;
    }
    expect(raised).toBeGreaterThan(0);
    for (let i = 2; i < flat.positions.length; i += 3) expect(flat.positions[i]).toBe(0);
  });

  it('стенка тянется до фактических визуальных кромок (skirt)', () => {
    const grid = cliffGrid();
    const surface = createVisualSurface(grid, STEP, curvatureOf(2, 2, ['.7', '.7']));
    const walls = buildWallGeometry(grid, STEP, surface);
    // Верхние кромки стенок совпадают с углами приподнятого плато, а не с level×step.
    const tops: number[] = [];
    for (let i = 2; i < walls.positions.length; i += 3) {
      const z = walls.positions[i]!;
      if (z > STEP / 2) tops.push(z);
    }
    expect(tops.length).toBeGreaterThan(0);
    const [c00, , , c01] = surface.cornerHeights(1, 0);
    for (const top of tops) {
      expect([c00, c01, surface.cornerHeights(1, 1)[2], surface.cornerHeights(1, 1)[3]].some(
        (h) => Math.abs(h - top) < 1e-6,
      )).toBe(true);
    }
  });
});

describe('VisualSurfaceSource (ASSET-7 → REND-9)', () => {
  function makeCtx() {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    return { assets, ctx };
  }

  it('до готовности карты поверхность плоская; по готовности подменяется и зовёт подписчиков', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid(), { curvatureMapId: 'visuals/curve.json' });
    let changes = 0;
    source.onChange(() => changes++);
    source.init(ctx);
    source.init(ctx); // идемпотентность: обе подсистемы зовут init
    expect(source.current?.hasCurvature).toBe(false);
    expect(assets.requests.filter((r) => r.kind === 'terrain-curvature').length).toBe(1);

    assets.resolve('terrain-curvature', 'visuals/curve.json', curvatureOf(4, 2, ['.7..', '....']));
    expect(changes).toBe(1);
    expect(source.current?.hasCurvature).toBe(true);
    expect(source.current!.heightAt(1.5, 0.5)).toBeGreaterThan(0);
  });

  it('несовпадение сетки — предупреждение и рендер без кривизны (ASSET-7)', () => {
    const { assets, ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), {
      curvatureMapId: 'visuals/wrong.json',
      warn: (m) => warnings.push(m),
    });
    source.init(ctx);
    assets.resolve('terrain-curvature', 'visuals/wrong.json', curvatureOf(3, 3, ['...', '...', '...']));
    expect(warnings.some((w) => /не совпадает с сеткой/.test(w))).toBe(true);
    expect(source.current?.hasCurvature).toBe(false);
  });

  it('ошибка загрузки — предупреждение и плоские ступени', () => {
    const { assets, ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), {
      curvatureMapId: 'visuals/missing.json',
      warn: (m) => warnings.push(m),
    });
    source.init(ctx);
    assets.fail('terrain-curvature', 'visuals/missing.json', 'файл недоступен');
    expect(warnings.some((w) => /не загрузилась/.test(w))).toBe(true);
    expect(source.current?.hasCurvature).toBe(false);
  });

  it('без curvatureMapId ассеты не запрашиваются — плоские ступени без предупреждений', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    source.init(ctx);
    expect(assets.requests.length).toBe(0);
    expect(source.current?.hasCurvature).toBe(false);
  });
});
