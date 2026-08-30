/**
 * Переподача манифеста визуалов работающей подсистеме моделей (REND-17):
 * граница «пересобирается/переживает», сохранение назначенного поимённо,
 * отсутствие последствий у переподачи без правок и неизменность игрового пути.
 *
 * Всё headless, без WebGL-контекста, как и остальной пакет: наблюдаемое — узлы
 * сцены, объекты инстанса и список запросов к сервису ассетов.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type EntityId } from '@fluxus/core';
import { validateCurvatureMap, type VisualManifest } from '@fluxus/assets';
import {
  ModelsSubsystem,
  VisualSurfaceSource,
  type RenderContext,
  type SurfaceNormal,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const STEP = 0.5;
const HERO: EntityId = 1;
const MODEL_ID = 'models/runner.mdx';
const OTHER_MODEL_ID = 'models/golem.mdx';

/** 4×4 без перепада уровней; наклон даёт только карта кривизны. */
function flatGrid() {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: FIXED_ONE,
    levels: ['0000', '0000', '0000', '0000'],
    flags: ['....', '....', '....', '....'],
  });
}

/** Точка на склоне бугра: нормаль здесь заметно отклонена от вертикали. */
const SLOPE_X = 0.8;
const SLOPE_Y = 2.0;

function makeManifest(): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        // Ярус назван явно (ASSET-13): без него снятие `boneControls` меняло бы
        // и ярус записи, а тест здесь ровно про то, что инстанс переподачу
        // ПЕРЕЖИВАЕТ (REND-17), а не пересобирается.
        tier: 'detailed',
        defaultSkin: 'red',
        skins: { red: { '0': 'tex/red.png' }, blue: { '0': 'tex/blue.png' } },
        animations: { states: { idle: 'Stand', move: 'Walk' } },
        boneControls: { torso: { bone: 'Bone_Chest', maxYawDeg: 72, smoothing: 18 } },
        surfaceAlign: { factor: 0 },
      },
      // Вторая запись на той же модели: по ней видно, что правка соседней
      // записи чужих инстансов не касается.
      Keeper: { model: MODEL_ID, tier: 'detailed' },
    },
  };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  readonly ctx: RenderContext;
  readonly source: VisualSurfaceSource;
  readonly assets: AssetsStub;
  readonly warnings: string[];
}

function makeRig(manifest: VisualManifest = makeManifest()): Rig {
  const assets = makeAssets();
  const warnings: string[] = [];
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: STEP },
  };
  const source = new VisualSurfaceSource(flatGrid(), { curvatureMapId: 'visuals/curve.json' });
  const subsystem = new ModelsSubsystem(manifest, {
    surface: source,
    warn: (message) => warnings.push(message),
  });
  subsystem.init(ctx);

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
  assets.resolve('terrain-curvature', 'visuals/curve.json', map.map);
  return { subsystem, ctx, source, assets, warnings };
}

/** Сущность стоит на склоне и никуда не идёт. */
function onSlope(id: EntityId = HERO, partial: Parameters<typeof makeEntityView>[1] = {}) {
  return makeEntityView(id, {
    prevX: SLOPE_X,
    currX: SLOPE_X,
    prevY: SLOPE_Y,
    currY: SLOPE_Y,
    ...partial,
  });
}

/** Угол up-вектора инстанса от вертикали, радианы. */
function tiltAngleOf(subsystem: ModelsSubsystem, entity: EntityId): number {
  const pose = subsystem.instanceFor(entity)!.pose;
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(
    new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw),
  );
  return Math.acos(Math.min(Math.max(up.z, -1), 1));
}

/** Наклон нормали поверхности в точке — эталон сравнения. */
function surfaceAngleAt(source: VisualSurfaceSource, x: number, y: number): number {
  const normal: SurfaceNormal = { x: 0, y: 0, z: 1 };
  source.current!.normalAt(x, y, normal);
  return Math.acos(Math.min(Math.max(normal.z, -1), 1));
}

function requestCount(assets: AssetsStub, id: string): number {
  return assets.requests.filter((request) => request.id === id).length;
}

/**
 * Фаза проигрываемого клипа, наблюдаемая снаружи: клип фикстуры крутит
 * `Bone_Chest` от нуля к 90°, поэтому угол кости и есть «сколько клипа
 * проиграно». Сброс действия вернул бы её к нулю — это и ловится.
 */
function clipPhaseOf(subsystem: ModelsSubsystem, entity: EntityId): number {
  const bone = subsystem.instanceFor(entity)!.model!.bonesByName.get('Bone_Chest')!;
  return bone.quaternion.angleTo(new THREE.Quaternion());
}

describe('переподача манифеста обновляет инстанс, не пересобирая его (REND-17)', () => {
  it('правка параметра наклона видна в кадре; модель, скелет и контроллер те же', () => {
    const { subsystem, source, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);

    const before = subsystem.instanceFor(HERO)!;
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(0, 6); // factor 0: вертикален
    const requestsBefore = assets.requests.length;

    const next = makeManifest();
    next.entities.Runner!.surfaceAlign = { factor: 1 };
    subsystem.applyManifest(next);
    subsystem.updateFrame(1 / 60, 1);

    const after = subsystem.instanceFor(HERO)!;
    // Инстанс тот же объект: ни модель, ни скелет, ни контроллер не пересозданы.
    expect(after.model).toBe(before.model);
    expect(after.model!.skeleton).toBe(before.model!.skeleton);
    expect(after.controller).toBe(before.controller);
    expect(after).toBe(before);
    // Ассеты заново не запрашивались — модель не перезагружалась.
    expect(assets.requests.length).toBe(requestsBefore);

    const expected = surfaceAngleAt(source, SLOPE_X, SLOPE_Y);
    expect(expected).toBeGreaterThan(0.01); // точка действительно на склоне
    // Правка действует с первого же кадра после переподачи, а дальше наклон
    // доворачивается сглаженно (REND-10): накопленное состояние переподача не
    // сбрасывает и разрывом непрерывности не является.
    expect(tiltAngleOf(subsystem, HERO)).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    expect(tiltAngleOf(subsystem, HERO)).toBeCloseTo(expected, 5);
  });

  it('правка переда записи разворачивает существующий инстанс (REND-13)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope(HERO, { facingYaw: 0 })]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);
    const model = subsystem.instanceFor(HERO)!.model;
    expect(subsystem.instanceFor(HERO)!.pose.yaw).toBeCloseTo(0, 6);

    const next = makeManifest();
    next.entities.Runner!.facingDeg = -90;
    subsystem.applyManifest(next);
    // Курс доворачивается сглаженно, поэтому мгновенности ждём от snap-тика.
    subsystem.syncTick(makeTickView([onSlope(HERO, { facingYaw: 0, snap: true })]));
    subsystem.updateFrame(1 / 60, 1);

    expect(subsystem.instanceFor(HERO)!.model).toBe(model);
    expect(subsystem.instanceFor(HERO)!.pose.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('правка масштаба записи меняет размер и габариты инстанса без пересборки (REND-15)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    const model = subsystem.instanceFor(HERO)!.model!;
    const heightBefore = model.bounds.maxZ;

    const next = makeManifest();
    next.entities.Runner!.scale = 2;
    subsystem.applyManifest(next);

    expect(subsystem.instanceFor(HERO)!.model).toBe(model);
    expect(model.bounds.maxZ).toBeCloseTo(heightBefore * 2, 6);
  });

  it('правка клипа текущего состояния меняет клип; правка чужого состояния — нет (REND-4)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(HERO)!.controller!;
    expect(controller.currentClipName).toBe('Stand - 1'); // состояние покоя
    for (let i = 0; i < 20; i++) subsystem.updateFrame(1 / 60, 1);
    const phase = clipPhaseOf(subsystem, HERO);
    expect(phase).toBeGreaterThan(0.1); // клип действительно проигрывается

    // Правка клипа состояния, в котором инстанс НЕ находится, в кадре не звучит
    // и фазу текущего клипа не сбрасывает.
    const foreign = makeManifest();
    foreign.entities.Runner!.animations = { states: { idle: 'Stand', move: 'Roll' } };
    subsystem.applyManifest(foreign);
    expect(subsystem.instanceFor(HERO)!.controller).toBe(controller);
    expect(controller.currentClipName).toBe('Stand - 1');
    subsystem.updateFrame(1 / 60, 1);
    expect(clipPhaseOf(subsystem, HERO)).toBeGreaterThan(phase);

    // Правка клипа текущего состояния — звучит, и тем же инстансом.
    const own = makeManifest();
    own.entities.Runner!.animations = { states: { idle: 'Jump Loop', move: 'Walk' } };
    subsystem.applyManifest(own);
    expect(subsystem.instanceFor(HERO)!.controller).toBe(controller);
    expect(controller.currentClipName).toBe('Jump Loop');
  });

  it('снятие контроля костей возвращает кость к значению клипа (REND-5)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope(HERO, { aimYaw: Math.PI / 2 })]));
    assets.resolve('model', MODEL_ID, makeModel());
    const model = subsystem.instanceFor(HERO)!.model!;
    const chest = model.bonesByName.get('Bone_Chest')!;
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    const aimed = new THREE.Euler().setFromQuaternion(chest.quaternion, 'ZYX').z;
    expect(aimed).toBeGreaterThan(0.3);

    const next = makeManifest();
    delete next.entities.Runner!.boneControls;
    subsystem.applyManifest(next);
    subsystem.updateFrame(1 / 60, 1);

    expect(subsystem.instanceFor(HERO)!.model).toBe(model); // инстанс не пересобран
    const released = new THREE.Euler().setFromQuaternion(chest.quaternion, 'ZYX').z;
    expect(released).toBeLessThan(aimed);
  });
});

describe('пересборка инстанса при смене модели (REND-3, REND-17)', () => {
  it('смена ассета модели строит инстанс заново; прежние буферы остаются в кэше', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope(), onSlope(2, { kind: 'Keeper' })]));
    assets.resolve('model', MODEL_ID, makeModel());
    const before = subsystem.instanceFor(HERO)!.model!;
    const neighbour = subsystem.instanceFor(2)!.model!;

    const next = makeManifest();
    // Запись `Keeper` остаётся на прежней модели — её инстанс не трогаем.
    next.entities.Runner!.model = OTHER_MODEL_ID;
    subsystem.applyManifest(next);
    expect(assets.requests).toContainEqual({ kind: 'model', id: OTHER_MODEL_ID });
    // До готовности нового ассета — заглушка (ASSET-4), как при спавне.
    expect(subsystem.instanceFor(HERO)!.model).toBeNull();

    assets.resolve('model', OTHER_MODEL_ID, makeModel());
    const after = subsystem.instanceFor(HERO)!.model!;
    expect(after).not.toBe(before);
    expect(after.meshes[0]!.geometry).not.toBe(before.meshes[0]!.geometry);
    // Разделяемые данные прежней модели остались: инстанс соседа цел, и
    // повторный спавн на ней ассет заново не запрашивает (REND-3).
    expect(subsystem.instanceFor(2)!.model).toBe(neighbour);
    const requestsBefore = requestCount(assets, MODEL_ID);
    subsystem.syncTick(
      makeTickView([onSlope(), onSlope(2, { kind: 'Keeper' }), onSlope(3, { kind: 'Keeper' })]),
    );
    expect(requestCount(assets, MODEL_ID)).toBe(requestsBefore);
    expect(subsystem.instanceFor(3)!.model!.meshes[0]!.geometry).toBe(neighbour.meshes[0]!.geometry);
  });

  it('появление записи у типа, рисовавшегося заглушкой, даёт ему модель (ASSET-6)', () => {
    const { subsystem, ctx, assets, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(HERO, { kind: 'Ghost' })]));
    expect(warnings.length).toBe(1); // записи нет — предупреждение один раз
    expect(subsystem.instanceFor(HERO)!.model).toBeNull();

    const next = makeManifest();
    next.entities.Ghost = { model: MODEL_ID, tier: 'detailed' };
    subsystem.applyManifest(next);
    assets.resolve('model', MODEL_ID, makeModel());

    expect(subsystem.instanceFor(HERO)!.model).not.toBeNull();
    // Инстанс тот же: второго сценового объекта на ту же сущность не появилось,
    // а заглушка снята — в кадре только модель.
    expect(ctx.scene.children.length).toBe(1);
    expect(subsystem.instanceFor(HERO)!.placeholder).toBe(false);
  });

  it('переподача, заведшая запись эмиттера, снимает заглушку (REND-37)', () => {
    const { subsystem, ctx, assets, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(HERO, { kind: 'Ghost' })]));
    const instance = subsystem.instanceFor(HERO)!;
    expect(instance.placeholder).toBe(true);
    expect(warnings.length).toBe(1);
    const requests = assets.requests.length;

    const next = makeManifest();
    next.particles = { byKind: { Ghost: { effect: 'vfx/ghost.effect.json' } } };
    subsystem.applyManifest(next);

    // Изображение у вида теперь чужое: заглушки нет, и узла под неё в сцене не
    // осталось — ровно как у вида, заявленного с рождения.
    expect(subsystem.instanceFor(HERO)).toBe(instance);
    expect(instance.placeholder).toBe(false);
    expect(ctx.scene.children.length).toBe(0);
    // Пересборки из ассета в этом переходе нет: спрашивать было нечего.
    expect(assets.requests.length).toBe(requests);

    // Обратная правка возвращает заглушку тому же инстансу; предупреждение об
    // отсутствующей записи остаётся одним на тип (ASSET-6) — о `Ghost` уже
    // сказано, и повторять переподача его не начинает.
    subsystem.applyManifest(makeManifest());
    expect(subsystem.instanceFor(HERO)).toBe(instance);
    expect(instance.placeholder).toBe(true);
    expect(ctx.scene.children.length).toBe(1);
    expect(assets.requests.length).toBe(requests);
    expect(warnings.length).toBe(1);
  });

  it('исчезнувшая запись эмиттера возвращает заглушку и её предупреждение (REND-37, ASSET-6)', () => {
    const manifest = makeManifest();
    manifest.particles = { byKind: { Wisp: { effect: 'vfx/wisp.effect.json' } } };
    const { subsystem, ctx, warnings } = makeRig(manifest);
    subsystem.syncTick(makeTickView([makeEntityView(HERO, { kind: 'Wisp' })]));
    expect(subsystem.instanceFor(HERO)!.placeholder).toBe(false);
    expect(warnings).toEqual([]);

    // Автор убрал запись — изображения у вида не осталось вовсе, и это ровно
    // тот случай, ради которого предупреждение и написано.
    subsystem.applyManifest(makeManifest());
    expect(subsystem.instanceFor(HERO)!.placeholder).toBe(true);
    expect(ctx.scene.children.length).toBe(1);
    expect(warnings.filter((message) => message.includes('Wisp'))).toHaveLength(1);
  });
});

describe('назначенное поимённо переживает переподачу (REND-11, REND-6)', () => {
  it('скин набора инстансов не откатывается правкой defaultSkin', () => {
    const { subsystem, assets } = makeRig();
    // Инстанс 1 — со скином из набора, инстанс 2 — со скином записи.
    subsystem.syncTick(makeTickView([onSlope(HERO, { skin: 'blue' }), onSlope(2)]));
    assets.resolve('model', MODEL_ID, makeModel());
    expect(requestCount(assets, 'tex/blue.png')).toBe(1);
    expect(requestCount(assets, 'tex/red.png')).toBe(1);

    const next = makeManifest();
    next.entities.Runner!.defaultSkin = 'green';
    next.entities.Runner!.skins!.green = { '0': 'tex/green.png' };
    subsystem.applyManifest(next);

    // Выбранный скин остался выбранным, невыбранный переехал на новый умолчательный.
    expect(requestCount(assets, 'tex/green.png')).toBe(1);
    expect(requestCount(assets, 'tex/blue.png')).toBe(1);
  });

  it('скин, выставленный сменой скина, переподача не отменяет', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.setSkin(HERO, 'blue');
    expect(requestCount(assets, 'tex/blue.png')).toBe(1);

    const next = makeManifest();
    next.entities.Runner!.defaultSkin = 'green';
    next.entities.Runner!.skins!.green = { '0': 'tex/green.png' };
    subsystem.applyManifest(next);

    expect(requestCount(assets, 'tex/green.png')).toBe(0);
    expect(requestCount(assets, 'tex/blue.png')).toBe(1);
  });

  it('правка текстур самого скина доезжает до его инстансов и не трогает соседний скин', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope(), onSlope(2, { skin: 'blue' })]));
    assets.resolve('model', MODEL_ID, makeModel());

    const next = makeManifest();
    next.entities.Runner!.skins!.red = { '0': 'tex/crimson.png' };
    subsystem.applyManifest(next);

    // Инстанс в правленом скине получил новую текстуру, инстанс в синем — нет.
    expect(requestCount(assets, 'tex/crimson.png')).toBe(1);
    expect(requestCount(assets, 'tex/blue.png')).toBe(1);
  });
});

describe('переподача без правок последствий не имеет (REND-17)', () => {
  it('манифест с тем же содержимым не трогает ни клип, ни скин, ни модель', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    const instance = subsystem.instanceFor(HERO)!;
    const controller = instance.controller!;
    const clip = controller.currentClipName;
    for (let i = 0; i < 20; i++) subsystem.updateFrame(1 / 60, 1);
    const phase = clipPhaseOf(subsystem, HERO);
    expect(phase).toBeGreaterThan(0.1);
    const requestsBefore = assets.requests.length;

    // Разобранный документ после чужой правки: объекты новые, содержимое записи то же.
    const next = makeManifest();
    next.entities.Other = { model: OTHER_MODEL_ID };
    subsystem.applyManifest(next);

    expect(subsystem.instanceFor(HERO)!.model).toBe(instance.model);
    expect(subsystem.instanceFor(HERO)!.controller).toBe(controller);
    expect(controller.currentClipName).toBe(clip);
    // Фаза клипа продолжилась, а не пошла с нуля: переподача без правок работы
    // не делает, хотя все объекты в поданном документе новые.
    subsystem.updateFrame(1 / 60, 1);
    expect(clipPhaseOf(subsystem, HERO)).toBeGreaterThan(phase);
    // Ни текстуры скина, ни модель заново не запрошены — записи чужого типа
    // ассетов не тянут, пока его сущность не появилась в кадре.
    expect(assets.requests.length).toBe(requestsBefore);
  });

  it('повторная подача того же документа — операция без работы', () => {
    const manifest = makeManifest();
    const { subsystem, assets } = makeRig(manifest);
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    const requestsBefore = assets.requests.length;

    subsystem.applyManifest(manifest);
    expect(assets.requests.length).toBe(requestsBefore);
  });
});

describe('игровой путь не меняется (REND-17)', () => {
  it('сборка, которая переподачи не зовёт, ведёт себя как прежде', () => {
    const { subsystem, ctx, assets } = makeRig();
    subsystem.syncTick(makeTickView([onSlope()]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);
    const model = subsystem.instanceFor(HERO)!.model;

    // Обычный ход матча: тики и кадры, манифест — загруженный ассет (ASSET-6).
    for (let tick = 0; tick < 5; tick++) {
      subsystem.syncTick(makeTickView([onSlope(HERO, { moving: true })]));
      subsystem.updateFrame(1 / 60, 1);
    }
    expect(subsystem.instanceFor(HERO)!.model).toBe(model);
    expect(subsystem.instanceFor(HERO)!.controller!.currentClipName).toBe('Walk Fast');
    expect(ctx.scene.children.length).toBe(1);

    // Исчезновение сущности убирает инстанс на общих основаниях (REND-3).
    subsystem.syncTick(makeTickView([]));
    expect(subsystem.instanceFor(HERO)).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
  });
});
