/**
 * Headless-половина демо: сборка мини-симуляции ядра из `content/scenes/duel.scene.json` —
 * без THREE и DOM, чтобы её можно было прогнать в Node (smoke-скрипты) и
 * переиспользовать из `main.ts`. Образец сборки — `test/host.test.ts` и
 * `core-ts/src/sim/scenario.ts`.
 *
 * Сцена собрана из готовых тестовых сценариев ядра (`engine/tests/golden`):
 * движение по инпуту — из `input-drive`, полёт снаряда — из `terrain`,
 * коллайдер и физика — из `physics`. Геймплей сцены — весь в JSON; нативными
 * здесь регистрируются только `InputSystem` и `PhysicsSystem` — механизм
 * движка, которому в JSON не место (TICK-4, DI-3).
 */
import {
  InputSystem,
  LocomotionSystem,
  PhysicsSystem,
  PhysicsWorld,
  initialState,
  loadScene,
  mathApi,
  staticsFromTerrain,
  worldInitSpawn,
  type EntityId,
  type SceneDef,
  type Simulation,
  type SimulationState,
  type TerrainApi,
  type TerrainGrid,
} from '@game-mvp/core';

// ----------------------------------------------------------------- константы

export const TICK_SECONDS = 1 / 60;
export const WORLD_SEED = 20260805;
/** Игрок демо один; порядок списка игроков задаёт слоты (TICK-5). */
export const PLAYER_ID = 'p1';

/**
 * Имя действия → индекс бита `buttons` (TICK-2, input-devices INP-4): данные
 * демо-контента, единственный источник смысла битов. Их читают системы сцены
 * (`LocomotionSystem` — индексы) и сэмплер ввода (`InputSampler.actionBits`);
 * раскладку кнопок ядро не знает (LOC-1).
 */
export const ACTION_BITS = { cast: 0, kill: 1, dodge: 2, jump: 3 } as const;

// ------------------------------------------------------------------- сборка

export interface DemoSimulation {
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly playerId: EntityId;
  readonly terrain: TerrainApi;
  readonly grid: TerrainGrid;
}

/**
 * Поднимает сцену демо: мир, системы, физика, игрок. Чистая функция без DOM;
 * `def` — содержимое `content/scenes/duel.scene.json` (браузер импортирует его через vite,
 * headless-скрипты читают файл сами — у Node и vite разные механики JSON).
 */
export function createDemoSimulation(def: SceneDef): DemoSimulation {
  const scene = loadScene(def);
  if (scene.terrain === undefined) throw new Error('демо: сцена обязана содержать террейн');
  const terrain = scene.terrain;
  const grid = terrain.grid;

  scene.systems.register(new InputSystem({ players: [PLAYER_ID] }));
  // Передвижение героя: разгон/торможение и манёвры уклона, переката и прыжка
  // (LOC-1..6). Конфигурация — поля компонента `Locomotion` у prefab'а Hero,
  // здесь только раскладка кнопок демо.
  scene.systems.register(
    new LocomotionSystem({ dodgeButton: ACTION_BITS.dodge, jumpButton: ACTION_BITS.jump }),
  );
  // Физика ядра: статика обрывов из террейна — игрок не сойдёт с плато мимо
  // рампы (PHYS-8, TERR-5). Снаряд без коллайдера — летит поверх обрывов.
  scene.systems.register(
    new PhysicsSystem(new PhysicsWorld(staticsFromTerrain(grid), grid.tileSize)),
  );

  const playerId = worldInitSpawn(scene.world, 'Hero');
  const state = initialState(scene.world, WORLD_SEED);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: WORLD_SEED,
    math: mathApi,
    terrain,
    modifiers: scene.modifiers,
  };

  return { sim, state, playerId, terrain, grid };
}
