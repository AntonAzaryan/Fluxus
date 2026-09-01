/**
 * Конфиг сцены (SER-7) — то, что пишет редактор: компоненты, prefabs и
 * системы одним документом.
 *
 * Загрузчик поднимает мир и реестр, но не создаёт `SimulationState` и не
 * тикает: `math` и `physics` — зависимости сборки (DI-2, DI-3), а не данные
 * сцены, и в конфиге их нет.
 */
import { createWorld, spawn, type PrefabDef } from '../ecs/world.js';
import { SystemRegistry } from '../systems/registry.js';
import type { SystemDef } from '../dsl/evaluatedSystem.js';
import {
  createTerrainApi,
  createTerrainGrid,
  floorComponentSchema,
  terrainPrefab,
  TERRAIN_PREFAB,
  type TerrainDef,
} from '../systems/terrain.js';
import {
  arenaPrefab,
  checkArenaSupport,
  createArenaApi,
  ArenaSystem,
  ARENA_COMPONENTS,
  ARENA_PREFAB,
  type ArenaDef,
} from '../systems/arena.js';
import {
  fowComponents,
  DETECTION_SOURCES_COMPONENT,
  STEALTH_SOURCES_COMPONENT,
  VISION_MODIFIER_COMPONENT,
  type FowLists,
} from '../systems/visibility.js';
import { TimeScaleSystem, timeComponents, TIME_SCALE_MODIFIERS_COMPONENT } from '../systems/time.js';
import { TweenSystem, TWEEN_SCHEMA, type TweenDef } from '../systems/tween.js';
import { modifierList, DEFAULT_MODIFIER_SLOTS } from '../systems/modifiers.js';
import { ABILITY_COMPONENTS, BUFF_COMPONENTS } from '../systems/abilities/components.js';
import { compileAbilityCatalog } from '../systems/abilities/catalog.js';
import { BuffSystem } from '../systems/abilities/buffs.js';
import { CastPhaseSystem } from '../systems/abilities/phase.js';
import { TargetingCommitSystem } from '../systems/abilities/targeting.js';
import { CastInterruptSystem } from '../systems/abilities/interrupt.js';
import { CooldownSystem } from '../systems/abilities/cooldown.js';
import { EffectDurationSystem } from '../systems/abilities/duration.js';
import { ProjectileSystem } from '../systems/abilities/projectile.js';
import { AbilityVisibilitySystem } from '../systems/abilities/visibility.js';
import type {
  AbilityCatalog,
  AbilityDef,
  AbilityRuntimeDef,
  BuffDef,
} from '../systems/abilities/model.js';
import { NPC_COMPONENTS } from '../systems/npc/components.js';
import { compileNpcCatalog } from '../systems/npc/document.js';
import { NpcBehaviorSystem } from '../systems/npc/behavior.js';
import { NpcDirectorSystem } from '../systems/npc/director.js';
import { NpcMovementSystem } from '../systems/npc/movement.js';
import { NpcThreatSystem } from '../systems/npc/threat.js';
import type { NpcCatalog, NpcPlatformDef } from '../systems/npc/model.js';
import { applyPlacement, type ScenarioSpawn } from './placement.js';
import type {
  ArenaApi,
  ComponentSchema,
  ModifierList,
  ModifierRegistry,
  TerrainApi,
  TerrainGrid,
  WorldState,
} from '../types.js';

export interface SceneDef {
  /** Порядок задаёт битовые id компонентов и потому является частью формата (SER-7). */
  readonly components: readonly ComponentSchema[];
  readonly prefabs?: readonly PrefabDef[];
  readonly systems?: readonly SystemDef[];
  readonly capacity?: number;
  /** Ассет террейна (TERR-2). Компонент карты пола и его prefab порождаются из него. */
  readonly terrain?: TerrainDef;
  /** Ассет арены (ARENA-1). Компоненты радиуса и состояния и prefab порождаются из него. */
  readonly arena?: ArenaDef;
  /** Подключает `TimeScale`, `TimeScaleModifiers` и сведение источников (TIME-2, TIME-7). */
  readonly timeScale?: boolean;
  /** Таблица определений твинов (TWEEN-1, TWEEN-3): наличие включает `TweenSystem`. */
  readonly tweens?: readonly TweenDef[];
  /**
   * Подключает компоненты тумана войны (FOW-1..3). Саму `VisibilitySystem`
   * сцена не регистрирует: ей нужен raycast, то есть зависимость сборки (DI-3).
   *
   * Требует `terrain`: без запроса уровня фильтр по высоте (FOW-5) неисполним,
   * и сцена с `fog` без террейна отвергается загрузчиком (SER-7).
   */
  readonly fog?: boolean;
  /**
   * Число слотов в списках источников-модификаторов (TIME-7, FOW-3); по
   * умолчанию 4. Часть формата снапшота: от него зависят и состав, и имена
   * полей компонентов источников (SER-6, SER-7).
   */
  readonly modifierSlots?: number;
  /**
   * Номера мягких стелс-каналов (FOW-12, SER-7): целые `[0, 31]` без повторов.
   * Не перечисленные каналы — жёсткие; отсутствие поля — все жёсткие
   * (умолчание консервативно к информации). Требует `fog`. В мир и снапшот
   * таблица не входит: она порождена конфигом и иммутабельна на матч.
   */
  readonly softStealthChannels?: readonly number[];
  /**
   * Таблица определений способностей (ABIL-2): наличие подключает компоненты
   * платформы и её системы. Определения живут полем конфига сцены, а не
   * отдельными документами, по той же причине, что таблица определений твинов:
   * из мира определение адресуется индексом в таблице (ABIL-1).
   */
  readonly abilities?: readonly AbilityDef[];
  /**
   * Таблица определений баффов (BUFF-2): наличие подключает компонент инстанса
   * и `BuffSystem`. От `abilities` независима — бафф накладывается обычным
   * списком действий и способностей не требует (BUFF-1, SER-7).
   */
  readonly buffs?: readonly BuffDef[];
  /**
   * Биндинги сцены для платформы способностей (ABIL-8): что в этой сцене
   * значат смерть, лок действий, сторона и урон. Понятий игрока, здоровья и
   * урона ядро при этом не приобретает.
   */
  readonly abilityRuntime?: AbilityRuntimeDef;
  /**
   * Платформа поведения NPC (`npc-behavior` NPC-2): таблица документов
   * поведения, биндинги сцены, бюджет решений и таблица волн. Наличие поля
   * подключает компоненты платформы и её системы — тем же порядком, каким
   * `abilities` подключает платформу способностей.
   *
   * Документы живут полем конфига сцены, а не отдельными файлами, по той же
   * причине, что таблицы твинов и способностей: из мира документ адресуется
   * ИНДЕКСОМ в таблице (поле `NpcAgent.behavior`), а индекс имеет смысл только
   * вместе с таблицей. Деревом контента это остаётся: конфиг сцены и есть
   * контент (CONT-1).
   */
  readonly npc?: NpcPlatformDef;
  /**
   * Начальная расстановка сцены (SER-7, SER-8) — то, что стоит на арене в
   * каждом её прогоне. Порядок записей нормативен: он задаёт выданные
   * `index`/`generation` (ID-2, DET-6), а через плоскую форму мира — хеш
   * `worldInit` (DET-1). Сортировать и дедуплицировать список нельзя.
   *
   * Расстановку документа прогона (сценарий CLI-2, конфиг матча NTR-5) она не
   * замещает и не замещается ею: они складываются, сцена идёт первой.
   */
  readonly initial?: readonly ScenarioSpawn[];
}

/**
 * Инварианты состава сцены, проверяемые ДО создания мира (SER-7, ABIL-8):
 * молчаливый фолбэк выглядел бы исправной сценой и расходился бы с нормой
 * только там, где это дорого заметить.
 */
function checkSceneInvariants(def: SceneDef): void {
  // Туман войны без террейна не определён и потому запрещён (SER-7): пересчёт
  // видимости обязан отсекать кандидатов по уровню запросом уровня сущности к
  // террейну (FOW-5, TERR-4), а в сцене без террейна запроса уровня нет вовсе.
  // Отказ здесь, до создания мира, а не молчаливый фолбэк «все уровни нулевые»:
  // тот выглядел бы исправной FoW и отличался бы от неё только на сценах с
  // перепадом высот.
  if (def.fog === true && def.terrain === undefined) {
    throw new Error(
      'SER-7: сцена включает туман войны (fog) без террейна (terrain) — ' +
        'пересчёту видимости не у кого спросить уровень сущности (FOW-5, TERR-4)',
    );
  }
  // Туман вместе со способностями требует объявленной стороны (ABIL-8):
  // основание то же, что у пары «туман без террейна» — без стороны маску
  // видимости сущности-слота вычислить нечем, и реализация оказалась бы перед
  // выбором, какую норму нарушить, сделав слот публичным вопреки NET-12 или
  // невидимым никому.
  if (def.fog === true && def.abilities !== undefined && def.abilityRuntime?.teamField === undefined) {
    throw new Error(
      'ABIL-8: сцена включает туман войны (fog) и определения способностей (abilities), ' +
        'но не объявляет биндинг стороны (abilityRuntime.teamField)',
    );
  }
  // Таблица мягких каналов без тумана ни к чему не относится (SER-7): молчаливое
  // игнорирование поля скрыло бы опечатку в конфиге.
  if (def.softStealthChannels !== undefined && def.fog !== true) {
    throw new Error(
      'SER-7: сцена объявляет мягкие стелс-каналы (softStealthChannels) без тумана войны (fog) — ' +
        'без компонентов тумана нет ни стелс-масок, ни пересчёта (FOW-12)',
    );
  }
}

/**
 * Маска жёстких каналов из перечисления мягких (FOW-12, SER-7): валидация
 * адресная, умолчание — все каналы жёсткие. Считается до создания мира: в мир
 * и снапшот таблица не входит.
 */
function hardStealthMask(channels: readonly number[] | undefined): number {
  let soft = 0;
  for (const channel of channels ?? []) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 31) {
      throw new Error(
        `SER-7: мягкий стелс-канал ${channel} вне диапазона [0, 31] — маска каналов 32-битная (FOW-2, FOW-3)`,
      );
    }
    const bit = 1 << channel;
    if ((soft & bit) !== 0) {
      throw new Error(`SER-7: мягкий стелс-канал ${channel} перечислен дважды (softStealthChannels)`);
    }
    soft |= bit;
  }
  return ~soft;
}

/**
 * Состав компонентов мира. Порядок нормативен (SER-7): floor → arena →
 * timeScale → tween → fow → компоненты платформы способностей → компонент
 * инстанса баффа. Он задаёт битовые id компонентов, то есть представление
 * масок в снапшоте.
 */
function sceneComponents(
  def: SceneDef,
  grid: TerrainGrid | undefined,
  timeScaleModifiers: ModifierList,
  fowLists: FowLists,
): ComponentSchema[] {
  return [
    ...def.components,
    ...(grid === undefined ? [] : [floorComponentSchema(grid)]),
    ...(def.arena === undefined ? [] : ARENA_COMPONENTS),
    ...(def.timeScale === true ? timeComponents(timeScaleModifiers) : []),
    ...(def.tweens === undefined ? [] : [TWEEN_SCHEMA]),
    ...(def.fog === true ? fowComponents(fowLists) : []),
    ...(def.abilities === undefined ? [] : ABILITY_COMPONENTS),
    ...(def.buffs === undefined ? [] : BUFF_COMPONENTS),
    ...(def.npc === undefined ? [] : NPC_COMPONENTS),
  ];
}

/** Prefab'ы мира: объявленные сценой плюс носители террейна и арены (SER-7). */
function scenePrefabs(def: SceneDef, grid: TerrainGrid | undefined): PrefabDef[] {
  return [
    ...(def.prefabs ?? []),
    ...(grid === undefined ? [] : [terrainPrefab(grid)]),
    // Ассет арены валидируется здесь же, до `createWorld`.
    ...(def.arena === undefined ? [] : [arenaPrefab(def.arena)]),
  ];
}

/**
 * Нативные системы, включаемые самим составом сцены (SER-7). Их регистрация
 * здесь, а не у вызывающего: без них объявленные компоненты — мёртвые данные.
 * Исключение — только системы, которым нужна зависимость сборки:
 * `PhysicsSystem` и `VisibilitySystem` (нужен raycast, DI-3).
 *
 * Порядок регистрации сохраняется дословно: он наблюдаем через порядок
 * прогона систем при равном `order` (SYS-2).
 */
function registerSceneSystems(
  systems: SystemRegistry,
  def: SceneDef,
  world: WorldState,
  timeScaleModifiers: ModifierList,
  modifiers: ModifierRegistry,
  abilities: AbilityCatalog | undefined,
  npc: NpcCatalog | undefined,
): void {
  // `TweenSystem` разбирает пути к полям в конструкторе, поэтому битый
  // `target` падает на загрузке сцены, а не в середине матча (SYS-3).
  // Арена есть в сцене — значит, за её границей кто-то следит (ARENA-3, ARENA-5).
  if (def.arena !== undefined) systems.register(new ArenaSystem());
  if (def.timeScale === true) systems.register(new TimeScaleSystem(timeScaleModifiers));
  if (def.tweens !== undefined) systems.register(new TweenSystem(def.tweens));
  registerAbilitySystems(systems, def, modifiers, abilities);
  registerNpcSystems(systems, npc);
  // Валидация каждой системы — внутри registerFromJson (SYS-3): конфиг с
  // опечаткой не должен доживать до первого тика.
  for (const system of def.systems ?? []) systems.registerFromJson(system, world);
}

/** Системы платформы способностей и баффов (SER-7, ABIL-10, BUFF-1, NET-12). */
function registerAbilitySystems(
  systems: SystemRegistry,
  def: SceneDef,
  modifiers: ModifierRegistry,
  abilities: AbilityCatalog | undefined,
): void {
  if (abilities === undefined) return;
  if (def.abilities !== undefined) {
    systems.register(new TargetingCommitSystem(abilities));
    systems.register(new CastPhaseSystem(abilities));
    systems.register(new ProjectileSystem(abilities));
    systems.register(new CooldownSystem());
    systems.register(new EffectDurationSystem(abilities));
    systems.register(new CastInterruptSystem(abilities));
  }
  // `BuffSystem` включает своё поле конфига, а не поле способностей: сцена с
  // одними баффами законна (SER-7, BUFF-1). Списки источников она разрешает в
  // конструкторе, поэтому статовая правка, адресующая неподключённый список, —
  // ошибка загрузки (BUFF-4).
  if (def.buffs !== undefined) {
    systems.register(new BuffSystem(abilities, modifiers));
  }
  // Маску сущностям-спутникам платформы пишет отдельная система (NET-12), и
  // включает её пара «есть определения + сцена с туманом». Туман здесь условие,
  // а не вкус: без `fog` компонента `Visibility` в мире нет вовсе, вешать его
  // спутнику некуда, а фильтр снапшота на такой сцене не режет никого.
  // Обе группы определений, а не одни `abilities`: инстанс баффа — такой же
  // спутник, как слот, и сцена вправе объявить `buffs` без способностей (SER-7).
  if (def.fog === true) {
    systems.register(new AbilityVisibilitySystem(abilities));
  }
}

/**
 * Платформа поведения NPC включается составом сцены целиком (SER-7, NPC-2):
 * зависимостей сборки у её систем нет — восприятие есть прямое чтение мира
 * (NPC-1), поиск пути не требуется (NAV-6), — а без систем объявленные
 * компоненты остались бы мёртвыми данными. Сами документы разобраны до
 * создания мира.
 */
function registerNpcSystems(systems: SystemRegistry, npc: NpcCatalog | undefined): void {
  if (npc === undefined) return;
  systems.register(new NpcBehaviorSystem(npc));
  systems.register(new NpcMovementSystem(npc));
  systems.register(new NpcThreatSystem(npc));
  // Режиссёр включается таблицей волн, а не самой платформой: сцена вправе
  // расставить NPC руками и волн не иметь вовсе (NPC-8).
  if (npc.waves !== undefined) systems.register(new NpcDirectorSystem(npc));
}

export interface Scene {
  readonly world: WorldState;
  readonly systems: SystemRegistry;
  /** Есть, если сцена содержит террейн. */
  readonly terrain?: TerrainApi;
  /** Есть, если сцена содержит арену. */
  readonly arena?: ArenaApi;
  /**
   * Списки источников-модификаторов сцены (TIME-7, FOW-3) — по одному
   * экземпляру на сцену, а не на модуль (DI-1). Есть всегда: от флагов
   * `timeScale`/`fog` зависит только то, дописана ли схема в мир.
   */
  readonly modifiers: ModifierRegistry;
  /**
   * Скомпилированная таблица определений способностей и баффов (ABIL-10,
   * BUFF-2). Есть, если сцена содержит `abilities` либо `buffs`. Иммутабельна и
   * в снапшот не входит — как террейн и арена, она порождена данными сцены
   * (design Decision 2).
   */
  readonly abilities?: AbilityCatalog;
  /**
   * Скомпилированная платформа поведения NPC (NPC-2). Есть, если сцена
   * объявила `npc`. Живёт рядом с таблицей способностей и по тем же
   * основаниям: порождена данными сцены, иммутабельна и в снапшот не входит —
   * состояние агентов целиком лежит в полях компонентов (NPC-1).
   */
  readonly npc?: NpcCatalog;
  /**
   * Маска жёстких стелс-каналов (FOW-12): взведённый бит — канал жёсткий.
   * Есть, если сцена содержит `fog`. Порождена конфигом
   * (`softStealthChannels`, SER-7), иммутабельна и в снапшот не входит — как
   * террейн и таблица способностей; сборка передаёт её `VisibilitySystem`.
   */
  readonly stealthHardMask?: number;
}

export function loadScene(def: SceneDef): Scene {
  checkSceneInvariants(def);
  // Схемы карты пола и арены зависят от ассетов, поэтому дописываются к
  // объявленным компонентам, а не пишутся в сцене руками (TERR-6, ARENA-1).
  const grid = def.terrain === undefined ? undefined : createTerrainGrid(def.terrain);
  const slots = def.modifierSlots ?? DEFAULT_MODIFIER_SLOTS;
  const timeScaleModifiers = modifierList(TIME_SCALE_MODIFIERS_COMPONENT, slots);
  const fowLists: FowLists = {
    vision: modifierList(VISION_MODIFIER_COMPONENT, slots),
    stealth: modifierList(STEALTH_SOURCES_COMPONENT, slots, 'mask'),
    detection: modifierList(DETECTION_SOURCES_COMPONENT, slots, 'mask'),
  };
  const modifiers: ModifierRegistry = new Map(
    [timeScaleModifiers, fowLists.vision, fowLists.stealth, fowLists.detection].map(
      (list) => [list.component, list] as const,
    ),
  );
  // Валидация таблицы каналов — до создания мира, как остальные инварианты
  // состава (SER-7); сама маска нужна только сцене с туманом.
  const stealthHardMask = hardStealthMask(def.softStealthChannels);
  const components = sceneComponents(def, grid, timeScaleModifiers, fowLists);
  const prefabs = scenePrefabs(def, grid);
  // Коэффициент опоры в prefabs сцены — доля в [0, 1] (ARENA-3): опечатка
  // контента не должна доживать до первого тика.
  checkArenaSupport(def.prefabs ?? []);
  // Документы поведения NPC проверяются ДО создания мира (SER-7, NPC-2): опечатка
  // в имени исполнителя не должна доживать даже до расстановки. Мира компиляции
  // не нужно — документ поведения не адресует ни компонентов, ни prefab'ов, — и
  // тем она отличается от таблицы способностей, которой мир необходим (ABIL-10).
  const npc = def.npc === undefined ? undefined : compileNpcCatalog(def.npc);

  const world = createWorld(components, prefabs, def.capacity);
  // Сущности террейна и арены спавнятся до начальной расстановки: они часть
  // worldInit (DET-1), и их ID обязаны быть первыми, иначе расстановка сцены
  // сдвигала бы выдаваемые ID (ID-2, DET-6).
  const terrain =
    grid === undefined
      ? undefined
      : createTerrainApi(world, grid, spawn(world, TERRAIN_PREFAB));
  const arena =
    def.arena === undefined
      ? undefined
      : createArenaApi(world, def.arena, spawn(world, ARENA_PREFAB));
  // Расстановка сцены — строго после носителей (SER-7) и строго до расстановки
  // документа прогона (SER-8): порядок задаёт выданные ID, то есть хеш
  // `worldInit`. Отсутствующий список неотличим от пустого.
  applyPlacement(world, def.initial, 'сцена');
  const systems = new SystemRegistry();
  // Платформа способностей включается составом сцены целиком (SER-7):
  // зависимостей сборки у её систем нет, а без них объявленные компоненты —
  // мёртвые данные. Определения проверяются ДО регистрации: сцена с опечаткой
  // в списке действий не должна доживать до первого тика (ABIL-10).
  // Таблица одна на обе группы определений, и компилируется она, если сцена
  // объявила хотя бы одну из них: `buffs` от `abilities` независимо (SER-7).
  const abilities =
    def.abilities === undefined && def.buffs === undefined
      ? undefined
      : compileAbilityCatalog(def, world);
  registerSceneSystems(systems, def, world, timeScaleModifiers, modifiers, abilities, npc);
  return {
    world,
    systems,
    modifiers,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
    ...(abilities !== undefined ? { abilities } : {}),
    ...(npc !== undefined ? { npc } : {}),
    ...(def.fog === true ? { stealthHardMask } : {}),
  };
}
