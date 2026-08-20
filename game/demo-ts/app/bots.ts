/**
 * Бот демо-арены как ДАННЫЕ: профиль (BOT-6) и документ поведения (BOT-8),
 * который этот профиль называет.
 *
 * Модуль сборки ИГРЫ, и потому дерево контента читает законно (CONT-4): движку
 * это запрещено, а демо и есть игра. Здесь же держится связка двух документов —
 * профиль называет путь документа поведения, а не сборка выбирает его сама:
 * «какую политику играет этот бот» — выбор дизайнера, выраженный данными.
 *
 * Дерево во вкладке не листается: сборщик кладёт документы поведения в бандл
 * статическими импортами, а путь из профиля резолвится по ним. Незнакомый путь
 * — отказ здесь и сейчас: бот с ненайденной политикой не «играет как раньше», он
 * не собирается вовсе.
 *
 * Контентом этот модуль не является (`game-content` CONT-1): контент лежит в
 * `content/`, здесь только его чтение и разбор.
 */
import {
  parseBotBehavior,
  parseBotProfile,
  type BotBehaviorDocument,
  type BotProfile,
} from '@game-mvp/bot';
import profileJson from '../../../content/bots/normal.json';
import classicJson from '../../../content/bots/behaviors/classic.json';
import cautiousJson from '../../../content/bots/behaviors/cautious.json';

/** Документы поведения по пути ОТ КОРНЯ дерева контента — так адресуется ассет (ASSET-2). */
const BEHAVIORS: Readonly<Record<string, unknown>> = {
  'bots/behaviors/classic.json': classicJson,
  'bots/behaviors/cautious.json': cautiousJson,
};

/** Профиль бота демо (BOT-6): проверяется на входе, а не принимается на веру. */
export function demoBotProfile(source = 'профиль бота демо'): BotProfile {
  return parseBotProfile(profileJson, source);
}

/** Документ поведения, названный профилем (BOT-8). */
export function demoBotBehavior(profile: BotProfile): BotBehaviorDocument {
  const document = BEHAVIORS[profile.behavior];
  if (document === undefined) {
    throw new Error(
      `демо: профиль "${profile.name}" называет документ поведения "${profile.behavior}", ` +
        `которого нет в сборке; известные: ${Object.keys(BEHAVIORS).join(', ')} (BOT-8)`,
    );
  }
  return parseBotBehavior(document, profile.behavior);
}
