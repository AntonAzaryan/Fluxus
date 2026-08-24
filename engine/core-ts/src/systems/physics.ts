/**
 * Физика (PHYS-1..14): примитивные коллайдеры, статика обрывов, разрешение
 * движения по маскам слоёв, sensor-пересечения и детерминированный raycast.
 *
 * Всё считается в 2D-проекции и в Q16.16 (PHYS-1, PHYS-3). Третьей координаты
 * не появляется и здесь: перепад высот входит в физику статическими
 * коллайдерами обрывов (`terrain` TERR-5), а участие пары в пересечении
 * дополнительно гейтуется колоночной моделью (PHYS-14) — отрезком ДИСКРЕТНЫХ
 * уровней террейна, а не непрерывным z.
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
  rayVsBox,
  rayVsCircle,
} from './collisionGeometry.js';
import {
  bandsMeet,
  effectiveLevel,
  COLLIDER_HEIGHT_FIELD,
  type LevelProbe,
  type LevelSource,
  type PhysicsDeps,
} from './columnModel.js';
import { PhysicsWorld } from './broadPhase.js';
import { countCostBroadPhase, countCostRaycast } from '../debug.js';
import { componentSchema, getField, hasComponent } from '../ecs/world.js';
import { query } from '../ecs/query.js';
import {
  FIXED_ONE,
  POSITION_COMPONENT,
  type EntityId,
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
 * Broad-phase (PHYS-5) и колоночная модель (PHYS-14) вынесены в собственные
 * модули — сетка по статике не знает ни ECS, ни террейна, а правило полос не
 * знает ни форм, ни свипов. Наружу они выходят отсюда: адрес физики один, и
 * потребителю незачем знать, на сколько файлов она разложена внутри.
 */
export { PhysicsWorld } from './broadPhase.js';
export { COLLIDER_HEIGHT_FIELD } from './columnModel.js';
export type { PhysicsDeps } from './columnModel.js';

/**
 * Теги блокировки: обычные теги сущности (ECS), у статики — её собственные.
 * Обзором управляет тег `blocksVision` (PHYS-2); участие в разрешении движения
 * тегом больше не выражается — его задают маски `layer`/`blockMask`, и тег
 * `blocksMovement` остаётся только меткой на статике обрывов (TERR-5).
 */
export const BLOCKS_MOVEMENT = 'blocksMovement';
export const BLOCKS_VISION = 'blocksVision';

/**
 * События физики (PHYS-9, PHYS-12): тип → имена полей его данных.
 *
 * Перечень здесь, а не у потребителя, потому что эти события эмитит МЕХАНИЗМ, а
 * не сцена действием `emitEvent`: обходом документа игры их не найти, и список,
 * переписанный рядом с игрой, пережил бы переименование молча — ровно тот отказ,
 * который читатель журнала боя (DIAG-10) увидит как пропавший факт.
 */
export const PHYSICS_EVENTS = {
  Collision: ['entity', 'other', 'nx', 'ny'],
  Overlap: ['entity', 'other'],
} as const;

/** Имена типов берутся у перечня: переименование мимо него не компилируется. */
const COLLISION_EVENT: keyof typeof PHYSICS_EVENTS = 'Collision';
const OVERLAP_EVENT: keyof typeof PHYSICS_EVENTS = 'Overlap';

/** Обрыв блокирует и движение, и обзор (TERR-5); массив общий на все отрезки. */
const CLIFF_TAGS: readonly string[] = [BLOCKS_MOVEMENT, BLOCKS_VISION];

/**
 * Слой статики обрывов по умолчанию. Значение — параметр сборки, а не
 * конвенция ядра (PHYS-2): загрузчик сцены вправе передать свой.
 */
export const DEFAULT_CLIFF_LAYER = 1;

const DEFAULT_COLLIDER_COMPONENT = 'Collider';
const DEFAULT_VELOCITY_COMPONENT = 'Velocity';
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

// ------------------------------------------------ колоночная модель (PHYS-14)

/**
 * Объявила ли сцена поле высоты у своего компонента коллайдера (PHYS-14).
 * Спрашивается ОДИН раз, на сборке: состав полей компонента неизменен, а ответ
 * — зависимость сборки физики. Тот же приём, что у `inputTargetDeclared`
 * (TICK-4): системе мир на конструировании не передают, и спрашивать схему на
 * каждом тике незачем.
 *
 * Умолчание «поля нет — гейта нет» нормативно (PHYS-14): контент, не знающий о
 * высотах, от появления гейта не меняется вовсе — ни поведением, ни стоимостью
 * тика.
 */
export function colliderHeightDeclared(
  world: WorldState,
  component: string = DEFAULT_COLLIDER_COMPONENT,
): boolean {
  return componentSchema(world, component)?.fields[COLLIDER_HEIGHT_FIELD] !== undefined;
}

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
 * Вторым и НЕЗАВИСИМЫМ от масок условием пары идёт колоночный гейт (PHYS-14):
 * полосы дискретных уровней участников обязаны иметь общий уровень. Полоса
 * берётся только у сущностей — статика обрывов её не получает, её высотная
 * семантика уже в PHYS-11 и PHYS-13.
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
  /** Объявила ли сцена поле высоты коллайдера (PHYS-14) — ответ сборки, не вопрос тика. */
  private readonly heightGate: boolean;
  /**
   * Эффективные уровни препятствий на этот тик (PHYS-14), параллельно массиву
   * запроса. Скретч переживает тики и перевыделяется только при РОСТЕ сцены:
   * оценка уровня — одна на препятствие за тик, и без общего буфера она стоила
   * бы карты или пары объектов на каждого.
   */
  private levels = new Int32Array(0);
  /** Точка запроса `levelAt`: одна на систему, а не одна на вызов. */
  private readonly probe: LevelProbe = { x: 0, y: 0 };
  /**
   * Полоса текущего движущегося (PHYS-14). Живёт полем по той же причине, что и
   * `blocker`: её читают обход препятствий и sensor-проверка, а лишний параметр
   * на каждом кандидате ничего не объясняет. Высота, не большая нуля, — полоса
   * не ограничена, и гейт для этого движущегося выключен целиком.
   */
  private moverLevel = 0;
  private moverHeight = 0;

  constructor(physicsWorld: PhysicsWorld, options: PhysicsOptions = {}, deps: PhysicsDeps = {}) {
    this.physicsWorld = physicsWorld;
    this.colliderComponent = options.collider ?? DEFAULT_COLLIDER_COMPONENT;
    this.velocityComponent = options.velocity ?? DEFAULT_VELOCITY_COMPONENT;
    this.heightGate = deps.height === true;
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

    this.cacheLevels(ctx, obstacles);

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

      // Полоса движущегося для БЛОКИРОВКИ (PHYS-8, PHYS-9) — одна оценка на
      // тик, по состоянию до хода: обе оси видят один уровень, и промежуточных
      // уровней вдоль пути не возникает (PHYS-14).
      //
      // Пустая маска блокировки уровня не спрашивает вовсе: до `nearestBlocker`
      // такой ход не доходит (ниже), а полосу заметаемого объёма сенсорная
      // проверка всё равно считает заново — по разрешённому состоянию. Сквозной
      // снаряд (`blockMask = 0`, `hitMask ≠ 0`) — ровно тот случай, ради
      // которого писался гейт, и мёртвого `levelAt` на тик он платить не должен.
      this.moverHeight = this.heightGate
        ? ctx.get(mover, this.colliderComponent, COLLIDER_HEIGHT_FIELD)
        : 0;
      this.moverLevel =
        this.moverHeight > 0 && blockMask !== 0
          ? effectiveLevel(ctx, this.probe, mover, from.x, from.y)
          : 0;

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
            ctx.events.emit(COLLISION_EVENT, {
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
        // Полоса движущегося для заметаемого объёма (PHYS-14) — ОДНА оценка за
        // тик, по разрешённому состоянию: позиция после разрешения обеих осей.
        // Промежуточных уровней вдоль пути не считается вовсе — одна оценка
        // детерминированна и не зависит от порядка разрешения осей.
        if (this.moverHeight > 0) {
          this.moverLevel = effectiveLevel(ctx, this.probe, mover, x, y);
        }
        const executed = union(boundsAt(from.x, from.y, collider), boundsAt(x, y, collider));
        // Пара «движущийся — статика» наблюдаема как ОДНА: сущности у статики
        // нет, и `other` у всех отрезков один и тот же (STATIC_COLLIDER). При
        // этом прямая стена мира — цепочка односкелеточных отрезков (TERR-5,
        // `ponytail` в `terrain.ts`: соседние не сливаются), и свип вдоль неё
        // задевает их пачкой. Событие на пару за тик по PHYS-12 ровно одно,
        // сколько бы звеньев ни попало в объём.
        if (this.physicsWorld.queryByLayer(executed, hitMask).length > 0) {
          ctx.events.emit(OVERLAP_EVENT, { entity: mover, other: STATIC_COLLIDER });
        }
        // Динамика индекса не имеет, и её обход — тот же объём работы
        // broad-phase, что и обход клеток у статики (PERF-3). Считается в
        // локальную переменную, а сумма уходит наружу один раз на движущегося:
        // в цикле — ровно одно целочисленное сложение. Кандидат, отсеянный
        // маской, тоже кандидат: работа по его осмотру уже сделана.
        let pairs = 0;
        for (let index = 0; index < obstacles.length; index++) {
          const other = obstacles[index]!;
          if (other === mover) continue;
          pairs++;
          if ((ctx.get(other, this.colliderComponent, 'layer') & hitMask) === 0) continue;
          // Колоночный гейт (PHYS-14) — второе условие рядом с маской, и оно
          // независимо от неё: маска выражает отношение слоёв, полоса —
          // совместность по высоте.
          if (!this.bandsMeetWithMover(ctx, other, index)) continue;
          const position = positionOf(other);
          const otherCollider = colliderOf(ctx.get, other, this.colliderComponent);
          if (overlaps(executed, boundsAt(position.x, position.y, otherCollider))) {
            ctx.events.emit(OVERLAP_EVENT, { entity: mover, other });
          }
        }
        countCostBroadPhase(pairs);
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
    // Кандидаты динамики — тот же объём работы broad-phase, что и кандидаты,
    // осмотренные обходом клеток внутри `queryByLayer` выше (PERF-3): счёт идёт
    // в локальную переменную, наружу уходит одной суммой на шаг оси. Кандидат,
    // отсеянный маской, из счёта не выпадает — его осмотр уже состоялся.
    let pairs = 0;
    for (let index = 0; index < obstacles.length; index++) {
      const other = obstacles[index]!;
      if (other === mover) continue;
      pairs++;
      if ((ctx.get(other, this.colliderComponent, 'layer') & blockMask) === 0) continue;
      // Колоночный гейт (PHYS-14) — второе условие рядом с маской: пара без
      // общего уровня хода не блокирует и события `Collision` не даёт.
      if (!this.bandsMeetWithMover(ctx, other, index)) continue;
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
    countCostBroadPhase(pairs);
    return found;
  }

  /**
   * Эффективные уровни препятствий на этот тик (PHYS-14): одна оценка на
   * препятствие, по состоянию ДО разрешения. Оценивать уровень соседа по его
   * уже разрешённой позиции значило бы поставить полосу в зависимость от того,
   * успел ли сосед пройти разрешение раньше, — то есть от порядка обхода.
   *
   * Гейт выключен (поля высоты в схеме нет) — цикла нет вовсе: сцена, не
   * знающая о высотах, не платит за колоночную модель ничем.
   */
  private cacheLevels(ctx: SystemContext, obstacles: Float64Array): void {
    if (!this.heightGate) return;
    // Скретч растёт вместе со сценой и переживает тики: перевыделение — только
    // при росте, а не на каждом тике (дисциплина аллокаций).
    if (this.levels.length < obstacles.length) this.levels = new Int32Array(obstacles.length);
    for (let index = 0; index < obstacles.length; index++) {
      const other = obstacles[index]!;
      this.levels[index] = effectiveLevel(
        ctx,
        this.probe,
        other,
        ctx.get(other, POSITION_COMPONENT, 'x'),
        ctx.get(other, POSITION_COMPONENT, 'y'),
      );
    }
  }

  /**
   * Пересекается ли полоса текущего движущегося с полосой препятствия (PHYS-14).
   * Полоса движущегося не ограничена — пара проходит, и поля высоты препятствия
   * не читается вовсе: при выключенном гейте его в схеме нет.
   */
  private bandsMeetWithMover(ctx: SystemContext, other: EntityId, index: number): boolean {
    if (this.moverHeight <= 0) return true;
    const height = ctx.get(other, this.colliderComponent, COLLIDER_HEIGHT_FIELD);
    return bandsMeet(this.moverLevel, this.moverHeight, this.levels[index]!, height);
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

      let best: number | undefined;
      let bestEntity: EntityId | undefined;

      const rayBounds: Bounds = {
        minX: Math.min(from.x, to.x),
        minY: Math.min(from.y, to.y),
        maxX: Math.max(from.x, to.x),
        maxY: Math.max(from.y, to.y),
      };

      for (const s of physicsWorld.query(rayBounds, tag)) {
        // PHYS-13: ребро, чей верхний уровень не выше уровня луча, прозрачно —
        // пересечение не засчитывается вовсе.
        if (cliffRayOpen(elevation, s)) continue;
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
        // Колоночный гейт луча (PHYS-14): попадание засчитывается, только если
        // полоса коллайдера содержит уровень испускателя. Луч БЕЗ уровня
        // пересекает коллайдер любой полосы — то же консервативное умолчание,
        // что у обрывов в PHYS-13. Статика через этот гейт не проходит: полосы
        // у неё нет, её высотную семантику несут PHYS-11 и PHYS-13.
        if (heightGate && elevation !== undefined) {
          const height = read(entity, colliderComponent, COLLIDER_HEIGHT_FIELD);
          const level = height > 0 ? effectiveLevel(levels, probe, entity, x, y) : 0;
          if (!bandsMeet(level, height, elevation, 1)) continue;
        }
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
