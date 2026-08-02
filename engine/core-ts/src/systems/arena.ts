/**
 * Арена (ARENA-1..5): граница-окружность, запрос принадлежности и два факта,
 * которые ядро сообщает наружу — выход за край и провал сквозь пол.
 *
 * Здесь только механизм. Что делать с вышедшей сущностью, по какому расписанию
 * сужать радиус и какова судьба провалившегося — политика JSON-систем поверх
 * событий (ARENA-3, ARENA-5); балансных чисел в этом файле нет.
 *
 * Центр иммутабелен и живёт в ассете (`worldInit`, DET-1), радиус мутабелен и
 * лежит в компоненте на сущности арены: сужение обязано попадать в снапшот и
 * откатываться вместе с миром (ARENA-4, SNAP-1).
 */
import { distSqLe, INT32_MAX, INT32_MIN, sub } from '../math/fixed.js';
import { getField, type PrefabDef } from '../ecs/world.js';
import {
  LEVEL_OVERRIDE_COMPONENT,
  POSITION_COMPONENT,
  type ArenaApi,
  type ComponentSchema,
  type EntityId,
  type Fixed,
  type System,
  type SystemContext,
  type Vec2,
  type WorldState,
} from '../types.js';

/** Компонент мутабельного радиуса и prefab его носителя. */
export const ARENA_COMPONENT = 'ArenaBounds';
export const ARENA_PREFAB = 'Arena';

/** Компонент стороны границы на прошлом тике — им же контент и подписывает сущность на систему. */
export const ARENA_STATE_COMPONENT = 'ArenaState';

/** Арена сужается после физики: позиции за тик уже финальные (PhysicsSystem — 100). */
const DEFAULT_ORDER = 110;

/** Ассет арены: то, что пишет редактор и читает загрузчик сцены (ARENA-1). */
export interface ArenaDef {
  /** Иммутабельный центр в Q16.16; в компонент не кладётся — он не меняется. */
  readonly center: Vec2;
  /** Стартовый радиус в Q16.16; дальше живёт в компоненте (ARENA-4). */
  readonly radius: Fixed;
}

/**
 * Схема радиуса и схема прошлой стороны границы. Компонент состояния —
 * обычный, а не поле системы: иначе после отката мира (SNAP-1) система помнила
 * бы будущее и не увидела бы повторного перехода.
 *
 * Дефолт «внутри и на полу» означает, что сущность считается появившейся в
 * штатном положении: спавн за краем или над дырой даёт событие на первом же
 * тике, и политике не нужен отдельный канал для этого случая.
 */
export const ARENA_COMPONENTS: readonly ComponentSchema[] = [
  { name: ARENA_COMPONENT, fields: { radius: 'fixed' } },
  {
    name: ARENA_STATE_COMPONENT,
    fields: { inside: 'i32', onFloor: 'i32' },
    defaults: { inside: 1, onFloor: 1 },
  },
];

/** Prefab singleton-сущности арены; здесь же валидируется ассет (ARENA-1). */
export function arenaPrefab(def: ArenaDef): PrefabDef {
  checkFixed(def.center.x, 'center.x');
  checkFixed(def.center.y, 'center.y');
  if (!Number.isInteger(def.radius) || def.radius < 1) {
    throw new Error('ARENA-1: "radius" — целое ≥ 1 в Q16.16 (FP-1)');
  }
  return {
    name: ARENA_PREFAB,
    components: { [ARENA_COMPONENT]: { radius: def.radius } },
    tags: ['arena'],
  };
}

function checkFixed(value: number, what: string): void {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new Error(`ARENA-1: "${what}" — целое в Q16.16, помещающееся в i32 (FP-1)`);
  }
}

/**
 * Запрос принадлежности (ARENA-2). Замыкается на мир и на сущность-носителя:
 * радиус читается из компонента и потому следует за сужением, снапшотами и
 * откатами. Уровень террейна не участвует — арена ограничивает плоскость, а не
 * объём.
 */
export function createArenaApi(world: WorldState, def: ArenaDef, entity: EntityId): ArenaApi {
  const center = def.center;
  const radius = (): Fixed => getField(world, entity, ARENA_COMPONENT, 'radius');
  return {
    entity,
    center,
    radius,
    contains: (position) => {
      const r = radius();
      // Отрицательный радиус — переусердствовавшее сужение: арена пуста, а не
      // зеркальна (distSqLe сравнивает квадраты и знак бы потеряла).
      if (r < 0) return false;
      // Граница включающая, сравнение по квадратам без sqrt — тот же
      // компаратор, что и у `withinRadius` (QUERY-1, ARENA-2).
      return distSqLe(sub(position.x, center.x), sub(position.y, center.y), r);
    },
  };
}

export interface ArenaOptions {
  readonly order?: number;
}

/**
 * Наблюдение за границей и полом (ARENA-3, ARENA-5). Система эмитит два
 * события и не делает больше ничего: убить, вернуть внутрь, уронить — политика.
 *
 * События идут ПО ПЕРЕХОДУ, а не пока сущность снаружи: непрерывный урон за
 * краем политика отсчитывает сама от полученного события. Причина смены
 * стороны роли не играет — кнокбэк и сужение радиуса дают один и тот же факт.
 *
 * Обходятся только сущности с `ArenaState`: кто участвует в проверке, решает
 * контент через prefab, а не ядро.
 */
export class ArenaSystem implements System {
  readonly name = 'Arena';
  readonly order: number;

  constructor(options: ArenaOptions = {}) {
    this.order = options.order ?? DEFAULT_ORDER;
  }

  run(ctx: SystemContext): void {
    const arena = ctx.arena;
    if (arena === undefined) return; // сцена без арены тикает штатно (DI-3)

    for (const entity of ctx.query({ all: [POSITION_COMPONENT, ARENA_STATE_COMPONENT] })) {
      const position: Vec2 = {
        x: ctx.get(entity, POSITION_COMPONENT, 'x'),
        y: ctx.get(entity, POSITION_COMPONENT, 'y'),
      };

      const inside = arena.contains(position) ? 1 : 0;
      if (inside !== ctx.get(entity, ARENA_STATE_COMPONENT, 'inside')) {
        ctx.commands.setField(entity, ARENA_STATE_COMPONENT, 'inside', inside);
        if (inside === 0) ctx.events.emit('LeftArena', { entity });
      }

      // ARENA-5: пол проверяется только у стоящих на земле. Override уровня
      // (ARENA-6) означает, что сущность в полёте — снаряд над дырой не падает.
      // Без террейна проверять нечем (DI-3).
      if (ctx.terrain === undefined || ctx.has(entity, LEVEL_OVERRIDE_COMPONENT)) continue;
      const onFloor = ctx.terrain.hasFloorAt(position) ? 1 : 0;
      if (onFloor !== ctx.get(entity, ARENA_STATE_COMPONENT, 'onFloor')) {
        ctx.commands.setField(entity, ARENA_STATE_COMPONENT, 'onFloor', onFloor);
        if (onFloor === 0) ctx.events.emit('FellThroughFloor', { entity });
      }
    }
  }
}
