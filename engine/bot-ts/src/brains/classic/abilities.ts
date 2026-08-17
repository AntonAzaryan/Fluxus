/**
 * Слой способностей классического мозга: какую кнопку жать, сколько её держать
 * и куда при этом смотреть.
 *
 * Отдельно от слоя маршрутов (`utility.ts`) намеренно. Кнопка и ход — разные
 * руки: человек кастует на бегу, уклоняется, продолжая отступать, и прыгает,
 * не переставая сближаться. Слей их в одно соревнование — и любой каст стоил бы
 * боту хода, а любой ход отменял бы каст.
 *
 * О механике самих способностей слой не знает НИЧЕГО (BOT-6): что кнопка 0 —
 * заряжаемый снаряд, а кнопка 6 — щит, живёт в JSON-системах сцены. Мозгу
 * профиль сообщает только бит, цель (`enemy` / `threat` / `cliff`), дальность,
 * длительность удержания и кулдаун — и этого хватает, чтобы шесть разных
 * способностей демо игрались одним кодом.
 *
 * Одна способность за раз, и это не упрощение. Сцена демо гейтит касты друг об
 * друга (`ShieldCast` и `CaptureRelease` не срабатывают во время заряда), а
 * маска `buttons` одна: две кнопки, зажатые вместе, читались бы сценой как
 * последовательность, которой бот не задумывал.
 *
 * Детерминизм на слой не распространяется (BOT-5): float, память между тиками и
 * несеяный шум законны — наружу уходит только маска `buttons`, а она проходит
 * те же ограничения, что маска человека (`boundary.ts`, INP-3).
 */
import type { BotAbilityProfile, BotProfile } from '../../profile.js';
import type { BotTerrain } from '../../terrainView.js';
import type { PerceivedWorld } from './perception.js';
import type { BrainRandom } from './random.js';
import { nearestEnemy, nearestThreat, type BehaviorPlan } from './utility.js';

/** Точка, на которую способность требует смотреть. */
export interface AbilityAim {
  readonly x: number;
  readonly y: number;
}

/** Выход слоя на тик: маска действий и требование к прицелу. */
export interface AbilityIntent {
  /** Маска `buttons` (TICK-2); 0 — на этом тике не жмётся ничего. */
  readonly buttons: number;
  /**
   * Куда смотреть, пока способность применяется; `undefined` — прицел решает
   * маршрут. Захват ловит снаряд конусом от прицела, заряд летит туда, куда
   * смотрел кастер в момент отпускания, — обе способности бесполезны, если
   * прицел в это время живёт своей жизнью.
   */
  readonly aim: AbilityAim | undefined;
}

const IDLE: AbilityIntent = { buttons: 0, aim: undefined };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Полезность применения по дистанции: единица в упор, половина на самой границе
 * дальности. Та же нормировка, что у маршрутов, и по той же причине — веса
 * профиля обязаны быть сравнимы между собой.
 */
function closeness(distance: number, range: number): number {
  if (range <= 0) return 0;
  return clamp01(1 - distance / (2 * range));
}

/** Начатое применение: какую способность бот держит, до какого тика и куда смотрит. */
interface ActivePress {
  readonly index: number;
  readonly ability: BotAbilityProfile;
  readonly untilTick: number;
  /**
   * Последняя известная точка прицела применения. Держится ЗДЕСЬ, а не
   * пересчитывается на месте, потому что цель по ходу удержания пропадает: враг
   * уходит в туман, пойманный снаряд перестаёт быть угрозой. Заряд при этом
   * обязан улететь туда, куда бот целился, а не туда, куда прицел уехал от
   * потери цели.
   */
  aim: AbilityAim | undefined;
}

/** Что слой решил про одну способность на этом тике. */
interface Candidate {
  readonly index: number;
  readonly ability: BotAbilityProfile;
  readonly score: number;
  readonly aim: AbilityAim | undefined;
}

export interface AbilityLayerOptions {
  /**
   * Рельеф сцены (`terrainView.ts`); `undefined` — сцена без террейна. Без него
   * цель `cliff` не набирает очков никогда: прыгать вслепую значит жечь кулдаун
   * и терять ход в никуда.
   */
  readonly terrain?: BotTerrain;
}

export class AbilityLayer {
  private readonly profile: BotProfile;
  private readonly random: BrainRandom;
  private readonly terrain: BotTerrain | undefined;
  /** Тик готовности по индексу способности в профиле. */
  private readonly readyAtTick: number[];
  private active: ActivePress | undefined;

  constructor(profile: BotProfile, random: BrainRandom, options: AbilityLayerOptions = {}) {
    this.profile = profile;
    this.random = random;
    this.terrain = options.terrain;
    this.readyAtTick = profile.abilities.map(() => -Infinity);
  }

  /**
   * Забыть кулдауны и начатое применение: ветвь истории, в которой они
   * набирались, стёрта перемоткой (NTR-16). Номера тиков после неё идут НАЗАД,
   * и оставленные сроки держали бы способности незаряженными ровно ту глубину,
   * которую унесла перемотка, — а зажатая кнопка уехала бы вводом в мир, где её
   * никто не нажимал.
   */
  forget(): void {
    this.readyAtTick.fill(-Infinity);
    this.active = undefined;
  }

  /** Держит ли слой кнопку прямо сейчас — наблюдаемый выход для тестов и отладки. */
  get holding(): string | undefined {
    return this.active?.ability.name;
  }

  step(world: PerceivedWorld, plan: BehaviorPlan, tick: number): AbilityIntent {
    const held = this.active;
    if (held !== undefined) return this.continuePress(held, world, plan, tick);
    return this.beginPress(world, plan, tick);
  }

  /**
   * Продолжение начатого применения. Отпускается кнопка по одной из двух
   * причин: вышел срок удержания либо мир потребовал РЕАКЦИИ — в бота полетело
   * что-то, от чего есть чем закрыться, либо по курсу встал обрыв.
   *
   * Второй случай — не отдельная ручка профиля, а следствие того же скоринга:
   * перебила удерживаемую способность реактивная (`threat` или `cliff`) —
   * заряд бросается. Заряд демо копится больше полусекунды и запирает манёвры
   * (`ActionLock`, LOC-7), и бот, честно докачивающий его под летящий снаряд
   * или упёршись в уступ, — не терпеливый, а неживой. Наступательная цель
   * (`enemy`) удержание не рвёт: смена одной атаки на другую посреди заряда —
   * мельтешение, а не решение.
   */
  private continuePress(
    held: ActivePress,
    world: PerceivedWorld,
    plan: BehaviorPlan,
    tick: number,
  ): AbilityIntent {
    held.aim = this.score(held.index, held.ability, world, plan).aim ?? held.aim;
    const expired = tick >= held.untilTick;
    const rival = expired ? undefined : this.best(world, plan, tick, held.index)?.ability.target;
    const interrupted = rival === 'threat' || rival === 'cliff';
    if (!expired && !interrupted) return { buttons: 1 << held.ability.button, aim: held.aim };
    // Спад кнопки — тик БЕЗ бита: он и есть отпускание, которое сцена читает
    // (`ChargeRelease`, `CaptureRelease`). Кулдаун отсчитывается отсюда, а не от
    // нажатия: удержание — часть применения, а не пауза перед ним.
    this.active = undefined;
    // Джиттер кулдауна (BOT-6): бот, жмущий способность ровно по таймеру,
    // читается как автомат — им он и является, и профиль обязан уметь это
    // скрыть.
    const { jitterTicks } = this.profile.decision;
    const jitter = jitterTicks === 0 ? 0 : this.random.below(jitterTicks + 1);
    this.readyAtTick[held.index] = tick + held.ability.cooldownTicks + jitter;
    // Прицел держится и на спаде: именно он решает, куда улетит заряд.
    return { buttons: 0, aim: held.aim };
  }

  private beginPress(world: PerceivedWorld, plan: BehaviorPlan, tick: number): AbilityIntent {
    const chosen = this.best(world, plan, tick, undefined);
    if (chosen === undefined) return IDLE;
    // `holdTicks` — сколько тиков кнопка ЗАЖАТА, поэтому срок отсчитывается от
    // текущего тика включительно: единица даёт тап (нажали — отпустили).
    this.active = {
      index: chosen.index,
      ability: chosen.ability,
      untilTick: tick + chosen.ability.holdTicks,
      aim: chosen.aim,
    };
    return { buttons: 1 << chosen.ability.button, aim: chosen.aim };
  }

  /** Лучшая из готовых способностей; `except` исключается из соревнования. */
  private best(
    world: PerceivedWorld,
    plan: BehaviorPlan,
    tick: number,
    except: number | undefined,
  ): Candidate | undefined {
    let best: Candidate | undefined;
    for (const [index, ability] of this.profile.abilities.entries()) {
      if (index === except) continue;
      if (tick < this.readyAtTick[index]!) continue;
      const candidate = this.score(index, ability, world, plan);
      if (candidate.score <= 0) continue;
      if (best === undefined || candidate.score > best.score) best = candidate;
    }
    return best;
  }

  /** Полезность одной способности здесь и сейчас и точка, на которую она смотрит. */
  private score(
    index: number,
    ability: BotAbilityProfile,
    world: PerceivedWorld,
    plan: BehaviorPlan,
  ): Candidate {
    const none: Candidate = { index, ability, score: 0, aim: undefined };
    if (ability.weight <= 0) return none;
    // Манёвр без направления симуляция игнорирует (LOC-4) либо выполняет на
    // месте (LOC-5) — и в обоих случаях кулдаун сгорает впустую.
    if (ability.requiresMoving === true && !this.moving(world, plan)) return none;

    switch (ability.target) {
      case 'enemy': {
        const enemy = nearestEnemy(world);
        // Только ВИДИМЫЙ: помнимое положение под туманом войны (BOT-3) — это
        // координаты, где враг был, а не где он есть, и кастовать по ним значит
        // отдавать кулдаун за память.
        if (enemy?.visible !== true) return none;
        const distance = Math.hypot(enemy.x - world.self.x, enemy.y - world.self.y);
        if (distance > ability.range) return none;
        return {
          index,
          ability,
          score: ability.weight * closeness(distance, ability.range),
          aim: { x: enemy.x, y: enemy.y },
        };
      }
      case 'threat': {
        const threat = nearestThreat(world);
        if (threat === undefined || threat.distance > ability.range) return none;
        return {
          index,
          ability,
          score: ability.weight * closeness(threat.distance, ability.range),
          aim: { x: threat.x, y: threat.y },
        };
      }
      case 'cliff': {
        if (!this.cliffAhead(ability, world, plan)) return none;
        // Постоянный вес, без нормировки по дистанции: уступ либо на пути, либо
        // нет, и «чуть-чуть на пути» ничего не значит.
        return { index, ability, score: ability.weight, aim: undefined };
      }
    }
  }

  /**
   * Идёт ли бот куда-нибудь: цель дальше допуска прибытия либо маршрут велит
   * стрейфить, а стрейф в профиле включён. Второе слагаемое — не запас: на
   * дистанции боя цель маршрута совпадает с местом, где бот стоит, и ход ему
   * даёт ровно стрейф (`micro.ts`). Без него уклон был бы навсегда выключен
   * там, где он и нужен.
   */
  private moving(world: PerceivedWorld, plan: BehaviorPlan): boolean {
    if (plan.strafe && this.profile.movement.strafe > 0) return true;
    const distance = Math.hypot(plan.targetX - world.self.x, plan.targetY - world.self.y);
    return distance > this.profile.movement.arriveTolerance;
  }

  /**
   * Берётся ли манёвром то, что по курсу: уступ с перепадом не выше `rise`
   * (LOC-5, PHYS-11), СПУСК с уступа любой высоты либо дыра, за которой снова
   * есть пол (ARENA-5).
   *
   * Спуск здесь не для полноты. Наземная сущность несёт `cliffRise = 0`, а при
   * нулевом допуске обрыв блокирует В ОБЕ СТОРОНЫ (PHYS-11): бот, запрыгнувший
   * на плато, без прыжка вниз остаётся на нём навсегда. Прыжок ставит допуск на
   * время полёта, а при активном допуске спуск свободен с любой высоты, —
   * поэтому условие тут «допуск вообще есть», а не «перепад в его пределах».
   *
   * Курс — направление на цель МАРШРУТА, а не набранная скорость: решение
   * принимается до микро-слоя, а прыгать бот должен туда, куда собрался, а не
   * туда, куда его донёс разгон прошлых тиков.
   */
  private cliffAhead(
    ability: BotAbilityProfile,
    world: PerceivedWorld,
    plan: BehaviorPlan,
  ): boolean {
    const terrain = this.terrain;
    if (terrain === undefined || ability.range <= 0) return false;
    const dx = plan.targetX - world.self.x;
    const dy = plan.targetY - world.self.y;
    const length = Math.hypot(dx, dy);
    if (length <= this.profile.movement.arriveTolerance) return false;

    const rise = ability.rise ?? 0;
    const own = terrain.levelAt(world.self.x, world.self.y);
    // Шаг щупа — половина клетки: пройти клетку насквозь, не заметив её, нельзя,
    // а считать чаще незачем — рельеф кусочно-постоянен по клеткам (TERR-1).
    const step = Math.max(terrain.tileSize / 2, 1e-3);
    const steps = Math.ceil(ability.range / step);
    for (let i = 1; i <= steps; i++) {
      const reach = Math.min(i * step, ability.range);
      const x = world.self.x + (dx / length) * reach;
      const y = world.self.y + (dy / length) * reach;
      if (!terrain.hasFloorAt(x, y)) {
        // Дыра. Прыгать в неё стоит, только если приземляться есть куда:
        // override уровня действует в полёте, а не после него (LOC-5).
        return this.floorBeyond(terrain, world, dx / length, dy / length, reach, ability.range);
      }
      const climb = terrain.levelAt(x, y) - own;
      if (climb === 0) continue;
      // Спуск проходит при любом допуске, подъём — только в его пределах: уступ
      // выше прыжка обрыв не пропустит (PHYS-11), бот упрётся в него и в полёте,
      // и кнопка уйдёт впустую.
      return climb < 0 ? rise > 0 : climb <= rise;
    }
    return false;
  }

  /** Есть ли за дырой пол в пределах вдвое большего заглядывания. */
  private floorBeyond(
    terrain: BotTerrain,
    world: PerceivedWorld,
    dirX: number,
    dirY: number,
    from: number,
    range: number,
  ): boolean {
    const step = Math.max(terrain.tileSize / 2, 1e-3);
    for (let reach = from + step; reach <= range * 2; reach += step) {
      if (terrain.hasFloorAt(world.self.x + dirX * reach, world.self.y + dirY * reach)) return true;
    }
    return false;
  }
}
