/**
 * Кулдауны (ABIL-7), `order` 800 (DET-9).
 *
 * Убывание стоит ПОСЛЕ систем сцены, а гейт триггера читает поле в начале тика
 * (`CastPhaseSystem`, −790): кулдаун длительностью N тиков даёт ровно N тиков
 * между двумя кастами независимо от того, какие `order` выбрал автор сцены
 * своим системам. Убывание в начале тика отняло бы один тик у каждого кулдауна.
 *
 * Счётчик идёт в ГЛОБАЛЬНЫХ тиках, а не в эффективном времени сущности —
 * документированный выбор, который TIME-4 оставляет каждой системе (design
 * Decision 9): целочисленный счётчик остаётся целочисленным, а числа
 * определений остаются теми же тиками, что в конфиге.
 */
import { ABILITY_COOLDOWN_COMPONENT } from './components.js';
import type { QuerySpec, System, SystemContext } from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 800;

export class CooldownSystem implements System {
  readonly name = 'Cooldown';
  readonly order = ANCHOR_ORDER;
  private readonly spec: QuerySpec = { all: [ABILITY_COOLDOWN_COMPONENT] };

  run(ctx: SystemContext): void {
    for (const slot of ctx.query(this.spec)) {
      const remaining = ctx.get(slot, ABILITY_COOLDOWN_COMPONENT, 'remaining');
      if (remaining <= 0) continue;
      ctx.commands.setField(slot, ABILITY_COOLDOWN_COMPONENT, 'remaining', remaining - 1);
    }
  }
}
