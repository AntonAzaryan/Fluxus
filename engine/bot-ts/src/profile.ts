/**
 * Профиль поведения бота (BOT-6): всё, что тюнит геймдизайнер, — задержка
 * реакции, шум прицела, джиттер таймингов, агрессивность, веса utility — живёт
 * документом контента (`game-content` CONT-1), а не константами кода. Новый
 * уровень сложности заводится JSON-документом; код мозга при этом один.
 *
 * Здесь — форма документа и его валидация. Читается профиль на конструировании
 * мозга (BOT-6) и только там: реализация, дочитывающая профиль по ходу матча,
 * означала бы, что часть поведения всё-таки живёт вне документа.
 *
 * Профиль версионируется с первого дня (design, Open Questions): поле `schema`
 * обязательно и проверяется — состав ручек дорастёт с плейтестами, и документ
 * прошлой формы обязан отличаться от нового явно, а не полем, которого нет.
 *
 * Схемы `engine/schemas/` порождаются из ядра (SER-*) и профилей не касаются:
 * профиль — не документ симуляции, в `worldInit` он не входит и на детерминизм
 * не влияет (BOT-5).
 */

/** Версия формы документа профиля. Растёт при несовместимом изменении состава. */
export const BOT_PROFILE_SCHEMA = 1;

/** Поведения utility-слоя (BOT-6): ключи весов профиля. */
export const BOT_BEHAVIORS = ['pressure', 'kite', 'retreat', 'dodge', 'ability'] as const;

export type BotBehavior = (typeof BOT_BEHAVIORS)[number];

/** Человечность реакции: наблюдение доезжает до решения не мгновенно. */
export interface BotReactionProfile {
  /** Задержка реакции в тиках — глубина буфера наблюдений. */
  readonly delayTicks: number;
  /** Разброс задержки, тики: реакция человека не постоянна. */
  readonly jitterTicks: number;
  /** Горизонт памяти о пропавшем из виду враге, тики (BOT-3: помнить можно, знать — нет). */
  readonly memoryTicks: number;
}

/** Прицел: точные координаты снапшота портятся ровно настолько, насколько велит профиль. */
export interface BotAimProfile {
  /** Амплитуда шума прицела, градусы. */
  readonly noiseDegrees: number;
  /** Как часто мозг пересчитывает шум, тики: дрожание, а не пересчёт каждый тик. */
  readonly noisePeriodTicks: number;
}

/** Тайминги решений: частота передумывания и её джиттер (BOT-6). */
export interface BotDecisionProfile {
  readonly intervalTicks: number;
  readonly jitterTicks: number;
}

/** Микро-слой: чем ограничен steering и когда бот считает, что «у края». */
export interface BotMovementProfile {
  /** Максимальная доля хода стика: 1 — до упора (INP-3). */
  readonly maxSpeed: number;
  /** Радиус, ближе которого цель считается достигнутой, мировые единицы. */
  readonly arriveTolerance: number;
  /** Запас до границы арены, мировые единицы: ближе бот держаться не станет. */
  readonly edgeMargin: number;
}

/** Способность: одна кнопка `buttons` (TICK-2) и политика её применения. */
export interface BotAbilityProfile {
  /** Индекс бита в маске `buttons`, 0..15 (`tick-loop` TICK-2). */
  readonly button: number;
  /** Пауза между применениями, тики. */
  readonly cooldownTicks: number;
  /** Дальность, на которой применение осмысленно, мировые единицы. */
  readonly range: number;
}

export interface BotProfile {
  readonly schema: number;
  readonly name: string;
  readonly reaction: BotReactionProfile;
  readonly aim: BotAimProfile;
  readonly decision: BotDecisionProfile;
  readonly movement: BotMovementProfile;
  readonly ability: BotAbilityProfile;
  /** Веса поведений utility-слоя; ключи — `BOT_BEHAVIORS`. */
  readonly utility: Readonly<Record<BotBehavior, number>>;
  /** Агрессивность: сдвиг предпочтения «давить» против «отступать», 0..1. */
  readonly aggression: number;
  /**
   * Seed внутренней случайности мозга. Необязателен: детерминизм на мозг не
   * распространяется (BOT-5), и несеяная случайность допустима. Поле нужно
   * тестам и воспроизводимым прогонам, а не симуляции.
   */
  readonly seed?: number;
}

interface Findings {
  readonly issues: string[];
}

function record(input: unknown, path: string, findings: Findings): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    findings.issues.push(`${path}: ожидался объект`);
    return {};
  }
  return input as Record<string, unknown>;
}

function num(
  input: Record<string, unknown>,
  key: string,
  path: string,
  range: { min: number; max: number; int?: boolean },
  findings: Findings,
): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    findings.issues.push(`${path}.${key}: ожидалось конечное число`);
    return range.min;
  }
  if (range.int === true && !Number.isInteger(value)) {
    findings.issues.push(`${path}.${key}: ожидалось целое, получено ${value}`);
    return range.min;
  }
  if (value < range.min || value > range.max) {
    findings.issues.push(`${path}.${key}: ${value} вне [${range.min}, ${range.max}]`);
    return range.min;
  }
  return value;
}

/** Тики — целые и неотрицательные: буфер наблюдений и джиттер меряются тиками. */
const TICKS = { min: 0, max: 600, int: true } as const;

/**
 * Разбор и проверка документа профиля (BOT-6). Бросает с полным списком
 * находок, а не с первой: документ правит геймдизайнер, и «почини одно, узнай
 * про следующее» — худший из возможных циклов правки.
 */
export function parseBotProfile(input: unknown, source = 'профиль бота'): BotProfile {
  const findings: Findings = { issues: [] };
  const root = record(input, source, findings);

  const schema = num(root, 'schema', source, { min: 1, max: 1_000_000, int: true }, findings);
  if (schema !== BOT_PROFILE_SCHEMA && findings.issues.length === 0) {
    findings.issues.push(
      `${source}.schema: ${schema} — реализация читает форму ${BOT_PROFILE_SCHEMA}`,
    );
  }
  const name = typeof root.name === 'string' && root.name !== '' ? root.name : '';
  if (name === '') findings.issues.push(`${source}.name: ожидалась непустая строка`);

  const reaction = record(root.reaction, `${source}.reaction`, findings);
  const aim = record(root.aim, `${source}.aim`, findings);
  const decision = record(root.decision, `${source}.decision`, findings);
  const movement = record(root.movement, `${source}.movement`, findings);
  const ability = record(root.ability, `${source}.ability`, findings);
  const utility = record(root.utility, `${source}.utility`, findings);

  const weights = {} as Record<BotBehavior, number>;
  for (const behavior of BOT_BEHAVIORS) {
    weights[behavior] = num(utility, behavior, `${source}.utility`, { min: 0, max: 10 }, findings);
  }

  const profile: BotProfile = {
    schema,
    name,
    reaction: {
      delayTicks: num(reaction, 'delayTicks', `${source}.reaction`, TICKS, findings),
      jitterTicks: num(reaction, 'jitterTicks', `${source}.reaction`, TICKS, findings),
      memoryTicks: num(reaction, 'memoryTicks', `${source}.reaction`, TICKS, findings),
    },
    aim: {
      noiseDegrees: num(aim, 'noiseDegrees', `${source}.aim`, { min: 0, max: 180 }, findings),
      noisePeriodTicks: num(aim, 'noisePeriodTicks', `${source}.aim`, { ...TICKS, min: 1 }, findings),
    },
    decision: {
      intervalTicks: num(decision, 'intervalTicks', `${source}.decision`, { ...TICKS, min: 1 }, findings),
      jitterTicks: num(decision, 'jitterTicks', `${source}.decision`, TICKS, findings),
    },
    movement: {
      maxSpeed: num(movement, 'maxSpeed', `${source}.movement`, { min: 0, max: 1 }, findings),
      arriveTolerance: num(movement, 'arriveTolerance', `${source}.movement`, { min: 0, max: 100 }, findings),
      edgeMargin: num(movement, 'edgeMargin', `${source}.movement`, { min: 0, max: 100 }, findings),
    },
    ability: {
      // Ширина маски `buttons` — u16 (TICK-2): биты выше 15 не переживают круг
      // через транспорт, и профиль не вправе их назначать.
      button: num(ability, 'button', `${source}.ability`, { min: 0, max: 15, int: true }, findings),
      cooldownTicks: num(ability, 'cooldownTicks', `${source}.ability`, TICKS, findings),
      range: num(ability, 'range', `${source}.ability`, { min: 0, max: 1000 }, findings),
    },
    utility: weights,
    aggression: num(root, 'aggression', source, { min: 0, max: 1 }, findings),
    ...(root.seed === undefined
      ? {}
      : { seed: num(root, 'seed', source, { min: 0, max: 2 ** 31 - 1, int: true }, findings) }),
  };

  if (findings.issues.length > 0) {
    throw new Error(`parseBotProfile (BOT-6): ${findings.issues.join('; ')}`);
  }
  return profile;
}
