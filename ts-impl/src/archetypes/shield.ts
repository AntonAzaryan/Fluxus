/**
 * Архетип Shield
 * spec/archetypes/shield.yaml
 */

import {
  Position,
  Collider,
  StaticBody,
  Health,
  AttachedTo,
  Lifetime,
  CollisionLayer,
} from '../components/types';
import { toFixed } from '../fixed/fixed';
import { defaultGameConfig } from '../gameConfig';

export function createShieldArchetype(
  overrides?: Partial<{
    Position: Position;
    Collider: Collider;
    StaticBody: StaticBody;
    Health: Health;
    AttachedTo: AttachedTo;
    Lifetime: Lifetime;
    CollisionLayer: CollisionLayer;
  }>
): {
  Position: Position;
  Collider: Collider;
  StaticBody: StaticBody;
  Health: Health;
  AttachedTo: AttachedTo;
  Lifetime: Lifetime;
  CollisionLayer: CollisionLayer;
} {
  return {
    Position: overrides?.Position || new Position(toFixed(0), toFixed(0), toFixed(0)),
    Collider:
      overrides?.Collider ||
      new Collider('circle', defaultGameConfig.shield_radius, toFixed(0), toFixed(0), toFixed(50.0)),
    StaticBody: overrides?.StaticBody || new StaticBody(),
    Health:
      overrides?.Health || new Health(defaultGameConfig.shield_health, defaultGameConfig.shield_health),
    AttachedTo: overrides?.AttachedTo || new AttachedTo(BigInt(0)),
    Lifetime: overrides?.Lifetime || new Lifetime(BigInt(0)),
    CollisionLayer: overrides?.CollisionLayer || new CollisionLayer(4, 0b1010),
  };
}
