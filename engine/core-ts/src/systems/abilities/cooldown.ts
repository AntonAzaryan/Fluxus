/**
 * Кулдауны (ABIL-7), `order` 800 (DET-9).
 *
 * Убывание стоит ПОСЛЕ систем сцены, а гейт триггера читает поле в начале тика
 * (`CastPhaseSystem`, −790): кулдаун длительностью N тиков даёт ровно N тиков
 * между двумя кастами независимо от того, какие `order` выбрал автор сцены
 * своим системам. Убывание в начале тика отняло бы один тик у каждого кулдауна.
 *
 * TimeScale (TIME-5): игнорирует — остаток убывает на единицу за ГЛОБАЛЬНЫЙ
 * тик, а не в эффективном времени сущности; выбор, который TIME-4 оставляет
 * каждой системе (design Decision 9): целочисленный счётчик остаётся
 * целочисленным, а числа определений остаются теми же тиками, что в конфиге.
 */
import { ABILITY_COOLDOWN_COMPONENT } from './components.js';
import { resolveCooldownHandles, type CooldownHandles } from './handles.js';
import type { QuerySpec, System, SystemContext } from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 800;

export class CooldownSystem implements System {
  readonly name = 'Cooldown';
  readonly order = ANCHOR_ORDER;
  private readonly spec: QuerySpec = { all: [ABILITY_COOLDOWN_COMPONENT] };
  /** Handle поля остатка (SYS-10): один раз, на первом входе, после раннего выхода. */
  private handles: CooldownHandles | undefined;

  run(ctx: SystemContext): void {
    const slots = ctx.query(this.spec);
    if (slots.length === 0) return;
    const h = (this.handles ??= resolveCooldownHandles(ctx));
    for (const slot of slots) {
      const remaining = ctx.getByHandle(slot, h.remaining);
      if (remaining <= 0) continue;
      ctx.commands.setField(slot, ABILITY_COOLDOWN_COMPONENT, 'remaining', remaining - 1);
    }
  }
}
