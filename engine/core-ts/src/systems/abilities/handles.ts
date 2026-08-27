/**
 * Handle компонентов платформы способностей (`data-driven-systems` SYS-10):
 * имена полей слота, кулдауна, длительности, снаряда и инстанса баффа
 * разрешаются один раз — и дальше горячие циклы систем платформы читают мир
 * числовыми ссылками, без словарного поиска по строкам.
 *
 * Раскладка этих компонентов — контракт платформы (ABIL-1, BUFF-1), а не
 * данные сцены: имена полей здесь фиксированы, и разрешать их строго законно.
 * Момент разрешения — первый вход в систему и ПОСЛЕ её раннего выхода: таблицы
 * способностей и баффов независимы (SER-7), и сцена, объявившая только баффы,
 * не должна падать на именах слота, которого у неё нет вовсе.
 */
import {
  ABILITY_COOLDOWN_COMPONENT,
  ABILITY_DURATION_COMPONENT,
  ABILITY_PROJECTILE_COMPONENT,
  ABILITY_SLOT_COMPONENT,
  ABILITY_STEPS,
  BUFF_INSTANCE_COMPONENT,
  stepFieldEntity,
  stepFieldX,
  stepFieldY,
} from './components.js';
import type { ComponentHandle, FieldHandle, SystemContext } from '../../types.js';

export interface SlotHandles {
  readonly component: ComponentHandle;
  readonly abilityId: FieldHandle;
  readonly owner: FieldHandle;
  readonly phase: FieldHandle;
  readonly phaseTicks: FieldHandle;
  readonly staged: FieldHandle;
  readonly level: FieldHandle;
  readonly lastInterrupt: FieldHandle;
  /** Поля шагов цепочки прицеливания (ABIL-5), по индексу шага. */
  readonly stepX: readonly FieldHandle[];
  readonly stepY: readonly FieldHandle[];
  readonly stepEntity: readonly FieldHandle[];
}

export function resolveSlotHandles(ctx: SystemContext): SlotHandles {
  const field = (name: string): FieldHandle => ctx.resolveField(ABILITY_SLOT_COMPONENT, name);
  const stepX: FieldHandle[] = [];
  const stepY: FieldHandle[] = [];
  const stepEntity: FieldHandle[] = [];
  for (let i = 0; i < ABILITY_STEPS; i++) {
    stepX.push(field(stepFieldX(i)));
    stepY.push(field(stepFieldY(i)));
    stepEntity.push(field(stepFieldEntity(i)));
  }
  return {
    component: ctx.resolveComponent(ABILITY_SLOT_COMPONENT),
    abilityId: field('abilityId'),
    owner: field('owner'),
    phase: field('phase'),
    phaseTicks: field('phaseTicks'),
    staged: field('staged'),
    level: field('level'),
    lastInterrupt: field('lastInterrupt'),
    stepX,
    stepY,
    stepEntity,
  };
}

export interface CooldownHandles {
  readonly remaining: FieldHandle;
}

export function resolveCooldownHandles(ctx: SystemContext): CooldownHandles {
  return { remaining: ctx.resolveField(ABILITY_COOLDOWN_COMPONENT, 'remaining') };
}

export interface DurationHandles {
  readonly remaining: FieldHandle;
  readonly abilityId: FieldHandle;
  readonly owner: FieldHandle;
}

export function resolveDurationHandles(ctx: SystemContext): DurationHandles {
  const field = (name: string): FieldHandle => ctx.resolveField(ABILITY_DURATION_COMPONENT, name);
  return { remaining: field('remaining'), abilityId: field('abilityId'), owner: field('owner') };
}

export interface ProjectileHandles {
  readonly abilityId: FieldHandle;
  readonly owner: FieldHandle;
  readonly ticksLeft: FieldHandle;
  readonly range: FieldHandle;
  readonly originX: FieldHandle;
  readonly originY: FieldHandle;
}

export function resolveProjectileHandles(ctx: SystemContext): ProjectileHandles {
  const field = (name: string): FieldHandle => ctx.resolveField(ABILITY_PROJECTILE_COMPONENT, name);
  return {
    abilityId: field('abilityId'),
    owner: field('owner'),
    ticksLeft: field('ticksLeft'),
    range: field('range'),
    originX: field('originX'),
    originY: field('originY'),
  };
}

export interface BuffInstanceHandles {
  readonly buffId: FieldHandle;
  readonly target: FieldHandle;
  readonly source: FieldHandle;
  readonly buffClass: FieldHandle;
}

export function resolveBuffInstanceHandles(ctx: SystemContext): BuffInstanceHandles {
  const field = (name: string): FieldHandle => ctx.resolveField(BUFF_INSTANCE_COMPONENT, name);
  return {
    buffId: field('buffId'),
    target: field('target'),
    source: field('source'),
    // `class` — имя поля документа, а не идентификатор TS: переименовано только
    // на этой стороне (BUFF-3).
    buffClass: field('class'),
  };
}
