/**
 * ED-13: «Вьюпорт редактора SHALL получать позу камеры конвейером capability
 * `camera` (CAM-1, CAM-7)… Собственный контроллер камеры редактора MUST NOT
 * существовать». ED-15 требует в режиме правки как минимум free-RTS и fly.
 *
 * Проверяется ровно шов: сэмпл ввода редактора доходит до конвейера и меняет
 * позу, а сама поза считается конвейером — здесь нет ни одной ожидаемой
 * величины, которую редактор посчитал бы сам. Прогон headless, как и требует
 * сценарий CAM-1 «Headless-тест позы»: WebGL не создаётся.
 */
import { describe, expect, it } from 'vitest';
import { createTerrainGrid } from '@game-mvp/core';
import { CAMERA_KEYS, createSceneCamera } from '../src/areas/sceneCamera.js';

const HEIGHT_STEP = 0.6;

/**
 * Арена теста — своя и большая: запас границ конвейера (CAM-3) больше
 * четырёх клеток фикстуры документов, и на ней панорамировать было бы негде.
 * Правая половина — плато уровня 1.
 */
const SIZE = 32;
const terrainDef = (levels: readonly string[]) => ({
  width: SIZE,
  height: SIZE,
  tileSize: 65536,
  levels,
  flags: Array.from({ length: SIZE }, () => '.'.repeat(SIZE)),
});
const HALF_PLATEAU = Array.from({ length: SIZE }, () =>
  '0'.repeat(SIZE / 2) + '1'.repeat(SIZE / 2),
);

function camera(): ReturnType<typeof createSceneCamera> {
  return createSceneCamera({
    grid: createTerrainGrid(terrainDef(HALF_PLATEAU)),
    heightStep: HEIGHT_STEP,
  });
}

/** Несколько кадров с зажатыми клавишами — так же, как их подаёт кадровый цикл. */
function hold(
  rig: ReturnType<typeof createSceneCamera>,
  keys: readonly string[],
  frames = 30,
): void {
  const held = new Set(keys);
  for (let step = 0; step < frames; step++) {
    rig.sample(held, null);
    rig.frame(1 / 60);
  }
}

describe('ED-15, CAM-3: free-RTS доступен и панорамирует по документу террейна', () => {
  it('клавиша панорамы двигает точку наблюдения', () => {
    const rig = camera();
    const before = rig.focusX;
    hold(rig, [CAMERA_KEYS.panRight]);
    expect(rig.focusX).toBeGreaterThan(before);
  });

  it('точка наблюдения не уходит за границы арены документа (CAM-3, CAM-7)', () => {
    const rig = camera();
    hold(rig, [CAMERA_KEYS.panRight], 900);
    // Арена — SIZE клеток по единице; запас конфига камеры сверх неё конечен.
    expect(rig.focusX).toBeLessThan(SIZE * 2);
  });

  it('высота точки наблюдения следует уровню под ней, а не задаётся редактором', () => {
    const rig = camera();
    // Старт — центр арены, то есть край плато уровня 1; сглаживание высоты
    // конвейера успевает дойти до поверхности за первые кадры (CAM-2).
    hold(rig, [], 180);
    const onPlateau = rig.frame(1 / 60).posZ;
    hold(rig, [CAMERA_KEYS.panLeft], 300);
    expect(rig.frame(1 / 60).posZ).toBeLessThan(onPlateau);
  });
});

describe('ED-15, CAM-2: облёт — режим конвейера, а не второй способ считать позу', () => {
  it('переключатель включает и выключает fly', () => {
    const rig = camera();
    expect(rig.flying).toBe(false);
    rig.toggleFly();
    rig.frame(1 / 60);
    expect(rig.flying).toBe(true);
    rig.toggleFly();
    rig.frame(1 / 60);
    expect(rig.flying).toBe(false);
  });

  it('клавиши перемещения работают только в облёте — вне его они не камерины', () => {
    const grounded = camera();
    const before = grounded.frame(1 / 60);
    const groundedAt = { x: before.posX, y: before.posY };
    hold(grounded, [CAMERA_KEYS.flyForward]);
    const after = grounded.frame(1 / 60);
    expect(after.posX).toBeCloseTo(groundedAt.x, 6);
    expect(after.posY).toBeCloseTo(groundedAt.y, 6);

    const flying = camera();
    flying.toggleFly();
    flying.frame(1 / 60);
    const start = flying.frame(1 / 60);
    const from = { x: start.posX, y: start.posY, z: start.posZ };
    hold(flying, [CAMERA_KEYS.flyForward]);
    const moved = flying.frame(1 / 60);
    expect(Math.hypot(moved.posX - from.x, moved.posY - from.y, moved.posZ - from.z)).toBeGreaterThan(0.5);
  });
});

describe('CAM-4, CAM-7: зум и переподача источников работающему конвейеру', () => {
  it('колесо меняет дистанцию, а не позицию точки наблюдения', () => {
    const rig = camera();
    const before = rig.frame(1 / 60);
    const distance = Math.hypot(before.posX - rig.focusX, before.posY - rig.focusY);
    rig.zoom(3);
    for (let step = 0; step < 60; step++) rig.frame(1 / 60);
    const after = rig.frame(1 / 60);
    expect(Math.hypot(after.posX - rig.focusX, after.posY - rig.focusY)).toBeGreaterThan(distance);
  });

  it('правка карты уровней под камерой не требует перезапуска конвейера', () => {
    const rig = camera();
    for (let step = 0; step < 120; step++) rig.frame(1 / 60);
    const flat = rig.frame(1 / 60).posZ;
    // Кисть уровней (ED-10) отдаёт пересчитанную ядром сетку целиком.
    rig.setGrid(
      createTerrainGrid(terrainDef(Array.from({ length: SIZE }, () => '3'.repeat(SIZE)))),
    );
    for (let step = 0; step < 240; step++) rig.frame(1 / 60);
    expect(rig.frame(1 / 60).posZ).toBeGreaterThan(flat + HEIGHT_STEP);
  });
});
