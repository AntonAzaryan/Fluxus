/**
 * Архетип Fireball
 * spec/archetypes/fireball.yaml
 */

import {
  Position,
  Velocity,
  Collider,
  DynamicBody,
  Projectile,
  LocalTimeScale,
  CollisionLayer,
} from '../components/types';
import { toFixed } from '../fixed/fixed';
import { defaultGameConfig } from '../gameConfig';

export function createFireballArchetype(
  overrides?: Partial<{
    Position: Position;
    Velocity: Velocity;
    Collider: Collider;
    DynamicBody: DynamicBody;
    Projectile: Projectile;
    LocalTimeScale: LocalTimeScale;
    CollisionLayer: CollisionLayer;
  }>
): {
  Position: Position;
  Velocity: Velocity;
  Collider: Collider;
  DynamicBody: DynamicBody;
  Projectile: Projectile;
  LocalTimeScale: LocalTimeScale;
  CollisionLayer: CollisionLayer;
} {
  return {
    Position: overrides?.Position || new Position(toFixed(0), toFixed(0), toFixed(0)),
    Velocity: overrides?.Velocity || new Velocity(toFixed(0), toFixed(0), toFixed(0)),
    Collider:
      overrides?.Collider ||
      new Collider('circle', defaultGameConfig.fireball_radius, toFixed(0), toFixed(0), toFixed(10.0)),
    DynamicBody: overrides?.DynamicBody || new DynamicBody(toFixed(0.1), toFixed(1.0), toFixed(0.0)),
    Projectile:
      overrides?.Projectile ||
      new Projectile(
        BigInt(0),
        defaultGameConfig.fireball_damage,
        defaultGameConfig.fireball_max_distance,
        toFixed(0)
      ),
    LocalTimeScale: overrides?.LocalTimeScale || new LocalTimeScale(toFixed(1.0)),
    CollisionLayer: overrides?.CollisionLayer || new CollisionLayer(8, 0b111),
  };
}
