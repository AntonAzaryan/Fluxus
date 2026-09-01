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
import { createTerrainGrid } from '@fluxus/core';
import {
  CameraRig,
  DEFAULT_CAMERA_CONFIG,
  cameraConfigFromManifest,
  createCameraInput,
  terrainGroundApi,
} from '@fluxus/render';
import { CAMERA_KEYS, EDITOR_CAMERA_CONFIG, createSceneCamera } from '../src/areas/sceneCamera.js';

const HEIGHT_STEP = 0.6;

/** Пустой сэмпл ввода: игровой кадр сравнения никто не двигает. */
const EMPTY_INPUT = createCameraInput();

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

/**
 * Кадр без террейна (ED-20, REND-11): арены у превью ассета нет вовсе, и
 * подсунуть конвейеру выдуманную значило бы клампить камеру по несуществующему.
 * Проверяется, что это тот же конвейер без источников (CAM-7), а не второй
 * способ считать позу.
 */
describe('ED-13, CAM-7: конвейер без источников — кадр без террейна', () => {
  it('поза выдаётся и ввод её меняет, хотя ни границ, ни поверхности нет', () => {
    const rig = createSceneCamera({ heightStep: HEIGHT_STEP });
    const pose = rig.frame(1 / 60);
    expect(Number.isFinite(pose.posX) && Number.isFinite(pose.posZ)).toBe(true);
    const before = rig.focusX;
    // Границ нет — и панораме нечем упереться: клампа арены не существует.
    hold(rig, [CAMERA_KEYS.panRight]);
    expect(rig.focusX).toBeGreaterThan(before);
  });

  it('первая сетка заводит источник, а не остаётся неуслышанной', () => {
    const rig = createSceneCamera({ heightStep: HEIGHT_STEP });
    for (let step = 0; step < 120; step++) rig.frame(1 / 60);
    const flat = rig.frame(1 / 60).posZ;
    rig.setGrid(
      createTerrainGrid(terrainDef(Array.from({ length: SIZE }, () => '5'.repeat(SIZE)))),
    );
    for (let step = 0; step < 240; step++) rig.frame(1 / 60);
    expect(rig.frame(1 / 60).posZ).toBeGreaterThan(flat + HEIGHT_STEP);
  });
});

/**
 * Стартовый и обзорный кадр (ED-15) через вход кадрирования конвейера (CAM-8).
 * Ни одной ожидаемой величины редактор здесь не считает: проверяется, что
 * кадрирование запрошено по границам арены, отданным тем же источником, что
 * инжектирован в конвейер, и что после него камера работает как обычно.
 */
const OVERVIEW = 20;
const overviewGrid = () =>
  createTerrainGrid({
    width: OVERVIEW,
    height: OVERVIEW,
    tileSize: 65536,
    levels: Array.from({ length: OVERVIEW }, () => '0'.repeat(OVERVIEW)),
    flags: Array.from({ length: OVERVIEW }, () => '.'.repeat(OVERVIEW)),
  });

/** Горизонтальный вынос камеры от точки наблюдения — он монотонен по дистанции. */
function reach(rig: ReturnType<typeof createSceneCamera>): number {
  const pose = rig.frame(1 / 60);
  return Math.hypot(pose.posX - rig.focusX, pose.posY - rig.focusY);
}

describe('ED-15, CAM-8: стартовый и обзорный кадр — кадрированием, а не своей позой', () => {
  it('границы арены отдаёт тот же источник, что инжектирован в конвейер', () => {
    const rig = createSceneCamera({ grid: overviewGrid(), heightStep: HEIGHT_STEP });
    expect(rig.arena).toEqual({ minX: 0, minY: 0, maxX: OVERVIEW, maxY: OVERVIEW });
    // Кадра без террейна арена не касается вовсе (ED-20).
    expect(createSceneCamera({ heightStep: HEIGHT_STEP }).arena).toBeNull();
  });

  it('первый же кадр после мгновенного кадрирования — обзорный', () => {
    const rig = createSceneCamera({ grid: overviewGrid(), heightStep: HEIGHT_STEP });
    const arena = rig.arena;
    expect(arena).not.toBeNull();
    const close = reach(rig);
    rig.frameBounds(arena ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 16 / 9, true);
    const framed = reach(rig);
    // Обзор дальше стартовой игровой дистанции — арена в кадре целиком.
    expect(framed).toBeGreaterThan(close);
    expect(rig.focusX).toBeCloseTo(OVERVIEW / 2, 6);
    expect(rig.focusY).toBeCloseTo(OVERVIEW / 2, 6);
    // Перелёта автор не видит: следующие кадры дистанцию не двигают.
    for (let step = 0; step < 60; step++) rig.frame(1 / 60);
    expect(reach(rig)).toBeCloseTo(framed, 6);
  });

  it('обзорное действие после приближения возвращает обзор и не меняет режима', () => {
    const rig = createSceneCamera({ grid: overviewGrid(), heightStep: HEIGHT_STEP });
    const arena = rig.arena ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    rig.frameBounds(arena, 16 / 9, true);
    const overview = reach(rig);

    rig.zoom(-6);
    hold(rig, [CAMERA_KEYS.panRight], 120);
    expect(reach(rig)).toBeLessThan(overview);
    expect(rig.focusX).toBeGreaterThan(OVERVIEW / 2);

    rig.frameBounds(arena, 16 / 9);
    hold(rig, [], 240);
    expect(reach(rig)).toBeCloseTo(overview, 3);
    expect(rig.focusX).toBeCloseTo(OVERVIEW / 2, 6);
    expect(rig.flying).toBe(false);
  });

  it('кадрирование в облёте режима не меняет (CAM-8)', () => {
    const rig = createSceneCamera({ grid: overviewGrid(), heightStep: HEIGHT_STEP });
    rig.toggleFly();
    rig.frame(1 / 60);
    expect(rig.flying).toBe(true);
    rig.frameBounds(rig.arena ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 16 / 9);
    rig.frame(1 / 60);
    expect(rig.flying).toBe(true);
  });
});

/**
 * Потолок зума вьюпорта редактора (ED-13, CAM-1, CAM-8).
 *
 * ED-13 требует совпадения с игровым конфигом по наклону, дистанции и FOV по
 * умолчанию; потолок зума в этот перечень не входит и остаётся настройкой
 * конвейера. Проверяется, что настройка эта РАБОТАЕТ на настоящей по размеру
 * арене: обзор не упирается в кламп (CAM-8 клампа не обходит), и отдалиться от
 * стартового кадра есть куда. Игровой конфиг при этом остаётся игровым.
 */
const ARENA = 34;
const arenaGrid = () =>
  createTerrainGrid({
    width: ARENA,
    height: ARENA,
    tileSize: 65536,
    levels: Array.from({ length: ARENA }, () => '0'.repeat(ARENA)),
    flags: Array.from({ length: ARENA }, () => '.'.repeat(ARENA)),
  });

describe('ED-13, CAM-1: потолок зума кадра правки поднят конфигом, а не обходом клампа', () => {
  it('игрового умолчания работа не касается', () => {
    expect(DEFAULT_CAMERA_CONFIG.maxDistance).toBe(28);
    expect(EDITOR_CAMERA_CONFIG.maxDistance).toBeGreaterThan(DEFAULT_CAMERA_CONFIG.maxDistance);
  });

  it('обзор арены 34×34 не обрезается потолком', () => {
    const rig = createSceneCamera({ grid: arenaGrid(), heightStep: HEIGHT_STEP });
    const arena = rig.arena ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    rig.frameBounds(arena, 1, true);
    // Эталон — тот же конвейер с заведомо недостижимым потолком: совпадение
    // означает, что кадрирование не упёрлось в кламп. Ожидаемой величины
    // редактор не считает — её считает конвейер (ED-13).
    const free = createSceneCamera({
      grid: arenaGrid(),
      heightStep: HEIGHT_STEP,
      config: { maxDistance: Number.MAX_SAFE_INTEGER },
    });
    free.frameBounds(arena, 1, true);
    expect(reach(rig)).toBeCloseTo(reach(free), 6);

    // С игровым потолком тот же обзор обрезается — иначе проверка выше пуста.
    const game = createSceneCamera({
      grid: arenaGrid(),
      heightStep: HEIGHT_STEP,
      config: { maxDistance: DEFAULT_CAMERA_CONFIG.maxDistance },
    });
    game.frameBounds(arena, 1, true);
    expect(reach(game)).toBeLessThan(reach(rig));
  });

  it('от стартового кадра есть куда отдалиться', () => {
    const rig = createSceneCamera({ grid: arenaGrid(), heightStep: HEIGHT_STEP });
    rig.frameBounds(rig.arena ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 1, true);
    const overview = reach(rig);
    rig.zoom(4);
    hold(rig, [], 180);
    expect(reach(rig)).toBeGreaterThan(overview);
  });
});

/**
 * ED-13: «Превью игрового кадра SHALL идти с тем же конфигом камеры, что и
 * игровой клиент: наклон, дистанция и FOV по умолчанию совпадают».
 *
 * Адрес этих чисел один — секция конфига камеры манифеста визуалов (ASSET-10),
 * и игровой клиент читает её тем же `cameraConfigFromManifest`. Проверяется
 * именно совпадение поз, а не совпадение чисел: сравнивать числа значило бы
 * посчитать позу в редакторе второй раз (ED-13 это запрещает).
 */
describe('ED-13, ASSET-10: кадр правки идёт с конфигом камеры манифеста', () => {
  const SECTION = { pitch: 1, distance: 20, fovDeg: 55 };

  /** Поза первого кадра: то, что автор увидит, и то, что увидит игрок. */
  const posed = (rig: ReturnType<typeof createSceneCamera>) => rig.frame(1 / 60);

  it('наклон, дистанция и FOV совпадают с игровыми — теми же числами секции', () => {
    const grid = createTerrainGrid(terrainDef(HALF_PLATEAU));
    const ground = terrainGroundApi(grid, HEIGHT_STEP);
    const game = new CameraRig({
      config: cameraConfigFromManifest(SECTION),
      groundHeightAt: ground.groundHeightAt,
      bounds: ground.bounds,
    });
    const editor = createSceneCamera({
      grid,
      heightStep: HEIGHT_STEP,
      manifest: cameraConfigFromManifest(SECTION),
    });
    // Точка наблюдения у кадра правки своя — центр арены (следить не за чем,
    // CAM-7), поэтому сравнивается форма кадра, а не абсолютные координаты.
    const gamePose = game.update(EMPTY_INPUT, 1 / 60, null);
    const editorPose = posed(editor);
    expect(editorPose.fovDeg).toBeCloseTo(gamePose.fovDeg, 6);
    expect(editorPose.pitch).toBeCloseTo(gamePose.pitch, 6);
    expect(Math.hypot(editorPose.posX - editor.focusX, editorPose.posY - editor.focusY)).toBeCloseTo(
      Math.hypot(gamePose.posX - game.focusX, gamePose.posY - game.focusY),
      6,
    );
    // Числа секции действительно другие: иначе проверка сравнивала бы умолчания
    // кода сами с собой и прошла бы и без чтения манифеста.
    expect(editorPose.fovDeg).not.toBeCloseTo(DEFAULT_CAMERA_CONFIG.fovDeg, 3);
    expect(editorPose.pitch).not.toBeCloseTo(DEFAULT_CAMERA_CONFIG.pitch, 3);
  });

  it('секции нет — кадр прежний: отсутствие секции значит умолчание кода (ASSET-10)', () => {
    const grid = createTerrainGrid(terrainDef(HALF_PLATEAU));
    const withSection = createSceneCamera({
      grid,
      heightStep: HEIGHT_STEP,
      manifest: cameraConfigFromManifest(undefined),
    });
    const without = createSceneCamera({ grid, heightStep: HEIGHT_STEP });
    expect(posed(withSection)).toEqual(posed(without));
  });

  it('потолок зума вьюпорта манифест не отменяет: это отклонение редактора (CAM-1)', () => {
    const grid = createTerrainGrid(terrainDef(HALF_PLATEAU));
    const rig = createSceneCamera({
      grid,
      heightStep: HEIGHT_STEP,
      // Игровой потолок в секции — законное значение манифеста; обзор арены в
      // редакторе от него зависеть не должен (ED-13 потолка зума не называет).
      manifest: cameraConfigFromManifest({ maxDistance: DEFAULT_CAMERA_CONFIG.maxDistance }),
    });
    rig.zoom(1000);
    hold(rig, [], 600);
    expect(reach(rig)).toBeGreaterThan(DEFAULT_CAMERA_CONFIG.maxDistance);
  });
});
