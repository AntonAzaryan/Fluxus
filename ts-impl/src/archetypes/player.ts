/**
 * Архетип Player
 * spec/archetypes/player.yaml
 */

import {
  Position,
  Velocity,
  Collider,
  DynamicBody,
  Health,
  Cooldowns,
  MoveIntent,
  CollisionLayer,
} from '../components/types';
import { toFixed } from '../fixed/fixed';
import { defaultGameConfig } from '../gameConfig';

export function createPlayerArchetype(
  overrides?: Partial<{
    Position: Position;
    Velocity: Velocity;
    Collider: Collider;
    DynamicBody: DynamicBody;
    Health: Health;
    Cooldowns: Cooldowns;
    MoveIntent: MoveIntent;
    CollisionLayer: CollisionLayer;
  }>
): {
  Position: Position;
  Velocity: Velocity;
  Collider: Collider;
  DynamicBody: DynamicBody;
  Health: Health;
  Cooldowns: Cooldowns;
  MoveIntent: MoveIntent;
  CollisionLayer: CollisionLayer;
} {
  return {
    Position: overrides?.Position || new Position(toFixed(0), toFixed(0), toFixed(0)),
    Velocity: overrides?.Velocity || new Velocity(toFixed(0), toFixed(0), toFixed(0)),
    Collider:
      overrides?.Collider ||
      new Collider('circle', defaultGameConfig.player_radius, toFixed(0), toFixed(0), toFixed(30.0)),
    DynamicBody:
      overrides?.DynamicBody || new DynamicBody(toFixed(1.0), toFixed(0.0), toFixed(0.8)),
    Health:
      overrides?.Health ||
      new Health(defaultGameConfig.player_max_health, defaultGameConfig.player_max_health),
    Cooldowns:
      overrides?.Cooldowns || new Cooldowns(toFixed(0), toFixed(0), toFixed(0), toFixed(0)),
    MoveIntent: overrides?.MoveIntent || new MoveIntent(toFixed(0), toFixed(0), toFixed(0)),
    CollisionLayer: overrides?.CollisionLayer || new CollisionLayer(1, 0b111),
  };
}
