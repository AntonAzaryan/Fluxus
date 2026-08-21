/**
 * Снаряд платформы (ABIL-9), `order` 300 (DET-9).
 *
 * Система разбирает то, что произвели физика и арена, — события столкновения
 * (PHYS-9) и пересечения без блокировки (PHYS-12) ЭТОГО тика, — и исчерпание
 * дальности и времени жизни. Полёт как таковой она не считает: скорость снаряда
 * — обычное поле, интегрирует его разрешение движения (PHYS-8), и второго
 * интегратора рядом с ним не появляется.
 *
 * Значение 300, а не первое свободное за ареной: полоса 1…200 плотно занята
 * системами существующих сцен и сценариев, и якорь внутри неё ронял бы их на
 * загрузке конфликтом `order`.
 */
import { distSqLe } from '../../math/fixed.js';
import { execute, systemError, type Action } from '../../dsl/actions.js';
import { ABILITY_PROJECTILE_COMPONENT } from './components.js';
import { positionOf, type ExprVarsRecord } from './runtime.js';
import type { AbilityCatalog, CompiledAbility } from './model.js';
import { NO_ENTITY, type EntityId, type QuerySpec, type System, type SystemContext } from '../../types.js';

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 300;

/** События физики, которые платформа считает попаданием (PHYS-9, PHYS-12). */
const COLLISION_EVENT = 'Collision';
const OVERLAP_EVENT = 'Overlap';

export class ProjectileSystem implements System {
  readonly name = 'Projectile';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: AbilityCatalog;
  private readonly spec: QuerySpec = { all: [ABILITY_PROJECTILE_COMPONENT] };
  /** Переиспользуемая область видимости списков доставки (ABIL-10). */
  private readonly vars: ExprVarsRecord = { self: 0, owner: 0, other: 0, event: 0 };

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
  }

  run(ctx: SystemContext): void {
    const published = ctx.events.length;
    for (const projectile of ctx.query(this.spec)) {
      const index = ctx.get(projectile, ABILITY_PROJECTILE_COMPONENT, 'abilityId');
      const ability = this.catalog.abilities[index];
      if (ability === undefined) {
        throw new Error(
          `снаряд ${projectile} ссылается на определение способности ${index}, ` +
            `в таблице их ${this.catalog.abilities.length}`,
        );
      }
      const owner = ctx.get(projectile, ABILITY_PROJECTILE_COMPONENT, 'owner');
      this.hits(ctx, projectile, owner, ability, published);
      this.exhaustion(ctx, projectile, owner, ability);
    }
  }

  /**
   * Столкновение и пересечение запускают список действий определения. Снаряд
   * бывает и второй стороной пары — `Collision` называет обоих участников
   * (PHYS-9), — поэтому проверяются оба поля, а встречный участник уезжает в
   * область видимости именем `other`.
   */
  private hits(
    ctx: SystemContext,
    projectile: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
    published: number,
  ): void {
    if (ability.onHit.length === 0) return;
    for (let i = 0; i < published; i++) {
      const event = ctx.events.at(i);
      if (event.type !== COLLISION_EVENT && event.type !== OVERLAP_EVENT) continue;
      const entity = event.data.entity;
      const other = event.data.other;
      let counterpart: number;
      if (entity === projectile) counterpart = other ?? NO_ENTITY;
      else if (other === projectile) counterpart = entity ?? NO_ENTITY;
      else continue;
      this.vars.self = projectile;
      this.vars.owner = owner;
      this.vars.other = counterpart;
      this.vars.event = i;
      this.exec(ctx, ability.onHit);
    }
  }

  /**
   * Исчерпание времени жизни и дальности (ABIL-9). Обе величины включаются
   * только положительным значением: «предела нет» и «предел исчерпан» не
   * путаются, а список затухания исполняется ровно один раз.
   */
  private exhaustion(
    ctx: SystemContext,
    projectile: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
  ): void {
    let faded = false;
    const ticksLeft = ctx.get(projectile, ABILITY_PROJECTILE_COMPONENT, 'ticksLeft');
    if (ticksLeft > 0) {
      ctx.commands.setField(projectile, ABILITY_PROJECTILE_COMPONENT, 'ticksLeft', ticksLeft - 1);
      faded = ticksLeft === 1;
    }
    if (!faded) {
      const range = ctx.get(projectile, ABILITY_PROJECTILE_COMPONENT, 'range');
      if (range > 0) {
        const dx = ctx.math.sub(
          positionOf(ctx, projectile, 'x'),
          ctx.get(projectile, ABILITY_PROJECTILE_COMPONENT, 'originX'),
        );
        const dy = ctx.math.sub(
          positionOf(ctx, projectile, 'y'),
          ctx.get(projectile, ABILITY_PROJECTILE_COMPONENT, 'originY'),
        );
        faded = !distSqLe(dx, dy, range);
      }
    }
    if (!faded) return;
    this.vars.self = projectile;
    this.vars.owner = owner;
    this.vars.other = NO_ENTITY;
    this.vars.event = 0;
    this.exec(ctx, ability.onFade);
    ctx.commands.destroy(projectile);
  }

  private exec(ctx: SystemContext, actions: readonly Action[]): void {
    if (actions.length === 0) return;
    try {
      execute(actions, ctx, this.vars);
    } catch (cause) {
      throw systemError(this.name, cause);
    }
  }
}
