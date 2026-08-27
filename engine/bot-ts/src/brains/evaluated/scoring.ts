/**
 * Скоринг документа поведения (BOT-9): вход словаря → кривая отклика → вес →
 * полезность действия.
 *
 * Здесь и только здесь живёт словарь ВХОДОВ — нормировка наблюдения в [0, 1].
 * Нормировка — код, а не документ: масштаб берётся из профиля (дистанция боя,
 * запас до края) и из состояния (радиус арены, кулдаун своего слота), и
 * дизайнеру незачем повторять её в каждом documenте кривой.
 *
 * СЧИТАЛОК здесь нет: кривая отклика, оценка оси и композиция — общая модель
 * скоринга ядра (`npc-behavior` NPC-3), которую бот делит с поведением NPC.
 * Собственной реализации считалок и собственного словаря форм кривых у бота
 * быть не должно (BOT-9); ботовыми остаются словарь ВХОДОВ (ниже) и словарь
 * ИСПОЛНИТЕЛЕЙ (`layers/plan.ts`).
 *
 * Ветвлений «по имени поведения» тут нет ни одного (BOT-8): `switch` разбирает
 * ВХОД — то есть форму документа, — а не то, какое действие считается. Действие
 * для этого модуля — список осей, и `pressure` он от `retreat` не отличает.
 *
 * Разбор пересчёта (BOT-10) строится ТОЛЬКО когда трасса включена: `records`
 * равно `undefined` — и ни одного объекта на тик не создаётся.
 */
import {
  clamp01,
  combineUtility,
  considerationScore as scoreAxis,
  curveValue as curveOfModel,
  finishUtility,
  UTILITY_IDENTITY,
} from '@fluxus/core';
import type { BotAction, BotBehaviorDocument, BotConsideration, BotCurve, BotExecutor } from '../../behavior.js';
import type { BotProfile } from '../../profile.js';
import type { PerceivedWorld } from '../layers/perception.js';
import { distanceFromCenter, nearestEnemy, nearestThreat, type ArenaCenter } from '../layers/plan.js';

/** Что скорингу нужно знать о сцене и о боте помимо наблюдения. */
export interface ScoringContext {
  readonly profile: BotProfile;
  readonly center: ArenaCenter;
}

/** Оценка одной оси в разборе пересчёта (BOT-10). */
export interface ConsiderationTrace {
  readonly input: BotConsideration['input'];
  /** Слот способности у входа `abilityCooldownFraction`; иначе отсутствует. */
  readonly slot?: number;
  /** Оценка после кривой и веса — то, что ушло в произведение. */
  readonly score: number;
}

/** Разбор полезности одного действия (BOT-10). */
export interface ActionTrace {
  readonly executor: BotExecutor;
  readonly utility: number;
  readonly considerations: readonly ConsiderationTrace[];
}

/**
 * Разбор ОДНОГО пересчёта решения (BOT-10): чем считали, сколько получилось и
 * кто выиграл. Чистое наблюдение — на выбор мозга не влияет.
 */
export interface BotDecisionRecord {
  readonly tick: number;
  readonly actions: readonly ActionTrace[];
  /** Выбранный исполнитель; при нулевых очках — умолчание механизма (BOT-9). */
  readonly chosen: BotExecutor;
  /** Полезность победителя; ноль — очков не набрал никто. */
  readonly utility: number;
}

/** Колбэк трассы решений; отсутствие — трасса выключена, записи не строятся. */
export type BotDecisionSink = (record: BotDecisionRecord) => void;

/**
 * Умолчание механизма при нулевых очках (BOT-9): к центру — там бот видит
 * больше и не падает с арены. Именно МЕХАНИЗМА, а не документа: документ,
 * забывший объявить действие, не обязан ещё и объявлять запасное.
 */
export const FALLBACK_EXECUTOR: BotExecutor = 'retreat';

/**
 * Значение входа словаря в [0, 1] (BOT-9). Нормировка названа у каждого входа:
 * это ровно то, что отличает «вход словаря» от «поля мира».
 */
export function inputValue(
  consideration: BotConsideration,
  world: PerceivedWorld,
  context: ScoringContext,
): number {
  const { profile, center } = context;
  switch (consideration.input) {
    case 'enemyKnown':
      return nearestEnemy(world) === undefined ? 0 : 1;
    case 'enemyDistance': {
      const enemy = nearestEnemy(world);
      const range = profile.movement.engageRange;
      // ШКАЛЫ НЕТ — сравнивать не с чем, и вход не значит ничего: ноль здесь
      // говорит «ни один вывод о дистанции не обоснован», а не «враг вплотную».
      // Профиль такую дистанцию боя объявить не вправе (BOT-9, `profile.ts`:
      // масштаб входов проверяется валидацией), и ветка держится защитой от
      // руками собранного профиля, а не поведением, которое кто-то настраивает.
      if (range <= 0) return 0;
      // Врага не видно и не помнится — «дальше некуда»: давить и кайтить не на
      // кого, и говорят это ворота `enemyKnown`, а не подмена расстояния.
      if (enemy === undefined) return 1;
      // Масштаб — ДВЕ дистанции боя: на ней вход достигает единицы, и вся
      // «шкала боя» — от вплотную до вдвое дальше желаемого — ложится в [0, 1].
      return clamp01(Math.hypot(enemy.x - world.self.x, enemy.y - world.self.y) / (2 * range));
    }
    case 'threatClosing':
      return nearestThreat(world) === undefined ? 0 : 1;
    case 'threatDistance': {
      const threat = nearestThreat(world);
      const range = profile.movement.engageRange;
      // Та же защита, что у `enemyDistance`, и тот же смысл: без шкалы вывода о
      // дистанции нет. Ноль убывающая кривая читает как «снаряд вплотную»,
      // поэтому «нечего сказать» здесь выражается ЕДИНИЦЕЙ — уклоняться не от
      // чего, ровно как при отсутствии сближающегося снаряда.
      if (threat === undefined || range <= 0) return 1;
      return clamp01(threat.distance / range);
    }
    case 'edgeProximity': {
      const radius = world.arenaRadius;
      const margin = profile.movement.edgeMargin;
      // Ноль на входе в запас до границы, единица — на самой границе (ARENA-2).
      // Арены в снапшоте нет — краю неоткуда взяться.
      if (radius === undefined || margin <= 0) return 0;
      return clamp01((distanceFromCenter(world, center) - (radius - margin)) / margin);
    }
    case 'abilityCooldownFraction': {
      const slot = world.slots.find((entry) => entry.slotIndex === consideration.slot);
      // Слота нет в снапшоте — «ничто не мешает»: у входа один смысл, и
      // «кулдауна нет» и «слот неизвестен» ведут себя одинаково.
      return slot === undefined ? 0 : clamp01(slot.cooldown);
    }
  }
}

/**
 * Кривая отклика: значение входа → оценка, зажатая в [0, 1] (BOT-9). Тело —
 * общая модель ядра (NPC-3); здесь только имя, которым кривую зовут тесты и
 * соседние слои бота. `BotCurve` — псевдоним формы этой же модели, поэтому
 * приведения между ними нет.
 */
export function curveValue(curve: BotCurve, x: number): number {
  return curveOfModel(curve, x);
}

/** Оценка оси: кривая от входа, взвешенная документом; лежит в [0, 1] (BOT-9). */
export function considerationScore(
  consideration: BotConsideration,
  world: PerceivedWorld,
  context: ScoringContext,
): number {
  return scoreAxis(consideration.curve, consideration.weight, inputValue(consideration, world, context));
}

/**
 * Полезность действия — композиция оценок его осей (BOT-9). Правило композиции
 * — произведение с сохранением диапазона — живёт в общей модели ядра (NPC-3);
 * компенсацию числа осей (штраф Дэйва Марка) v1 не вводит: осей мало, и форма
 * документа позволяет добавить её полем позже.
 */
export function actionUtility(
  action: BotAction,
  world: PerceivedWorld,
  context: ScoringContext,
): number {
  let utility = UTILITY_IDENTITY;
  for (const consideration of action.considerations) {
    utility = combineUtility(utility, considerationScore(consideration, world, context));
  }
  return finishUtility(utility);
}

/** Выбор действия и (если трасса включена) разбор пересчёта. */
export interface ScoredDecision {
  readonly chosen: BotExecutor;
  readonly utility: number;
  /** Разбор; `undefined` — трасса выключена (BOT-10, ноль стоимости). */
  readonly record: BotDecisionRecord | undefined;
}

/**
 * Пересчёт решения по документу: побеждает действие с наибольшей полезностью,
 * ничью решает порядок документа, нулевая полезность не выбирается вовсе
 * (BOT-9). Когда очков не набрал никто — умолчание механизма.
 */
export function scoreDocument(
  document: BotBehaviorDocument,
  world: PerceivedWorld,
  context: ScoringContext,
  tick: number,
  traced: boolean,
): ScoredDecision {
  const traces: ActionTrace[] | undefined = traced ? [] : undefined;
  let chosen: BotExecutor = FALLBACK_EXECUTOR;
  let best = 0;
  for (const action of document.actions) {
    const utility =
      traces === undefined
        ? actionUtility(action, world, context)
        : tracedUtility(action, world, context, traces);
    // Строго больше: ничья остаётся за ранее найденным, то есть за более ранним
    // действием документа, а ноль не выигрывает никогда.
    if (utility > best) {
      best = utility;
      chosen = action.executor;
    }
  }
  return {
    chosen,
    utility: best,
    record: traces === undefined ? undefined : { tick, actions: traces, chosen, utility: best },
  };
}

/** Та же полезность, но с записью оценок по осям — только для включённой трассы. */
function tracedUtility(
  action: BotAction,
  world: PerceivedWorld,
  context: ScoringContext,
  traces: ActionTrace[],
): number {
  const considerations: ConsiderationTrace[] = [];
  let utility = UTILITY_IDENTITY;
  for (const consideration of action.considerations) {
    const score = considerationScore(consideration, world, context);
    considerations.push({
      input: consideration.input,
      ...(consideration.slot === undefined ? {} : { slot: consideration.slot }),
      score,
    });
    utility = combineUtility(utility, score);
  }
  const clamped = finishUtility(utility);
  traces.push({ executor: action.executor, utility: clamped, considerations });
  return clamped;
}
