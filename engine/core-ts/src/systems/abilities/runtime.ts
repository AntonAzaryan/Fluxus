/**
 * Общий слой платформы способностей: то, что читают и пишут все её системы.
 *
 * Модуль существует ради ABIL-10: долгоживущие структуры (объект переменных
 * списка действий, точки шагов, спецификация запроса кандидатов) создаются один
 * раз на систему и переиспользуются между тиками, поэтому работа платформы не
 * порождает аллокаций, пропорциональных числу слотов. Приём тот же, что у
 * `orderedBuffers` в `dsl/actions.ts`.
 *
 * Мутаций мимо Command Buffer здесь нет (DET-7, CMD-4): всё, что пишется,
 * пишется командами.
 */
import { countCostAbilityCandidates } from '../../debug.js';
import { distSqCompare, distSqLe } from '../../math/fixed.js';
import { indexOf as rawIndexOf } from '../../ecs/entityIndex.js';
import { evaluate, typeError, type Expression, type ExprValue } from '../../dsl/expr.js';
import { isVisibleTo, VISIBILITY_COMPONENT } from '../visibility.js';
import {
  ABILITY_COOLDOWN_COMPONENT,
  ABILITY_STEPS,
  BUFF_INSTANCE_COMPONENT,
} from './components.js';
import { resolveSlotHandles, type BuffInstanceHandles, type SlotHandles } from './handles.js';
import type { StepShapeGate } from './shape.js';
import {
  INPUT_BUTTONS_FIELD,
  INPUT_PREV_BUTTONS_FIELD,
  INPUT_TARGET_X_FIELD,
  INPUT_TARGET_Y_FIELD,
  STEP_POINT,
  STEP_UNIT,
  TRIGGER_INPUT,
  type AbilityCatalog,
  type CompiledAbility,
  type CompiledBuff,
  type CompiledStep,
} from './model.js';
import {
  NO_ENTITY,
  POSITION_COMPONENT,
  type EntityId,
  type Fixed,
  type QuerySpec,
  type SystemContext,
  type Vec2,
} from '../../types.js';

/** Мутабельная точка: наружу уходит как `Vec2`, перезаписывается между связываниями. */
interface MutableVec2 {
  x: Fixed;
  y: Fixed;
}

/**
 * Число тиков — сырое целое (EXPR-2), а не Q16.16: `durationTicks: 30` в
 * определении означает тридцать тиков, а не 0.00046. Дробное значение —
 * ошибка вычисления класса SYS-9: молчаливое усечение спрятало бы формулу,
 * забывшую `toInt`.
 */
export function ticksOf(value: ExprValue, where: string): number {
  return intOf(value, where, 'число тиков');
}

/**
 * Счётное значение определения: сырое целое, а не Q16.16, и не дробь. Тем же
 * правилом и по той же причине, что число тиков: молчаливое усечение спрятало
 * бы формулу, забывшую `toInt`.
 */
export function intOf(value: ExprValue, where: string, what = 'счётное значение'): number {
  if (typeof value !== 'number') throw typeError(where, 'number', value);
  if (!Number.isInteger(value)) {
    throw new Error(`${where}: ${what} — сырое целое, получено ${value}`);
  }
  return value;
}

/**
 * Величина Q16.16 определения: строго число (EXPR-2). Отдельной проверки на
 * целость тут нет — в отличие от счётчика тиков, дробное значение здесь
 * штатное: это длина, радиус или доля оборота.
 */
export function fixedOf(value: ExprValue, where: string): Fixed {
  if (typeof value !== 'number') throw typeError(where, 'number', value);
  return value;
}

/** Предикат определения: строго `bool` (EXPR-7), числа в позиции условия нет. */
export function predicate(expr: Expression, ctx: SystemContext, vars: ExprVarsRecord): boolean {
  const value = evaluate(expr, ctx, vars);
  if (typeof value !== 'boolean') throw typeError('предикат определения', 'bool', value);
  return value;
}

/**
 * Определение слота по индексу в таблице сцены (ABIL-1). Ссылка мимо таблицы —
 * жёсткая ошибка, называющая слот и размер таблицы: то же правило и тот же текст
 * класса, что у твина, ссылающегося на несуществующее определение (TWEEN-1).
 */
export function abilityOf(
  catalog: AbilityCatalog,
  ctx: SystemContext,
  h: SlotHandles,
  slot: EntityId,
): CompiledAbility {
  const index = ctx.getByHandle(slot, h.abilityId);
  const ability = catalog.abilities[index];
  if (ability === undefined) {
    throw new Error(
      `слот ${slot} ссылается на определение способности ${index}, в таблице их ${catalog.abilities.length}`,
    );
  }
  return ability;
}

/** Позиция читается тотально (ECS-7): без компонента — мировое начало координат. */
export function positionOf(ctx: SystemContext, entity: EntityId, axis: 'x' | 'y'): Fixed {
  return ctx.has(entity, POSITION_COMPONENT) ? ctx.get(entity, POSITION_COMPONENT, axis) : 0;
}

/** Фронт бита: установлен сейчас и снят в прошлой маске (TICK-4). */
export function buttonEdge(buttons: number, prevButtons: number, bit: number): boolean {
  if (bit < 0) return false;
  const mask = 1 << bit;
  return (buttons & mask) !== 0 && (prevButtons & mask) === 0;
}

/** Спад бита: снят сейчас и был установлен в прошлой маске. */
export function buttonFell(buttons: number, prevButtons: number, bit: number): boolean {
  if (bit < 0) return false;
  const mask = 1 << bit;
  return (buttons & mask) === 0 && (prevButtons & mask) !== 0;
}

/** Бит взведён в маске текущего тика; наружу модуля не отдаётся (см. `triggerHoldEnded`). */
function buttonHeld(buttons: number, bit: number): boolean {
  if (bit < 0) return false;
  return (buttons & (1 << bit)) !== 0;
}

/**
 * Удержание бита триггера прекращено (ABIL-4). Это условие завершения фазы
 * `hold` и оно же — сигнал накопления шага фазы `release` (ABIL-5), поэтому
 * функция одна на обе системы платформы: разъехавшиеся предикаты записали бы
 * шаг там, где фаза не завершилась, и наоборот.
 *
 * Взят не спад бита, а его невзведённость: фаза, в которую слот вошёл уже с
 * отпущенной кнопкой, обязана завершиться сразу, а не ждать нового нажатия.
 * У способности с триггером не `input` бита триггера нет вовсе (ABIL-3), и
 * такая фаза по удержанию не завершается — завершить её может только `timeout`.
 */
export function triggerHoldEnded(ability: CompiledAbility, buttons: number): boolean {
  return ability.triggerKind === TRIGGER_INPUT && !buttonHeld(buttons, ability.triggerBit);
}

/**
 * Маска кнопок владельца. Собственного состояния фронта платформа не держит
 * (ABIL-3): обе маски читаются из компонента ввода, как их положил
 * `InputSystem` (TICK-4).
 *
 * Гейт двойной: сцена вправе не иметь компонента ввода вовсе (`hasInput`), а
 * ВЛАДЕЛЕЦ вправе его не иметь, оставаясь при этом законным носителем
 * способности, — так живёт NPC (`npc-behavior` NPC-1): его ротация просит каст
 * событием, а кнопок у него нет и не будет.
 *
 * Чтение поля тотально (ECS-7) и без второго гейта вернуло бы тот же ноль, но
 * вместе с записью о чтении без владения на КАЖДЫЙ тик каждой фазы (FP-4):
 * диагностика заполнялась бы штатным положением дел, и настоящая находка в ней
 * утонула бы.
 */
function ownerButtons(
  ctx: SystemContext,
  catalog: AbilityCatalog,
  owner: EntityId,
  field: string,
): number {
  const { bindings } = catalog;
  if (!bindings.hasInput || !ctx.has(owner, bindings.inputComponent)) return 0;
  return ctx.get(owner, bindings.inputComponent, field);
}

export function buttonsOf(ctx: SystemContext, catalog: AbilityCatalog, owner: EntityId): number {
  return ownerButtons(ctx, catalog, owner, INPUT_BUTTONS_FIELD);
}

export function prevButtonsOf(ctx: SystemContext, catalog: AbilityCatalog, owner: EntityId): number {
  return ownerButtons(ctx, catalog, owner, INPUT_PREV_BUTTONS_FIELD);
}

/**
 * Точка прицела этого кадра. Поля точки появляются в компоненте ввода вместе с
 * полем `target` кадра (TICK-2).
 *
 * Ветка «полей нет» осталась тотальной, но недостижима у способности с шагами:
 * определение, чей шаг берёт точку прицела, в сцене без этих полей отвергается
 * на загрузке (ABIL-5, проверка в `catalog.ts`). Молчаливой подстановки позиции
 * владельца — «направление от владельца к владельцу», то есть выстрел в никуда
 * без единого сообщения — здесь поэтому больше нет; величина остаётся
 * определённой и воспроизводимой на случай будущего читателя без шагов.
 */
export function aimX(ctx: SystemContext, catalog: AbilityCatalog, owner: EntityId): Fixed {
  const { bindings } = catalog;
  if (!bindings.hasAimPoint) return positionOf(ctx, owner, 'x');
  return ctx.get(owner, bindings.inputComponent, INPUT_TARGET_X_FIELD);
}

export function aimY(ctx: SystemContext, catalog: AbilityCatalog, owner: EntityId): Fixed {
  const { bindings } = catalog;
  if (!bindings.hasAimPoint) return positionOf(ctx, owner, 'y');
  return ctx.get(owner, bindings.inputComponent, INPUT_TARGET_Y_FIELD);
}

// ------------------------------------------------------------------ кулдаун

/**
 * Остаток кулдауна слота; читается из мира — гейт триггера обязан видеть начало
 * тика (ABIL-7). Наружу модуля не выходит: спрашивающим нужен не остаток, а
 * ответ гейта целиком (`slotReady`), и отдельно взятое слагаемое было бы
 * приглашением собрать этот ответ во второй раз.
 */
function cooldownRemaining(ctx: SystemContext, slot: EntityId): number {
  return ctx.has(slot, ABILITY_COOLDOWN_COMPONENT)
    ? ctx.get(slot, ABILITY_COOLDOWN_COMPONENT, 'remaining')
    : 0;
}

/**
 * Гейт старта каста (ABIL-7): слот свободен от фазы (`phase < 0`, значение
 * `NO_PHASE`) и кулдаун выстоял. Предикат ЕДИНЫЙ и живёт здесь, а не в
 * `tryStart`, потому что читают его двое: сама машина фаз и вход `abilityReady`
 * документа поведения NPC (`npc-behavior` NPC-7), отвечающий «стартовал бы
 * каст этого слота». Второе прочтение тех же двух полей рядом означало бы, что
 * исход каста следует из двух мест, — ровно то, что ABIL-7 запрещает.
 *
 * Держит старт ПОЛОЖИТЕЛЬНЫЙ остаток, а не «любой ненулевой»: поле обычное i32
 * (ABIL-1), убывание трогает только положительные значения, и запрет по
 * отрицательному запер бы слот навсегда. Ноль и меньше — «предела нет», та же
 * конвенция, что у дальности снаряда и длительности эффекта.
 */
export function slotReady(ctx: SystemContext, handles: SlotHandles, slot: EntityId): boolean {
  return ctx.getByHandle(slot, handles.phase) < 0 && cooldownRemaining(ctx, slot) <= 0;
}

/**
 * Взведение кулдауна (ABIL-7). Компонент вешает платформа, если его на слоте
 * нет: перечислять его в prefab'е слота — обязанность, которую контент забудет
 * молча, а взведение без компонента пропало бы в пустоту.
 */
export function setCooldown(
  ctx: SystemContext,
  slot: EntityId,
  remaining: number,
  total: number,
): void {
  if (ctx.has(slot, ABILITY_COOLDOWN_COMPONENT)) {
    ctx.commands.setField(slot, ABILITY_COOLDOWN_COMPONENT, 'remaining', remaining);
    ctx.commands.setField(slot, ABILITY_COOLDOWN_COMPONENT, 'total', total);
    return;
  }
  ctx.commands.addComponent(slot, ABILITY_COOLDOWN_COMPONENT, { remaining, total });
}

/** Значение выражения `cooldownTicks`; отсутствие блока — нулевой кулдаун. */
export function cooldownTicksOf(
  ctx: SystemContext,
  ability: CompiledAbility,
  vars: ExprVarsRecord,
): number {
  if (ability.cooldownTicks === undefined) return 0;
  const ticks = ticksOf(
    evaluate(ability.cooldownTicks, ctx, vars),
    `способность "${ability.id}": "cooldownTicks"`,
  );
  return ticks < 0 ? 0 : ticks;
}

// -------------------------------------------------- предсвязанные имена

/** Объект переменных списка действий: мутируется на месте, наружу не отдаётся. */
export type ExprVarsRecord = Record<string, ExprValue>;

/** Имена, предсвязанные во всех списках действий способности (design Decision 2). */
export const SLOT_BOUND_NAMES: readonly string[] = (() => {
  const names = ['self', 'owner', 'level', 'phaseTicks', 'staged', 'lastInterrupt'];
  for (let i = 0; i < ABILITY_STEPS; i++) names.push(`step${i}`, `unit${i}`);
  return names;
})();

/**
 * Переиспользуемая область видимости списка действий слота. Один экземпляр на
 * систему: значения перезаписываются перед каждым исполнением, а точки шагов
 * живут тремя объектами, созданными в конструкторе (ABIL-10).
 *
 * Второй формой состояния это не является (ABIL-1): все значения читаются из
 * полей слота обычным `ctx.get`, и источник у них один.
 */
export class SlotScope {
  readonly vars: ExprVarsRecord = {};
  private readonly points: MutableVec2[] = [];
  /**
   * Handle полей слота (SYS-10). Живут ЗДЕСЬ, а не в системе: область — объект
   * системы, создаваемый в её конструкторе, и разрешение имён на первом
   * связывании происходит ровно один раз за её жизнь. Ленивость несущая: сцена
   * с одними баффами компонента слота не объявляет вовсе (SER-7), и системе,
   * которая до слотов не дошла, падать не на чем.
   */
  private cached: SlotHandles | undefined;

  constructor() {
    for (const name of SLOT_BOUND_NAMES) this.vars[name] = 0;
    for (let i = 0; i < ABILITY_STEPS; i++) {
      const point: MutableVec2 = { x: 0, y: 0 };
      this.points.push(point);
      this.vars[`step${i}`] = point;
    }
  }

  /** Разрешённые handle полей слота; резолв — на первом обращении (SYS-10). */
  handles(ctx: SystemContext): SlotHandles {
    return (this.cached ??= resolveSlotHandles(ctx));
  }

  bind(ctx: SystemContext, slot: EntityId, owner: EntityId): void {
    const h = this.handles(ctx);
    this.vars.self = slot;
    this.vars.owner = owner;
    this.vars.level = ctx.getByHandle(slot, h.level);
    this.vars.phaseTicks = ctx.getByHandle(slot, h.phaseTicks);
    this.vars.staged = ctx.getByHandle(slot, h.staged);
    this.vars.lastInterrupt = ctx.getByHandle(slot, h.lastInterrupt);
    for (let i = 0; i < ABILITY_STEPS; i++) {
      const point = this.points[i]!;
      point.x = ctx.getByHandle(slot, h.stepX[i]!);
      point.y = ctx.getByHandle(slot, h.stepY[i]!);
      this.vars[`unit${i}`] = ctx.getByHandle(slot, h.stepEntity[i]!);
    }
  }
}

// ------------------------------------------------------------------- баффы

/**
 * Имена, предсвязанные во всех списках действий баффа (design Decision 2):
 * инстанс, его цель, его источник и число стаков. Больше платформа не обещает
 * ничего: полезные величины баффа — обычные поля его инстанса, и читаются они
 * обычным `getComponent`, включая признак снятия, по которому `onExpire`
 * различает «истёк сам» и «рассеян» (BUFF-6).
 */
export const BUFF_BOUND_NAMES: readonly string[] = ['self', 'target', 'source', 'stacks'];

/**
 * Переиспользуемая область видимости списка действий инстанса — один экземпляр
 * на систему, значения перезаписываются перед каждым исполнением (ABIL-10).
 */
export class BuffScope {
  readonly vars: ExprVarsRecord = {};

  constructor() {
    for (const name of BUFF_BOUND_NAMES) this.vars[name] = 0;
  }

  bind(instance: EntityId, target: EntityId, source: EntityId, stacks: number): void {
    this.vars.self = instance;
    this.vars.target = target;
    this.vars.source = source;
    this.vars.stacks = stacks;
  }
}

/**
 * Определение инстанса по индексу в таблице сцены (BUFF-1). Ссылка мимо
 * таблицы — жёсткая ошибка того же класса, что у слота способности.
 */
export function buffOf(
  catalog: AbilityCatalog,
  ctx: SystemContext,
  h: BuffInstanceHandles,
  instance: EntityId,
): CompiledBuff {
  const index = ctx.getByHandle(instance, h.buffId);
  const buff = catalog.buffs[index];
  if (buff === undefined) {
    throw new Error(
      `инстанс ${instance} ссылается на определение баффа ${index}, в таблице их ${catalog.buffs.length}`,
    );
  }
  return buff;
}

/**
 * Поле инстанса с учётом уже поставленных команд буфера (CMD-5). Мир до flush
 * команд не видит, а сведение стакинга и убывание остатка случаются в одном
 * тике и в одной системе: без чтения буфера продление, записанное сведением,
 * затёрлось бы убыванием, посчитанным от досведённого значения.
 */
export function buffField(ctx: SystemContext, instance: EntityId, field: string): number {
  return (
    ctx.commands.peekField(instance, BUFF_INSTANCE_COMPONENT, field) ??
    ctx.get(instance, BUFF_INSTANCE_COMPONENT, field)
  );
}

/**
 * Идентификатор источника-модификатора инстанса (BUFF-4, design Decision 7):
 * индекс сущности плюс единица. Индекс уникален среди живых сущностей,
 * помещается в `i32` (полный `EntityId` 48-битный и в слот `id{N}` не влез бы,
 * ID-1) и после сдвига не равен нулю, который TIME-7 запрещает. Формул вида
 * «id определения × страйд + слот игрока» платформа не заводит: страйд — второй
 * предел, о который однажды ударятся.
 */
export function modifierIdOf(instance: EntityId): number {
  return rawIndexOf(instance) + 1;
}

// --------------------------------------------------- шаги прицеливания (ABIL-5)

/**
 * Предсвязанные имена списков действий доставки (ABIL-9). Их мало намеренно:
 * полезная нагрузка снаряда — обычные компоненты сцены на той же сущности, и
 * читаются они обычным `getComponent`.
 */
export const PROJECTILE_HIT_NAMES: readonly string[] = ['self', 'owner', 'other', 'event'];
export const PROJECTILE_FADE_NAMES: readonly string[] = ['self', 'owner'];
export const DURATION_EXPIRE_NAMES: readonly string[] = ['self', 'owner'];

/** Имя, которым связана сущность-кандидат в предикате `filter` (ABIL-5). */
export const CANDIDATE_NAME = 'candidate';

/**
 * Начало шага (ABIL-5): точка или сущность предыдущего шага, для первого шага —
 * владелец слота. Читается из полей слота, а не из состояния платформы.
 */
export function stepOriginX(
  ctx: SystemContext,
  h: SlotHandles,
  slot: EntityId,
  owner: EntityId,
  step: number,
): Fixed {
  if (step === 0) return positionOf(ctx, owner, 'x');
  const previous = ctx.getByHandle(slot, h.stepEntity[step - 1]!);
  if (previous !== NO_ENTITY && ctx.isAlive(previous)) return positionOf(ctx, previous, 'x');
  return ctx.getByHandle(slot, h.stepX[step - 1]!);
}

export function stepOriginY(
  ctx: SystemContext,
  h: SlotHandles,
  slot: EntityId,
  owner: EntityId,
  step: number,
): Fixed {
  if (step === 0) return positionOf(ctx, owner, 'y');
  const previous = ctx.getByHandle(slot, h.stepEntity[step - 1]!);
  if (previous !== NO_ENTITY && ctx.isAlive(previous)) return positionOf(ctx, previous, 'y');
  return ctx.getByHandle(slot, h.stepY[step - 1]!);
}

/**
 * Видна ли цель стороне владельца (ABIL-5, FOW-2). Сцена без биндинга стороны
 * этой части проверки не выполняет вовсе, а сущность без `Visibility` публична
 * по умолчанию (NET-12) — то же правило, что у фильтра снапшота.
 */
function visibleToOwner(
  ctx: SystemContext,
  catalog: AbilityCatalog,
  owner: EntityId,
  target: EntityId,
): boolean {
  const { teamComponent, teamFieldName } = catalog.bindings;
  if (teamComponent === undefined || teamFieldName === undefined) return true;
  if (!ctx.has(target, VISIBILITY_COMPONENT)) return true;
  const team = ctx.get(owner, teamComponent, teamFieldName);
  return isVisibleTo(ctx.get(target, VISIBILITY_COMPONENT, 'visibleTo'), team);
}

/**
 * Выбор ближайшей к точке прицела сущности среди кандидатов (ABIL-5).
 * Спецификация запроса и её центр — поля экземпляра: подтверждение шага может
 * случиться у каждого слота, и объект на запрос был бы аллокацией,
 * пропорциональной числу слотов (ABIL-10).
 *
 * Тай-брейк равных расстояний — порядок обхода запроса (QUERY-2): строгое
 * сравнение оставляет первого встреченного, а запрос отдаёт кандидатов по
 * возрастанию raw-индекса. Сравнение квадратов — точной 64-битной
 * `distSqCompare`, той же, что у упорядоченной выборки (ACT-5).
 *
 * Требование `Position` стоит в САМОМ запросе — той канонической формой
 * `{all: ['Position'], withinRadius}`, которой QUERY-1 записывает поиск целей в
 * радиусе. Без него запрос широк на весь мир: `withinRadius` владения
 * `Position` не требует, а читает поле тотально (ECS-7, открытый вопрос
 * QUERY-1), то есть сущность-слот, инстанс баффа и всякий спутник без положения
 * оказываются в мировом начале координат. Два следствия, и оба дефекты: ядро
 * читает `Position` без владения на каждом подтверждении шага (запись
 * сломанного инварианта в диагностике, FP-4), а каст, чьё начало шага близко к
 * началу координат, выбирает целью сущность, расстояния до которой не
 * существует, — «ближайшая к точке прицела» (ABIL-5) о такой не определено
 * вовсе. Предикат `filter` эту дыру не закрывает: он фильтр контента, а чтение
 * идёт до него, внутри запроса.
 */
export class CandidatePicker {
  private readonly center: MutableVec2 = { x: 0, y: 0 };
  private readonly withinRadius = { center: this.center as Vec2, radius: 0 as Fixed };
  private readonly bounded: QuerySpec;
  private readonly unbounded: QuerySpec = { all: [POSITION_COMPONENT] };

  constructor() {
    this.bounded = { all: [POSITION_COMPONENT], withinRadius: this.withinRadius };
  }

  nearest(
    ctx: SystemContext,
    originX: Fixed,
    originY: Fixed,
    targetX: Fixed,
    targetY: Fixed,
    range: Fixed | undefined,
    filter: Expression | undefined,
    shape: StepShapeGate,
    vars: ExprVarsRecord,
  ): EntityId {
    let spec = this.unbounded;
    if (range !== undefined) {
      this.center.x = originX;
      this.center.y = originY;
      this.withinRadius.radius = range;
      spec = this.bounded;
    }
    let best = NO_ENTITY;
    let bestX = 0;
    let bestY = 0;
    // Кандидаты скана — работа тика (PERF-3): считается ОСМОТР, а не исход, и
    // калитка зовётся один раз на проход с числом отобранных запросом — тело
    // цикла проходит каждый из них, ранних выходов у скана нет.
    const candidates = ctx.query(spec);
    countCostAbilityCandidates(candidates.length);
    for (const candidate of candidates) {
      const candidateX = positionOf(ctx, candidate, 'x');
      const candidateY = positionOf(ctx, candidate, 'y');
      // Фигура шага — гейт платформы (ABIL-5), и стоит он ДО предиката
      // контента: `filter` — политика, а фигура описывает, что заденет каст, и
      // ровно её рисует превью (REND-28).
      if (!shape.contains(ctx, candidateX, candidateY)) continue;
      if (filter !== undefined) {
        vars[CANDIDATE_NAME] = candidate;
        if (!predicate(filter, ctx, vars)) continue;
      }
      const dx = ctx.math.sub(candidateX, targetX);
      const dy = ctx.math.sub(candidateY, targetY);
      if (best === NO_ENTITY || distSqCompare(dx, dy, bestX, bestY) < 0) {
        best = candidate;
        bestX = dx;
        bestY = dy;
      }
    }
    return best;
  }
}

/**
 * Проверка накопленных шагов — заново и целиком, и только на подтверждении
 * (ABIL-5): сущность шага жива, `filter` по-прежнему истинен, расстояние в
 * пределах `range`, а при объявленном биндинге стороны — цель видна стороне
 * владельца. Непрерывной проверки между шагами нет: она сделала бы исход каста
 * зависящим от того, на каком тике внутри фазы цель мигнула.
 */
export function stagedStepsValid(
  ctx: SystemContext,
  catalog: AbilityCatalog,
  h: SlotHandles,
  ability: CompiledAbility,
  slot: EntityId,
  owner: EntityId,
  vars: ExprVarsRecord,
): boolean {
  const staged = ctx.getByHandle(slot, h.staged);
  for (let i = 0; i < staged && i < ability.stepCount; i++) {
    const step = catalog.steps[ability.stepStart + i]!;
    if (!stagedStepValid(ctx, catalog, h, ability, slot, owner, vars, step, i)) return false;
  }
  return true;
}

/**
 * Один накопленный шаг (ABIL-5). Точка проверки: у шага `unit` — ТЕКУЩАЯ
 * позиция сущности (цель могла уйти), у шага `point` — записанная точка.
 */
function stagedStepValid(
  ctx: SystemContext,
  catalog: AbilityCatalog,
  h: SlotHandles,
  ability: CompiledAbility,
  slot: EntityId,
  owner: EntityId,
  vars: ExprVarsRecord,
  step: CompiledStep,
  i: number,
): boolean {
  if (step.kind === STEP_POINT) {
    const pointX = ctx.getByHandle(slot, h.stepX[i]!);
    const pointY = ctx.getByHandle(slot, h.stepY[i]!);
    return stepInRange(ctx, h, ability, slot, owner, vars, step, i, pointX, pointY);
  }
  // У `vector` и `none` мерить нечего: первый хранит единичное направление,
  // второй не берёт ничего.
  if (step.kind !== STEP_UNIT) return true;
  const unit = ctx.getByHandle(slot, h.stepEntity[i]!);
  if (unit === NO_ENTITY || !ctx.isAlive(unit)) return false;
  if (step.filter !== undefined) {
    vars[CANDIDATE_NAME] = unit;
    if (!predicate(step.filter, ctx, vars)) return false;
  }
  if (!visibleToOwner(ctx, catalog, owner, unit)) return false;
  const pointX = positionOf(ctx, unit, 'x');
  const pointY = positionOf(ctx, unit, 'y');
  return stepInRange(ctx, h, ability, slot, owner, vars, step, i, pointX, pointY);
}

/** Расстояние шага в пределах объявленного `range` (ABIL-5); без него — да. */
function stepInRange(
  ctx: SystemContext,
  h: SlotHandles,
  ability: CompiledAbility,
  slot: EntityId,
  owner: EntityId,
  vars: ExprVarsRecord,
  step: CompiledStep,
  i: number,
  pointX: Fixed,
  pointY: Fixed,
): boolean {
  if (step.range === undefined) return true;
  const range = evaluate(step.range, ctx, vars);
  if (typeof range !== 'number') throw typeError(`шаг ${i} способности "${ability.id}"`, 'number', range);
  const dx = ctx.math.sub(pointX, stepOriginX(ctx, h, slot, owner, i));
  const dy = ctx.math.sub(pointY, stepOriginY(ctx, h, slot, owner, i));
  return distSqLe(dx, dy, range);
}
