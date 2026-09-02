/**
 * Fog of War (FOW-1..6, FOW-12): компоненты видимости и нативная система
 * пересчёта.
 *
 * FoW живёт в симуляции, а не в рендере: клиент под контролем игрока, и «скрыть
 * только визуально» — это wallhack. Здесь считается битмаска `Visibility`,
 * которой потом режется персональный снапшот (`sim/filter.ts`, NET-12).
 *
 * Система нативна (FOW-4) ради перфа raycast-LoS каждый тик, но контракт
 * `System` не обходит: читает через `SystemContext`, пишет только через
 * `ctx.commands` (TICK-3, CMD-4).
 *
 * Стелс — канальный (FOW-3): вид невидимости — бит `i32`-маски, у цели
 * свёртка источников `StealthSources`, у наблюдателя — `DetectionSources`;
 * скрытость — пер-наблюдательное сравнение масок, причём битмаску `Visibility`
 * гасят только жёсткие каналы сцены (FOW-12), мягкие — дело доставки состояния
 * и подачи (FOW-13). Свёртки публикуются производными компонентами
 * `StealthState`/`DetectionState` — их пишет этот же пересчёт и только при
 * изменении (правило FOW-6); потребители раньше якоря 900 в тике читают
 * значение прошлого пересчёта — та же свежесть, что у самой `Visibility`.
 *
 * Опциональная зависимость (DI-3) здесь одна: без `ctx.physics` укрытия не
 * отсекают — сцена без физики тикает штатно. Террейн опциональной для ЭТОЙ
 * системы не является: фильтр по высоте (FOW-5) спрашивает уровень сущности у
 * террейна, и «уровня нет» означало бы молчаливо выключенный фильтр — с виду
 * исправную FoW, отличающуюся от настоящей только на сценах с перепадом высот
 * (`serialization` SER-7). Прогон, включивший пересчёт видимости в сцене без
 * террейна, отвергает сборка (`sim/build.ts`, FOW-5).
 *
 * Диапазон: `withinRadius` считает квадраты расстояний точной 64-битной
 * арифметикой, а вот `raycast` — нет, и там действует предел ~181 единицы
 * (см. шапку `physics.ts`). Эффективный радиус обзора выше этого предела
 * ставить нельзя.
 *
 * TimeScale (TIME-5): игнорирует — маска считается по состоянию мира на тике,
 * счётчиков времени у системы нет.
 */
import * as fixed from '../math/fixed.js';
import { componentSchema } from '../ecs/world.js';
import { BLOCKS_VISION } from './physics.js';
import { optionalComponentHandle } from './optionalHandle.js';
import { QueryBuffer } from './queryBuffer.js';
import {
  POSITION_COMPONENT,
  type ComponentHandle,
  type ComponentSchema,
  type EntityId,
  type FieldHandle,
  type Fixed,
  type ModifierList,
  type QuerySpec,
  type System,
  type SystemContext,
  type TerrainApi,
  type Vec2,
  type WorldState,
} from '../types.js';

export const VISION_COMPONENT = 'Vision';
export const VISIBILITY_COMPONENT = 'Visibility';
export const TEAM_COMPONENT = 'Team';
export const STEALTH_STATE_COMPONENT = 'StealthState';
export const DETECTION_STATE_COMPONENT = 'DetectionState';

/** FOW-1: радиус обзора наблюдателя. */
export const VISION_SCHEMA: ComponentSchema = {
  name: VISION_COMPONENT,
  fields: { radius: 'fixed' },
};

/** FOW-2: кому сущность сейчас видна — битмаска команд, а не массив. */
export const VISIBILITY_SCHEMA: ComponentSchema = {
  name: VISIBILITY_COMPONENT,
  fields: { visibleTo: 'i32' },
};

/** Принадлежность команде: и бит наблюдателя, и «своя» команда цели (FOW-2, NET-15). */
export const TEAM_SCHEMA: ComponentSchema = {
  name: TEAM_COMPONENT,
  fields: { id: 'i32' },
};

/**
 * FOW-3: эффективная стелс-маска сущности — OR занятых слотов `StealthSources`.
 * Производный компонент: пишет его пересчёт видимости, и только при изменении;
 * сущности с ненулевой свёрткой пересчёт дописывает его сам (`publishState`) —
 * объявлять его заранее контент не обязан. Потребители (условия таргетинга,
 * доставка, подача) читают его, а не слоты — свёртка в каждом потребителе была
 * бы вторым определением эффективной маски.
 */
export const STEALTH_STATE_SCHEMA: ComponentSchema = {
  name: STEALTH_STATE_COMPONENT,
  fields: { mask: 'i32' },
};

/** FOW-3: эффективная маска детекции наблюдателя — OR занятых слотов `DetectionSources`. */
export const DETECTION_STATE_SCHEMA: ComponentSchema = {
  name: DETECTION_STATE_COMPONENT,
  fields: { mask: 'i32' },
};

/**
 * FOW-3: слотовые списки источников стелса и детекции — та же раскладка
 * TIME-7, что у `VisionModifier`, но значение слота — маска каналов `i32`
 * с нейтралью `0` и свёрткой OR (`systems/modifiers.ts`, values: 'mask').
 */
export const STEALTH_SOURCES_COMPONENT = 'StealthSources';
export const DETECTION_SOURCES_COMPONENT = 'DetectionSources';

/**
 * FOW-3: тот же паттерн списка источников, что у `TimeScaleModifiers` (TIME-7).
 * Значение слота — множитель радиуса; композиционная политика живёт вне ядра.
 * Экземпляр списка создаёт сцена (SER-7): модульный синглтон разделили бы две
 * симуляции в одном процессе (DI-1).
 */
export const VISION_MODIFIER_COMPONENT = 'VisionModifier';

/** Списки источников группы тумана войны — их создаёт сцена (SER-7, DI-1). */
export interface FowLists {
  /** `VisionModifier` — множители радиуса обзора (values: 'scale'). */
  readonly vision: ModifierList;
  /** `StealthSources` — маски стелс-каналов цели (values: 'mask'). */
  readonly stealth: ModifierList;
  /** `DetectionSources` — маски детекции наблюдателя (values: 'mask'). */
  readonly detection: ModifierList;
}

/**
 * Все схемы FoW разом — сцене подключать их одним спредом. Порядок задаёт
 * битовые id и нормирован FOW-3: `Vision`, `Visibility`, `Team`,
 * `StealthState`, `DetectionState`, `StealthSources`, `DetectionSources`,
 * `VisionModifier`. Функция, а не константа: схемы списков — функция от числа
 * слотов сцены.
 */
export function fowComponents(lists: FowLists): readonly ComponentSchema[] {
  return [
    VISION_SCHEMA,
    VISIBILITY_SCHEMA,
    TEAM_SCHEMA,
    STEALTH_STATE_SCHEMA,
    DETECTION_STATE_SCHEMA,
    lists.stealth.schema,
    lists.detection.schema,
    lists.vision.schema,
  ];
}

/**
 * Объявлен ли миром компонент видимости — то есть есть ли пересчёту что считать
 * (FOW-5). Схема компонента — факт сцены, известный до первого тика, поэтому
 * сборка решает по ней, а не по составу мира на каком-то тике: компоненты
 * объявляются один раз загрузчиком (SER-7), и новых по ходу матча не заводится.
 */
export function visibilityDeclared(world: WorldState): boolean {
  return componentSchema(world, VISIBILITY_COMPONENT) !== undefined;
}

/** Клампы стакинга модификаторов обзора (FOW-3): сырой Q16.16 — от слепоты до 4.0. */
export const VISION_SCALE_MIN: Fixed = 0;
export const VISION_SCALE_MAX: Fixed = fixed.fromInt(4);

// ------------------------------------------------------------ битмаска команд

/**
 * FOW-2: маска — одно поле `i32`, то есть ровно 32 команды, `[0, 31]`. Команда
 * 31 занимает знаковый бит: `1 << 31` в JS уже даёт отрицательное число, и
 * именно оно кладётся в Int32Array — специального случая не нужно, но и
 * трактовать маску как беззнаковую нельзя. Больше 32 команд потребует второго
 * поля (или `u64` в Rust-порте), а не молчаливого переполнения.
 *
 * Та же ширина и по тем же основаниям у каналов стелса (FOW-3): бит маски
 * `StealthSources`/`DetectionSources` — вид невидимости, `[0, 31]`.
 */
export const MAX_TEAMS = 32;

export function teamBit(team: number): number {
  if (!Number.isInteger(team) || team < 0 || team >= MAX_TEAMS) {
    throw new Error(`FOW-2: команда ${team} вне диапазона [0, ${MAX_TEAMS - 1}] — битмаска видимости 32-битная`);
  }
  return 1 << team;
}

export function isVisibleTo(mask: number, team: number): boolean {
  return (mask & teamBit(team)) !== 0;
}

// -------------------------------------------------------------------- система

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 900;

/**
 * Спецификации выборок пересчёта — константы модуля, а не литералы на тик:
 * состав их известен заранее, а объект на прогон был бы аллокацией на ровном
 * месте. Спецификация КАНДИДАТОВ константой быть не может — её радиус и центр
 * принадлежат наблюдателю (FOW-5), и строится она на каждого.
 */
const TARGET_SPEC: QuerySpec = { all: [VISIBILITY_COMPONENT, POSITION_COMPONENT] };
const OBSERVER_SPEC: QuerySpec = { all: [VISION_COMPONENT, TEAM_COMPONENT, POSITION_COMPONENT] };
const STEALTH_SOURCES_SPEC: QuerySpec = { all: [STEALTH_SOURCES_COMPONENT] };
const DETECTION_SOURCES_SPEC: QuerySpec = { all: [DETECTION_SOURCES_COMPONENT] };
const STEALTH_STATE_SPEC: QuerySpec = { all: [STEALTH_STATE_COMPONENT] };
const DETECTION_STATE_SPEC: QuerySpec = { all: [DETECTION_STATE_COMPONENT] };

/**
 * Handle полей FoW (`data-driven-systems` SYS-10): пересчёт видимости читает
 * позицию, команду и стелс на КАЖДОГО кандидата КАЖДОГО наблюдателя, то есть
 * произведением, а не суммой. Имена разрешаются один раз, на первом входе.
 */
interface VisibilityHandles {
  /**
   * Сторона и производные состояния — компоненты, наличие которых система
   * СПРАШИВАЕТ, а не требует: сущность без них видна по-настоящему, а
   * публиковать свёртку некуда. `undefined` — компонента нет и в схемах сцены,
   * и ответ тот же `false`, что у строкового пути (`systems/optionalHandle.ts`).
   */
  readonly team: { readonly component: ComponentHandle; readonly id: FieldHandle } | undefined;
  readonly stealthState:
    | { readonly component: ComponentHandle; readonly mask: FieldHandle }
    | undefined;
  readonly detectionState:
    | { readonly component: ComponentHandle; readonly mask: FieldHandle }
    | undefined;
  readonly posX: FieldHandle;
  readonly posY: FieldHandle;
  readonly visibleTo: FieldHandle;
  readonly visionRadius: FieldHandle;
}

function resolveHandles(ctx: SystemContext): VisibilityHandles {
  const team = optionalComponentHandle(ctx, TEAM_COMPONENT);
  const stealthState = optionalComponentHandle(ctx, STEALTH_STATE_COMPONENT);
  const detectionState = optionalComponentHandle(ctx, DETECTION_STATE_COMPONENT);
  return {
    team: team === undefined ? undefined : { component: team, id: ctx.resolveField(TEAM_COMPONENT, 'id') },
    stealthState:
      stealthState === undefined
        ? undefined
        : { component: stealthState, mask: ctx.resolveField(STEALTH_STATE_COMPONENT, 'mask') },
    detectionState:
      detectionState === undefined
        ? undefined
        : { component: detectionState, mask: ctx.resolveField(DETECTION_STATE_COMPONENT, 'mask') },
    posX: ctx.resolveField(POSITION_COMPONENT, 'x'),
    posY: ctx.resolveField(POSITION_COMPONENT, 'y'),
    visibleTo: ctx.resolveField(VISIBILITY_COMPONENT, 'visibleTo'),
    visionRadius: ctx.resolveField(VISION_COMPONENT, 'radius'),
  };
}

/**
 * Опций у системы не осталось: место в тике — якорь, а не параметр (DET-9).
 * Тип сохранён как форма поля-включателя в документах прогона и матча
 * (`"visibility": {}` в сценарии, CLI-2), поэтому объект без свойств.
 */
export type VisibilityOptions = Record<string, never>;

/** Зависимости сборки пересчёта: списки источников сцены и таблица каналов (FOW-12). */
export interface VisibilityDeps {
  readonly lists: FowLists;
  /**
   * Маска жёстких каналов сцены (FOW-12): взведённый бит — канал жёсткий.
   * Порождена конфигом (`softStealthChannels`, SER-7), иммутабельна на матч и
   * в снапшот не входит; умолчание — все каналы жёсткие (`~0`).
   */
  readonly hardStealthMask: number;
}

/**
 * FOW-5: за тик по каждому наблюдателю — кандидаты через `withinRadius`,
 * отсечение перекрытых укрытиями, отсечение уровней выше наблюдателя,
 * пер-наблюдательное отсечение скрытых по маскам жёстких каналов (FOW-3,
 * FOW-12). Результат — новая маска `Visibility.visibleTo` плюс публикация
 * свёрток `StealthState`/`DetectionState`.
 *
 * ponytail: кандидаты берутся отдельным запросом на наблюдателя, то есть до
 * O(наблюдатели × сущности). При «до 10 сущностей с обзором» (FOW-4) это
 * дешевле любого индекса, который пришлось бы инвалидировать после каждой
 * записи в `Position`. Пространственный индекс — когда наблюдателей станут
 * сотни. Накопители масок и свёрток стелса — долгоживущие Map системы,
 * очищаемые на входе в прогон, а не новые на тик: их размер пропорционален
 * числу целей, и аллокация на тик была бы ровно тем, что дисциплина ядра
 * запрещает в горячем пути.
 */
export class VisibilitySystem implements System {
  readonly name = 'Visibility';
  readonly order = ANCHOR_ORDER;
  // Поле объявлено явно, а не parameter property в конструкторе: ядро исполняется
  // без сборки — типы стрипает сам Node (>=22.18), а strip-only режим отвергает
  // parameter properties, потому что те порождают код, а не только удаляют типы.
  // Через этот файл проходит `bin/sim.mjs` (CLI-1), так что сахар здесь стоил бы
  // CLI флага `--experimental-transform-types` и его предупреждения в выводе.
  private readonly deps: VisibilityDeps;
  /**
   * Буферы выборок: свой на каждую (QUERY-3), все переживают тики — пересчёт
   * снимает их каждый прогон, и контейнер на вызов был бы аллокацией размером
   * в мир (SYS-10). Кандидаты наблюдателя — отдельный буфер: он вложен в обход
   * `observers`, и общим с ним быть не может.
   */
  private readonly targets = new QueryBuffer();
  private readonly observers = new QueryBuffer();
  private readonly candidates = new QueryBuffer();
  private readonly stealthSources = new QueryBuffer();
  private readonly detectionSources = new QueryBuffer();
  private readonly stealthOrphans = new QueryBuffer();
  private readonly detectionOrphans = new QueryBuffer();
  /** Разрешаются на первом входе, ПОСЛЕ раннего выхода (SYS-10). */
  private handles: VisibilityHandles | undefined;
  /** Маска `visibleTo` следующего тика по целям; живёт между прогонами, очищается на входе. */
  private readonly next = new Map<EntityId, number>();
  /** Свёртка стелса по целям (FOW-5) — один раз на цель, а не на пару; живёт как `next`. */
  private readonly stealthOf = new Map<EntityId, number>();

  /** Списки источников и таблица каналов приходят извне (DI-1, FOW-12). */
  constructor(deps: VisibilityDeps) {
    this.deps = deps;
  }

  run(ctx: SystemContext): void {
    const targets = this.targets.run(ctx, TARGET_SPEC);
    const stealth = this.stealthSources.run(ctx, STEALTH_SOURCES_SPEC);
    const detection = this.detectionSources.run(ctx, DETECTION_SOURCES_SPEC);
    // Ранний выход только когда системе не о ком говорить ВООБЩЕ: публикация
    // свёрток (FOW-3) обязана идти и на тике без единой пары Visibility+Position
    // — иначе носитель источников без позиции хранил бы чёрствую маску (FOW-5).
    if (targets === 0 && stealth === 0 && detection === 0) return;
    const h = (this.handles ??= resolveHandles(ctx));
    // FOW-5: фолбэка «уровней нет» у фильтра по высоте не существует, поэтому
    // считать без террейна система не вправе. Сюда доходит только сборка,
    // собранная мимо `buildSimulation`: та отвергает такой прогон до первого
    // тика, и это единственная точка, где правило живёт нормой.
    const terrain = ctx.terrain;
    if (terrain === undefined) {
      throw new Error(
        'FOW-5: пересчёт видимости включён в сцене без террейна — ' +
          'фильтру по высоте не у кого спросить уровень сущности (TERR-4, SER-7)',
      );
    }

    // Собственная команда видит свою сущность всегда, в том числе под стелсом
    // (FOW-3, NET-15) — с этого маска и начинается, а не с нуля. Свёртка стелса
    // считается здесь же, один раз на цель, а не на пару (FOW-5).
    const next = this.next;
    const stealthOf = this.stealthOf;
    next.clear();
    stealthOf.clear();
    for (let slot = 0; slot < targets; slot++) {
      const target = this.targets.ids[slot]!;
      next.set(target, ownTeamBit(ctx, h, target));
      stealthOf.set(target, this.deps.lists.stealth.union(ctx, target));
    }

    const observers = targets === 0 ? 0 : this.observers.run(ctx, OBSERVER_SPEC);
    for (let slot = 0; slot < observers; slot++) {
      markSeenBy(ctx, h, terrain, this.observers.ids[slot]!, this.deps, stealthOf, next, this.candidates);
    }

    // FOW-6: команда эмитится только при фактическом изменении битов — иначе
    // `Visibility` всегда dirty и сетевая дельта теряет смысл. Маска читается
    // по индексу слота: `Visibility` перечислен в `all` выборки (SYS-10).
    for (let slot = 0; slot < targets; slot++) {
      const target = this.targets.ids[slot]!;
      const mask = next.get(target)!;
      if (mask === ctx.getByIndex(this.targets.indices[slot]!, h.visibleTo)) continue;
      ctx.commands.setFieldByHandle(target, h.visibleTo, mask);
    }

    publishState(
      ctx,
      h.stealthState,
      STEALTH_STATE_COMPONENT,
      STEALTH_SOURCES_COMPONENT,
      this.stealthSources,
      this.stealthOrphans,
      STEALTH_STATE_SPEC,
      (entity) => stealthOf.get(entity) ?? this.deps.lists.stealth.union(ctx, entity),
    );
    publishState(
      ctx,
      h.detectionState,
      DETECTION_STATE_COMPONENT,
      DETECTION_SOURCES_COMPONENT,
      this.detectionSources,
      this.detectionOrphans,
      DETECTION_STATE_SPEC,
      (entity) => this.deps.lists.detection.union(ctx, entity),
    );
  }
}

/**
 * FOW-3: свёртка публикуется производным компонентом состояния — по правилу
 * FOW-6, только при изменении, иначе состояние dirty каждый тик и сетевая
 * дельта теряет смысл. Носитель — каждый, у кого есть список источников:
 * сущности с ненулевой свёрткой пересчёт ДОПИСЫВАЕТ компонент состояния сам
 * (командой, как `AbilityVisibilitySystem` дописывает `Visibility` спутнику) —
 * объявлять его заранее контент не обязан, и непарный `StealthSources` не
 * оставляет потребителей (NPC-10, EXPR-2, доставка FOW-13) с нулём при
 * взведённой маске. Носитель состояния БЕЗ списка источников публикуется той
 * же свёрткой — нулевой: осиротевшее состояние гаснет, а не черствеет.
 */
function publishState(
  ctx: SystemContext,
  handle: { readonly component: ComponentHandle; readonly mask: FieldHandle } | undefined,
  component: string,
  sourcesComponent: string,
  sources: QueryBuffer,
  orphans: QueryBuffer,
  orphanSpec: QuerySpec,
  foldOf: (entity: EntityId) => number,
): void {
  // Компонента состояния нет в схемах сцены — публиковать некуда; в группе
  // тумана (FOW-3) он есть всегда, случай этот — рукотворные миры тестов.
  if (handle === undefined) return;
  for (let slot = 0; slot < sources.count; slot++) {
    const entity = sources.ids[slot]!;
    const mask = foldOf(entity);
    if (ctx.hasByHandle(entity, handle.component)) {
      if (mask !== ctx.getByHandle(entity, handle.mask)) {
        ctx.commands.setFieldByHandle(entity, handle.mask, mask);
      }
    } else if (mask !== 0) {
      ctx.commands.addComponent(entity, component, { mask });
    }
  }
  // Носитель состояния БЕЗ списка источников: свёртка нулевая по определению —
  // осиротевшее состояние гаснет, а не черствеет. Носители со списком уже
  // обработаны выше, второй команды им не ставится.
  const found = orphans.run(ctx, orphanSpec);
  for (let slot = 0; slot < found; slot++) {
    const entity = orphans.ids[slot]!;
    if (ctx.has(entity, sourcesComponent)) continue;
    // Компонент состояния перечислен в `all` этой выборки — маска читается по
    // индексу слота (SYS-10).
    if (ctx.getByIndex(orphans.indices[slot]!, handle.mask) === 0) continue;
    ctx.commands.setFieldByHandle(entity, handle.mask, 0);
  }
}

/**
 * Взводит бит стороны наблюдателя у всех, кого он видит (FOW-3, FOW-5).
 * Маска-накопитель приходит аргументом: она одна на прогон системы, и кандидат
 * может быть виден нескольким наблюдателям одной стороны.
 */
function markSeenBy(
  ctx: SystemContext,
  h: VisibilityHandles,
  terrain: TerrainApi,
  observer: EntityId,
  deps: VisibilityDeps,
  stealthOf: ReadonlyMap<EntityId, number>,
  next: Map<EntityId, number>,
  candidates: QueryBuffer,
): void {
  // Наблюдатель отобран запросом по `Team`: сторона у него есть заведомо.
  const bit = teamBit(ctx.getByHandle(observer, h.team!.id));
  const from = positionOf(ctx, h, observer);
  // FOW-5: уровень СУЩНОСТИ, а не уровень точки под ней — у прыгающего и
  // летящего это разные вещи (LOC-5, ARENA-6).
  const level = terrain.levelOf(observer);
  // FOW-3: детекция — свойство наблюдателя, свёртка одна на его проход.
  const detection = deps.lists.detection.union(ctx, observer);

  const found = candidates.run(ctx, {
    all: [VISIBILITY_COMPONENT, POSITION_COMPONENT],
    withinRadius: { center: from, radius: effectiveRadius(ctx, h, observer, deps.lists.vision) },
  });
  for (let slot = 0; slot < found; slot++) {
    const candidate = candidates.ids[slot]!;
    const mask = next.get(candidate);
    // Бит уже взведён другим наблюдателем той же команды (или это сама
    // сущность наблюдателя) — второй раз считать нечего.
    if (mask === undefined || (mask & bit) !== 0) continue;
    // FOW-5: скрыт, если хотя бы один ЖЁСТКИЙ канал стелса не вскрыт детекцией
    // этого наблюдателя (FOW-12); мягкие каналы битмаску не гасят (FOW-13).
    if ((stealthOf.get(candidate)! & deps.hardStealthMask & ~detection) !== 0) continue;
    // FOW-5: строго выше — не видно; обратное направление не ограничено.
    if (terrain.levelOf(candidate) > level) continue;
    if (!hasLineOfSight(ctx, h, observer, from, candidate, level)) continue;
    next.set(candidate, mask | bit);
  }
}

/** Сущность без `Team` ничьей «своей» не является: её видно только по-настоящему. */
function ownTeamBit(ctx: SystemContext, h: VisibilityHandles, entity: EntityId): number {
  const team = h.team;
  if (team === undefined || !ctx.hasByHandle(entity, team.component)) return 0;
  return teamBit(ctx.getByHandle(entity, team.id));
}

function positionOf(ctx: SystemContext, h: VisibilityHandles, entity: EntityId): Vec2 {
  return {
    x: ctx.getByHandle(entity, h.posX),
    y: ctx.getByHandle(entity, h.posY),
  };
}

/** FOW-3: `Vision.radius`, домноженный на произведение источников `VisionModifier`. */
function effectiveRadius(
  ctx: SystemContext,
  h: VisibilityHandles,
  observer: EntityId,
  modifiers: ModifierList,
): Fixed {
  const scale = modifiers.product(ctx, observer, VISION_SCALE_MIN, VISION_SCALE_MAX);
  return ctx.math.mul(ctx.getByHandle(observer, h.visionRadius), scale);
}

/** FOW-5: перекрыт ли кандидат укрытием — коллайдером с тегом `blocksVision`. */
function hasLineOfSight(
  ctx: SystemContext,
  h: VisibilityHandles,
  observer: EntityId,
  from: Vec2,
  candidate: EntityId,
  elevation: number,
): boolean {
  if (ctx.physics === undefined) return true;
  const hit = ctx.physics.raycast(from, positionOf(ctx, h, candidate), {
    mask: BLOCKS_VISION,
    ignore: observer,
    // Уровень наблюдателя — тот же, что в фильтре по высоте (TERR-4): рёбра
    // своего уровня и ниже луч не перекрывают (PHYS-13) — видно и вниз, и на
    // плато того же уровня через низину.
    elevation,
  });
  // Луч упёрся в саму цель — она не перекрыта: собственный коллайдер цели
  // укрытием для неё не является (PHYS-6 исключает только источник).
  return hit === null || hit.entity === candidate;
}
