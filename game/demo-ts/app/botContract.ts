/**
 * Связь бот-профиля со сценой (BOT-13): «определение способности сцены плюс её
 * бот-аннотация → ожидаемая запись профиля».
 *
 * Модуль ОДИН на сверку и генерацию, и это несущее требование, а не экономия:
 * второй реализации правил вывода появиться не должно (BOT-13). Сверка
 * (`test/botContract.test.ts`) сравнивает выведенное с отгруженным профилем,
 * генерация (`bin/bots-sync.mjs`) выведенное записывает — обе стороны читают
 * одни и те же правила отсюда.
 *
 * Живёт он в сборке ИГРЫ, потому что читает оба дерева сразу — конфиг сцены и
 * профиль бота, — а движку дерево контента запрещено (`game-content` CONT-4).
 * Игре оно разрешено: она и есть игра (CONT-1). Отсюда же граница модуля: сам
 * он ничего не открывает и не пишет — документы приезжают разобранными, находки
 * уезжают строками. Файлы читают тест и CLI.
 *
 * Что откуда берётся:
 *
 * - из ОПРЕДЕЛЕНИЯ сцены (ABIL-2..5) — механика: бит триггера, биты
 *   подтверждения и отмены, вид подтверждения шага, число шагов цепочки, предел
 *   удержания и кулдаун;
 * - из АННОТАЦИИ (BOT-12) — семантика, которой в определении нет: цель, руки,
 *   требование движения, перепад уступа и прицел каждого шага;
 * - из ПРОФИЛЯ (BOT-6) — числа сложности исполнения: шум точки, задержки
 *   подтверждений, вероятность отмены, собственный темп применения, вес и
 *   дальность. Их вывод не трогает ни сверкой, ни генерацией.
 *
 * Кулдаун — единственное число, живущее в обоих документах, и правило для него
 * ОДНО (BOT-13): `cooldownTicks` профиля не меньше кулдауна определения.
 * Конвенция отгруженных профилей «чуть выше» (60→62, 120→125) была знанием в
 * комментарии; здесь она стала проверяемым инвариантом.
 */
import type { AbilityDef, AbilityPhaseDef, PrefabDef } from '@fluxus/core';
import type {
  BotAbilityHands,
  BotAbilityProfile,
  BotAbilityTarget,
  BotCastCommit,
  BotProfile,
  BotStepAim,
} from '@fluxus/bot';
import type { BotAbilityHint, BotHintsDocument } from './botHints.js';

/** Часть конфига сцены, которую читает вывод: определения и prefab'ы слотов. */
export interface ContractScene {
  readonly abilities?: readonly AbilityDef[];
  readonly prefabs?: readonly PrefabDef[];
}

/** Описание каста, выведенное из фаз и цепочки прицеливания определения. */
export interface ExpectedCast {
  readonly slotIndex: number;
  readonly commit: BotCastCommit;
  /** Бит подтверждения; `undefined` — у каста с отпусканием фронта подтверждения нет (ABIL-4). */
  readonly confirmButton: number | undefined;
  readonly cancelButton: number | undefined;
  /** Прицелы шагов в порядке ABIL-5 — число шагов от сцены, прицел от аннотации. */
  readonly steps: readonly BotStepAim[];
}

/** Ожидаемая запись профиля БЕЗ чисел сложности (BOT-13). */
export interface ExpectedAbility {
  /** `id` определения сцены (ABIL-2). */
  readonly ability: string;
  /** Имя записи профиля (`BotAbilityProfile.name`). */
  readonly name: string;
  readonly button: number;
  readonly target: BotAbilityTarget;
  readonly hands: BotAbilityHands | undefined;
  readonly requiresMoving: boolean;
  readonly rise: number | undefined;
  /** Дальность — умолчание скелета, а не сверяемая механика (см. `botHints.ts`). */
  readonly range: number;
  /** Нижняя граница `cooldownTicks` профиля: кулдаун определения сцены (ABIL-7). */
  readonly cooldownFloor: number;
  /**
   * Предел удержания бита триггера, тики: `undefined` — фазы удержания нет, и
   * способность применяется тапом. `Infinity` — фаза есть, а предела у неё нет.
   */
  readonly holdMaxTicks: number | undefined;
  readonly cast: ExpectedCast | undefined;
}

export interface ExpectedAbilities {
  readonly abilities: readonly ExpectedAbility[];
  /** Находки о самой паре «сцена + аннотация»: аннотация описывает не то, что в сцене. */
  readonly findings: readonly string[];
}

/**
 * Фаза, в которой бит триггера ДЕРЖИТСЯ (ABIL-4): `hold` и `release`
 * завершаются прекращением удержания. Её длительность и есть предел, дольше
 * которого держать бит нельзя.
 */
function holdPhase(phases: readonly AbilityPhaseDef[]): AbilityPhaseDef | undefined {
  return phases.find((phase) => phase.trigger === 'hold' || phase.trigger === 'release');
}

/**
 * Фаза, накапливающая шаги прицеливания (ABIL-5): только `commit` и `release`.
 * Её вид и есть «чем подтверждается шаг» в терминах профиля.
 */
function commitPhase(phases: readonly AbilityPhaseDef[]): AbilityPhaseDef | undefined {
  return phases.find((phase) => phase.trigger === 'commit' || phase.trigger === 'release');
}

/**
 * Предел удержания, тики — сама длительность фазы, БЕЗ запаса в тик.
 * Длительность-выражение пределом не считается: вычислить её здесь нечем, и
 * «предела нет» честнее выдуманного числа.
 *
 * Ровно `durationTicks` — законное удержание, и это не рассуждение, а порядок
 * проверок тика: прекращение удержания завершает фазу ДО ветки истечения
 * (`CastPhaseSystem.advance`), а шаг прицеливания того же тика записан ещё
 * раньше — системой накопления на −800 (ABIL-4, ABIL-5, DET-9). Границу пинает
 * тест демо «передержка на 300 мс сверх максимума рвёт заряд в самом кастере»
 * (`demoAbilities.test.ts`): счётчик фазы на тике нажатия равен нулю, таймаут
 * срабатывает на тике, где счётчик ДОСТИГ `durationTicks`, — то есть держать
 * столько же тиков, сколько длится фаза, ещё можно, а на тик дольше уже нет.
 */
function holdLimit(phase: AbilityPhaseDef): number {
  if (typeof phase.durationTicks !== 'number') return Number.POSITIVE_INFINITY;
  return phase.durationTicks;
}

/** Номер слота владельца (ABIL-1) — из prefab'а слота, а не из константы сборки. */
function slotIndexOf(prefabs: readonly PrefabDef[], abilityId: number): number | undefined {
  for (const prefab of prefabs) {
    const slot = prefab.components.AbilitySlot;
    if (slot?.abilityId === abilityId) return slot.slotIndex;
  }
  return undefined;
}

/** Кулдаун определения (ABIL-2): литерал — число, выражение — из аннотации (BOT-13). */
function cooldownFloor(def: AbilityDef, hint: BotAbilityHint, path: string, findings: string[]): number {
  if (def.cooldownTicks === undefined) return hint.cooldownTicks ?? 0;
  if (typeof def.cooldownTicks === 'number') {
    if (hint.cooldownTicks !== undefined && hint.cooldownTicks !== def.cooldownTicks) {
      findings.push(
        `${path}: аннотация называет кулдаун ${hint.cooldownTicks}, а определение — литерал ${def.cooldownTicks}`,
      );
    }
    return def.cooldownTicks;
  }
  if (hint.cooldownTicks === undefined) {
    findings.push(
      `${path}: кулдаун определения — выражение, и число для сверки обязана назвать аннотация (cooldownTicks, BOT-13)`,
    );
    return 0;
  }
  return hint.cooldownTicks;
}

/** Ожидаемый каст: фазы и цепочка шагов определения в терминах профиля (BOT-6). */
function expectedCast(
  def: AbilityDef,
  hint: BotAbilityHint,
  abilityId: number,
  prefabs: readonly PrefabDef[],
  path: string,
  findings: string[],
): ExpectedCast | undefined {
  const accumulating = commitPhase(def.phases ?? []);
  // Каст описывается ровно там, где есть ЧТО подтверждать, — у определения с
  // фазой, накапливающей шаги (ABIL-5). Мгновенная способность (ABIL-2) и
  // способность «нажать и держать» одинаково выражаются записью без каста:
  // ни слота, ни фронтов подтверждения боту для них не нужно (BOT-6).
  if (accumulating === undefined) return undefined;

  const commit: BotCastCommit = accumulating.trigger === 'release' ? 'release' : 'confirm';
  const slotIndex = slotIndexOf(prefabs, abilityId);
  if (slotIndex === undefined) {
    findings.push(`${path}: в сцене нет prefab'а слота с abilityId ${abilityId} — номер слота брать неоткуда (ABIL-1)`);
  }
  if (commit === 'confirm' && def.confirmBit === undefined) {
    findings.push(`${path}: каст подтверждается фронтом, а определение бита подтверждения не назначило (ABIL-3, ABIL-5)`);
  }

  const steps = def.targeting?.steps ?? [];
  if (steps.length !== hint.steps.length) {
    findings.push(
      `${path}: аннотация описывает ${hint.steps.length} шаг(ов) прицеливания, а определение — ${steps.length} (ABIL-5)`,
    );
  }
  return {
    slotIndex: slotIndex ?? 0,
    commit,
    // У каста с отпусканием фронта подтверждения нет вовсе: шаг записывает
    // прекращение удержания (ABIL-4), и названный битом профиль описывал бы
    // нажатие, которого бот не шлёт.
    confirmButton: commit === 'confirm' ? def.confirmBit : undefined,
    cancelButton: def.cancelBit,
    steps: steps.map((_step, index) => hint.steps[index]?.aim ?? 'enemy'),
  };
}

/**
 * Ожидаемые записи профиля по сцене и её аннотации (BOT-13). Способность, не
 * названная аннотацией, в результат не попадает: «боту её не описывали» —
 * законное состояние, а не находка (BOT-12).
 */
export function expectedAbilities(scene: ContractScene, hints: BotHintsDocument): ExpectedAbilities {
  const defs = scene.abilities ?? [];
  const prefabs = scene.prefabs ?? [];
  const findings: string[] = [];
  const abilities: ExpectedAbility[] = [];

  for (const hint of hints.abilities) {
    const path = `аннотация "${hints.name}", способность "${hint.ability}"`;
    const abilityId = defs.findIndex((def) => def.id === hint.ability);
    const def = defs[abilityId];
    if (def === undefined) {
      findings.push(`${path}: в сцене нет определения с таким id (ABIL-2)`);
      continue;
    }
    const button = def.trigger.input?.bit;
    if (button === undefined) {
      findings.push(`${path}: триггер определения — не ввод, и бита у него нет (ABIL-3)`);
      continue;
    }
    const phase = holdPhase(def.phases ?? []);
    abilities.push({
      ability: hint.ability,
      name: hint.name,
      button,
      target: hint.target,
      hands: hint.hands,
      requiresMoving: hint.requiresMoving,
      rise: hint.rise,
      range: hint.range,
      cooldownFloor: cooldownFloor(def, hint, path, findings),
      holdMaxTicks: phase === undefined ? undefined : holdLimit(phase),
      cast: expectedCast(def, hint, abilityId, prefabs, path, findings),
    });
  }
  return { abilities, findings };
}

// ------------------------------------------------------------------- сверка

/** Сколько тиков бот держит бит: у способности платформы это её собственный каст. */
function heldTicks(ability: BotAbilityProfile): number {
  return ability.cast === undefined ? ability.holdTicks : ability.cast.holdTicks;
}

/** Значение поля в тексте находки: отсутствующее называется словами, а не `undefined`. */
function shown(value: unknown): string {
  return value === undefined ? 'нет поля' : JSON.stringify(value);
}

function compare(actual: unknown, expected: unknown, field: string, note: string, findings: string[]): void {
  if (actual === expected) return;
  findings.push(`${field}: ${shown(actual)}, а ${note} — ${shown(expected)}`);
}

/** Механика каста: слот, вид подтверждения, биты и цепочка шагов (BOT-13). */
function verifyCast(expected: ExpectedCast, ability: BotAbilityProfile, findings: string[]): void {
  const cast = ability.cast;
  if (cast === undefined) {
    findings.push(
      `cast: описания нет, а определение сцены требует подтверждения шага — такую способность бот не применяет (BOT-6)`,
    );
    return;
  }
  compare(cast.slotIndex, expected.slotIndex, 'cast.slotIndex', 'prefab слота сцены называет', findings);
  compare(cast.commit, expected.commit, 'cast.commit', 'вид фазы определения даёт', findings);
  compare(cast.confirmButton, expected.confirmButton, 'cast.confirmButton', 'касту этого вида полагается', findings);
  compare(cast.cancelButton, expected.cancelButton, 'cast.cancelButton', 'определение назначило', findings);
  if (cast.steps.length !== expected.steps.length) {
    findings.push(
      `cast.steps: ${cast.steps.length} шаг(ов), а цепочка прицеливания определения — ${expected.steps.length} (ABIL-5)`,
    );
  }
  for (const [index, aim] of expected.steps.entries()) {
    const step = cast.steps[index];
    if (step === undefined) continue;
    compare(step.aim, aim, `cast.steps[${index}].aim`, 'аннотация называет', findings);
  }
}

/** Одна запись профиля против выведенного ожидания (BOT-13). */
function verifyAbility(expected: ExpectedAbility, ability: BotAbilityProfile): readonly string[] {
  const findings: string[] = [];
  compare(ability.button, expected.button, 'button', 'определение сцены назначило биту триггера', findings);
  compare(ability.target, expected.target, 'target', 'аннотация называет', findings);
  compare(ability.hands, expected.hands, 'hands', 'аннотация называет', findings);
  compare(ability.requiresMoving ?? false, expected.requiresMoving, 'requiresMoving', 'аннотация называет', findings);
  compare(ability.rise, expected.rise, 'rise', 'аннотация называет', findings);

  // Длительность удержания. Само число — сложность (дизайнер решает, как долго
  // бот копит заряд), но окно, в которое оно обязано попасть, — механика фазы:
  // передержавшего срывает таймаут (ABIL-4), а способности без фазы удержания
  // держать нечего, и всё сверх тапа сгорает в занятый слой способностей.
  const held = heldTicks(ability);
  if (expected.holdMaxTicks === undefined) {
    if (held !== 1) {
      findings.push(
        `holdTicks: ${held}, а у определения без фазы удержания держать нечего — применение это тап (ABIL-2)`,
      );
    }
  } else if (held < 1 || held > expected.holdMaxTicks) {
    findings.push(
      `holdTicks: ${held} вне окна фазы удержания определения [1, ${expected.holdMaxTicks}] (ABIL-4)`,
    );
  }

  if (ability.cooldownTicks < expected.cooldownFloor) {
    findings.push(
      `cooldownTicks: ${ability.cooldownTicks} меньше кулдауна определения ${expected.cooldownFloor} — ` +
        `бот жал бы бит в незаряженную способность, теряя тик решения (BOT-13)`,
    );
  }

  if (expected.cast === undefined) {
    if (ability.cast !== undefined) {
      findings.push(
        `cast: описание каста есть, а определению сцены подтверждать нечего — фазы, накапливающей шаги, у него нет (ABIL-5)`,
      );
    }
  } else {
    verifyCast(expected.cast, ability, findings);
  }
  return findings;
}

/**
 * Сверка записей профиля с выведенным ожиданием (BOT-13). Находки
 * ПЕРЕЧИСЛЯЮТСЯ разом, а не бросаются по первой: адресат — дизайнер, и «почини
 * одно, узнай про следующее» здесь тот же худший цикл правки, что в валидации.
 *
 * Способность, названная аннотацией, но отсутствующая в профиле, находкой НЕ
 * является: состав способностей бота — выбор дизайнера (BOT-6), и лёгкий
 * профиль вправе не играть захватом.
 */
export function verifyProfileAbilities(
  expected: readonly ExpectedAbility[],
  profile: BotProfile,
): readonly string[] {
  const findings: string[] = [];
  for (const entry of expected) {
    const ability = profile.abilities.find((candidate) => candidate.name === entry.name);
    if (ability === undefined) continue;
    for (const finding of verifyAbility(entry, ability)) {
      findings.push(`способность "${entry.name}" (определение сцены "${entry.ability}"): ${finding}`);
    }
  }
  findings.push(...unclaimed(expected, profile));
  return findings;
}

/**
 * Записи профиля, которых аннотация не назвала, — с одной оговоркой, и она
 * несущая. Связка «запись профиля ↔ определение сцены» держится ИМЕНЕМ, и
 * опечатка в имени выключала бы сверку этой записи молча — тот самый «рассинхрон
 * молча», ради которого BOT-13 и существует, только уехавший на уровень выше.
 *
 * Признак опечатки — БИТ: неописанная запись, жмущая бит, который сцена назначила
 * описанному определению, почти наверняка и есть оно, названное иначе. Запись на
 * бите, которого нет ни у одного описанного определения, — законное «боту её не
 * описывали» (BOT-12): так живёт прыжок демо, манёвр локомоушена (LOC-5), у
 * которого определения способности нет вовсе.
 */
function unclaimed(expected: readonly ExpectedAbility[], profile: BotProfile): readonly string[] {
  const described = new Set(expected.map((entry) => entry.name));
  const findings: string[] = [];
  for (const ability of profile.abilities) {
    if (described.has(ability.name)) continue;
    const clash = expected.find((entry) => entry.button === ability.button);
    if (clash === undefined) continue;
    findings.push(
      `запись профиля "${ability.name}": аннотация её не описывает, а её бит ${ability.button} назначен ` +
        `определению "${clash.ability}" (аннотация зовёт эту запись "${clash.name}") — опечатка в имени ` +
        `выключила бы сверку записи молча (BOT-13)`,
    );
  }
  return findings;
}

// --------------------------------------------------------------- генерация

/**
 * Нейтральные умолчания скелета — ЧИСЛА СЛОЖНОСТИ (BOT-6), поставленные только
 * затем, чтобы новая запись была валидной и играбельной. Дизайнер их тюнит;
 * повторная генерация к ним не возвращается.
 */
const SKELETON = {
  weight: 1,
  /** Конвенция «чуть выше кулдауна сцены»: 60→62, 120→125 (профиль, BOT-6). */
  cooldownMarginTicks: 2,
  /** Задержка подтверждения шага: бот целится, а не подтверждает мгновенно. */
  stepDelayTicks: 6,
  /** Шум точки прицела, мировые единицы: ноль был бы сверхчеловеческим прицелом. */
  pointNoise: 0.5,
  /** Запас к сроку ведения каста сверх подтверждений и отставания картинки. */
  giveUpMarginTicks: 30,
} as const;

/** Сколько держать бит по умолчанию: половина окна фазы, тап — если фазы нет. */
function defaultHold(expected: ExpectedAbility): number {
  const limit = expected.holdMaxTicks;
  if (limit === undefined || !Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit / 2));
}

/** Отставание картинки мира — им ограничены тайминги каста (BOT-6, `checkCastTimings`). */
function lagOf(profile: BotProfile): number {
  return profile.reaction.delayTicks + profile.reaction.jitterTicks;
}

function skeletonCast(expected: ExpectedCast, hold: number, lag: number): Record<string, unknown> {
  // Фронт подтверждения бот шлёт по своим часам, и уехать раньше, чем доезжает
  // картинка, он не вправе (BOT-6): у каста с подтверждением задержка шага не
  // меньше отставания. У каста с отпусканием подтверждение — спад бита, и его
  // срок равен длительности удержания.
  const delay = expected.commit === 'release' ? hold : Math.max(SKELETON.stepDelayTicks, lag);
  const steps = expected.steps.map((aim) => ({
    aim,
    confirmDelayTicks: delay,
    pointNoise: SKELETON.pointNoise,
  }));
  return {
    slotIndex: expected.slotIndex,
    commit: expected.commit,
    ...(expected.confirmButton === undefined ? {} : { confirmButton: expected.confirmButton }),
    ...(expected.cancelButton === undefined ? {} : { cancelButton: expected.cancelButton }),
    steps,
    holdTicks: hold,
    cancelChance: 0,
    giveUpTicks: delay * steps.length + lag + SKELETON.giveUpMarginTicks,
  };
}

/** Скелет новой записи: механика и семантика из документов, сложность — умолчаниями. */
function skeleton(expected: ExpectedAbility, lag: number): Record<string, unknown> {
  const hold = defaultHold(expected);
  return {
    name: expected.name,
    button: expected.button,
    target: expected.target,
    ...(expected.hands === undefined ? {} : { hands: expected.hands }),
    ...(expected.rise === undefined ? {} : { rise: expected.rise }),
    ...(expected.requiresMoving ? { requiresMoving: true } : {}),
    range: expected.range,
    holdTicks: hold,
    cooldownTicks:
      expected.cooldownFloor === 0 ? 0 : expected.cooldownFloor + SKELETON.cooldownMarginTicks,
    weight: SKELETON.weight,
    ...(expected.cast === undefined ? {} : { cast: skeletonCast(expected.cast, hold, lag) }),
  };
}

/**
 * Правка одного поля записи. `undefined` означает «поля быть не должно», и
 * стирается оно тоже правкой — иначе запись, у которой сцена отняла бит отмены,
 * несла бы его вечно.
 */
function put(
  entry: Record<string, unknown>,
  key: string,
  value: unknown,
  path: string,
  changes: string[],
): void {
  const before = entry[key];
  if (before === value) return;
  if (value === undefined) {
    if (!(key in entry)) return;
    delete entry[key];
  } else {
    entry[key] = value;
  }
  changes.push(`${path}.${key}: ${shown(before)} → ${shown(value)}`);
}

/**
 * Цепочка шагов: число и порядок — от сцены, прицел — от аннотации, а числа
 * сложности каждого шага остаются на своих местах по индексу. Шаг, которого в
 * цепочке больше нет, уходит вместе со своими числами — сохранить их негде.
 */
function syncSteps(
  cast: Record<string, unknown>,
  expected: ExpectedCast,
  hold: number,
  path: string,
  changes: string[],
): void {
  const before = Array.isArray(cast.steps) ? (cast.steps as Record<string, unknown>[]) : [];
  const steps = expected.steps.map((aim, index) => {
    const step: Record<string, unknown> = { ...(before[index] ?? {}) };
    put(step, 'aim', aim, `${path}.steps[${index}]`, changes);
    // У каста с отпусканием спад бита И ЕСТЬ подтверждение шага: «сколько
    // держать» и «сколько целиться» там одно число, и разойтись им нельзя
    // (ABIL-4, валидация профиля).
    if (expected.commit === 'release') {
      put(step, 'confirmDelayTicks', hold, `${path}.steps[${index}]`, changes);
    }
    if (step.confirmDelayTicks === undefined) step.confirmDelayTicks = SKELETON.stepDelayTicks;
    if (step.pointNoise === undefined) step.pointNoise = SKELETON.pointNoise;
    return step;
  });
  if (before.length !== steps.length) {
    changes.push(`${path}.steps: ${before.length} шаг(ов) → ${steps.length}`);
  }
  cast.steps = steps;
}

/** Механика каста в существующей записи; числа сложности не трогаются. */
function syncCast(
  entry: Record<string, unknown>,
  expected: ExpectedAbility,
  lag: number,
  path: string,
  changes: string[],
): void {
  const wanted = expected.cast;
  if (wanted === undefined) {
    put(entry, 'cast', undefined, path, changes);
    return;
  }
  if (typeof entry.cast !== 'object' || entry.cast === null) {
    entry.cast = skeletonCast(wanted, defaultHold(expected), lag);
    changes.push(`${path}.cast: описание каста заведено по фазам определения`);
    return;
  }
  const cast = entry.cast as Record<string, unknown>;
  put(cast, 'slotIndex', wanted.slotIndex, `${path}.cast`, changes);
  put(cast, 'commit', wanted.commit, `${path}.cast`, changes);
  put(cast, 'confirmButton', wanted.confirmButton, `${path}.cast`, changes);
  put(cast, 'cancelButton', wanted.cancelButton, `${path}.cast`, changes);
  // Длительность удержания — СОБСТВЕННОЕ число профиля (BOT-6), и генерация его
  // не переписывает даже выпавшим из окна фазы: об этом говорит находка сверки,
  // а правит его дизайнер. Цепочке шагов оно отдаётся таким, каким лежит в
  // документе, — навязывать своё значение здесь означало бы тюнинг за него.
  const held = typeof cast.holdTicks === 'number' ? cast.holdTicks : defaultHold(expected);
  syncSteps(cast, wanted, held, `${path}.cast`, changes);
}

/**
 * Приведение записей профиля к сцене и аннотации (BOT-13). Документ правится НА
 * МЕСТЕ — разобранный JSON, а не разобранный профиль: сохранить порядок ключей
 * и нетронутые поля можно только так, а дифф правки обязан быть о правке.
 *
 * Числа сложности исполнения — `range`, `weight`, `pointNoise`, `cancelChance`,
 * `giveUpTicks`, длительность удержания и собственный темп применения
 * (`cooldownTicks`) — не трогаются НИКОГДА, без исключений: BOT-13 запрещает их
 * перетирать без оговорок, а «привести к сцене» и «перетереть» для числа,
 * которое дизайнер выставил руками, — одно и то же действие. Разошедшееся число
 * остаётся как есть, а называет его та же сверка, что и в гейте
 * (`verifyProfileAbilities` по документу ПОСЛЕ правки) — второй реализации
 * правил вывода не появляется (BOT-13), и чинит число человек.
 *
 * Исключение ровно одно и исключением не является: у нового, ЗАВОДИМОГО скелета
 * числа берутся умолчаниями — это создание записи, а не правка чужой.
 *
 * `options.add` по умолчанию ВЫКЛЮЧЕН: состав способностей бота — решение
 * дизайнера (BOT-6), и «в профиле этой способности нет» читается двояко — либо
 * сцена только что её получила, либо этот уровень сложности ею не играет.
 * Различить их генерации нечем, поэтому заведение записи включается явно.
 */
export function syncProfileAbilities(
  expected: readonly ExpectedAbility[],
  document: Record<string, unknown>,
  profile: BotProfile,
  options: { readonly add: boolean } = { add: false },
): readonly string[] {
  const changes: string[] = [];
  const list = Array.isArray(document.abilities) ? (document.abilities as Record<string, unknown>[]) : [];
  const lag = lagOf(profile);

  for (const wanted of expected) {
    const path = `способность "${wanted.name}"`;
    const entry = list.find((candidate) => candidate.name === wanted.name);
    if (entry === undefined) {
      if (!options.add) continue;
      list.push(skeleton(wanted, lag));
      changes.push(`${path}: заведён скелет записи — числа сложности умолчаниями, тюнинг за дизайнером (BOT-6)`);
      continue;
    }
    put(entry, 'button', wanted.button, path, changes);
    put(entry, 'target', wanted.target, path, changes);
    put(entry, 'hands', wanted.hands, path, changes);
    // Умолчание поля — `false` (BOT-6), поэтому сравниваются ЗНАЧЕНИЯ, а не
    // наличие: названный документом `false` остаётся на месте, а не вычищается
    // диффом, который ничего не меняет.
    if ((entry.requiresMoving === true) !== wanted.requiresMoving) {
      put(entry, 'requiresMoving', wanted.requiresMoving ? true : undefined, path, changes);
    }
    put(entry, 'rise', wanted.rise, path, changes);
    syncCast(entry, wanted, lag, path, changes);
  }
  document.abilities = list;
  return changes;
}
