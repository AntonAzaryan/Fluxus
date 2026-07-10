/**
 * AttachedToSyncSystem
 * Стадия: Simulation
 *
 * Удерживает сущности с AttachedTo (например, щит) на фиксированном
 * смещении от владельца: Position = owner.Position + offset.
 * Выполняется до стадии Physics, чтобы обновлённая позиция
 * участвовала в разрешении коллизий этого же тика.
 */

import { GameWorld } from '../ecs/world';
import { add } from '../fixed/fixed';

export function attachedToSyncSystem(world: GameWorld): void {
  const attachedEntities = world.with('AttachedTo');

  for (const entity of attachedEntities) {
    const attachedTo = entity.AttachedTo!;
    const owner = world.get(attachedTo.owner_id);

    if (!owner || !owner.Position || !entity.Position) continue;

    entity.Position.x = add(owner.Position.x, attachedTo.offset_x);
    entity.Position.y = add(owner.Position.y, attachedTo.offset_y);
  }
}
