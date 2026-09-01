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
import {
  blocks,
  boundsInto,
  cliffGateOpen,
  closestDistanceSq,
  copyBounds,
  overlaps,
  surfaceNormal,
  unionInto,
  SHAPE_AABB,
  type Blocker,
  type Bounds,
  type Move,
  type MutableCollider,
  type StaticCollider,
} from './collisionGeometry.js';
import {
  bandsMeet,
  effectiveLevel,
  COLLIDER_HEIGHT_FIELD,
  type LevelProbe,
  type PhysicsDeps,
} from './columnModel.js';
import {
  colliderByHandle,
  resolvePhysicsHandles,
  DEFAULT_COLLIDER_COMPONENT,
  DEFAULT_VELOCITY_COMPONENT,
  type PhysicsHandles,
  type PhysicsOptions,
} from './colliderRead.js';
import { PhysicsWorld } from './broadPhase.js';
import { countCostBroadPhase } from '../debug.js';
import { componentSchema } from '../ecs/world.js';
import {
  FIXED_ONE,
  POSITION_COMPONENT,
  type EntityId,
  type System,
  type SystemContext,
  type TerrainGrid,
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
export { createPhysicsApi } from './raycast.js';
export type { PhysicsOptions } from './colliderRead.js';

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
 * TimeScale (TIME-5): учитывает — система опт-ин (TIME-4), и шаг оси есть
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
   * Позиции препятствий на этот тик, параллельно массиву запроса — как
   * `levels`: скретчи переживают тики и перевыделяются только при росте сцены.
   * Ячейка уже разрешённого движущегося обновляется на месте, поэтому сосед
   * видит, куда его предшественник встал (Command Buffer вливается только в
   * конце системы), — прежде это делала карта «сущность → пара координат»,
   * заводимая каждый тик, с объектом-обёрткой на каждое чтение (снятый
   * ponytail: профиль npc-stress показал эти аллокации долей GC ~10% тика).
   */
  private obstacleX = new Int32Array(0);
  private obstacleY = new Int32Array(0);
  /**
   * Буферы шага оси: две огибающие, их объединение и сам `Move` жили объектами
   * на каждый шаг каждого движущегося — восемь аллокаций на движущегося за тик
   * (снятый ponytail, тот же профиль). Живут полями, как буферы кандидата;
   * `axis`/`step`/центр перезаписываются на каждом шаге, буферы огибающих
   * переиспользуются и заметаемым объёмом сенсорной проверки.
   */
  private readonly moveCurrent: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly moveNext: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly moveSwept: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly move = {
    current: this.moveCurrent, next: this.moveNext, swept: this.moveSwept,
    axis: 'x' as 'x' | 'y', step: 0, centerX: 0, centerY: 0,
  };
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
   * Разрешённая позиция движущегося: `resolveAxes` возвращает её полями, а не
   * парой координат в объекте, — объект на каждого движущегося за тик был бы
   * аллокацией, пропорциональной числу сущностей (дисциплина аллокаций).
   */
  private resolvedX = 0;
  private resolvedY = 0;
  /**
   * Полоса текущего движущегося (PHYS-14). Живёт полем по той же причине, что и
   * `blocker`: её читают обход препятствий и sensor-проверка, а лишний параметр
   * на каждом кандидате ничего не объясняет. Высота, не большая нуля, — полоса
   * не ограничена, и гейт для этого движущегося выключен целиком.
   */
  private moverLevel = 0;
  private moverHeight = 0;
  /** Разрешаются на первом входе, ПОСЛЕ раннего выхода (SYS-10). */
  private handles: PhysicsHandles | undefined;
  /** Коллайдер движущегося: тот же приём буфера, что у кандидата. */
  private readonly moverCollider: MutableCollider = {
    halfX: 0,
    halfY: 0,
    shape: SHAPE_AABB,
    radius: 0,
  };

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
    const h = (this.handles ??= resolvePhysicsHandles(ctx, this.colliderComponent, this.velocityComponent, this.heightGate));

    // Препятствия — все носители коллайдера: участие в блокировке и в сенсорах
    // решают маски на narrow-phase (PHYS-2), а не тег на запросе.
    const obstacles = ctx.query({ all: [POSITION_COMPONENT, this.colliderComponent] });
    this.cacheObstaclePositions(ctx, h, obstacles);
    this.cacheLevels(ctx, obstacles);

    // Движущиеся — подпоследовательность препятствий в том же порядке: оба
    // запроса обходят слоты по возрастанию raw-индекса (QUERY-2), а маска
    // движущихся строже на компонент скорости. Поэтому ячейка движущегося в
    // скретчах находится монотонным указателем, без поиска и без карты.
    let moverAt = 0;
    for (const mover of movers) {
      while (obstacles[moverAt] !== mover) moverAt++;
      this.resolveMover(ctx, h, mover, moverAt, obstacles);
      moverAt++;
    }
  }

  /**
   * Позиции препятствий — в скретчи, одно чтение на препятствие за тик.
   * `Position` внутри прогона системы неизменна (мутации идут через Command
   * Buffer и вливаются после неё, CMD-2), поэтому снимок на входе равен живому
   * чтению; уже разрешённые движущиеся обновляют свою ячейку на месте — сосед
   * обязан видеть, куда его предшественник уже встал.
   */
  private cacheObstaclePositions(ctx: SystemContext, h: PhysicsHandles, obstacles: Float64Array): void {
    if (this.obstacleX.length < obstacles.length) {
      this.obstacleX = new Int32Array(obstacles.length);
      this.obstacleY = new Int32Array(obstacles.length);
    }
    for (let index = 0; index < obstacles.length; index++) {
      const other = obstacles[index]!;
      this.obstacleX[index] = ctx.getByHandle(other, h.posX);
      this.obstacleY[index] = ctx.getByHandle(other, h.posY);
    }
  }

  /** Ход одного движущегося: полоса, разрешение осей, сенсоры и запись позиции. */
  private resolveMover(
    ctx: SystemContext,
    h: PhysicsHandles,
    mover: EntityId,
    moverAt: number,
    obstacles: Float64Array,
  ): void {
    const collider = this.moverCollider;
    colliderByHandle(ctx, mover, h, collider);
    const blockMask = ctx.getByHandle(mover, h.blockMask);
    const hitMask = ctx.getByHandle(mover, h.hitMask);
    const cliffRise = ctx.getByHandle(mover, h.cliffRise);
    // Множитель шага — один на сущность и тик (TIME-3): обе оси одного хода
    // обязаны замедляться одинаково.
    const scale = ctx.getEffectiveDelta(mover, FIXED_ONE);
    const fromX = this.obstacleX[moverAt]!;
    const fromY = this.obstacleY[moverAt]!;

    // Полоса движущегося для БЛОКИРОВКИ (PHYS-8, PHYS-9) — одна оценка на
    // тик, по состоянию до хода: обе оси видят один уровень, и промежуточных
    // уровней вдоль пути не возникает (PHYS-14).
    //
    // Пустая маска блокировки уровня не спрашивает вовсе: до `nearestBlocker`
    // такой ход не доходит (ниже), а полосу заметаемого объёма сенсорная
    // проверка всё равно считает заново — по разрешённому состоянию. Сквозной
    // снаряд (`blockMask = 0`, `hitMask ≠ 0`) — ровно тот случай, ради
    // которого писался гейт, и мёртвого `levelAt` на тик он платить не должен.
    this.moverHeight = h.height === undefined ? 0 : ctx.getByHandle(mover, h.height);
    this.moverLevel =
      this.moverHeight > 0 && blockMask !== 0
        ? effectiveLevel(ctx, this.probe, mover, fromX, fromY)
        : 0;

    this.resolveAxes(ctx, h, mover, collider, obstacles, blockMask, cliffRise, scale, fromX, fromY);
    const x = this.resolvedX;
    const y = this.resolvedY;

    // Сенсоры (PHYS-12): объём — фактически исполненный ход тика, обе оси
    // после разрешения. Порядок событий: статика раньше динамики, динамика —
    // по порядку запроса (QUERY-2); одно событие на пару за тик — обход
    // каждого препятствия здесь единственный. Объём хода собирается в тех же
    // буферах, что шаг оси, — к этому моменту они свободны.
    if (hitMask !== 0) {
      this.emitOverlaps(ctx, h, mover, collider, obstacles, hitMask, fromX, fromY, x, y);
    }

    if (x !== fromX || y !== fromY) {
      this.obstacleX[moverAt] = x;
      this.obstacleY[moverAt] = y;
      ctx.commands.setField(mover, POSITION_COMPONENT, 'x', x);
      ctx.commands.setField(mover, POSITION_COMPONENT, 'y', y);
    }
  }

  /**
   * Разрешение хода по осям — сначала X, затем Y (PHYS-8). Заблокированная ось
   * гасится (движущийся остаётся на старой координате), свободная исполняется.
   *
   * Результат возвращается полями `resolvedX`/`resolvedY`, а не парой координат
   * в объекте: объект на каждого движущегося за тик был бы аллокацией,
   * пропорциональной числу сущностей (дисциплина аллокаций).
   */
  private resolveAxes(
    ctx: SystemContext,
    h: PhysicsHandles,
    mover: EntityId,
    collider: MutableCollider,
    obstacles: Float64Array,
    blockMask: number,
    cliffRise: number,
    scale: number,
    fromX: number,
    fromY: number,
  ): void {
    let x = fromX;
    let y = fromY;
    const stepX = fixed.mul(ctx.getByHandle(mover, h.velocityX), scale);
    if (stepX !== 0 && !this.axisBlocked(ctx, h, mover, collider, obstacles, blockMask, cliffRise, 'x', stepX, x, y)) {
      x = fixed.add(x, stepX);
    }
    const stepY = fixed.mul(ctx.getByHandle(mover, h.velocityY), scale);
    if (stepY !== 0 && !this.axisBlocked(ctx, h, mover, collider, obstacles, blockMask, cliffRise, 'y', stepY, x, y)) {
      y = fixed.add(y, stepY);
    }
    this.resolvedX = x;
    this.resolvedY = y;
  }

  /**
   * Гасит ли шаг оси препятствие. Тест — свёрнутый (swept) AABB от старой
   * позиции к новой; при блокировке эмитится `Collision` с нормалью поверхности
   * (PHYS-9).
   *
   * Пустая маска блокировки не порождает ни огибающих, ни поиска: сквозной
   * снаряд проходит ось, не заплатив за narrow-phase (PHYS-2). Огибающие,
   * объединение и `Move` — буферы системы, а не объекты на шаг оси.
   */
  private axisBlocked(
    ctx: SystemContext,
    h: PhysicsHandles,
    mover: EntityId,
    collider: MutableCollider,
    obstacles: Float64Array,
    blockMask: number,
    cliffRise: number,
    axis: 'x' | 'y',
    step: number,
    x: number,
    y: number,
  ): boolean {
    if (blockMask === 0) return false;
    const move = this.move;
    boundsInto(this.moveCurrent, x, y, collider);
    boundsInto(this.moveNext, axis === 'x' ? fixed.add(x, step) : x, axis === 'y' ? fixed.add(y, step) : y, collider);
    unionInto(this.moveSwept, this.moveCurrent, this.moveNext);
    move.axis = axis;
    move.step = step;
    move.centerX = x;
    move.centerY = y;
    if (!this.nearestBlocker(ctx, h, move, mover, obstacles, blockMask, cliffRise)) return false;
    // Нормаль поверхности в точке контакта (PHYS-9); осевая против движения —
    // её фолбэк и полный ответ для пары прямоугольников. Политике (отскок,
    // кнокбэк, урон о стену) нужна сторона удара, а не факт остановки.
    const normal = surfaceNormal(move, collider.shape, this.blocker);
    ctx.events.emit(COLLISION_EVENT, {
      entity: mover,
      other: this.blocker.other,
      nx: normal.x,
      ny: normal.y,
    });
    return true;
  }

  /** Sensor-пересечения по фактически исполненному ходу тика (PHYS-12). */
  private emitOverlaps(
    ctx: SystemContext,
    h: PhysicsHandles,
    mover: EntityId,
    collider: MutableCollider,
    obstacles: Float64Array,
    hitMask: number,
    fromX: number,
    fromY: number,
    x: number,
    y: number,
  ): void {
    // Полоса движущегося для заметаемого объёма (PHYS-14) — ОДНА оценка за
    // тик, по разрешённому состоянию: позиция после разрешения обеих осей.
    // Промежуточных уровней вдоль пути не считается вовсе — одна оценка
    // детерминированна и не зависит от порядка разрешения осей.
    if (this.moverHeight > 0) {
      this.moverLevel = effectiveLevel(ctx, this.probe, mover, x, y);
    }
    boundsInto(this.moveCurrent, fromX, fromY, collider);
    boundsInto(this.moveNext, x, y, collider);
    unionInto(this.moveSwept, this.moveCurrent, this.moveNext);
    const executed = this.moveSwept;
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
      if (!this.candidatePasses(ctx, h, other, index, hitMask)) continue;
      if (overlaps(executed, this.candidateBounds)) {
        ctx.events.emit(OVERLAP_EVENT, { entity: mover, other });
      }
    }
    countCostBroadPhase(pairs);
  }

  /**
   * Проходит ли препятствие оба условия пары — и заполняет буферы кандидата.
   *
   * Условий два, и они независимы: маска выражает отношение слоёв (PHYS-2),
   * полоса — совместность по высоте (PHYS-14). Обход блокировки и обход
   * сенсоров задают их одинаково и в одном порядке, поэтому проверка живёт в
   * одном месте: разъехавшись, они дали бы паре разный ответ в блокировке и в
   * сенсоре — расхождение, которого спека не знает.
   */
  private candidatePasses(
    ctx: SystemContext,
    h: PhysicsHandles,
    other: EntityId,
    index: number,
    mask: number,
  ): boolean {
    if ((ctx.getByHandle(other, h.layer) & mask) === 0) return false;
    if (!this.bandsMeetWithMover(ctx, h, other, index)) return false;
    colliderByHandle(ctx, other, h, this.candidateCollider);
    boundsInto(this.candidateBounds, this.obstacleX[index]!, this.obstacleY[index]!, this.candidateCollider);
    return true;
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
    h: PhysicsHandles,
    move: Move,
    mover: EntityId,
    obstacles: Float64Array,
    blockMask: number,
    cliffRise: number,
  ): boolean {
    let bestDistanceSq = this.nearestStaticBlocker(move, blockMask, cliffRise);
    let found = bestDistanceSq >= 0;
    // Кандидаты динамики — тот же объём работы broad-phase, что и кандидаты,
    // осмотренные обходом клеток внутри `queryByLayer` выше (PERF-3): счёт идёт
    // в локальную переменную, наружу уходит одной суммой на шаг оси. Кандидат,
    // отсеянный маской, из счёта не выпадает — его осмотр уже состоялся.
    let pairs = 0;
    for (let index = 0; index < obstacles.length; index++) {
      const other = obstacles[index]!;
      if (other === mover) continue;
      pairs++;
      // Маска и колоночный гейт (PHYS-2, PHYS-14) — там же, где у сенсоров, и
      // буферы кандидата заполняет тот же вызов. Позиция берётся из скретча
      // препятствий: уже разрешённый сосед лежит там обновлённым (Command
      // Buffer вливается только в конце системы), остальные — снимком входа,
      // равным живому полю мира.
      if (!this.candidatePasses(ctx, h, other, index, blockMask)) continue;
      if (!blocks(move, this.candidateBounds)) continue;
      const distanceSq = closestDistanceSq(this.candidateBounds, move.centerX, move.centerY);
      if (found && distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      found = true;
      this.blocker.other = other;
      this.blocker.shape = this.candidateCollider.shape;
      this.blocker.centerX = this.obstacleX[index]!;
      this.blocker.centerY = this.obstacleY[index]!;
      // Копия, а не ссылка: буфер кандидата перезапишет следующий претендент.
      copyBounds(this.blocker.bounds, this.candidateBounds);
    }
    countCostBroadPhase(pairs);
    return found;
  }

  /**
   * Ближайший блокирующий отрезок статики; `-1` — не найдено ни одного
   * (квадрат расстояния неотрицателен, и отдельный флаг не нужен). Найденное
   * пишется в `this.blocker`.
   */
  private nearestStaticBlocker(move: Move, blockMask: number, cliffRise: number): number {
    let bestDistanceSq = -1;
    for (const s of this.physicsWorld.queryByLayer(move.swept, blockMask)) {
      if (!blocks(move, s)) continue;
      if (cliffGateOpen(move, s, cliffRise)) continue;
      const distanceSq = closestDistanceSq(s, move.centerX, move.centerY);
      if (bestDistanceSq >= 0 && distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      // Статика — всегда прямоугольник (обрыв — вырожденный в отрезок); центр
      // круга у неё не определён и обнуляется, чтобы не пережить чужую запись.
      this.blocker.other = STATIC_COLLIDER;
      this.blocker.shape = SHAPE_AABB;
      this.blocker.centerX = 0;
      this.blocker.centerY = 0;
      copyBounds(this.blocker.bounds, s);
    }
    return bestDistanceSq;
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
    // при росте, а не на каждом тике (дисциплина аллокаций). Позиции — из
    // скретчей препятствий, заполненных к этому моменту состоянием ДО
    // разрешения: обход движущихся ещё не начался.
    if (this.levels.length < obstacles.length) this.levels = new Int32Array(obstacles.length);
    for (let index = 0; index < obstacles.length; index++) {
      this.levels[index] = effectiveLevel(ctx, this.probe, obstacles[index]!, this.obstacleX[index]!, this.obstacleY[index]!);
    }
  }

  /**
   * Пересекается ли полоса текущего движущегося с полосой препятствия (PHYS-14).
   * Полоса движущегося не ограничена — пара проходит, и поля высоты препятствия
   * не читается вовсе: при выключенном гейте его в схеме нет.
   */
  private bandsMeetWithMover(
    ctx: SystemContext,
    h: PhysicsHandles,
    other: EntityId,
    index: number,
  ): boolean {
    if (this.moverHeight <= 0 || h.height === undefined) return true;
    const height = ctx.getByHandle(other, h.height);
    return bandsMeet(this.moverLevel, this.moverHeight, this.levels[index]!, height);
  }
}

/** `other` в событии столкновения: сущности у статического коллайдера нет. */
export const STATIC_COLLIDER = -1;
