/**
 * Эффект с собственной длительностью (ABIL-9), `order` 810 (DET-9).
 *
 * Купол, зона, оболочка, тот же снаряд: сущность с компонентом длительности
 * убывает по тикам и при исчерпании исполняет список действий истечения и
 * удаляется. Рукописной системы «тикнуть и снять» на каждую зону не пишется.
 *
 * Граница с баффом проходит по носителю: эффект, живущий НА цели свойством или
 * модификатором, есть бафф, а эффект, живущий В мире собственной сущностью, —
 * этот механизм.
 *
 * Стоит сразу за кулдаунами и раньше сведения баффов: истекающая зона снимает
 * наложенные ею баффы своим списком действий, и сведение этих снятий обязано
 * попасть в тот же тик, а не в следующий (DET-9).
 *
 * TimeScale (TIME-5): игнорирует — остаток убывает на единицу за ГЛОБАЛЬНЫЙ тик
 * (design Decision 9, тот же выбор, что у кулдаунов и баффов). Следствие для
 * дизайна: замедление не растягивает жизнь купола или зоны.
 */
import { execute, systemError } from '../../dsl/actions.js';
import { ABILITY_DURATION_COMPONENT } from './components.js';
import { resolveDurationHandles, type DurationHandles } from './handles.js';
import type { ExprVarsRecord } from './runtime.js';
import type { AbilityCatalog } from './model.js';
import type { QuerySpec, System, SystemContext } from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 810;

export class EffectDurationSystem implements System {
  readonly name = 'EffectDuration';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  private readonly spec: QuerySpec = { all: [ABILITY_DURATION_COMPONENT] };
  /** Переиспользуемая область видимости списка истечения (ABIL-10). */
  private readonly vars: ExprVarsRecord = { self: 0, owner: 0 };
  /** Handle полей длительности (SYS-10): один раз, на первом входе, после раннего выхода. */
  private handles: DurationHandles | undefined;

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
  }

  run(ctx: SystemContext): void {
    const effects = ctx.query(this.spec);
    if (effects.length === 0) return;
    const h = (this.handles ??= resolveDurationHandles(ctx));
    for (const effect of effects) {
      const remaining = ctx.getByHandle(effect, h.remaining);
      if (remaining <= 0) continue;
      ctx.commands.setField(effect, ABILITY_DURATION_COMPONENT, 'remaining', remaining - 1);
      if (remaining > 1) continue;

      const index = ctx.getByHandle(effect, h.abilityId);
      const ability = this.catalog.abilities[index];
      if (ability === undefined) {
        throw new Error(
          `эффект ${effect} ссылается на определение способности ${index}, ` +
            `в таблице их ${this.catalog.abilities.length}`,
        );
      }
      if (ability.onExpire.length > 0) {
        this.vars.self = effect;
        this.vars.owner = ctx.getByHandle(effect, h.owner);
        try {
          execute(ability.onExpire, ctx, this.vars);
        } catch (cause) {
          throw systemError(this.name, cause);
        }
      }
      ctx.commands.destroy(effect);
    }
  }
}
