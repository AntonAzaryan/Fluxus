/**
 * MoveIntentSystem
 * Стадия: Intent
 * 
 * Читает события MoveCommand и устанавливает компонент MoveIntent.
 */

import { GameWorld } from '../ecs/world';
import { EventBus, MoveCommand } from '../ecs/events';
import { MoveIntent } from '../components/types';

export function moveIntentSystem(
  world: GameWorld,
  bus: EventBus
): void {
  // Сначала очистить все MoveIntent (пересоздать каждый тик)
  const entitiesWithMoveIntent = world.with('MoveIntent');

  for (const entity of entitiesWithMoveIntent) {
    entity.MoveIntent.dx = BigInt(0);
    entity.MoveIntent.dy = BigInt(0);
    entity.MoveIntent.dz = BigInt(0);
  }

  // Обработать команды движения
  const moveCommands = bus.get<MoveCommand>('MoveCommand');

  for (const command of moveCommands) {
    const entity = world.get(command.player_id);

    if (entity && entity.MoveIntent) {
      entity.MoveIntent.dx = command.dx;
      entity.MoveIntent.dy = command.dy;
      entity.MoveIntent.dz = command.dz;
    }
  }
}
