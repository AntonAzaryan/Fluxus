/**
 * Геометрия исполнителей (BOT-9): что значит «давить», «кайтить», «отступать» и
 * «уклоняться» в терминах точки на плоскости.
 *
 * Это МЕХАНИЗМ, и в документ поведения он не переезжает ни при каком развитии
 * словаря: документ выбирает МЕЖДУ исполнителями, а сочинять новых из
 * steering-примитивов он не вправе (BOT-9, «Соблазн описать микро документом»).
 * Новый исполнитель — новая ветка `planFor` и новая запись закрытого словаря,
 * то есть правка кода с ревью, ровно как новая нативная система рядом с
 * JSON-системами.
 *
 * Слой общий: им пользуются и скоринг по документу (`brains/evaluated/`), и
 * слой способностей (`abilities.ts`) — ближайший враг и ближайшая угроза
 * считаются ОДИН раз и одинаково, иначе мозг целился бы в одного противника, а
 * шёл к другому.
 */
import type { BotExecutor } from '../../behavior.js';
import type { BotProfile } from '../../profile.js';
import type { PerceivedWorld, RememberedEnemy, ThreatView } from './perception.js';

/** Куда двигаться и куда целиться на этом тике. */
export interface BehaviorPlan {
  readonly executor: BotExecutor;
  readonly targetX: number;
  readonly targetY: number;
  /** Точка прицела; `undefined` — целиться по направлению движения. */
  readonly aim: { readonly x: number; readonly y: number } | undefined;
  /**
   * Уместен ли на этом маршруте стрейф — поперечное подмешивание в ход
   * (`micro.ts`). Уместен он там, где направление выбрано ГРУБО: сблизиться,
   * оторваться. На уклоне и отступлении направление выбрано ТОЧНО — вбок от
   * линии полёта, к центру, — и мельтешение вокруг него ровно эти два манёвра и
   * ломает.
   */
  readonly strafe: boolean;
}

export interface ArenaCenter {
  readonly x: number;
  readonly y: number;
}

/**
 * Оценка входа и кривой живёт в [0, 1] (BOT-9); не-число читается как ноль.
 * Тело — общей модели скоринга (`npc-behavior` NPC-3): диапазон у оценки один
 * на бота и NPC, и второго зажима под тем же смыслом заводить не за чем.
 */
export { clamp01 } from '@fluxus/core';

/** Ближайший известный враг: видимый предпочтительнее помнимого при равном расстоянии. */
export function nearestEnemy(world: PerceivedWorld): RememberedEnemy | undefined {
  let best: RememberedEnemy | undefined;
  let bestScore = Infinity;
  for (const enemy of world.enemies) {
    const distance = Math.hypot(enemy.x - world.self.x, enemy.y - world.self.y);
    // Помнимое положение обесценивается: оно тем менее полезно, чем старше.
    const score = enemy.visible ? distance : distance + 1;
    if (score < bestScore) {
      bestScore = score;
      best = enemy;
    }
  }
  return best;
}

/** Ближайшая сближающаяся угроза — единственная, от которой имеет смысл уклоняться. */
export function nearestThreat(world: PerceivedWorld): ThreatView | undefined {
  let best: ThreatView | undefined;
  for (const threat of world.threats) {
    if (!threat.closing) continue;
    if (best === undefined || threat.distance < best.distance) best = threat;
  }
  return best;
}

/** Насколько бот удалился от центра арены — масштаб «пора отступать» (ARENA-2). */
export function distanceFromCenter(world: PerceivedWorld, center: ArenaCenter): number {
  return Math.hypot(world.self.x - center.x, world.self.y - center.y);
}

/** Держит цель внутри арены с запасом `edgeMargin` — «не стоять у края». */
function insideArena(
  x: number,
  y: number,
  world: PerceivedWorld,
  profile: BotProfile,
  center: ArenaCenter,
): { readonly x: number; readonly y: number } {
  const radius = world.arenaRadius;
  if (radius === undefined) return { x, y };
  const limit = Math.max(0, radius - profile.movement.edgeMargin);
  const dx = x - center.x;
  const dy = y - center.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= limit || distance === 0) return { x, y };
  return { x: center.x + (dx / distance) * limit, y: center.y + (dy / distance) * limit };
}

function away(
  fromX: number,
  fromY: number,
  world: PerceivedWorld,
  step: number,
): { readonly x: number; readonly y: number } {
  const dx = world.self.x - fromX;
  const dy = world.self.y - fromY;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: world.self.x + step, y: world.self.y };
  return { x: world.self.x + (dx / length) * step, y: world.self.y + (dy / length) * step };
}

/**
 * Точка на луче «бот → цель», отстоящая от цели на `keep`. Ближе `keep` бот уже
 * стоит — тогда цель движения он и есть сам: отходить назад — работа кайта, а
 * не сближения.
 */
function approach(
  toX: number,
  toY: number,
  world: PerceivedWorld,
  keep: number,
): { readonly x: number; readonly y: number } {
  const dx = toX - world.self.x;
  const dy = toY - world.self.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= keep || distance === 0) return { x: world.self.x, y: world.self.y };
  const step = distance - keep;
  return { x: world.self.x + (dx / distance) * step, y: world.self.y + (dy / distance) * step };
}

/** Уклонение вбок от линии полёта снаряда: поперёк его скорости, прочь от неё. */
function sidestep(
  threat: ThreatView,
  world: PerceivedWorld,
  step: number,
): { readonly x: number; readonly y: number } {
  const length = Math.hypot(threat.vx, threat.vy);
  if (length === 0) return away(threat.x, threat.y, world, step);
  let px = -threat.vy / length;
  let py = threat.vx / length;
  // Из двух перпендикуляров берётся тот, что уводит от линии полёта.
  if (px * (world.self.x - threat.x) + py * (world.self.y - threat.y) < 0) {
    px = -px;
    py = -py;
  }
  return { x: world.self.x + px * step, y: world.self.y + py * step };
}

/** Геометрия выбранного исполнителя на этот тик: цель движения, прицел, уместность стрейфа. */
export function planFor(
  executor: BotExecutor,
  world: PerceivedWorld,
  profile: BotProfile,
  center: ArenaCenter,
): BehaviorPlan {
  const enemy = nearestEnemy(world);
  const threat = nearestThreat(world);
  const step = Math.max(profile.movement.edgeMargin, profile.movement.arriveTolerance);
  const aim = enemy === undefined ? undefined : { x: enemy.x, y: enemy.y };

  let target = { x: world.self.x, y: world.self.y };
  let strafe = false;
  switch (executor) {
    case 'pressure':
      // Сближение — до ДИСТАНЦИИ БОЯ, а не до ног противника. Бот, идущий в
      // упор, во-первых, не даёт своим же снарядам разлететься, во-вторых,
      // лишает себя уклонения: чужой шар с двух клеток не успевает быть
      // замеченным никем — ни ботом, ни человеком. «В упор» тут и не выражается:
      // дистанция боя положительна по валидации профиля — она же масштаб входов
      // словаря (BOT-9), и ноль отменял бы не только запас, но и их смысл.
      if (enemy !== undefined) target = approach(enemy.x, enemy.y, world, profile.movement.engageRange);
      strafe = true;
      break;
    case 'kite':
      if (enemy !== undefined) target = away(enemy.x, enemy.y, world, profile.movement.engageRange);
      strafe = true;
      break;
    case 'retreat':
      target = { x: center.x, y: center.y };
      break;
    case 'dodge':
      if (threat !== undefined) target = sidestep(threat, world, step);
      break;
  }
  const bounded = insideArena(target.x, target.y, world, profile, center);
  return { executor, targetX: bounded.x, targetY: bounded.y, aim, strafe };
}
