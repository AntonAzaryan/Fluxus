/**
 * Мировые якоря инстансов (REND-41): точка над нарисованным инстансом → пиксели
 * кадра, посаженные ТОЙ ЖЕ реализацией позы (CAM-1), которой нарисован кадр.
 *
 * Графического контекста ни один тест не создаёт: проекция — арифметика матриц,
 * и проверять её глазами нечем (то же основание, что у headless-теста позы).
 * Экранного слоя здесь тоже нет: пакет рендера свободен от DOM (REND-19), и
 * якорь — числа, а не элемент.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import {
  ModelsSubsystem,
  ScreenAnchors,
  applyCameraPose,
  type AnchorInstanceSource,
  type CameraPose,
  type ModelInstanceView,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const VIEWPORT = { width: 400, height: 300 };
const MODEL_ID = 'models/runner.mdx';

/** Изометрическая поза игрового кадра: наклон 50°, взгляд с юга (CAM-1). */
function gamePose(x: number, y: number, distance = 16): CameraPose {
  const pitch = (50 * Math.PI) / 180;
  return {
    posX: x,
    posY: y - Math.cos(pitch) * distance,
    posZ: Math.sin(pitch) * distance,
    yaw: Math.PI / 2,
    pitch,
    roll: 0,
    fovDeg: 45,
  };
}

/**
 * Инстанс-заглушка: ровно тот публичный вид, который отдаёт подсистема моделей
 * (REND-3). Позволяет адресовать позу и границы числом, не собирая ассет.
 */
function stubInstance(
  entity: EntityId,
  pose: { x: number; y: number; z: number; scale?: number },
  bounds: { maxZ: number } | null,
  visible = true,
): ModelInstanceView {
  return {
    entity,
    decoration: false,
    tier: 'detailed',
    model: null,
    controller: null,
    placeholder: false,
    visible,
    lodLevel: 0,
    pose: {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      yaw: 0,
      scale: pose.scale ?? 1,
    },
    bounds:
      bounds === null
        ? null
        : { minX: -0.5, minY: -0.5, minZ: 0, maxX: 0.5, maxY: 0.5, maxZ: bounds.maxZ },
  };
}

/** Источник инстансов из словаря — узкий порт `instanceFor` (REND-41). */
function sourceOf(views: ReadonlyMap<EntityId, ModelInstanceView>): AnchorInstanceSource {
  return { instanceFor: (entity) => views.get(entity) ?? null };
}

describe('точка якоря (REND-41)', () => {
  it('по умолчанию — верх границ инстанса с масштабом набора', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 3, y: 4, z: 2, scale: 1.5 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    anchors.update(gamePose(3, 4), VIEWPORT);
    expect(anchor.worldX).toBeCloseTo(3, 6);
    expect(anchor.worldY).toBeCloseTo(4, 6);
    // 2 (поза) + 2 (верх границ) × 1.5 (масштаб набора, REND-11) = 5.
    expect(anchor.worldZ).toBeCloseTo(5, 6);
    expect(anchor.drawn).toBe(true);
  });

  it('высота потребителя вместо умолчания — там, где верх границ не тот якорь', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 0, y: 0, z: 0 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1, { height: 0.5 });
    anchors.update(gamePose(0, 0), VIEWPORT);
    expect(anchor.worldZ).toBeCloseTo(0.5, 6);
  });

  it('вертикален: наклон по нормали и курс инстанса его не вращают (REND-10, REND-13)', () => {
    const tilted = stubInstance(1, { x: 1, y: 1, z: 0 }, { maxZ: 2 });
    // Инстанс завален на 30° и развёрнут курсом — якорь остаётся над позой.
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 1.2));
    const rotated: ModelInstanceView = {
      ...tilted,
      pose: { ...tilted.pose, qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w, yaw: 1.2 },
    };
    const anchors = new ScreenAnchors({ instances: sourceOf(new Map([[1, rotated]])) });
    const anchor = anchors.track(1);
    anchors.update(gamePose(1, 1), VIEWPORT);
    expect(anchor.worldX).toBeCloseTo(1, 6);
    expect(anchor.worldY).toBeCloseTo(1, 6);
    expect(anchor.worldZ).toBeCloseTo(2, 6);
  });

  it('модели ещё нет — якорь стоит в самой позе: границ, чтобы подняться, не из чего взять', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 2, y: 2, z: 1 }, null)],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    anchors.update(gamePose(2, 2), VIEWPORT);
    expect(anchor.drawn).toBe(true);
    expect(anchor.worldZ).toBeCloseTo(1, 6);
  });
});

describe('проекция якоря в координаты кадра (REND-41, CAM-1)', () => {
  it('совпадает с камерой кадра: та же поза, та же посадка, та же матрица', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 5, y: 7, z: 1 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    const pose = gamePose(4, 6);
    anchors.update(pose, VIEWPORT);

    // Камера КАДРА — ровно та, какую заводит сборка движка: мир Z-up.
    const frame = new THREE.PerspectiveCamera(pose.fovDeg, VIEWPORT.width / VIEWPORT.height, 0.1, 300);
    frame.up.set(0, 0, 1);
    applyCameraPose(frame, pose);
    frame.updateMatrixWorld(true);
    const expected = new THREE.Vector3(anchor.worldX, anchor.worldY, anchor.worldZ).project(frame);

    expect(anchor.ndcX).toBeCloseTo(expected.x, 6);
    expect(anchor.ndcY).toBeCloseTo(expected.y, 6);
    expect(anchor.x).toBeCloseTo(((expected.x + 1) / 2) * VIEWPORT.width, 6);
    expect(anchor.y).toBeCloseTo(((1 - expected.y) / 2) * VIEWPORT.height, 6);
    expect(anchor.onScreen).toBe(true);
  });

  it('якорь идёт вместе с изображением: сдвиг камеры двигает пиксели', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 0, y: 0, z: 0 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    anchors.update(gamePose(0, 0), VIEWPORT);
    const centeredX = anchor.x;
    // Камера уехала на восток — юнит уходит влево по экрану.
    anchors.update(gamePose(3, 0), VIEWPORT);
    expect(anchor.x).toBeLessThan(centeredX);
    expect(anchor.onScreen).toBe(true);
  });

  it('сущность за кромкой кадра — координаты есть, признак «виден» снят', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 60, y: 0, z: 0 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    anchors.update(gamePose(0, 0), VIEWPORT);
    expect(anchor.drawn).toBe(true);
    expect(anchor.onScreen).toBe(false);
    expect(Number.isFinite(anchor.x)).toBe(true);
  });

  it('сущность ЗА камерой не выезжает на экран зеркально', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 0, y: -40, z: 0 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    // Камера смотрит на север из точки (0,0): юнит далеко за её спиной.
    anchors.update(gamePose(0, 10), VIEWPORT);
    expect(anchor.onScreen).toBe(false);
  });
});

describe('состав набора и его оборот (REND-41, REND-26)', () => {
  it('не нарисованная сущность даёт якорь с признаком «не нарисован», а не отсутствие записи', () => {
    const views = new Map<EntityId, ModelInstanceView>();
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(7);
    anchors.update(gamePose(0, 0), VIEWPORT);
    expect(anchors.anchorOf(7)).toBe(anchor);
    expect(anchor.drawn).toBe(false);
    expect(anchor.onScreen).toBe(false);
  });

  it('отсечённый кадром инстанс (REND-21) якоря по существу не даёт', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 0, y: 0, z: 0 }, { maxZ: 2 }, false)],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    anchors.update(gamePose(0, 0), VIEWPORT);
    expect(anchor.drawn).toBe(false);
  });

  it('сущности вне набора якоря нет — «не в наборе» и «нет данных» различаются', () => {
    const anchors = new ScreenAnchors({ instances: sourceOf(new Map()) });
    expect(anchors.anchorOf(3)).toBeNull();
  });

  it('запись стабильна и переиспользуется: кадр её только переписывает (REND-26)', () => {
    const views = new Map<EntityId, ModelInstanceView>([
      [1, stubInstance(1, { x: 0, y: 0, z: 0 }, { maxZ: 2 })],
    ]);
    const anchors = new ScreenAnchors({ instances: sourceOf(views) });
    const anchor = anchors.track(1);
    for (let i = 0; i < 10; i++) anchors.update(gamePose(i, 0), VIEWPORT);
    expect(anchors.anchorOf(1)).toBe(anchor);
    expect(anchors.track(1)).toBe(anchor);
  });

  it('оборот набора не заводит новых записей: снятая возвращается в свободный список (PERF-9)', () => {
    const anchors = new ScreenAnchors({ instances: sourceOf(new Map()) });
    const first = anchors.track(1);
    anchors.untrack(1);
    expect(anchors.size).toBe(0);
    expect(anchors.track(2)).toBe(first);
    anchors.clear();
    expect(anchors.size).toBe(0);
    expect(anchors.track(3)).toBe(first);
  });

  it('обход набора идёт в порядке добавления', () => {
    const anchors = new ScreenAnchors({ instances: sourceOf(new Map()) });
    anchors.track(5);
    anchors.track(2);
    anchors.track(9);
    const seen: EntityId[] = [];
    anchors.each((anchor) => seen.push(anchor.entity));
    expect(seen).toEqual([5, 2, 9]);
  });
});

describe('вход якоря — публичный вид подсистемы моделей (REND-41, REND-1)', () => {
  it('позу и границы даёт `instanceFor` живой подсистемы — второго источника нет', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const models = new ModelsSubsystem(
      { entities: { Runner: { model: MODEL_ID, scale: 2 } } },
      { warn: () => {} },
    );
    models.init(ctx);
    models.syncTick(makeTickView([makeEntityView(1, { currX: 2, currY: 3, kind: 'Runner' })]));
    assets.resolve('model', MODEL_ID, makeModel());
    models.updateFrame(1 / 60, 1);

    const anchors = new ScreenAnchors({ instances: models });
    const anchor = anchors.track(1);
    anchors.update(gamePose(2, 3), VIEWPORT);

    const view = models.instanceFor(1)!;
    expect(anchor.drawn).toBe(view.visible);
    expect(anchor.worldX).toBeCloseTo(view.pose.x, 6);
    expect(anchor.worldY).toBeCloseTo(view.pose.y, 6);
    // Высота — верх границ ТОГО ЖЕ вида: константы кода в якоре нет (REND-41).
    expect(anchor.worldZ).toBeCloseTo(view.pose.z + view.bounds!.maxZ * view.pose.scale, 6);
  });
});
