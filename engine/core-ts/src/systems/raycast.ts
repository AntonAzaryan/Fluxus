/**
 * Луч физики (PHYS-6, PHYS-13, PHYS-14): обход статики и коллайдеров сущностей
 * и выбор ближайшего попадания.
 *
 * Отдельным модулем — по той же причине, что broad-phase и колоночная модель:
 * обход луча не знает ни разрешения движения, ни сенсоров, а разрешение
 * движения не знает про луч. Наружу он выходит из `physics.ts`: адрес физики
 * один, и потребителю незачем знать, на сколько файлов она разложена внутри.
 */
import * as vec from '../math/vector.js';
import {
  boundsAt,
  rayVsBox,
  rayVsCircle,
  SHAPE_CIRCLE,
  type Bounds,
  type StaticCollider,
} from './collisionGeometry.js';
import {
  bandsMeet,
  effectiveLevel,
  COLLIDER_HEIGHT_FIELD,
  type LevelProbe,
  type LevelSource,
  type PhysicsDeps,
} from './columnModel.js';
import {
  colliderOf,
  DEFAULT_COLLIDER_COMPONENT,
  type FieldReader,
  type PhysicsOptions,
} from './colliderRead.js';
import { PhysicsWorld } from './broadPhase.js';
import { countCostRaycast } from '../debug.js';
import { getField, hasComponent } from '../ecs/world.js';
import { query } from '../ecs/query.js';
import {
  POSITION_COMPONENT,
  type EntityId,
  type PhysicsApi,
  type RaycastHit,
  type WorldState,
} from '../types.js';

/** Точка луча: и начало, и направление — обычные пары Q16.16. */
interface RayPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Physics API (PHYS-4, PHYS-6). Держит ссылку на мир: raycast зовут другие
 * системы посреди тика, и позиции обязаны читаться живыми, а не из индекса,
 * снятого в начале тика.
 */
export function createPhysicsApi(
  world: WorldState,
  physicsWorld: PhysicsWorld,
  options: PhysicsOptions = {},
  deps: PhysicsDeps = {},
): PhysicsApi {
  const colliderComponent = options.collider ?? DEFAULT_COLLIDER_COMPONENT;
  const read: FieldReader = (entity, component, field) => getField(world, entity, component, field);
  const heightGate = deps.height === true;
  // Источник уровня и точка запроса собираются ОДИН раз на симуляцию, а не на
  // вызов луча: `raycast` зовут из середины тика на каждого кандидата видимости
  // (FOW-5), и объект на вызов был бы аллокацией, пропорциональной сцене.
  const levels: LevelSource = {
    has: (entity, component) => hasComponent(world, entity, component),
    get: read,
    ...(deps.terrain !== undefined ? { terrain: deps.terrain } : {}),
  };
  const probe: LevelProbe = { x: 0, y: 0 };
  // Ближайшее попадание копится в аккумуляторе, собранном ОДИН раз на
  // симуляцию, — по той же причине, что `levels` и `probe`: луч зовут из
  // середины тика на каждого кандидата видимости (FOW-5).
  const nearest: RayNearest = { distance: undefined, entity: undefined };
  const rayBounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const scan: ColliderScan = { read, colliderComponent, levels, probe, heightGate };

  return {
    raycast: (from, to, rayOptions) => {
      // Единица объёма — сам вызов луча (PERF-3): осмотренные им кандидаты
      // статики считает `collect` своим счётчиком.
      countCostRaycast();
      // Маска ФИЛЬТРУЕТ коллайдеры (PHYS-6): её отсутствие — пересечение по
      // всем, а не по коллайдерам какого-то одного тега. LoS свой тег называет
      // сам (`VisibilitySystem`), и подставленное умолчание молча сужало бы
      // луч, пущенный из выражения без маски (EXPR-8).
      const tag = rayOptions?.mask;
      const elevation = rayOptions?.elevation;
      const delta = vec.sub(to, from);
      const rayLength = vec.length(delta);
      if (rayLength === 0) return null;
      const dir = vec.normalize(delta);

      resetNearest(nearest);
      rayBounds.minX = Math.min(from.x, to.x);
      rayBounds.minY = Math.min(from.y, to.y);
      rayBounds.maxX = Math.max(from.x, to.x);
      rayBounds.maxY = Math.max(from.y, to.y);

      // Порядок прежний и наблюдаем: сначала статика, затем коллайдеры мира по
      // индексу сущности (QUERY-2) — ничья достаётся первому по обходу.
      castAgainstStatics(physicsWorld.query(rayBounds, tag), from, dir, rayLength, elevation, nearest);
      castAgainstColliders(queryColliders(world, colliderComponent, tag), scan, from, dir, rayLength, rayOptions, nearest);

      const best = nearest.distance;
      if (best === undefined) return null;
      const point = vec.add(from, vec.scale(dir, best));
      const bestEntity = nearest.entity;
      const hit: RaycastHit = bestEntity === undefined ? { point } : { entity: bestEntity, point };
      return hit;
    },
    /** ARENA-5: у круга — радиус, у AABB — меньшая полуось (вписанная окружность). */
    inradiusOf: (entity) => {
      if (!hasComponent(world, entity, colliderComponent)) return undefined;
      const collider = colliderOf(read, entity, colliderComponent);
      return collider.shape === SHAPE_CIRCLE
        ? collider.radius
        : Math.min(collider.halfX, collider.halfY);
    },
  };
}

/**
 * Ближайшее попадание луча: расстояние и сущность (у статики её нет). Живёт
 * записью, а не парой возвращаемых значений, — обе половины обхода пишут в неё
 * по очереди, и объекта на вызов луча не заводится.
 */
interface RayNearest {
  distance: number | undefined;
  entity: EntityId | undefined;
}

/** Сброс аккумулятора перед новым лучом: запись переиспользуется между вызовами. */
function resetNearest(nearest: RayNearest): void {
  nearest.distance = undefined;
  nearest.entity = undefined;
}

/** Неизменная на всю симуляцию обвязка обхода коллайдеров лучом. */
interface ColliderScan {
  readonly read: FieldReader;
  readonly colliderComponent: string;
  readonly levels: LevelSource;
  readonly probe: LevelProbe;
  readonly heightGate: boolean;
}

/** Отрезки статики на пути луча (PHYS-13 — гейт прозрачности ребра обрыва). */
function castAgainstStatics(
  statics: readonly StaticCollider[],
  from: RayPoint,
  dir: RayPoint,
  rayLength: number,
  elevation: number | undefined,
  nearest: RayNearest,
): void {
  for (const s of statics) {
    // PHYS-13: ребро, чей верхний уровень не выше уровня луча, прозрачно —
    // пересечение не засчитывается вовсе.
    if (cliffRayOpen(elevation, s)) continue;
    const distance = rayVsBox(from, dir, rayLength, s);
    if (distance !== undefined && (nearest.distance === undefined || distance < nearest.distance)) {
      nearest.distance = distance;
      nearest.entity = undefined;
    }
  }
}

/** Коллайдеры сущностей на пути луча (PHYS-6, колоночный гейт PHYS-14). */
function castAgainstColliders(
  entities: Float64Array,
  scan: ColliderScan,
  from: RayPoint,
  dir: RayPoint,
  rayLength: number,
  rayOptions: { readonly ignore?: EntityId; readonly elevation?: number } | undefined,
  nearest: RayNearest,
): void {
  const read = scan.read;
  for (const entity of entities) {
    if (entity === rayOptions?.ignore) continue;
    const x = read(entity, POSITION_COMPONENT, 'x');
    const y = read(entity, POSITION_COMPONENT, 'y');
    if (!rayBandMeets(scan, entity, x, y, rayOptions?.elevation)) continue;
    const collider = colliderOf(read, entity, scan.colliderComponent);
    const distance =
      collider.shape === SHAPE_CIRCLE
        ? rayVsCircle(from, dir, rayLength, { x, y }, collider.radius)
        : rayVsBox(from, dir, rayLength, boundsAt(x, y, collider));
    if (distance !== undefined && (nearest.distance === undefined || distance < nearest.distance)) {
      nearest.distance = distance;
      nearest.entity = entity;
    }
  }
}

/**
 * Колоночный гейт луча (PHYS-14): попадание засчитывается, только если полоса
 * коллайдера содержит уровень испускателя. Луч БЕЗ уровня пересекает коллайдер
 * любой полосы — то же консервативное умолчание, что у обрывов в PHYS-13.
 * Статика через этот гейт не проходит: полосы у неё нет, её высотную семантику
 * несут PHYS-11 и PHYS-13.
 */
function rayBandMeets(
  scan: ColliderScan,
  entity: EntityId,
  x: number,
  y: number,
  elevation: number | undefined,
): boolean {
  if (!scan.heightGate || elevation === undefined) return true;
  const height = scan.read(entity, scan.colliderComponent, COLLIDER_HEIGHT_FIELD);
  const level = height > 0 ? effectiveLevel(scan.levels, scan.probe, entity, x, y) : 0;
  return bandsMeet(level, height, elevation, 1);
}

/**
 * Коллайдеры с нужным тегом; без тега — все коллайдеры мира (PHYS-6). Порядок —
 * по индексу сущности (QUERY-2), поэтому и разрешение ничьей детерминировано.
 */
function queryColliders(world: WorldState, component: string, tag: string | undefined): Float64Array {
  return query(world, { all: [POSITION_COMPONENT, component], withTag: tag });
}

/**
 * PHYS-13: прозрачно ли ребро обрыва для луча данной высоты. Ребро перекрывает
 * луч, только если его верхний уровень строго больше уровня испускателя:
 * взгляд и полёт по своему уровню и вниз свободны — и через собственное ребро,
 * и через низину к плато того же уровня, — а подъём выше уровня луча
 * перекрывает, как любая статика. Луч без уровня консервативен: обрыв
 * перекрывает его с обеих сторон, как обычная статика без уровней.
 *
 * Детерминизм не затронут: сравнение целых уровней, порядок перебора прежний.
 * На гейт движения (PHYS-11, `cliffGateOpen`) правило не переносится.
 */
function cliffRayOpen(elevation: number | undefined, s: StaticCollider): boolean {
  if (elevation === undefined) return false;
  if (s.levelNeg === undefined || s.levelPos === undefined) return false;
  return (s.levelNeg > s.levelPos ? s.levelNeg : s.levelPos) <= elevation;
}
