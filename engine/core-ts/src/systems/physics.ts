/**
 * Физика (PHYS-1..13): примитивные коллайдеры, статика обрывов, разрешение
 * движения по маскам слоёв, sensor-пересечения и детерминированный raycast.
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
import {
  blocks,
  boundsAt,
  boundsInto,
  cliffGateOpen,
  closestDistanceSq,
  copyBounds,
  overlaps,
  surfaceNormal,
  union,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  type Blocker,
  type Bounds,
  type Collider,
  type Move,
  type MutableCollider,
  type StaticCollider,
} from './collisionGeometry.js';
import { getField, hasComponent } from '../ecs/world.js';
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

/**
 * Формы коллайдера, статический прямоугольник и огибающая — из геометрии
 * разрешения движения (`collisionGeometry.ts`); здесь они реэкспортируются,
 * потому что это публичная поверхность физики (PHYS-1).
 */
export { SHAPE_AABB, SHAPE_CIRCLE } from './collisionGeometry.js';
export type { Bounds, StaticCollider } from './collisionGeometry.js';

/**
 * Теги блокировки: обычные теги сущности (ECS), у статики — её собственные.
 * Обзором управляет тег `blocksVision` (PHYS-2); участие в разрешении движения
 * тегом больше не выражается — его задают маски `layer`/`blockMask`, и тег
 * `blocksMovement` остаётся только меткой на статике обрывов (TERR-5).
 */
export const BLOCKS_MOVEMENT = 'blocksMovement';
export const BLOCKS_VISION = 'blocksVision';

/** Обрыв блокирует и движение, и обзор (TERR-5); массив общий на все отрезки. */
const CLIFF_TAGS: readonly string[] = [BLOCKS_MOVEMENT, BLOCKS_VISION];

/**
 * Слой статики обрывов по умолчанию. Значение — параметр сборки, а не
 * конвенция ядра (PHYS-2): загрузчик сцены вправе передать свой.
 */
export const DEFAULT_CLIFF_LAYER = 1;

const DEFAULT_COLLIDER_COMPONENT = 'Collider';
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
const DEFAULT_CELL_SIZE = fixed.fromInt(4);
/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 100;

/**
 * Статические коллайдеры обрывов из производной геометрии террейна (TERR-5).
 * Слой статики — параметр сборки (PHYS-2), а не конвенция ядра.
 */
export function staticsFromTerrain(
  grid: TerrainGrid,
  cliffLayer: number = DEFAULT_CLIFF_LAYER,
): StaticCollider[] {
  return grid.cliffs.map((edge) => ({
    minX: Math.min(edge.from.x, edge.to.x),
    minY: Math.min(edge.from.y, edge.to.y),
    maxX: Math.max(edge.from.x, edge.to.x),
    maxY: Math.max(edge.from.y, edge.to.y),
    tags: CLIFF_TAGS,
    layer: cliffLayer,
    levelNeg: edge.levelNeg,
    levelPos: edge.levelPos,
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
  // Поля объявлены явно, а не parameter properties: `bin/sim.mjs` исполняет
  // исходники через strip-only режим node, который их не поддерживает (CLI-1).
  readonly statics: readonly StaticCollider[];
  readonly cellSize: Fixed;

  constructor(statics: readonly StaticCollider[], cellSize: Fixed = DEFAULT_CELL_SIZE) {
    this.statics = statics;
    this.cellSize = cellSize;
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

  /**
   * Клетка сетки по мировой координате.
   *
   * DET-2, условия 3 и 5: делимое — координата в Q16.16, то есть `i32` по
   * модулю меньше 2^31; делитель `cellSize` — положительное целое Q16.16.
   * Промежуток из 2^53 не выходит, частное приводится к целому.
   *
   * Условие 4: делимое БЫВАЕТ отрицательным (арена левее и ниже начала
   * координат), и `floor` расходится там с усечением к нулю. Расхождение
   * ненаблюдаемо, и держится это не на выборе `floor`, а на том, что вставка в
   * индекс и запрос по нему пользуются ОДНОЙ этой функцией: при любой конвенции
   * отображение остаётся разбиением плоскости на клетки, коллайдер лежит в той
   * же клетке, в которой его ищут, и набор кандидатов совпадает. Обход клеток
   * идёт по возрастанию, а результат сортируется по индексу статики (DET-6),
   * поэтому и порядок от конвенции не зависит. Закреплено тестом на статике с
   * отрицательными координатами в `physics.test.ts`.
   */
  private cell(coordinate: Fixed): number {
    return Math.floor(coordinate / this.cellSize);
  }

  /**
   * Статика, чей AABB пересекает `bounds` и у которой есть тег `tag`; без тега
   * — вся статика, попавшая в `bounds` (PHYS-6: маска ФИЛЬТРУЕТ, и её
   * отсутствие фильтром быть не может). Порядок — по индексу (DET-6).
   */
  query(bounds: Bounds, tag?: string): StaticCollider[] {
    return this.collect(bounds, tag, undefined);
  }

  /** Статика, чей AABB пересекает `bounds` и чей `layer` попал в маску (PHYS-2). Порядок — по индексу (DET-6). */
  queryByLayer(bounds: Bounds, mask: number): StaticCollider[] {
    return this.collect(bounds, undefined, mask);
  }

  /**
   * Общий обход клеток обоих запросов: фильтр — тег (raycast; без тега фильтра
   * нет вовсе) либо маска слоёв (движение, сенсоры).
   *
   * ponytail: один запрос стоит двух массивов — индексов кандидатов и выданных
   * коллайдеров, — а зовут его на каждом шаге оси каждого движущегося и ещё раз
   * на его сенсоры. Снимается переиспользуемым буфером на `PhysicsWorld` либо
   * обходом через колбэк; и то и другое — когда профиль на реальной сцене
   * покажет эти аллокации, а не по вкусу.
   */
  private collect(bounds: Bounds, tag: string | undefined, mask: number | undefined): StaticCollider[] {
    this.queryId++;
    const found: number[] = [];
    for (let cy = this.cell(bounds.minY); cy <= this.cell(bounds.maxY); cy++) {
      for (let cx = this.cell(bounds.minX); cx <= this.cell(bounds.maxX); cx++) {
        for (const index of this.cells.get(cx * 131072 + cy) ?? []) {
          if (this.stamp[index] === this.queryId) continue;
          this.stamp[index] = this.queryId;
          const s = this.statics[index]!;
          const rejected = mask === undefined ? tag !== undefined && !s.tags.includes(tag) : (s.layer & mask) === 0;
          if (rejected) continue;
          if (!overlaps(bounds, s)) continue;
          found.push(index);
        }
      }
    }
    found.sort((a, b) => a - b);
    return found.map((index) => this.statics[index]!);
  }
}

// ------------------------------------------------------------- коллайдеры ECS

/**
 * ponytail: коллайдер выдаётся новым объектом на каждый вызов. Горячий обход
 * кандидатов блокировки от этого уже избавлен готовым буфером (`colliderInto`
 * ниже); остались места, где буфера пока нет, — движущийся раз на тик и
 * КАЖДОЕ препятствие на sensor-проверке. Второй буфер на `PhysicsSystem`
 * закрывает и их — когда профиль на реальной сцене покажет эти аллокации.
 */
function colliderOf(read: FieldReader, entity: EntityId, component: string): Collider {
  const collider: MutableCollider = { halfX: 0, halfY: 0, shape: 0, radius: 0 };
  colliderInto(read, entity, component, collider);
  return collider;
}

/** Тот же разбор в готовый буфер: обход кандидатов не аллоцирует (PHYS-5). */
function colliderInto(
  read: FieldReader,
  entity: EntityId,
  component: string,
  out: MutableCollider,
): void {
  const shape = read(entity, component, 'shape');
  const radius = read(entity, component, 'radius');
  out.shape = shape;
  out.radius = radius;
  // У круга огибающая — квадрат по радиусу: полуоси коллайдера не читаются.
  out.halfX = shape === SHAPE_CIRCLE ? radius : read(entity, component, 'halfX');
  out.halfY = shape === SHAPE_CIRCLE ? radius : read(entity, component, 'halfY');
}

type FieldReader = (entity: EntityId, component: string, field: string) => number;

// --------------------------------------------------------- разрешение движения

export interface PhysicsOptions {
  readonly collider?: string;
  readonly velocity?: string;
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
 * Препятствие блокирует движущегося, если `(obstacle.layer & mover.blockMask)`
 * непусто (PHYS-2); статика обрывов дополнительно проходит направленный гейт
 * по `cliffRise` (PHYS-11). Пересечения по `hitMask` не блокируют, а дают
 * событие `Overlap` по фактически исполненному свипу (PHYS-12).
 *
 * Система — документированный опт-ин в TimeScale (TIME-4, TIME-5): шаг оси —
 * произведение скорости на итоговый множитель `getEffectiveDelta` (TIME-3,
 * TIME-7). Скорость в компоненте при этом не мутируется — замедление действует
 * в точке интеграции и не «прилипает» к состоянию.
 *
 * ponytail: формы аппроксимируются огибающими AABB, а сущность при блокировке
 * остаётся на старой координате оси, а не придвигается вплотную. Точный
 * контакт и капсульный sweep — когда это станет заметно в игре.
 */
export class PhysicsSystem implements System {
  readonly name = 'Physics';
  readonly order = ANCHOR_ORDER;
  private readonly colliderComponent: string;
  private readonly velocityComponent: string;
  private readonly physicsWorld: PhysicsWorld;
  /**
   * Найденное препятствие текущего шага оси: заполняется `firstBlocker`,
   * читается сразу же при эмите события. Запись переиспользуется — обход
   * сущностей не аллоцирует по одной на каждую (дисциплина аллокаций).
   */
  private readonly blocker: Blocker = {
    other: STATIC_COLLIDER,
    shape: SHAPE_AABB,
    centerX: 0,
    centerY: 0,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  /**
   * Буферы кандидата в обходе препятствий: выбор ближайшего обязан осмотреть
   * всех блокирующих, и без них каждый кандидат стоил бы коллайдера и
   * огибающей в куче — аллокация, пропорциональная числу препятствий на
   * каждом шаге оси каждого движущегося.
   */
  private readonly candidateCollider: MutableCollider = {
    halfX: 0,
    halfY: 0,
    shape: SHAPE_AABB,
    radius: 0,
  };
  private readonly candidateBounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(physicsWorld: PhysicsWorld, options: PhysicsOptions = {}) {
    this.physicsWorld = physicsWorld;
    this.colliderComponent = options.collider ?? DEFAULT_COLLIDER_COMPONENT;
    this.velocityComponent = options.velocity ?? DEFAULT_VELOCITY_COMPONENT;
  }

  run(ctx: SystemContext): void {
    const movers = ctx.query({
      all: [POSITION_COMPONENT, this.colliderComponent, this.velocityComponent],
    });
    if (movers.length === 0) return;

    // Препятствия — все носители коллайдера: участие в блокировке и в сенсорах
    // решают маски на narrow-phase (PHYS-2), а не тег на запросе.
    const obstacles = ctx.query({ all: [POSITION_COMPONENT, this.colliderComponent] });
    // Позиции уже разрешённых на этом тике: Command Buffer вливается только в
    // конце системы, а сосед обязан видеть, куда его предшественник уже встал.
    //
    // ponytail: карта заводится заново каждый тик, а `positionOf` отдаёт свежую
    // пару координат на каждого не разрешённого ещё соседа — аллокация,
    // пропорциональная числу движущихся и препятствий. Долгоживущая карта с
    // очисткой и чтение координат без объекта-обёртки (как уже сделано в
    // `nearestBlocker`) снимают и то и другое — по профилю, а не по вкусу.
    const resolved = new Map<EntityId, Vec2>();
    const positionOf = (entity: EntityId): Vec2 =>
      resolved.get(entity) ?? {
        x: ctx.get(entity, POSITION_COMPONENT, 'x'),
        y: ctx.get(entity, POSITION_COMPONENT, 'y'),
      };

    for (const mover of movers) {
      const collider = colliderOf(ctx.get, mover, this.colliderComponent);
      const blockMask = ctx.get(mover, this.colliderComponent, 'blockMask');
      const hitMask = ctx.get(mover, this.colliderComponent, 'hitMask');
      const cliffRise = ctx.get(mover, this.colliderComponent, 'cliffRise');
      // Множитель шага — один на сущность и тик (TIME-3): обе оси одного хода
      // обязаны замедляться одинаково.
      const scale = ctx.getEffectiveDelta(mover, FIXED_ONE);
      const from = positionOf(mover);
      let x = from.x;
      let y = from.y;

      for (const axis of ['x', 'y'] as const) {
        const step = fixed.mul(ctx.get(mover, this.velocityComponent, axis), scale);
        if (step === 0) continue;
        const nextX = axis === 'x' ? fixed.add(x, step) : x;
        const nextY = axis === 'y' ? fixed.add(y, step) : y;

        // Пустая маска блокировки не порождает ни огибающих, ни поиска: сквозной
        // снаряд проходит ось, не заплатив за narrow-phase (PHYS-2).
        //
        // ponytail: шаг оси стоит четырёх объектов — две огибающие, их
        // объединение и сам `Move`, — то есть восьми на движущегося за тик.
        // Все четыре живут ровно до конца итерации и снимаются полями системы,
        // как уже сделано для кандидата (`candidateBounds`); ждём профиля.
        if (blockMask !== 0) {
          const current = boundsAt(x, y, collider);
          const next = boundsAt(nextX, nextY, collider);
          const move: Move = {
            current,
            next,
            swept: union(current, next),
            axis,
            step,
            centerX: x,
            centerY: y,
          };
          if (this.nearestBlocker(ctx, move, mover, obstacles, resolved, blockMask, cliffRise)) {
            // Нормаль поверхности в точке контакта (PHYS-9); осевая против
            // движения — её фолбэк и полный ответ для пары прямоугольников.
            // Политике (отскок, кнокбэк, урон о стену) нужна сторона удара, а
            // не факт остановки.
            const normal = surfaceNormal(move, collider.shape, this.blocker);
            ctx.events.emit('Collision', {
              entity: mover,
              other: this.blocker.other,
              nx: normal.x,
              ny: normal.y,
            });
            continue; // ось погашена: движущийся остаётся на старой координате
          }
        }

        x = nextX;
        y = nextY;
      }

      // Сенсоры (PHYS-12): объём — фактически исполненный ход тика, обе оси
      // после разрешения. Порядок событий: статика раньше динамики, динамика —
      // по порядку запроса (QUERY-2); одно событие на пару за тик — обход
      // каждого препятствия здесь единственный.
      //
      // ponytail: объём хода стоит трёх объектов на движущегося (две огибающие
      // и объединение), а каждое препятствие в обходе ниже — своей позиции и
      // своего коллайдера. Те же буферы, что и на шаге оси, снимают и это.
      if (hitMask !== 0) {
        const executed = union(boundsAt(from.x, from.y, collider), boundsAt(x, y, collider));
        // Пара «движущийся — статика» наблюдаема как ОДНА: сущности у статики
        // нет, и `other` у всех отрезков один и тот же (STATIC_COLLIDER). При
        // этом прямая стена мира — цепочка односкелеточных отрезков (TERR-5,
        // `ponytail` в `terrain.ts`: соседние не сливаются), и свип вдоль неё
        // задевает их пачкой. Событие на пару за тик по PHYS-12 ровно одно,
        // сколько бы звеньев ни попало в объём.
        if (this.physicsWorld.queryByLayer(executed, hitMask).length > 0) {
          ctx.events.emit('Overlap', { entity: mover, other: STATIC_COLLIDER });
        }
        for (const other of obstacles) {
          if (other === mover) continue;
          if ((ctx.get(other, this.colliderComponent, 'layer') & hitMask) === 0) continue;
          const position = positionOf(other);
          const otherCollider = colliderOf(ctx.get, other, this.colliderComponent);
          if (overlaps(executed, boundsAt(position.x, position.y, otherCollider))) {
            ctx.events.emit('Overlap', { entity: mover, other });
          }
        }
      }

      if (x !== from.x || y !== from.y) {
        resolved.set(mover, { x, y });
        ctx.commands.setField(mover, POSITION_COMPONENT, 'x', x);
        ctx.commands.setField(mover, POSITION_COMPONENT, 'y', y);
      }
    }
  }

  /**
   * Блокирующее препятствие по маске (PHYS-2), ближайшее к центру движущегося;
   * при равном расстоянии — первое по порядку обхода: статика раньше динамики,
   * динамика — по порядку запроса (QUERY-2). Найденное пишется в
   * `this.blocker` — нормаль события считается по его форме (PHYS-9).
   *
   * Ход гасит любой блокирующий, и выбор между ними наблюдаем только через
   * событие. Ближайший — тот, чья поверхность и дала контакт: прямая стена
   * мира собрана из соседних односкелеточных отрезков статики (TERR-5), и
   * «первый по индексу» брал бы нормаль у звена, до которого движущийся не
   * доехал, — по его внутреннему стыку, то есть ложную диагональ.
   */
  private nearestBlocker(
    ctx: SystemContext,
    move: Move,
    mover: EntityId,
    obstacles: Float64Array,
    resolved: ReadonlyMap<EntityId, Vec2>,
    blockMask: number,
    cliffRise: number,
  ): boolean {
    let bestDistanceSq = 0;
    let found = false;
    for (const s of this.physicsWorld.queryByLayer(move.swept, blockMask)) {
      if (!blocks(move, s)) continue;
      if (cliffGateOpen(move, s, cliffRise)) continue;
      const distanceSq = closestDistanceSq(s, move.centerX, move.centerY);
      if (found && distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      found = true;
      // Статика — всегда прямоугольник (обрыв — вырожденный в отрезок); центр
      // круга у неё не определён и обнуляется, чтобы не пережить чужую запись.
      this.blocker.other = STATIC_COLLIDER;
      this.blocker.shape = SHAPE_AABB;
      this.blocker.centerX = 0;
      this.blocker.centerY = 0;
      copyBounds(this.blocker.bounds, s);
    }
    for (const other of obstacles) {
      if (other === mover) continue;
      if ((ctx.get(other, this.colliderComponent, 'layer') & blockMask) === 0) continue;
      // Позиция читается без объекта-обёртки: уже разрешённый сосед отдаёт
      // свою (Command Buffer вливается только в конце системы), остальные —
      // живое поле мира.
      const position = resolved.get(other);
      const px = position?.x ?? ctx.get(other, POSITION_COMPONENT, 'x');
      const py = position?.y ?? ctx.get(other, POSITION_COMPONENT, 'y');
      colliderInto(ctx.get, other, this.colliderComponent, this.candidateCollider);
      boundsInto(this.candidateBounds, px, py, this.candidateCollider);
      if (!blocks(move, this.candidateBounds)) continue;
      const distanceSq = closestDistanceSq(this.candidateBounds, move.centerX, move.centerY);
      if (found && distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      found = true;
      this.blocker.other = other;
      this.blocker.shape = this.candidateCollider.shape;
      this.blocker.centerX = px;
      this.blocker.centerY = py;
      // Копия, а не ссылка: буфер кандидата перезапишет следующий претендент.
      copyBounds(this.blocker.bounds, this.candidateBounds);
    }
    return found;
  }
}

/** `other` в событии столкновения: сущности у статического коллайдера нет. */
export const STATIC_COLLIDER = -1;

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
      // Маска ФИЛЬТРУЕТ коллайдеры (PHYS-6): её отсутствие — пересечение по
      // всем, а не по коллайдерам какого-то одного тега. LoS свой тег называет
      // сам (`VisibilitySystem`), и подставленное умолчание молча сужало бы
      // луч, пущенный из выражения без маски (EXPR-8).
      const tag = rayOptions?.mask;
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
        // PHYS-13: ребро обрыва перекрывает луч направленно — вход с верхней
        // стороны свободен, и такое пересечение не засчитывается вовсе.
        if (cliffRayOpen(dir, s)) continue;
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
 * Коллайдеры с нужным тегом; без тега — все коллайдеры мира (PHYS-6). Порядок —
 * по индексу сущности (QUERY-2), поэтому и разрешение ничьей детерминировано.
 */
function queryColliders(world: WorldState, component: string, tag: string | undefined): Float64Array {
  return query(world, { all: [POSITION_COMPONENT, component], withTag: tag });
}

/**
 * Направленное перекрытие луча обрывом (PHYS-13): ребро с уровнями сторон
 * пропускает луч, входящий с верхней стороны, — обзор и полёт сверху вниз
 * свободны, зеркально духу гейта движения (PHYS-11), где спуск при активном
 * допуске свободен с любой высоты. Обычная статика без уровней и вход со
 * стороны нижнего (или равного — вырожденное ребро не даёт одностороннего
 * окна) уровня перекрывают луч как прежде.
 *
 * Ребро — осевой вырожденный прямоугольник (TERR-5), ось нормали — та, где
 * `min == max`; сторона входа — по знаку компоненты направления на этой оси:
 * положительная входит со стороны меньшей координаты (`levelNeg`),
 * отрицательная — со стороны `levelPos`. Нулевая компонента — луч вдоль самого
 * ребра, стороны входа у него нет: перекрытие сохраняется (консервативно; до
 * narrow-phase такой луч всё равно не доводит вырожденный слэб `rayVsBox`).
 *
 * Детерминизм не затронут: сравнение целых уровней, порядок перебора прежний.
 * На гейт движения (PHYS-11, `cliffGateOpen`) правило не переносится.
 */
function cliffRayOpen(dir: Vec2, s: StaticCollider): boolean {
  if (s.levelNeg === undefined || s.levelPos === undefined) return false;
  const direction = s.minX === s.maxX ? dir.x : dir.y;
  if (direction === 0) return false;
  return direction > 0 ? s.levelNeg > s.levelPos : s.levelPos > s.levelNeg;
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
 *
 * DET-2, условия 3 и 5: делимое `numerator · 2^16` по модулю не больше 2^47 —
 * строго меньше 2^53, поэтому приведённое частное совпадает с точным целым.
 *
 * Условие 4: **`floor` здесь — норма площадки, а не деталь реализации.** Это
 * единственное деление ядра, где конвенция округления наблюдаема в геймплее:
 * делимое и делитель бывают отрицательными по отдельности, и частное в
 * интервале `(-1, 0)` сырых единиц Q16.16 даёт `-1` при округлении к минус
 * бесконечности и `0` при усечении к нулю. Такое частное попадает в дальнюю
 * границу слэба, а сравнение `near > far` превращает `0 > -1` в промах и
 * `0 > 0` — в попадание: порт, выбравший усечение, отдал бы другой набор
 * попаданий (PHYS-7). Вторая реализация ядра ОБЯЗАНА округлять к минус
 * бесконечности (в Rust — `div_euclid` либо `(a / b).floor()`, но не `a / b`
 * целочисленным). Различающий тест — в `physics.test.ts`.
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
