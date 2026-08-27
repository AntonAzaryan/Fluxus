/**
 * Документ поведения бота (BOT-8): политика выбора действий — состав действий,
 * considerations, кривые и веса — живёт документом дерева контента (`game-content`
 * CONT-1), а не кодом. Новое поведение бота заводится правкой документа; код
 * evaluator'а при этом не меняется.
 *
 * Здесь — ФОРМА документа и его валидация; вычисление оценок — в
 * `brains/evaluated/scoring.ts`, исполнители — в `brains/layers/plan.ts`.
 * Evaluator знает форму документа, а не его содержимое: ветвлений «по имени
 * поведения» в нём нет — по образцу пары «JSON-система / ядро-evaluator»
 * (`data-driven-systems`).
 *
 * Разрез с профилем (BOT-6, BOT-8) нормативный и держится здесь: документ
 * поведения отвечает «что делать», профиль — «насколько хорошо» (реакция, шум,
 * джиттер, тайминги решений, состав способностей). Соответствие бота его
 * документу — ДАННЫЕ: путь документа называет профиль (`BotProfile.behavior`), а
 * не константа кода.
 *
 * Три словаря — исполнителей, входов и кривых — ЗАКРЫТЫ (BOT-9). Расширение
 * любого из них — осознанная правка кода с ревью, как новая нативная система
 * рядом с JSON-системами: это и есть защита от inner-platform effect, то есть от
 * DSL, переизобретающего TypeScript. Композицию исполнителей, steering-примитивы
 * и микро-слой документ описывать не вправе вовсе — это механизм.
 *
 * Из трёх словарей ботовых ДВА: исполнители и входы. Словарь форм кривых —
 * общей модели скоринга ядра (`npc-behavior` NPC-3), разделяемой с поведением
 * NPC: новая форма появляется одной правкой модели и становится доступна обоим
 * документам, а «ботового» набора форм не существует.
 *
 * Форма — интерпретируемая, но компиляции не мешает (design, решение владельца):
 * действие — плоский список considerations с кривой-записью, поэтому «собрать из
 * документа функцию» остаётся возможным без смены формата.
 */
import {
  SCORING_CURVES,
  SCORING_CURVE_FIELDS,
  type ScoringCurve,
  type ScoringCurveType,
} from '@fluxus/core';
import {
  name as documentName,
  num,
  oneOf,
  record,
  schema as schemaField,
  throwFindings,
  type Findings,
} from './findings.js';

/**
 * Версия формы документа поведения (BOT-8). Растёт при несовместимом изменении
 * состава: документ прошлой формы обязан отличаться от нового явно, а не полем,
 * которого нет.
 */
export const BOT_BEHAVIOR_SCHEMA = 1;

/**
 * Исполнители — закрытый словарь кодовых веток `planFor` (BOT-9). Действие
 * документа ссылается на исполнителя по имени, а сочинить нового из
 * steering-примитивов документ не может: новый исполнитель — правка кода.
 */
export const BOT_EXECUTORS = ['pressure', 'kite', 'retreat', 'dodge'] as const;

export type BotExecutor = (typeof BOT_EXECUTORS)[number];

/**
 * Входы considerations — закрытый словарь наблюдений, нормированных в [0, 1]
 * (BOT-9). Нормировка — код словаря (`scoring.ts`), а не документ: масштаб берётся
 * из профиля (дистанция боя, запас до края) и из состояния (радиус арены).
 *
 * - `enemyDistance` — расстояние до ближайшего известного врага в масштабе боя;
 * - `enemyKnown` — известен ли враг вообще (видим или помнится);
 * - `threatDistance` — расстояние до ближайшего СБЛИЖАЮЩЕГОСЯ снаряда;
 * - `threatClosing` — летит ли в бота хоть что-нибудь;
 * - `edgeProximity` — насколько бот вышел в запас до границы арены (ARENA-2);
 * - `abilityCooldownFraction` — доля оставшегося кулдауна СВОЕГО слота (ABIL-7);
 *   единственный вход с параметром — consideration называет слот полем `slot`.
 */
export const BOT_INPUTS = [
  'enemyDistance',
  'enemyKnown',
  'threatDistance',
  'threatClosing',
  'edgeProximity',
  'abilityCooldownFraction',
] as const;

export type BotInput = (typeof BOT_INPUTS)[number];

/**
 * Формы кривой отклика — закрытый набор ОБЩЕЙ МОДЕЛИ (BOT-9, `npc-behavior`
 * NPC-3): своего набора у бота нет, и новая форма приезжает сюда правкой
 * модели ядра, а не правкой этого файла. Параметры живут полями кривой.
 */
export const BOT_CURVES = SCORING_CURVES;

export type BotCurveType = ScoringCurveType;

/**
 * Кривая отклика: вход в [0, 1] → оценка, которая клампится в [0, 1]. Форма —
 * общей модели (NPC-3), псевдоним оставлен ради читаемости документа бота.
 *
 * Формул в документе нет и не будет (design Non-Goals): «вход → кривая → вес» —
 * это ровно та граница, за которой начинается генеральный DSL выражений.
 */
export type BotCurve = ScoringCurve;

/** Одна ось полезности: вход словаря, кривая отклика и вес (BOT-9). */
export interface BotConsideration {
  readonly input: BotInput;
  /**
   * Индекс слота способности (`AbilitySlot.slotIndex`, ABIL-1) для входа
   * `abilityCooldownFraction`. У прочих входов поле бессмысленно и потому
   * отвергается: лишнее поле — признак того, что документ писали, не понимая,
   * что настраивают.
   */
  readonly slot?: number;
  readonly curve: BotCurve;
  /**
   * Вес оси, 0..1. Верхняя граница — не вкус, а требование диапазона (BOT-9):
   * оценка consideration'а лежит в [0, 1], полезность действия есть их
   * произведение, и вес больше единицы вывел бы произведение за диапазон, то
   * есть сделал бы веса разных действий несравнимыми. Приоритет одного действия
   * над другим выражается ОТНОШЕНИЕМ весов, а общий множитель на решение не
   * влияет — политику всегда можно ужать в [0, 1], не меняя ни одного выбора.
   */
  readonly weight: number;
}

/** Действие: кодовый исполнитель и оси его полезности (BOT-9). */
export interface BotAction {
  readonly executor: BotExecutor;
  readonly considerations: readonly BotConsideration[];
}

export interface BotBehaviorDocument {
  readonly schema: number;
  readonly name: string;
  /**
   * Действия в порядке документа. Порядок нормативен: при равных полезностях
   * выигрывает первое — иначе ничья решалась бы порядком ключей объекта, то
   * есть случайностью сериализации.
   */
  readonly actions: readonly BotAction[];
}

/**
 * Разбор кривой: форма из словаря ОБЩЕЙ МОДЕЛИ, параметры — её же таблица
 * полей (BOT-9, NPC-3). Ходом по таблице, а не своим `switch` на имя формы:
 * иначе новая форма модели требовала бы второй правки — здесь, — и обещание
 * «одна правка на обоих потребителей» держалось бы на памяти автора.
 *
 * Диапазоны параметров широкие намеренно: кривая — форма отклика, а не
 * балансное число, и ограничивать наклон значило бы запрещать дизайнеру
 * резкость. Клампится РЕЗУЛЬТАТ (общая модель), а не коэффициенты; поле-долю
 * модель называет сама, и её диапазон — [0, 1].
 */
function parseCurve(input: unknown, path: string, findings: Findings): BotCurve {
  const root = record(input, path, findings);
  const named = oneOf(root, 'type', path, BOT_CURVES, findings);
  // Неизвестная форма уже названа находкой; читается она как прямая, чтобы
  // разбор дошёл до конца и назвал ОСТАЛЬНЫЕ находки документа.
  const type: ScoringCurveType = named ?? 'linear';
  const span = { min: -1000, max: 1000 } as const;
  const parsed: Record<string, unknown> = { type };
  for (const field of SCORING_CURVE_FIELDS[type]) {
    parsed[field.key] = num(root, field.key, path, field.unit ? { min: 0, max: 1 } : span, findings);
  }
  return parsed as unknown as BotCurve;
}

/** Разбор одной оси полезности: вход, его параметр, кривая и вес. */
function parseConsideration(input: unknown, path: string, findings: Findings): BotConsideration {
  const root = record(input, path, findings);
  const named = oneOf(root, 'input', path, BOT_INPUTS, findings);
  const resolved: BotInput = named ?? 'enemyKnown';
  // Слот спрашивается ровно у того входа, для которого он что-то значит, — тем
  // же правилом, каким профиль спрашивает перепад уступа только у цели `cliff`.
  const needsSlot = resolved === 'abilityCooldownFraction';
  const slot = needsSlot
    ? num(root, 'slot', path, { min: 0, max: 63, int: true }, findings)
    : undefined;
  if (!needsSlot && root.slot !== undefined) {
    findings.issues.push(`${path}.slot: слот осмыслен только у входа "abilityCooldownFraction"`);
  }
  return {
    input: resolved,
    ...(slot === undefined ? {} : { slot }),
    curve: parseCurve(root.curve, `${path}.curve`, findings),
    weight: num(root, 'weight', path, { min: 0, max: 1 }, findings),
  };
}

/** Разбор одного действия: исполнитель словаря и непустой список considerations. */
function parseAction(input: unknown, path: string, findings: Findings): BotAction {
  const root = record(input, path, findings);
  const executor = oneOf(root, 'executor', path, BOT_EXECUTORS, findings);
  const considerations: BotConsideration[] = [];
  if (!Array.isArray(root.considerations)) {
    findings.issues.push(`${path}.considerations: ожидался массив осей полезности`);
  } else if (root.considerations.length === 0) {
    // Пустой список — действие с полезностью «пустого произведения», то есть
    // всегда выигрывающее. Умолчание механизма (BOT-9) от такого документа не
    // спасает: выбор состоялся бы, просто ни на чём не основанный.
    findings.issues.push(
      `${path}.considerations: пустой список — полезность действия не на чем считать`,
    );
  } else {
    for (const [index, entry] of root.considerations.entries()) {
      considerations.push(parseConsideration(entry, `${path}.considerations[${index}]`, findings));
    }
  }
  return { executor: executor ?? 'retreat', considerations };
}

/**
 * Разбор и проверка документа поведения (BOT-8). Бросает с полным списком
 * находок: документ правит геймдизайнер, и находки адресованы ему.
 *
 * Зовётся на конструировании мозга (BOT-8) — в том числе тогда, когда сборка уже
 * разобрала документ у себя: между сборкой и мозгом лежит structured clone
 * границы воркера, и «его уже проверили» там предположение, а не факт.
 */
export function parseBotBehavior(
  input: unknown,
  source = 'документ поведения бота',
): BotBehaviorDocument {
  const findings: Findings = { issues: [] };
  const root = record(input, source, findings);
  const schema = schemaField(root, source, BOT_BEHAVIOR_SCHEMA, findings);
  const name = documentName(root, source, findings);

  const actions: BotAction[] = [];
  if (!Array.isArray(root.actions)) {
    findings.issues.push(`${source}.actions: ожидался массив действий`);
  } else if (root.actions.length === 0) {
    findings.issues.push(`${source}.actions: ни одного действия — выбирать не из чего`);
  } else {
    for (const [index, entry] of root.actions.entries()) {
      actions.push(parseAction(entry, `${source}.actions[${index}]`, findings));
    }
  }
  // Два действия на одном исполнителе — не опечатка, а вопрос без ответа: чья
  // полезность считается настоящей. Порядок документа решает ничьи, а не
  // дубликаты: побеждала бы просто первая запись, и вторая молча ничего не
  // значила бы.
  const seen = new Set<BotExecutor>();
  for (const action of actions) {
    if (seen.has(action.executor)) {
      findings.issues.push(`${source}.actions: исполнитель "${action.executor}" объявлен дважды`);
    }
    seen.add(action.executor);
  }

  throwFindings('parseBotBehavior (BOT-8)', findings);
  return { schema, name, actions };
}
