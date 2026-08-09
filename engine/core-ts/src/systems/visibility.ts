/**
 * Fog of War (FOW-1..6): компоненты видимости и нативная система пересчёта.
 *
 * FoW живёт в симуляции, а не в рендере: клиент под контролем игрока, и «скрыть
 * только визуально» — это wallhack. Здесь считается битмаска `Visibility`,
 * которой потом режется персональный снапшот (`sim/filter.ts`, NET-12).
 *
 * Система нативна (FOW-4) ради перфа raycast-LoS каждый тик, но контракт
 * `System` не обходит: читает через `SystemContext`, пишет только через
 * `ctx.commands` (TICK-3, CMD-4).
 *
 * Опциональные зависимости (DI-3): без `ctx.physics` укрытия не отсекают, без
 * `ctx.terrain` не отсекает высота — сцена без них тикает штатно.
 *
 * Диапазон: `withinRadius` считает квадраты расстояний точной 64-битной
 * арифметикой, а вот `raycast` — нет, и там действует предел ~181 единицы
 * (см. шапку `physics.ts`). Эффективный радиус обзора выше этого предела
 * ставить нельзя.
 */
import * as fixed from '../math/fixed.js';
import { BLOCKS_VISION } from './physics.js';
import {
  POSITION_COMPONENT,
  type ComponentSchema,
  type EntityId,
  type Fixed,
  type ModifierList,
  type System,
  type SystemContext,
  type Vec2,
} from '../types.js';

export const VISION_COMPONENT = 'Vision';
export const VISIBILITY_COMPONENT = 'Visibility';
export const STEALTH_COMPONENT = 'Stealth';
export const TEAM_COMPONENT = 'Team';

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

/** FOW-3: `active != 0` гасит биты чужих команд. Bool-полей в ECS нет (ECS-3). */
export const STEALTH_SCHEMA: ComponentSchema = {
  name: STEALTH_COMPONENT,
  fields: { active: 'i32' },
};

/** Принадлежность команде: и бит наблюдателя, и «своя» команда цели (FOW-2, NET-15). */
export const TEAM_SCHEMA: ComponentSchema = {
  name: TEAM_COMPONENT,
  fields: { id: 'i32' },
};

/**
 * FOW-3: тот же паттерн списка источников, что у `TimeScaleModifiers` (TIME-7).
 * Значение слота — множитель радиуса; композиционная политика живёт вне ядра.
 * Экземпляр списка создаёт сцена (SER-7): модульный синглтон разделили бы две
 * симуляции в одном процессе (DI-1).
 */
export const VISION_MODIFIER_COMPONENT = 'VisionModifier';

/**
 * Все схемы FoW разом — сцене подключать их одним спредом. Порядок задаёт
 * битовые id (SER-7), поэтому список источников обязан остаться последним.
 * Функция, а не константа: его схема — функция от числа слотов сцены.
 */
export function fowComponents(modifiers: ModifierList): readonly ComponentSchema[] {
  return [VISION_SCHEMA, VISIBILITY_SCHEMA, STEALTH_SCHEMA, TEAM_SCHEMA, modifiers.schema];
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
 * Опций у системы не осталось: место в тике — якорь, а не параметр (DET-9).
 * Тип сохранён как форма поля-включателя в документах прогона и матча
 * (`"visibility": {}` в сценарии, CLI-2), поэтому объект без свойств.
 */
export type VisibilityOptions = Record<string, never>;

/**
 * FOW-5: за тик по каждому наблюдателю — кандидаты через `withinRadius`,
 * отсечение перекрытых укрытиями, отсечение уровней выше наблюдателя, учёт
 * `Stealth`. Результат — новая маска `Visibility.visibleTo`.
 *
 * ponytail: кандидаты берутся отдельным запросом на наблюдателя, то есть до
 * O(наблюдатели × сущности). При «до 10 сущностей с обзором» (FOW-4) это
 * дешевле любого индекса, который пришлось бы инвалидировать после каждой
 * записи в `Position`. Пространственный индекс — когда наблюдателей станут
 * сотни.
 */
export class VisibilitySystem implements System {
  readonly name = 'Visibility';
  readonly order = ANCHOR_ORDER;
  // Поле объявлено явно, а не parameter property в конструкторе: ядро исполняется
  // без сборки — типы стрипает сам Node (>=22.18), а strip-only режим отвергает
  // parameter properties, потому что те порождают код, а не только удаляют типы.
  // Через этот файл проходит `bin/sim.mjs` (CLI-1), так что сахар здесь стоил бы
  // CLI флага `--experimental-transform-types` и его предупреждения в выводе.
  private readonly modifiers: ModifierList;

  /** Список источников обзора приходит извне (DI-1): своего модульного у системы нет. */
  constructor(modifiers: ModifierList) {
    this.modifiers = modifiers;
  }

  run(ctx: SystemContext): void {
    const targets = ctx.query({ all: [VISIBILITY_COMPONENT, POSITION_COMPONENT] });
    if (targets.length === 0) return;

    // Собственная команда видит свою сущность всегда, в том числе под стелсом
    // (FOW-3, NET-15) — с этого маска и начинается, а не с нуля.
    const next = new Map<EntityId, number>();
    for (const target of targets) next.set(target, ownTeamBit(ctx, target));

    const observers = ctx.query({ all: [VISION_COMPONENT, TEAM_COMPONENT, POSITION_COMPONENT] });
    for (const observer of observers) {
      const bit = teamBit(ctx.get(observer, TEAM_COMPONENT, 'id'));
      const from = positionOf(ctx, observer);
      const level = ctx.terrain?.levelOf(observer);

      const candidates = ctx.query({
        all: [VISIBILITY_COMPONENT, POSITION_COMPONENT],
        withinRadius: { center: from, radius: effectiveRadius(ctx, observer, this.modifiers) },
      });
      for (const candidate of candidates) {
        const mask = next.get(candidate);
        // Бит уже взведён другим наблюдателем той же команды (или это сама
        // сущность наблюдателя) — второй раз считать нечего.
        if (mask === undefined || (mask & bit) !== 0) continue;
        if (isHidden(ctx, candidate)) continue;
        // FOW-5: строго выше — не видно; обратное направление не ограничено.
        if (level !== undefined && ctx.terrain!.levelOf(candidate) > level) continue;
        if (!hasLineOfSight(ctx, observer, from, candidate)) continue;
        next.set(candidate, mask | bit);
      }
    }

    // FOW-6: команда эмитится только при фактическом изменении битов — иначе
    // `Visibility` всегда dirty и сетевая дельта теряет смысл.
    for (const target of targets) {
      const mask = next.get(target)!;
      if (mask === ctx.get(target, VISIBILITY_COMPONENT, 'visibleTo')) continue;
      ctx.commands.setField(target, VISIBILITY_COMPONENT, 'visibleTo', mask);
    }
  }
}

/** Сущность без `Team` ничьей «своей» не является: её видно только по-настоящему. */
function ownTeamBit(ctx: SystemContext, entity: EntityId): number {
  return ctx.has(entity, TEAM_COMPONENT) ? teamBit(ctx.get(entity, TEAM_COMPONENT, 'id')) : 0;
}

function positionOf(ctx: SystemContext, entity: EntityId): Vec2 {
  return {
    x: ctx.get(entity, POSITION_COMPONENT, 'x'),
    y: ctx.get(entity, POSITION_COMPONENT, 'y'),
  };
}

/** FOW-3: активный стелс исключает сущность из чужих масок. */
function isHidden(ctx: SystemContext, entity: EntityId): boolean {
  return ctx.has(entity, STEALTH_COMPONENT) && ctx.get(entity, STEALTH_COMPONENT, 'active') !== 0;
}

/** FOW-3: `Vision.radius`, домноженный на произведение источников `VisionModifier`. */
function effectiveRadius(ctx: SystemContext, observer: EntityId, modifiers: ModifierList): Fixed {
  const scale = modifiers.product(ctx, observer, VISION_SCALE_MIN, VISION_SCALE_MAX);
  return ctx.math.mul(ctx.get(observer, VISION_COMPONENT, 'radius'), scale);
}

/** FOW-5: перекрыт ли кандидат укрытием — коллайдером с тегом `blocksVision`. */
function hasLineOfSight(ctx: SystemContext, observer: EntityId, from: Vec2, candidate: EntityId): boolean {
  if (ctx.physics === undefined) return true;
  const hit = ctx.physics.raycast(from, positionOf(ctx, candidate), {
    mask: BLOCKS_VISION,
    ignore: observer,
  });
  // Луч упёрся в саму цель — она не перекрыта: собственный коллайдер цели
  // укрытием для неё не является (PHYS-6 исключает только источник).
  return hit === null || hit.entity === candidate;
}
