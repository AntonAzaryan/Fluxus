/**
 * Компоненты ECS как классы для miniplex
 * spec/components/*.yaml — 16 компонентов
 * 
 * Все числовые поля используют fixed-point (bigint)
 */

import { Fixed } from '../fixed/fixed';

/**
 * Position: координаты сущности в мире 2.5D
 */
export class Position {
  x: Fixed;
  y: Fixed;
  z: Fixed;

  constructor(x: Fixed, y: Fixed, z: Fixed) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

/**
 * Velocity: вектор скорости (единиц/сек)
 */
export class Velocity {
  dx: Fixed;
  dy: Fixed;
  dz: Fixed;

  constructor(dx: Fixed, dy: Fixed, dz: Fixed) {
    this.dx = dx;
    this.dy = dy;
    this.dz = dz;
  }
}

/**
 * Collider: физический коллайдер сущности
 */
export class Collider {
  shape: 'circle' | 'aabb';
  radius: Fixed;
  half_width: Fixed;
  half_height: Fixed;
  height: Fixed;

  constructor(
    shape: 'circle' | 'aabb',
    radius: Fixed,
    half_width: Fixed,
    half_height: Fixed,
    height: Fixed
  ) {
    this.shape = shape;
    this.radius = radius;
    this.half_width = half_width;
    this.half_height = half_height;
    this.height = height;
  }
}

/**
 * CollisionLayer: битовая маска слоя и взаимодействия
 */
export class CollisionLayer {
  layer: number;
  mask: number;

  constructor(layer: number, mask: number) {
    this.layer = layer;
    this.mask = mask;
  }
}

/**
 * Cooldowns: кулдауны способностей (в мс как fixed-point)
 */
export class Cooldowns {
  fireball: Fixed;
  shield: Fixed;
  dash: Fixed;
  time_slow: Fixed;

  constructor(fireball: Fixed, shield: Fixed, dash: Fixed, time_slow: Fixed) {
    this.fireball = fireball;
    this.shield = shield;
    this.dash = dash;
    this.time_slow = time_slow;
  }
}

/**
 * Health: текущее и максимальное здоровье
 */
export class Health {
  current: Fixed;
  max: Fixed;

  constructor(current: Fixed, max: Fixed) {
    this.current = current;
    this.max = max;
  }
}

/**
 * Dash: компонент активного рывка
 */
export class Dash {
  start_tick: bigint;
  duration_ms: Fixed;
  dir_x: Fixed;
  dir_y: Fixed;
  dir_z: Fixed;

  constructor(
    start_tick: bigint,
    duration_ms: Fixed,
    dir_x: Fixed,
    dir_y: Fixed,
    dir_z: Fixed
  ) {
    this.start_tick = start_tick;
    this.duration_ms = duration_ms;
    this.dir_x = dir_x;
    this.dir_y = dir_y;
    this.dir_z = dir_z;
  }
}

/**
 * Projectile: маркер снаряда
 */
export class Projectile {
  owner_id: bigint;
  damage: Fixed;
  max_distance: Fixed;
  traveled_distance: Fixed;

  constructor(
    owner_id: bigint,
    damage: Fixed,
    max_distance: Fixed,
    traveled_distance: Fixed
  ) {
    this.owner_id = owner_id;
    this.damage = damage;
    this.max_distance = max_distance;
    this.traveled_distance = traveled_distance;
  }
}

/**
 * Lifetime: тик истечения существования сущности
 */
export class Lifetime {
  expires_tick: bigint;

  constructor(expires_tick: bigint) {
    this.expires_tick = expires_tick;
  }
}

/**
 * MoveIntent: намерение движения от игрока (-1.0 .. 1.0)
 */
export class MoveIntent {
  dx: Fixed;
  dy: Fixed;
  dz: Fixed;

  constructor(dx: Fixed, dy: Fixed, dz: Fixed) {
    this.dx = dx;
    this.dy = dy;
    this.dz = dz;
  }
}

/**
 * LocalTimeScale: локальный множитель времени
 */
export class LocalTimeScale {
  scale: Fixed;

  constructor(scale: Fixed) {
    this.scale = scale;
  }
}

/**
 * TimeSlowImmune: маркер иммунитета к замедлению времени
 */
export class TimeSlowImmune {
  // Маркер без полей
}

/**
 * DynamicBody: маркер динамического физического тела
 */
export class DynamicBody {
  mass: Fixed;
  restitution: Fixed;
  friction: Fixed;

  constructor(mass: Fixed, restitution: Fixed, friction: Fixed) {
    this.mass = mass;
    this.restitution = restitution;
    this.friction = friction;
  }
}

/**
 * StaticBody: маркер статичного физического тела
 */
export class StaticBody {
  // Маркер без полей
}

/**
 * Dead: маркер смерти сущности
 */
export class Dead {
  respawn_tick: bigint;

  constructor(respawn_tick: bigint) {
    this.respawn_tick = respawn_tick;
  }
}

/**
 * AttachedTo: привязка сущности к владельцу.
 * offset_x/offset_y — смещение относительно Position владельца (в мировых
 * единицах, XY), поддерживается каждый тик AttachedToSyncSystem.
 */
export class AttachedTo {
  owner_id: bigint;
  offset_x: Fixed;
  offset_y: Fixed;

  constructor(owner_id: bigint, offset_x: Fixed, offset_y: Fixed) {
    this.owner_id = owner_id;
    this.offset_x = offset_x;
    this.offset_y = offset_y;
  }
}

// Экспорт всех типов компонентов для использования в ECS
export type ComponentTypes = {
  Position: Position;
  Velocity: Velocity;
  Collider: Collider;
  CollisionLayer: CollisionLayer;
  Cooldowns: Cooldowns;
  Health: Health;
  Dash: Dash;
  Projectile: Projectile;
  Lifetime: Lifetime;
  MoveIntent: MoveIntent;
  LocalTimeScale: LocalTimeScale;
  TimeSlowImmune: TimeSlowImmune;
  DynamicBody: DynamicBody;
  StaticBody: StaticBody;
  Dead: Dead;
  AttachedTo: AttachedTo;
};
