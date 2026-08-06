/**
 * Общие фикстуры тестов оболочки: мини-сцена ядра (движение по вводу, каст,
 * выбивание пола — все ветки плоской формы), синхронные пары портов для
 * детерминированных unit-тестов канала и снимок TickView для сравнения.
 */
import {
  FIXED_ONE,
  FLOOR_COMPONENT,
  InputSystem,
  fixed,
  initialState,
  loadScene,
  mathApi,
  worldInitSpawn,
  type Scene,
  type SceneDef,
  type Simulation,
  type SimulationState,
  type System,
} from '@game-mvp/core';
import { Extractor, kindByTags, type RenderContext, type TickView } from '@game-mvp/render';
import type { ShellPort } from '../src/index.js';

export const PLAYER_ID = 'p1';
export const TICK_SECONDS = 0.05;
export const STEP: number = fixed.fromFloat(0.1);
export const CAST_BUTTON = 1;

/** Сцена: герой с вводом, JSON-система движения, TS-системы каста и пола. */
export function sceneDef(): SceneDef {
  return {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: {
          aimDir: 'fixed',
          buttons: 'i32',
          moveX: 'fixed',
          moveY: 'fixed',
          prevButtons: 'i32',
          seq: 'i32',
        },
      },
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
    ],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: fixed.fromFloat(0.5), y: fixed.fromFloat(0.5) },
          Velocity: { x: 0, y: 0 },
        },
        tags: ['Hero'],
      },
    ],
    systems: [
      {
        name: 'Movement',
        order: 10,
        query: { all: ['Position', 'Input'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Velocity',
              values: {
                x: { getComponent: [{ var: 'e' }, 'Input', 'moveX'] },
                y: { getComponent: [{ var: 'e' }, 'Input', 'moveY'] },
              },
            },
          },
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: {
                x: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveX'] },
                  ],
                },
                y: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'y'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveY'] },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
    terrain: {
      width: 2,
      height: 2,
      tileSize: FIXED_ONE,
      levels: ['00', '00'],
      flags: ['..', '..'],
    },
    capacity: 8,
  };
}

export interface Rig {
  readonly scene: Scene;
  readonly sim: Simulation;
  readonly state: SimulationState;
}

/**
 * Собирает симуляцию фикстуры. `castOnTicks`/`breakFloorOnTick` включают
 * TS-системы каста (aim из событий) и выбивания клетки 0 пола.
 */
export function makeRig(options: { castOnTicks?: readonly number[]; breakFloorOnTick?: number } = {}): Rig {
  const scene = loadScene(sceneDef());
  scene.systems.register(new InputSystem({ players: [PLAYER_ID] }));
  if (options.castOnTicks !== undefined) {
    const casts = new Set(options.castOnTicks);
    const caster: System = {
      name: 'Caster',
      order: 30,
      run(ctx) {
        if (!casts.has(ctx.tick)) return;
        for (const entity of ctx.query({ all: ['Player', 'Position'] })) {
          ctx.events.emit('CastFireball', { entity, dirX: 0, dirY: FIXED_ONE });
        }
      },
    };
    scene.systems.register(caster);
  }
  if (options.breakFloorOnTick !== undefined) {
    const at = options.breakFloorOnTick;
    const breaker: System = {
      name: 'FloorBreaker',
      order: 40,
      run(ctx) {
        if (ctx.tick !== at) return;
        for (const terrain of ctx.query({ withTag: 'terrain' })) {
          const word = ctx.get(terrain, FLOOR_COMPONENT, 'w0');
          ctx.commands.setField(terrain, FLOOR_COMPONENT, 'w0', word & ~1);
        }
      },
    };
    scene.systems.register(breaker);
  }
  worldInitSpawn(scene.world, 'Hero');
  const state = initialState(scene.world, 7);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 7,
    math: mathApi,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
  };
  return { scene, sim, state };
}

export function makeExtractor(rig: Rig): Extractor {
  return new Extractor({
    kindOf: kindByTags(['Hero']),
    terrainGrid: rig.scene.terrain!.grid,
    aimEvents: ['CastFireball'],
    aimHoldTicks: 2,
  });
}

/** RenderContext для RemoteHost без THREE: подсистемы в тестах его не трогают. */
export function dummyContext(): RenderContext {
  return { scene: {}, assets: {}, config: { heightStep: 1 } } as unknown as RenderContext;
}

// ------------------------------------------------------------------- порты

/** Синхронная пара портов: доставка немедленная, без клона — для unit-тестов. */
export function syncPortPair(): [ShellPort, ShellPort] {
  const handlers: Array<((message: unknown) => void) | null> = [null, null];
  const make = (self: number, other: number): ShellPort => ({
    post(message) {
      handlers[other]?.(message);
    },
    onMessage(handler) {
      handlers[self] = handler;
    },
  });
  return [make(0, 1), make(1, 0)];
}

/** Пара, где воркер → main копится в очередь: тест дренирует сам (conflation). */
export function queuedPortPair(): { worker: ShellPort; main: ShellPort; drain: () => number } {
  let mainHandler: ((message: unknown) => void) | null = null;
  let workerHandler: ((message: unknown) => void) | null = null;
  const queue: unknown[] = [];
  return {
    worker: {
      post(message) {
        queue.push(message);
      },
      onMessage(handler) {
        workerHandler = handler;
      },
    },
    main: {
      post(message) {
        workerHandler?.(message);
      },
      onMessage(handler) {
        mainHandler = handler;
      },
    },
    drain() {
      let delivered = 0;
      while (queue.length > 0) {
        const message = queue.shift();
        mainHandler?.(message);
        delivered++;
      }
      return delivered;
    },
  };
}

// ------------------------------------------------------------------ снимки

/** Снимок TickView в plain-объект для глубокого сравнения. */
export function snapshotView(view: TickView): unknown {
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
