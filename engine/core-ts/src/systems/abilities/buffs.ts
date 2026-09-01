/**
 * Рантайм баффов (BUFF-1..BUFF-7), `order` 820 (DET-9).
 *
 * Система делает ровно четыре вещи и ни одной сверх: накладывает свежие
 * инстансы (сводя их по политике стакинга), крутит периодику и реакции,
 * убавляет остаток и разбирает уход инстанса — истечение, снятие и исчезновение
 * цели. Отдельных механизмов для пассивок, аур и DoT здесь нет и быть не должно
 * (BUFF-7): каждый из них выражается составом блоков определения.
 *
 * Место в тике: позже `EffectDurationSystem` (810), потому что истекающая зона
 * снимает наложенные ею баффы своим списком действий, и сведение этих снятий
 * обязано попасть в тот же тик; раньше `CastInterruptSystem` (830), потому что
 * периодика баффов публикует события урона, и прерывание обязано видеть и их;
 * раньше `VisibilitySystem` (900), потому что бафф вправе править список
 * источников обзора, и снятый им источник обязан быть снят до пересчёта (DET-9).
 *
 * Проходов по инстансам два, и это не оптимизация, а условие воспроизводимости.
 * Наложение и убывание случаются в одной системе, а команды буфера мир видит
 * только после flush (CMD-5): в один проход исход зависел бы от того, чей
 * raw-индекс меньше — свежего инстанса или продлеваемого им действующего, — то
 * есть от переиспользования слотов сущностей (ID-6). Первый проход накладывает
 * (свежий инстанс отличается от действующего полем `class`, которое в мире ещё
 * ноль), второй тикает уже действующие, читая изменённые поля через `peekField`.
 *
 * TimeScale (TIME-5): игнорирует — остаток инстанса и счётчик периодики идут в
 * ГЛОБАЛЬНЫХ тиках (design Decision 9, тот же выбор, что у кулдаунов).
 * Следствие для дизайна: замедление цели не разрежает тики DoT и не удлиняет
 * бафф.
 */
import { execute, systemError, type Action } from '../../dsl/actions.js';
import { evaluate, typeError } from '../../dsl/expr.js';
import { requireModifierList } from '../modifiers.js';
import {
  ABILITY_SLOT_COMPONENT,
  BUFF_INSTANCE_COMPONENT,
  NO_BUFF_CLASS,
} from './components.js';
import { resolveBuffInstanceHandles, type BuffInstanceHandles } from './handles.js';
import { applyInterrupt, INTERRUPT_DISPEL } from './interrupt.js';
import { STACKING_INDEPENDENT, STACKING_STACK, type AbilityCatalog, type CompiledBuff } from './model.js';
import {
  abilityOf,
  buffField,
  buffOf,
  BuffScope,
  intOf,
  modifierIdOf,
  SlotScope,
  ticksOf,
} from './runtime.js';
import {
  NO_ENTITY,
  type EntityId,
  type ModifierList,
  type ModifierRegistry,
  type QuerySpec,
  type System,
  type SystemContext,
} from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 820;

/** Стаков у самостоятельно наложенного инстанса (BUFF-3). */
const FIRST_STACK = 1;

export class BuffSystem implements System {
  readonly name = 'Buff';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  /**
   * Списки источников разрешены НА ЗАГРУЗКЕ (BUFF-4): статовая правка,
   * адресующая список, которого сцена не подключает, — ошибка загрузки, а не
   * правка без эффекта. Порядок массива — порядок `catalog.statMods`.
   */
  private readonly lists: readonly ModifierList[];
  private readonly scope = new BuffScope();
  /** Область видимости прерываемого каста — отдельная (ABIL-10). */
  private readonly victim = new SlotScope();
  private readonly spec: QuerySpec = { all: [BUFF_INSTANCE_COMPONENT] };
  /**
   * Handle полей инстанса (SYS-10): разрешаются на первом входе и ПОСЛЕ раннего
   * выхода — сцена без инстансов до имён не доходит.
   */
  private handles: BuffInstanceHandles | undefined;

  constructor(catalog: AbilityCatalog, modifiers: ModifierRegistry | undefined) {
    this.catalog = catalog;
    this.lists = catalog.statMods.map((mod) => requireModifierList(modifiers, mod.component));
  }

  run(ctx: SystemContext): void {
    const instances = ctx.query(this.spec);
    if (instances.length === 0) return;
    const h = (this.handles ??= resolveBuffInstanceHandles(ctx));
    for (const instance of instances) this.apply(ctx, h, instances, instance);
    for (const instance of instances) this.advance(ctx, h, instance);
  }

  // ------------------------------------------------------------- наложение

  /**
   * Первый проход: инстанс, которого платформа ещё не накладывала, получает
   * класс, длительность и статовые правки определения (BUFF-2) либо сводится с
   * действующим по политике стакинга (BUFF-3).
   */
  private apply(
    ctx: SystemContext,
    h: BuffInstanceHandles,
    instances: Float64Array,
    instance: EntityId,
  ): void {
    if (ctx.getByHandle(instance, h.buffClass) !== NO_BUFF_CLASS) return;
    // Цель исчезла раньше, чем бафф успел лечь: снимать нечего и исполнять
    // нечего (BUFF-6).
    const target = this.liveTarget(ctx, h, instance);
    if (target === NO_ENTITY) return;
    const buff = buffOf(this.catalog, ctx, h, instance);
    const source = ctx.getByHandle(instance, h.source);

    // Длительность нового наложения считается в области видимости НОВОГО
    // инстанса (BUFF-3) — и когда он живёт сам, и когда сводится с действующим.
    this.scope.bind(instance, target, source, FIRST_STACK);
    const remaining = this.duration(ctx, buff);

    const host =
      buff.stacking === STACKING_INDEPENDENT
        ? NO_ENTITY
        : this.host(ctx, h, instances, instance, target);
    if (host !== NO_ENTITY) {
      this.coalesce(ctx, buff, host, instance, target, remaining);
      return;
    }

    const write = ctx.commands;
    write.setField(instance, BUFF_INSTANCE_COMPONENT, 'class', buff.klass);
    write.setField(instance, BUFF_INSTANCE_COMPONENT, 'stacks', FIRST_STACK);
    write.setField(instance, BUFF_INSTANCE_COMPONENT, 'remaining', remaining);
    write.setField(instance, BUFF_INSTANCE_COMPONENT, 'periodicTicks', 0);
    this.placeStatMods(ctx, buff, instance, target);
  }

  /**
   * Действующий инстанс той же пары «цель, определение» (BUFF-3). Обход идёт в
   * порядке запроса (QUERY-2), поэтому несколько наложений одного тика сводятся
   * в порядке идентификаторов сущностей и результат воспроизводится реплеем
   * (DET-6). Собственного индекса «цель → инстансы» платформа не строит: он был
   * бы состоянием вне мира (TICK-4) и требовал бы инвалидации на каждом спавне.
   */
  private host(
    ctx: SystemContext,
    h: BuffInstanceHandles,
    instances: Float64Array,
    instance: EntityId,
    target: EntityId,
  ): EntityId {
    const buffId = ctx.getByHandle(instance, h.buffId);
    for (const other of instances) {
      if (other === instance) continue;
      if (!ctx.isAlive(other)) continue;
      // Класс читается через буфер: инстанс, наложенный на этом же тике
      // проходом выше, для мира ещё не наложен (CMD-5).
      if (buffField(ctx, other, 'class') === NO_BUFF_CLASS) continue;
      if (buffField(ctx, other, 'dispelled') !== 0) continue;
      if (ctx.getByHandle(other, h.target) !== target) continue;
      if (ctx.getByHandle(other, h.buffId) !== buffId) continue;
      return other;
    }
    return NO_ENTITY;
  }

  /**
   * Сведение с действующим инстансом: `refresh` продлевает, `stack` вдобавок
   * поднимает число стаков до потолка (BUFF-3). Второй сущности не появляется,
   * поэтому лишняя удаляется — статовых правок она поставить не успела.
   *
   * Сложение эффекта стаков платформа не определяет: величина правки —
   * выражение определения, читающее `stacks`, и потому правки переставляются
   * заново после изменения их числа.
   */
  private coalesce(
    ctx: SystemContext,
    buff: CompiledBuff,
    host: EntityId,
    instance: EntityId,
    target: EntityId,
    remaining: number,
  ): void {
    ctx.commands.setField(host, BUFF_INSTANCE_COMPONENT, 'remaining', remaining);
    // Дальше область видимости — область ДЕЙСТВУЮЩЕГО инстанса: жить будет он,
    // и его же поля читает выражение величины статовой правки.
    const source = buffField(ctx, host, 'source');
    const stacks = buffField(ctx, host, 'stacks');
    this.scope.bind(host, target, source, stacks);
    if (buff.stacking === STACKING_STACK) {
      const ceiling = this.maxStacks(ctx, buff);
      const raised = stacks + 1 > ceiling ? ceiling : stacks + 1;
      if (raised !== stacks) {
        ctx.commands.setField(host, BUFF_INSTANCE_COMPONENT, 'stacks', raised);
        this.scope.bind(host, target, source, raised);
        this.placeStatMods(ctx, buff, host, target);
      }
    }
    ctx.commands.destroy(instance);
  }

  // ------------------------------------------------------------------ тик

  /**
   * Второй проход: инстансы, действовавшие к началу тика. Свежие сюда не
   * попадают — их поле `class` в мире ещё ноль, — и это и есть «периодика
   * считается от тика наложения» (BUFF-5): счётчик начинает ход со следующего
   * тика, а не с того, на котором инстанс появился.
   */
  /**
   * Цель инстанса, если она жива; иначе инстанс уничтожается и возвращается
   * `NO_ENTITY` (BUFF-6). Одно правило — одна запись: наложение и ход читают
   * исчезновение цели одинаково, и разойтись им негде.
   */
  private liveTarget(ctx: SystemContext, h: BuffInstanceHandles, instance: EntityId): EntityId {
    const target = ctx.getByHandle(instance, h.target);
    if (target === NO_ENTITY || !ctx.isAlive(target)) {
      ctx.commands.destroy(instance);
      return NO_ENTITY;
    }
    return target;
  }

  private advance(ctx: SystemContext, h: BuffInstanceHandles, instance: EntityId): void {
    if (ctx.getByHandle(instance, h.buffClass) === NO_BUFF_CLASS) return;
    // Исчезновение цели удаляет инстанс БЕЗ `onExpire` (BUFF-6): исполнять
    // список действий над несуществующей сущностью нечем. Снимать источники
    // тоже не с кого — они исчезли вместе с целью.
    const target = this.liveTarget(ctx, h, instance);
    if (target === NO_ENTITY) return;
    const buff = buffOf(this.catalog, ctx, h, instance);
    const source = buffField(ctx, instance, 'source');
    const stacks = buffField(ctx, instance, 'stacks');

    // Снятие разбирается тем же путём, что истечение (BUFF-6), и раньше него:
    // рассеянный бафф не обязан отработать периодику этого тика.
    if (buffField(ctx, instance, 'dispelled') !== 0) {
      this.finish(ctx, buff, instance, target, source, stacks, true);
      return;
    }

    const ticks = buffField(ctx, instance, 'periodicTicks') + 1;
    ctx.commands.setField(instance, BUFF_INSTANCE_COMPONENT, 'periodicTicks', ticks);
    this.scope.bind(instance, target, source, stacks);
    this.periodic(ctx, buff, ticks);
    this.triggers(ctx, buff);

    const remaining = buffField(ctx, instance, 'remaining');
    // Неположительный остаток — постоянный бафф (BUFF-2, BUFF-6): он не
    // истекает сам и снимается только явно.
    if (remaining <= 0) return;
    ctx.commands.setField(instance, BUFF_INSTANCE_COMPONENT, 'remaining', remaining - 1);
    if (remaining > 1) return;
    this.finish(ctx, buff, instance, target, source, stacks, false);
  }

  /** Периодика (BUFF-5): каждый `everyTicks`-й тик жизни инстанса. */
  private periodic(ctx: SystemContext, buff: CompiledBuff, ticks: number): void {
    if (buff.everyTicks === undefined || buff.periodic.length === 0) return;
    const every = ticksOf(
      evaluate(buff.everyTicks, ctx, this.scope.vars),
      `бафф "${buff.id}": "periodic.everyTicks"`,
    );
    if (every <= 0 || ticks % every !== 0) return;
    this.exec(ctx, buff.periodic);
  }

  /**
   * Реакции на события шины текущего тика (BUFF-5, EVT-2). Отбор событий по
   * отношению к цели — предикат определения, а не конвенция платформы: какие
   * поля события называют цель, знает сцена (ABIL-8).
   */
  private triggers(ctx: SystemContext, buff: CompiledBuff): void {
    if (buff.triggerCount === 0) return;
    const published = ctx.events.length;
    if (published === 0) return;
    for (let t = 0; t < buff.triggerCount; t++) {
      const trigger = this.catalog.buffTriggers[buff.triggerStart + t]!;
      for (let i = 0; i < published; i++) {
        if (ctx.events.at(i).type !== trigger.type) continue;
        this.scope.vars[trigger.as] = i;
        this.exec(ctx, trigger.actions);
      }
    }
  }

  // -------------------------------------------------- истечение и снятие

  /**
   * Уход инстанса (BUFF-6): `onExpire`, снятие поставленных им источников и
   * удаление сущности. Причина различима списком действий по полю `dispelled`
   * инстанса — сущность ещё жива, пока команда удаления не применена (CMD-2).
   *
   * Рассеивание идущего каста вдобавок прерывает его источником `dispel`
   * (ABIL-6): каст, выраженный баффом на кастере, снимается вместе с ним, и
   * второго механизма для этого платформа не заводит.
   */
  private finish(
    ctx: SystemContext,
    buff: CompiledBuff,
    instance: EntityId,
    target: EntityId,
    source: EntityId,
    stacks: number,
    dispelled: boolean,
  ): void {
    this.scope.bind(instance, target, source, stacks);
    this.exec(ctx, buff.onExpire);
    this.clearStatMods(ctx, buff, instance, target);
    ctx.commands.destroy(instance);
    if (dispelled) this.dispelCast(ctx, source);
  }

  /**
   * Источник инстанса — сущность-слот с идущим кастом: рассеивание баффа есть
   * прерывание этого каста (BUFF-6, ABIL-6). Слот без каста, источник иного
   * рода и нулевой источник не значат ничего — это обычные баффы.
   */
  private dispelCast(ctx: SystemContext, source: EntityId): void {
    if (source === NO_ENTITY || !ctx.isAlive(source)) return;
    if (!ctx.has(source, ABILITY_SLOT_COMPONENT)) return;
    // Handle слота разрешаются ЗДЕСЬ, а не на входе системы: сцена вправе
    // объявить одни баффы (SER-7), и компонента слота у неё тогда нет вовсе.
    // Проверка выше доказывает, что он есть, — резолв законен (SYS-10).
    const h = this.victim.handles(ctx);
    const phaseIndex = ctx.getByHandle(source, h.phase);
    if (phaseIndex < 0) return;
    const owner = ctx.getByHandle(source, h.owner);
    if (owner === NO_ENTITY || !ctx.isAlive(owner)) return;
    const ability = abilityOf(this.catalog, ctx, h, source);
    const phase = this.catalog.phases[ability.phaseStart + phaseIndex];
    if (phase === undefined || phaseIndex >= ability.phaseCount) return;
    applyInterrupt(
      ctx,
      this.catalog,
      ability,
      phase,
      source,
      owner,
      INTERRUPT_DISPEL,
      this.victim,
      this.name,
    );
  }

  // ------------------------------------------------------ статовые правки

  /**
   * Постановка источников (BUFF-4) существующим механизмом слотов (TIME-7):
   * reducer, нейтральное значение свободного слота, запрет нулевого
   * идентификатора и ошибка при отсутствии свободного слота действуют без
   * ослаблений — переполнение слотов остаётся громкой ошибкой, а не молчаливым
   * вытеснением чужого источника.
   */
  private placeStatMods(
    ctx: SystemContext,
    buff: CompiledBuff,
    instance: EntityId,
    target: EntityId,
  ): void {
    const id = modifierIdOf(instance);
    for (let i = 0; i < buff.statCount; i++) {
      const list = this.lists[buff.statStart + i]!;
      if (!ctx.has(target, list.component)) {
        throw new Error(
          `бафф "${buff.id}": цель ${target} не несёт списка источников "${list.component}" (TIME-7)`,
        );
      }
      const mod = this.catalog.statMods[buff.statStart + i]!;
      const value = evaluate(mod.value, ctx, this.scope.vars);
      if (typeof value !== 'number') {
        throw typeError(`бафф "${buff.id}": статовая правка "${list.component}"`, 'number', value);
      }
      list.add(ctx, target, id, value);
    }
  }

  /** Снятие всех поставленных инстансом источников (BUFF-4, BUFF-6). */
  private clearStatMods(
    ctx: SystemContext,
    buff: CompiledBuff,
    instance: EntityId,
    target: EntityId,
  ): void {
    const id = modifierIdOf(instance);
    for (let i = 0; i < buff.statCount; i++) {
      const list = this.lists[buff.statStart + i]!;
      if (!ctx.has(target, list.component)) continue;
      list.remove(ctx, target, id);
    }
  }

  // ------------------------------------------------------------ выражения

  private duration(ctx: SystemContext, buff: CompiledBuff): number {
    if (buff.durationTicks === undefined) return 0;
    const ticks = ticksOf(
      evaluate(buff.durationTicks, ctx, this.scope.vars),
      `бафф "${buff.id}": "durationTicks"`,
    );
    return ticks < 0 ? 0 : ticks;
  }

  private maxStacks(ctx: SystemContext, buff: CompiledBuff): number {
    const ceiling = intOf(
      evaluate(buff.maxStacks!, ctx, this.scope.vars),
      `бафф "${buff.id}": "maxStacks"`,
      'потолок стаков',
    );
    return ceiling < FIRST_STACK ? FIRST_STACK : ceiling;
  }

  /**
   * Ошибка внутри списка действий — та же ошибка класса 3, что у системы из
   * данных (SYS-9): второго класса ошибок платформа не вводит (ABIL-10).
   */
  private exec(ctx: SystemContext, actions: readonly Action[]): void {
    if (actions.length === 0) return;
    try {
      execute(actions, ctx, this.scope.vars);
    } catch (cause) {
      throw systemError(this.name, cause);
    }
  }
}
