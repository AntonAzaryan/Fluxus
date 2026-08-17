/**
 * Профиль поведения бота (BOT-6): всё, что тюнит геймдизайнер, — задержка
 * реакции, шум прицела, джиттер таймингов, агрессивность, веса utility и
 * СОСТАВ СПОСОБНОСТЕЙ — живёт документом контента (`game-content` CONT-1), а не
 * константами кода. Новый уровень сложности заводится JSON-документом; код
 * мозга при этом один.
 *
 * Здесь — форма документа и его валидация. Читается профиль на конструировании
 * мозга (BOT-6) и только там: реализация, дочитывающая профиль по ходу матча,
 * означала бы, что часть поведения всё-таки живёт вне документа.
 *
 * Способности — СПИСОК, а не одна кнопка: у героя демо их шесть боевых, и
 * «какими из них бот играет» — ровно тот выбор, который BOT-6 отдаёт документу.
 * Ульта отката времени в списке отсутствует не запретом в коде — код о её
 * существовании не знает вовсе, — а тем, что дизайнер её не назвал: бит ульты
 * ведёт хост мира (`netcode` NET-11), и бот, дёргающий его, останавливал бы
 * матч всем участникам.
 *
 * Профиль версионируется с первого дня (design, Open Questions): поле `schema`
 * обязательно и проверяется — состав ручек дорастёт с плейтестами, и документ
 * прошлой формы обязан отличаться от нового явно, а не полем, которого нет.
 *
 * Схемы `engine/schemas/` порождаются из ядра (SER-*) и профилей не касаются:
 * профиль — не документ симуляции, в `worldInit` он не входит и на детерминизм
 * не влияет (BOT-5).
 */

/**
 * Версия формы документа профиля. Растёт при несовместимом изменении состава.
 *
 * 2 — одна способность (`ability`) заменена списком (`abilities`), из весов
 * `utility` ушло поведение `ability` (способности решаются параллельно
 * движению, а не соревнуются с ним), у `movement` появились дистанция боя и
 * стрейф.
 */
export const BOT_PROFILE_SCHEMA = 2;

/**
 * Поведения utility-слоя (BOT-6): ключи весов профиля. Это выбор МАРШРУТА на
 * ближайшие тики, и способностей среди них нет намеренно — жать кнопку и идти
 * можно одновременно, а поведение «стоять и кастовать» было бы ботом, который
 * замирает ради выстрела.
 */
export const BOT_BEHAVIORS = ['pressure', 'kite', 'retreat', 'dodge'] as const;

export type BotBehavior = (typeof BOT_BEHAVIORS)[number];

/**
 * На что нацелена способность — единственное, что мозг знает о её смысле
 * (BOT-6: механика способности живёт в сцене, а не в мозге):
 *
 * - `enemy` — применяется по видимому противнику в дальности (каст, купол);
 * - `threat` — применяется по сближающемуся снаряду (щит, захват, уклон);
 * - `cliff` — применяется, когда по курсу обрыв или дыра, которые берутся
 *   манёвром (прыжок).
 */
export const BOT_ABILITY_TARGETS = ['enemy', 'threat', 'cliff'] as const;

export type BotAbilityTarget = (typeof BOT_ABILITY_TARGETS)[number];

/** Одна способность: бит `buttons` (TICK-2) и политика её применения. */
export interface BotAbilityProfile {
  /**
   * Имя действия сцены (`cast`, `shield`, `jump`…). Мозгу оно не значит ничего
   * — решает `target`, — и нужно диагностике и находкам валидации: «способность
   * 3» в тексте ошибки дизайнеру не адресуется.
   */
  readonly name: string;
  /** Индекс бита в маске `buttons`, 0..15 (`tick-loop` TICK-2). */
  readonly button: number;
  readonly target: BotAbilityTarget;
  /**
   * Дальность, на которой применение осмысленно, мировые единицы. Для `cliff` —
   * заглядывание вперёд по курсу: насколько далеко бот замечает уступ.
   */
  readonly range: number;
  /**
   * Сколько тиков держать бит. 1 — тап (кнопка нажата тик и отпущена: сцена
   * получает и фронт, и спад, поэтому одним числом выражаются обе конвенции —
   * и «срабатывает по нажатию», и «по отпусканию»). Больше — заряд: бот держит
   * кнопку и отпускает её, накопив силу.
   */
  readonly holdTicks: number;
  /** Пауза между применениями, тики; отсчитывается от отпускания кнопки. */
  readonly cooldownTicks: number;
  /** Вес в соревновании способностей между собой; 0 — способность выключена. */
  readonly weight: number;
  /**
   * Перепад в уровнях террейна (`terrain` TERR-1), который бот берёт манёвром.
   * Обязателен и осмыслен только для `cliff`: это `jumpHeight` конфигурации
   * локомоушена (LOC-5), выраженный в профиле, — компонентов чужой сущности
   * мозг не читает, а прыгать на уступ вдвое выше своего прыжка он не должен.
   */
  readonly rise?: number;
  /**
   * Требует ли манёвр ненулевого вектора движения. Уклон без направления
   * игнорируется симуляцией (LOC-4), прыжок на месте не переносит через обрыв
   * (LOC-5) — обе кнопки, нажатые стоя, сгорели бы в кулдаун впустую.
   * Умолчание — `false`: каст и щит направления не требуют.
   */
  readonly requiresMoving?: boolean;
}

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

/** Микро-слой: чем ограничен steering, где бот хочет драться и как он мельтешит. */
export interface BotMovementProfile {
  /** Максимальная доля хода стика: 1 — до упора (INP-3). */
  readonly maxSpeed: number;
  /** Радиус, ближе которого цель считается достигнутой, мировые единицы. */
  readonly arriveTolerance: number;
  /** Запас до границы арены, мировые единицы: ближе бот держаться не станет. */
  readonly edgeMargin: number;
  /**
   * Дистанция боя, мировые единицы: масштаб, по которому решаются «давить»
   * против «кайтить» и на котором сближающийся снаряд уже страшен. Своим
   * числом, а не дальностью какой-нибудь из способностей: список способностей
   * дизайнер меняет, а желаемая дистанция боя — свойство самого бота.
   */
  readonly engageRange: number;
  /**
   * Доля хода, уходящая в поперечное смещение при сближении и кайте: 0 — бот
   * ходит по прямой и потому попадаем в упор. Стрейф — не украшение: снаряд
   * летит по прямой, и цель, идущая ровно на стрелка, не промахивается мимо
   * себя.
   */
  readonly strafe: number;
  /** Период смены стороны стрейфа, тики: маятник, а не дрожь. */
  readonly strafePeriodTicks: number;
}

export interface BotProfile {
  readonly schema: number;
  readonly name: string;
  readonly reaction: BotReactionProfile;
  readonly aim: BotAimProfile;
  readonly decision: BotDecisionProfile;
  readonly movement: BotMovementProfile;
  /** Способности, которыми бот играет (BOT-6). Пустой список — бот-мишень. */
  readonly abilities: readonly BotAbilityProfile[];
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

function flag(
  input: Record<string, unknown>,
  key: string,
  path: string,
  findings: Findings,
): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    findings.issues.push(`${path}.${key}: ожидалось true или false`);
    return undefined;
  }
  return value;
}

/** Тики — целые и неотрицательные: буфер наблюдений и джиттер меряются тиками. */
const TICKS = { min: 0, max: 600, int: true } as const;

/** Одна запись списка способностей: своя валидация, свой путь в находках. */
function parseAbility(input: unknown, path: string, findings: Findings): BotAbilityProfile {
  const root = record(input, path, findings);
  const name = typeof root.name === 'string' && root.name !== '' ? root.name : '';
  if (name === '') findings.issues.push(`${path}.name: ожидалась непустая строка`);

  const target = root.target;
  const known = (BOT_ABILITY_TARGETS as readonly unknown[]).includes(target);
  if (!known) {
    findings.issues.push(
      `${path}.target: ожидалось одно из ${BOT_ABILITY_TARGETS.join('|')}, получено ${JSON.stringify(target)}`,
    );
  }
  const resolved: BotAbilityTarget = known ? (target as BotAbilityTarget) : 'enemy';

  // Перепад уступа спрашивается ровно у той цели, для которой он что-то значит:
  // `rise` у каста — не безобидное лишнее поле, а признак того, что документ
  // писали, не понимая, что настраивают.
  const rise =
    resolved === 'cliff'
      ? num(root, 'rise', path, { min: 0, max: 15, int: true }, findings)
      : undefined;
  if (resolved !== 'cliff' && root.rise !== undefined) {
    findings.issues.push(`${path}.rise: перепад уступа осмыслен только у цели "cliff"`);
  }
  const requiresMoving = flag(root, 'requiresMoving', path, findings);

  return {
    name,
    // Ширина маски `buttons` — u16 (TICK-2): биты выше 15 не переживают круг
    // через транспорт, и профиль не вправе их назначать.
    button: num(root, 'button', path, { min: 0, max: 15, int: true }, findings),
    target: resolved,
    range: num(root, 'range', path, { min: 0, max: 1000 }, findings),
    holdTicks: num(root, 'holdTicks', path, { ...TICKS, min: 1 }, findings),
    cooldownTicks: num(root, 'cooldownTicks', path, TICKS, findings),
    weight: num(root, 'weight', path, { min: 0, max: 10 }, findings),
    ...(rise === undefined ? {} : { rise }),
    ...(requiresMoving === undefined ? {} : { requiresMoving }),
  };
}

function parseAbilities(input: unknown, source: string, findings: Findings): BotAbilityProfile[] {
  const path = `${source}.abilities`;
  if (!Array.isArray(input)) {
    findings.issues.push(`${path}: ожидался массив способностей`);
    return [];
  }
  const abilities = input.map((entry, index) => parseAbility(entry, `${path}[${index}]`, findings));
  // Две способности на одном бите — не опечатка в одном документе, а бот,
  // который вместо купола кастует щит: маска одна, и различить их сцене нечем.
  const seen = new Map<number, string>();
  for (const ability of abilities) {
    const first = seen.get(ability.button);
    if (first !== undefined) {
      findings.issues.push(
        `${path}: бит ${ability.button} назначен дважды — "${first}" и "${ability.name}"`,
      );
      continue;
    }
    seen.set(ability.button, ability.name);
  }
  return abilities;
}

/**
 * Разбор и проверка документа профиля (BOT-6). Бросает с полным списком
 * находок, а не с первой: документ правит геймдизайнер, и «почини одно, узнай
 * про следующее» — худший из возможных циклов правки.
 */
export function parseBotProfile(input: unknown, source = 'профиль бота'): BotProfile {
  const findings: Findings = { issues: [] };
  const root = record(input, source, findings);

  const schema = num(root, 'schema', source, { min: 1, max: 1_000_000, int: true }, findings);
  // Расхождение формы называется ВСЕГДА, а не только когда прочих находок нет:
  // документ будущей формы шумит несовпадением полей, и именно версия
  // объясняет этот шум — промолчать о ней значит спрятать причину за следствием.
  if (schema !== BOT_PROFILE_SCHEMA) {
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
      engageRange: num(movement, 'engageRange', `${source}.movement`, { min: 0, max: 1000 }, findings),
      strafe: num(movement, 'strafe', `${source}.movement`, { min: 0, max: 1 }, findings),
      strafePeriodTicks: num(movement, 'strafePeriodTicks', `${source}.movement`, { ...TICKS, min: 1 }, findings),
    },
    abilities: parseAbilities(root.abilities, source, findings),
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
