/**
 * CameraRig (camera CAM-1..5, CAM-7): конвейер позы без WebGL — поза как
 * данные, follow по x/y с высотой по поверхности, режимы и Dota-переходы, зум,
 * кламп к границам, snap без проезда, маршрутизация ввода героя, переподача
 * инжектированных источника поверхности и границ.
 */
import { describe, expect, it } from 'vitest';
import {
  CameraRig,
  EffectStack,
  TraumaShake,
  createCameraInput,
  edgePanAxes,
  terrainGroundApi,
  type CameraInput,
  type CameraRigOptions,
  type FollowTarget,
} from '../src/index.js';
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';

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
    shake.addTrauma(1);
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
