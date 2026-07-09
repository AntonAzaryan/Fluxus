/**
 * Game MVP TS Implementation
 * 
 * Детерминированное ECS-ядро на TypeScript с miniplex
 * spec/ — единственный источник истины
 */

// Fixed-point арифметика
export * from './fixed/fixed';
export * from './fixed/trig';
export * from './fixed/vector';
export { SIN_LUT, COS_LUT, ATAN_LUT, TABLE_SIZE } from './fixed/trigLut';

// RNG
export * from './rng/pcg32';

// Компоненты
export * from './components/types';

// Ресурсы
export * from './resources/resources';

// ECS
export * from './ecs/entity';
export * from './ecs/world';
export * from './ecs/events';

// Архетипы
export * from './archetypes/player';
export * from './archetypes/fireball';
export * from './archetypes/shield';
export * from './archetypes/wall';

// GameConfig
export { defaultGameConfig } from './gameConfig';

// Tick
export { tick, createGameState, GameState, TickInput } from './tick';

// Schedule
export { schedule } from './schedule';

// Physics
export { PhysicsProvider } from './physics/physicsProvider';
export * from './physics/contract';
