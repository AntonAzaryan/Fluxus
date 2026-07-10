/**
 * Tick: точка входа игрового цикла
 * 
 * tick(state, input) -> state
 * Чистая функция, детерминированное ядро
 */

import { GameWorld } from './ecs/world';
import { EventBus } from './ecs/events';
import { Resources, InputCommand } from './resources/resources';
import { schedule } from './schedule';
import { PhysicsProvider } from './physics/physicsProvider';
import { Fixed, div, mul, toFixed, ONE } from './fixed/fixed';
import { defaultGameConfig } from './gameConfig';

/**
 * Состояние игры для tick()
 */
export interface GameState {
  world: GameWorld;
  resources: Resources;
  bus: EventBus;
  physics: PhysicsProvider;
}

/**
 * Входные данные для tick()
 */
export interface TickInput {
  commands: InputCommand[];
}

/**
 * Игровой тик
 * @param state Состояние игры (мутируется in-place)
 * @param input Входные команды
 * @returns Обновлённое состояние (то же самое, мутированное)
 */
export function tick(state: GameState, input: TickInput): GameState {
  const { world, resources, bus, physics } = state;
  const { timeState, gameConfig } = resources;

  // 1. Очистить буфер событий перед стадией Input
  bus.clear();

  // 2. Положить команды в InputBuffer
  resources.inputBuffer.commands = input.commands;

  // 3. Вычислить dt с учётом time_scale
  // dt = (1.0 / tick_rate) * time_scale, в СЕКУНДАХ (скорости в GameConfig — units/sec)
  // ms_per_tick хранит миллисекунды (1000.0 / tick_rate) — переводим в секунды делением на 1000
  const dt = mul(div(gameConfig.ms_per_tick, toFixed(1000.0)), timeState.time_scale);

  // 4. Выполнить все стадии по расписанию
  for (const stage of schedule) {
    stage.execute(world, resources, bus, physics, dt);
  }

  // 5. Увеличить current_tick (внешний рантайм может делать это сам)
  // В данной реализации увеличиваем здесь
  timeState.current_tick = timeState.current_tick + BigInt(1);

  return state;
}

/**
 * Создать новое состояние игры
 */
export function createGameState(): GameState {
  return {
    world: new GameWorld(),
    resources: {
      gameConfig: defaultGameConfig,
      timeState: { current_tick: BigInt(0), time_scale: ONE },
      rngState: { state: BigInt(0), inc: BigInt(0) },
      entityAllocatorState: { next_id: BigInt(1) },
      inputBuffer: { commands: [] },
      timeSlowState: { expires_tick: BigInt(0) },
    },
    bus: new EventBus(),
    physics: new PhysicsProvider(),
  };
}
