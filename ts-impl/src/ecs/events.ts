/**
 * EventBus: буфер событий для одного тика
 * 
 * События копятся в общий буфер тика, очищаются раз в тик перед стадией Input
 * (conventions.md §6)
 */

/**
 * Типы событий из spec/events/*.yaml
 */
export interface MoveCommand {
  tick: bigint;
  player_id: bigint;
  dx: bigint;
  dy: bigint;
  dz: bigint;
}

export interface CastFireball {
  tick: bigint;
  player_id: bigint;
  caster_id: bigint;
  target_x: bigint;
  target_y: bigint;
  target_z: bigint;
}

export interface CastShield {
  tick: bigint;
  player_id: bigint;
  caster_id: bigint;
  target_x: bigint;
  target_y: bigint;
  target_z: bigint;
}

export interface DashCommand {
  tick: bigint;
  player_id: bigint;
}

export interface CastTimeSlow {
  tick: bigint;
  player_id: bigint;
  caster_id: bigint;
}

export interface Collision {
  entity_a: bigint;
  entity_b: bigint;
  contact_point: { x: bigint; y: bigint; z: bigint };
  normal: { x: bigint; y: bigint; z: bigint };
  penetration: bigint;
}

export interface DamageCommand {
  target_id: bigint;
  source_id: bigint;
  damage: bigint;
  damage_type: string;
}

/**
 * Union всех типов событий
 */
export type EventType =
  | 'MoveCommand'
  | 'CastFireball'
  | 'CastShield'
  | 'DashCommand'
  | 'CastTimeSlow'
  | 'Collision'
  | 'DamageCommand';

export type EventData =
  | MoveCommand
  | CastFireball
  | CastShield
  | DashCommand
  | CastTimeSlow
  | Collision
  | DamageCommand;

/**
 * EventBus: Map<event_name, events[]>
 */
export class EventBus {
  private buffer: Map<string, EventData[]> = new Map();

  /**
   * Испустить событие
   */
  emit<T extends EventData>(eventName: string, event: T): void {
    const events = this.buffer.get(eventName) || [];
    events.push(event);
    this.buffer.set(eventName, events);
  }

  /**
   * Получить все события типа
   */
  get<T extends EventData>(eventName: string): T[] {
    return (this.buffer.get(eventName) || []) as T[];
  }

  /**
   * Получить все события (для итерации)
   */
  entries(): IterableIterator<[string, EventData[]]> {
    return this.buffer.entries();
  }

  /**
   * Очистить весь буфер (раз в тик перед стадией Input)
   */
  clear(): void {
    this.buffer.clear();
  }

  /**
   * Проверить наличие событий
   */
  hasEvents(eventName: string): boolean {
    const events = this.buffer.get(eventName);
    return events !== undefined && events.length > 0;
  }
}
