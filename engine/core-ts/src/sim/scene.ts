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
import { fowComponents, VISION_MODIFIER_COMPONENT } from '../systems/visibility.js';
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
import type {
  AbilityCatalog,
  AbilityDef,
  AbilityRuntimeDef,
  BuffDef,
} from '../systems/abilities/model.js';
import { applyPlacement, type ScenarioSpawn } from './placement.js';
import type { ArenaApi, ComponentSchema, ModifierRegistry, TerrainApi, WorldState } from '../types.js';

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
}

export function loadScene(def: SceneDef): Scene {
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
  // Схемы карты пола и арены зависят от ассетов, поэтому дописываются к
  // объявленным компонентам, а не пишутся в сцене руками (TERR-6, ARENA-1).
  const grid = def.terrain === undefined ? undefined : createTerrainGrid(def.terrain);
  const slots = def.modifierSlots ?? DEFAULT_MODIFIER_SLOTS;
  const timeScaleModifiers = modifierList(TIME_SCALE_MODIFIERS_COMPONENT, slots);
  const visionModifiers = modifierList(VISION_MODIFIER_COMPONENT, slots);
  const modifiers: ModifierRegistry = new Map([
    [timeScaleModifiers.component, timeScaleModifiers],
    [visionModifiers.component, visionModifiers],
  ]);
  // Порядок нормативен (SER-7): floor → arena → timeScale → tween → fow →
  // компоненты платформы способностей → компонент инстанса баффа. Он задаёт
  // битовые id компонентов, то есть представление масок в снапшоте.
  const components = [
    ...def.components,
    ...(grid === undefined ? [] : [floorComponentSchema(grid)]),
    ...(def.arena === undefined ? [] : ARENA_COMPONENTS),
    ...(def.timeScale === true ? timeComponents(timeScaleModifiers) : []),
    ...(def.tweens === undefined ? [] : [TWEEN_SCHEMA]),
    ...(def.fog === true ? fowComponents(visionModifiers) : []),
    ...(def.abilities === undefined ? [] : ABILITY_COMPONENTS),
    ...(def.buffs === undefined ? [] : BUFF_COMPONENTS),
  ];
  const prefabs = [
    ...(def.prefabs ?? []),
    ...(grid === undefined ? [] : [terrainPrefab(grid)]),
    // Ассет арены валидируется здесь же, до `createWorld`.
    ...(def.arena === undefined ? [] : [arenaPrefab(def.arena)]),
  ];
  // Коэффициент опоры в prefabs сцены — доля в [0, 1] (ARENA-3): опечатка
  // контента не должна доживать до первого тика.
  checkArenaSupport(def.prefabs ?? []);

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
  // Нативные системы, включаемые самим составом сцены (SER-7). Их регистрация
  // здесь, а не у вызывающего: без них объявленные компоненты — мёртвые данные.
  // Исключение — только системы, которым нужна зависимость сборки:
  // `PhysicsSystem` и `VisibilitySystem` (нужен raycast, DI-3).
  // `TweenSystem` разбирает пути к полям в конструкторе, поэтому битый
  // `target` падает на загрузке сцены, а не в середине матча (SYS-3).
  // Арена есть в сцене — значит, за её границей кто-то следит (ARENA-3, ARENA-5).
  if (def.arena !== undefined) systems.register(new ArenaSystem());
  if (def.timeScale === true) systems.register(new TimeScaleSystem(timeScaleModifiers));
  if (def.tweens !== undefined) systems.register(new TweenSystem(def.tweens));
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
  if (abilities !== undefined && def.abilities !== undefined) {
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
  if (abilities !== undefined && def.buffs !== undefined) {
    systems.register(new BuffSystem(abilities, modifiers));
  }
  // Валидация каждой системы — внутри registerFromJson (SYS-3): конфиг с
  // опечаткой не должен доживать до первого тика.
  for (const system of def.systems ?? []) systems.registerFromJson(system, world);
  return {
    world,
    systems,
    modifiers,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
    ...(abilities !== undefined ? { abilities } : {}),
  };
}
