/**
 * Types for game state that renderer consumes
 * Mirrors ts-impl component structure for rendering
 */

/**
 * Fixed-point value (from ts-impl)
 * For rendering, we convert to number
 */
export type Fixed = bigint;

/**
 * 3D Vector in fixed-point
 */
export interface Vec3Fixed {
  x: Fixed;
  y: Fixed;
  z: Fixed;
}

/**
 * Entity with components for rendering
 */
export interface Entity {
  id: bigint;
  Position?: { x: Fixed; y: Fixed; z: Fixed };
  Velocity?: { dx: Fixed; dy: Fixed; dz: Fixed };
  Collider?: {
    shape: 'circle' | 'aabb';
    radius: Fixed;
    half_width: Fixed;
    half_height: Fixed;
    height: Fixed;
  };
  Health?: { current: Fixed; max: Fixed };
  Projectile?: { owner_id: bigint; damage: Fixed };
  Dash?: { start_tick: bigint; duration_ms: Fixed; dir_x: Fixed; dir_y: Fixed; dir_z: Fixed };
  StaticBody?: {};
  AttachedTo?: { owner_id: bigint; offset_x: Fixed; offset_y: Fixed };
}

/**
 * Game state snapshot for rendering
 */
export interface GameState {
  tick: bigint;
  entities: Entity[];
}
