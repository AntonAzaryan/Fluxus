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
import { ABILITY_STEPS } from '@game-mvp/core';

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

/**
 * Чем заняты руки бота — второе и последнее, что мозг знает о смысле
 * способности (BOT-6). Нужно оно потому, что сцена вправе развести ДВА своих
 * определения на одном бите условием на владельце: пустой рукой бит кастует
 * заряд, с пойманным снарядом — бросает его. Определений мозг не знает и знать
 * не должен; знает он ровно то, что сказал документ:
 *
 * - `free` — только со свободными руками;
 * - `full` — только с пойманным снарядом в руках.
 *
 * Поле необязательно: щиту, уклону и прыжку руки безразличны, и молчание
 * документа — это «безразличны», а не «свободны».
 */
export const BOT_ABILITY_HANDS = ['free', 'full'] as const;

export type BotAbilityHands = (typeof BOT_ABILITY_HANDS)[number];

/**
 * Чем целится ОДИН шаг цепочки прицеливания (ABIL-5). Уже, чем цели выбора
 * способности: шаг называет ТОЧКУ, а `cliff` точки не даёт — это признак
 * «по курсу уступ», и шагом он не выражается.
 */
export const BOT_STEP_AIMS = ['enemy', 'threat', 'self'] as const;

export type BotStepAim = (typeof BOT_STEP_AIMS)[number];

/**
 * Чем подтверждается шаг цепочки — то же различие, что у вида фазы в сцене
 * (ABIL-4, ABIL-5):
 *
 * - `confirm` — ФРОНТОМ бита подтверждения: бот целится и жмёт `confirmButton`;
 * - `release` — ПРЕКРАЩЕНИЕМ УДЕРЖАНИЯ бита триггера: бот держит кнопку, целясь,
 *   и перестаёт её держать; прицеливание того же тика и есть шаг, и отдельного
 *   бита подтверждения тут нет вовсе.
 *
 * Молчание документа — `confirm`: способность, описанная до появления фазы
 * `release`, подтверждается так, как подтверждалась.
 */
export const BOT_CAST_COMMITS = ['confirm', 'release'] as const;

export type BotCastCommit = (typeof BOT_CAST_COMMITS)[number];

/** Один шаг цепочки прицеливания: чем целится и когда подтверждается (BOT-6). */
export interface BotAbilityStepProfile {
  readonly aim: BotStepAim;
  /**
   * Сколько тиков бот целится, прежде чем подтвердить шаг. Человечность, а не
   * механика: мгновенное подтверждение цепочки — тот же сверхчеловеческий ввод,
   * что прицел без шума (BOT-6).
   */
  readonly confirmDelayTicks: number;
  /** Шум точки прицела шага, мировые единицы: дизайнер решает, как криво бот целится. */
  readonly pointNoise: number;
}

/**
 * Способность платформы (ABIL-1..ABIL-5) в терминах профиля: фазы каста и
 * цепочка шагов вместо одного бита с дальностью (BOT-6). Соответствие
 * способности СЦЕНЫ и этой записи — данные: индекс слота владельца и биты
 * подтверждения с отменой называет документ, а не код мозга.
 *
 * Блок необязателен, и это несущее: способность, описанная одним битом, — не
 * ошибка документа, а способность СТАРОГО вида (сцена гейтит её сама, без
 * подтверждения шага). Способность, требующую подтверждения, такой профиль
 * просто не применяет — чинится это профилем, а не ветвлением в коде мозга.
 */
export interface BotAbilityCastProfile {
  /** Индекс слота владельца (`AbilitySlot.slotIndex`, ABIL-1). */
  readonly slotIndex: number;
  /** Чем подтверждается шаг (`BOT_CAST_COMMITS`); умолчание — `confirm`. */
  readonly commit: BotCastCommit;
  /**
   * Бит подтверждения шага в маске `buttons` (INP-4, ABIL-3). Есть только у
   * каста с `commit: "confirm"`: отпусканию бит подтверждения не нужен, и
   * названный там он описывал бы фронт, которого бот не шлёт.
   */
  readonly confirmButton?: number;
  /** Бит отмены; без него бот начатый каст не отменяет. */
  readonly cancelButton?: number;
  /** Цепочка шагов в порядке ABIL-5; пустая — способность без прицеливания. */
  readonly steps: readonly BotAbilityStepProfile[];
  /**
   * Сколько тиков держать бит триггера — длительность фазы удержания (ABIL-4).
   * Ноль — тап: бит живёт один тик нажатия и на следующем спадает.
   *
   * У каста с `commit: "release"` это же число — срок прицеливания шага: спад
   * бита И ЕСТЬ подтверждение, поэтому «сколько держать» и «сколько целиться»
   * там одно, и валидация требует, чтобы документ назвал их одинаково.
   */
  readonly holdTicks: number;
  /** Вероятность отменить начатый каст на тике решения, 0..1. */
  readonly cancelChance: number;
  /**
   * Сколько тиков бот ведёт начатый каст, прежде чем бросить его. Страховка от
   * повисшего каста: определение сцены могло прерваться так, что до мозга это
   * не доехало, и без предела он держал бы способность занятой навсегда.
   */
  readonly giveUpTicks: number;
}

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
  /**
   * Пауза между применениями, тики; отсчитывается от отпускания кнопки.
   *
   * Это СОБСТВЕННЫЙ счётчик бота, а не кулдаун способности: настоящий гейт
   * держит платформа (ABIL-7), и профиль о нём не знает — знать чужой документ
   * он и не вправе (CONT-4). Отсюда конвенция отгруженных профилей: число здесь
   * ставится ЧУТЬ ВЫШЕ кулдауна определения сцены (60→62, 120→125, 150→155,
   * 300→305). Ниже — и бот жмёт бит в незаряженную способность: нажатие сцена
   * отбрасывает, а слой способностей всё равно занят им тик, и в этот тик не
   * выбирается ничего другого. Выше — законно и означает просто «этот бот
   * применяет её реже», чем позволяет сцена.
   *
   * Проверить эту связь валидацией нельзя: сцена профилю недоступна. Ловится
   * она сверкой двух документов — и место для такой сверки там, где оба дерева
   * читаются законно, то есть в игровом приложении, а не в движке.
   */
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
  /**
   * Требование к рукам (`BOT_ABILITY_HANDS`) — то самое условие, которым сцена
   * разводит два своих определения на одном бите. Отсутствует — рукам всё
   * равно.
   */
  readonly hands?: BotAbilityHands;
  /**
   * Описание способности платформы (BOT-6). Отсутствует — способность старого
   * вида: бот жмёт бит и держит его `holdTicks`, ничего не подтверждая.
   */
  readonly cast?: BotAbilityCastProfile;
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

/** Индекс бита маски `buttons` — ширина u16 (TICK-2). */
const BUTTON = { min: 0, max: 15, int: true } as const;

/** Один шаг цепочки: своя валидация, свой путь в находках. */
function parseStep(input: unknown, path: string, findings: Findings): BotAbilityStepProfile {
  const root = record(input, path, findings);
  const aim = root.aim;
  const known = (BOT_STEP_AIMS as readonly unknown[]).includes(aim);
  if (!known) {
    findings.issues.push(
      `${path}.aim: ожидалось одно из ${BOT_STEP_AIMS.join('|')}, получено ${JSON.stringify(aim)}`,
    );
  }
  return {
    aim: known ? (aim as BotStepAim) : 'enemy',
    confirmDelayTicks: num(root, 'confirmDelayTicks', path, TICKS, findings),
    pointNoise: num(root, 'pointNoise', path, { min: 0, max: 100 }, findings),
  };
}

/**
 * Описание способности платформы (BOT-6). Число шагов ограничено константой
 * платформы (`ABILITY_STEPS`, ABIL-1): цепочка длиннее слоту не влезет, и
 * профиль, её объявивший, описывает не ту способность, что в сцене.
 */
function parseCast(input: unknown, path: string, findings: Findings): BotAbilityCastProfile {
  const root = record(input, path, findings);
  const commit = parseCommit(root, path, findings);
  const steps: BotAbilityStepProfile[] = [];
  if (!Array.isArray(root.steps)) {
    findings.issues.push(`${path}.steps: ожидался массив шагов прицеливания`);
  } else {
    if (root.steps.length > ABILITY_STEPS) {
      findings.issues.push(
        `${path}.steps: ${root.steps.length} шагов при пределе платформы ${ABILITY_STEPS} (ABIL-1)`,
      );
    }
    for (const [index, entry] of root.steps.entries()) {
      steps.push(parseStep(entry, `${path}.steps[${index}]`, findings));
    }
  }
  const cancelButton =
    root.cancelButton === undefined ? undefined : num(root, 'cancelButton', path, BUTTON, findings);
  const confirmButton =
    root.confirmButton === undefined
      ? undefined
      : num(root, 'confirmButton', path, BUTTON, findings);
  const holdTicks = num(root, 'holdTicks', path, TICKS, findings);
  checkCommitShape(commit, { confirmButton: root.confirmButton, holdTicks, steps }, path, findings);
  return {
    slotIndex: num(root, 'slotIndex', path, { min: 0, max: 63, int: true }, findings),
    commit,
    ...(confirmButton === undefined ? {} : { confirmButton }),
    ...(cancelButton === undefined ? {} : { cancelButton }),
    steps,
    holdTicks,
    cancelChance: num(root, 'cancelChance', path, { min: 0, max: 1 }, findings),
    giveUpTicks: num(root, 'giveUpTicks', path, { ...TICKS, min: 1 }, findings),
  };
}

/** Чем подтверждается шаг (BOT-6); молчание документа — фронтом бита. */
function parseCommit(
  root: Record<string, unknown>,
  path: string,
  findings: Findings,
): BotCastCommit {
  const value = root.commit;
  if (value === undefined) return 'confirm';
  if (!(BOT_CAST_COMMITS as readonly unknown[]).includes(value)) {
    findings.issues.push(
      `${path}.commit: ожидалось одно из ${BOT_CAST_COMMITS.join('|')}, получено ${JSON.stringify(value)}`,
    );
    return 'confirm';
  }
  return value as BotCastCommit;
}

/**
 * Форма описания под выбранный способ подтверждения (ABIL-4, ABIL-5). Проверка
 * тут не про диапазоны чисел, а про то, что документ описывает СУЩЕСТВУЮЩУЮ
 * механику: бит подтверждения у отпускания не нажимается никогда, а прекращение
 * удержания записывает ровно один шаг и ровно тем тиком, которым спадает бит.
 */
function checkCommitShape(
  commit: BotCastCommit,
  cast: {
    readonly confirmButton: unknown;
    readonly holdTicks: number;
    readonly steps: readonly BotAbilityStepProfile[];
  },
  path: string,
  findings: Findings,
): void {
  if (commit === 'confirm') {
    if (cast.confirmButton === undefined) {
      findings.issues.push(`${path}.confirmButton: каст с подтверждением обязан назвать бит (ABIL-5)`);
    }
    return;
  }
  if (cast.confirmButton !== undefined) {
    findings.issues.push(
      `${path}.confirmButton: у каста с отпусканием фронта подтверждения нет — шаг записывает прекращение удержания бита триггера (ABIL-4)`,
    );
  }
  if (cast.steps.length > 1) {
    findings.issues.push(
      `${path}.steps: ${cast.steps.length} шагов, а прекращение удержания записывает ровно один (ABIL-5)`,
    );
  }
  const first = cast.steps[0];
  if (first !== undefined && first.confirmDelayTicks !== cast.holdTicks) {
    findings.issues.push(
      `${path}: holdTicks ${cast.holdTicks} и steps[0].confirmDelayTicks ${first.confirmDelayTicks} — ` +
        `у каста с отпусканием это ОДНО число: спад бита и есть подтверждение шага`,
    );
  }
}

/** Требование к рукам (BOT-6); молчание документа — «рукам всё равно». */
function parseHands(
  root: Record<string, unknown>,
  path: string,
  findings: Findings,
): BotAbilityHands | undefined {
  const value = root.hands;
  if (value === undefined) return undefined;
  if (!(BOT_ABILITY_HANDS as readonly unknown[]).includes(value)) {
    findings.issues.push(
      `${path}.hands: ожидалось одно из ${BOT_ABILITY_HANDS.join('|')}, получено ${JSON.stringify(value)}`,
    );
    return undefined;
  }
  return value as BotAbilityHands;
}

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
  const hands = parseHands(root, path, findings);
  const cast = root.cast === undefined ? undefined : parseCast(root.cast, `${path}.cast`, findings);

  return {
    name,
    // Ширина маски `buttons` — u16 (TICK-2): биты выше 15 не переживают круг
    // через транспорт, и профиль не вправе их назначать.
    button: num(root, 'button', path, BUTTON, findings),
    target: resolved,
    range: num(root, 'range', path, { min: 0, max: 1000 }, findings),
    holdTicks: num(root, 'holdTicks', path, { ...TICKS, min: 1 }, findings),
    cooldownTicks: num(root, 'cooldownTicks', path, TICKS, findings),
    weight: num(root, 'weight', path, { min: 0, max: 10 }, findings),
    ...(rise === undefined ? {} : { rise }),
    ...(requiresMoving === undefined ? {} : { requiresMoving }),
    ...(hands === undefined ? {} : { hands }),
    ...(cast === undefined ? {} : { cast }),
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
  //
  // Исключение ровно одно, и оно тоже данные. Сцена вправе развести два своих
  // определения на одном бите условием на владельце, и профиль повторяет это
  // условие требованием к рукам: взаимоисключающие требования — не коллизия,
  // потому что в каждый момент бит значит ровно одно. Сверяется КАЖДАЯ пара, а
  // не запись с первой на этом бите: три записи, из которых две требуют одного
  // и того же, коллизия так же, как две.
  const seen = new Map<number, BotAbilityProfile[]>();
  for (const ability of abilities) {
    const same = seen.get(ability.button);
    if (same === undefined) {
      seen.set(ability.button, [ability]);
      continue;
    }
    for (const other of same) {
      if (exclusiveHands(other, ability)) continue;
      findings.issues.push(
        `${path}: бит ${ability.button} назначен дважды — "${other.name}" и "${ability.name}"`,
      );
    }
    same.push(ability);
  }
  return abilities;
}

/** Разводит ли документ две записи одного бита требованием к рукам (BOT-6). */
function exclusiveHands(left: BotAbilityProfile, right: BotAbilityProfile): boolean {
  return left.hands !== undefined && right.hands !== undefined && left.hands !== right.hands;
}

/**
 * Перекрёстные проверки каста и задержки реакции — двух блоков ОДНОГО документа
 * (BOT-6). Свой каст мозг закрывает по своему слоту из своего снапшота
 * (`abilities.ts`), а снапшот отстаёт ровно на задержку реакции с джиттером,
 * которую назвал этот же документ.
 *
 * Отсюда два правила. Первое: раньше, чем `Σ confirmDelayTicks` плюс это
 * отставание, увидеть каст законченным бот физически не может, и профиль с
 * более коротким пределом ведения описывает каст, который ВСЕГДА бросается по
 * пределу и ни разу не доводится. Второе: фронт подтверждения не вправе уезжать
 * раньше, чем доезжает картинка.
 *
 * Числа обе стороны берут из документа, поэтому находки называют оба и профиль,
 * в котором они разошлись.
 */
function checkCastTimings(profile: BotProfile, source: string, findings: Findings): void {
  const lag = profile.reaction.delayTicks + profile.reaction.jitterTicks;
  for (const [index, ability] of profile.abilities.entries()) {
    const cast = ability.cast;
    if (cast === undefined) continue;
    const path = `${source}.abilities[${index}].cast`;
    const confirmAt = cast.steps.reduce((sum, step) => sum + step.confirmDelayTicks, 0);
    const needed = confirmAt + lag;
    if (cast.giveUpTicks < needed) {
      findings.issues.push(
        `${path}: giveUpTicks ${cast.giveUpTicks} меньше ${needed} — ` +
          `${confirmAt} тик(ов) подтверждений плюс отставание картинки ${lag} ` +
          `(reaction.delayTicks + reaction.jitterTicks); каст "${ability.name}" бросался бы по пределу всегда`,
      );
    }
    // Второе правило — про ФРОНТ подтверждения, и только про него. Фронт бот
    // шлёт по СВОИМ часам, ничего в мире не дождавшись, и профиль, у которого
    // он уезжает раньше, чем доезжает картинка, описывает бота, судящего о
    // собственном касте по миру, в котором тот ещё не начался. У каста с
    // отпусканием фронта нет вовсе: момент записи шага там привязан к
    // длительности удержания, то есть к кнопке, которую бот уже держит, — и
    // требовать от рефлекторного перехвата ждать дольше собственной реакции
    // значило бы запретить его вовсе, а не починить.
    if (cast.commit !== 'confirm' || cast.steps.length === 0 || confirmAt >= lag) continue;
    findings.issues.push(
      `${path}: последнее подтверждение уезжает на тике ${confirmAt}, а картинка мира отстаёт на ${lag} ` +
        `(reaction.delayTicks + reaction.jitterTicks) — бот судил бы о касте "${ability.name}" по миру, ` +
        `в котором тот ещё не начался`,
    );
  }
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

  checkCastTimings(profile, source, findings);

  if (findings.issues.length > 0) {
    throw new Error(`parseBotProfile (BOT-6): ${findings.issues.join('; ')}`);
  }
  return profile;
}
