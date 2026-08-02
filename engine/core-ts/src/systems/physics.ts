/**
 * Физика (PHYS-1..9): примитивные коллайдеры, статика обрывов, разрешение
 * движения и детерминированный raycast.
 *
 * Всё считается в 2D-проекции и в Q16.16 (PHYS-1, PHYS-3). Уровень террейна на
 * пересечения не влияет — перепад высот входит в физику статическими
 * коллайдерами обрывов (`terrain` TERR-5), а не третьей координатой.
 *
 * Диапазон: расстояния, участвующие в квадратичных тестах, не должны выходить
 * за ~181 единицу — квадрат большего значения не помещается в Q16.16. Тот же
 * предел уже действует в `withinRadius` (QUERY-1), потому что там та же
 * арифметика.
 */
import * as fixed from '../math/fixed.js';
import * as vec from '../math/vector.js';
import { getField, hasTag } from '../ecs/world.js';
import { query } from '../ecs/query.js';
import {
  FIXED_ONE,
  POSITION_COMPONENT,
  type EntityId,
  type Fixed,
  type PhysicsApi,
  type RaycastHit,
  type System,
  type SystemContext,
  type TerrainGrid,
  type Vec2,
  type WorldState,
} from '../types.js';

/** Значения поля `shape` компонента коллайдера. */
export const SHAPE_CIRCLE = 0;
export const SHAPE_AABB = 1;

/** Теги блокировки: обычные теги сущности (ECS), у статики — её собственные. */
export const BLOCKS_MOVEMENT = 'blocksMovement';
export const BLOCKS_VISION = 'blocksVision';

/** Обрыв блокирует и движение, и обзор (TERR-5); массив общий на все отрезки. */
const CLIFF_TAGS: readonly string[] = [BLOCKS_MOVEMENT, BLOCKS_VISION];

const DEFAULT_COLLIDER_COMPONENT = 'Collider';
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
const DEFAULT_CELL_SIZE = fixed.fromInt(4);
/** Физика двигает сущности после геймплейных систем, но до наблюдателей видимости. */
const DEFAULT_ORDER = 100;

/**
 * Статический коллайдер: прямоугольник в мировых координатах. Обрыв —
 * вырожденный прямоугольник нулевой толщины: отрезок и прямоугольник тогда
 * проходят один narrow-phase, а не два.
 */
export interface StaticCollider {
  readonly minX: Fixed;
  readonly minY: Fixed;
  readonly maxX: Fixed;
  readonly maxY: Fixed;
  readonly tags: readonly string[];
}

interface Bounds {
  minX: Fixed;
  minY: Fixed;
  maxX: Fixed;
  maxY: Fixed;
}

/** Статические коллайдеры обрывов из производной геометрии террейна (TERR-5). */
export function staticsFromTerrain(grid: TerrainGrid): StaticCollider[] {
  return grid.cliffs.map((edge) => ({
    minX: Math.min(edge.from.x, edge.to.x),
    minY: Math.min(edge.from.y, edge.to.y),
    maxX: Math.max(edge.from.x, edge.to.x),
    maxY: Math.max(edge.from.y, edge.to.y),
    tags: CLIFF_TAGS,
  }));
}

/**
 * Broad-phase (PHYS-5): равномерная сетка по статике. Динамика не
 * индексируется — её десятки, и живой линейный обход не может протухнуть,
 * в отличие от индекса, который пришлось бы инвалидировать после каждой
 * записи в `Position` любой системой.
 *
 * ponytail: индексировать динамику имеет смысл, когда её станут сотни;
 * пока это лишний инвариант, который легко нарушить молча.
 */
export class PhysicsWorld {
  private readonly cells = new Map<number, number[]>();
  /** Метка последнего запроса на каждый коллайдер — дешёвая дедупликация по клеткам. */
  private readonly stamp: Int32Array;
  private queryId = 0;

  constructor(
    readonly statics: readonly StaticCollider[],
    readonly cellSize: Fixed = DEFAULT_CELL_SIZE,
  ) {
    this.stamp = new Int32Array(statics.length);
    for (let i = 0; i < statics.length; i++) {
      const s = statics[i]!;
      for (let cy = this.cell(s.minY); cy <= this.cell(s.maxY); cy++) {
        for (let cx = this.cell(s.minX); cx <= this.cell(s.maxX); cx++) {
          const key = cx * 131072 + cy;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  private cell(coordinate: Fixed): number {
    return Math.floor(coordinate / this.cellSize);
  }

  /** Статика, чей AABB пересекает `bounds` и у которой есть тег `tag`. Порядок — по индексу (DET-6). */
  query(bounds: Bounds, tag: string): StaticCollider[] {
    this.queryId++;
    const found: number[] = [];
    for (let cy = this.cell(bounds.minY); cy <= this.cell(bounds.maxY); cy++) {
      for (let cx = this.cell(bounds.minX); cx <= this.cell(bounds.maxX); cx++) {
        for (const index of this.cells.get(cx * 131072 + cy) ?? []) {
          if (this.stamp[index] === this.queryId) continue;
          this.stamp[index] = this.queryId;
          const s = this.statics[index]!;
          if (!s.tags.includes(tag)) continue;
          if (!overlaps(bounds, s)) continue;
          found.push(index);
        }
      }
    }
    found.sort((a, b) => a - b);
    return found.map((index) => this.statics[index]!);
  }
}

/** Касание не считается пересечением: сущность, вставшая вплотную к стене, не заблокирована. */
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

// ------------------------------------------------------------- коллайдеры ECS

interface Collider {
  readonly halfX: Fixed;
  readonly halfY: Fixed;
  readonly shape: number;
  readonly radius: Fixed;
}

function colliderOf(read: FieldReader, entity: EntityId, component: string): Collider {
  const shape = read(entity, component, 'shape');
  const radius = read(entity, component, 'radius');
  return shape === SHAPE_CIRCLE
    ? { halfX: radius, halfY: radius, shape, radius }
    : {
        halfX: read(entity, component, 'halfX'),
        halfY: read(entity, component, 'halfY'),
        shape,
        radius,
      };
}

type FieldReader = (entity: EntityId, component: string, field: string) => number;

function boundsAt(x: Fixed, y: Fixed, collider: Collider): Bounds {
  return {
    minX: fixed.sub(x, collider.halfX),
    minY: fixed.sub(y, collider.halfY),
    maxX: fixed.add(x, collider.halfX),
    maxY: fixed.add(y, collider.halfY),
  };
}

// --------------------------------------------------------- разрешение движения

export interface PhysicsOptions {
  readonly collider?: string;
  readonly velocity?: string;
  readonly order?: number;
}

/**
 * Разрешение движения (PHYS-8). Система на TS за обычным контрактом: читает
 * запросами, пишет только через Command Buffer (DET-7, CMD-4).
 *
 * Движение раскладывается по осям — сначала X, затем Y: заблокированная ось
 * гасится, свободная исполняется, и скольжение вдоль стены получается само,
 * без отдельного правила. Тест — свёрнутый (swept) AABB от старой позиции к
 * новой, поэтому быстрый снаряд не проскакивает сквозь нулевую толщину обрыва.
 *
 * ponytail: формы аппроксимируются огибающими AABB, а сущность при блокировке
 * остаётся на старой координате оси, а не придвигается вплотную. Точный
 * контакт и капсульный sweep — когда это станет заметно в игре.
 */
export class PhysicsSystem implements System {
  readonly name = 'Physics';
  readonly order: number;
  private readonly colliderComponent: string;
  private readonly velocityComponent: string;

  constructor(
    private readonly physicsWorld: PhysicsWorld,
    options: PhysicsOptions = {},
  ) {
    this.order = options.order ?? DEFAULT_ORDER;
    this.colliderComponent = options.collider ?? DEFAULT_COLLIDER_COMPONENT;
    this.velocityComponent = options.velocity ?? DEFAULT_VELOCITY_COMPONENT;
  }

  run(ctx: SystemContext): void {
    const movers = ctx.query({
      all: [POSITION_COMPONENT, this.colliderComponent, this.velocityComponent],
    });
    if (movers.length === 0) return;

    const blockers = ctx.query({
      all: [POSITION_COMPONENT, this.colliderComponent],
      withTag: BLOCKS_MOVEMENT,
    });
    // Позиции уже разрешённых на этом тике: Command Buffer вливается только в
    // конце системы, а сосед обязан видеть, куда его предшественник уже встал.
    const resolved = new Map<EntityId, Vec2>();
    const positionOf = (entity: EntityId): Vec2 =>
      resolved.get(entity) ?? {
        x: ctx.get(entity, POSITION_COMPONENT, 'x'),
        y: ctx.get(entity, POSITION_COMPONENT, 'y'),
      };

    for (const mover of movers) {
      const collider = colliderOf(ctx.get, mover, this.colliderComponent);
      const from = positionOf(mover);
      let x = from.x;
      let y = from.y;

      for (const axis of ['x', 'y'] as const) {
        const step = ctx.get(mover, this.velocityComponent, axis);
        if (step === 0) continue;
        const nextX = axis === 'x' ? fixed.add(x, step) : x;
        const nextY = axis === 'y' ? fixed.add(y, step) : y;
        const current = boundsAt(x, y, collider);
        const next = boundsAt(nextX, nextY, collider);
        const swept = union(current, next);

        const hit = this.firstBlocker(ctx, { current, next, swept, axis }, mover, blockers, positionOf);
        if (hit === undefined) {
          x = nextX;
          y = nextY;
          continue;
        }
        // Нормаль направлена против движения: политике (отскок, кнокбэк, урон
        // о стену) нужна сторона удара, а не факт остановки (PHYS-9).
        const sign = step > 0 ? -1 : 1;
        ctx.events.emit('Collision', {
          entity: mover,
          other: hit,
          nx: axis === 'x' ? fixed.fromInt(sign) : 0,
          ny: axis === 'y' ? fixed.fromInt(sign) : 0,
        });
      }

      if (x !== from.x || y !== from.y) {
        resolved.set(mover, { x, y });
        ctx.commands.setField(mover, POSITION_COMPONENT, 'x', x);
        ctx.commands.setField(mover, POSITION_COMPONENT, 'y', y);
      }
    }
  }

  /** Первый блокирующий: статика идёт раньше динамики, динамика — по порядку запроса (QUERY-2). */
  private firstBlocker(
    ctx: SystemContext,
    move: Move,
    mover: EntityId,
    blockers: Float64Array,
    positionOf: (entity: EntityId) => Vec2,
  ): number | undefined {
    for (const s of this.physicsWorld.query(move.swept, BLOCKS_MOVEMENT)) {
      if (blocks(move, s)) return STATIC_COLLIDER;
    }
    for (const other of blockers) {
      if (other === mover) continue;
      const position = positionOf(other);
      const collider = colliderOf(ctx.get, other, this.colliderComponent);
      if (blocks(move, boundsAt(position.x, position.y, collider))) return other;
    }
    return undefined;
  }
}

/** `other` в событии столкновения: сущности у статического коллайдера нет. */
export const STATIC_COLLIDER = -1;

interface Move {
  readonly current: Bounds;
  readonly next: Bounds;
  readonly swept: Bounds;
  readonly axis: 'x' | 'y';
}

/**
 * Блокирует ли препятствие этот ход по оси.
 *
 * Пока сущность снаружи — блокирует всё, что задевает заметаемый объём. Если
 * она уже внутри препятствия (заспавнили внахлёст, геймплейная система
 * записала `Position` в стену), блокируется только ход, который не уводит её
 * наружу: иначе любое движение считалось бы столкновением, и сущность
 * залипала бы навсегда.
 */
function blocks(move: Move, obstacle: Bounds): boolean {
  if (!overlaps(move.current, obstacle)) return overlaps(move.swept, obstacle);
  return separation(move.next, obstacle, move.axis) <= separation(move.current, obstacle, move.axis);
}

/**
 * Удвоенное расстояние между центрами по оси. Удвоенное — чтобы не делить:
 * сравниваются только два таких значения между собой. Сумма границ выходит за
 * i32, поэтому складывается обычной арифметикой (в Rust-порте — i64), а не
 * через `fixed.add` с его проверкой диапазона.
 */
function separation(box: Bounds, obstacle: Bounds, axis: 'x' | 'y'): number {
  const a = axis === 'x' ? box.minX + box.maxX : box.minY + box.maxY;
  const b = axis === 'x' ? obstacle.minX + obstacle.maxX : obstacle.minY + obstacle.maxY;
  return Math.abs(a - b);
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

// -------------------------------------------------------------------- raycast

/**
 * Physics API (PHYS-4, PHYS-6). Держит ссылку на мир: raycast зовут другие
 * системы посреди тика, и позиции обязаны читаться живыми, а не из индекса,
 * снятого в начале тика.
 */
export function createPhysicsApi(
  world: WorldState,
  physicsWorld: PhysicsWorld,
  options: PhysicsOptions = {},
): PhysicsApi {
  const colliderComponent = options.collider ?? DEFAULT_COLLIDER_COMPONENT;
  const read: FieldReader = (entity, component, field) => getField(world, entity, component, field);

  return {
    raycast: (from, to, rayOptions) => {
      const tag = rayOptions?.mask ?? BLOCKS_VISION;
      const delta = vec.sub(to, from);
      const rayLength = vec.length(delta);
      if (rayLength === 0) return null;
      const dir = vec.normalize(delta);

      let best: number | undefined;
      let bestEntity: EntityId | undefined;

      const rayBounds: Bounds = {
        minX: Math.min(from.x, to.x),
        minY: Math.min(from.y, to.y),
        maxX: Math.max(from.x, to.x),
        maxY: Math.max(from.y, to.y),
      };

      for (const s of physicsWorld.query(rayBounds, tag)) {
        const distance = rayVsBox(from, dir, rayLength, s);
        if (distance !== undefined && (best === undefined || distance < best)) {
          best = distance;
          bestEntity = undefined;
        }
      }

      for (const entity of queryColliders(world, colliderComponent, tag)) {
        if (entity === rayOptions?.ignore) continue;
        const x = read(entity, POSITION_COMPONENT, 'x');
        const y = read(entity, POSITION_COMPONENT, 'y');
        const collider = colliderOf(read, entity, colliderComponent);
        const distance =
          collider.shape === SHAPE_CIRCLE
            ? rayVsCircle(from, dir, rayLength, { x, y }, collider.radius)
            : rayVsBox(from, dir, rayLength, boundsAt(x, y, collider));
        if (distance !== undefined && (best === undefined || distance < best)) {
          best = distance;
          bestEntity = entity;
        }
      }

      if (best === undefined) return null;
      const point = vec.add(from, vec.scale(dir, best));
      const hit: RaycastHit = bestEntity === undefined ? { point } : { entity: bestEntity, point };
      return hit;
    },
  };
}

/** Коллайдеры с нужным тегом. Порядок — по индексу сущности (QUERY-2), поэтому и разрешение ничьей детерминировано. */
function queryColliders(world: WorldState, component: string, tag: string): Float64Array {
  return query(world, { all: [POSITION_COMPONENT, component], withTag: tag });
}

/**
 * Луч против прямоугольника — метод слэбов в расстояниях вдоль луча, а не в
 * параметре `t`: параметр потребовал бы деления на длину и второго диапазона.
 */
function rayVsBox(from: Vec2, dir: Vec2, rayLength: Fixed, box: Bounds): number | undefined {
  let near = 0;
  let far = rayLength;

  for (const axis of ['x', 'y'] as const) {
    const origin = from[axis];
    const direction = dir[axis];
    const lo = axis === 'x' ? box.minX : box.minY;
    const hi = axis === 'x' ? box.maxX : box.maxY;
    if (direction === 0) {
      if (origin <= lo || origin >= hi) return undefined;
      continue;
    }
    let t0 = ratio(fixed.sub(lo, origin), direction, rayLength);
    let t1 = ratio(fixed.sub(hi, origin), direction, rayLength);
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return undefined;
  }
  return near;
}

/**
 * Деление с насыщением: частное вне отрезка луча нас не интересует, а
 * `fixed.div` на почти нулевом знаменателе вылетело бы за i32. Промежуточное
 * произведение не превышает 2^47 и в double точно, как и в i64 у Rust-порта.
 */
function ratio(numerator: Fixed, denominator: Fixed, limit: Fixed): number {
  const quotient = Math.floor((numerator * FIXED_ONE) / denominator);
  const bound = limit + FIXED_ONE;
  return quotient < -bound ? -bound : quotient > bound ? bound : quotient;
}

/**
 * Луч против круга — через проекцию на нормированное направление, без
 * дискриминанта: у квадратичной формы промежуточные произведения выходят за
 * Q16.16 уже на десятке единиц, здесь же все множители порядка расстояния.
 */
function rayVsCircle(
  from: Vec2,
  dir: Vec2,
  rayLength: Fixed,
  center: Vec2,
  radius: Fixed,
): number | undefined {
  const toCenter = vec.sub(center, from);
  const projection = vec.dot(toCenter, dir);
  const perpendicularSq = fixed.sub(vec.lengthSq(toCenter), fixed.mul(projection, projection));
  const radiusSq = fixed.mul(radius, radius);
  if (perpendicularSq > radiusSq) return undefined;

  const halfChord = fixed.sqrt(fixed.sub(radiusSq, perpendicularSq));
  const entry = fixed.sub(projection, halfChord);
  // Источник внутри круга: попадание в нулевой дистанции — дефект вызова
  // (PHYS-6 требует исключать источник), а не хит.
  if (entry < 0) return undefined;
  return entry > rayLength ? undefined : entry;
}
