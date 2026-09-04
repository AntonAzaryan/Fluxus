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
} from '@fluxus/core';
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
    // Каденс доставок здесь один и тот же — тик за доставку в обе стороны, —
    // поэтому обратный ход идёт с той же скоростью, что прямой: разница только
    // в знаке. Темп скраба, отличный от живого, проверяется отдельно ниже.
    expect(dts[3]).toBeCloseTo(-0.016, 6);
    expect(Math.abs(dts[3]!)).toBeCloseTo(dts[4]!, 6);
    expect(dts[4]).toBeCloseTo(0.016, 6);
  });

  it('темп обратного хода — темп скраба: клипы догоняют обратное движение', () => {
    // Живой мир доставляется через тик (conflation SHELL-4 или рассылка вдвое
    // реже тиков), а скраб ходит по четыре тика за доставку (REW-13). Клип,
    // отматываемый по часам главного потока, отстал бы от сущности вдвое —
    // сценарий REND-25 требует «догоняя обратное движение», а не «в своём
    // темпе».
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);
    for (let i = 0; i < 14; i++) tick(sim, state);

    const dts: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (dt) => dts.push(dt),
    });

    setNow(0);
    for (const at of [10, 12, 14]) dispatch(deliveredResult(state, at, 'Running'), [host]);
    host.frame(); // первый кадр сессии: интервала ещё нет
    setNow(16);
    host.frame();

    dispatch(deliveredResult(state, 10, 'Rewinding'), [host]);
    setNow(32);
    host.frame();

    expect(dts[1]).toBeCloseTo(0.016, 6);
    // Вдвое быстрее и назад: 4 тика за доставку против 2 у живого мира.
    expect(dts[2]).toBeCloseTo(-0.032, 6);
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

  it('порог телепорта считается на доставленный пролёт тиков, а не на один тик', () => {
    // Скорость снаряда: 0.625 мировых единиц за тик. Шаг скраба — четыре тика
    // (REW-13), то есть 2.5 единицы за доставку при пороге телепорта 2. Порог,
    // применённый как «за один тик», объявил бы телепортом КАЖДУЮ доставку
    // скраба — и обратный ход снаряда рассыпался бы на череду прыжков, ровно то,
    // что REND-2 запрещает.
    const { scene, sim } = makeScene();
    const runner = spawnRunner(scene, 0.5, 0.5, 0.625, 0);
    // Вторая сущность прыгает по 20 единиц за тик — на порог не натягивается
    // никаким пролётом: разрыв остаётся разрывом и внутри скраба.
    const jumper = spawnRunner(scene, 0.5, 0.5, 20, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    const history: Snapshot[] = [];
    for (let i = 0; i < 12; i++) {
      dispatch(tick(sim, state), [host]);
      history.push(takeSnapshot(state));
    }
    const view = host.view.entities.get(runner)!;
    const jumped = host.view.entities.get(jumper)!;

    // Вход в перемотку: разрыв по смене режима, как и прежде.
    restoreSnapshot(state, history[11]!);
    dispatch(deliveredResult(state, 12, 'Rewinding'), [host]);
    expect(view.snap).toBe(true);

    // Шаг скраба назад на четыре тика: 2.5 единицы разом — это движение, а не
    // телепорт.
    restoreSnapshot(state, history[7]!);
    dispatch(deliveredResult(state, 8, 'Rewinding'), [host]);
    expect(view.snap).toBe(false);
    expect(view.prevX).toBeCloseTo(8, 3);
    expect(view.currX).toBeCloseTo(5.5, 3);
    // Та же доставка, тот же пролёт — а прыгун снапнут: 80 единиц четырьмя
    // тиками не объясняются.
    expect(jumped.snap).toBe(true);

    restoreSnapshot(state, history[3]!);
    dispatch(deliveredResult(state, 4, 'Rewinding'), [host]);
    expect(view.snap).toBe(false);
    expect(view.currX).toBeCloseTo(3, 3);
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

describe('RenderHost: входная граница нагрузки события (REND-1)', () => {
  /**
   * «Конверсия Q16.16 → float SHALL происходить на входе в рендер … и MUST NOT
   * происходить глубже» — значит, за границей нагрузка события уже float, и
   * потребителю (тряска камеры CAM-6, точка оболочки REND-23) делить нечего.
   * Приводятся ровно координатные поля: ссылка на сущность — целый номер, а
   * поле, смысл которого задаёт контент, рендер не трогает вовсе.
   */
  it('координаты события переходят границу float’ами, ссылки и прочие поля — как есть', () => {
    const boom: System = {
      name: 'Boom',
      order: 41,
      run(ctx) {
        if (ctx.tick !== 1) return;
        for (const entity of ctx.query({ all: ['Position'] })) {
          ctx.events.emit('Boom', {
            entity,
            x: F(3),
            y: F(-2.5),
            dirX: F(1),
            dirY: 0,
            amount: 7,
          });
        }
      },
    };
    const { scene, sim } = makeScene([boom]);
    const runner = spawnRunner(scene, 0.5, 0.5, 0, 0);
    const state = initialState(scene.world, 7);
    const { host } = makeHost(scene);

    dispatch(tick(sim, state), [host]);
    const event = host.view.events.find((entry) => entry.type === 'Boom')!;
    expect(event.data.x).toBe(3);
    expect(event.data.y).toBe(-2.5);
    expect(event.data.dirX).toBe(1);
    expect(event.data.dirY).toBe(0);
    expect(event.data.entity).toBe(runner);
    expect(event.data.amount).toBe(7);
  });
});

// -- change `fog-observer-inputs`: каденс доставок по часам и часы кадра

describe('RenderHost: темп и альфа считаются по каденсу ЧАСОВ (REND-2, REND-25)', () => {
  /**
   * Скраб шагает по `step` тиков РАЗ В `every` рассылок (`workerShell`,
   * `demoScrubEveryOf`): тиков за доставку у него в `step` раз больше, а самих
   * доставок во столько же меньше. Темп обязан считаться тиками В СЕКУНДУ —
   * иначе клипы отматываются в `every` раз быстрее ног.
   */
  it('скраб раз в две доставки: темп — отношение тиков в секунду, а не спанов', () => {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);
    for (let i = 0; i < 20; i++) tick(sim, state);

    const dts: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (dt) => dts.push(dt),
    });

    // Живой мир: тик за доставку, доставка раз в 16 мс — 62.5 тика в секунду.
    let at = 30;
    for (let ms = 0; ms <= 64; ms += 16) {
      setNow(ms);
      dispatch(deliveredResult(state, at++, 'Running'), [host]);
    }
    setNow(80);
    host.frame();
    setNow(96);
    host.frame();

    // Скраб: четыре тика назад РАЗ В ДВЕ рассылки — те же 32 мс на доставку,
    // то есть 125 тиков в секунду, вдвое быстрее живого мира.
    let back = at - 1;
    for (let ms = 128; ms <= 256; ms += 32) {
      setNow(ms);
      back -= 4;
      dispatch(deliveredResult(state, back, 'Rewinding'), [host]);
    }
    setNow(272);
    host.frame();
    setNow(288);
    host.frame();

    const forward = dts[1]!;
    const backward = dts[dts.length - 1]!;
    expect(forward).toBeCloseTo(0.016, 6);
    // ВДВОЕ и назад. Считая спанами (4 тика против 1), темп вышел бы вчетверо —
    // клипы отматывались бы вдвое быстрее собственных ног.
    expect(backward).toBeCloseTo(-0.032, 4);
  });

  it('доставка раз в два тика: альфа доходит до единицы к следующей доставке', () => {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    // tickSeconds 0.05, а доставки — раз в 100 мс (conflation SHELL-4 либо
    // рассылка реже тиков). Знаменатель альфы обязан быть каденсом доставки:
    // по `tickSeconds` интерполяция кончалась бы на половине интервала, и
    // вторую половину сущность стояла бы — 50 % duty-цикл, «череда телепортов».
    const { host, setNow } = makeHost(scene);
    for (let i = 0; i < 20; i++) tick(sim, state);

    const alphas: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (_dt, alpha) => alphas.push(alpha),
    });

    let at = 10;
    for (let ms = 0; ms <= 400; ms += 100) {
      setNow(ms);
      dispatch(deliveredResult(state, (at += 2), 'Running'), [host]);
    }
    // Середина интервала доставок — ровно половина пути.
    setNow(450);
    host.frame();
    // Его конец — единица, а не «единица с 250 мс назад».
    setNow(500);
    host.frame();
    expect(alphas[0]).toBeCloseTo(0.5, 2);
    expect(alphas[1]).toBeCloseTo(1, 2);
  });

  it('доставки чаще тика альфу не ломают: знаменатель не меньше длительности тика', () => {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);
    for (let i = 0; i < 20; i++) tick(sim, state);

    const alphas: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (_dt, alpha) => alphas.push(alpha),
    });

    let at = 10;
    for (let ms = 0; ms <= 100; ms += 10) {
      setNow(ms);
      dispatch(deliveredResult(state, at++, 'Running'), [host]);
    }
    setNow(125); // половина ТИКА, а не половина интервала доставок
    host.frame();
    expect(alphas[0]).toBeCloseTo(0.5, 2);
  });
});

describe('RenderHost: часы кадра неактивного продюсера (REND-11)', () => {
  it('первый кадр после возвращения не доигрывает накопленный простой', () => {
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
    setNow(50);
    dispatch(tick(sim, state), [host]);
    // Первый кадр сессии: интервала ещё нет, dt — ноль.
    host.frame();
    setNow(66);
    host.frame();
    expect(dts[1]).toBeCloseTo(0.016, 5);

    // Сцену забрал другой продюсер (режим правки, REND-11): кадры потока тиков
    // не рисуются вовсе.
    const other = { name: 'document' };
    host.stage.publish(other, host.view);
    setNow(5000);
    host.frame();
    expect(dts).toHaveLength(2);

    // Поток тиков вернулся. Первый его кадр обязан быть НУЛЕВЫМ по dt: иначе
    // подсистемы доигрывают накопленный простой до потолка в 0.25 с разом.
    dispatch(deliveredResult(state, state.tick, 'Running'), [host]);
    setNow(5016);
    host.frame();
    expect(dts).toHaveLength(3);
    expect(dts[2]).toBe(0);
    setNow(5032);
    host.frame();
    expect(dts[3]).toBeCloseTo(0.016, 5);
  });
});

// ---- change `delivery-interpolation-and-dirty-extract`: буфер под джиттер

describe('RenderHost: показ отстаёт под наблюдаемый джиттер (REND-2, SHELL-7)', () => {
  /** Стенд каденса: доставки и кадры по управляемым часам, альфа — наружу. */
  function cadenceRig(): {
    deliver: (ms: number, at: number) => void;
    frame: (ms: number) => number;
    view: () => TickView;
  } {
    const { scene, sim } = makeScene();
    spawnRunner(scene, 0.5, 0.5, 0.1, 0);
    const state = initialState(scene.world, 7);
    const { host, setNow } = makeHost(scene);
    for (let i = 0; i < 40; i++) tick(sim, state);
    const alphas: number[] = [];
    host.register({
      name: 'probe',
      init: () => {},
      syncTick: () => {},
      updateFrame: (_dt, alpha) => alphas.push(alpha),
    });
    return {
      deliver: (ms, at) => {
        setNow(ms);
        dispatch(deliveredResult(state, at, 'Running'), [host]);
      },
      frame: (ms) => {
        setNow(ms);
        host.frame();
        return alphas[alphas.length - 1]!;
      },
      view: () => host.view,
    };
  }

  it('ровный каденс: отставание — ровно интервал, поведение прежнее', () => {
    const rig = cadenceRig();
    let at = 30;
    // Каденс стенда равен его же тику (50 мс): пол знаменателя альфы не
    // вмешивается, и видно ровно то, что было до буфера джиттера.
    for (let ms = 0; ms <= 300; ms += 50) rig.deliver(ms, at++);

    const cadence = rig.view().cadence!;
    expect(cadence.intervalSeconds).toBeCloseTo(0.05, 4);
    // Дрожания нет — и отставание равно интервалу: это и есть прежняя
    // интерполяция «между двумя последними доставленными тиками».
    expect(cadence.jitterSeconds).toBeCloseTo(0, 6);
    expect(cadence.delaySeconds).toBeCloseTo(cadence.intervalSeconds, 6);
    // Альфа считается ровно как прежде: доля интервала с последней доставки.
    expect(rig.frame(325)).toBeCloseTo(0.5, 2);
    expect(rig.frame(350)).toBeCloseTo(1, 2);
  });

  it('дрожащий каденс поднимает отставание, и оно ограничено двумя интервалами', () => {
    const rig = cadenceRig();
    let at = 30;
    let ms = 0;
    // Тот же средний каденс 50 мс, но доставки приходят то рано, то поздно:
    // джиттер ненулевой, и отставание обязано его учесть.
    for (let i = 0; i < 16; i++) {
      ms += i % 2 === 0 ? 25 : 75;
      rig.deliver(ms, at++);
    }
    const cadence = rig.view().cadence!;
    expect(cadence.intervalSeconds).toBeCloseTo(0.05, 2);
    expect(cadence.jitterSeconds).toBeGreaterThan(0);
    expect(cadence.delaySeconds).toBeGreaterThan(cadence.intervalSeconds);
    // Потолок — глубина буфера: одна отложенная доставка, то есть два интервала.
    expect(cadence.delaySeconds).toBeLessThanOrEqual(cadence.intervalSeconds * 2 + 1e-9);
  });
});
