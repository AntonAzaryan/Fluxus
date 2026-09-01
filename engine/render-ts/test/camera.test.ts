/**
 * CameraRig (camera CAM-1..5, CAM-7): конвейер позы без WebGL — поза как
 * данные, follow по x/y с высотой по поверхности, режимы и Dota-переходы, зум,
 * кламп к границам, snap без проезда, маршрутизация ввода героя, переподача
 * инжектированных источника поверхности и границ.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CameraRig,
  EffectStack,
  TraumaShake,
  applyCameraPose,
  createCameraInput,
  edgePanAxes,
  resetCameraInput,
  terrainGroundApi,
  type CameraInput,
  type CameraPose,
  type CameraRigOptions,
  type FollowTarget,
} from '../src/index.js';
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';

const target = (x: number, y: number, snap = false): FollowTarget => ({ x, y, snap });

/** Плоская сетка width×height с уровнем `level` во всех клетках. */
function flatGrid(width: number, height: number, level: number): TerrainGrid {
  const cells = width * height;
  return {
    width,
    height,
    tileSize: FIXED_ONE,
    levels: new Uint8Array(cells).fill(level),
    ramps: new Uint8Array(cells),
    floor: new Uint8Array(cells).fill(1),
    cliffs: [],
  };
}

function makeRig(options: CameraRigOptions = {}): { rig: CameraRig; input: CameraInput } {
  return { rig: new CameraRig(options), input: createCameraInput() };
}

/** Прогоняет rig кадрами по 1/60 с; ввод сбрасываем вручную, как сборка. */
function settle(
  rig: CameraRig,
  input: CameraInput,
  follow: FollowTarget | null,
  frames: number,
): void {
  for (let i = 0; i < frames; i++) rig.update(input, 1 / 60, follow);
}

describe('CameraRig: поза и follow (CAM-1, CAM-2)', () => {
  it('возвращает позу как данные без графического контекста', () => {
    const { rig, input } = makeRig();
    const pose = rig.update(input, 1 / 60, target(10, 10));
    expect(Number.isFinite(pose.posX)).toBe(true);
    expect(Number.isFinite(pose.posZ)).toBe(true);
    expect(pose.fovDeg).toBeGreaterThan(0);
    expect(pose.roll).toBe(0);
  });

  it('follow сглаженно сходится к цели по x/y', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    settle(rig, input, target(10, 6), 300);
    expect(rig.focusX).toBeCloseTo(10, 1);
    expect(rig.focusY).toBeCloseTo(6, 1);
  });

  it('высота — поверхность под точкой наблюдения, не вертикаль цели (CAM-2)', () => {
    // Поверхность под целью — 1.2; вертикальной координаты цели у rig'а нет
    // вовсе (FollowTarget — только x/y): подброс героя позу не меняет.
    const { rig, input } = makeRig({ groundHeightAt: () => 1.2, startX: 5, startY: 5 });
    settle(rig, input, target(5, 5), 300);
    const pose = rig.update(input, 1 / 60, target(5, 5));
    expect(rig.groundZ).toBeCloseTo(1.2, 3);
    expect(pose.posZ).toBeCloseTo(1.2 + Math.sin(rig.config.pitch) * rig.config.distance, 2);
  });

  it('подъём поверхности проходит сглаженно, без скачка за кадр', () => {
    let ground = 0;
    const { rig, input } = makeRig({ groundHeightAt: () => ground, startX: 5, startY: 5 });
    settle(rig, input, target(5, 5), 60);
    ground = 0.6; // герой заехал на плато
    rig.update(input, 1 / 60, target(5, 5));
    expect(rig.groundZ).toBeGreaterThan(0);
    expect(rig.groundZ).toBeLessThan(0.3); // не весь шаг за один кадр
    settle(rig, input, target(5, 5), 300);
    expect(rig.groundZ).toBeCloseTo(0.6, 3);
  });
});

describe('CameraRig: snap при разрыве цели (CAM-5)', () => {
  it('прыгает без проезда, когда цель пришла со snap-флагом', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    settle(rig, input, target(0, 0), 60);
    rig.update(input, 1 / 60, target(20, 0, true));
    expect(rig.focusX).toBe(20);
  });

  it('без snap-флага цель догоняется сглаживанием', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    settle(rig, input, target(0, 0), 60);
    rig.update(input, 1 / 60, target(20, 0));
    expect(rig.focusX).toBeGreaterThan(0);
    expect(rig.focusX).toBeLessThan(5);
  });

  /**
   * Порогом владеет CAM-5, а не политика рендера: та применяет snap по РОДУ
   * разрыва (спавн, телепорт, rewind), величины у неё нет. Поэтому
   * подпороговый телепорт камера доводит сглаживанием — «расхождение политик
   * намеренно».
   */
  it('подпороговый разрыв со snap-флагом доводится сглаживанием (CAM-5)', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0, config: { snapDistance: 2 } });
    settle(rig, input, target(0, 0), 60);
    rig.update(input, 1 / 60, target(1, 0, true));
    expect(rig.focusX).toBeGreaterThan(0);
    expect(rig.focusX).toBeLessThan(1);
  });

  it('порог берётся из конфига камеры: тот же разрыв при меньшем пороге — прыжок (CAM-1, CAM-5)', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0, config: { snapDistance: 0.5 } });
    settle(rig, input, target(0, 0), 60);
    rig.update(input, 1 / 60, target(1, 0, true));
    expect(rig.focusX).toBe(1);
  });

  /**
   * Сценарий «Rewind под free-камерой» с обратной стороны: перемотка поднимает
   * признак разрыва ВСЕМУ миру (`snapAll` REND-2), а герой при этом стоит.
   * Камера, слушающаяся признака, дёрнулась бы ни на чём.
   */
  it('признак разрыва при неподвижной цели камеру не двигает (CAM-5)', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    settle(rig, input, target(3, 0), 300);
    const before = rig.focusX;
    rig.update(input, 1 / 60, target(3, 0, true));
    expect(rig.focusX).toBeCloseTo(before, 10);
  });

  it('смещение меряется от прошлого кадра и после свободной панорамы (CAM-5)', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0, config: { snapDistance: 2 } });
    settle(rig, input, target(0, 0), 60);
    // Панорама открепляет камеру (CAM-3), но цель всё это время видна и стоит.
    input.panX = 1;
    settle(rig, input, target(0, 0), 30);
    input.panX = 0;
    resetCameraInput(input);
    input.followToggle = true;
    rig.update(input, 1 / 60, target(0, 0));
    resetCameraInput(input);
    // Разрыв на единицу — подпороговый и после возвращения в follow: память о
    // позиции цели свежая, а не оставшаяся с момента открепления.
    rig.update(input, 1 / 60, target(1, 0, true));
    expect(rig.focusX).not.toBe(1);
  });
});

describe('CameraRig: режимы и переходы (CAM-2)', () => {
  it('панорамирование открепляет follow → free', () => {
    const { rig, input } = makeRig();
    expect(rig.mode).toBe('follow');
    input.panX = 1;
    rig.update(input, 1 / 60, target(0, 0));
    expect(rig.mode).toBe('free');
  });

  it('centerTap перелетает к герою, оставаясь в free', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    input.panX = 1;
    settle(rig, input, target(10, 10), 30);
    input.panX = 0;
    input.centerTap = true;
    rig.update(input, 1 / 60, target(10, 10));
    input.centerTap = false;
    settle(rig, input, target(10, 10), 300);
    expect(rig.mode).toBe('free');
    expect(rig.focusX).toBeCloseTo(10, 0);
    expect(rig.focusY).toBeCloseTo(10, 0);
  });

  it('followToggle возвращает залипающий follow', () => {
    const { rig, input } = makeRig();
    input.panX = 1;
    rig.update(input, 1 / 60, target(0, 0));
    input.panX = 0;
    input.followToggle = true;
    rig.update(input, 1 / 60, target(0, 0));
    expect(rig.mode).toBe('follow');
  });

  it('fly перехватывает клавиатуру движения и летает сам', () => {
    const { rig, input } = makeRig();
    expect(rig.capturesMovement()).toBe(false);
    input.flyToggle = true;
    const before = rig.update(input, 1 / 60, target(0, 0));
    // Поза переиспользуется (CAM-1) — снимаем значения до полёта.
    const beforeY = before.posY;
    input.flyToggle = false;
    expect(rig.mode).toBe('fly');
    expect(rig.capturesMovement()).toBe(true);
    input.moveY = 1; // вперёд: при yaw = π/2 полёт уходит в +Y
    settle(rig, input, null, 60);
    const after = rig.update(input, 1 / 60, null);
    expect(after.posY).toBeGreaterThan(beforeY + 1);
    // Выход — обратно в free-RTS.
    input.moveY = 0;
    input.flyToggle = true;
    rig.update(input, 1 / 60, null);
    expect(rig.mode).toBe('free');
    expect(rig.capturesMovement()).toBe(false);
  });
});

describe('CameraRig: зум (CAM-4)', () => {
  const distanceOf = (rig: CameraRig, input: CameraInput): number => {
    const pose = rig.update(input, 1 / 60, null);
    return (pose.posZ - rig.groundZ) / Math.sin(rig.config.pitch);
  };

  it('колесо клампится к min/max без рывков', () => {
    const { rig, input } = makeRig();
    input.wheelSteps = 100; // далеко за лимит
    rig.update(input, 1 / 60, null);
    input.wheelSteps = 0;
    settle(rig, input, null, 600);
    expect(distanceOf(rig, input)).toBeCloseTo(rig.config.maxDistance, 1);
    input.wheelSteps = -100;
    rig.update(input, 1 / 60, null);
    input.wheelSteps = 0;
    settle(rig, input, null, 600);
    expect(distanceOf(rig, input)).toBeCloseTo(rig.config.minDistance, 1);
  });

  it('зум переживает смену режима free ↔ follow', () => {
    const { rig, input } = makeRig();
    input.wheelSteps = 100;
    rig.update(input, 1 / 60, target(0, 0));
    input.wheelSteps = 0;
    settle(rig, input, target(0, 0), 600);
    const zoomed = distanceOf(rig, input);
    input.followToggle = true;
    rig.update(input, 1 / 60, target(0, 0));
    input.followToggle = false;
    settle(rig, input, target(0, 0), 60);
    expect(distanceOf(rig, input)).toBeCloseTo(zoomed, 1);
  });
});

describe('CameraRig: границы арены (CAM-3)', () => {
  it('точка наблюдения останавливается на границе с запасом', () => {
    const { rig, input } = makeRig({
      bounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
      startX: 12,
      startY: 12,
    });
    input.panX = 1;
    settle(rig, input, null, 1200);
    expect(rig.focusX).toBeCloseTo(24 - rig.config.boundsMargin, 3);
  });
});

describe('CameraRig: переподача источников (CAM-7)', () => {
  /** Дистанция камеры по позе — зум переживает переподачу (CAM-4). */
  const distanceOf = (rig: CameraRig, input: CameraInput): number => {
    const pose = rig.update(input, 1 / 60, null);
    return (pose.posZ - rig.groundZ) / Math.sin(rig.config.pitch);
  };

  /** Суммарный |roll| эффектов за несколько кадров: стек ещё работает (CAM-6). */
  const rollOver = (stack: EffectStack, rig: CameraRig, input: CameraInput, frames: number): number => {
    let total = 0;
    for (let i = 0; i < frames; i++) {
      total += Math.abs(stack.apply(rig.update(input, 1 / 60, null), 1 / 60).roll);
    }
    return total;
  };

  it('уменьшившаяся арена приводит точку наблюдения внутрь ближайшим положением', () => {
    const { rig, input } = makeRig({
      bounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
      startX: 20,
      startY: 4,
    });
    input.panX = 1; // открепляет камеру в free-RTS (CAM-2)
    settle(rig, input, null, 1200);
    input.panX = 0;
    const margin = rig.config.boundsMargin;
    expect(rig.focusX).toBeCloseTo(24 - margin, 3);

    rig.setSources({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
    // X был за новым краем — прижался к нему с тем же запасом; Y был внутри и
    // не сдвинулся: ближайшее положение, а не центр и не стартовая точка.
    expect(rig.focusX).toBeCloseTo(10 - margin, 6);
    expect(rig.focusY).toBeCloseTo(4, 6);
  });

  it('переподача границ не трогает режим, зум и стек эффектов', () => {
    const { rig, input } = makeRig({
      bounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
      startX: 20,
      startY: 4,
    });
    input.panX = 1;
    rig.update(input, 1 / 60, target(0, 0));
    input.panX = 0;
    input.wheelSteps = 100; // отдалить за лимит (CAM-4)
    rig.update(input, 1 / 60, null);
    input.wheelSteps = 0;
    settle(rig, input, null, 600);

    const stack = new EffectStack();
    const shake = new TraumaShake();
    stack.add(shake);
    shake.trigger(1);
    expect(rollOver(stack, rig, input, 5)).toBeGreaterThan(0);
    const zoomBefore = distanceOf(rig, input);
    expect(rig.mode).toBe('free');

    rig.setSources({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });

    expect(rig.mode).toBe('free');
    expect(distanceOf(rig, input)).toBeCloseTo(zoomBefore, 3);
    // Стек живёт у потребителя и переподачей не задет — пересоздание камеры
    // отняло бы и его вместе с накопленной trauma.
    expect(rollOver(stack, rig, input, 5)).toBeGreaterThan(0);
  });

  it('без переподачи конвейер работает по прежним значениям', () => {
    const { rig, input } = makeRig({
      bounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
      startX: 12,
      startY: 12,
    });
    input.panX = 1;
    settle(rig, input, null, 1200);
    const margin = rig.config.boundsMargin;
    expect(rig.focusX).toBeCloseTo(24 - margin, 3);

    // Пустая переподача и переподача одной только поверхности границ не трогают.
    rig.setSources({});
    rig.setSources({ groundHeightAt: () => 3 });
    settle(rig, input, null, 60);
    expect(rig.focusX).toBeCloseTo(24 - margin, 3);
  });

  it('источник поверхности отвечает по действующей сетке, а не по той, над которой создан', () => {
    const ground = terrainGroundApi(flatGrid(4, 4, 0), 0.6);
    const { rig, input } = makeRig({
      groundHeightAt: ground.groundHeightAt,
      bounds: ground.bounds,
      startX: 2,
      startY: 2,
    });
    settle(rig, input, null, 300);
    expect(rig.groundZ).toBeCloseTo(0, 6);

    // Автор поднял уровень: пересчитанная ядром сетка приезжает НОВЫМ объектом
    // (rendering REND-14) — снимок при создании отвечал бы по прежней арене.
    ground.setGrid(flatGrid(4, 4, 2));
    rig.update(input, 1 / 60, null);
    expect(rig.groundZ).toBeGreaterThan(0);
    expect(rig.groundZ).toBeLessThan(0.6); // сглаженно, не скачком за кадр (CAM-2)
    settle(rig, input, null, 300);
    expect(rig.groundZ).toBeCloseTo(1.2, 3);
  });

  it('границы источника отвечают по новой сетке и переподаются камере как есть', () => {
    const ground = terrainGroundApi(flatGrid(24, 24, 0), 0.6);
    const { rig, input } = makeRig({
      groundHeightAt: ground.groundHeightAt,
      bounds: ground.bounds,
      startX: 20,
      startY: 20,
    });
    settle(rig, input, null, 60);

    ground.setGrid(flatGrid(10, 10, 0));
    expect(ground.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });

    // Источник и есть набор, который принимает конвейер (CAM-7).
    rig.setSources(ground);
    const margin = rig.config.boundsMargin;
    expect(rig.focusX).toBeCloseTo(10 - margin, 6);
    expect(rig.focusY).toBeCloseTo(10 - margin, 6);
  });
});

describe('вспомогательные функции камеры', () => {
  it('edgePanAxes: оси у краёв, ноль в центре и вне канваса', () => {
    const rect = { left: 0, top: 0, width: 200, height: 100 };
    expect(edgePanAxes(100, 50, rect, 20)).toEqual({ x: 0, y: 0 });
    expect(edgePanAxes(0, 50, rect, 20).x).toBe(-1);
    expect(edgePanAxes(200, 50, rect, 20).x).toBe(1);
    expect(edgePanAxes(100, 0, rect, 20).y).toBe(1); // экранный верх — мировой север
    expect(edgePanAxes(100, 100, rect, 20).y).toBe(-1);
    expect(edgePanAxes(-5, 50, rect, 20)).toEqual({ x: 0, y: 0 });
  });

  it('terrainGroundApi: уровень клифа клетки × шаг высоты и границы сетки', () => {
    const grid = {
      width: 2,
      height: 1,
      tileSize: FIXED_ONE,
      levels: new Uint8Array([0, 2]),
      ramps: new Uint8Array([0, 0]),
      floor: new Uint8Array([1, 1]),
      cliffs: [],
    } as unknown as TerrainGrid;
    const ground = terrainGroundApi(grid, 0.6);
    expect(ground.groundHeightAt(0.5, 0.5)).toBe(0);
    expect(ground.groundHeightAt(1.5, 0.5)).toBeCloseTo(1.2, 6);
    expect(ground.groundHeightAt(99, 99)).toBeCloseTo(1.2, 6); // кламп к крайней клетке
    expect(ground.bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 });
  });
});

/**
 * Посадка позы на THREE-камеру (CAM-1). Проверяется наблюдаемое — оси кадра,
 * которые получились, — а не то, какими вызовами они получены.
 */
describe('applyCameraPose: оси кадра из позы', () => {
  /** Орты кадра из матрицы камеры: вправо, вверх и взгляд. */
  function axesOf(pose: CameraPose, up: [number, number, number]): Record<string, number[]> {
    const camera = new THREE.PerspectiveCamera(pose.fovDeg, 4 / 3, 0.1, 300);
    camera.up.set(...up);
    applyCameraPose(camera, pose);
    camera.updateMatrixWorld(true);
    const basis = new THREE.Matrix4().extractRotation(camera.matrixWorld).elements;
    return {
      right: [basis[0], basis[1], basis[2]],
      up: [basis[4], basis[5], basis[6]],
      // Камера смотрит по своему −Z (соглашение THREE).
      forward: [-basis[8], -basis[9], -basis[10]],
    };
  }

  it('невырожденная поза: взгляд, вбок и вверх — те самые орты, которыми считает конвейер', () => {
    const pose: CameraPose = {
      posX: 1,
      posY: 2,
      posZ: 8,
      yaw: 0.6,
      pitch: 0.5,
      roll: 0,
      fovDeg: 45,
    };
    const cosP = Math.cos(pose.pitch);
    const sinP = Math.sin(pose.pitch);
    const axes = axesOf(pose, [0, 0, 1]);
    const expected = {
      forward: [Math.cos(pose.yaw) * cosP, Math.sin(pose.yaw) * cosP, -sinP],
      right: [Math.sin(pose.yaw), -Math.cos(pose.yaw), 0],
      up: [sinP * Math.cos(pose.yaw), sinP * Math.sin(pose.yaw), cosP],
    };
    for (const name of ['forward', 'right', 'up']) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(axes[name]![axis]).toBeCloseTo(expected[name as keyof typeof expected][axis]!, 6);
      }
    }
  });

  it('взгляд ровно в надир не сбивает ось взгляда и следует yaw, а не вырождению lookAt', () => {
    const pose: CameraPose = {
      posX: 1,
      posY: 2,
      posZ: 8,
      yaw: 0.6,
      pitch: Math.PI / 2,
      roll: 0,
      fovDeg: 45,
    };
    const axes = axesOf(pose, [0, 0, 1]);
    // Взгляд — строго вниз: сдвига оси, которым `lookAt` разрешает вырождение,
    // в кадре нет.
    expect(axes.forward![0]).toBeCloseTo(0, 9);
    expect(axes.forward![1]).toBeCloseTo(0, 9);
    expect(axes.forward![2]).toBeCloseTo(-1, 9);
    // Верх экрана — предел соседних поз: горизонтальное направление yaw.
    expect(axes.up![0]).toBeCloseTo(Math.cos(pose.yaw), 6);
    expect(axes.up![1]).toBeCloseTo(Math.sin(pose.yaw), 6);
    expect(axes.up![2]).toBeCloseTo(0, 6);
  });
});

/**
 * Кадрирование по заданным границам (CAM-8). Проверяется не «дистанция равна
 * такому-то числу» — это была бы вторая реализация той же формулы, — а само
 * утверждение требования: прямоугольник попадает в кадр. Попадание считается
 * по позе, которую отдал конвейер, и по поданным пропорциям.
 */
const HALF_FOV = (fovDeg: number): number => Math.tan(((fovDeg / 2) * Math.PI) / 180);

/** Лежат ли все углы наземного прямоугольника внутри пирамиды видимости позы. */
function rectInFrame(
  pose: CameraPose,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  aspect: number,
  groundZ: number,
): boolean {
  const tanV = HALF_FOV(pose.fovDeg);
  const tanH = tanV * aspect;
  const cosP = Math.cos(pose.pitch);
  const sinP = Math.sin(pose.pitch);
  // Оси кадра: взгляд, вбок и вверх — те же, что применяет `applyCameraPose`.
  const f = [Math.cos(pose.yaw) * cosP, Math.sin(pose.yaw) * cosP, -sinP];
  const r = [Math.sin(pose.yaw), -Math.cos(pose.yaw), 0];
  const u = [sinP * Math.cos(pose.yaw), sinP * Math.sin(pose.yaw), cosP];
  for (const x of [rect.minX, rect.maxX]) {
    for (const y of [rect.minY, rect.maxY]) {
      const v = [x - pose.posX, y - pose.posY, groundZ - pose.posZ];
      const dot = (a: number[]): number =>
        (a[0] ?? 0) * (v[0] ?? 0) + (a[1] ?? 0) * (v[1] ?? 0) + (a[2] ?? 0) * (v[2] ?? 0);
      const depth = dot(f);
      // Допуск в микрон: сравниваются два разных прохода одной геометрии.
      if (depth <= 0) return false;
      if (Math.abs(dot(r)) > depth * tanH + 1e-6) return false;
      if (Math.abs(dot(u)) > depth * tanV + 1e-6) return false;
    }
  }
  return true;
}

const arena = (size: number): { minX: number; minY: number; maxX: number; maxY: number } => ({
  minX: 0,
  minY: 0,
  maxX: size,
  maxY: size,
});

describe('CameraRig: кадрирование по заданным границам (CAM-8)', () => {
  it('прямоугольник попадает в кадр при разных пропорциях', () => {
    const rect = arena(14);
    for (const aspect of [0.75, 1, 16 / 9, 2.5]) {
      const { rig, input } = makeRig();
      rig.frameBounds({ rect, aspect, immediate: true });
      const pose = rig.update(input, 1 / 60, null);
      expect(rig.focusX, `aspect ${aspect}`).toBeCloseTo(7, 6);
      expect(rig.focusY, `aspect ${aspect}`).toBeCloseTo(7, 6);
      expect(rectInFrame(pose, rect, aspect, rig.groundZ), `aspect ${aspect}`).toBe(true);
    }
  });

  it('пропорции подаёт потребитель: узкий кадр отодвигает камеру дальше широкого', () => {
    const rect = arena(14);
    const far = makeRig();
    far.rig.frameBounds({ rect, aspect: 0.75, immediate: true });
    const near = makeRig();
    near.rig.frameBounds({ rect, aspect: 2.5, immediate: true });
    const distance = (made: { rig: CameraRig; input: CameraInput }): number => {
      const pose = made.rig.update(made.input, 1 / 60, null);
      return Math.hypot(pose.posX - made.rig.focusX, pose.posY - made.rig.focusY, pose.posZ);
    };
    expect(distance(far)).toBeGreaterThan(distance(near));
  });

  it('арена, не влезающая в пределы зума, кадрируется на пределе, а не отказом', () => {
    const rect = arena(400);
    const { rig, input } = makeRig();
    rig.frameBounds({ rect, aspect: 16 / 9, immediate: true });
    const pose = rig.update(input, 1 / 60, null);
    expect(rig.focusX).toBeCloseTo(200, 6);
    expect(rig.focusY).toBeCloseTo(200, 6);
    const distance = Math.hypot(pose.posX - rig.focusX, pose.posY - rig.focusY, pose.posZ);
    expect(distance).toBeCloseTo(rig.config.maxDistance, 6);
  });

  it('мгновенное применение даёт дистанцию на первом же update, сглаженное — приезжает', () => {
    const rect = arena(14);
    const distanceOf = (rig: CameraRig, input: CameraInput): number => {
      const pose = rig.update(input, 1 / 60, null);
      return Math.hypot(pose.posX - rig.focusX, pose.posY - rig.focusY, pose.posZ);
    };
    const instant = makeRig();
    instant.rig.frameBounds({ rect, aspect: 16 / 9, immediate: true });
    const wanted = distanceOf(instant.rig, instant.input);

    const eased = makeRig();
    eased.rig.frameBounds({ rect, aspect: 16 / 9 });
    const first = distanceOf(eased.rig, eased.input);
    expect(Math.abs(first - wanted)).toBeGreaterThan(0.1);
    settle(eased.rig, eased.input, null, 300);
    expect(distanceOf(eased.rig, eased.input)).toBeCloseTo(wanted, 3);
  });

  it('после кадрирования работают панорама и зум, и следующий кадр не возвращает вид', () => {
    const rect = arena(14);
    const { rig, input } = makeRig();
    rig.frameBounds({ rect, aspect: 16 / 9, immediate: true });
    rig.update(input, 1 / 60, null);
    const framed = { x: rig.focusX, y: rig.focusY };

    // Разовость: кадрирование никто не запрашивал заново.
    settle(rig, input, null, 60);
    expect(rig.focusX).toBeCloseTo(framed.x, 6);
    expect(rig.focusY).toBeCloseTo(framed.y, 6);

    input.panX = 1;
    settle(rig, input, null, 30);
    expect(rig.focusX).toBeGreaterThan(framed.x);
    input.panX = 0;

    const before = rig.update(input, 1 / 60, null);
    const distance = Math.hypot(before.posX - rig.focusX, before.posY - rig.focusY);
    input.wheelSteps = 3;
    rig.update(input, 1 / 60, null);
    resetCameraInput(input);
    settle(rig, input, null, 120);
    const after = rig.update(input, 1 / 60, null);
    expect(Math.hypot(after.posX - rig.focusX, after.posY - rig.focusY)).toBeGreaterThan(distance);
  });

  it('кадрирование в облёте не меняет режима и видно после выхода из него', () => {
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    input.flyToggle = true;
    rig.update(input, 1 / 60, null);
    resetCameraInput(input);
    expect(rig.mode).toBe('fly');
    const inFly = rig.update(input, 1 / 60, null);

    rig.frameBounds({ rect: arena(14), aspect: 16 / 9, immediate: true });
    const stillFlying = rig.update(input, 1 / 60, null);
    expect(rig.mode).toBe('fly');
    // Поза облёта своя (CAM-2) и кадрированием не тронута.
    expect(stillFlying.posX).toBeCloseTo(inFly.posX, 6);
    expect(stillFlying.posY).toBeCloseTo(inFly.posY, 6);

    input.flyToggle = true;
    rig.update(input, 1 / 60, null);
    resetCameraInput(input);
    expect(rig.mode).toBe('free');
    expect(rig.focusX).toBeCloseTo(7, 6);
    expect(rig.focusY).toBeCloseTo(7, 6);
  });

  it('точка наблюдения клампится инжектированными границами, а не поданным прямоугольником', () => {
    // Кадрируют по аргументу, а клампят по инжектированному (CAM-3, CAM-7):
    // прямоугольник смещён за пределы арены, и центр его туда не уводит.
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const rect = { minX: 40, minY: 40, maxX: 54, maxY: 54 };
    const instant = makeRig({ bounds });
    instant.rig.frameBounds({ rect, aspect: 16 / 9, immediate: true });
    instant.rig.update(instant.input, 1 / 60, null);
    const margin = instant.rig.config.boundsMargin;
    expect(instant.rig.focusX).toBeCloseTo(10 - margin, 6);
    expect(instant.rig.focusY).toBeCloseTo(10 - margin, 6);

    // Перелёт клампится тем же — и потому доезжает: назначение за границами
    // арены оставило бы его незавершённым навсегда.
    const eased = makeRig({ bounds });
    eased.rig.frameBounds({ rect, aspect: 16 / 9 });
    settle(eased.rig, eased.input, null, 120);
    expect(eased.rig.focusX).toBeCloseTo(10 - margin, 6);
    expect(eased.rig.focusY).toBeCloseTo(10 - margin, 6);
  });

  it('сглаженное применение — перелёт точки наблюдения, а не её телепорт', () => {
    // «Оба применения» CAM-8: мгновенное ставит точку наблюдения сразу,
    // сглаженное ведёт её тем же сглаживанием, что и прочие переходы (CAM-2).
    // Половина кадра, прыгающая при сглаженной дистанции, перелётом не была бы.
    const rect = arena(14);
    const { rig, input } = makeRig({ startX: 0, startY: 0 });
    rig.frameBounds({ rect, aspect: 16 / 9 });
    rig.update(input, 1 / 60, null);
    expect(rig.focusX).toBeGreaterThan(0);
    expect(rig.focusX).toBeLessThan(6.5);
    settle(rig, input, null, 240);
    expect(rig.focusX).toBeCloseTo(7, 6);
    expect(rig.focusY).toBeCloseTo(7, 6);

    // Разовость перелёта: взявшего камеру в руки автора он не тянет обратно.
    const taken = makeRig({ startX: 0, startY: 0 });
    taken.rig.frameBounds({ rect, aspect: 16 / 9 });
    taken.input.panX = -1;
    settle(taken.rig, taken.input, null, 10);
    taken.input.panX = 0;
    const stopped = taken.rig.focusX;
    settle(taken.rig, taken.input, null, 120);
    expect(taken.rig.focusX).toBeCloseTo(stopped, 6);
  });

  it('кадр нулевого размера не даёт NaN: горизонталь просто не ограничивает', () => {
    const { rig, input } = makeRig();
    rig.frameBounds({ rect: arena(14), aspect: 0, immediate: true });
    const pose = rig.update(input, 1 / 60, null);
    expect(Number.isFinite(pose.posX) && Number.isFinite(pose.posZ)).toBe(true);
  });
});
