/**
 * Headless-половина демо: сборка мини-симуляции ядра из `content/scenes/duel.scene.json` —
 * без THREE и DOM, чтобы её можно было прогнать в Node (smoke-скрипты) и
 * переиспользовать из `main.ts`. Образец сборки — `test/host.test.ts` и
 * `core-ts/src/sim/scenario.ts`.
 *
 * Сцена собрана из готовых тестовых сценариев ядра (`engine/tests/golden`):
 * движение по инпуту — из `input-drive`, полёт снаряда — из `terrain`,
 * коллайдер и физика — из `physics`. TS-система ниже добавляет только то, что
 * в JSON-DSL не выразить: выбивание бита пола.
 */
import {
  FLOOR_COMPONENT,
  InputSystem,
  PhysicsSystem,
  PhysicsWorld,
  cellAt,
  initialState,
  loadScene,
  mathApi,
  staticsFromTerrain,
  worldInitSpawn,
  type EntityId,
  type SceneDef,
  type Simulation,
  type SimulationState,
  type System,
  type TerrainApi,
  type TerrainGrid,
} from '@game-mvp/core';

// ----------------------------------------------------------------- константы

export const TICK_SECONDS = 1 / 60;
export const WORLD_SEED = 20260805;
/** Игрок демо один; порядок списка игроков задаёт слоты (TICK-5). */
export const PLAYER_ID = 'p1';

/** Биты маски `buttons` (TICK-2): договорённость демо, читается системами сцены. */
export const CAST_BUTTON = 1 << 0;
export const KILL_BUTTON = 1 << 1;

/**
 * Полный оборот в единице угла ядра (FP-7): `aimDir` — binary angle measure,
 * то есть сырое значение угла совпадает с Q16.16-долей оборота. Оболочка
 * считает угол `atan2` и квантует им — как `move` квантуется `fromFloat`.
 */
export const TURN_UNITS = 0x10000;

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

  /** Слов в компоненте карты пола — для адресации бита клетки (TERR-6). */
  const floorWordTotal = Math.ceil((grid.width * grid.height) / 32);
  /** Имя поля-слова карты пола: то же дополнение нулями, что в ядре. */
  const floorWordField = (cell: number): string => {
    const width = String(floorWordTotal - 1).length;
    return `w${String(cell >>> 5).padStart(width, '0')}`;
  };

  /**
   * Конец жизни фаербола: выбить бит пола клетки под точкой затухания (TERR-6;
   * рендер покажет дыру не позже следующего кадра, REND-7) и убрать снаряд.
   * TS-система: адресация слова/бита карты пола в JSON-DSL не выражается.
   */
  const impactSystem: System = {
    name: 'FireballImpact',
    order: 50,
    run(ctx) {
      for (const fireball of ctx.query({ all: ['Position', 'Lifetime'] })) {
        if (ctx.get(fireball, 'Lifetime', 'ticks') > 0) continue;
        const x = ctx.get(fireball, 'Position', 'x');
        const y = ctx.get(fireball, 'Position', 'y');
        const cell = cellAt(grid, { x, y });
        const field = floorWordField(cell);
        for (const holder of ctx.query({ withTag: 'terrain' })) {
          const word = ctx.get(holder, FLOOR_COMPONENT, field);
          ctx.commands.setField(holder, FLOOR_COMPONENT, field, word & ~(1 << (cell & 31)));
        }
        ctx.events.emit('FireballExploded', { x, y });
        ctx.commands.destroy(fireball);
      }
    },
  };

  scene.systems.register(new InputSystem({ players: [PLAYER_ID] }));
  scene.systems.register(impactSystem);
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
