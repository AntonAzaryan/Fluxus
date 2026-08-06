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
import { LocomotionSystem, type LocomotionOptions } from '../systems/locomotion.js';
import { mathApi } from '../math/mathApi.js';
import {
  createPhysicsApi,
  PhysicsSystem,
  PhysicsWorld,
  staticsFromTerrain,
  type PhysicsOptions,
} from '../systems/physics.js';
import { requireModifierList } from '../systems/modifiers.js';
import { VisibilitySystem, VISION_MODIFIER_COMPONENT, type VisibilityOptions } from '../systems/visibility.js';
import { loadScene, type SceneDef } from './scene.js';
import { prettyJsonSerializer, snapshotToPlain, type PlainSnapshot } from './serialization.js';
import { initialState, tick, type Simulation } from './tick.js';
import { worldInitHash } from './worldInit.js';
import type {
  DiagnosticsSink,
  FieldOverrides,
  InputFrame,
  PhysicsApi,
  SimulationState,
} from '../types.js';

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
   * Включает нативный локомоушен (LOC-1). Поле сценария по тем же основаниям,
   * что и физика: какая реализация движет героя — зависимость сборки (SER-7),
   * а не данные сцены.
   */
  readonly locomotion?: LocomotionOptions;
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
  /**
   * Хеш `worldInit` (DET-1, CLI-3). Стоит перед `ticks`, потому что диагностика
   * требует сравнивать хеши раньше снапшотов: расхождение начальных данных
   * обязано быть видно в первых строках, до потиковой сверки.
   */
  readonly worldInitHash: string;
  /** Тик 0 — состояние после начальной расстановки, до первого `tick()`. */
  readonly ticks: readonly TickRecord[];
}

/**
 * Приёмник трейса (CLI-7). Необязателен: без него документ прогона совпадает с
 * тем, что был до появления диагностики, — эталоны от параметра не зависят.
 */
export function runScenario(def: ScenarioDef, diagnostics?: DiagnosticsSink): RunOutput {
  if (typeof def.name !== 'string' || def.name === '') throw new Error('сценарий: "name" — непустая строка');
  if (!Number.isInteger(def.seed)) throw new Error(`сценарий "${def.name}": "seed" — целое число`);
  if (!Number.isInteger(def.ticks) || def.ticks < 0) {
    throw new Error(`сценарий "${def.name}": "ticks" — неотрицательное целое`);
  }

  if (def.inputs !== undefined && def.players === undefined) {
    throw new Error(`сценарий "${def.name}": есть "inputs", но нет "players" — слоты не определены (TICK-5)`);
  }

  // Системы, включаемые составом сцены (в том числе `ArenaSystem`), регистрирует
  // сам загрузчик (SER-7); здесь — только те, которым нужна зависимость сборки.
  const { world, systems, terrain, arena, modifiers } = loadScene(def.scene);
  if (def.players !== undefined) systems.register(new InputSystem({ players: def.players }));
  if (def.locomotion !== undefined) systems.register(new LocomotionSystem(def.locomotion));

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
  if (def.visibility !== undefined) {
    systems.register(
      new VisibilitySystem(requireModifierList(modifiers, VISION_MODIFIER_COMPONENT), def.visibility),
    );
  }

  for (const entry of def.initial ?? []) spawn(world, entry.prefab, entry.overrides);

  const state = initialState(world, def.seed);
  // Считается здесь и только здесь: после начальной расстановки и до первого
  // тика — ровно тот момент, который DET-1 называет `worldInit`.
  const hash = worldInitHash({
    world,
    mode: state.mode,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
  });
  const sim: Simulation = {
    systems,
    worldSeed: def.seed,
    math: mathApi,
    modifiers,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
    ...(physics !== undefined ? { physics } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
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

  return { scenario: def.name, seed: def.seed, worldInitHash: hash, ticks };
}

/** Байты для golden-файла и stdout: pretty JSON того же документа. */
export function runScenarioBytes(def: ScenarioDef, diagnostics?: DiagnosticsSink): Uint8Array {
  return prettyJsonSerializer.encode(runScenario(def, diagnostics));
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
