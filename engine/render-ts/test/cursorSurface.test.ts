/**
 * Проекция курсора на визуальную поверхность (REND-42): точка вьюпорта — на
 * тот пол, который игрок ВИДИТ, а не на плоскость постоянной высоты.
 *
 * Камера здесь наклонена намеренно, а не смотрит в надир: разница между полем
 * высот и плоскостью растёт как `Δh / tan(pitch)`, и вертикальный луч её не
 * показал бы вовсе — при взгляде сверху вниз обе версии дают одну точку.
 * Графического контекста не создаётся ни одного (то же основание, что у
 * headless-теста позы, CAM-1).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import { validateCurvatureMap, type TerrainCurvatureMap } from '@fluxus/assets';
import {
  CursorSurface,
  VisualSurfaceSource,
  type CameraPose,
  type RenderContext,
  type ViewportPoint,
} from '../src/index.js';
import { makeAssets } from './fixtures.js';

/** Шаг высоты уровня — тот же, что у стенда picking'а. */
const STEP = 2;

/** Прямоугольник вьюпорта и его центр — точка, через которую идёт луч. */
const VIEWPORT: ViewportPoint = { x: 60, y: 40, width: 120, height: 80 };

function grid(levels: readonly string[], flags?: readonly string[]): TerrainGrid {
  const height = levels.length;
  const width = levels[0]!.length;
  return createTerrainGrid({
    width,
    height,
    tileSize: FIXED_ONE,
    levels: [...levels],
    flags: flags === undefined ? Array.from({ length: height }, () => '.'.repeat(width)) : [...flags],
  });
}

function curvature(width: number, height: number, rows: number[][]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

interface Rig {
  readonly cursor: CursorSurface;
  readonly source: VisualSurfaceSource;
}

function makeRig(terrain: TerrainGrid): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  const source = new VisualSurfaceSource(terrain);
  // Поверхность заводится тем же `init`, каким её заводят подсистемы (REND-8):
  // сервис проекции её только читает и своей не строит.
  source.init(ctx);
  return { cursor: new CursorSurface({ surface: source }), source };
}

/**
 * Поза с наклоном `pitch` вниз, взглядом вдоль +Y (yaw = π/2), поставленная так,
 * чтобы луч через центр вьюпорта прошёл через мировую точку `(x, y)` на высоте
 * `z`. Именно через ТОЧКУ, а не через клетку: тест адресует место, а не пиксель.
 */
function aimAt(x: number, y: number, z: number, pitch: number, distance = 12): CameraPose {
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  return {
    posX: x,
    posY: y - cos * distance,
    posZ: z + sin * distance,
    yaw: Math.PI / 2,
    pitch,
    roll: 0,
    fovDeg: 45,
  };
}

/** Высота плоскости под точкой наблюдения — то, чем целилась игра до REND-42. */
function planeHit(pose: CameraPose, planeZ: number): { x: number; y: number } {
  const cos = Math.cos(pose.pitch);
  const sin = Math.sin(pose.pitch);
  const t = (pose.posZ - planeZ) / sin;
  return { x: pose.posX + Math.cos(pose.yaw) * cos * t, y: pose.posY + Math.sin(pose.yaw) * cos * t };
}

describe('проекция курсора на визуальную поверхность (REND-42)', () => {
  it('луч строится общей посадкой позы (CAM-1) — как у picking\'а, без графического контекста', () => {
    const { cursor } = makeRig(grid(['0000', '0000', '0000', '0000']));
    const ray = cursor.ray(
      { posX: 1.5, posY: 2.5, posZ: 7, yaw: 0, pitch: Math.PI / 2, roll: 0, fovDeg: 45 },
      VIEWPORT,
    );
    expect(ray.originX).toBeCloseTo(1.5, 6);
    expect(ray.originY).toBeCloseTo(2.5, 6);
    expect(ray.originZ).toBeCloseTo(7, 6);
    expect(ray.dirZ).toBeCloseTo(-1, 6);
  });

  it('прицел над плато уровня 1 ложится на высоту плато, а не на плоскость низины', () => {
    // Северная половина арены — плато уровня 1 (высота 1 × STEP = 2).
    const { cursor } = makeRig(grid(['0000', '0000', '1111', '1111']));
    // Точка на площадке плато; камера смотрит с юга и наклонена на 50° — тот же
    // порядок наклона, что у игрового кадра (DEFAULT_CAMERA_CONFIG).
    const pitch = (50 * Math.PI) / 180;
    const pose = aimAt(1.5, 2.5, STEP, pitch);

    const hit = cursor.project(pose, VIEWPORT)!;
    expect(hit.kind).toBe('surface');
    expect(hit.z).toBeCloseTo(STEP, 4);
    expect(hit.x).toBeCloseTo(1.5, 4);
    expect(hit.y).toBeCloseTo(2.5, 4);
    expect(hit.cellX).toBe(1);
    expect(hit.cellY).toBe(2);

    // Тест не вырожден: плоскость на высоте низины (то, чем целилась игра)
    // отвела бы точку на `Δh / tan(pitch)` ≈ 1.68 мировой единицы вглубь кадра —
    // почти две клетки промаха на одной ступени высоты.
    const plane = planeHit(pose, 0);
    expect(Math.hypot(plane.x - hit.x, plane.y - hit.y)).toBeCloseTo(
      STEP / Math.tan(pitch),
      3,
    );
  });

  it('прицел над клеткой с кривизной ложится на выпуклость, а не на её хорду', () => {
    const { cursor, source } = makeRig(grid(['000', '000', '000']));
    // Северный ряд узлов поднят: внутри клетки (1,1) поле меняется по Y.
    source.setCurvature(curvature(3, 3, [
      [14, 14, 14, 14],
      [7, 7, 7, 7],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]));
    const surface = source.current!;
    expect(surface.hasCellCurvature(1, 1)).toBe(true);

    const px = 1.5;
    const py = 1.25;
    const pitch = (50 * Math.PI) / 180;
    const pose = aimAt(px, py, surface.heightInCell(1, 1, px, py), pitch);

    const hit = cursor.project(pose, VIEWPORT)!;
    expect(hit.cellX).toBe(1);
    expect(hit.cellY).toBe(1);
    // Марш идёт тем же `heightInCell`, каким геометрия ставит свои вершины.
    expect(hit.z).toBeCloseTo(surface.heightInCell(1, 1, hit.x, hit.y), 3);
    expect(hit.x).toBeCloseTo(px, 3);
    expect(hit.y).toBeCloseTo(py, 3);
  });

  it('клетка без пола названа вместе с признаком: дыра — клетка сетки, а не её отсутствие', () => {
    const { cursor } = makeRig(
      grid(['0000', '0000', '0000', '0000'], ['....', '._..', '....', '....']),
    );
    const hit = cursor.project(
      { posX: 1.5, posY: 1.5, posZ: 9, yaw: 0, pitch: Math.PI / 2, roll: 0, fovDeg: 45 },
      VIEWPORT,
    )!;
    expect(hit.cell).toBe(1 * 4 + 1);
    expect(hit.noFloor).toBe(true);
  });

  it('луч мимо арены попадания не даёт — и это ответ, а не отсутствие ответа', () => {
    const { cursor } = makeRig(grid(['0000', '0000', '0000', '0000']));
    // Взгляд ВВЕРХ из-под арены: ни поля высот, ни настилов на пути нет.
    const hit = cursor.project(
      { posX: 2, posY: 2, posZ: 20, yaw: 0, pitch: -Math.PI / 4, roll: 0, fovDeg: 45 },
      VIEWPORT,
    );
    expect(hit).toBeNull();
  });

  it('правка поля высот меняет ответ: поверхность читается текущая, а не захваченная', () => {
    const { cursor, source } = makeRig(grid(['000', '000', '000']));
    const straightDown: CameraPose = {
      posX: 1.5, posY: 1.5, posZ: 12, yaw: 0, pitch: Math.PI / 2, roll: 0, fovDeg: 45,
    };
    expect(cursor.project(straightDown, VIEWPORT)!.z).toBeCloseTo(0, 4);

    source.setGrid(grid(['000', '010', '000']));
    expect(cursor.project(straightDown, VIEWPORT)!.z).toBeCloseTo(STEP, 4);
  });

  it('попадание переиспользуется: аллокаций на кадр путь проекции не делает (REND-26)', () => {
    const { cursor } = makeRig(grid(['000', '000', '000']));
    const pose = aimAt(1.5, 1.5, 0, (50 * Math.PI) / 180);
    const first = cursor.project(pose, VIEWPORT);
    const second = cursor.project(pose, VIEWPORT);
    expect(second).toBe(first);
  });
});
