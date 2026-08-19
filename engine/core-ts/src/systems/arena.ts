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
import { distSqLe, INT32_MAX, INT32_MIN, mul, sub } from '../math/fixed.js';
import { getField, type PrefabDef } from '../ecs/world.js';
import {
  FIXED_ONE,
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

/**
 * События арены (ARENA-5): тип → имена полей его данных. Перечень здесь по той
 * же причине, что и у физики (`PHYSICS_EVENTS`): эти два факта эмитит МЕХАНИЗМ,
 * а не сцена действием `emitEvent`, — обходом документа игры их не найти.
 */
export const ARENA_EVENTS = {
  LeftArena: ['entity'],
  FellThroughFloor: ['entity'],
} as const;

/** Имена типов берутся у перечня: переименование мимо него не компилируется. */
const LEFT_ARENA_EVENT: keyof typeof ARENA_EVENTS = 'LeftArena';
const FELL_THROUGH_FLOOR_EVENT: keyof typeof ARENA_EVENTS = 'FellThroughFloor';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 110;

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
 *
 * `support` — коэффициент опорной области (ARENA-3): Q16.16-доля вписанной
 * окружности коллайдера в `[0, 1]`, ноль — проверка по центру. Конфигурация, а
 * не состояние прошлого тика, но живёт в том же компоненте: участие в
 * проверках арены и их параметры — один гейт, а отдельный опциональный
 * компонент дал бы вторую маску на том же горячем пути.
 */
export const ARENA_COMPONENTS: readonly ComponentSchema[] = [
  { name: ARENA_COMPONENT, fields: { radius: 'fixed' } },
  {
    name: ARENA_STATE_COMPONENT,
    fields: { inside: 'i32', onFloor: 'i32', support: 'fixed' },
    defaults: { inside: 1, onFloor: 1 },
  },
];

/**
 * Валидация `support` в prefabs сцены (ARENA-3): доля вне `[0, 1]` не имеет
 * геометрического смысла и отвергается на загрузке, а не проявляется поведением.
 */
export function checkArenaSupport(prefabs: readonly PrefabDef[]): void {
  for (const prefab of prefabs) {
    const support = prefab.components[ARENA_STATE_COMPONENT]?.support;
    if (support === undefined) continue;
    if (!Number.isInteger(support) || support < 0 || support > FIXED_ONE) {
      throw new Error(
        `ARENA-3: prefab "${prefab.name}" — "support" вне [0, 1] в Q16.16 (получено ${support})`,
      );
    }
  }
}

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
  readonly order = ANCHOR_ORDER;

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
        if (inside === 0) ctx.events.emit(LEFT_ARENA_EVENT, { entity });
      }

      // ARENA-5: пол проверяется только у стоящих на земле. Override уровня
      // (ARENA-6) означает, что сущность в полёте — снаряд над дырой не падает.
      // Без террейна проверять нечем (DI-3).
      if (ctx.terrain === undefined || ctx.has(entity, LEVEL_OVERRIDE_COMPONENT)) continue;
      const onFloor = standsOnFloor(ctx, entity, position) ? 1 : 0;
      if (onFloor !== ctx.get(entity, ARENA_STATE_COMPONENT, 'onFloor')) {
        ctx.commands.setField(entity, ARENA_STATE_COMPONENT, 'onFloor', onFloor);
        if (onFloor === 0) ctx.events.emit(FELL_THROUGH_FLOOR_EVENT, { entity });
      }
    }
  }
}

/**
 * Критерий опоры (ARENA-5): круг радиуса `support × inradius коллайдера`
 * пересекает хотя бы одну клетку с полом. Вырождение в точку — и поведение,
 * тождественное проверке по центру, — при нулевом `support`, без коллайдера
 * (уменьшать нечего) и без Physics API (форма коллайдера ядру неизвестна, DI-3).
 */
function standsOnFloor(ctx: SystemContext, entity: EntityId, position: Vec2): boolean {
  const terrain = ctx.terrain!;
  const support = ctx.get(entity, ARENA_STATE_COMPONENT, 'support');
  if (support !== 0 && ctx.physics !== undefined) {
    const inradius = ctx.physics.inradiusOf(entity);
    if (inradius !== undefined) {
      const radius = mul(support, inradius);
      if (radius > 0) return terrain.hasFloorWithin(position, radius);
    }
  }
  return terrain.hasFloorAt(position);
}
