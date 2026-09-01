/**
 * Движение NPC (`npc-behavior` NPC-6) — ГЕЙМПЛЕЙНАЯ ПОЛИТИКА над навигационным
 * швом (NAV-4): система хранит прогресс в своих компонентах и пишет скорость
 * через Command Buffer. Ядро никого по пути не водит, компонента пути и поля
 * «идти сюда» у него нет.
 *
 * Сближение с очередной целью движения — точкой маршрута или целью преследования
 * — идёт по пути из `findPath`, когда навигация в сборке есть, и прямым seek,
 * когда её нет (NPC-6, DI-4, NAV-6). Документа поведения и маршрутов сцены это
 * не касается: ни то ни другое о СПОСОБЕ движения не говорит.
 *
 * Путь не хранится списком (NPC-6): `findPath` чист и детерминирован (NAV-2),
 * поэтому политика держит ОДНУ очередную точку — полями компонента агента, как
 * и вектор расхождения, — и перезапрашивает путь в своём окне решений (NPC-4).
 * Окно это читается из мира: `decidedTick` агента, поставленный системой
 * поведения на этом же тике (её `order` меньше, и её команды уже применены).
 *
 * Всякий не-`found` ответ, отсутствие точки и достигнутая держимая точка
 * означают одно и то же — прямой seek к цели, тот же, что в сборке без
 * навигации: недостижимость и исчерпание бюджета матч не роняют и волну не
 * останавливают (NPC-6).
 *
 * Локальное расхождение — по соседям СЕТКИ (`grid.ts`): полного перебора пар
 * агентов нет, и стоимость шага растёт числом соседей, а не квадратом числа
 * агентов (NPC-6). Пересчёт вектора расхождения идёт СВОИМ каденсом — раз в
 * `separationIntervalTicks` тиков на агента, — а между окнами применяется
 * последний пересчитанный вектор из полей компонента (NPC-6).
 *
 * Исполнение решения идёт КАЖДЫЙ тик независимо от каденса пересмотра (NPC-4):
 * решение выбирает `behavior.ts` по своим окнам, а движется агент постоянно.
 * Каденс пересчёта расхождения этого не меняет: он про СВЕЖЕСТЬ вектора, а не
 * про право двигаться, — и в бюджет решений (NPC-4) не входит.
 *
 * Направления считаются в ПОЛЯХ системы, а не возвращаются векторами: литерал
 * `{ x, y }` на каждого агента (и на каждого его соседа) был бы аллокацией,
 * пропорциональной числу сущностей.
 *
 * TimeScale (TIME-5): игнорирует сам — каденсы пересчёта пути и расхождения идут
 * в ГЛОБАЛЬНЫХ тиках, — но движение агента замедляется: система пишет СКОРОСТЬ,
 * а интегрирует её физика (PHYS-8), опт-ин в TimeScale.
 */
import { add, distSqLe, div, mul, sub } from '../../math/fixed.js';
import { lengthOf } from '../../math/vector.js';
import { NpcGrid } from './grid.js';
import { NpcRoutes } from './routes.js';
import { isDead, livingAgents, posX, posY } from './runtime.js';
import { NPC_ACTION_NONE, NPC_AGENT_COMPONENT, NPC_ROUTE_COMPONENT } from './components.js';
import { resolveNpcHandles, type NpcHandles } from './handles.js';
import { EXEC_FOLLOW_ROUTE, EXEC_SEEK_TARGET, type CompiledBehavior, type NpcCatalog } from './model.js';
import {
  FIXED_ONE,
  NO_ENTITY,
  type EntityId,
  type Fixed,
  type NavigationApi,
  type PathRequestOptions,
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
  /**
   * Концы запроса пути и его опции — ПЕРЕИСПОЛЬЗУЕМЫЕ поля системы, а не
   * литералы на вызов: запрос случается в окне решений каждого агента, и
   * литерал на каждый был бы аллокацией, пропорциональной числу сущностей.
   * `findPath` — чистый запрос (NAV-2) и переданных точек не удерживает.
   */
  private readonly requestFrom = { x: 0 as Fixed, y: 0 as Fixed };
  private readonly requestTo = { x: 0 as Fixed, y: 0 as Fixed };
  private readonly requestOptions = { agentRadius: 0 as Fixed };
  /** Точка, к которой агент идёт на этом тике: держимая либо только что найденная. */
  private pointX: Fixed = 0;
  private pointY: Fixed = 0;
  /** Handle платформы (SYS-10): один раз на первом входе, после раннего выхода. */
  private handles: NpcHandles | undefined;

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
    const handles = (this.handles ??= resolveNpcHandles(ctx, bindings));
    this.routes.rebuild(ctx, bindings.position, handles);
    this.grid.begin(agents.length);
    for (let slot = 0; slot < agents.length; slot++) {
      const entity = agents[slot]!;
      this.grid.add(slot, posX(ctx, handles, entity), posY(ctx, handles, entity));
    }

    for (let slot = 0; slot < agents.length; slot++) {
      const entity = agents[slot]!;
      const behavior = this.catalog.behaviors[ctx.getByHandle(entity, handles.agentBehavior)];
      if (behavior === undefined) continue;
      this.desired(ctx, handles, behavior, entity);
      let vx = mul(this.dirX, behavior.speed);
      let vy = mul(this.dirY, behavior.speed);
      this.separation(ctx, handles, behavior, entity, slot);
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
  private desired(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
  ): void {
    this.dirX = 0;
    this.dirY = 0;
    const action = ctx.getByHandle(entity, handles.agentAction);
    if (action === NPC_ACTION_NONE) return;
    const state = behavior.states[ctx.getByHandle(entity, handles.agentState)];
    const executor = state?.actions[action]?.executor;
    if (executor === EXEC_FOLLOW_ROUTE) this.followRoute(ctx, handles, behavior, entity);
    else if (executor === EXEC_SEEK_TARGET) this.seekTarget(ctx, handles, behavior, entity);
    // `hold` и `cast` стоят на месте: идущий каст двигать себя не должен, а
    // «атака в контакте» — это остановка, а не отдельный исполнитель.
  }

  /**
   * Следование маршруту (NPC-6): сближение с текущей точкой, переход к следующей
   * по достижении. Прогресс живёт в компоненте агента, то есть снапшотится и
   * откатывается вместе с миром (SNAP-1).
   */
  private followRoute(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
  ): void {
    if (!ctx.hasByHandle(entity, handles.route)) return;
    const route = ctx.getByHandle(entity, handles.routeRoute);
    let index = ctx.getByHandle(entity, handles.routeIndex);
    let point = this.routes.at(route, index);
    if (point === NO_ENTITY) return;
    const x = posX(ctx, handles, entity);
    const y = posY(ctx, handles, entity);
    if (distSqLe(posX(ctx, handles, point) - x, posY(ctx, handles, point) - y, behavior.arrive)) {
      index += 1;
      ctx.commands.setField(entity, NPC_ROUTE_COMPONENT, 'index', index);
      point = this.routes.at(route, index);
      if (point === NO_ENTITY) return;
    }
    this.steer(ctx, handles, behavior, entity, posX(ctx, handles, point), posY(ctx, handles, point));
  }

  /** Сближение с целью; в пределах дистанции контакта агент стоит (NPC-4). */
  private seekTarget(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
  ): void {
    const target = ctx.getByHandle(entity, handles.agentTarget);
    if (target === NO_ENTITY || !ctx.isAlive(target) || isDead(ctx, handles, target)) return;
    const goalX = posX(ctx, handles, target);
    const goalY = posY(ctx, handles, target);
    const dx = goalX - posX(ctx, handles, entity);
    const dy = goalY - posY(ctx, handles, entity);
    if (distSqLe(dx, dy, behavior.attack)) return;
    this.steer(ctx, handles, behavior, entity, goalX, goalY);
  }

  /**
   * Сближение с точкой — ОДИН механизм для маршрута и для преследования (NPC-6):
   * различается у них только источник очередной цели, а не способ движения.
   *
   * Без собранной навигации это прежний прямой seek, байт-в-байт (DI-4, NAV-6).
   * С навигацией агент идёт к держимой точке пути, а прямой seek остаётся
   * деградацией: путь не найден, точки нет либо она уже достигнута.
   *
   * Достигнутая точка ИСЧЕРПАНА и возвращает к прямому seek — это норма NPC-6,
   * а не решение реализации: у документа с дистанцией контакта меньше дистанции
   * прибытия агент, стоящий на достигнутой точке, так и не дошёл бы до цели, а
   * шаг, длиннее остатка пути, давал бы перелёт и разворот на месте каждый тик.
   */
  private steer(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
    goalX: Fixed,
    goalY: Fixed,
  ): void {
    const x = posX(ctx, handles, entity);
    const y = posY(ctx, handles, entity);
    if (this.holdsPoint(ctx, handles, behavior, entity, goalX, goalY)) {
      this.normalize(sub(this.pointX, x), sub(this.pointY, y));
      return;
    }
    this.normalize(goalX - x, goalY - y);
  }

  /**
   * Есть ли на этом тике держимая точка пути (NPC-6). В окне решений агента
   * (NPC-4) путь перезапрашивается, между окнами берётся точка из полей
   * компонента; достигнутая точка считается ИСЧЕРПАННОЙ (NPC-6) и держимой не
   * является.
   *
   * Окно читается по `decidedTick`: система поведения (`order` −795) ставит его
   * командой, а команды применяются на границе системы (CMD-2), поэтому здесь
   * (`order` 70) равенство номеру тика и означает «агент решал на этом тике».
   * Окно от этого остаётся функцией состояния мира, как того требует NPC-4.
   */
  private holdsPoint(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
    goalX: Fixed,
    goalY: Fixed,
  ): boolean {
    const navigation = ctx.navigation;
    if (navigation === undefined) return false;
    if (ctx.getByHandle(entity, handles.agentDecidedTick) === ctx.tick) {
      return this.requestPath(ctx, handles, navigation, entity, goalX, goalY);
    }
    if (ctx.getByHandle(entity, handles.agentPathValid) === 0) return false;
    this.pointX = ctx.getByHandle(entity, handles.agentPathX);
    this.pointY = ctx.getByHandle(entity, handles.agentPathY);
    const x = posX(ctx, handles, entity);
    const y = posY(ctx, handles, entity);
    return !distSqLe(sub(this.pointX, x), sub(this.pointY, y), behavior.arrive);
  }

  /**
   * Перезапрос пути в окне решений (NPC-6): держится ОЧЕРЕДНАЯ точка, а не
   * список. `agentRadius` берётся из данных агента — радиуса вписанной
   * окружности его коллайдера (PHYS-4, ARENA-5), а не из константы механизма;
   * сцена без физики радиуса не даёт вовсе, и запрос идёт без него.
   */
  private requestPath(
    ctx: SystemContext,
    handles: NpcHandles,
    navigation: NavigationApi,
    entity: EntityId,
    goalX: Fixed,
    goalY: Fixed,
  ): boolean {
    this.requestFrom.x = posX(ctx, handles, entity);
    this.requestFrom.y = posY(ctx, handles, entity);
    this.requestTo.x = goalX;
    this.requestTo.y = goalY;
    const radius = ctx.physics?.inradiusOf(entity);
    let options: PathRequestOptions | undefined;
    if (radius !== undefined) {
      this.requestOptions.agentRadius = radius;
      options = this.requestOptions;
    }
    const path = navigation.findPath(this.requestFrom, this.requestTo, options);
    // Пустой список у `found` — цель совпала с точкой агента (NAV-5): держать
    // нечего, и прямой seek здесь и есть кратчайший путь.
    const next = path.status === 'found' ? path.waypoints[0] : undefined;
    if (next === undefined) {
      // Команда — только на изменившееся: поля агента участвуют в dirty-дельте
      // тика (OBS-6), и запись прежнего нуля объявляла бы изменение, которого не
      // было, — каждое окно решений каждого агента без пути.
      if (ctx.getByHandle(entity, handles.agentPathValid) !== 0) {
        ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'pathValid', 0);
      }
      return false;
    }
    this.pointX = next.x;
    this.pointY = next.y;
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'pathValid', 1);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'pathX', next.x);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'pathY', next.y);
    return true;
  }

  /**
   * Вектор локального расхождения агента в `dirX`/`dirY` (NPC-6). Пересчёт идёт
   * КАДЕНСОМ: в окне `(тик + место агента в обходе) % интервал` — та же
   * конструкция, что у окна решений (NPC-4), и по той же причине. Место в
   * обходе стабильно (QUERY-2), номер тика — состояние мира, поэтому окно есть
   * функция состояния мира и только его: ни машины, ни нагрузки, ни «свободного
   * времени» здесь нет, иначе два прогона одного матча разошлись бы.
   *
   * Между окнами применяется ДЕРЖИМЫЙ вектор — поля компонента агента, которые
   * перемотка возвращает вместе с миром (SNAP-1). В самом окне свежий вектор
   * применяется из полей системы, а в мир уходит командой: мир до flush её не
   * видит (CMD-5) — тот же приём, что у `stateEnteredTick` решателя.
   */
  private separation(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
    slot: number,
  ): void {
    if (behavior.separation <= 0 || behavior.separationWeight <= 0) {
      // Документ расхождения не просит: ни запроса к сетке, ни записей в
      // компонент — держать нечего, и вектор остаётся нулевым.
      this.dirX = 0;
      this.dirY = 0;
      return;
    }
    if ((ctx.tick + slot) % behavior.separationIntervalTicks !== 0) {
      this.dirX = ctx.getByHandle(entity, handles.agentSepX);
      this.dirY = ctx.getByHandle(entity, handles.agentSepY);
      return;
    }
    this.recomputeSeparation(behavior, slot);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'sepX', this.dirX);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'sepY', this.dirY);
  }

  /**
   * Пересчёт вектора расхождения по соседям сетки (NPC-6): чем ближе сосед, тем
   * сильнее отталкивание. Результат — единичный вектор в `dirX`/`dirY` либо
   * ноль; на скорость его переводит вызывающий весом документа.
   *
   * Вклад соседа считается ОДНИМ корнем: `d/|d| · (1 − |d|/R)` равно
   * `d · (1/|d| − 1/R)`, поэтому нормировать вектор отдельно не нужно — а корень
   * в Q16.16 стоит двоичного поиска, и на каждого соседа каждого агента их было
   * бы вдвое больше нужного.
   */
  private recomputeSeparation(behavior: CompiledBehavior, slot: number): void {
    this.dirX = 0;
    this.dirY = 0;
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
