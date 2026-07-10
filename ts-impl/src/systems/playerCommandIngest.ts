/**
 * PlayerCommandIngestSystem
 * Стадия: Input
 * 
 * Читает сырые команды из InputBuffer и конвертирует их
 * в события-команды для систем способностей.
 */

import { GameWorld } from '../ecs/world';
import { EventBus } from '../ecs/events';
import { Resources, InputCommand } from '../resources/resources';
import { ComponentTypes } from '../components/types';

export function playerCommandIngestSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const { inputBuffer, timeState } = resources;
  const commands = inputBuffer.commands;

  console.log('[playerCommandIngest] Processing', commands.length, 'commands');

  for (const command of commands) {
    console.log('[playerCommandIngest] Command:', command.type, command.player_id);
    switch (command.type) {
      case 'MoveCommandInput': {
        // Проверка: сущность существует и не мертва
        if (world.has(command.player_id)) {
          const health = world.get(command.player_id)?.Health;
          const dead = world.get(command.player_id)?.Dead;

          console.log('[playerCommandIngest] MoveCommand:', command.player_id, 'health:', health, 'dead:', dead);

          if (health && !dead) {
            bus.emit('MoveCommand', {
              tick: timeState.current_tick,
              player_id: command.player_id,
              dx: command.dx,
              dy: command.dy,
              dz: command.dz,
            });
            console.log('[playerCommandIngest] Emitted MoveCommand');
          }
        }
        break;
      }

      case 'CastFireballInput': {
        if (world.has(command.player_id)) {
          const health = world.get(command.player_id)?.Health;
          const dead = world.get(command.player_id)?.Dead;
          
          if (health && !dead) {
            bus.emit('CastFireball', {
              tick: timeState.current_tick,
              player_id: command.player_id,
              caster_id: command.player_id,
              target_x: command.target_x,
              target_y: command.target_y,
              target_z: command.target_z,
            });
          }
        }
        break;
      }

      case 'CastShieldInput': {
        if (world.has(command.player_id)) {
          const health = world.get(command.player_id)?.Health;
          const dead = world.get(command.player_id)?.Dead;
          
          if (health && !dead) {
            bus.emit('CastShield', {
              tick: timeState.current_tick,
              player_id: command.player_id,
              caster_id: command.player_id,
              target_x: command.target_x,
              target_y: command.target_y,
              target_z: command.target_z,
            });
          }
        }
        break;
      }

      case 'DashInput': {
        if (world.has(command.player_id)) {
          const health = world.get(command.player_id)?.Health;
          const dead = world.get(command.player_id)?.Dead;
          
          if (health && !dead) {
            bus.emit('DashCommand', {
              tick: timeState.current_tick,
              player_id: command.player_id,
            });
          }
        }
        break;
      }

      case 'CastTimeSlowInput': {
        if (world.has(command.player_id)) {
          const health = world.get(command.player_id)?.Health;
          const dead = world.get(command.player_id)?.Dead;
          
          if (health && !dead) {
            bus.emit('CastTimeSlow', {
              tick: timeState.current_tick,
              player_id: command.player_id,
              caster_id: command.player_id,
            });
          }
        }
        break;
      }
    }
  }

  // Очистить буфер после обработки
  inputBuffer.commands = [];
}
