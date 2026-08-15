/**
 * RenderHost: интерполяционный буфер двух тиков, альфа, snap при isReplay,
 * телепорте и спавне (REND-1, REND-2), ход часов презентации по режиму мира
 * (REND-25) и скраб перемотки без телепортов (REND-2), порядок подсистем
 * (REND-8), зеркало карты пола (REND-7) и направление каста из событий (REND-5).
 *
 * Прогоняется на настоящей мини-симуляции ядра: хост тестируется ровно тем
 * контрактом, которым его зовёт внешний слой — `dispatch(tick(...), [host])`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FIXED_ONE,
  FLOOR_COMPONENT,
  dispatch,
  fixed,
  initialState,
  loadScene,
  mathApi,
  restoreSnapshot,
  takeSnapshot,
  tick,
  worldInitSpawn,
  type EntityId,
  type Scene,
  type Simulation,
  type SimulationState,
  type Snapshot,
  type System,
  type TickResult,
  type WorldMode,
} from '@game-mvp/core';
import {
  RenderHost,
  kindByTags,
  type RenderContext,
  type RenderHostConfig,
  type RenderSubsystem,
  type TickView,
} from '../src/index.js';
import { makeAssets } from './fixtures.js';

const F = (n: number): number => fixed.fromFloat(n);

// ------------------------------------------------------------------ обвязка

function makeScene(extraSystems: readonly System[] = []): { scene: Scene; sim: Simulation } {
  const scene = loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
    ],
    prefabs: [{ name: 'Runner', components: { Position: {}, Velocity: {} }, tags: ['Runner'] }],
    terrain: {
      width: 2,
      height: 2,
      tileSize: FIXED_ONE,
      levels: ['00', '00'],
      flags: ['..', '..'],
    },
  });
  const mover: System = {
    name: 'Mover',
    order: 10,
    run(ctx) {
      for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
        ctx.commands.setField(
          entity,
          'Position',
          'x',
          ctx.math.add(ctx.get(entity, 'Position', 'x'), ctx.get(entity, 'Velocity', 'x')),
        );
        ctx.commands.setField(
          entity,
          'Position',
          'y',
          ctx.math.add(ctx.get(entity, 'Position', 'y'), ctx.get(entity, 'Velocity', 'y')),
        );
      }
    },
  };
  scene.systems.register(mover);
  for (const system of extraSystems) scene.systems.register(system);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 7,
    math: mathApi,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
  };
  return { scene, sim };
}

function spawnRunner(scene: Scene, x: number, y: number, vx: number, vy: number): EntityId {
  return worldInitSpawn(scene.world, 'Runner', {
    Position: { x: F(x), y: F(y) },
    Velocity: { x: F(vx), y: F(vy) },
  });
}

interface HostRig {
  host: RenderHost;
  /** Поле-функция, а не метод: `setNow` разбирают деструктуризацией, `this` ему не нужен. */
  setNow: (ms: number) => void;
}

function makeHost(scene: Scene, config: Partial<RenderHostConfig> = {}): HostRig {
  let now = 0;
  const context: RenderContext = {
    scene: new THREE.Scene(),
    assets: makeAssets().service,
    config: { heightStep: 0.5 },
  };
  const host = new RenderHost(context, {
    tickSeconds: 0.05,
    kindOf: kindByTags(['Runner']),
    ...(scene.terrain !== undefined ? { terrainGrid: scene.terrain.grid } : {}),
    clock: () => now,
    ...config,
  });
  return {
    host,
    setNow: (ms) => {
      now = ms;
    },
  };
}

/** Рукодельный replay-результат: тот же контракт TickResult, isReplay = true. */
function replayResult(state: SimulationState): TickResult {
  return {
    state,
    tick: state.tick,
    mode: state.mode,
    isReplay: true,
    events: state.events,
    changes: { isEmpty: true, changedEntities: () => new Set<EntityId>() },
  };
}

/**
 * Доставка вне расписания — то, что рендер видит при паузе и перемотке
 * (WSM-6, NET-11): живого тика за ней нет, режим и номер тика приходят от
 * доставившей стороны, мир — тот, что она восстановила.
 */
function deliveredResult(
  state: SimulationState,
  at: number,
  mode: WorldMode,
  isReplay = false,
): TickResult {
  return {
    state,
    tick: at,
    mode,
    isReplay,
    events: state.events,
    changes: { isEmpty: true, changedEntities: () => new Set<EntityId>() },
  };
}

// -------------------------------------------------------------------- тесты

describe('RenderHost: интерполяционный буфер (REND-1, REND-2)', () => {
  it('держит два последних тика и конвертирует Q16.16 в float один раз', () => {
    const { scene, sim } = makeScene();
    const runner = spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);

    setNow(0);
    dispatch(tick(sim, state), [host]);
    const view = host.view.entities.get(runner)!;
    // Первый тик: спавн — snap, буфер схлопнут в текущую позицию.
    expect(view.spawned).toBe(true);
    expect(view.snap).toBe(true);
    expect(view.currX).toBeCloseTo(0.6, 3);
    expect(view.prevX).toBeCloseTo(0.6, 3);

    setNow(50);
    dispatch(tick(sim, state), [host]);
    expect(view.snap).toBe(false);
    expect(view.spawned).toBe(false);
    expect(view.prevX).toBeCloseTo(0.6, 3);
    expect(view.currX).toBeCloseTo(0.7, 3);
    expect(view.moving).toBe(true);
    expect(view.facingYaw).toBeCloseTo(0, 5);
  });

  it('frame() считает альфу как долю тика между двумя onTick', () => {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);

    const alphas: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (_dt, alpha) => alphas.push(alpha),
    });

    setNow(0);
    dispatch(tick(sim, state), [host]);
    setNow(50);
    dispatch(tick(sim, state), [host]);

    setNow(75); // середина 50-миллисекундного тика
    host.frame();
    setNow(100);
    host.frame();
    setNow(200); // за пределом тика — альфа клампится
    host.frame();
    expect(alphas[0]).toBeCloseTo(0.5, 5);
    expect(alphas[1]).toBeCloseTo(1, 5);
    expect(alphas[2]).toBeCloseTo(1, 5);
  });

  it('интерполированная позиция по альфе ложится между тиками', () => {
    const { scene, sim } = makeScene();
    const runner = spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);

    setNow(0);
    dispatch(tick(sim, state), [host]);
    setNow(50);
    dispatch(tick(sim, state), [host]);

    const view = host.view.entities.get(runner)!;
    const alpha = 0.5;
    const x = view.prevX + (view.currX - view.prevX) * alpha;
    expect(x).toBeCloseTo(0.65, 3);
  });
});

describe('RenderHost: snap при разрывах непрерывности (REND-2)', () => {
  it('isReplay схлопывает буфер: без «проезда» интерполяцией', () => {
    const { scene, sim } = makeScene();
    const runner = spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    dispatch(tick(sim, state), [host]);
    dispatch(tick(sim, state), [host]);
    const view = host.view.entities.get(runner)!;
    expect(view.snap).toBe(false);

    dispatch(replayResult(state), [host]);
    expect(host.view.snapAll).toBe(true);
    expect(view.snap).toBe(true);
    expect(view.prevX).toBeCloseTo(view.currX, 6);
    // Реплейные события не считаются свежими (OBS-5).
    expect(host.view.freshEvents).toBe(false);
  });

  it('скачок позиции больше snapDistance — телепорт без интерполяции', () => {
    const teleporter: System = {
      name: 'Teleporter',
      order: 20,
      run(ctx) {
        if (ctx.tick !== 3) return;
        for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
          ctx.commands.setField(
            entity,
            'Position',
            'x',
            ctx.math.add(ctx.get(entity, 'Position', 'x'), F(10)),
          );
        }
      },
    };
    const { scene, sim } = makeScene([teleporter]);
    const runner = spawnRunner(scene, 0.5, 0.5, 0.01, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    dispatch(tick(sim, state), [host]);
    dispatch(tick(sim, state), [host]);
    const view = host.view.entities.get(runner)!;
    expect(view.snap).toBe(false);

    dispatch(tick(sim, state), [host]); // тик 3 — телепорт на +10
    expect(view.snap).toBe(true);
    expect(view.prevX).toBeCloseTo(view.currX, 6);
    expect(view.currX).toBeGreaterThan(10);
  });

  it('исчезнувшая сущность уходит из presentation-состояния (REND-3)', () => {
    const killer: System = {
      name: 'Killer',
      order: 20,
      run(ctx) {
        if (ctx.tick !== 2) return;
        for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
          ctx.commands.destroy(entity);
        }
      },
    };
    const { scene, sim } = makeScene([killer]);
    const runner = spawnRunner(scene, 0.5, 0.5, 0, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    dispatch(tick(sim, state), [host]);
    expect(host.view.entities.has(runner)).toBe(true);
    dispatch(tick(sim, state), [host]);
    expect(host.view.entities.has(runner)).toBe(false);
  });
});

describe('RenderHost: часы презентации следуют режиму мира (REND-25)', () => {
  it('Running — вперёд, Paused — стоп, Rewinding — назад; модуль тот же', () => {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);

    const dts: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (dt) => dts.push(dt),
    });

    setNow(0);
    dispatch(tick(sim, state), [host]);
    host.frame(); // первый кадр сессии: интервала ещё нет

    setNow(16);
    host.frame(); // живой мир — время идёт вперёд

    // Мир замер: кадры идут дальше, состояние доставляется тем же тиком.
    dispatch(deliveredResult(state, state.tick, 'Paused'), [host]);
    setNow(32);
    host.frame();

    // Скраб: сервер отдаёт восстановленные состояния с убывающими тиками.
    dispatch(deliveredResult(state, state.tick - 1, 'Rewinding'), [host]);
    setNow(48);
    host.frame();

    dispatch(deliveredResult(state, state.tick, 'Running'), [host]);
    setNow(64);
    host.frame();

    expect(dts[0]).toBe(0);
    expect(dts[1]).toBeCloseTo(0.016, 6);
    // Стоящий мир с идущими клипами показывал бы движение, которого нет.
    expect(dts[2]).toBe(0);
    // Обратный ход идёт с той же скоростью, что прямой: знак, а не другой темп.
    expect(dts[3]).toBeCloseTo(-0.016, 6);
    expect(Math.abs(dts[3]!)).toBeCloseTo(dts[4]!, 6);
    expect(dts[4]).toBeCloseTo(0.016, 6);
  });
});

describe('RenderHost: скраб перемотки без телепортов (REND-2)', () => {
  it('вход и выход — snap, соседние восстановленные состояния интерполируются', () => {
    const { scene, sim } = makeScene();
    const runner = spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    const history: Snapshot[] = [];
    for (let i = 0; i < 5; i++) {
      dispatch(tick(sim, state), [host]);
      history.push(takeSnapshot(state));
    }
    const view = host.view.entities.get(runner)!;
    expect(view.snap).toBe(false);

    // Вход в перемотку — смена режима: разрыв, буфер схлопнут (REND-2).
    restoreSnapshot(state, history[3]!);
    dispatch(deliveredResult(state, 4, 'Rewinding'), [host]);
    expect(host.view.snapAll).toBe(true);
    expect(view.snap).toBe(true);
    expect(view.prevX).toBeCloseTo(view.currX, 6);

    // Соседнее восстановленное состояние: разрыва нет — та же пара prev→curr,
    // только едет она назад.
    restoreSnapshot(state, history[2]!);
    dispatch(deliveredResult(state, 3, 'Rewinding'), [host]);
    expect(host.view.snapAll).toBe(false);
    expect(view.snap).toBe(false);
    expect(view.prevX).toBeCloseTo(0.9, 3);
    expect(view.currX).toBeCloseTo(0.8, 3);
    // Кадр посреди пары — между историческими позициями, а не в одной из них.
    expect(view.prevX + (view.currX - view.prevX) * 0.5).toBeCloseTo(0.85, 3);

    restoreSnapshot(state, history[1]!);
    dispatch(deliveredResult(state, 2, 'Rewinding'), [host]);
    expect(view.snap).toBe(false);
    expect(view.prevX).toBeCloseTo(0.8, 3);
    expect(view.currX).toBeCloseTo(0.7, 3);

    // Реплейный проход остаётся разрывом и внутри перемотки.
    dispatch(deliveredResult(state, 2, 'Rewinding', true), [host]);
    expect(host.view.snapAll).toBe(true);

    // Выход из перемотки — снова смена режима, снова snap.
    dispatch(deliveredResult(state, 2, 'Paused'), [host]);
    expect(host.view.snapAll).toBe(true);
    expect(view.snap).toBe(true);
  });
});

describe('RenderHost: подсистемы зовутся в порядке регистрации (REND-8)', () => {
  it('init, syncTick и updateFrame идут строго по списку', () => {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    const calls: string[] = [];
    const probe = (name: string): RenderSubsystem => ({
      name,
      init: () => calls.push(`${name}:init`),
      syncTick: (view: TickView) => calls.push(`${name}:sync:${view.tick}`),
      updateFrame: () => calls.push(`${name}:frame`),
    });
    host.register(probe('a'));
    host.register(probe('b'));

    dispatch(tick(sim, state), [host]);
    host.frame();
    expect(calls).toEqual([
      'a:init',
      'b:init',
      'a:sync:1',
      'b:sync:1',
      'a:frame',
      'b:frame',
    ]);
  });
});

describe('RenderHost: зеркало карты пола (REND-7, TERR-6)', () => {
  it('мутация пола отдаёт изменившиеся клетки не позже следующего syncTick', () => {
    const breaker: System = {
      name: 'FloorBreaker',
      order: 30,
      run(ctx) {
        if (ctx.tick !== 2) return;
        for (const terrain of ctx.query({ withTag: 'terrain' })) {
          const word = ctx.get(terrain, FLOOR_COMPONENT, 'w0');
          ctx.commands.setField(terrain, FLOOR_COMPONENT, 'w0', word & ~1); // выбиваем клетку 0
        }
      },
    };
    const { scene, sim } = makeScene([breaker]);
    spawnRunner(scene, 1.5, 1.5, 0, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    dispatch(tick(sim, state), [host]);
    expect(host.view.floorBits![0]).toBe(1);
    expect(host.view.floorChangedCells).toEqual([]);

    dispatch(tick(sim, state), [host]);
    expect(host.view.floorChangedCells).toEqual([0]);
    expect(host.view.floorBits![0]).toBe(0);

    dispatch(tick(sim, state), [host]);
    expect(host.view.floorChangedCells).toEqual([]);
  });
});

describe('RenderHost: направление каста из событий (REND-5)', () => {
  it('событие из aimEvents ставит aimYaw кастеру и протухает по hold-окну', () => {
    const caster: System = {
      name: 'Caster',
      order: 40,
      run(ctx) {
        if (ctx.tick !== 2) return;
        for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
          ctx.events.emit('CastFireball', { entity, dirX: 0, dirY: F(1) });
        }
      },
    };
    const { scene, sim } = makeScene([caster]);
    const runner = spawnRunner(scene, 0.5, 0.5, 0.01, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene, { aimEvents: ['CastFireball'], aimHoldTicks: 1 });

    dispatch(tick(sim, state), [host]);
    const view = host.view.entities.get(runner)!;
    expect(view.aimYaw).toBeNull();

    dispatch(tick(sim, state), [host]); // тик 2 — каст на север
    expect(host.view.events.some((event) => event.type === 'CastFireball')).toBe(true);
    expect(view.aimYaw).not.toBeNull();
    expect(view.aimYaw!).toBeCloseTo(Math.PI / 2, 5);

    dispatch(tick(sim, state), [host]); // тик 3 — ещё в hold-окне
    expect(view.aimYaw).not.toBeNull();
    dispatch(tick(sim, state), [host]); // тик 4 — протухло
    expect(view.aimYaw).toBeNull();
  });
});
