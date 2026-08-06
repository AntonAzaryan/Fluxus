/**
 * Манёвры локомоушена в рендере: состояние и фаза из машины LOC-3 доезжают
 * плоской формой (REND-4), инстанс играет клип манёвра и уходит по дуге
 * прыжка, а провал (ARENA-5) опускает его вниз (REND-12).
 *
 * Конвейер прогоняется на настоящей мини-симуляции с `LocomotionSystem`:
 * фаза манёвра считается по полям мира, и подменять их руками означало бы
 * тестировать не то, что поедет в картинку.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FIXED_ONE,
  LEVEL_OVERRIDE_COMPONENT,
  InputSystem,
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_DODGE,
  LOCOMOTION_NORMAL,
  LOCOMOTION_ROLL,
  LOCOMOTION_WINDOW,
  LocomotionSystem,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type EntityId,
  type InputFrame,
  type Scene,
  type Simulation,
  type SimulationState,
} from '@game-mvp/core';
import type { VisualManifest } from '@game-mvp/assets';
import {
  Extractor,
  ModelsSubsystem,
  ViewBuffer,
  kindByTags,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const F = (n: number): number => fixed.fromFloat(n);

/** Биты кнопок — дефолты `LocomotionSystem`: уклон 1, прыжок 2. */
const DODGE = 1 << 1;
const JUMP = 1 << 2;

/** Балансные числа — контент (LOC-1); подобраны так, чтобы фазы были круглыми. */
const CONFIG = {
  maxSpeed: F(4),
  accel: F(4),
  decel: F(4),
  dodgeSpeed: F(6),
  dodgeTicks: 2,
  windowTicks: 3,
  rollSpeed: F(3),
  rollTicks: 4,
  jumpSpeed: F(2),
  jumpTicks: 4,
  jumpHeight: 1,
} as const;

interface Rig {
  scene: Scene;
  sim: Simulation;
  state: SimulationState;
  hero: EntityId;
  step: (over?: Partial<InputFrame>) => void;
}

function makeRig(): Rig {
  const scene = loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
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
      { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
      {
        name: 'Locomotion',
        fields: {
          maxSpeed: 'fixed',
          accel: 'fixed',
          decel: 'fixed',
          dodgeSpeed: 'fixed',
          dodgeTicks: 'i32',
          windowTicks: 'i32',
          rollSpeed: 'fixed',
          rollTicks: 'i32',
          jumpSpeed: 'fixed',
          jumpTicks: 'i32',
          jumpHeight: 'i32',
        },
      },
      {
        name: 'LocomotionState',
        fields: { state: 'i32', ticksLeft: 'i32', dirX: 'fixed', dirY: 'fixed' },
      },
      // Прыжок ставит override уровня на время полёта (LOC-5, ARENA-6).
      { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
    ],
    prefabs: [
      {
        name: 'Runner',
        components: {
          Position: { x: F(1.5), y: F(1.5) },
          Player: { slot: 0 },
          Input: {},
          Velocity: {},
          Locomotion: { ...CONFIG },
          LocomotionState: {},
        },
        tags: ['Runner'],
      },
      // Сущность, которой локомоушен не касается: у неё нет ни конфигурации,
      // ни состояния манёвров — участие определяется составом компонентов.
      { name: 'Prop', components: { Position: { x: F(2.5), y: F(2.5) } }, tags: ['Runner'] },
    ],
    terrain: {
      width: 4,
      height: 4,
      tileSize: FIXED_ONE,
      levels: ['0000', '0000', '0000', '0000'],
      flags: ['....', '....', '....', '....'],
    },
  });
  scene.systems.register(new InputSystem({ players: ['p1'] }));
  scene.systems.register(new LocomotionSystem());
  const hero = worldInitSpawn(scene.world, 'Runner');
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 1,
    math: mathApi,
    terrain: scene.terrain!,
  };
  const state = initialState(scene.world, 1);

  let at = 0;
  const step = (over: Partial<InputFrame> = {}): void => {
    at += 1;
    tick(sim, state, [
      { tick: at, playerId: 'p1', seq: at, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0, ...over },
    ]);
  };
  return { scene, sim, state, hero, step };
}

/** Extractor + ViewBuffer поверх рига: то же, что делает хост. */
function makePipeline(rig: Rig): { pump: () => void; buffer: ViewBuffer } {
  const extractor = new Extractor({
    kindOf: kindByTags(['Runner']),
    terrainGrid: rig.scene.terrain!.grid,
  });
  const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
  let last = 0;
  return {
    buffer,
    pump: () => {
      // Extractor читает мир после тика — ровно как `RenderHost.onTick`.
      buffer.apply(
        extractor.extract({
          state: rig.state,
          tick: (last += 1),
          mode: rig.state.mode,
          isReplay: false,
          events: rig.state.events,
          changes: { isEmpty: true, changedEntities: () => new Set<EntityId>() },
        }),
      );
    },
  };
}

describe('Extractor: состояние и фаза манёвра (REND-4, REND-12)', () => {
  it('уклон → окно → перекат: состояния и фазы по ходу манёвров', () => {
    const rig = makeRig();
    const { pump, buffer } = makePipeline(rig);
    const view = () => buffer.view.entities.get(rig.hero)!;

    rig.step({ move: { x: F(1), y: 0 }, buttons: DODGE });
    pump();
    expect(view().motion).toBe(LOCOMOTION_DODGE);
    // Первый тик манёвра: ticksLeft ещё полный, фаза — ноль.
    expect(view().currMotionPhase).toBeCloseTo(0, 6);

    rig.step({ move: { x: F(1), y: 0 } });
    pump();
    expect(view().motion).toBe(LOCOMOTION_DODGE);
    expect(view().currMotionPhase).toBeCloseTo(0.5, 6); // (2 − 1) / 2

    rig.step({ move: { x: F(1), y: 0 } });
    pump();
    expect(view().motion).toBe(LOCOMOTION_WINDOW);
    // Окно даблтапа манёвром не является — фазы у него нет (REND-4).
    expect(view().currMotionPhase).toBeNaN();

    rig.step({ move: { x: F(1), y: 0 }, buttons: DODGE });
    pump();
    expect(view().motion).toBe(LOCOMOTION_ROLL);
    expect(view().currMotionPhase).toBeCloseTo(0, 6);

    for (const expected of [0.25, 0.5, 0.75]) {
      rig.step({ move: { x: F(1), y: 0 } });
      pump();
      expect(view().motion).toBe(LOCOMOTION_ROLL);
      expect(view().currMotionPhase).toBeCloseTo(expected, 6);
    }

    rig.step({ move: { x: F(1), y: 0 } });
    pump();
    expect(view().motion).toBe(LOCOMOTION_NORMAL);
    expect(view().currMotionPhase).toBeNaN();
  });

  it('прыжок: фаза от нуля до конца манёвра, prev/curr скользят по тикам', () => {
    const rig = makeRig();
    const { pump, buffer } = makePipeline(rig);

    rig.step({ move: { x: F(1), y: 0 }, buttons: JUMP });
    pump();
    expect(buffer.view.entities.get(rig.hero)!.motion).toBe(LOCOMOTION_AIRBORNE);

    rig.step({ move: { x: F(1), y: 0 } });
    pump();
    const view = buffer.view.entities.get(rig.hero)!;
    expect(view.prevMotionPhase).toBeCloseTo(0, 6);
    expect(view.currMotionPhase).toBeCloseTo(0.25, 6);
    // Override уровня на время полёта (ARENA-6) виден рендеру (REND-10).
    expect(view.levelOverride).toBe(true);

    for (let i = 0; i < 3; i++) {
      rig.step({ move: { x: F(1), y: 0 } });
      pump();
    }
    const landed = buffer.view.entities.get(rig.hero)!;
    expect(landed.motion).toBe(LOCOMOTION_NORMAL);
    expect(landed.currMotionPhase).toBeNaN();
    expect(landed.levelOverride).toBe(false);
  });

  it('сущность без компонента локомоушена — Normal без фазы (LOC-1)', () => {
    const rig = makeRig();
    const bare = worldInitSpawn(rig.scene.world, 'Prop');
    rig.step();
    const extractor = new Extractor({ kindOf: kindByTags(['Runner']) });
    const ext = extractor.extract({
      state: rig.state,
      tick: 1,
      mode: rig.state.mode,
      isReplay: false,
      events: rig.state.events,
      changes: { isEmpty: true, changedEntities: () => new Set<EntityId>() },
    });
    const index = [...ext.id.subarray(0, ext.count)].indexOf(bare);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(ext.motion[index]).toBe(LOCOMOTION_NORMAL);
    expect(ext.motionPhase[index]).toBeNaN();
  });
});

describe('ViewBuffer: скольжение фазы манёвра (REND-2)', () => {
  /** Синтетический тик на одну сущность: проверяются правила буфера, не мир. */
  const extOf = (tickNumber: number, phase: number, snapAll = false) => ({
    tick: tickNumber,
    mode: 'Running' as const,
    isReplay: false,
    snapAll,
    freshEvents: true,
    count: 1,
    id: new Float64Array([5]),
    kind: new Int32Array([-1]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    level: new Uint8Array([0]),
    flags: new Uint8Array([0]),
    facingYaw: new Float32Array([Number.NaN]),
    aimYaw: new Float32Array([Number.NaN]),
    motion: new Uint8Array([LOCOMOTION_AIRBORNE]),
    motionPhase: new Float32Array([phase]),
    events: [],
    floorDelta: [],
    kindTable: [],
  });

  it('фаза скользит по доставленным тикам, разрыв непрерывности её схлопывает', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extOf(1, 0));
    const view = () => buffer.view.entities.get(5)!;
    expect(view().prevMotionPhase).toBe(0);
    expect(view().currMotionPhase).toBe(0);

    buffer.apply(extOf(2, 0.25));
    expect(view().prevMotionPhase).toBe(0);
    expect(view().currMotionPhase).toBeCloseTo(0.25, 6);

    // Замороженный тик (Paused): мир не изменился — буфер не двигаем.
    buffer.apply(extOf(2, 0.25));
    expect(view().prevMotionPhase).toBe(0);
    expect(view().currMotionPhase).toBeCloseTo(0.25, 6);

    // Conflation (SHELL-4): невиденные тики пропали, скольжение идёт по доставленным.
    buffer.apply(extOf(5, 0.75));
    expect(view().prevMotionPhase).toBeCloseTo(0.25, 6);
    expect(view().currMotionPhase).toBeCloseTo(0.75, 6);

    // Rewind/смена режима: интерполировать не по чему — prev = curr.
    buffer.apply(extOf(3, 0.5, true));
    expect(view().prevMotionPhase).toBeCloseTo(0.5, 6);
    expect(view().currMotionPhase).toBeCloseTo(0.5, 6);
  });
});

// -------------------------------------------------------- подсистема моделей

const MODEL_ID = 'models/runner.mdx';

function makeManifest(verticalOffset?: {
  jumpArc?: number;
  fallSpeed?: number;
  fallDepth?: number;
}): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        animations: {
          states: { idle: 'Stand', move: 'Walk', roll: 'Roll', jump: 'Jump', fall: 'Fall' },
          events: { EntityDied: 'Death' },
        },
        ...(verticalOffset === undefined ? {} : { verticalOffset }),
      },
    },
  };
}

function makeModelsRig(verticalOffset?: { jumpArc?: number; fallSpeed?: number; fallDepth?: number }) {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(makeManifest(verticalOffset), { warn: () => {} });
  subsystem.init(ctx);
  return { subsystem, assets, ctx };
}

describe('ModelsSubsystem: состояния манёвров (REND-4)', () => {
  it('перекат и прыжок играют свои клипы, окно даблтапа — обычный move', () => {
    const { subsystem, assets } = makeModelsRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    assets.resolve('model', MODEL_ID, makeModel());
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Walk Fast');

    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true, motion: LOCOMOTION_ROLL })]),
    );
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Roll');

    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true, motion: LOCOMOTION_AIRBORNE })]),
    );
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Jump Loop');

    // Окно даблтапа — не манёвр: анимация та же, что при обычном беге (LOC-4).
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true, motion: LOCOMOTION_WINDOW })]),
    );
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Walk Fast');

    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: false })]));
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Stand - 1');
  });

  it('состояние без записи в манифесте оставляет текущий клип', () => {
    const { subsystem, assets } = makeModelsRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    assets.resolve('model', MODEL_ID, makeModel());
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Walk Fast');

    // Уклона в манифесте нет — фолбэка кодом не происходит (REND-4).
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true, motion: LOCOMOTION_DODGE })]),
    );
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Walk Fast');
  });

  it('провал играет клип fall по событию арены (ARENA-5)', () => {
    const { subsystem, assets } = makeModelsRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: true,
        events: [{ type: 'FellThroughFloor', data: { entity: 1 } }],
      }),
    );
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Fall');
  });
});

describe('ModelsSubsystem: вертикальное смещение (REND-12)', () => {
  const jumping = (phasePrev: number, phaseCurr: number) =>
    makeEntityView(1, {
      motion: LOCOMOTION_AIRBORNE,
      levelOverride: true,
      prevMotionPhase: phasePrev,
      currMotionPhase: phaseCurr,
    });

  it('дуга прыжка поднимает инстанс и возвращает его на землю', () => {
    const { subsystem, assets } = makeModelsRig({ jumpArc: 2 });
    subsystem.syncTick(makeTickView([jumping(Number.NaN, 0)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBeCloseTo(0, 6);

    subsystem.syncTick(makeTickView([jumping(0.25, 0.5)]));
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBeCloseTo(2, 6);
    // Половина тика между фазами 0.25 и 0.5 — среднее вкладов (REND-2).
    subsystem.updateFrame(0.016, 0.5);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBeCloseTo(1.75, 6);

    // Тик приземления: манёвра больше нет — инстанс на поверхности.
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBeCloseTo(0, 6);
  });

  it('без параметров манифеста дуги нет', () => {
    const { subsystem, assets } = makeModelsRig();
    subsystem.syncTick(makeTickView([jumping(0.25, 0.5)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(0.016, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBe(0);
  });

  it('провал опускает инстанс до глубины, snap возвращает на поверхность', () => {
    const { subsystem, assets } = makeModelsRig({ fallSpeed: 6, fallDepth: 3 });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: true,
        events: [{ type: 'FellThroughFloor', data: { entity: 1 } }],
      }),
    );
    subsystem.updateFrame(0.1, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBeCloseTo(-0.6, 6);
    subsystem.updateFrame(1, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBe(-3); // упёрлось в глубину

    // Респавн телепортом — разрыв непрерывности: снижение отменено (REND-2).
    subsystem.syncTick(makeTickView([makeEntityView(1, { snap: true })]));
    subsystem.updateFrame(0.1, 1);
    expect(subsystem.instanceFor(1)!.holder.position.z).toBe(0);
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Stand - 1');
  });
});
