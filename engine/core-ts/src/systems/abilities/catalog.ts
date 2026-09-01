/**
 * Предкомпиляция определений способностей (ABIL-10): разбор, проверки и
 * приведение во внутреннее представление ОДИН раз на загрузке сцены.
 *
 * Ошибка определения — неизвестное имя действия или оператора, ссылка на
 * незарегистрированный компонент, несуществующий идентификатор фазы в
 * `timeout.then`, число шагов сверх константы слота, недоступный источник
 * прерывания — ошибка загрузки, называющая способность и место, а не ошибка
 * первого срабатывания. Правило и его основание те же, что у регистрации
 * JSON-системы (SYS-3): текст определения известен целиком заранее.
 *
 * Второй реализации проверок здесь нет (ABIL-11): списки действий и выражения
 * проверяет тот же обход, что валидирует JSON-систему, — ему передаются
 * предсвязанные имена платформы параметром `bound`, который он уже принимает.
 */
import { SHAPE_AABB, SHAPE_CIRCLE } from '../physics.js';
import { compileBindings } from './bindings.js';
import { compileBuffs, emptyBuffBuffers } from './buffCatalog.js';
import { ABILITY_STEPS } from './components.js';
import {
  defaultOutcome,
  INTERRUPT_DAMAGED,
  INTERRUPT_DISABLE,
  INTERRUPT_DISPLACEMENT,
  INTERRUPT_SOURCES,
  interruptCode,
  SOURCE_BINDING,
  sourceMask,
} from './interrupt.js';
import {
  COOLDOWN_FULL,
  COOLDOWN_PARTIAL,
  COOLDOWN_REFUND,
  PHASE_AUTO,
  PHASE_COMMIT,
  PHASE_HOLD,
  PHASE_RELEASE,
  STAGED_KEEP,
  STAGED_RESET,
  STEP_NONE,
  STEP_POINT,
  STEP_UNIT,
  STEP_VECTOR,
  TIMEOUT_CANCEL,
  TIMEOUT_COMMIT,
  TIMEOUT_NONE,
  TRIGGER_ALWAYS,
  TRIGGER_EVENT,
  TRIGGER_INPUT,
  type AbilityCatalog,
  type AbilityCatalogDef,
  type AbilityInterruptDef,
  type CompiledAbility,
  type CompiledBindings,
  type CompiledOutcome,
  type CompiledPhase,
  type CompiledStep,
} from './model.js';
import {
  actionsOf,
  asList,
  asObject,
  bitOf,
  expressionOf,
  fail,
  keyOf,
  literalName,
} from './parse.js';
import {
  CANDIDATE_NAME,
  DURATION_EXPIRE_NAMES,
  PROJECTILE_FADE_NAMES,
  PROJECTILE_HIT_NAMES,
  SLOT_BOUND_NAMES,
} from './runtime.js';
import type { Expression } from '../../dsl/expr.js';
import type { WorldState } from '../../types.js';

const PHASE_TRIGGERS: Readonly<Record<string, number>> = Object.freeze({
  hold: PHASE_HOLD,
  auto: PHASE_AUTO,
  commit: PHASE_COMMIT,
  release: PHASE_RELEASE,
});

const STEP_KINDS: Readonly<Record<string, number>> = Object.freeze({
  none: STEP_NONE,
  point: STEP_POINT,
  unit: STEP_UNIT,
  vector: STEP_VECTOR,
});

/** Словарь фигур общий со словарём форм коллайдера (PHYS-2, ABIL-5). */
const SHAPE_KINDS: Readonly<Record<string, number>> = Object.freeze({
  circle: SHAPE_CIRCLE,
  aabb: SHAPE_AABB,
});

const COOLDOWN_KINDS: Readonly<Record<string, number>> = Object.freeze({
  refund: COOLDOWN_REFUND,
  partial: COOLDOWN_PARTIAL,
  full: COOLDOWN_FULL,
});

const STAGED_KINDS: Readonly<Record<string, number>> = Object.freeze({
  reset: STAGED_RESET,
  keep: STAGED_KEEP,
});

interface CatalogBuffers {
  readonly phases: CompiledPhase[];
  readonly steps: CompiledStep[];
  readonly outcomes: CompiledOutcome[];
}

/** Данные распознавания источника, объявляемые только на уровне определения. */
interface Recognition {
  disableMask: number;
  displacement: Expression | undefined;
  damageThreshold: Expression | undefined;
  declared: number;
}

export function compileAbilityCatalog(def: AbilityCatalogDef, world: WorldState): AbilityCatalog {
  const bindings = compileBindings(def, world);
  const buffers: CatalogBuffers = { phases: [], steps: [], outcomes: [] };
  const abilities: CompiledAbility[] = [];
  const index = new Map<string, number>();

  const declared = def.abilities === undefined ? [] : asList(def.abilities, 'abilities');
  declared.forEach((ability, i) => {
    const at = `способность[${i}]`;
    const node = asObject(ability, at);
    const id = literalName(node.id, `${at}.id`);
    if (index.has(id)) fail(`${at}.id`, `определение "${id}" объявлено дважды`);
    index.set(id, i);
    abilities.push(compileAbility(node, id, world, bindings, buffers));
  });

  // Таблицы независимы (SER-7): сцена вправе объявить только `buffs`, только
  // `abilities` либо обе. Разбор у них общий, а порядок здесь — порядок полей
  // конфига, и на результат он не влияет: определения ничем не связаны.
  const buffTable = emptyBuffBuffers();
  compileBuffs(def.buffs, world, buffTable);

  return {
    abilities,
    phases: buffers.phases,
    steps: buffers.steps,
    outcomes: buffers.outcomes,
    index,
    buffs: buffTable.buffs,
    statMods: buffTable.statMods,
    buffTriggers: buffTable.triggers,
    buffIndex: buffTable.index,
    bindings,
  };
}

function compileAbility(
  def: Readonly<Record<string, unknown>>,
  id: string,
  world: WorldState,
  bindings: CompiledBindings,
  buffers: CatalogBuffers,
): CompiledAbility {
  const path = `способность "${id}"`;
  const trigger = compileTrigger(def.trigger, path);
  const recognition: Recognition = {
    disableMask: 0,
    displacement: undefined,
    damageThreshold: undefined,
    declared: 0,
  };

  const outcomeStart = buffers.outcomes.length;
  compileInterrupts(def.interrupts, world, bindings, recognition, buffers, `${path}.interrupts`, true);
  const outcomeCount = buffers.outcomes.length - outcomeStart;

  const stepStart = buffers.steps.length;
  const targeting = def.targeting === undefined ? undefined : asObject(def.targeting, `${path}.targeting`);
  compileSteps(targeting?.steps, world, buffers, path);
  const stepCount = buffers.steps.length - stepStart;

  // Имя события связано только там, где событие существует — на тике
  // срабатывания триггера: в `effects` мгновенной способности и в `onEnter`
  // первой фазы. Дальше шина уже другая (EVT-2), и связанное имя обещало бы то,
  // чего нет.
  const eventNames =
    trigger.kind === TRIGGER_EVENT ? [...SLOT_BOUND_NAMES, trigger.eventAs] : SLOT_BOUND_NAMES;
  const phases = def.phases === undefined ? [] : asList(def.phases, `${path}.phases`);

  const phaseStart = buffers.phases.length;
  compilePhases(phases, world, bindings, recognition, buffers, path, eventNames);

  const projectile =
    def.projectile === undefined ? undefined : asObject(def.projectile, `${path}.projectile`);
  const duration = def.duration === undefined ? undefined : asObject(def.duration, `${path}.duration`);

  return {
    id,
    triggerKind: trigger.kind,
    triggerBit: trigger.bit,
    eventType: trigger.eventType,
    eventAs: trigger.eventAs,
    // Условие сверх триггера (ABIL-3) считается ТАМ ЖЕ, где триггер, — на тике
    // его срабатывания, с уже связанным именем события (`phase.ts`). Поэтому
    // список связанных имён у него тот же, что у `onEnter` первой фазы: без
    // события условие не может спросить, ЭТОМУ ли владельцу событие адресовано,
    // а без такого вопроса одно событие поднимало бы каст у всех носителей
    // определения разом (`npc-behavior` NPC-7).
    condition: expressionOf(def.condition, world, eventNames, `${path}.condition`),
    confirmBit: def.confirmBit === undefined ? -1 : bitOf(def.confirmBit, `${path}.confirmBit`),
    cancelBit: def.cancelBit === undefined ? -1 : bitOf(def.cancelBit, `${path}.cancelBit`),
    phaseStart,
    phaseCount: phases.length,
    stepStart,
    stepCount,
    outcomeStart,
    outcomeCount,
    cooldownTicks: expressionOf(def.cooldownTicks, world, SLOT_BOUND_NAMES, `${path}.cooldownTicks`),
    effects: actionsOf(
      def.effects,
      world,
      phases.length > 0 ? SLOT_BOUND_NAMES : eventNames,
      `${path}.effects`,
    ),
    declared: recognition.declared,
    disableMask: recognition.disableMask,
    displacement: recognition.displacement,
    damageThreshold: recognition.damageThreshold,
    onHit: actionsOf(projectile?.onHit, world, PROJECTILE_HIT_NAMES, `${path}.projectile.onHit`),
    onFade: actionsOf(projectile?.onFade, world, PROJECTILE_FADE_NAMES, `${path}.projectile.onFade`),
    onExpire: actionsOf(duration?.onExpire, world, DURATION_EXPIRE_NAMES, `${path}.duration.onExpire`),
  };
}

interface CompiledTrigger {
  readonly kind: number;
  readonly bit: number;
  readonly eventType: string;
  readonly eventAs: string;
}

/** Ровно один из трёх видов (ABIL-3); расширение набора — правка требования. */
function compileTrigger(def: unknown, path: string): CompiledTrigger {
  const node = asObject(def, `${path}.trigger`);
  const keys = Object.keys(node);
  if (keys.length !== 1) {
    fail(`${path}.trigger`, `ожидался ровно один вид триггера, найдено ${keys.length}`);
  }
  const kind = keys[0]!;
  if (kind === 'input') {
    const input = asObject(node.input, `${path}.trigger.input`);
    return {
      kind: TRIGGER_INPUT,
      bit: bitOf(input.bit, `${path}.trigger.input.bit`),
      eventType: '',
      eventAs: '',
    };
  }
  if (kind === 'event') {
    const event = asObject(node.event, `${path}.trigger.event`);
    return {
      kind: TRIGGER_EVENT,
      bit: -1,
      eventType: literalName(event.type, `${path}.trigger.event.type`),
      eventAs: event.as === undefined ? 'event' : literalName(event.as, `${path}.trigger.event.as`),
    };
  }
  if (kind === 'always') return { kind: TRIGGER_ALWAYS, bit: -1, eventType: '', eventAs: '' };
  fail(`${path}.trigger`, `неизвестный вид триггера "${kind}"; допустимы: always, event, input`);
}

/**
 * Размер фигуры шага (ABIL-5) — ЛИТЕРАЛ определения, а не выражение. Проверка
 * стоит на загрузке по общему правилу платформы (ABIL-10): фигура — одно
 * описание на двух потребителей, и вычисляемый размер разошёл бы их. Симуляция
 * такое выражение вычислила бы и применила, а превью (`rendering` REND-28)
 * получает каталог без мира, литерала не находит и не рисует ФИГУРУ ВОВСЕ —
 * игрок остался бы без изображения зоны, которую каст всё-таки проверяет.
 *
 * Прочие числа определения выражениями остаются: `range`, `cooldownTicks`,
 * `durationTicks` читает только симуляция, и уровень с талантами их законно
 * меняют (ABIL-2). Размер фигуры от них отличается ровно тем, что его читает
 * ещё и кадр.
 */
function shapeSize(node: unknown, path: string): Expression | undefined {
  if (node === undefined) return undefined;
  if (typeof node !== 'number') {
    fail(path, 'размер фигуры шага — литеральное число: его читает и превью, которому мира не дано (ABIL-5, REND-28)');
  }
  return node;
}

function compileSteps(
  steps: unknown,
  world: WorldState,
  buffers: CatalogBuffers,
  path: string,
): void {
  if (steps === undefined) return;
  const list = asList(steps, `${path}.targeting.steps`);
  if (list.length > ABILITY_STEPS) {
    fail(
      `${path}.targeting.steps`,
      `шагов ${list.length}, а слот несёт ${ABILITY_STEPS} (ABIL-1) — увеличение числа шагов есть правка формата`,
    );
  }
  // Кандидат связан именем `candidate` (ABIL-5); прочие имена — те же, что у
  // остальных выражений определения.
  const bound = [...SLOT_BOUND_NAMES, CANDIDATE_NAME];
  list.forEach((raw, i) => {
    const at = `${path}.targeting.steps[${i}]`;
    const step = asObject(raw, at);
    const shape = step.shape === undefined ? undefined : asObject(step.shape, `${at}.shape`);
    const shapeKind = shape === undefined ? -1 : keyOf(SHAPE_KINDS, shape.kind, `${at}.shape.kind`);
    const sizeField = shapeKind === SHAPE_AABB ? 'halfX' : 'radius';
    buffers.steps.push({
      kind: keyOf(STEP_KINDS, step.kind, `${at}.kind`),
      filter: expressionOf(step.filter, world, bound, `${at}.filter`),
      range: expressionOf(step.range, world, SLOT_BOUND_NAMES, `${at}.range`),
      shapeKind,
      shapeA: shapeSize(shape?.[sizeField], `${at}.shape.${sizeField}`),
      shapeB: shapeSize(shape?.halfY, `${at}.shape.halfY`),
      halfAngle: shapeSize(shape?.halfAngle, `${at}.shape.halfAngle`),
    });
  });
}

function compilePhases(
  phases: readonly unknown[],
  world: WorldState,
  bindings: CompiledBindings,
  recognition: Recognition,
  buffers: CatalogBuffers,
  path: string,
  eventNames: readonly string[],
): void {
  const nodes = phases.map((phase, i) => asObject(phase, `${path}.phases[${i}]`));
  const ids = nodes.map((phase, i) => literalName(phase.id, `${path}.phases[${i}].id`));

  nodes.forEach((phase, i) => {
    const at = `${path}.phases[${i}]`;
    const outcomeStart = buffers.outcomes.length;
    compileInterrupts(phase.interrupts, world, bindings, recognition, buffers, `${at}.interrupts`, false);
    buffers.phases.push({
      id: ids[i]!,
      trigger: keyOf(PHASE_TRIGGERS, phase.trigger, `${at}.trigger`),
      durationTicks: expressionOf(phase.durationTicks, world, SLOT_BOUND_NAMES, `${at}.durationTicks`),
      onEnter: actionsOf(phase.onEnter, world, i === 0 ? eventNames : SLOT_BOUND_NAMES, `${at}.onEnter`),
      onExit: actionsOf(phase.onExit, world, SLOT_BOUND_NAMES, `${at}.onExit`),
      onCancel: actionsOf(phase.onCancel, world, SLOT_BOUND_NAMES, `${at}.onCancel`),
      timeoutThen: compileTimeout(phase.timeout, ids, `${at}.timeout`),
      outcomeStart,
      outcomeCount: buffers.outcomes.length - outcomeStart,
    });
  });
}

/**
 * Исход истечения `durationTicks` (ABIL-4): идентификатор фазы того же
 * определения, зарезервированное `commit` либо зарезервированное `cancel`.
 * Индекс фазы — номер В СПИСКЕ ОПРЕДЕЛЕНИЯ, тот же, что лежит в поле `phase`
 * слота (ABIL-1), а не смещение в общем массиве.
 */
function compileTimeout(timeout: unknown, ids: readonly string[], path: string): number {
  if (timeout === undefined) return TIMEOUT_NONE;
  const then = literalName(asObject(timeout, path).then, `${path}.then`);
  if (then === 'commit') return TIMEOUT_COMMIT;
  if (then === 'cancel') return TIMEOUT_CANCEL;
  const target = ids.indexOf(then);
  if (target < 0) {
    fail(`${path}.then`, `фазы "${then}" в определении нет; есть: ${ids.join(', ')}`);
  }
  return target;
}

/**
 * Разбор блока прерываний. `perAbility` различает два уровня: данные
 * распознавания источника (маска лока, предикат смещения, порог урона)
 * принадлежат определению целиком, а фаза переопределяет только исход.
 */
function compileInterrupts(
  map: unknown,
  world: WorldState,
  bindings: CompiledBindings,
  recognition: Recognition,
  buffers: CatalogBuffers,
  path: string,
  perAbility: boolean,
): void {
  if (map === undefined) return;
  const node = asObject(map, path);
  // Ключи обходятся отсортированными: порядок карты имён задаёт порядок записей
  // общей таблицы, а он обязан быть воспроизводимым (SER-6, ACT-3).
  for (const name of Object.keys(node).sort()) {
    const at = `${path}.${name}`;
    const code = interruptCode(name);
    if (code === 0) {
      fail(at, `неизвестный источник прерывания; словарь закрыт: ${INTERRUPT_SOURCES.join(', ')}`);
    }
    const entry = asObject(node[name], at) as AbilityInterruptDef;
    checkSourceAvailable(name, bindings, at);

    const cooldown =
      entry.cooldown === undefined ? undefined : keyOf(COOLDOWN_KINDS, entry.cooldown, `${at}.cooldown`);
    const staged =
      entry.staged === undefined ? undefined : keyOf(STAGED_KINDS, entry.staged, `${at}.staged`);
    const part = expressionOf(entry.refund, world, SLOT_BOUND_NAMES, `${at}.refund`);
    if (cooldown === COOLDOWN_PARTIAL && part === undefined) {
      fail(at, 'исход "partial" требует долю кулдауна в поле "refund"');
    }

    // Умолчания платформы действуют на всё, чего определение не назвало (ABIL-6).
    // Таблица берётся из `interrupt.ts` — второй её копии не заводится.
    const fallback = defaultOutcome(code);
    buffers.outcomes.push({
      source: code,
      cooldown: cooldown ?? fallback.cooldown,
      part,
      staged: staged ?? fallback.staged,
    });
    recognition.declared |= sourceMask(code);
    compileRecognition(code, entry, world, recognition, at, perAbility);
  }
}

/**
 * Определение, называющее источник, недоступный в этой сцене, отвергается на
 * загрузке сообщением, называющим способность и недостающий биндинг (ABIL-8):
 * молча недействующего прерывания не бывает.
 */
function checkSourceAvailable(name: string, bindings: CompiledBindings, path: string): void {
  const required = Object.hasOwn(SOURCE_BINDING, name) ? SOURCE_BINDING[name]! : undefined;
  if (required === undefined) return;
  const declared =
    required === 'deadMarker'
      ? bindings.deadMarker !== undefined
      : required === 'actionLock'
        ? bindings.actionLock !== undefined
        : bindings.damageType !== undefined;
  if (!declared) {
    fail(path, `источник "${name}" недоступен: сцена не объявила биндинг "${required}" (ABIL-8)`);
  }
}

function compileRecognition(
  code: number,
  entry: AbilityInterruptDef,
  world: WorldState,
  recognition: Recognition,
  path: string,
  perAbility: boolean,
): void {
  const own = entry.mask !== undefined || entry.when !== undefined || entry.threshold !== undefined;
  if (own && !perAbility) {
    fail(path, 'данные распознавания источника объявляются на уровне определения, а не фазы');
  }
  if (!perAbility) return;
  if (code === INTERRUPT_DISABLE) {
    if (!Number.isInteger(entry.mask)) {
      fail(`${path}.mask`, 'источник "disable" требует целочисленной маски лока (LOC-7)');
    }
    recognition.disableMask = entry.mask!;
  }
  if (code === INTERRUPT_DISPLACEMENT) {
    if (entry.when === undefined) {
      fail(`${path}.when`, 'источник "displacement" требует предиката над владельцем');
    }
    recognition.displacement = expressionOf(entry.when, world, SLOT_BOUND_NAMES, `${path}.when`);
  }
  if (code === INTERRUPT_DAMAGED) {
    recognition.damageThreshold = expressionOf(
      entry.threshold,
      world,
      SLOT_BOUND_NAMES,
      `${path}.threshold`,
    );
  }
}
