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
  VISION_MODIFIER_COMPONENT,
  VisibilitySystem,
  colliderHeightDeclared,
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
} from '@fluxus/core';

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
  /**
   * Рывок. Бит читает не `LocomotionSystem`, а определение способности `dodge`
   * сцены (`trigger.input.bit`): рывок демо — способность с кулдауном, а не
   * манёвр по кнопке (`LocomotionOptions.dodgeButton` сборки равен `null`).
   */
  dodge: 2,
  jump: 3,
  slowDome: 4,
  capture: 5,
  shield: 6,
  /**
   * Ульта отката. Бит УДЕРЖАНИЯ, а не фронта: фронт кастует ульту (определение
   * `rewind` сцены), а дальше тот же бит читает хост мира — сервер матча из
   * входящих кадров, локальная оболочка из сообщений главного потока, — и ведёт
   * точку перемотки, пока он не исчезнет. Второго канала под это в протоколе
   * нет и заводить его нельзя (`netcode-transport` NTR-8), поэтому номер бита
   * приезжает конфигом матча (`rewind.holdButton` в `duel.match.json`) — там он
   * обязан совпасть с этим.
   */
  rewind: 7,
  /**
   * Подтверждение и отмена шага прицеливания (ABIL-5). Обычные биты маски, как
   * и всё остальное: собственных полей `InputFrame` они не получают, а что
   * именно они означают, решает определение способности сцены (INP-4, ABIL-3).
   *
   * В сцене их называют `confirmBit`/`cancelBit` определений фаербола и
   * захвата, в раскладке устройств (`bindings.json`) — правая кнопка мыши и
   * `Q`. Совпадение держится только именами действий: разошлись — бот и человек
   * подтверждают разными битами, и сцена этого не заметит.
   */
  confirm: 8,
  cancel: 9,
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
 * `Shielded` — маркер щита: его вешает определение способности, а снимает
 * `onExpire` баффа длительности (`buff-system` BUFF-6, design Decision 7). Пока
 * он висит на герое, оболочка `effects.byState` рисует вокруг него синюю
 * сферу — ту самую запись, под которую имя было объявлено заранее, до контента.
 * `Held` — снаряд, пойманный захватом: пока он висит на держателе, его рисует
 * та же оболочка. `Holding` — обратная сторона той же пары, уже на ГЕРОЕ.
 * `Charging` — герой копит заряд каста: маркер ставит фаза заряда определения,
 * и по нему `effects.byState` рисует шар перед кастером.
 *
 * Порядок ДОБАВЛЕНИЯ важнее алфавита: бит существующего имени не должен
 * поехать — новое состояние дописывается в конец.
 */
/**
 * Маркер смерти сцены демо. Знание СБОРКИ, как и `RESPAWN_EVENT`: смерть —
 * конвенция ядра (`EntityDied`), а КОМПОНЕНТ, которым сцена помечает мертвеца,
 * описывает сама сцена. Имя читают доставка состояний (`STATE_COMPONENTS`) и
 * подсистема моделей (`deadState`, REND-4) — оба держатся на совпадении этой
 * строки с компонентом сцены.
 */
export const DEAD_COMPONENT = 'Dead';

export const STATE_COMPONENTS: readonly string[] = Object.freeze([
  'Falling',
  'Shielded',
  'Held',
  'Holding',
  'Charging',
  // Маркер смерти сцены (системы `HealthDeath`/`FallDeath`/`KillSwitch`) —
  // ПОСЛЕДНИМ: порядок задаёт биты `EntityView.states` (CAM-6), и вставка в
  // середину переименовала бы состояния уже написанных записей манифеста.
  // Едет он ради фиксации клипа смерти по доставленному состоянию (REND-4):
  // событие `EntityDied` живёт один тик, а инстанс — сколько угодно, поэтому
  // труп, вернувшийся из тумана, и босс, возрождённый СВОЕЙ системой, без него
  // читались бы неверно (FOW-8).
  DEAD_COMPONENT,
]);

/** Бит состояния в `EntityView.states` (CAM-6); неизвестное имя — ошибка сборки. */
export function stateBit(component: string): number {
  const index = STATE_COMPONENTS.indexOf(component);
  if (index === -1) throw new Error(`демо: состояние "${component}" не зеркалируется Extractor'ом`);
  return 1 << index;
}

/**
 * Полный путь снаряда в тиках — ЗЕРКАЛО поля `AbilityProjectile.ticksLeft`
 * prefab'а `Fireball`, которым доставка определения считает жизнь снаряда
 * (`ability-system` ABIL-9). Знание СБОРКИ, а не ядра: из него Extractor
 * выводит фазу полёта (REND-12), а рендер по ней рисует полётную дугу.
 * Расходится со сценой — расходится только дуга: симуляция этого числа не
 * читает. Ретюнить оба вместе.
 */
export const FIREBALL_LIFETIME_TICKS = 50;

/**
 * Числа заряда каста, которые нужны КАРТИНКЕ: размер и место шара заряда
 * (`chargeBalls.ts`) и порог, с которого главный поток показывает предикт
 * траектории (`main.ts`).
 *
 * Все четыре — ЗЕРКАЛО чисел определения `fireball` сцены (ABIL-2) в их родном
 * Q16.16: по ним считает симуляция, а картинка обязана считать по тем же, иначе
 * шар обещает не тот выстрел, который улетит. Определение из DSL не читается
 * (ABIL-1), доставать их обходом дерева действий — значит держаться за форму
 * чужого списка, поэтому здесь они зеркалом, а совпадение держит тест сцены:
 * он ищет каждое из них ВНУТРИ определения, куда бы оно там ни переехало.
 * Расходятся — расходится только картинка: симуляция этих полей не читает.
 */
export const CHARGE_VISUAL = Object.freeze({
  /** Окно роста в тиках: тем же числом определение обрезает накопленный заряд. */
  ticks: 60,
  /** Размер на полном заряде — множитель Q16.16 (2.0), он же множитель урона. */
  maxScale: 2 * 65536,
  /** С этого множителя определение спавнит `HeavyFireball` — шар берёт его цвет. */
  heavyScale: 98304,
  /** Вынос перед кастером: та же точка, с которой стартует выстрел (0.45). */
  offset: 29491,
});

/**
 * Порог, с которого главный поток показывает предикт траектории каста
 * (`AbilityPreviewSubsystem.applyLocalInput`, REND-28): пока заряд младше него,
 * превью не рисуется вовсе.
 *
 * Одиночный клик ЛКМ — это выстрел, а не прицеливание: фигура шага, мигнувшая
 * на два кадра, читается как сбой картинки, а не как подсказка. Шесть тиков —
 * 100 мс при 60 Гц: короче обычного клика (по замерам ввода клик держится
 * 50–120 мс) и заметно короче того момента, когда игрок уже понял, что ДЕРЖИТ
 * кнопку. Величина — политика картинки: симуляция её не читает, и от порога не
 * зависит ни один исход каста.
 */
export const CHARGE_PREVIEW_MIN_TICKS = 6;

/**
 * Накопленный заряд по счётчику `Charging.ticks` — ТА ЖЕ арифметика, которой
 * определение считает силу выстрела: тик нажатия окном роста не считается,
 * сверх окна заряд не растёт (дальше он только передержан).
 */
export function chargeHeld(ticks: number): number {
  return Math.max(Math.min(ticks - 1, CHARGE_VISUAL.ticks), 0);
}

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
  /**
   * Держимая точка пути NPC (`NpcAgent.pathX`/`pathY`/`pathValid`, `npc-behavior`
   * NPC-6) — вход отладочного источника нитей пути (`render-debug` RDBG-6).
   * Основание то же, что у радиуса коллайдера: у главного потока нет другого
   * пути узнать величину компонента, а источник, не нашедший стата, говорит
   * «нет данных» и выдуманной точки не рисует. Границу видимости это не двигает
   * — статы едут только на ДОСТАВЛЕННЫХ сущностях (`netcode` NET-12).
   */
  navPathX: 'navX',
  navPathY: 'navY',
  navPathValid: 'navHold',
  /**
   * Заряд каста (`Charging.ticks`) и прицел (`Input.aimDir`) — входы шара
   * заряда главного потока (`chargeBalls.ts`). Оба живут НА ГЕРОЕ, а не на
   * сущности-слоте, и это несущее: слот виден только стороне владельца
   * (`netcode` NET-12, ABIL-8), а заряжаемый шар противника обязан быть виден
   * противнику из доставленного состояния (HUD-1) — иначе удар, которого не
   * видно. `Charging.ticks` при этом не второй счётчик, а доставляемая проекция
   * `AbilitySlot.phaseTicks` фазы заряда: пишет её система сцены `ChargeTick`.
   */
  charge: 'charge',
  aim: 'aim',
  /** Оставшиеся тики кулдауна способности и его полная длительность. */
  cooldown: (ability: string): string => `${ability}.cd`,
  cooldownMax: (ability: string): string => `${ability}.cdMax`,
  /**
   * Состояние сущности-слота способности (`ability-system` ABIL-1), доставленное
   * НА ВЛАДЕЛЬЦЕ: индекс определения, фаза каста, число подтверждённых шагов и
   * сами шаги. Их читает подсистема превью каста (REND-28) — единственный
   * потребитель, которому мало битов состояния: ей нужны числа.
   */
  slotAbility: (ability: string): string => `${ability}.ability`,
  slotPhase: (ability: string): string => `${ability}.phase`,
  slotStaged: (ability: string): string => `${ability}.staged`,
  slotStepX: (ability: string, step: number): string => `${ability}.s${step}x`,
  slotStepY: (ability: string, step: number): string => `${ability}.s${step}y`,
  slotStepEntity: (ability: string, step: number): string => `${ability}.s${step}e`,
} as const;

/**
 * Номер слота способности у героя (`AbilitySlot.slotIndex`, ABIL-1) — общий
 * словарь сцены, сборки и профиля бота. Сцена выдаёт слоты системой `GrantSlots`
 * и этими же номерами их адресует, сборка по ним собирает статы кулдауна и
 * превью, профиль бота — блоком `cast.slotIndex` (BOT-6). Разошлись — стат
 * приедет от чужой способности, и заметить это можно только глазами.
 */
export const ABILITY_SLOTS = Object.freeze({
  cast: 0,
  slowDome: 1,
  capture: 2,
  shield: 3,
  rewind: 4,
  throwHeld: 5,
  dodge: 6,
});

/**
 * Способности демо, у которых виджет показывает кулдаун (те же имена, что
 * INP-4), и номер слота, на котором лежит его величина. Остаток кулдауна живёт
 * отдельным компонентом сущности-слота (ABIL-1, ABIL-7), поэтому источник — это
 * пара «номер слота, поле `AbilityCooldown`», а не поле на герое.
 *
 * `jump` слота не имеет вовсе: это манёвр локомоушена (LOC-5), а не способность
 * платформы. Виджет его кнопки рисует, а стата не находит и показывает «нет
 * данных» — то есть кнопку без затемнения (HUD-8). `dodge` слот имеет: рывок
 * демо — способность с кулдауном в секунду (ABIL-7), и виджет, объявленный
 * заранее, наконец получил свою величину.
 */
export const COOLDOWN_SOURCES: Readonly<Record<string, number>> = Object.freeze({
  cast: ABILITY_SLOTS.cast,
  dodge: ABILITY_SLOTS.dodge,
  slowDome: ABILITY_SLOTS.slowDome,
  capture: ABILITY_SLOTS.capture,
  shield: ABILITY_SLOTS.shield,
  rewind: ABILITY_SLOTS.rewind,
});

/** Порядок панели кулдаунов HUD — порядок кнопок, а не источников. */
export const COOLDOWN_ABILITIES: readonly string[] = Object.freeze([
  'cast',
  'dodge',
  'jump',
  'slowDome',
  'capture',
  'shield',
  'rewind',
]);

/**
 * Слоты, чьё состояние доставляется превью каста (REND-28). Их ровно два —
 * фаербол и захват: только у них есть цепочка прицеливания, а превью рисует
 * фигуру шага. Остальные слоты состояния в кадр не возят: стат без потребителя
 * — это байты в каждом кадре каждой сущности.
 */
export const PREVIEW_SLOTS: readonly string[] = Object.freeze(['cast', 'capture']);

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
      // `null` — уклон системой не стартует: рывок демо стал СПОСОБНОСТЬЮ
      // (определение `dodge` сцены, ABIL-3), и её кулдаун платформа гейтит сама
      // (ABIL-7). Останься здесь бит уклона — одно нажатие стартовало бы манёвр
      // дважды: сначала способностью, потом системой, — и кулдаун ничего бы не
      // значил. Прыжок триггером системы остаётся: у него способности нет.
      dodgeButton: null,
      jumpButton: ACTION_BITS.jump,
      lockComponent: ACTION_LOCK_COMPONENT,
    }),
  );
  // Физика ядра: статика обрывов из террейна — игрок не сойдёт с плато мимо
  // рампы (PHYS-8, TERR-5). Снаряд без коллайдера — летит поверх обрывов.
  const physicsWorld = new PhysicsWorld(staticsFromTerrain(grid), grid.tileSize);
  // Зависимости сборки физики (DI-3): колоночный гейт включает сцена, объявив
  // поле высоты у своего компонента коллайдера (PHYS-14), а уровень цели луч
  // берёт из запроса террейна (TERR-4). Тот же состав, что у `buildSimulation`
  // сетевого матча: одиночная симуляция обязана тикать ту же физику (SHELL-8).
  const physicsDeps = { height: colliderHeightDeclared(scene.world), terrain };
  scene.systems.register(new PhysicsSystem(physicsWorld, {}, physicsDeps));
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
    physics: createPhysicsApi(scene.world, physicsWorld, {}, physicsDeps),
  };

  return { sim, state, playerId, terrain, grid };
}
