/**
 * Эквивалентность разбиения (client-shell SHELL-2, задача 1.4): standalone-пара
 * Extractor → ViewBuffer, соединённая прямым вызовом, даёт на каждом тике тот
 * же `TickView`, что и собранный `RenderHost`, на одном и том же `TickResult`.
 *
 * Сцена намеренно трогает все ветки плоской формы: движение (интерполяция и
 * facingYaw), каст (aim из событий), телепорт (snap), смерть (despawn),
 * выбитый пол (floorDelta) — см. host.test.ts, откуда взята обвязка.
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
  tick,
  worldInitSpawn,
  type Scene,
  type Simulation,
  type System,
} from '@game-mvp/core';
import {
  Extractor,
  RenderHost,
  ViewBuffer,
  kindByTags,
  type TickView,
} from '../src/index.js';
import { makeAssets } from './fixtures.js';

const F = (n: number): number => fixed.fromFloat(n);

function makeScene(): { scene: Scene; sim: Simulation } {
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
      }
    },
  };
  const caster: System = {
    name: 'Caster',
    order: 20,
    run(ctx) {
      if (ctx.tick !== 3) return;
      for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
        ctx.events.emit('CastFireball', { entity, dirX: 0, dirY: F(1) });
      }
    },
  };
  const teleporter: System = {
    name: 'Teleporter',
    order: 30,
    run(ctx) {
      if (ctx.tick !== 5) return;
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
  const breaker: System = {
    name: 'FloorBreaker',
    order: 40,
    run(ctx) {
      if (ctx.tick !== 6) return;
      for (const terrain of ctx.query({ withTag: 'terrain' })) {
        const word = ctx.get(terrain, FLOOR_COMPONENT, 'w0');
        ctx.commands.setField(terrain, FLOOR_COMPONENT, 'w0', word & ~1);
      }
    },
  };
  const killer: System = {
    name: 'Killer',
    order: 50,
    run(ctx) {
      if (ctx.tick !== 8) return;
      for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
        ctx.commands.destroy(entity);
      }
    },
  };
  scene.systems.register(mover);
  scene.systems.register(caster);
  scene.systems.register(teleporter);
  scene.systems.register(breaker);
  scene.systems.register(killer);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 7,
    math: mathApi,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
  };
  return { scene, sim };
}

/** Снимок TickView в plain-объект для глубокого сравнения. */
function snapshotView(view: TickView): unknown {
  return {
    tick: view.tick,
    mode: view.mode,
    isReplay: view.isReplay,
    snapAll: view.snapAll,
    freshEvents: view.freshEvents,
    entities: [...view.entities.values()].map((entity) => ({ ...entity })),
    events: view.events.map((event) => ({ type: event.type, data: { ...event.data } })),
    floorBits: view.floorBits === null ? null : [...view.floorBits],
    floorChangedCells: [...view.floorChangedCells],
  };
}

describe('Разбиение RenderHost: пара Extractor/ViewBuffer эквивалентна хосту (SHELL-2)', () => {
  it('TickView совпадает на каждом тике сценария со всеми ветками', () => {
    const { scene, sim } = makeScene();
    worldInitSpawn(scene.world, 'Runner', {
      Position: { x: F(0.5), y: F(0.5) },
      Velocity: { x: F(0.1), y: F(0) },
    });
    const state = initialState(scene.world, 7);
    const grid = scene.terrain!.grid;

    let now = 0;
    const host = new RenderHost(
      { scene: new THREE.Scene(), assets: makeAssets().service, config: { heightStep: 0.5 } },
      {
        tickSeconds: 0.05,
        kindOf: kindByTags(['Runner']),
        terrainGrid: grid,
        aimEvents: ['CastFireball'],
        aimHoldTicks: 2,
        clock: () => now,
      },
    );

    const extractor = new Extractor({
      kindOf: kindByTags(['Runner']),
      terrainGrid: grid,
      aimEvents: ['CastFireball'],
      aimHoldTicks: 2,
    });
    const buffer = new ViewBuffer({
      tickSeconds: 0.05,
      floorBits: new Uint8Array(grid.floor),
      clock: () => now,
    });

    for (let step = 0; step < 10; step++) {
      now = step * 50;
      const result = tick(sim, state);
      dispatch(result, [host]);
      buffer.apply(extractor.extract(result));
      expect(snapshotView(buffer.view)).toEqual(snapshotView(host.view));
    }
    // Сценарий прошёл все ветки: сущность жила и умерла, пол выбит.
    expect(buffer.view.entities.size).toBe(0);
    expect(buffer.view.floorBits![0]).toBe(0);
  });
});
