/**
 * GameConfig: значения по умолчанию из spec/resources/game_config.yaml
 * Все значения в fixed-point через toFixed()
 */

import { GameConfig } from './resources/resources';
import { toFixed } from './fixed/fixed';

export const defaultGameConfig: GameConfig = {
  // Персонаж
  player_move_speed: toFixed(300.0),
  player_max_health: toFixed(500.0),
  player_radius: toFixed(20.0),

  // Фаербол (Q)
  fireball_speed: toFixed(800.0),
  fireball_max_distance: toFixed(600.0),
  fireball_damage: toFixed(100.0),
  fireball_radius: toFixed(8.0),
  fireball_cooldown: toFixed(2000.0),

  // Щит (E)
  shield_spawn_distance: toFixed(80.0),
  shield_arc_degrees: toFixed(30.0),
  shield_lifetime_ms: toFixed(500.0),
  shield_health: toFixed(1.0),
  shield_radius: toFixed(35.0),
  shield_cooldown: toFixed(2000.0),

  // Рывок (Space)
  dash_speed: toFixed(1200.0),
  dash_duration_ms: toFixed(200.0),
  dash_cooldown_ms: toFixed(500.0),

  // Замедление времени (R)
  time_slow_duration_ms: toFixed(3000.0),
  time_slow_cooldown_ms: toFixed(15000.0),
  time_slow_scale: toFixed(0.5),

  // Респавн
  respawn_delay_ms: toFixed(10000.0),

  // Физика
  gravity: toFixed(0.0),

  // Время: 1000ms / 60 ticks = 16.666667ms per tick
  ms_per_tick: toFixed(1000.0 / 60.0),
};
