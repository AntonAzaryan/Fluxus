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
export const ACTION_BITS = { cast: 0, shield: 1, dodge: 2, jump: 3, catch: 4 } as const;

/**
 * Компонент селективного лока действий и бит «манёвры запрещены» (LOC-7).
 * Знание СБОРКИ, как и раскладка битов кнопок: ядру имя компонента и смысл
 * бита неизвестны, а системы сцены (`FireballCast`, `CatchCast`) ставят ровно
 * эту маску, пока герой копит заряд или держит пойманный снаряд.
 *
 * Те же два значения едут в `LocomotionSystem` матча полем `locomotion`
 * документа `content/matches/duel.match.json` (NTR-14): сборка одиночного
 * прогона и сборка матча обязаны собирать локомоушен одинаково, иначе локи
 * в них разъедутся при одной и той же сцене.
 */
export const ACTION_LOCK = { component: 'ActionLock', maneuverBit: 0 } as const;

/**
 * Компоненты-состояния, зеркалируемые в `EntityView.states` (CAM-6): порядок
 * списка задаёт номера битов. Список ОДИН на обе половины сборки — Extractor
 * симуляции (`worker.ts`) выставляет по нему биты, диспетчер эффектов главного
 * потока (`main.ts`) по нему же ищет имя из таблицы `states` манифеста
 * (ASSET-8), и по нему же подсистема эффектов находит бит записи
 * `effects.byState` (REND-23). Два списка разошлись бы молча: эффект просто не
 * включался бы, а автор увидел бы только его отсутствие.
 *
 * Состав — состояния боя сцены демо: `Falling` (провал в пустоту), `Shielded`
 * (щит держит урон), `Charging` (копится заряд фаербола), `Catching` (открыта
 * зона перехвата), `Carrying` (пойманный снаряд в руках). Колонка `flags`
 * вмещает шесть (`MAX_STATE_COMPONENTS`), поэтому запас ещё есть.
 */
export const STATE_COMPONENTS: readonly string[] = Object.freeze([
  'Falling',
  'Shielded',
  'Charging',
  'Catching',
  'Carrying',
]);

/**
 * Полный путь снаряда в тиках — поле `Lifetime.ticks` prefab'а `Fireball`
 * сцены демо. Знание СБОРКИ, а не ядра: из него Extractor выводит фазу полёта
 * (REND-12), а рендер по ней рисует полётную дугу. Расходится с prefab'ом —
 * расходится только дуга: симуляция этого числа здесь не читает.
 */
export const FIREBALL_LIFETIME_TICKS = 90;

/**
 * Имена доставляемых статов демо (`match-hud` HUD-8) — общий словарь двух
 * половин сборки: воркер объявляет по ним источники (`extractor.ts`), виджеты
 * биндятся на те же имена в композиции HUD (`hud.ts`). Имена принадлежат
 * СБОРКЕ, а не ядру: кодек и HUD их смысла не знают.
 *
 * Стат едет только у той сущности, у которой источник есть: снаряд без
 * `Health` не везёт ни `hp`, ни `hpMax`, и виджет видит пустое состояние, а не
 * выдуманный ноль (HUD-8).
 */
export const STATS = {
  /** Слот игрока — по нему счётчики раскладываются по игрокам. */
  slot: 'slot',
  hp: 'hp',
  hpMax: 'hpMax',
  deaths: 'deaths',
  /** Оставшиеся тики кулдауна способности и его полная длительность. */
  cooldown: (ability: string): string => `${ability}.cd`,
  cooldownMax: (ability: string): string => `${ability}.cdMax`,
} as const;

/**
 * Способности демо, у которых виджет показывает кулдаун (те же имена, что
 * INP-4, и те же поля компонента `Cooldowns` сцены). Уклон и прыжок в списке
 * не значатся: перезарядки у них нет, и оверлей у их кнопок был бы вечно
 * пустым — на экране их держат собственные кнопки раскладки (`bindings.json`).
 */
export const COOLDOWN_ABILITIES: readonly string[] = Object.freeze(['cast', 'shield', 'catch']);

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
  // Селективный лок манёвров (LOC-7) — те же имя компонента и бит, что у
  // сборки матча: их держит `ACTION_LOCK`, и обе половины читают его.
  scene.systems.register(
    new LocomotionSystem({
      dodgeButton: ACTION_BITS.dodge,
      jumpButton: ACTION_BITS.jump,
      lockComponent: ACTION_LOCK.component,
      maneuverLockBit: ACTION_LOCK.maneuverBit,
    }),
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
    // Арена сцены — вход `ArenaSystem` (ARENA-1): без неё система молчит, и
    // провал в клетку без пола не порождает `FellThroughFloor` (ARENA-5).
    ...(scene.arena !== undefined ? { arena: scene.arena } : {}),
  };

  return { sim, state, playerId, terrain, grid };
}
