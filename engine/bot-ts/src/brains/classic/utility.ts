/**
 * Слой решений классического мозга (задача 3.2): utility-скоринг поведений с
 * весами из профиля и частотой передумывания оттуда же (BOT-6).
 *
 * Скоринг, а не дерево поведений и не машина состояний: поведения соревнуются
 * числом, и «сделать бота осторожнее» — правка веса в JSON, а не перестройка
 * графа переходов. Своя реализация, а не библиотека: зрелых нет, а весь слой —
 * пять функций полезности (design D4).
 *
 * Сырая полезность каждого поведения нормирована в [0, 1] и умножается на вес
 * профиля. Нормировка обязательна: без неё веса перестали бы быть сравнимыми
 * между собой, и дизайнер тюнил бы не приоритет, а масштаб чужой формулы.
 */
import { BOT_BEHAVIORS, type BotBehavior, type BotProfile } from '../../profile.js';
import type { PerceivedWorld, RememberedEnemy, ThreatView } from './perception.js';
import type { BrainRandom } from './random.js';

export type BehaviorScores = Readonly<Record<BotBehavior, number>>;

/** Куда двигаться, куда целиться и жать ли способность на этом тике. */
export interface BehaviorPlan {
  readonly behavior: BotBehavior;
  readonly targetX: number;
  readonly targetY: number;
  /** Точка прицела; `undefined` — целиться по направлению движения. */
  readonly aim: { readonly x: number; readonly y: number } | undefined;
  readonly fire: boolean;
}

export interface ArenaCenter {
  readonly x: number;
  readonly y: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

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

function distanceFromCenter(world: PerceivedWorld, center: ArenaCenter): number {
  return Math.hypot(world.self.x - center.x, world.self.y - center.y);
}

/**
 * Полезности поведений (BOT-6). Ручки все из профиля: агрессивность двигает
 * пару «давить/кайтить», дальность способности задаёт масштаб дистанций, запас
 * до края — момент, когда пора отступать к центру.
 */
export function scoreBehaviors(
  world: PerceivedWorld,
  profile: BotProfile,
  options: { readonly abilityReady: boolean; readonly center: ArenaCenter },
): BehaviorScores {
  const enemy = nearestEnemy(world);
  const range = profile.ability.range;
  const distance =
    enemy === undefined ? Infinity : Math.hypot(enemy.x - world.self.x, enemy.y - world.self.y);
  const threat = nearestThreat(world);
  const margin = profile.movement.edgeMargin;
  const radius = world.arenaRadius;
  const { center } = options;

  const raw: Record<BotBehavior, number> = {
    // Давить тем полезнее, чем дальше противник: сближение — работа.
    pressure: enemy === undefined ? 0 : profile.aggression * clamp01(distance / (2 * range)),
    // Кайтить — наоборот: чем ближе противник, тем ценнее разорвать дистанцию.
    kite: enemy === undefined ? 0 : (1 - profile.aggression) * clamp01(1 - distance / range),
    // Отступать к центру: полезность растёт в запасе `edgeMargin` до границы
    // арены и достигает единицы на самой границе (`arena` ARENA-2).
    retreat:
      radius === undefined || margin <= 0
        ? 0
        : clamp01((distanceFromCenter(world, center) - (radius - margin)) / margin),
    // Уклоняться — только от сближающегося снаряда и тем сильнее, чем он ближе.
    dodge: threat === undefined || range <= 0 ? 0 : clamp01(1 - threat.distance / range),
    // Способность: готова, враг виден и в дальности.
    ability:
      !options.abilityReady || enemy === undefined || !enemy.visible || distance > range
        ? 0
        : clamp01(1 - distance / (range * 2)),
  };

  const scores = {} as Record<BotBehavior, number>;
  for (const behavior of BOT_BEHAVIORS) scores[behavior] = raw[behavior] * profile.utility[behavior];
  return scores;
}

/** Держит цель внутри арены с запасом `edgeMargin` — «не стоять у края» (design D4). */
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

/** Геометрия выбранного поведения на этот тик: цель движения, прицел, выстрел. */
export function planFor(
  behavior: BotBehavior,
  world: PerceivedWorld,
  profile: BotProfile,
  center: ArenaCenter,
): BehaviorPlan {
  const enemy = nearestEnemy(world);
  const threat = nearestThreat(world);
  const step = Math.max(profile.movement.edgeMargin, profile.movement.arriveTolerance);
  const aim = enemy === undefined ? undefined : { x: enemy.x, y: enemy.y };

  let target = { x: world.self.x, y: world.self.y };
  let fire = false;
  switch (behavior) {
    case 'pressure':
      if (enemy !== undefined) target = { x: enemy.x, y: enemy.y };
      break;
    case 'kite':
      if (enemy !== undefined) target = away(enemy.x, enemy.y, world, profile.ability.range);
      break;
    case 'retreat':
      target = { x: center.x, y: center.y };
      break;
    case 'dodge':
      if (threat !== undefined) target = sidestep(threat, world, step);
      break;
    case 'ability':
      fire = enemy !== undefined;
      break;
  }
  const bounded = insideArena(target.x, target.y, world, profile, center);
  return { behavior, targetX: bounded.x, targetY: bounded.y, aim, fire };
}

/**
 * Выбор поведения с частотой передумывания из профиля (BOT-6): между
 * пересчётами держится ранее выбранное — мельтешение между двумя почти равными
 * поведениями выглядит как сломанный бот, а не как думающий.
 */
export class UtilityLayer {
  private readonly profile: BotProfile;
  private readonly random: BrainRandom;
  private chosen: BotBehavior = 'retreat';
  private lastScores: BehaviorScores | undefined;
  private nextDecisionTick = -Infinity;

  constructor(profile: BotProfile, random: BrainRandom) {
    this.profile = profile;
    this.random = random;
  }

  /** Скоринг последнего пересчёта — наблюдаемый выход слоя для тестов и отладки. */
  get scores(): BehaviorScores | undefined {
    return this.lastScores;
  }

  choose(
    world: PerceivedWorld,
    tick: number,
    options: { readonly abilityReady: boolean; readonly center: ArenaCenter },
  ): BotBehavior {
    if (tick < this.nextDecisionTick) return this.chosen;
    const scores = scoreBehaviors(world, this.profile, options);
    this.lastScores = scores;
    let best: BotBehavior = 'retreat';
    let bestScore = 0;
    for (const behavior of BOT_BEHAVIORS) {
      const score = scores[behavior];
      if (score > bestScore) {
        bestScore = score;
        best = behavior;
      }
    }
    // Ни одно поведение не набрало очков — врага не видно, край далеко, снаряды
    // мимо. Умолчание — к центру: там бот видит больше и не падает с арены.
    this.chosen = best;
    const { intervalTicks, jitterTicks } = this.profile.decision;
    const jitter = jitterTicks === 0 ? 0 : this.random.below(jitterTicks + 1);
    this.nextDecisionTick = tick + intervalTicks + jitter;
    return best;
  }
}
