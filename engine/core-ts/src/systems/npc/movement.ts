/**
 * Движение NPC (`npc-behavior` NPC-6) — ГЕЙМПЛЕЙНАЯ ПОЛИТИКА над навигационным
 * швом (NAV-4): система хранит прогресс в своих компонентах и пишет скорость
 * через Command Buffer. Ядро никого по пути не водит, компонента пути и поля
 * «идти сюда» у него нет.
 *
 * Поиска пути здесь не происходит вовсе: маршрут волны — waypoint-данные сцены,
 * а сближение с целью — прямой seek. Сцена без Navigation API тикает с NPC
 * штатно (DI-4, NAV-6). Когда за `NavigationApi` появится реализация, seek
 * сменится на `findPath` — без правки документа поведения и маршрутов сцены,
 * потому что ни то ни другое о способе движения не говорит.
 *
 * Локальное расхождение — по соседям СЕТКИ (`grid.ts`): полного перебора пар
 * агентов нет, и стоимость шага растёт числом соседей, а не квадратом числа
 * агентов (NPC-6).
 *
 * Исполнение решения идёт КАЖДЫЙ тик независимо от каденса пересмотра (NPC-4):
 * решение выбирает `behavior.ts` по своим окнам, а движется агент постоянно.
 *
 * Направления считаются в ПОЛЯХ системы, а не возвращаются векторами: литерал
 * `{ x, y }` на каждого агента (и на каждого его соседа) был бы аллокацией,
 * пропорциональной числу сущностей.
 */
import { add, distSqLe, div, mul, sub } from '../../math/fixed.js';
import { lengthOf } from '../../math/vector.js';
import { NpcGrid } from './grid.js';
import { NpcRoutes } from './routes.js';
import { isDead, livingAgents, posX, posY } from './runtime.js';
import { NPC_ACTION_NONE, NPC_AGENT_COMPONENT, NPC_ROUTE_COMPONENT } from './components.js';
import { EXEC_FOLLOW_ROUTE, EXEC_SEEK_TARGET, type CompiledBehavior, type NpcCatalog } from './model.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type EntityId,
  type Fixed,
  type QuerySpec,
  type System,
  type SystemContext,
} from '../../types.js';

/** Место в шкале `order` и его основание — таблица DET-9; параметром сборки не является. */
const ANCHOR_ORDER = 70;

/** Размер клетки сетки расхождения — тот же, что у сетки восприятия. */
const CELL_SIZE = 2 << 16;

/** Предел соседей расхождения на агента — тот же осознанный потолок, что в восприятии. */
const NEIGHBOR_LIMIT = 16;

/**
 * Предел ОСМОТРА одного запроса расхождения (NPC-6) — см. `perception.ts`.
 * Меньше, чем у восприятия, и это не экономия: радиус расхождения — единицы
 * мировых единиц против десятков у радиуса чувства, и развёртка его колец на
 * порядок короче.
 */
const EXAMINE_LIMIT = 128;

/**
 * Ниже этого расстояния соседи считаются СОВПАВШИМИ. Порог не косметический:
 * вклад соседа обратен расстоянию, и на дистанции в единицу Q16.16 обратная
 * величина вылетела бы за i32 (FP-1). Одна двести пятьдесят шестая мировой
 * единицы — заведомо меньше любого коллайдера и заведомо больше этой границы.
 */
const COINCIDENT = FIXED_ONE >> 8;

export class NpcMovementSystem implements System {
  readonly name = 'NpcMovement';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: NpcCatalog;
  private readonly routes = new NpcRoutes();
  private readonly grid = new NpcGrid(CELL_SIZE);
  private readonly scratch = new Int32Array(NEIGHBOR_LIMIT);
  private readonly spec: QuerySpec;
  /** Направление шага текущего агента: единичный вектор либо ноль. */
  private dirX: Fixed = 0;
  private dirY: Fixed = 0;

  constructor(catalog: NpcCatalog) {
    this.catalog = catalog;
    // Мёртвый агент не двигается (NPC-1): скорость ему в последний раз пишет
    // сцена, и переписывать её каждый тик значило бы водить тело по арене.
    // Выборка живых — общая функция платформы, а не своя копия условия.
    const living = livingAgents(catalog);
    this.spec = {
      all: [...living.all, catalog.bindings.position, catalog.bindings.velocity],
      ...(living.not === undefined ? {} : { not: living.not }),
    };
  }

  run(ctx: SystemContext): void {
    const agents = ctx.query(this.spec);
    if (agents.length === 0) return;
    const bindings = this.catalog.bindings;
    this.routes.rebuild(ctx, bindings.position);
    this.grid.begin(agents.length);
    for (let slot = 0; slot < agents.length; slot++) {
      const entity = agents[slot]!;
      this.grid.add(slot, posX(ctx, bindings, entity), posY(ctx, bindings, entity));
    }

    for (let slot = 0; slot < agents.length; slot++) {
      const entity = agents[slot]!;
      const behavior = this.catalog.behaviors[ctx.get(entity, NPC_AGENT_COMPONENT, 'behavior')];
      if (behavior === undefined) continue;
      this.desired(ctx, behavior, entity);
      let vx = mul(this.dirX, behavior.speed);
      let vy = mul(this.dirY, behavior.speed);
      this.separation(behavior, slot);
      const push = mul(behavior.speed, behavior.separationWeight);
      vx = add(vx, mul(this.dirX, push));
      vy = add(vy, mul(this.dirY, push));
      ctx.commands.setField(entity, bindings.velocity, 'x', vx);
      ctx.commands.setField(entity, bindings.velocity, 'y', vy);
    }
  }

  /** Единичное направление в `dirX`/`dirY`; нулевой вектор остаётся нулевым. */
  private normalize(x: Fixed, y: Fixed): void {
    const length = lengthOf(x, y);
    if (length === 0) {
      this.dirX = 0;
      this.dirY = 0;
      return;
    }
    this.dirX = div(x, length);
    this.dirY = div(y, length);
  }

  /** Направление движения принятого решения (NPC-4). */
  private desired(ctx: SystemContext, behavior: CompiledBehavior, entity: EntityId): void {
    this.dirX = 0;
    this.dirY = 0;
    const action = ctx.get(entity, NPC_AGENT_COMPONENT, 'action');
    if (action === NPC_ACTION_NONE) return;
    const state = behavior.states[ctx.get(entity, NPC_AGENT_COMPONENT, 'state')];
    const executor = state?.actions[action]?.executor;
    if (executor === EXEC_FOLLOW_ROUTE) this.followRoute(ctx, behavior, entity);
    else if (executor === EXEC_SEEK_TARGET) this.seekTarget(ctx, behavior, entity);
    // `hold` и `cast` стоят на месте: идущий каст двигать себя не должен, а
    // «атака в контакте» — это остановка, а не отдельный исполнитель.
  }

  /**
   * Следование маршруту (NPC-6): seek к текущей точке, переход к следующей по
   * достижении. Прогресс живёт в компоненте агента, то есть снапшотится и
   * откатывается вместе с миром (SNAP-1).
   */
  private followRoute(ctx: SystemContext, behavior: CompiledBehavior, entity: EntityId): void {
    if (!ctx.has(entity, NPC_ROUTE_COMPONENT)) return;
    const bindings = this.catalog.bindings;
    const route = ctx.get(entity, NPC_ROUTE_COMPONENT, 'route');
    let index = ctx.get(entity, NPC_ROUTE_COMPONENT, 'index');
    let point = this.routes.at(route, index);
    if (point === NO_ENTITY) return;
    const x = posX(ctx, bindings, entity);
    const y = posY(ctx, bindings, entity);
    if (distSqLe(posX(ctx, bindings, point) - x, posY(ctx, bindings, point) - y, behavior.arrive)) {
      index += 1;
      ctx.commands.setField(entity, NPC_ROUTE_COMPONENT, 'index', index);
      point = this.routes.at(route, index);
      if (point === NO_ENTITY) return;
    }
    this.normalize(posX(ctx, bindings, point) - x, posY(ctx, bindings, point) - y);
  }

  /** Сближение с целью; в пределах дистанции контакта агент стоит (NPC-4). */
  private seekTarget(ctx: SystemContext, behavior: CompiledBehavior, entity: EntityId): void {
    const bindings = this.catalog.bindings;
    const target = ctx.get(entity, NPC_AGENT_COMPONENT, 'target');
    if (target === NO_ENTITY || !ctx.isAlive(target) || isDead(ctx, bindings, target)) return;
    const dx = posX(ctx, bindings, target) - posX(ctx, bindings, entity);
    const dy = posY(ctx, bindings, target) - posY(ctx, bindings, entity);
    if (distSqLe(dx, dy, behavior.attack)) return;
    this.normalize(dx, dy);
  }

  /**
   * Локальное расхождение по соседям сетки (NPC-6): чем ближе сосед, тем
   * сильнее отталкивание. Результат — единичный вектор в `dirX`/`dirY` либо
   * ноль; на скорость его переводит вызывающий весом документа.
   *
   * Вклад соседа считается ОДНИМ корнем: `d/|d| · (1 − |d|/R)` равно
   * `d · (1/|d| − 1/R)`, поэтому нормировать вектор отдельно не нужно — а корень
   * в Q16.16 стоит двоичного поиска, и на каждого соседа каждого агента их было
   * бы вдвое больше нужного.
   */
  private separation(behavior: CompiledBehavior, slot: number): void {
    this.dirX = 0;
    this.dirY = 0;
    if (behavior.separation <= 0 || behavior.separationWeight <= 0) return;
    const x = this.grid.xAt(slot);
    const y = this.grid.yAt(slot);
    const found = this.grid.neighbors(slot, x, y, behavior.separation, this.scratch, EXAMINE_LIMIT);
    const reach = div(FIXED_ONE, behavior.separation);
    let sumX: Fixed = 0;
    let sumY: Fixed = 0;
    for (let i = 0; i < found; i++) {
      const other = this.scratch[i]!;
      const dx = sub(x, this.grid.xAt(other));
      const dy = sub(y, this.grid.yAt(other));
      const length = lengthOf(dx, dy);
      if (length <= COINCIDENT) {
        // Точное совпадение позиций: разойтись некуда, и направление выбирается
        // стабильно — по порядку обхода, а не жребием (лишний вызов ГПСЧ здесь
        // сделал бы их число функцией плотности толпы, D9).
        sumX = add(sumX, slot < other ? -FIXED_ONE : FIXED_ONE);
        continue;
      }
      const scale = sub(div(FIXED_ONE, length), reach);
      if (scale <= 0) continue;
      sumX = add(sumX, mul(dx, scale));
      sumY = add(sumY, mul(dy, scale));
    }
    this.normalize(sumX, sumY);
  }
}
