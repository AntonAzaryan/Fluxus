/**
 * Прогон сценария без рендера и сети (CLI-1): вход — один JSON-документ со
 * сценой, seed, начальной расстановкой и инпутами (CLI-2), выход — снапшот
 * состояния на каждый тик (CLI-3).
 *
 * Чистая функция, а не команда: golden-тесты (CLI-5) зовут её напрямую, а
 * `bin/sim.mjs` добавляет к ней только чтение файла и вывод в stdout.
 *
 * Фильтрации по видимости здесь нет и не будет (CLI-5): golden фиксирует
 * полный мир, `viewpoint = ALL` — FoW живёт в транспорте, а не в ядре.
 */
import { spawn } from '../ecs/world.js';
import { InputSystem } from '../systems/inputSystem.js';
import { mathApi } from '../math/mathApi.js';
import {
  createPhysicsApi,
  PhysicsSystem,
  PhysicsWorld,
  staticsFromTerrain,
  type PhysicsOptions,
} from '../systems/physics.js';
import { ArenaSystem } from '../systems/arena.js';
import { VisibilitySystem, type VisibilityOptions } from '../systems/visibility.js';
import { loadScene, type SceneDef } from './scene.js';
import { prettyJsonSerializer, snapshotToPlain, type PlainSnapshot } from './serialization.js';
import { initialState, tick, type Simulation } from './tick.js';
import type { FieldOverrides, InputFrame, PhysicsApi, SimulationState } from '../types.js';

export interface ScenarioSpawn {
  readonly prefab: string;
  readonly overrides?: FieldOverrides;
}

export interface ScenarioDef {
  readonly name: string;
  readonly seed: number;
  readonly ticks: number;
  readonly scene: SceneDef;
  /** Начальная расстановка: порядок вызовов задаёт выданные ID (ID-2, DET-6). */
  readonly initial?: readonly ScenarioSpawn[];
  /** Канонические вводы тика (TICK-2); раскладываются по собственному полю `tick`. */
  readonly inputs?: readonly InputFrame[];
  /** Порядок игроков задаёт слоты (TICK-5); обязателен, если есть `inputs`. */
  readonly players?: readonly string[];
  /**
   * Включает физику (PHYS-4). Поле сценария, а не сцены: реализация — зависимость
   * сборки (DI-3, SER-7), в конфиге сцены её быть не должно.
   */
  readonly physics?: PhysicsOptions;
  /**
   * Включает пересчёт видимости (FOW-4). Как и физика — поле сценария, а не
   * сцены: системе нужен raycast, то есть зависимость сборки (DI-3).
   */
  readonly visibility?: VisibilityOptions;
}

/**
 * Снапшот тика. События входят в него сами (SNAP-1): `emitEvent` — единственный
 * наблюдаемый выход системы, ничего не пишущей в мир, и без него golden не
 * заметил бы его пропажу.
 */
export type TickRecord = PlainSnapshot;

export interface RunOutput {
  readonly scenario: string;
  readonly seed: number;
  /** Тик 0 — состояние после начальной расстановки, до первого `tick()`. */
  readonly ticks: readonly TickRecord[];
}

export function runScenario(def: ScenarioDef): RunOutput {
  if (typeof def.name !== 'string' || def.name === '') throw new Error('сценарий: "name" — непустая строка');
  if (!Number.isInteger(def.seed)) throw new Error(`сценарий "${def.name}": "seed" — целое число`);
  if (!Number.isInteger(def.ticks) || def.ticks < 0) {
    throw new Error(`сценарий "${def.name}": "ticks" — неотрицательное целое`);
  }

  if (def.inputs !== undefined && def.players === undefined) {
    throw new Error(`сценарий "${def.name}": есть "inputs", но нет "players" — слоты не определены (TICK-5)`);
  }

  const { world, systems, terrain, arena } = loadScene(def.scene);
  // Арена есть в сцене — значит, за её границей кто-то следит (ARENA-3, ARENA-5).
  if (arena !== undefined) systems.register(new ArenaSystem());
  if (def.players !== undefined) systems.register(new InputSystem({ players: def.players }));

  // Статика обрывов строится из террейна до расстановки: она иммутабельна и в
  // снапшот не входит (TERR-5, TERR-6).
  let physics: PhysicsApi | undefined;
  if (def.physics !== undefined) {
    const statics = terrain === undefined ? [] : staticsFromTerrain(terrain.grid);
    const physicsWorld = new PhysicsWorld(statics, terrain?.grid.tileSize);
    systems.register(new PhysicsSystem(physicsWorld, def.physics));
    physics = createPhysicsApi(world, physicsWorld, def.physics);
  }

  // Видимость считается по финальным позициям тика, поэтому регистрируется
  // после физики (FOW-6).
  if (def.visibility !== undefined) systems.register(new VisibilitySystem(def.visibility));

  for (const entry of def.initial ?? []) spawn(world, entry.prefab, entry.overrides);

  const state = initialState(world, def.seed);
  const sim: Simulation = {
    systems,
    worldSeed: def.seed,
    math: mathApi,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
    ...(physics !== undefined ? { physics } : {}),
  };

  const byTick = new Map<number, InputFrame[]>();
  for (const frame of def.inputs ?? []) {
    const list = byTick.get(frame.tick);
    if (list) list.push(frame);
    else byTick.set(frame.tick, [frame]);
  }

  const ticks: TickRecord[] = [record(state)];
  for (let i = 0; i < def.ticks; i++) {
    tick(sim, state, byTick.get(state.tick + 1) ?? []);
    ticks.push(record(state));
  }

  return { scenario: def.name, seed: def.seed, ticks };
}

/** Байты для golden-файла и stdout: pretty JSON того же документа. */
export function runScenarioBytes(def: ScenarioDef): Uint8Array {
  return prettyJsonSerializer.encode(runScenario(def));
}

function record(state: SimulationState): TickRecord {
  // Снапшот собирается из живого состояния без `takeSnapshot`: plain-форма и
  // так копирует всё в новые массивы, копия перед копией ничего не защищает.
  return snapshotToPlain({
    tick: state.tick,
    world: state.world,
    rng: state.rng.snapshot(),
    events: [...state.events],
    mode: state.mode,
  });
}
