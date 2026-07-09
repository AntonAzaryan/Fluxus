/**
 * Ресурсы ECS
 * spec/resources/*.yaml — 6 ресурсов
 * 
 * Ресурсы — это мутируемый объект (не в ECS),
 * tick() мутирует переданный state in-place
 */

import { Fixed } from '../fixed/fixed';
import { ComponentTypes } from '../components/types';

/**
 * GameConfig: глобальные параметры баланса
 * Все значения в fixed-point, читаются из spec/resources/game_config.yaml
 */
export interface GameConfig {
  // Персонаж
  player_move_speed: Fixed;
  player_max_health: Fixed;
  player_radius: Fixed;

  // Фаербол (Q)
  fireball_speed: Fixed;
  fireball_max_distance: Fixed;
  fireball_damage: Fixed;
  fireball_radius: Fixed;
  fireball_cooldown: Fixed;

  // Щит (E)
  shield_spawn_distance: Fixed;
  shield_arc_degrees: Fixed;
  shield_lifetime_ms: Fixed;
  shield_health: Fixed;
  shield_radius: Fixed;
  shield_cooldown: Fixed;

  // Рывок (Space)
  dash_speed: Fixed;
  dash_duration_ms: Fixed;
  dash_cooldown_ms: Fixed;

  // Замедление времени (R)
  time_slow_duration_ms: Fixed;
  time_slow_cooldown_ms: Fixed;
  time_slow_scale: Fixed;

  // Респавн
  respawn_delay_ms: Fixed;

  // Физика
  gravity: Fixed;

  // Время
  ms_per_tick: Fixed;
}

/**
 * TimeState: состояние времени симуляции
 */
export interface TimeState {
  current_tick: bigint; // u64
  time_scale: Fixed;    // 1.0 = норма, 0.5 = slow-mo
}

/**
 * RngState: состояние PCG32 RNG
 */
export interface RngStateResource {
  state: bigint; // u64
  inc: bigint;   // u64
}

/**
 * EntityAllocatorState: состояние аллокатора entity_id
 * next_id монотонно растёт, никогда не переиспользуется
 */
export interface EntityAllocatorState {
  next_id: bigint; // u64, начинается с 1
}

/**
 * InputBuffer: буфер ввода команд игрока
 * Команды кладутся внешним слоем, читаются PlayerCommandIngestSystem
 */
export interface InputBuffer {
  commands: InputCommand[];
}

/**
 * Типы входных команд
 */
export type InputCommand =
  | MoveCommandInput
  | CastFireballInput
  | CastShieldInput
  | DashInput
  | CastTimeSlowInput;

export interface MoveCommandInput {
  type: 'MoveCommandInput';
  player_id: bigint;
  dx: Fixed;
  dy: Fixed;
  dz: Fixed;
}

export interface CastFireballInput {
  type: 'CastFireballInput';
  player_id: bigint;
  target_x: Fixed;
  target_y: Fixed;
  target_z: Fixed;
}

export interface CastShieldInput {
  type: 'CastShieldInput';
  player_id: bigint;
  target_x: Fixed;
  target_y: Fixed;
  target_z: Fixed;
}

export interface DashInput {
  type: 'DashInput';
  player_id: bigint;
}

export interface CastTimeSlowInput {
  type: 'CastTimeSlowInput';
  player_id: bigint;
}

/**
 * TimeSlowState: состояние эффекта глобального замедления времени
 * expires_tick == 0 означает, что эффект не активен
 */
export interface TimeSlowState {
  expires_tick: bigint; // u64, 0 = не активен
}

/**
 * Полный набор ресурсов
 */
export interface Resources {
  gameConfig: GameConfig;
  timeState: TimeState;
  rngState: RngStateResource;
  entityAllocatorState: EntityAllocatorState;
  inputBuffer: InputBuffer;
  timeSlowState: TimeSlowState;
}

// Экспорт типов событий для использования в системах
export type { ComponentTypes };
