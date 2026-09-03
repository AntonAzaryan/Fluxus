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
 *
 * TimeScale (TIME-5): игнорирует — дальность и время жизни считаются в
 * ГЛОБАЛЬНЫХ тиках. Сам полёт при этом замедляется: скорость интегрирует
 * физика (PHYS-8), а она в TimeScale опт-ин, — то есть замедленный снаряд
 * проживает те же тики, но пролетает меньше.
 */
import { countCostProjectileSteps } from '../../debug.js';
import { distSqLe } from '../../math/fixed.js';
import { execute, systemError, type Action } from '../../dsl/actions.js';
import { ABILITY_PROJECTILE_COMPONENT } from './components.js';
import { resolveProjectileHandles, type ProjectileHandles } from './handles.js';
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
  /** Handle полей снаряда (SYS-10): один раз, на первом входе, после раннего выхода. */
  private handles: ProjectileHandles | undefined;

  constructor(catalog: AbilityCatalog) {
    this.catalog = catalog;
  }

  run(ctx: SystemContext): void {
    const published = ctx.events.length;
    const projectiles = ctx.query(this.spec);
    if (projectiles.length === 0) return;
    // Handle полей снаряда (SYS-10): один раз, на первом входе, после раннего выхода.
    const h = (this.handles ??= resolveProjectileHandles(ctx));
    for (const projectile of projectiles) {
      const index = ctx.getByHandle(projectile, h.abilityId);
      const ability = this.catalog.abilities[index];
      if (ability === undefined) {
        throw new Error(
          `снаряд ${projectile} ссылается на определение способности ${index}, ` +
            `в таблице их ${this.catalog.abilities.length}`,
        );
      }
      const owner = ctx.getByHandle(projectile, h.owner);
      this.hits(ctx, projectile, owner, ability, published);
      this.exhaustion(ctx, h, projectile, owner, ability);
    }
    // Продвинутые снаряды — работа тика (PERF-3), одним вызовом на проход.
    // Мёртвых в счёте нет: запрос отдаёт только живые носители компонента.
    countCostProjectileSteps(projectiles.length);
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
    h: ProjectileHandles,
    projectile: EntityId,
    owner: EntityId,
    ability: CompiledAbility,
  ): void {
    let faded = false;
    const ticksLeft = ctx.getByHandle(projectile, h.ticksLeft);
    if (ticksLeft > 0) {
      ctx.commands.setField(projectile, ABILITY_PROJECTILE_COMPONENT, 'ticksLeft', ticksLeft - 1);
      faded = ticksLeft === 1;
    }
    if (!faded) {
      const range = ctx.getByHandle(projectile, h.range);
      if (range > 0) {
        const dx = ctx.math.sub(
          positionOf(ctx, projectile, 'x'),
          ctx.getByHandle(projectile, h.originX),
        );
        const dy = ctx.math.sub(
          positionOf(ctx, projectile, 'y'),
          ctx.getByHandle(projectile, h.originY),
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
