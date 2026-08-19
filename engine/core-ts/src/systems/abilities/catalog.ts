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
import { validateActions, validateExpression, type SystemDef } from '../../dsl/evaluatedSystem.js';
import { componentSchema } from '../../ecs/world.js';
import { SHAPE_AABB, SHAPE_CIRCLE } from '../physics.js';
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
  INPUT_TARGET_X_FIELD,
  INPUT_TARGET_Y_FIELD,
  PHASE_AUTO,
  PHASE_COMMIT,
  PHASE_HOLD,
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
  type AbilityDef,
  type AbilityInterruptDef,
  type AbilityInterruptsDef,
  type AbilityPhaseDef,
  type AbilityStepDef,
  type CompiledAbility,
  type CompiledBindings,
  type CompiledOutcome,
  type CompiledPhase,
  type CompiledStep,
} from './model.js';
import {
  DURATION_EXPIRE_NAMES,
  PROJECTILE_FADE_NAMES,
  PROJECTILE_HIT_NAMES,
  SLOT_BOUND_NAMES,
  CANDIDATE_NAME,
} from './runtime.js';
import type { Action } from '../../dsl/actions.js';
import type { Expression } from '../../dsl/expr.js';
import type { WorldState } from '../../types.js';

/** Место системы прерываний в шкале (DET-9) — граница для проверки ABIL-6. */
const CAST_INTERRUPT_ORDER = 830;

const NO_ACTIONS: readonly Action[] = [];

/** Ширина маски кнопок и маски лока — 32 бита, как у `bitTest` (EXPR-2). */
const BIT_MAX = 31;

const PHASE_TRIGGERS: Readonly<Record<string, number>> = Object.freeze({
  hold: PHASE_HOLD,
  auto: PHASE_AUTO,
  commit: PHASE_COMMIT,
});

const STEP_KINDS: Readonly<Record<string, number>> = Object.freeze({
  none: STEP_NONE,
  point: STEP_POINT,
  unit: STEP_UNIT,
  vector: STEP_VECTOR,
});

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

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function asObject(node: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) fail(path, 'ожидался объект');
  return node as Readonly<Record<string, unknown>>;
}

function literalName(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'ожидалось непустое имя строкой');
  return value;
}

function bitOf(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > BIT_MAX) {
    fail(path, `ожидался номер бита — целое 0..${BIT_MAX}, получено ${JSON.stringify(value)}`);
  }
  return value as number;
}

/** Ключ закрытого набора: имя из словаря либо ошибка, перечисляющая словарь. */
function keyOf(table: Readonly<Record<string, number>>, value: unknown, path: string): number {
  const name = literalName(value, path);
  if (!Object.hasOwn(table, name)) {
    fail(path, `неизвестное значение "${name}"; допустимы: ${Object.keys(table).sort().join(', ')}`);
  }
  return table[name]!;
}

function actionsOf(node: unknown, world: WorldState, bound: readonly string[], path: string): readonly Action[] {
  if (node === undefined) return NO_ACTIONS;
  validateActions(node, world, bound, path);
  return node as readonly Action[];
}

function expressionOf(
  node: unknown,
  world: WorldState,
  bound: readonly string[],
  path: string,
): Expression | undefined {
  if (node === undefined) return undefined;
  validateExpression(node, world, bound, path);
  return node as Expression;
}

// ------------------------------------------------------------- биндинги ABIL-8

function compileBindings(def: AbilityCatalogDef, world: WorldState): CompiledBindings {
  const runtime = def.abilityRuntime;
  const path = 'abilityRuntime';
  const component = (value: string | undefined, key: string): string | undefined => {
    if (value === undefined) return undefined;
    const name = literalName(value, `${path}.${key}`);
    if (componentSchema(world, name) === undefined) {
      fail(`${path}.${key}`, `компонент "${name}" не зарегистрирован`);
    }
    return name;
  };

  const deadMarker = component(runtime?.deadMarker, 'deadMarker');
  const actionLock = component(runtime?.actionLock, 'actionLock');

  let teamComponent: string | undefined;
  let teamFieldName: string | undefined;
  if (runtime?.teamField !== undefined) {
    const pair = runtime.teamField;
    if (!Array.isArray(pair) || pair.length !== 2) {
      fail(`${path}.teamField`, 'ожидалась пара ["Компонент", "поле"]');
    }
    teamComponent = component(literalName(pair[0], `${path}.teamField[0]`), 'teamField[0]');
    teamFieldName = literalName(pair[1], `${path}.teamField[1]`);
    if (componentSchema(world, teamComponent!)!.fields[teamFieldName] === undefined) {
      fail(`${path}.teamField[1]`, `у компонента "${teamComponent!}" нет поля "${teamFieldName}"`);
    }
  }

  let damageType: string | undefined;
  let damageEntityField: string | undefined;
  let damageAmountField: string | undefined;
  if (runtime?.damageEvent !== undefined) {
    const event = asObject(runtime.damageEvent, `${path}.damageEvent`);
    damageType = literalName(event.type, `${path}.damageEvent.type`);
    damageEntityField = literalName(event.entityField, `${path}.damageEvent.entityField`);
    damageAmountField = literalName(event.amountField, `${path}.damageEvent.amountField`);
    checkDamageEventOrder(def.systems, damageType, path);
  }

  const inputComponent = runtime?.inputComponent === undefined
    ? 'Input'
    : literalName(runtime.inputComponent, `${path}.inputComponent`);
  const inputSchema = componentSchema(world, inputComponent);

  return {
    deadMarker,
    actionLock,
    teamComponent,
    teamFieldName,
    damageType,
    damageEntityField,
    damageAmountField,
    inputComponent,
    hasInput: inputSchema !== undefined,
    hasAimPoint:
      inputSchema !== undefined &&
      inputSchema.fields[INPUT_TARGET_X_FIELD] !== undefined &&
      inputSchema.fields[INPUT_TARGET_Y_FIELD] !== undefined,
  };
}

/**
 * Система сцены, публикующая событие урона, обязана стоять раньше системы
 * прерываний (ABIL-6): шина видна системе только от систем с меньшим `order`
 * (EVT-2), и позже неё событие не сработало бы никогда — молча. Проверка
 * покрывает только JSON-системы; событие, публикуемое сборкой, остаётся на
 * совести сборки.
 */
function checkDamageEventOrder(
  systems: readonly SystemDef[] | undefined,
  damageType: string,
  path: string,
): void {
  for (const system of systems ?? []) {
    if (system.order < CAST_INTERRUPT_ORDER) continue;
    if (!emitsEvent(system.do, damageType)) continue;
    fail(
      `${path}.damageEvent.type`,
      `система "${system.name}" публикует "${damageType}" на order ${system.order}, ` +
        `а прерывания читают шину на ${CAST_INTERRUPT_ORDER} — событие не сработает никогда (ABIL-6)`,
    );
  }
}

/** Обход дерева действий в поисках `emitEvent` названного типа. */
function emitsEvent(node: unknown, type: string): boolean {
  if (Array.isArray(node)) return node.some((child) => emitsEvent(child, type));
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  const emit = record.emitEvent;
  if (typeof emit === 'object' && emit !== null && (emit as Record<string, unknown>).type === type) {
    return true;
  }
  return Object.values(record).some((child) => emitsEvent(child, type));
}

// -------------------------------------------------------------- компиляция

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

  (def.abilities ?? []).forEach((ability, i) => {
    const path = `способность[${i}]`;
    const id = literalName(ability.id, `${path}.id`);
    if (index.has(id)) fail(`${path}.id`, `определение "${id}" объявлено дважды`);
    index.set(id, i);
    abilities.push(compileAbility(ability, id, world, bindings, buffers));
  });

  return {
    abilities,
    phases: buffers.phases,
    steps: buffers.steps,
    outcomes: buffers.outcomes,
    index,
    bindings,
  };
}

function compileAbility(
  def: AbilityDef,
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
  compileSteps(def.targeting?.steps, world, buffers, path);
  const stepCount = buffers.steps.length - stepStart;

  // Имя события связано только там, где событие существует — на тике
  // срабатывания триггера: в `effects` мгновенной способности и в `onEnter`
  // первой фазы. Дальше шина уже другая (EVT-2), и связанное имя обещало бы то,
  // чего нет.
  const eventNames =
    trigger.kind === TRIGGER_EVENT ? [...SLOT_BOUND_NAMES, trigger.eventAs] : SLOT_BOUND_NAMES;
  const hasPhases = def.phases !== undefined && def.phases.length > 0;

  const phaseStart = buffers.phases.length;
  compilePhases(def.phases, world, bindings, recognition, buffers, path, eventNames);
  const phaseCount = buffers.phases.length - phaseStart;

  const effects = actionsOf(
    def.effects,
    world,
    hasPhases ? SLOT_BOUND_NAMES : eventNames,
    `${path}.effects`,
  );

  return {
    id,
    triggerKind: trigger.kind,
    triggerBit: trigger.bit,
    eventType: trigger.eventType,
    eventAs: trigger.eventAs,
    condition: expressionOf(def.condition, world, SLOT_BOUND_NAMES, `${path}.condition`),
    confirmBit: def.confirmBit === undefined ? -1 : bitOf(def.confirmBit, `${path}.confirmBit`),
    cancelBit: def.cancelBit === undefined ? -1 : bitOf(def.cancelBit, `${path}.cancelBit`),
    phaseStart,
    phaseCount,
    stepStart,
    stepCount,
    outcomeStart,
    outcomeCount,
    cooldownTicks: expressionOf(def.cooldownTicks, world, SLOT_BOUND_NAMES, `${path}.cooldownTicks`),
    effects,
    declared: recognition.declared,
    disableMask: recognition.disableMask,
    displacement: recognition.displacement,
    damageThreshold: recognition.damageThreshold,
    onHit: actionsOf(def.projectile?.onHit, world, PROJECTILE_HIT_NAMES, `${path}.projectile.onHit`),
    onFade: actionsOf(def.projectile?.onFade, world, PROJECTILE_FADE_NAMES, `${path}.projectile.onFade`),
    onExpire: actionsOf(def.duration?.onExpire, world, DURATION_EXPIRE_NAMES, `${path}.duration.onExpire`),
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

function compileSteps(
  steps: readonly AbilityStepDef[] | undefined,
  world: WorldState,
  buffers: CatalogBuffers,
  path: string,
): void {
  if (steps === undefined) return;
  if (!Array.isArray(steps)) fail(`${path}.targeting.steps`, 'ожидался список шагов');
  if (steps.length > ABILITY_STEPS) {
    fail(
      `${path}.targeting.steps`,
      `шагов ${steps.length}, а слот несёт ${ABILITY_STEPS} (ABIL-1) — увеличение числа шагов есть правка формата`,
    );
  }
  // Кандидат связан именем `candidate` (ABIL-5); прочие имена — те же, что у
  // остальных выражений определения.
  const bound = [...SLOT_BOUND_NAMES, CANDIDATE_NAME];
  steps.forEach((step, i) => {
    const at = `${path}.targeting.steps[${i}]`;
    const shape = step.shape;
    buffers.steps.push({
      kind: keyOf(STEP_KINDS, step.kind, `${at}.kind`),
      filter: expressionOf(step.filter, world, bound, `${at}.filter`),
      range: expressionOf(step.range, world, SLOT_BOUND_NAMES, `${at}.range`),
      shapeKind: shape === undefined ? -1 : keyOf(SHAPE_KINDS, shape.kind, `${at}.shape.kind`),
      shapeA: expressionOf(
        shape?.kind === 'aabb' ? shape.halfX : shape?.radius,
        world,
        SLOT_BOUND_NAMES,
        `${at}.shape`,
      ),
      shapeB: expressionOf(shape?.halfY, world, SLOT_BOUND_NAMES, `${at}.shape.halfY`),
      halfAngle: expressionOf(shape?.halfAngle, world, SLOT_BOUND_NAMES, `${at}.shape.halfAngle`),
    });
  });
}

function compilePhases(
  phases: readonly AbilityPhaseDef[] | undefined,
  world: WorldState,
  bindings: CompiledBindings,
  recognition: Recognition,
  buffers: CatalogBuffers,
  path: string,
  eventNames: readonly string[],
): void {
  if (phases === undefined) return;
  if (!Array.isArray(phases)) fail(`${path}.phases`, 'ожидался список фаз');
  const ids = phases.map((phase, i) => literalName(phase.id, `${path}.phases[${i}].id`));

  phases.forEach((phase, i) => {
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
function compileTimeout(
  timeout: { readonly then: string } | undefined,
  ids: readonly string[],
  path: string,
): number {
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
  map: AbilityInterruptsDef | undefined,
  world: WorldState,
  bindings: CompiledBindings,
  recognition: Recognition,
  buffers: CatalogBuffers,
  path: string,
  perAbility: boolean,
): void {
  if (map === undefined) return;
  // Ключи обходятся отсортированными: порядок карты имён задаёт порядок записей
  // общей таблицы, а он обязан быть воспроизводимым (SER-6, ACT-3).
  for (const name of Object.keys(asObject(map, path)).sort()) {
    const at = `${path}.${name}`;
    const code = interruptCode(name);
    if (code === 0) {
      fail(at, `неизвестный источник прерывания; словарь закрыт: ${INTERRUPT_SOURCES.join(', ')}`);
    }
    const entry = asObject(map[name], at) as AbilityInterruptDef;
    checkSourceAvailable(name, bindings, at);

    const cooldown = entry.cooldown === undefined
      ? undefined
      : keyOf(COOLDOWN_KINDS, entry.cooldown, `${at}.cooldown`);
    const staged = entry.staged === undefined
      ? undefined
      : keyOf(STAGED_KINDS, entry.staged, `${at}.staged`);
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
    fail(
      path,
      `источник "${name}" недоступен: сцена не объявила биндинг "${required}" (ABIL-8)`,
    );
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
