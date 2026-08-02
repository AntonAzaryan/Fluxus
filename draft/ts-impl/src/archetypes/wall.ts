/**
 * Архетип Wall
 * spec/archetypes/wall.yaml
 */

import { Position, Collider, StaticBody, CollisionLayer } from '../components/types';
import { toFixed } from '../fixed/fixed';

export function createWallArchetype(
  overrides?: Partial<{
    Position: Position;
    Collider: Collider;
    StaticBody: StaticBody;
    CollisionLayer: CollisionLayer;
  }>
): {
  Position: Position;
  Collider: Collider;
  StaticBody: StaticBody;
  CollisionLayer: CollisionLayer;
} {
  return {
    Position: overrides?.Position || new Position(toFixed(0), toFixed(0), toFixed(0)),
    Collider:
      overrides?.Collider ||
      new Collider('aabb', toFixed(0), toFixed(50.0), toFixed(50.0), toFixed(100.0)),
    StaticBody: overrides?.StaticBody || new StaticBody(),
    CollisionLayer: overrides?.CollisionLayer || new CollisionLayer(2, 0b1111),
  };
}
