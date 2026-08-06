/**
 * Слой эффектов камеры (camera CAM-6, assets ASSET-8): стек и офсеты,
 * trauma-стакание, множитель 0, подавление импульсов при реплее, длящиеся
 * эффекты от состояний сущности, неизвестный тип — предупреждение и пропуск,
 * зеркалирование состояний в EntityView.states.
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type EntityId,
  type Simulation,
} from '@game-mvp/core';
import {
  CameraEffectsDirector,
  EffectStack,
  Extractor,
  SwayEffect,
  TraumaShake,
  ViewBuffer,
  type CameraPose,
  type PoseOffset,
} from '../src/index.js';
import { makeEntityView, makeTickView } from './fixtures.js';

const LOGICAL: CameraPose = {
  posX: 10,
  posY: 20,
  posZ: 5,
  yaw: Math.PI / 2,
  pitch: 0.8,
  roll: 0,
  fovDeg: 45,
};

const offsetOf = (stack: EffectStack, dt = 1 / 60): PoseOffset => {
  const pose = stack.apply(LOGICAL, dt);
  return {
    dx: pose.posX - LOGICAL.posX,
    dy: pose.posY - LOGICAL.posY,
    dz: pose.posZ - LOGICAL.posZ,
    dyaw: pose.yaw - LOGICAL.yaw,
    dpitch: pose.pitch - LOGICAL.pitch,
    droll: pose.roll - LOGICAL.roll,
    dfovDeg: pose.fovDeg - LOGICAL.fovDeg,
  };
};

const isZero = (o: PoseOffset): boolean =>
  o.dx === 0 && o.dy === 0 && o.dz === 0 && o.dyaw === 0 && o.dpitch === 0 && o.droll === 0 && o.dfovDeg === 0;

describe('EffectStack и эффекты (CAM-6)', () => {
  it('пустой стек: финальная поза равна логической', () => {
    expect(isZero(offsetOf(new EffectStack()))).toBe(true);
  });

  it('тряска трясёт и затухает в точный ноль — вклад завершённого эффекта нулевой', () => {
    const stack = new EffectStack();
    const shake = new TraumaShake({ decay: 2 });
    stack.add(shake);
    shake.addTrauma(1);
    let shook = false;
    for (let i = 0; i < 30; i++) {
      if (!isZero(offsetOf(stack))) shook = true;
    }
    expect(shook).toBe(true);
    for (let i = 0; i < 300; i++) offsetOf(stack); // trauma выгорает
    expect(isZero(offsetOf(stack))).toBe(true);
  });

  it('trauma стакается: второй импульс усиливает тряску, кламп к 1', () => {
    const shake = new TraumaShake({ decay: 0 });
    const out = (): number => {
      const o: PoseOffset = { dx: 0, dy: 0, dz: 0, dyaw: 0, dpitch: 0, droll: 0, dfovDeg: 0 };
      shake.update(1 / 60, o);
      return Math.hypot(o.dx, o.dy);
    };
    shake.addTrauma(0.3);
    const single = out();
    shake.addTrauma(0.3);
    expect(out()).toBeGreaterThan(single); // амплитуда ∝ trauma²
    shake.addTrauma(100);
    expect(out()).toBeLessThanOrEqual(Math.hypot(0.35, 0.35) + 1e-9); // кламп trauma = 1
  });

  it('множитель 0: финальная поза равна логической при активной тряске', () => {
    const stack = new EffectStack(0);
    const shake = new TraumaShake();
    stack.add(shake);
    shake.addTrauma(1);
    for (let i = 0; i < 10; i++) expect(isZero(offsetOf(stack))).toBe(true);
  });

  it('sway активен, пока активен; конверт гасит вклад в ноль после снятия', () => {
    const stack = new EffectStack();
    const sway = new SwayEffect({ fadeSeconds: 0.1 });
    stack.add(sway);
    sway.setActive(true);
    let active = false;
    for (let i = 0; i < 60; i++) {
      if (!isZero(offsetOf(stack))) active = true;
    }
    expect(active).toBe(true);
    sway.setActive(false);
    for (let i = 0; i < 60; i++) offsetOf(stack);
    expect(isZero(offsetOf(stack))).toBe(true);
  });
});

describe('CameraEffectsDirector (CAM-6, ASSET-8)', () => {
  const explosion = (x: number, y: number) => ({
    type: 'Boom',
    tick: 1,
    data: { x: x * FIXED_ONE, y: y * FIXED_ONE },
  });

  const shakeAmount = (stack: EffectStack): number => {
    const o = offsetOf(stack);
    return Math.hypot(o.dx, o.dy, o.dz);
  };

  it('событие из манифеста запускает тряску; после затухания поза чистая', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1, decay: 5 } } },
    });
    director.onTick(
      makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }),
      0,
      0,
      null,
    );
    expect(shakeAmount(director.stack)).toBeGreaterThan(0);
    for (let i = 0; i < 600; i++) director.stack.apply(LOGICAL, 1 / 60);
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('сила импульса ослабляется расстоянием до точки наблюдения', () => {
    const tables = {
      events: { Boom: { effect: 'shake', amplitude: 1, radius: 10, decay: 0 } },
    };
    const near = new CameraEffectsDirector({ tables });
    near.onTick(makeTickView([], { freshEvents: true, events: [explosion(1, 0)] }), 0, 0, null);
    const far = new CameraEffectsDirector({ tables });
    far.onTick(makeTickView([], { freshEvents: true, events: [explosion(9, 0)] }), 0, 0, null);
    const out = new CameraEffectsDirector({ tables });
    out.onTick(makeTickView([], { freshEvents: true, events: [explosion(50, 0)] }), 0, 0, null);
    expect(shakeAmount(near.stack)).toBeGreaterThan(shakeAmount(far.stack));
    expect(shakeAmount(far.stack)).toBeGreaterThan(0);
    expect(isZero(offsetOf(out.stack))).toBe(true); // за радиусом — ноль
  });

  it('реплей не стреляет очередью тряски: freshEvents=false → импульсы молчат (CAM-5)', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1 } } },
    });
    director.onTick(
      makeTickView([], { freshEvents: false, isReplay: true, events: [explosion(0, 0)] }),
      0,
      0,
      null,
    );
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('множитель 0: события и состояния игнорируются без ошибок', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1 } } },
      stack: new EffectStack(0),
    });
    director.onTick(makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }), 0, 0, null);
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('длящийся эффект следует присутствию состояния на цели (CAM-6)', () => {
    const hero = 7 as EntityId;
    const director = new CameraEffectsDirector({
      tables: { states: { Drunk: { effect: 'sway', fadeSeconds: 0.05 } } },
      stateComponents: ['Poisoned', 'Drunk'],
    });
    // Состояние присутствует: бит 1 (второй в списке).
    director.onTick(makeTickView([makeEntityView(hero, { states: 0b10 })]), 0, 0, hero);
    for (let i = 0; i < 30; i++) director.stack.apply(LOGICAL, 1 / 60);
    expect(isZero(offsetOf(director.stack))).toBe(false);
    // Состояние исчезло из снапшота — эффект гаснет.
    director.onTick(makeTickView([makeEntityView(hero, { states: 0 })]), 0, 0, hero);
    for (let i = 0; i < 120; i++) director.stack.apply(LOGICAL, 1 / 60);
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('неизвестный тип эффекта — предупреждение один раз и пропуск (ASSET-8)', () => {
    const warnings: string[] = [];
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'earthquake' } } },
      warn: (m) => warnings.push(m),
    });
    const view = makeTickView([], { freshEvents: true, events: [explosion(0, 0)] });
    director.onTick(view, 0, 0, null);
    director.onTick(view, 0, 0, null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('earthquake');
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });
});

describe('Extractor.stateComponents: присутствие компоненты → бит (CAM-6)', () => {
  it('зеркалирует состояния по порядку списка; лишние компоненты — отказ', () => {
    const scene = loadScene({
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: 'Drunk', fields: { power: 'fixed' } },
      ],
      prefabs: [
        { name: 'Sober', components: { Position: {} }, tags: ['Sober'] },
        { name: 'Drunkard', components: { Position: {}, Drunk: {} }, tags: ['Drunkard'] },
      ],
    });
    const sober = worldInitSpawn(scene.world, 'Sober', {
      Position: { x: fixed.fromFloat(1), y: fixed.fromFloat(1) },
    });
    const drunkard = worldInitSpawn(scene.world, 'Drunkard', {
      Position: { x: fixed.fromFloat(2), y: fixed.fromFloat(2) },
      Drunk: { power: fixed.fromFloat(1) },
    });
    const sim: Simulation = { systems: scene.systems, worldSeed: 1, math: mathApi };
    const state = initialState(scene.world, 1);
    const result = tick(sim, state);

    const extractor = new Extractor({
      kindOf: () => null,
      stateComponents: ['Poisoned', 'Drunk'],
    });
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extractor.extract(result));
    expect(buffer.view.entities.get(sober)!.states).toBe(0);
    expect(buffer.view.entities.get(drunkard)!.states).toBe(0b10);

    expect(
      () =>
        new Extractor({
          kindOf: () => null,
          stateComponents: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        }),
    ).toThrow(/stateComponents/);
  });
});

describe('EntityView.states: зеркалирование битов состояний (CAM-6)', () => {
  it('ViewBuffer переносит биты из колонки flags в states', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply({
      tick: 1,
      mode: 'Running',
      isReplay: false,
      snapAll: false,
      freshEvents: true,
      count: 1,
      id: new Float64Array([7]),
      kind: new Int32Array([-1]),
      x: new Float32Array([0]),
      y: new Float32Array([0]),
      level: new Uint8Array([0]),
      // бит 0 — moving, бит 1 — levelOverride, биты выше — состояния (STATE_BITS_SHIFT).
      flags: new Uint8Array([0b1001]),
      facingYaw: new Float32Array([Number.NaN]),
      aimYaw: new Float32Array([Number.NaN]),
      events: [],
      floorDelta: [],
      kindTable: [],
    });
    const view = buffer.view.entities.get(7)!;
    expect(view.moving).toBe(true);
    expect(view.states).toBe(0b10);
  });
});
