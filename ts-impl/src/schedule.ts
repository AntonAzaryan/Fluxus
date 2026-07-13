/**
 * Расписание стадий игрового тика
 * schedule.yaml
 */

import { GameWorld } from './ecs/world';
import { EventBus } from './ecs/events';
import { Resources } from './resources/resources';
import { playerCommandIngestSystem } from './systems/playerCommandIngest';
import { cooldownTickSystem } from './systems/cooldownTick';
import { moveIntentSystem } from './systems/moveIntent';
import { dashStartSystem } from './systems/dashStart';
import { fireballCastSystem } from './systems/fireballCast';
import { shieldCastSystem } from './systems/shieldCast';
import { timeSlowCastSystem } from './systems/timeSlowCast';
import { movementSystem } from './systems/movement';
import { dashUpdateSystem } from './systems/dashUpdate';
import { timeSlowSyncSystem } from './systems/timeSlowSync';
import { attachedToSyncSystem } from './systems/attachedToSync';
import { projectileTravelSystem } from './systems/projectileTravel';
import { projectileHitSystem } from './systems/projectileHit';
import { damageApplicationSystem } from './systems/damageApplication';
import { shieldExpirationSystem } from './systems/shieldExpiration';
import { despawnSystem } from './systems/despawn';
import { PhysicsProvider } from './physics/physicsProvider';
import { Fixed } from './fixed/fixed';
import { Collision } from './ecs/events';

/**
 * Стадии тика в порядке выполнения
 */
export interface Stage {
  name: string;
  execute: (world: GameWorld, resources: Resources, bus: EventBus, physics?: PhysicsProvider, dt?: Fixed) => void;
}

/**
 * Расписание стадий
 */
export const schedule: Stage[] = [
  // Input: Обработка ввода от игроков
  {
    name: 'Input',
    execute: (world, resources, bus) => {
      playerCommandIngestSystem(world, resources, bus);
    },
  },

  // Intent: Обработка команд способностей
  {
    name: 'Intent',
    execute: (world, resources, bus) => {
      cooldownTickSystem(world, resources);
      moveIntentSystem(world, bus);
      dashStartSystem(world, resources, bus);
      fireballCastSystem(world, resources, bus);
      shieldCastSystem(world, resources, bus);
      timeSlowCastSystem(world, resources, bus);
    },
  },

  // Simulation: Движение и физика (до провайдера)
  {
    name: 'Simulation',
    execute: (world, resources) => {
      movementSystem(world, resources);
      dashUpdateSystem(world, resources);
      timeSlowSyncSystem(world, resources);
      attachedToSyncSystem(world);
      projectileTravelSystem(world, resources);
    },
  },

  // Physics: Внешний провайдер физики
  {
    name: 'Physics',
    execute: (world, resources, bus, physics, dt) => {
      if (!physics || !dt) return;
      
      physics.step(
        world,
        dt,
        (collision) => {
          bus.emit('Collision', {
            entity_a: collision.entity_a,
            entity_b: collision.entity_b,
            contact_point: collision.contact_point,
            normal: collision.normal,
            penetration: collision.penetration,
          });
        }
      );
    },
  },

  // Reaction: Реакция на физические события
  {
    name: 'Reaction',
    execute: (world, resources, bus) => {
      projectileHitSystem(world, resources, bus);
    },
  },

  // Resolution: Применение урона, респавн, удаление сущностей
  {
    name: 'Resolution',
    execute: (world, resources, bus) => {
      damageApplicationSystem(world, resources, bus);
      shieldExpirationSystem(world, resources);
      despawnSystem(world, resources);
    },
  },
];

// Примечание: TimeAdvanceSystem не реализуется — tick увеличивается внешним рантаймом
