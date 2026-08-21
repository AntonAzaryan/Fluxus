/**
 * Бот-аннотация способности (BOT-12): «как этой способностью пользуется бот» —
 * ДАННЫЕ контента, парный сцене документ `<база>.bots.json`, а не знание в
 * голове дизайнера.
 *
 * Парность — по имени файла, как у документа презентации (`presentation-scene`
 * PRES-1): ссылок между сценой и аннотацией нет ни в одну сторону. Отсюда три
 * следствия, ради которых форма и выбрана такой: схема сцены не растёт (SER-7),
 * хеш контент-пака документа не видит — в каноническое представление входит
 * конфиг сцены, а не соседние файлы (`netcode` NET-17), — и Blender-импорт его
 * не переписывает (BLND-2): тот переписывает только пространственный слой.
 *
 * Форма и её проверка живут ЗДЕСЬ, в сборке игры, а не в `engine/bot-ts`, и это
 * не вопрос удобства: документ описывает связь профиля со СЦЕНОЙ, а сцену
 * пакету движка читать запрещено (`game-content` CONT-4). Игре оба дерева
 * доступны законно — она и есть игра (CONT-1).
 *
 * Аннотация называет ровно ту семантику, которой в определении способности нет
 * (`ability-system` ABIL-2): на что способность нацелена для мозга, что она
 * требует от рук и движения, чем целится каждый шаг цепочки (ABIL-5). Всё
 * остальное — бит триггера, биты подтверждения и отмены, фазы, кулдаун — уже
 * сказано определением, и повторять его здесь значило бы завести второй,
 * расходящийся с первым источник правды (вывод механики — `botContract.ts`).
 *
 * Числа сложности исполнения (шум прицела, задержки подтверждений, вероятность
 * отмены, собственный темп применения) документом НЕ описываются: они остаются
 * профилем (BOT-6). Исключение ровно одно и названо: `range` — стартовая
 * дальность применения для скелета новой записи, число, которое дизайнер потом
 * тюнит в каждом профиле отдельно, и потому сверкой оно не проверяется.
 *
 * Адресат находок — геймдизайнер, поэтому разбор собирает их все и называет
 * путь поля документа (та же конвенция, что у профиля, `bot-ts/src/findings.ts`).
 */
import {
  BOT_ABILITY_HANDS,
  BOT_ABILITY_TARGETS,
  BOT_STEP_AIMS,
  type BotAbilityHands,
  type BotAbilityTarget,
  type BotStepAim,
} from '@game-mvp/bot';

/**
 * Версия формы документа (BOT-12: «SHALL версионироваться обязательным полем
 * `schema`»). Растёт при несовместимом изменении состава полей — документ
 * прошлой формы обязан отличаться от нового явно, а не полем, которого нет.
 */
export const BOT_HINTS_SCHEMA = 1;

/** Окончание имени парного документа бот-аннотаций рядом с конфигом сцены. */
export const BOT_HINTS_SUFFIX = '.bots.json';

/** Чем целится один шаг цепочки прицеливания (ABIL-5) в терминах мозга. */
export interface BotStepHint {
  readonly aim: BotStepAim;
}

/** Аннотация ОДНОГО определения способности сцены (BOT-12). */
export interface BotAbilityHint {
  /** `id` определения сцены (ABIL-2) — ключ записи документа. */
  readonly ability: string;
  /**
   * Имя записи в профиле (`BotAbilityProfile.name`). Молчание документа — имя
   * совпадает с `id` определения; названо оно отдельным полем потому, что
   * совпадать они не обязаны: определение дуэли `fireball` в профиле зовётся
   * `cast` — именем действия раскладки (INP-4), а не именем определения.
   */
  readonly name: string;
  /** На что способность нацелена для мозга (BOT-6). */
  readonly target: BotAbilityTarget;
  /** Требование к рукам; `undefined` — рукам всё равно (BOT-6). */
  readonly hands: BotAbilityHands | undefined;
  /** Требует ли манёвр ненулевого вектора движения (LOC-4, LOC-5). */
  readonly requiresMoving: boolean;
  /** Перепад уступа, который бот берёт манёвром; осмыслен только у цели `cliff`. */
  readonly rise: number | undefined;
  /**
   * Дальность применения, мировые единицы. УМОЛЧАНИЕ СКЕЛЕТА, а не сверяемая
   * механика: в отгруженных профилях она разная у каждого уровня сложности
   * (`cast` — 12 у normal и 8 у easy), то есть это число сложности (BOT-6).
   */
  readonly range: number;
  /** Цепочка шагов в порядке ABIL-5; пустая — способность без прицеливания. */
  readonly steps: readonly BotStepHint[];
  /**
   * Кулдаун определения сцены в тиках. Обязателен ТОЛЬКО когда кулдаун
   * определения — выражение, а не литерал (ABIL-2): вычислить выражение здесь
   * нечем — оно читает поля слота и владельца, которых до матча нет, — и число
   * для кулдаун-инварианта сверки называет документ (BOT-13).
   */
  readonly cooldownTicks: number | undefined;
}

export interface BotHintsDocument {
  readonly schema: number;
  /** Имя документа — база парной сцены (`duel`), для находок и диагностики. */
  readonly name: string;
  /**
   * Профили, к которым аннотация относится, путями ОТ КОРНЯ дерева контента —
   * так адресуется ассет (`assets` ASSET-2) и так же профиль называет свой
   * документ поведения (BOT-8).
   *
   * ДАННЫЕ, а не догадка кода: связку «этот профиль играет эту сцену» не несёт
   * ни один из двух документов — профиль сцены не называет, сцена профилей не
   * знает, — и без такого списка сверке и генерации пришлось бы брать «все
   * профили дерева», то есть молча захватить бота второй сцены.
   */
  readonly profiles: readonly string[];
  /** Аннотации в порядке документа; ключ записи — `id` определения сцены. */
  readonly abilities: readonly BotAbilityHint[];
}

interface Range {
  readonly min: number;
  readonly max: number;
  readonly int?: boolean;
}

function objectAt(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  issues.push(`${path}: ожидался объект`);
  return {};
}

/** Значение из закрытого словаря; неизвестное — находка с самим значением. */
function wordAt<T extends string>(
  value: unknown,
  path: string,
  known: readonly T[],
  issues: string[],
): T | undefined {
  if ((known as readonly unknown[]).includes(value)) return value as T;
  issues.push(`${path}: ожидалось одно из ${known.join('|')}, получено ${JSON.stringify(value)}`);
  return undefined;
}

function numberAt(value: unknown, path: string, range: Range, issues: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path}: ожидалось конечное число`);
    return undefined;
  }
  if (range.int === true && !Number.isInteger(value)) {
    issues.push(`${path}: ожидалось целое, получено ${value}`);
    return undefined;
  }
  if (value < range.min || value > range.max) {
    issues.push(`${path}: ${value} вне [${range.min}, ${range.max}]`);
    return undefined;
  }
  return value;
}

function flagAt(value: unknown, path: string, issues: string[]): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  issues.push(`${path}: ожидалось true или false`);
  return false;
}

function textAt(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  issues.push(`${path}: ожидалась непустая строка`);
  return undefined;
}

/** Цепочка шагов: молчание документа — прицеливания нет (ABIL-5). */
function parseSteps(value: unknown, path: string, issues: string[]): readonly BotStepHint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path}: ожидался массив шагов прицеливания`);
    return [];
  }
  return value.map((entry, index) => {
    const step = objectAt(entry, `${path}[${index}]`, issues);
    return { aim: wordAt(step.aim, `${path}[${index}].aim`, BOT_STEP_AIMS, issues) ?? 'enemy' };
  });
}

/** Одна аннотация: своя проверка, свой путь в находках. */
function parseHint(id: string, value: unknown, path: string, issues: string[]): BotAbilityHint {
  const root = objectAt(value, path, issues);
  const target = wordAt(root.target, `${path}.target`, BOT_ABILITY_TARGETS, issues) ?? 'enemy';
  const hands =
    root.hands === undefined ? undefined : wordAt(root.hands, `${path}.hands`, BOT_ABILITY_HANDS, issues);

  // Перепад уступа спрашивается ровно у той цели, для которой он что-то значит
  // (то же правило, что в профиле): `rise` у каста — не безобидное лишнее поле,
  // а признак того, что документ писали, не понимая, что настраивают.
  const rise =
    root.rise === undefined
      ? undefined
      : numberAt(root.rise, `${path}.rise`, { min: 0, max: 15, int: true }, issues);
  if (target !== 'cliff' && root.rise !== undefined) {
    issues.push(`${path}.rise: перепад уступа осмыслен только у цели "cliff"`);
  }
  // И наоборот: у цели `cliff` он обязателен — профиль его требует (BOT-6), и
  // промолчавшая аннотация спорила бы с каждым профилем, который его назвал.
  if (target === 'cliff' && root.rise === undefined) {
    issues.push(`${path}.rise: цель "cliff" обязана назвать перепад уступа, который бот берёт манёвром (LOC-5)`);
  }

  return {
    ability: id,
    name: root.name === undefined ? id : (textAt(root.name, `${path}.name`, issues) ?? id),
    target,
    hands,
    requiresMoving: flagAt(root.requiresMoving, `${path}.requiresMoving`, issues),
    rise: target === 'cliff' ? rise : undefined,
    range: numberAt(root.range, `${path}.range`, { min: 0, max: 1000 }, issues) ?? 0,
    steps: parseSteps(root.steps, `${path}.steps`, issues),
    cooldownTicks:
      root.cooldownTicks === undefined
        ? undefined
        : numberAt(root.cooldownTicks, `${path}.cooldownTicks`, { min: 0, max: 100_000, int: true }, issues),
  };
}

function parseAbilities(value: unknown, source: string, issues: string[]): readonly BotAbilityHint[] {
  const path = `${source}.abilities`;
  const root = objectAt(value, path, issues);
  const hints = Object.keys(root).map((id) => parseHint(id, root[id], `${path}.${id}`, issues));

  // Две аннотации на одно имя записи профиля — не опечатка в одном документе, а
  // неразрешимая двусмысленность: сверять и генерировать эту запись пришлось бы
  // сразу по двум определениям сцены.
  const seen = new Map<string, string>();
  for (const hint of hints) {
    const first = seen.get(hint.name);
    if (first !== undefined) {
      issues.push(
        `${path}: запись профиля "${hint.name}" названа дважды — определениями "${first}" и "${hint.ability}"`,
      );
      continue;
    }
    seen.set(hint.name, hint.ability);
  }
  return hints;
}

/**
 * Пути профилей — от корня дерева контента (ASSET-2). Проверяется здесь ровно
 * форма пути: существует ли файл, документу неизвестно и известно быть не может
 * — дерево читает та сторона, которая его открывает.
 */
function parseProfiles(value: unknown, source: string, issues: string[]): readonly string[] {
  const path = `${source}.profiles`;
  if (!Array.isArray(value)) {
    issues.push(`${path}: ожидался массив путей профилей от корня дерева контента (BOT-13)`);
    return [];
  }
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${path}[${index}]`;
    const text = textAt(entry, at, issues);
    if (text === undefined) continue;
    if (text.startsWith('/') || text.includes('..')) {
      issues.push(`${at}: "${text}" — путь адресуется от корня дерева контента (ASSET-2), без "/" в начале и без ".."`);
      continue;
    }
    paths.push(text);
  }
  return paths;
}

/**
 * Разбор и проверка документа бот-аннотаций (BOT-12). Бросает с полным списком
 * находок, а не с первой: документ правит геймдизайнер, и «почини одно, узнай
 * про следующее» — худший из возможных циклов правки.
 */
export function parseBotHints(input: unknown, source = 'бот-аннотация сцены'): BotHintsDocument {
  const issues: string[] = [];
  const root = objectAt(input, source, issues);

  const schema =
    numberAt(root.schema, `${source}.schema`, { min: 1, max: 1_000_000, int: true }, issues) ?? 0;
  // Расхождение версии называется ВСЕГДА, а не только когда прочих находок нет:
  // документ будущей формы шумит несовпадением полей, и именно версия объясняет
  // этот шум — промолчать о ней значит спрятать причину за следствием.
  if (schema !== BOT_HINTS_SCHEMA) {
    issues.push(`${source}.schema: ${schema} — реализация читает форму ${BOT_HINTS_SCHEMA}`);
  }

  const document: BotHintsDocument = {
    schema,
    name: textAt(root.name, `${source}.name`, issues) ?? '',
    profiles: parseProfiles(root.profiles, source, issues),
    abilities: parseAbilities(root.abilities, source, issues),
  };

  if (issues.length > 0) throw new Error(`parseBotHints (BOT-12): ${issues.join('; ')}`);
  return document;
}
