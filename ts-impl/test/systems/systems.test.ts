/**
 * Интеграционные тесты систем
 */

import { describe, it, expect } from 'vitest';
import { GameWorld } from '../../src/ecs/world';
import { EventBus } from '../../src/ecs/events';
import { Resources, InputCommand } from '../../src/resources/resources';
import { createPlayerArchetype } from '../../src/archetypes/player';
import { defaultGameConfig } from '../../src/gameConfig';
import { toFixed, ONE, ZERO } from '../../src/fixed/fixed';
import { playerCommandIngestSystem } from '../../src/systems/playerCommandIngest';
import { fireballCastSystem } from '../../src/systems/fireballCast';
import { cooldownTickSystem } from '../../src/systems/cooldownTick';
import { Position, Velocity, Collider, DynamicBody, Health, Cooldowns, MoveIntent, CollisionLayer } from '../../src/components/types';

function createTestResources(): Resources {
  return {
    gameConfig: defaultGameConfig,
    timeState: { current_tick: BigInt(0), time_scale: ONE },
    rngState: { state: BigInt(0), inc: BigInt(0) },
    entityAllocatorState: { next_id: BigInt(1) },
    inputBuffer: { commands: [] },
    timeSlowState: { expires_tick: BigInt(0) },
  };
}

describe('Integration: Systems', () => {
  it('should cast fireball from player', () => {
    const world = new GameWorld();
    const bus = new EventBus();
    const resources = createTestResources();

    const archetype = createPlayerArchetype();
    const playerId = world.spawn({
      Position: new Position(toFixed(0), toFixed(0), toFixed(0)),
      Velocity: archetype.Velocity,
      Collider: archetype.Collider,
      DynamicBody: archetype.DynamicBody,
      Health: archetype.Health,
      Cooldowns: archetype.Cooldowns,
      MoveIntent: archetype.MoveIntent,
      CollisionLayer: archetype.CollisionLayer,
    });

    const commands: InputCommand[] = [
      {
        type: 'CastFireballInput',
        player_id: playerId,
        target_x: toFixed(100),
        target_y: toFixed(0),
        target_z: toFixed(0),
      },
    ];

    resources.inputBuffer.commands = commands;

    bus.clear();
    playerCommandIngestSystem(world, resources, bus);
    fireballCastSystem(world, resources, bus);

    const projectiles = world.with('Projectile');
    expect(projectiles.length).toBe(1);

    const fireball = projectiles[0];
    expect(fireball.Projectile?.owner_id).toBe(playerId);
    expect(fireball.Velocity?.dx).toBeGreaterThan(BigInt(0));
  });

  it('should respect fireball cooldown', () => {
    const world = new GameWorld();
    const bus = new EventBus();
    const resources = createTestResources();

    const archetype = createPlayerArchetype();
    const playerId = world.spawn({
      Position: new Position(toFixed(0), toFixed(0), toFixed(0)),
      Velocity: archetype.Velocity,
      Collider: archetype.Collider,
      DynamicBody: archetype.DynamicBody,
      Health: archetype.Health,
      Cooldowns: archetype.Cooldowns,
      MoveIntent: archetype.MoveIntent,
      CollisionLayer: archetype.CollisionLayer,
    });

    // Первый каст
    const commands: InputCommand[] = [
      {
        type: 'CastFireballInput',
        player_id: playerId,
        target_x: toFixed(100),
        target_y: toFixed(0),
        target_z: toFixed(0),
      },
    ];
    resources.inputBuffer.commands = commands;

    bus.clear();
    playerCommandIngestSystem(world, resources, bus);
    fireballCastSystem(world, resources, bus);

    // Кулдаун установлен
    const player = world.get(playerId);
    expect(player?.Cooldowns?.fireball).toBe(defaultGameConfig.fireball_cooldown);

    // Второй каст (должен быть заблокирован)
    bus.clear();
    playerCommandIngestSystem(world, resources, bus);
    fireballCastSystem(world, resources, bus);

    // Всё ещё один фаербол
    const projectiles = world.with('Projectile');
    expect(projectiles.length).toBe(1);
  });

  it('should tick cooldowns down', () => {
    const world = new GameWorld();
    const resources = createTestResources();

    const archetype = createPlayerArchetype();
    const playerId = world.spawn({
      Position: archetype.Position,
      Velocity: archetype.Velocity,
      Collider: archetype.Collider,
      DynamicBody: archetype.DynamicBody,
      Health: archetype.Health,
      Cooldowns: new Cooldowns(toFixed(100), ZERO, ZERO, ZERO),
      MoveIntent: archetype.MoveIntent,
      CollisionLayer: archetype.CollisionLayer,
    });
    const player = world.get(playerId)!;

    // Тик кулдаунов
    cooldownTickSystem(world, resources);

    // Кулдаун уменьшился на ms_per_tick
    expect(player.Cooldowns!.fireball).toBeLessThan(toFixed(100));
  });
});
