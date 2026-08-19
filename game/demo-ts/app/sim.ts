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
  FIXED_ONE,
  InputSystem,
  LocomotionSystem,
  PhysicsSystem,
  PhysicsWorld,
  VISION_MODIFIER_COMPONENT,
  VisibilitySystem,
  createPhysicsApi,
  initialState,
  loadScene,
  mathApi,
  requireModifierList,
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
export const ACTION_BITS = {
  cast: 0,
  kill: 1,
  dodge: 2,
  jump: 3,
  slowDome: 4,
  capture: 5,
  shield: 6,
  /**
   * Ульта отката. Бит УДЕРЖАНИЯ, а не фронта: фронт кастует ульту (JSON-система
   * `RewindCast` сцены), а дальше тот же бит читает хост мира — сервер матча из
   * входящих кадров, локальная оболочка из сообщений главного потока, — и ведёт
   * точку перемотки, пока он не исчезнет. Второго канала под это в протоколе
   * нет и заводить его нельзя (`netcode-transport` NTR-8), поэтому номер бита
   * приезжает конфигом матча (`rewind.holdButton` в `duel.match.json`) — там он
   * обязан совпасть с этим.
   */
  rewind: 7,
} as const;

/**
 * Компоненты-состояния, зеркалируемые в `EntityView.states` (CAM-6): порядок
 * списка задаёт номера битов. Список ОДИН на обе половины сборки — Extractor
 * симуляции (`worker.ts`) выставляет по нему биты, диспетчер эффектов главного
 * потока (`main.ts`) по нему же ищет имя из таблицы `states` манифеста
 * (ASSET-8), и по нему же подсистема эффектов находит бит записи
 * `effects.byState` (REND-23). Два списка разошлись бы молча: эффект просто не
 * включался бы, а автор увидел бы только его отсутствие.
 *
 * `Shielded` — компонент щита (JSON-системы `ShieldCast`/`ShieldRicochet`/
 * `ShieldExpire` сцены): пока он висит на герое, оболочка `effects.byState`
 * рисует вокруг него синюю сферу — ту самую запись, под которую имя было
 * объявлено заранее, до контента. `Held` — снаряд, пойманный
 * захватом: пока он висит на держателе, его рисует оболочка `effects.byState`.
 * `Holding` — обратная сторона той же пары, уже на ГЕРОЕ: записи эффекта у неё
 * нет, и доставляется она затем, чтобы превью зоны захвата гасло, пока снаряд
 * в руках (`main.ts`), — состояние симуляции, а не догадка главного потока.
 * `Charging` — герой копит заряд каста: записи эффекта у него тоже нет (шар
 * заряда рисует главный поток, см. `chargeVisualOf`), а доставляется оно затем,
 * чтобы гасить превью зоны захвата — во время заряда `CaptureRelease` не
 * сработает.
 *
 * Порядок ДОБАВЛЕНИЯ важнее алфавита: бит существующего имени не должен
 * поехать — новое состояние дописывается в конец.
 */
export const STATE_COMPONENTS: readonly string[] = Object.freeze([
  'Falling',
  'Shielded',
  'Held',
  'Holding',
  'Charging',
]);

/** Бит состояния в `EntityView.states` (CAM-6); неизвестное имя — ошибка сборки. */
export function stateBit(component: string): number {
  const index = STATE_COMPONENTS.indexOf(component);
  if (index === -1) throw new Error(`демо: состояние "${component}" не зеркалируется Extractor'ом`);
  return 1 << index;
}

/**
 * Полный путь снаряда в тиках — ЗЕРКАЛО поля `AbilityConfig.throwLifetime`
 * prefab'а `Hero`, которым `ChargeRelease` и `ThrowHeld` заполняют
 * `Lifetime.ticks` (и умолчания `Lifetime` у prefab'а `Fireball`, которое ни
 * один из них не оставляет в силе). Знание СБОРКИ, а не ядра: из него Extractor выводит фазу
 * полёта (REND-12), а рендер по ней рисует полётную дугу. Расходится с
 * `AbilityConfig` — расходится только дуга: симуляция этого числа не читает.
 * Ретюнить оба вместе.
 */
export const FIREBALL_LIFETIME_TICKS = 50;

/**
 * Компонент селективного лока действий (LOC-7), который сцена вешает на героя
 * с пойманным снарядом: манёвры на это время запрещены, ходьба — нет. Имя —
 * знание СБОРКИ: ядро смысла бита не знает, а JSON-системы сцены и опции
 * `LocomotionSystem` обязаны называть один и тот же компонент.
 */
export const ACTION_LOCK_COMPONENT = 'ActionLock';

/**
 * Событие возрождения, которое эмитит система сцены `Respawn` (order 140).
 * Знание СБОРКИ: возрождение — политика этой сцены, а не конвенция ядра, и
 * своим умолчанием его не знает никто. Читают имя оба потребителя, которым
 * смерть переключает состояние и которым его нечем переключить обратно:
 * портрет HUD (`reviveEvent`, HUD-5) и подсистема моделей — фиксация
 * последнего кадра клипа смерти снимается ровно этим событием (REND-4).
 * Возрождение НЕ пересоздаёт сущность (тот же `EntityId` теряет `Dead`) и
 * разрыва в доставке не даёт, поэтому оба держатся на совпадении этой строки
 * с типом события системы.
 */
export const RESPAWN_EVENT = 'HeroRespawned';

/**
 * Геометрия зоны захвата в МИРОВЫХ единицах — то, из чего главный поток рисует
 * превью конуса под курсором (превью покадровое, симуляции о нём знать нечего).
 * Числа берутся из той же записи `AbilityConfig` prefab'а `Hero`, по которой
 * решает JSON-система `CaptureRelease`: второго набора балансных чисел не
 * заводится, а расхождение превью с проверкой стало бы обманом игрока.
 *
 * `halfAngleTurns` — доля оборота (FP-7, единица угла ядра), радиус — клетки
 * мира: Q16.16 за границу симуляции не выходит (REND-1).
 */
export function captureZoneOf(def: SceneDef): { radius: number; halfAngleTurns: number } {
  const hero = def.prefabs?.find((prefab) => prefab.name === 'Hero');
  const config = hero?.components.AbilityConfig;
  if (config === undefined) throw new Error("демо: у prefab'а Hero нет AbilityConfig");
  const radius = config.captureRadius;
  const halfAngle = config.captureHalfAngle;
  // Отсутствующее поле — не ноль: нулевой сектор невидим, и превью молча
  // перестало бы существовать вместо того, чтобы сообщить о дыре в контенте.
  if (radius === undefined || halfAngle === undefined) {
    throw new Error(
      "демо: в AbilityConfig prefab'а Hero нет captureRadius/captureHalfAngle — превью зоны рисовать нечем",
    );
  }
  return { radius: radius / FIXED_ONE, halfAngleTurns: halfAngle / FIXED_ONE };
}

/**
 * Геометрия и тайминг ШАРА ЗАРЯДА в мировых единицах — то, из чего главный
 * поток рисует растущий шар перед кастером, пока зажата ЛКМ.
 *
 * Причина та же, что у превью зоны захвата: заряд растёт МЕЖДУ тиками, а
 * оболочка эффекта `effects.byKind` радиуса на сущность не знает — её радиус
 * задан записью манифеста и один на весь тип (REND-23). Поэтому шар живёт в
 * главном потоке, а числа берутся из той же записи `AbilityConfig`, по которой
 * решает JSON-система `ChargeRelease`: второго набора балансных чисел не
 * заводится.
 *
 * `ticks`/`graceTicks` — сырые тики (их же считает `Charging.ticks`),
 * `maxScale` — множитель размера в конце заряда, `heavyScale` — порог, с
 * которого `ChargeRelease` рождает `HeavyFireball` (шар с него и перекрашивается
 * в цвет тяжёлого снаряда), `offset` — вынос шара перед кастером в клетках мира.
 */
export function chargeVisualOf(def: SceneDef): {
  ticks: number;
  graceTicks: number;
  maxScale: number;
  heavyScale: number;
  offset: number;
} {
  const hero = def.prefabs?.find((prefab) => prefab.name === 'Hero');
  const config = hero?.components.AbilityConfig;
  if (config === undefined) throw new Error("демо: у prefab'а Hero нет AbilityConfig");
  const { chargeTicks, chargeGraceTicks, chargeMaxScale, chargeHeavyScale, throwOffset } = config;
  // Отсутствующее поле — не ноль: нулевой заряд невидим, и шар молча перестал
  // бы существовать вместо того, чтобы сообщить о дыре в контенте.
  if (
    chargeTicks === undefined ||
    chargeGraceTicks === undefined ||
    chargeMaxScale === undefined ||
    chargeHeavyScale === undefined ||
    throwOffset === undefined
  ) {
    throw new Error(
      "демо: в AbilityConfig prefab'а Hero нет chargeTicks/chargeGraceTicks/chargeMaxScale/chargeHeavyScale/throwOffset — шар заряда рисовать нечем",
    );
  }
  return {
    ticks: chargeTicks,
    graceTicks: chargeGraceTicks,
    maxScale: chargeMaxScale / FIXED_ONE,
    heavyScale: chargeHeavyScale / FIXED_ONE,
    offset: throwOffset / FIXED_ONE,
  };
}

/**
 * Накопленные тики заряда по доставленному `Charging.ticks` (стат `charge`),
 * ограниченные окном роста `maxTicks` (`AbilityConfig.chargeTicks`).
 *
 * Тик НАЖАТИЯ окном заряда не считается: самый быстрый тап отпускается на
 * следующем тике и обязан дать обычный шар, а не «чуть заряженный». Ровно эту
 * же поправку и ровно тот же предел делает `ChargeRelease` в сцене — держать их
 * врозь нельзя, поэтому `maxTicks` здесь и там одно и то же число, а тики
 * передержки за него не выходят: они видны только в СЫРОМ `Charging.ticks`.
 */
export function chargeHeld(ticks: number, maxTicks: number): number {
  return Math.max(0, Math.min(ticks - 1, maxTicks));
}

/**
 * Имена доставляемых статов демо (`match-hud` HUD-8) — общий словарь двух
 * половин сборки: воркер объявляет по ним источники (`extractor.ts`), виджеты
 * биндятся на те же имена в композиции HUD (`hud.ts`). Имена принадлежат
 * СБОРКЕ, а не ядру: кодек и HUD их смысла не знают.
 *
 * Часть статов приезжает не всегда: компонента счёта в сцене демо ещё нет.
 * Виджет, не нашедший стата, показывает пустое состояние, а не ноль (HUD-8),
 * поэтому объявление его здесь заранее ничего не ломает и ничего не выдумывает.
 */
export const STATS = {
  /** Слот игрока — по нему счётчики раскладываются по игрокам. */
  slot: 'slot',
  hp: 'hp',
  hpMax: 'hpMax',
  deaths: 'deaths',
  /**
   * Накопленные тики заряда каста (`Charging.ticks`). Стат, а не состояние:
   * биту `EntityView.states` величины не передать, а шар заряда рисуется по
   * ней покадрово (`chargeVisualOf`). Компонента нет — стата НЕТ, и главный
   * поток отличает «не заряжает» от «заряд нулевой» (HUD-8).
   */
  charge: 'charge',
  /**
   * Команда сущности (`Team.id`) и радиус обзора (`Vision.radius`) — входы
   * маски видимости тумана войны (FOW-7, design D4): подсистема тумана берёт
   * наблюдателей СВОЕЙ команды из доставленного состояния по этим именам, а
   * команду игрока — из стата его героя. Новых каналов под это нет: обычные
   * доставляемые статы (HUD-8), радиус приезжает уже во float мировых единиц.
   */
  team: 'team',
  visionRadius: 'vision',
  /**
   * Радиус коллайдера сущности (`Collider.radius`) — вход отладочного источника
   * кругов коллизий (`render-debug` RDBG-6). Стат, а не выдуманное число: у
   * главного потока нет другого пути узнать величину компонента, и источник,
   * не нашедший стата, говорит «нет данных».
   */
  colliderRadius: 'collider',
  /** Оставшиеся тики кулдауна способности и его полная длительность. */
  cooldown: (ability: string): string => `${ability}.cd`,
  cooldownMax: (ability: string): string => `${ability}.cdMax`,
} as const;

/**
 * Компонент cooldown'а ульты отката. Отдельный от `Cooldowns` намеренно: он
 * назван exempt-компонентом в конфиге матча (`duel.match.json`) и потому
 * переживает перемотку целиком, а остальные перезарядки обязаны откатываться
 * вместе с миром — ради этого ульта и существует. Общий компонент сделал бы
 * «пережил откат» свойством всех способностей разом.
 */
export const REWIND_COOLDOWN_COMPONENT = 'RewindCooldown';

/**
 * Способности демо, у которых виджет показывает кулдаун (те же имена, что
 * INP-4), и источник его величины в мире. Перезарядку в сцене имеют `cast`,
 * `slowDome`, `capture`, `shield` и `rewind`; `dodge` и `jump` держат в
 * компоненте `Cooldowns` нулевой предел и потому всегда готовы — виджет читает
 * те же доставленные статы и рисует их кнопки без затемнения.
 *
 * Источник назван таблицей, а не выведен из имени способности: у ульты отката
 * он свой (`REWIND_COOLDOWN_COMPONENT`), и правило «поле того же имени в
 * `Cooldowns`» на ней бы молча сломалось — стат не приехал бы, а виджет показал
 * бы пустоту вместо перезарядки.
 */
export interface CooldownSource {
  readonly component: string;
  readonly field: string;
  readonly maxField: string;
}

export const COOLDOWN_SOURCES: Readonly<Record<string, CooldownSource>> = Object.freeze({
  cast: { component: 'Cooldowns', field: 'cast', maxField: 'castMax' },
  dodge: { component: 'Cooldowns', field: 'dodge', maxField: 'dodgeMax' },
  jump: { component: 'Cooldowns', field: 'jump', maxField: 'jumpMax' },
  slowDome: { component: 'Cooldowns', field: 'slowDome', maxField: 'slowDomeMax' },
  capture: { component: 'Cooldowns', field: 'capture', maxField: 'captureMax' },
  shield: { component: 'Cooldowns', field: 'shield', maxField: 'shieldMax' },
  rewind: { component: REWIND_COOLDOWN_COMPONENT, field: 'ticks', maxField: 'max' },
});

/** Порядок панели кулдаунов HUD — порядок объявления источников. */
export const COOLDOWN_ABILITIES: readonly string[] = Object.freeze(Object.keys(COOLDOWN_SOURCES));

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
  // здесь только раскладка кнопок демо и имя компонента селективного лока
  // (LOC-7): его вешает на героя JSON-система захвата, пока снаряд в руках.
  scene.systems.register(
    new LocomotionSystem({
      dodgeButton: ACTION_BITS.dodge,
      jumpButton: ACTION_BITS.jump,
      lockComponent: ACTION_LOCK_COMPONENT,
    }),
  );
  // Физика ядра: статика обрывов из террейна — игрок не сойдёт с плато мимо
  // рампы (PHYS-8, TERR-5). Снаряд без коллайдера — летит поверх обрывов.
  const physicsWorld = new PhysicsWorld(staticsFromTerrain(grid), grid.tileSize);
  scene.systems.register(new PhysicsSystem(physicsWorld));
  // Пересчёт видимости (FOW-4): сцена с `fog` объявляет компоненты, а систему
  // регистрирует сборка — ей нужен raycast, то есть зависимость сборки (DI-3).
  // Тот же состав, что у сетевого матча (`buildSimulation` через `visibility`
  // конфига матча): одиночная симуляция обязана тикать те же системы (SHELL-8).
  if (def.fog === true) {
    scene.systems.register(
      new VisibilitySystem(requireModifierList(scene.modifiers, VISION_MODIFIER_COMPONENT)),
    );
  }

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
    // Physics API обязателен рядом с `VisibilitySystem`: LoS-луч (FOW-5) идёт
    // через `ctx.physics.raycast`, и без него перекрытие обзора обрывами молча
    // выключено — локальный режим разошёлся бы с сетевым (SHELL-8), где
    // `buildSimulation` API передаёт.
    physics: createPhysicsApi(scene.world, physicsWorld),
  };

  return { sim, state, playerId, terrain, grid };
}
