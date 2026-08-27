/**
 * Словари документа поведения NPC как таблицы «имя → код» (`npc-behavior`
 * NPC-2). Отдельным модулем, потому что читают их двое: разбор документа
 * (проверка закрытости словаря) и системы платформы (сравнение кодов), а два
 * списка под одним именем — способ им разъехаться.
 *
 * Коды совпадают с местом имени в своём наборе — порядок наборов в `model.ts`
 * нормативен, и таблицы здесь лишь дают ему форму, удобную разбору.
 */
import {
  COND_ELAPSED,
  COND_EVENT,
  COND_HAS_TARGET,
  COND_HEALTH_ABOVE,
  COND_HEALTH_BELOW,
  COND_NO_TARGET,
  COND_ROUTE_DONE,
  COND_TARGET_BEYOND,
  COND_TARGET_WITHIN,
  EXEC_CAST,
  EXEC_FOLLOW_ROUTE,
  EXEC_HOLD,
  EXEC_SEEK_TARGET,
  INPUT_ALWAYS,
  INPUT_CROWDING,
  INPUT_HEALTH_FRACTION,
  INPUT_ROUTE_REMAINING,
  INPUT_STATE_ELAPSED,
  INPUT_TARGET_DISTANCE,
  INPUT_TARGET_KNOWN,
  TIER_ELITE,
  TIER_MASS,
} from './model.js';
import { SCORING_CURVES } from '../../dsl/scoring.js';

export const TIER_CODES: Readonly<Record<string, number>> = Object.freeze({
  mass: TIER_MASS,
  elite: TIER_ELITE,
});

export const EXECUTOR_CODES: Readonly<Record<string, number>> = Object.freeze({
  hold: EXEC_HOLD,
  followRoute: EXEC_FOLLOW_ROUTE,
  seekTarget: EXEC_SEEK_TARGET,
  cast: EXEC_CAST,
});

export const INPUT_CODES: Readonly<Record<string, number>> = Object.freeze({
  always: INPUT_ALWAYS,
  targetKnown: INPUT_TARGET_KNOWN,
  targetDistance: INPUT_TARGET_DISTANCE,
  healthFraction: INPUT_HEALTH_FRACTION,
  crowding: INPUT_CROWDING,
  stateElapsed: INPUT_STATE_ELAPSED,
  routeRemaining: INPUT_ROUTE_REMAINING,
});

export const CONDITION_CODES: Readonly<Record<string, number>> = Object.freeze({
  healthBelow: COND_HEALTH_BELOW,
  healthAbove: COND_HEALTH_ABOVE,
  elapsed: COND_ELAPSED,
  event: COND_EVENT,
  targetWithin: COND_TARGET_WITHIN,
  targetBeyond: COND_TARGET_BEYOND,
  hasTarget: COND_HAS_TARGET,
  noTarget: COND_NO_TARGET,
  routeDone: COND_ROUTE_DONE,
});

/**
 * Формы кривой — словарь ОБЩЕЙ МОДЕЛИ (NPC-3): своего набора у документа NPC
 * нет. Таблица ВЫВОДИТСЯ из набора модели, а не переписывается рядом: код формы
 * и есть её место в `SCORING_CURVES`, и переписанный список молча отвергал бы в
 * документе NPC форму, которую документ бота уже принимает, — то есть заводил бы
 * второй словарь форм ровно там, где NPC-3 обещает его отсутствие.
 */
export const CURVE_CODES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(SCORING_CURVES.map((name, code) => [name, code])),
);
