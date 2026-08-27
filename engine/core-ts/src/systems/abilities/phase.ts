/**
 * Автомат каста (ABIL-3, ABIL-4, ABIL-7), `order` −790 (DET-9).
 *
 * Система отвечает на вопрос «что происходит с автоматом»: старт по триггеру с
 * гейтом кулдауна, инкремент счётчика фазы, переходы `hold`/`auto`/`commit`/
 * `release` и `timeout.then`, проверка накопленных шагов на подтверждении
 * (ABIL-5), прерывания, распознаваемые по состоянию мира, и удаление
 * слотов-сирот.
 *
 * Не более одного перехода фазы на слот за тик (ABIL-4). Ограничение
 * нормативно, а не оптимизационно: цепочка фаз нулевой длительности с переходом
 * назад иначе крутилась бы внутри одного тика бесконечно, а работа тика обязана
 * быть ограничена составом мира, а не содержимым определения.
 *
 * Стоит раньше `LocomotionSystem`, поэтому лок, поставленный входом в фазу,
 * гейтит манёвры того же тика (LOC-7), а доставка, заспавненная эффектом,
 * успевает к разрешению движения того же тика.
 */
import { execute, systemError, type Action } from '../../dsl/actions.js';
import { evaluate } from '../../dsl/expr.js';
import { ABILITY_SLOT_COMPONENT, NO_INTERRUPT, NO_PHASE } from './components.js';
import {
  applyInterrupt,
  INTERRUPT_CANCEL_INPUT,
  INTERRUPT_DEATH,
  INTERRUPT_DISABLE,
  INTERRUPT_DISPLACEMENT,
  INTERRUPT_RELEASE,
  INTERRUPT_SUPERSEDE,
  INTERRUPT_TARGET_LOST,
  INTERRUPT_TIMEOUT,
  sourceMask,
} from './interrupt.js';
import {
  ACTION_LOCK_MASK_FIELD,
  PHASE_COMMIT,
  PHASE_HOLD,
  PHASE_RELEASE,
  TIMEOUT_CANCEL,
  TIMEOUT_COMMIT,
  TIMEOUT_NONE,
  TRIGGER_ALWAYS,
  TRIGGER_EVENT,
  TRIGGER_INPUT,
  type AbilityCatalog,
  type CompiledAbility,
  type CompiledPhase,
} from './model.js';
import {
  abilityOf,
  buttonEdge,
  buttonFell,
  buttonsOf,
  cooldownRemaining,
  cooldownTicksOf,
  predicate,
  prevButtonsOf,
  setCooldown,
  SlotScope,
  stagedStepsValid,
  ticksOf,
  triggerHoldEnded,
} from './runtime.js';
import type { SlotHandles } from './handles.js';
import { NO_ENTITY, type EntityId, type QuerySpec, type System, type SystemContext } from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = -790;

const NO_SLOTS = new Float64Array(0);

/** «События нет» в позиции ссылки на шину: имя триггера в область не связывается. */
const NO_EVENT = -1;

export class CastPhaseSystem implements System {
  readonly name = 'CastPhase';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  /** Область видимости своего слота и отдельная — прерываемого (ABIL-10). */
  private readonly scope = new SlotScope();
  private readonly victim = new SlotScope();
  private readonly spec: QuerySpec = { all: [ABILITY_SLOT_COMPONENT] };
  /** Выборка текущего тика: по ней стартующий слот обходит слоты владельца. */
  private slots: Float64Array = NO_SLOTS;

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
  }

  run(ctx: SystemContext): void {
    const slots = ctx.query(this.spec);
    if (slots.length === 0) return;
    // Handle полей слота (SYS-10): разрешаются один раз, на первом входе, и
    // ПОСЛЕ раннего выхода — сцена без слотов до имён не доходит.
    const h = this.scope.handles(ctx);
    this.slots = slots;
    for (const slot of slots) {
      const owner = ctx.getByHandle(slot, h.owner);
      // Слот-сирота: владельца больше не существует (design Decision 14).
      // Смерть владельца сиротством НЕ является — герой переживает её той же
      // сущностью, и удалённый по маркеру слот отнял бы у него способности
      // навсегда; смерть прерывает каст источником `death`, и только.
      if (owner === NO_ENTITY || !ctx.isAlive(owner)) {
        ctx.commands.destroy(slot);
        continue;
      }
      const ability = abilityOf(this.catalog, ctx, h, slot);
      const phaseIndex = ctx.getByHandle(slot, h.phase);
      if (phaseIndex < 0) {
        this.tryStart(ctx, slot, owner, ability);
        continue;
      }
      const phase = this.phaseOf(ability, phaseIndex, slot);
      if (this.interrupted(ctx, slot, owner, ability, phase)) continue;
      this.advance(ctx, h, slot, owner, ability, phase, phaseIndex);
    }
    this.slots = NO_SLOTS;
  }

  private phaseOf(ability: CompiledAbility, index: number, slot: EntityId): CompiledPhase {
    const phase = this.catalog.phases[ability.phaseStart + index];
    if (phase === undefined || index >= ability.phaseCount) {
      throw new Error(
        `слот ${slot}: фаза ${index} вне списка способности "${ability.id}" (фаз ${ability.phaseCount})`,
      );
    }
    return phase;
  }

  // ------------------------------------------------------------------ старт

  /**
   * Триггер гейтируется кулдауном (ABIL-3, ABIL-7): гейт — часть платформы, и
   * собственных проверок кулдауна контент писать не обязан. Условие сверх
   * триггера — предикат определения.
   */
  private tryStart(
    ctx: SystemContext,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
  ): void {
    if (cooldownRemaining(ctx, slot) > 0) return;
    let event = NO_EVENT;
    if (ability.triggerKind === TRIGGER_INPUT) {
      if (!this.catalog.bindings.hasInput) return;
      const buttons = buttonsOf(ctx, this.catalog, owner);
      const prevButtons = prevButtonsOf(ctx, this.catalog, owner);
      if (!buttonEdge(buttons, prevButtons, ability.triggerBit)) return;
    } else if (ability.triggerKind === TRIGGER_EVENT) {
      event = findEvent(ctx, ability.eventType);
      if (event < 0) return;
    } else if (ability.triggerKind !== TRIGGER_ALWAYS) {
      return;
    }

    this.scope.bind(ctx, slot, owner);
    if (event >= 0) this.scope.vars[ability.eventAs] = event;
    if (ability.condition !== undefined && !predicate(ability.condition, ctx, this.scope.vars)) {
      return;
    }

    this.supersede(ctx, slot, owner);
    // Отсутствие блока фаз означает мгновенную способность (ABIL-4): триггер
    // сразу исполняет `effects` и взводит кулдаун, и отдельного вида
    // «мгновенная способность» в платформе для этого нет.
    if (ability.phaseCount === 0) {
      this.finish(ctx, slot, owner, ability, undefined, event, 0);
      return;
    }
    this.enter(ctx, slot, owner, ability, 0, undefined, event, 0);
  }

  /**
   * Владелец начал другую способность (ABIL-6). Компонента «кто кастует»
   * платформа не заводит: стартующий слот обходит слоты того же владельца и
   * смотрит их `phase`, читая сначала уже поставленные команды буфера, потом мир
   * (CMD-5). Мир до flush команд не видит, и два старта в одном тике иначе оба
   * считали бы себя первыми.
   */
  private supersede(ctx: SystemContext, starter: EntityId, owner: EntityId): void {
    for (const other of this.slots) {
      if (other === starter) continue;
      if (!ctx.isAlive(other)) continue;
      const h = this.scope.handles(ctx);
      if (ctx.getByHandle(other, h.owner) !== owner) continue;
      const phaseIndex =
        ctx.commands.peekField(other, ABILITY_SLOT_COMPONENT, 'phase') ??
        ctx.getByHandle(other, h.phase);
      if (phaseIndex < 0) continue;
      const ability = abilityOf(this.catalog, ctx, h, other);
      applyInterrupt(
        ctx,
        this.catalog,
        ability,
        this.phaseOf(ability, phaseIndex, other),
        other,
        owner,
        INTERRUPT_SUPERSEDE,
        this.victim,
        this.name,
      );
    }
  }

  // ------------------------------------------------------------ прерывания

  /**
   * Источники, видимые по состоянию мира. Проверяются в порядке словаря ABIL-6:
   * порядок наблюдаем исходом — у источников разная судьба кулдауна, — и потому
   * задан здесь явно, а не порядком чтения полей.
   */
  private interrupted(
    ctx: SystemContext,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    phase: CompiledPhase,
  ): boolean {
    const buttons = buttonsOf(ctx, this.catalog, owner);
    const prevButtons = prevButtonsOf(ctx, this.catalog, owner);
    const { deadMarker, actionLock } = this.catalog.bindings;

    // `release` — спад бита триггера в фазе, которая его НЕ потребляет: у фаз
    // `hold` и `release` отпускание есть штатное завершение (ABIL-4), а не срыв,
    // и в них источник не распознаётся вовсе (ABIL-6). Распознаётся он только
    // там, где определение назвало его в `interrupts`: иначе всякая многофазная
    // способность срывалась бы на первом же отпускании кнопки, которым игрок
    // открывает прицеливание.
    if (
      declares(ability, INTERRUPT_RELEASE) &&
      phase.trigger !== PHASE_HOLD &&
      phase.trigger !== PHASE_RELEASE &&
      ability.triggerKind === TRIGGER_INPUT &&
      buttonFell(buttons, prevButtons, ability.triggerBit)
    ) {
      return this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_RELEASE);
    }
    if (buttonEdge(buttons, prevButtons, ability.cancelBit)) {
      return this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_CANCEL_INPUT);
    }
    if (
      declares(ability, INTERRUPT_DISABLE) &&
      actionLock !== undefined &&
      ctx.has(owner, actionLock) &&
      (ctx.get(owner, actionLock, ACTION_LOCK_MASK_FIELD) & ability.disableMask) !== 0
    ) {
      return this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_DISABLE);
    }
    if (deadMarker !== undefined && ctx.has(owner, deadMarker)) {
      return this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_DEATH);
    }
    if (declares(ability, INTERRUPT_DISPLACEMENT) && ability.displacement !== undefined) {
      this.scope.bind(ctx, slot, owner);
      if (predicate(ability.displacement, ctx, this.scope.vars)) {
        return this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_DISPLACEMENT);
      }
    }
    return false;
  }

  private interrupt(
    ctx: SystemContext,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    phase: CompiledPhase,
    source: number,
  ): true {
    applyInterrupt(ctx, this.catalog, ability, phase, slot, owner, source, this.victim, this.name);
    return true;
  }

  // ---------------------------------------------------------------- автомат

  private advance(
    ctx: SystemContext,
    h: SlotHandles,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    phase: CompiledPhase,
    phaseIndex: number,
  ): void {
    const ticks = ctx.getByHandle(slot, h.phaseTicks) + 1;
    this.scope.bind(ctx, slot, owner);
    this.scope.vars.phaseTicks = ticks;

    let completed = false;
    if (phase.trigger === PHASE_HOLD || phase.trigger === PHASE_RELEASE) {
      // Фаза длится, пока держится бит триггера; прекращение удержания завершает
      // её (ABIL-4). У вида `release` тот же самый момент уже записал шаг
      // прицеливания системой на −800, и завершение видит его (ABIL-5, DET-9).
      const buttons = buttonsOf(ctx, this.catalog, owner);
      completed = triggerHoldEnded(ability, buttons);
    } else if (phase.trigger === PHASE_COMMIT) {
      // Фаза подтверждения завершается накоплением всех объявленных шагов, а
      // при их отсутствии — фронтом бита подтверждения (ABIL-4).
      if (ability.stepCount > 0) {
        completed = ctx.getByHandle(slot, h.staged) >= ability.stepCount;
      } else {
        const buttons = buttonsOf(ctx, this.catalog, owner);
        const prevButtons = prevButtonsOf(ctx, this.catalog, owner);
        completed = buttonEdge(buttons, prevButtons, ability.confirmBit);
      }
    }

    if (!completed) {
      const duration =
        phase.durationTicks === undefined
          ? undefined
          : ticksOf(
              evaluate(phase.durationTicks, ctx, this.scope.vars),
              `способность "${ability.id}": фаза "${phase.id}", "durationTicks"`,
            );
      if (duration !== undefined && ticks >= duration) {
        if (phase.timeoutThen === TIMEOUT_CANCEL) {
          this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_TIMEOUT);
          return;
        }
        if (phase.timeoutThen === TIMEOUT_COMMIT) {
          this.complete(ctx, slot, owner, ability, phase, phaseIndex, true, ticks);
          return;
        }
        if (phase.timeoutThen !== TIMEOUT_NONE) {
          this.enter(ctx, slot, owner, ability, phase.timeoutThen, phase, NO_EVENT, ticks);
          return;
        }
        // Блока `timeout` нет: истечение `durationTicks` завершает фазу штатно —
        // это и есть переход вида `auto` (ABIL-4).
        completed = true;
      }
    }

    if (!completed) {
      ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, 'phaseTicks', ticks);
      return;
    }
    this.complete(ctx, slot, owner, ability, phase, phaseIndex, false, ticks);
  }

  /**
   * Завершение фазы: если это фаза, накапливающая шаги (`commit` либо
   * `release`), — проверка накопленных шагов (ABIL-5), затем переход в
   * следующую фазу либо завершение каста. Вид `release` из проверки не выпадает:
   * отпускание есть его подтверждение, и одна и та же потерянная цель обязана
   * срывать каст в обеих фазах одинаково.
   */
  private complete(
    ctx: SystemContext,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    phase: CompiledPhase,
    phaseIndex: number,
    toCommit: boolean,
    ticks: number,
  ): void {
    if (
      (phase.trigger === PHASE_COMMIT || phase.trigger === PHASE_RELEASE) &&
      !stagedStepsValid(ctx, this.catalog, this.scope.handles(ctx), ability, slot, owner, this.scope.vars)
    ) {
      this.interrupt(ctx, slot, owner, ability, phase, INTERRUPT_TARGET_LOST);
      return;
    }
    const next = phaseIndex + 1;
    if (toCommit || next >= ability.phaseCount) {
      this.finish(ctx, slot, owner, ability, phase, NO_EVENT, ticks);
      return;
    }
    this.enter(ctx, slot, owner, ability, next, phase, NO_EVENT, ticks);
  }

  /** Вход в фазу: `onExit` покидаемой, обнуление счётчика, `onEnter` новой. */
  private enter(
    ctx: SystemContext,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    index: number,
    from: CompiledPhase | undefined,
    event: number,
    ticks: number,
  ): void {
    if (from !== undefined) this.execList(ctx, from.onExit, slot, owner, ability, ticks, event);
    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, 'phase', index);
    ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, 'phaseTicks', 0);
    this.execList(ctx, this.phaseOf(ability, index, slot).onEnter, slot, owner, ability, 0, event);
  }

  /**
   * Завершение каста: `onExit` последней фазы, `effects` определения и
   * взведение кулдауна (ABIL-4, ABIL-7).
   */
  private finish(
    ctx: SystemContext,
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    phase: CompiledPhase | undefined,
    event: number,
    ticks: number,
  ): void {
    if (phase !== undefined) this.execList(ctx, phase.onExit, slot, owner, ability, ticks, event);
    this.execList(ctx, ability.effects, slot, owner, ability, ticks, event);
    this.scope.bind(ctx, slot, owner);
    this.scope.vars.phaseTicks = ticks;
    const total = cooldownTicksOf(ctx, ability, this.scope.vars);
    setCooldown(ctx, slot, total, total);
    const set = (field: string, value: number): void => {
      ctx.commands.setField(slot, ABILITY_SLOT_COMPONENT, field, value);
    };
    set('phase', NO_PHASE);
    set('phaseTicks', 0);
    set('staged', 0);
    set('lastInterrupt', NO_INTERRUPT);
  }

  /**
   * Исполнение списка действий в области видимости слота. Ошибка внутри — та же
   * ошибка класса 3, что у системы из данных (SYS-9), и называть она обязана то
   * же: систему, путь до узла и причину.
   */
  private execList(
    ctx: SystemContext,
    actions: readonly Action[],
    slot: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    ticks: number,
    event: number,
  ): void {
    if (actions.length === 0) return;
    this.scope.bind(ctx, slot, owner);
    this.scope.vars.phaseTicks = ticks;
    if (event >= 0 && ability.triggerKind === TRIGGER_EVENT) {
      this.scope.vars[ability.eventAs] = event;
    }
    try {
      execute(actions, ctx, this.scope.vars);
    } catch (cause) {
      throw systemError(this.name, cause);
    }
  }
}

/** Объявлен ли источник определением (маска ABIL-6). */
function declares(ability: CompiledAbility, source: number): boolean {
  return (ability.declared & sourceMask(source)) !== 0;
}

/** Первое событие названного типа на шине текущего тика (EVT-2) либо −1. */
function findEvent(ctx: SystemContext, type: string): number {
  const published = ctx.events.length;
  for (let i = 0; i < published; i++) {
    if (ctx.events.at(i).type === type) return i;
  }
  return NO_EVENT;
}
