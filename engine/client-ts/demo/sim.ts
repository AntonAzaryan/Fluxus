/**
 * Headless-половина демо: сборка мини-симуляции ядра из `content/scenes/duel.scene.json` —
 * без THREE и DOM, чтобы её можно было прогнать в Node (smoke-скрипты) и
 * переиспользовать из `main.ts`. Образец сборки — `test/host.test.ts` и
 * `core-ts/src/sim/scenario.ts`.
 *
 * Сцена собрана из готовых тестовых сценариев ядра (`engine/tests/golden`):
 * движение по инпуту — из `input-drive`, полёт снаряда — из `terrain`,
 * коллайдер и физика — из `physics`. TS-системы ниже добавляют только то, что
 * в JSON-DSL не выразить: распаковку направления каста и выбивание бита пола.
 */
import {
  FLOOR_COMPONENT,
  InputSystem,
  PhysicsSystem,
  PhysicsWorld,
  cellAt,
  fixed,
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

/** Скорость снаряда и вынос точки спавна от центра игрока, Q16.16 за тик. */
const FIREBALL_SPEED = fixed.fromFloat(0.25);
const FIREBALL_SPAWN_OFFSET = fixed.fromFloat(0.45);

// ------------------------------------------------- упаковка направления каста
//
// В `InputFrame` для прицеливания есть единственный скаляр `aimDir` (TICK-2),
// а тригонометрии в fixed-математике ядра нет — угол внутри симуляции не
// развернуть в вектор. Поэтому демо кодирует НАПРАВЛЕНИЕ каста двумя
// квантованными компонентами в одном i32: старшие 16 бит — y, младшие — x,
// каждый — знаковое Q2.14 (16384 = 1.0). Распаковка в системе каста — чистые
// целочисленные сдвиги, детерминизм не задет.

/** Единичное направление (float на входе демо) → упакованный aimDir. */
export function packAimDir(dirX: number, dirY: number): number {
  const qx = Math.max(-16383, Math.min(16383, Math.round(dirX * 16384)));
  const qy = Math.max(-16383, Math.min(16383, Math.round(dirY * 16384)));
  return ((qy << 16) | (qx & 0xffff)) | 0;
}

/** Q2.14 → Q16.16: ×4 сдвигом; знак у `qx` восстанавливается парой сдвигов. */
function unpackAimDir(packed: number): { x: number; y: number } {
  const qx = (packed << 16) >> 16;
  const qy = packed >> 16;
  return { x: qx << 2, y: qy << 2 };
}

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
   * Спавн фаербола: TS-система, потому что распаковка `aimDir` (сдвиги) в
   * JSON-DSL не выражается. Фронт кнопки и канонический факт каста — событие
   * `CastFireball` — даёт JSON-система `Cast` сцены; натив читает шину тика
   * (EVT-2, `Cast` идёт раньше по order) и делает только то, чего JSON не
   * может: разворачивает направление и спавнит снаряд. Направление для
   * доворота торса (REND-5) уходит драфтовым событием `FireballAimed` —
   * вместе с самим нативом оно исчезает на этапе 30 (fixed-тригонометрия).
   */
  const launchSystem: System = {
    name: 'FireballLaunch',
    order: 35,
    run(ctx) {
      const total = ctx.events.length; // свои эмиты в этот же тик не перечитываем
      for (let i = 0; i < total; i++) {
        const event = ctx.events.at(i);
        if (event.type !== 'CastFireball') continue;
        const entity = event.data['entity'];
        if (entity === undefined || !ctx.isAlive(entity)) continue;

        const raw = unpackAimDir(ctx.get(entity, 'Input', 'aimDir'));
        if (raw.x === 0 && raw.y === 0) continue; // каст без направления — no-op
        const dir = ctx.math.vec.normalize(raw);

        const px = ctx.get(entity, 'Position', 'x');
        const py = ctx.get(entity, 'Position', 'y');
        ctx.commands.spawn('Fireball', {
          Position: {
            x: ctx.math.add(px, ctx.math.mul(dir.x, FIREBALL_SPAWN_OFFSET)),
            y: ctx.math.add(py, ctx.math.mul(dir.y, FIREBALL_SPAWN_OFFSET)),
          },
          Velocity: {
            x: ctx.math.mul(dir.x, FIREBALL_SPEED),
            y: ctx.math.mul(dir.y, FIREBALL_SPEED),
          },
        });
        ctx.events.emit('FireballAimed', { entity, dirX: dir.x, dirY: dir.y });
      }
    },
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
  scene.systems.register(launchSystem);
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
