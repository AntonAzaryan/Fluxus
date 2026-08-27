/**
 * Прерывания каста (ABIL-6): закрытый словарь источников, нормативная таблица
 * умолчаний, применение исхода — и поздний читатель шины `CastInterruptSystem`.
 *
 * Таблица исходов живёт одним модулем и вызывается всеми системами платформы:
 * два экземпляра разошлись бы на первом же новом источнике.
 *
 * `damaged` не помещается в открывающую полосу платформы по устройству шины
 * (EVT-2): событие урона публикует система сцены, и на тике каста оно
 * недоступно ни `CastPhaseSystem`, ни любой системе раньше него, а на следующем
 * тике его уже нет вовсе. Поэтому источник требует системы ПОСЛЕ систем сцены —
 * `CastInterruptSystem` на 830, последней среди читателей шины (DET-9).
 */
import { execute, systemError } from '../../dsl/actions.js';
import { evaluate, typeError } from '../../dsl/expr.js';
import { ABILITY_SLOT_COMPONENT, NO_PHASE } from './components.js';
import {
  COOLDOWN_FULL,
  COOLDOWN_PARTIAL,
  COOLDOWN_REFUND,
  STAGED_RESET,
  type AbilityCatalog,
  type CompiledAbility,
  type CompiledOutcome,
  type CompiledPhase,
} from './model.js';
import {
  abilityOf,
  cooldownTicksOf,
  setCooldown,
  SlotScope,
  type ExprVarsRecord,
} from './runtime.js';
import { NO_ENTITY, type EntityId, type QuerySpec, type System, type SystemContext } from '../../types.js';

/**
 * Закрытый словарь источников (ABIL-6). Числовые значения нормативны и
 * следуют порядку строк словаря требования, начиная с единицы; ноль означает
 * «прерывания не было». Нормативны они по той же причине, что и всё, во что
 * смотрит контент: значение, выбранное реализацией, развело бы два ядра при
 * одном и том же документе сцены (CLI-6).
 */
export const INTERRUPT_SOURCES: readonly string[] = [
  'release',
  'cancelInput',
  'supersede',
  'disable',
  'death',
  'displacement',
  'targetLost',
  'timeout',
  'damaged',
  'dispel',
];

export const INTERRUPT_RELEASE = 1;
export const INTERRUPT_CANCEL_INPUT = 2;
export const INTERRUPT_SUPERSEDE = 3;
export const INTERRUPT_DISABLE = 4;
export const INTERRUPT_DEATH = 5;
export const INTERRUPT_DISPLACEMENT = 6;
export const INTERRUPT_TARGET_LOST = 7;
export const INTERRUPT_TIMEOUT = 8;
export const INTERRUPT_DAMAGED = 9;
export const INTERRUPT_DISPEL = 10;

/** Код источника по имени словаря либо 0, если имени в словаре нет. */
export function interruptCode(source: string): number {
  return INTERRUPT_SOURCES.indexOf(source) + 1;
}

/** Бит источника в маске объявленных определением источников. */
export function sourceMask(code: number): number {
  return 1 << (code - 1);
}

/**
 * Биндинг сцены, без которого источник недоступен (ABIL-8). Источники, которых
 * в таблице нет, доступны в любой сцене.
 */
export const SOURCE_BINDING: Readonly<Record<string, string>> = Object.freeze({
  death: 'deadMarker',
  disable: 'actionLock',
  damaged: 'damageEvent',
});

/**
 * Нормативные умолчания платформы (ABIL-6). Балансом они не являются: они
 * различают «способность ничего не выпустила» и «способность потрачена», а доля
 * возврата — единственная числовая величина здесь — выражается только
 * определением.
 */
export function defaultOutcome(source: number): CompiledOutcome {
  const refund =
    source === INTERRUPT_CANCEL_INPUT ||
    source === INTERRUPT_TARGET_LOST ||
    source === INTERRUPT_DEATH;
  return {
    source,
    cooldown: refund ? COOLDOWN_REFUND : COOLDOWN_FULL,
    part: undefined,
    staged: STAGED_RESET,
  };
}

function findOutcome(
  outcomes: readonly CompiledOutcome[],
  start: number,
  count: number,
  source: number,
): CompiledOutcome | undefined {
  for (let i = 0; i < count; i++) {
    const outcome = outcomes[start + i]!;
    if (outcome.source === source) return outcome;
  }
  return undefined;
}

/**
 * Исход пары «фаза, источник»: переопределение фазы сильнее переопределения
 * определения, а платформенные умолчания действуют на всё, чего определение не
 * назвало (ABIL-6).
 */
export function resolveOutcome(
  catalog: AbilityCatalog,
  ability: CompiledAbility,
  phase: CompiledPhase | undefined,
  source: number,
): CompiledOutcome {
  if (phase !== undefined) {
    const own = findOutcome(catalog.outcomes, phase.outcomeStart, phase.outcomeCount, source);
    if (own !== undefined) return own;
  }
  return (
    findOutcome(catalog.outcomes, ability.outcomeStart, ability.outcomeCount, source) ??
    defaultOutcome(source)
  );
}

/**
 * Применение исхода: остаток кулдауна, судьба накопленного прицеливания,
 * запись `lastInterrupt` и исполнение `onCancel` фазы. Исход применяется в тот
 * же тик — это записи полей слота, а не отложенное решение (ABIL-6).
 *
 * Уже исполненные эффекты завершившихся фаз прерывание не отменяет: обратных
 * операций к списку действий платформа не хранит, и откат мира выполняет
 * перемотка (REW-2).
 *
 * `lastInterrupt` уходит в область видимости `onCancel` наравне с записью в
 * поле: поле станет видно миру только после flush команд системы (CMD-2), а
 * различать источник список действий обязан на том же тике (ABIL-6).
 */
export function applyInterrupt(
  ctx: SystemContext,
  catalog: AbilityCatalog,
  ability: CompiledAbility,
  phase: CompiledPhase,
  slot: EntityId,
  owner: EntityId,
  source: number,
  scope: SlotScope,
  system: string,
): void {
  const outcome = resolveOutcome(catalog, ability, phase, source);
  scope.bind(ctx, slot, owner);
  scope.vars.lastInterrupt = source;

  if (outcome.cooldown === COOLDOWN_REFUND) {
    // Поле остатка возвращается к нулю; сохранённого где-то ещё прежнего
    // значения не существует (ABIL-7).
    setCooldown(ctx, slot, 0, 0);
  } else {
    const total = cooldownTicksOf(ctx, ability, scope.vars);
    const remaining = outcome.cooldown === COOLDOWN_PARTIAL ? partOf(ctx, outcome, total, scope.vars) : total;
    setCooldown(ctx, slot, remaining, total);
  }

  const set = (field: string, value: number): void => {
    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, field, value);
  };
  set('lastInterrupt', source);
  set('phase', NO_PHASE);
  set('phaseTicks', 0);
  if (outcome.staged === STAGED_RESET) set('staged', 0);

  if (phase.onCancel.length === 0) return;
  try {
    execute(phase.onCancel, ctx, scope.vars);
  } catch (cause) {
    throw systemError(system, cause);
  }
}

/** Доля кулдауна для исхода `partial`: `total × доля`, доля — Q16.16. */
function partOf(
  ctx: SystemContext,
  outcome: CompiledOutcome,
  total: number,
  vars: ExprVarsRecord,
): number {
  if (outcome.part === undefined) return 0;
  const part = evaluate(outcome.part, ctx, vars);
  if (typeof part !== 'number') throw typeError('исход прерывания "partial"', 'number', part);
  const ticks = ctx.math.toInt(ctx.math.mul(ctx.math.fromInt(total), part));
  return ticks < 0 ? 0 : ticks;
}

// ------------------------------------------------------------------ система

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 830;

/**
 * Поздний читатель шины: прерывание идущего каста уроном (ABIL-6). Стоит
 * последней среди читателей шины и позже `BuffSystem` — периодика баффов
 * публикует события того же рода, и прерывание обязано видеть и их (DET-9).
 */
export class CastInterruptSystem implements System {
  readonly name = 'CastInterrupt';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  private readonly scope = new SlotScope();
  private readonly spec: QuerySpec = { all: [ABILITY_SLOT_COMPONENT] };
  /** Ни одно определение не объявило `damaged` — шину читать незачем. */
  private readonly watched: boolean;

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
    this.watched = catalog.abilities.some(
      (ability) => (ability.declared & sourceMask(INTERRUPT_DAMAGED)) !== 0,
    );
  }

  run(ctx: SystemContext): void {
    const { damageType, damageEntityField, damageAmountField } = this.catalog.bindings;
    if (!this.watched || damageType === undefined) return;
    if (damageEntityField === undefined || damageAmountField === undefined) return;
    const published = ctx.events.length;
    if (published === 0) return;

    const slots = ctx.query(this.spec);
    if (slots.length === 0) return;
    // Handle полей слота (SYS-10): один раз, на первом входе, после раннего выхода.
    const h = this.scope.handles(ctx);
    for (const slot of slots) {
      const phaseIndex = ctx.getByHandle(slot, h.phase);
      if (phaseIndex < 0) continue;
      const ability = abilityOf(this.catalog, ctx, h, slot);
      if ((ability.declared & sourceMask(INTERRUPT_DAMAGED)) === 0) continue;
      const owner = ctx.getByHandle(slot, h.owner);
      if (owner === NO_ENTITY || !ctx.isAlive(owner)) continue;

      // Урон за тик суммируется: «получил урон сверх порога» — про тик, а не
      // про отдельное событие, и два попадания подряд обязаны складываться.
      let damage = 0;
      let hit = false;
      for (let i = 0; i < published; i++) {
        const event = ctx.events.at(i);
        if (event.type !== damageType) continue;
        if (!Object.hasOwn(event.data, damageEntityField)) continue;
        if (event.data[damageEntityField] !== owner) continue;
        hit = true;
        // Сложение через Math API, а не голым `+`: величина урона — данные
        // контента, и масштаб у неё Q16.16 (DET-2, FP-4).
        const amount = Object.hasOwn(event.data, damageAmountField) ? event.data[damageAmountField]! : 0;
        damage = ctx.math.add(damage, amount);
      }
      if (!hit) continue;

      this.scope.bind(ctx, slot, owner);
      const threshold =
        ability.damageThreshold === undefined ? 0 : thresholdOf(ctx, ability, this.scope.vars);
      if (damage <= threshold) continue;

      const phase = this.catalog.phases[ability.phaseStart + phaseIndex]!;
      applyInterrupt(
        ctx,
        this.catalog,
        ability,
        phase,
        slot,
        owner,
        INTERRUPT_DAMAGED,
        this.scope,
        this.name,
      );
    }
  }
}

function thresholdOf(ctx: SystemContext, ability: CompiledAbility, vars: ExprVarsRecord): number {
  const value = evaluate(ability.damageThreshold!, ctx, vars);
  if (typeof value !== 'number') {
    throw typeError(`способность "${ability.id}": порог прерывания "damaged"`, 'number', value);
  }
  return value;
}
