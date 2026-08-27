/**
 * Разбор и предкомпиляция документов поведения NPC (`npc-behavior` NPC-2):
 * проверки и приведение во внутреннее представление ОДИН раз на загрузке сцены.
 *
 * Неизвестное имя исполнителя, входа, формы кривой или условия перехода —
 * ошибка ЗАГРУЗКИ, называющая место в документе и сам словарь, а не молчаливое
 * умолчание и не ошибка первого срабатывания (NPC-2). Правило и его основание
 * те же, что у регистрации JSON-системы (SYS-3) и компиляции способностей
 * (ABIL-10): текст документа известен целиком заранее, а его автор —
 * геймдизайнер.
 *
 * Читалки недоверенного JSON берутся у платформы способностей
 * (`abilities/parse.ts`) — второй реализации тех же отказов здесь нет: автор
 * правит один документ сцены и не должен читать два разных текста про одну и ту
 * же опечатку.
 */
import { SCORING_CURVE_FIELDS, type FixedCurve, type ScoringCurveType } from '../../dsl/scoring.js';
import { asList, asObject, fail, keyOf, literalName } from '../abilities/parse.js';
import {
  NPC_BEHAVIOR_SCHEMA,
  type CompiledAction,
  type CompiledBehavior,
  type CompiledConsideration,
  type CompiledNpcBindings,
  type CompiledState,
  type CompiledThreatSource,
  type CompiledTransition,
  type NpcCatalog,
  type NpcPlatformDef,
  type NpcWaveDef,
  type NpcWavesDef,
} from './model.js';
import { CONDITION_CODES, CURVE_CODES, EXECUTOR_CODES, INPUT_CODES, TIER_CODES } from './tables.js';
import { FIXED_ONE, type Fixed } from '../../types.js';

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Нормативные умолчания необязательных полей документа — их называет NPC-2. */
const DEFAULT_ELAPSED_SCALE = 60;
const DEFAULT_CROWD_SCALE = 4;

/**
 * Умолчание интервала пересчёта вектора локального расхождения (NPC-2, NPC-6) —
 * три тика. Число НОРМАТИВНОЕ, а не выбор реализации: молчание документа
 * обязано значить у двух реализаций ядра одно и то же (CLI-6), поэтому оно
 * живёт требованием, а здесь только повторено именем.
 */
const DEFAULT_SEPARATION_INTERVAL = 3;

/** Число Q16.16 из документа: целое в контейнере i32 — иначе оно не Q16.16 (FP-1). */
function fixedOf(node: unknown, path: string): Fixed {
  if (typeof node !== 'number' || !Number.isInteger(node) || node < INT32_MIN || node > INT32_MAX) {
    fail(path, `ожидалось число Q16.16 целым в i32, получено ${JSON.stringify(node)}`);
  }
  return node;
}

/** Неотрицательное целое: сроки в тиках и размеры волн. */
function countOf(node: unknown, path: string, max = INT32_MAX): number {
  if (typeof node !== 'number' || !Number.isInteger(node) || node < 0 || node > max) {
    fail(path, `ожидалось целое 0..${max}, получено ${JSON.stringify(node)}`);
  }
  return node;
}

/** Необязательное поле Q16.16 с умолчанием механизма. */
function fixedOr(node: unknown, path: string, fallback: Fixed): Fixed {
  return node === undefined ? fallback : fixedOf(node, path);
}

/** Доля Q16.16 в [0, 1]: то, что общая модель помечает полем `unit` (NPC-3). */
function unitOf(node: unknown, path: string): Fixed {
  const value = fixedOf(node, path);
  if (value < 0 || value > FIXED_ONE) {
    fail(path, `ожидалась доля [0, 1] в Q16.16 (0..${FIXED_ONE}), получено ${value}`);
  }
  return value;
}

/**
 * Кривая отклика в Q16.16: форма — из закрытого словаря общей модели (NPC-3),
 * параметры — по её же таблице полей. Ходом по таблице, а не своим `switch`:
 * новая форма модели становится доступна документу NPC без правки этого файла.
 */
function compileCurve(node: unknown, path: string): FixedCurve {
  const root = asObject(node, path);
  const type = literalName(root.type, `${path}.type`) as ScoringCurveType;
  const code = keyOf(CURVE_CODES, type, `${path}.type`);
  const params: Fixed[] = [];
  for (const field of SCORING_CURVE_FIELDS[type]) {
    // Признак доли объявляет ОБЩАЯ МОДЕЛЬ (NPC-3), и применяют его оба
    // потребителя: параметр-доля у документа NPC ограничен тем же [0, 1], что и
    // у документа бота, — иначе один и тот же параметр одной и той же формы
    // значил бы у них разное.
    const at = `${path}.${field.key}`;
    params.push(field.unit ? unitOf(root[field.key], at) : fixedOf(root[field.key], at));
  }
  return { type: code, a: params[0] ?? 0, b: params[1] ?? 0, c: params[2] ?? 0 };
}

/** Ось полезности: вход словаря NPC, кривая общей модели и вес (NPC-3). */
function compileConsideration(node: unknown, path: string): CompiledConsideration {
  const root = asObject(node, path);
  return {
    input: keyOf(INPUT_CODES, root.input, `${path}.input`),
    curve: compileCurve(root.curve, `${path}.curve`),
    // Вес оси — доля по построению диапазона (NPC-3): вес больше единицы вывел
    // бы полезность действия за [0, 1], то есть сделал бы веса разных действий
    // несравнимыми.
    weight: unitOf(root.weight, `${path}.weight`),
  };
}

/** Действие: исполнитель закрытого словаря и непустой список осей (NPC-2, NPC-3). */
function compileAction(node: unknown, path: string): CompiledAction {
  const root = asObject(node, path);
  const executor = keyOf(EXECUTOR_CODES, root.executor, `${path}.executor`);
  const casts = executor === EXECUTOR_CODES.cast;
  if (casts === (root.event === undefined)) {
    fail(
      `${path}.event`,
      casts
        ? 'исполнитель "cast" обязан назвать тип публикуемого события (NPC-7)'
        : 'тип события осмыслен только у исполнителя "cast"',
    );
  }
  const considerations = asList(root.considerations, `${path}.considerations`);
  if (considerations.length === 0) {
    // Пустой список — полезность «пустого произведения», то есть действие,
    // выигрывающее всегда и ни на чём не основанное.
    fail(`${path}.considerations`, 'пустой список — полезность действия не на чем считать');
  }
  return {
    executor,
    eventType: casts ? literalName(root.event, `${path}.event`) : '',
    considerations: considerations.map((entry, index) =>
      compileConsideration(entry, `${path}.considerations[${index}]`),
    ),
  };
}

/** Переход HFSM: адресат по имени состояния и условие закрытого словаря (NPC-2, NPC-7). */
function compileTransition(node: unknown, path: string, names: readonly string[]): CompiledTransition {
  const root = asObject(node, path);
  const to = literalName(root.to, `${path}.to`);
  const target = names.indexOf(to);
  if (target < 0) {
    fail(`${path}.to`, `состояния "${to}" в документе нет; объявлены: ${names.join(', ')}`);
  }
  const when = asObject(root.when, `${path}.when`);
  const kind = keyOf(CONDITION_CODES, when.kind, `${path}.when.kind`);
  const wantsValue =
    kind === CONDITION_CODES.healthBelow ||
    kind === CONDITION_CODES.healthAbove ||
    kind === CONDITION_CODES.targetWithin ||
    kind === CONDITION_CODES.targetBeyond;
  const wantsTicks = kind === CONDITION_CODES.elapsed;
  const wantsEvent = kind === CONDITION_CODES.event;
  return {
    to: target,
    kind,
    value: wantsValue ? fixedOf(when.value, `${path}.when.value`) : 0,
    ticks: wantsTicks ? countOf(when.ticks, `${path}.when.ticks`) : 0,
    eventType: wantsEvent ? literalName(when.event, `${path}.when.event`) : '',
    eventEntityField:
      wantsEvent && when.entityField !== undefined
        ? literalName(when.entityField, `${path}.when.entityField`)
        : '',
  };
}

function compileState(node: unknown, path: string, names: readonly string[]): CompiledState {
  const root = asObject(node, path);
  const actions = asList(root.actions, `${path}.actions`);
  if (actions.length === 0) fail(`${path}.actions`, 'ни одного действия — выбирать не из чего');
  const transitions = root.transitions === undefined ? [] : asList(root.transitions, `${path}.transitions`);
  return {
    name: literalName(root.name, `${path}.name`),
    actions: actions.map((entry, index) => compileAction(entry, `${path}.actions[${index}]`)),
    transitions: transitions.map((entry, index) =>
      compileTransition(entry, `${path}.transitions[${index}]`, names),
    ),
  };
}

/** Источник угрозы: событие шины, его поля и вес (NPC-5). */
function compileThreatSource(node: unknown, path: string): CompiledThreatSource {
  const root = asObject(node, path);
  return {
    eventType: literalName(root.event, `${path}.event`),
    victimField: literalName(root.victimField, `${path}.victimField`),
    sourceField: literalName(root.sourceField, `${path}.sourceField`),
    amountField: root.amountField === undefined ? '' : literalName(root.amountField, `${path}.amountField`),
    weight: fixedOf(root.weight, `${path}.weight`),
  };
}

/** Документ поведения целиком (NPC-2): версия формы, tier, каденс, дистанции, состояния. */
function compileBehavior(node: unknown, path: string): CompiledBehavior {
  const root = asObject(node, path);
  const schema = countOf(root.schema, `${path}.schema`);
  if (schema !== NPC_BEHAVIOR_SCHEMA) {
    fail(`${path}.schema`, `${schema} — реализация читает форму ${NPC_BEHAVIOR_SCHEMA}`);
  }
  const tier = keyOf(TIER_CODES, root.tier, `${path}.tier`);
  const decision = asObject(root.decision, `${path}.decision`);
  const intervalTicks = countOf(decision.intervalTicks, `${path}.decision.intervalTicks`, 1024);
  if (intervalTicks === 0) {
    fail(`${path}.decision.intervalTicks`, 'интервал пересмотра решений — минимум один тик');
  }
  if (tier === TIER_CODES.elite && intervalTicks !== 1) {
    // Tier `elite` и означает «решает каждый тик» (NPC-4); интервал сверх
    // единицы у него — противоречие документа самому себе, а не настройка.
    fail(`${path}.decision.intervalTicks`, 'tier "elite" решает каждый тик — интервал обязан быть 1');
  }
  // Каденс пересчёта расхождения (NPC-6): свежесть ИСПОЛНЕНИЯ уже принятого
  // решения, поэтому поле лежит рядом с весом расхождения, а не внутри
  // `decision` — в бюджет решений оно не входит и семантики документа не меняет.
  const separationIntervalTicks =
    root.separationIntervalTicks === undefined
      ? DEFAULT_SEPARATION_INTERVAL
      : countOf(root.separationIntervalTicks, `${path}.separationIntervalTicks`);
  if (separationIntervalTicks === 0) {
    fail(
      `${path}.separationIntervalTicks`,
      'интервал пересчёта расхождения — минимум один тик; ноль расхождения не выключает, для этого есть separationWeight',
    );
  }
  const ranges = asObject(root.ranges, `${path}.ranges`);
  const states = asList(root.states, `${path}.states`);
  if (states.length === 0) fail(`${path}.states`, 'ни одного состояния — исполнять нечего');
  const names = states.map((entry, index) =>
    literalName(asObject(entry, `${path}.states[${index}]`).name, `${path}.states[${index}].name`),
  );
  const threat = root.threat === undefined ? undefined : asObject(root.threat, `${path}.threat`);
  const sources = threat === undefined ? [] : asList(threat.sources, `${path}.threat.sources`);
  const scales = root.scales === undefined ? {} : asObject(root.scales, `${path}.scales`);
  return {
    name: literalName(root.name, `${path}.name`),
    tier,
    intervalTicks,
    sense: fixedOf(ranges.sense, `${path}.ranges.sense`),
    attack: fixedOf(ranges.attack, `${path}.ranges.attack`),
    arrive: fixedOf(ranges.arrive, `${path}.ranges.arrive`),
    separation: fixedOf(ranges.separation, `${path}.ranges.separation`),
    speed: fixedOf(root.speed, `${path}.speed`),
    // Умолчание веса расхождения — полная сила (NPC-2).
    separationWeight: fixedOr(root.separationWeight, `${path}.separationWeight`, FIXED_ONE),
    separationIntervalTicks,
    elapsedScale:
      scales.elapsedTicks === undefined
        ? DEFAULT_ELAPSED_SCALE
        : Math.max(1, countOf(scales.elapsedTicks, `${path}.scales.elapsedTicks`)),
    crowdScale:
      scales.crowd === undefined
        ? DEFAULT_CROWD_SCALE
        : Math.max(1, countOf(scales.crowd, `${path}.scales.crowd`)),
    switchMargin: threat === undefined ? 0 : fixedOf(threat.switchMargin, `${path}.threat.switchMargin`),
    decayPerTick:
      threat === undefined ? FIXED_ONE : fixedOr(threat.decayPerTick, `${path}.threat.decayPerTick`, FIXED_ONE),
    threatSources: sources.map((entry, index) =>
      compileThreatSource(entry, `${path}.threat.sources[${index}]`),
    ),
    states: states.map((entry, index) => compileState(entry, `${path}.states[${index}]`, names)),
  };
}

/** Биндинги сцены (NPC-1): умолчания — конвенция имён ядра, остальное называет сцена. */
function compileBindings(node: unknown, path: string): CompiledNpcBindings {
  const root = node === undefined ? {} : asObject(node, path);
  const pair = (value: unknown, where: string): readonly [string, string] => {
    const list = asList(value, where);
    if (list.length !== 2) fail(where, 'ожидалась пара ["Компонент", "поле"]');
    return [literalName(list[0], `${where}[0]`), literalName(list[1], `${where}[1]`)];
  };
  const health = root.health === undefined ? undefined : pair(root.health, `${path}.health`);
  const healthMax = root.healthMax === undefined ? undefined : pair(root.healthMax, `${path}.healthMax`);
  if ((health === undefined) !== (healthMax === undefined)) {
    // Доля здоровья — отношение двух полей (NPC-7): одно без другого не
    // вычисляется, и половина биндинга выглядела бы как исправная настройка.
    fail(`${path}.health`, 'биндинги health и healthMax объявляются парой — доля считается их отношением');
  }
  const team = root.team === undefined ? undefined : pair(root.team, `${path}.team`);
  return {
    position: root.position === undefined ? 'Position' : literalName(root.position, `${path}.position`),
    velocity: root.velocity === undefined ? 'Velocity' : literalName(root.velocity, `${path}.velocity`),
    healthComponent: health?.[0] ?? '',
    healthField: health?.[1] ?? '',
    healthMaxComponent: healthMax?.[0] ?? '',
    healthMaxField: healthMax?.[1] ?? '',
    teamComponent: team?.[0] ?? '',
    teamField: team?.[1] ?? '',
    deadMarker: root.deadMarker === undefined ? '' : literalName(root.deadMarker, `${path}.deadMarker`),
    hasHealth: health !== undefined,
    hasTeam: team !== undefined,
  };
}

/** Запись таблицы волн (NPC-8): состав, темп и место выпуска. */
function compileWave(node: unknown, path: string, behaviors: number): NpcWaveDef {
  const root = asObject(node, path);
  const behavior = countOf(root.behavior, `${path}.behavior`, behaviors - 1);
  const route = root.route === undefined ? undefined : countOf(root.route, `${path}.route`);
  if (route === undefined && (root.x === undefined || root.y === undefined)) {
    fail(path, 'волна называет либо маршрут (route), либо точку выпуска (x, y)');
  }
  return {
    prefab: literalName(root.prefab, `${path}.prefab`),
    count: countOf(root.count, `${path}.count`),
    behavior,
    delayTicks: countOf(root.delayTicks, `${path}.delayTicks`),
    spacingTicks: countOf(root.spacingTicks, `${path}.spacingTicks`),
    ...(route === undefined ? {} : { route }),
    ...(root.x === undefined ? {} : { x: fixedOf(root.x, `${path}.x`) }),
    ...(root.y === undefined ? {} : { y: fixedOf(root.y, `${path}.y`) }),
  };
}

function compileWaves(node: unknown, path: string, behaviors: number): NpcWavesDef {
  const root = asObject(node, path);
  const entries = asList(root.entries, `${path}.entries`);
  if (entries.length === 0) fail(`${path}.entries`, 'ни одной волны — режиссировать нечего');
  return {
    cap: countOf(root.cap, `${path}.cap`),
    entries: entries.map((entry, index) => compileWave(entry, `${path}.entries[${index}]`, behaviors)),
  };
}

/**
 * Компиляция платформы поведения NPC из конфига сцены (SER-7, NPC-2).
 * Зовётся загрузчиком сцены до первого тика: документ с опечаткой не должен
 * доживать до матча.
 */
export function compileNpcCatalog(def: NpcPlatformDef, path = 'сцена.npc'): NpcCatalog {
  const list = asList(def.behaviors, `${path}.behaviors`);
  if (list.length === 0) fail(`${path}.behaviors`, 'ни одного документа поведения');
  const behaviors = list.map((entry, index) => compileBehavior(entry, `${path}.behaviors[${index}]`));
  const budget =
    def.decisionBudget === undefined
      ? INT32_MAX
      : countOf(def.decisionBudget, `${path}.decisionBudget`);
  if (def.decisionBudget !== undefined && budget === 0) {
    fail(`${path}.decisionBudget`, 'нулевой бюджет — ни один агент не пересмотрит решение никогда');
  }
  // Числа видов источников угрозы ёмкость таблицы не ограничивает: NPC_THREAT_SLOTS
  // ограничивает ОДНОВРЕМЕННЫХ источников, и переполнение — штатное вытеснение
  // минимума (NPC-5), а не ошибка документа.
  return {
    behaviors,
    bindings: compileBindings(def.bindings, `${path}.bindings`),
    decisionBudget: budget,
    waves: def.waves === undefined ? undefined : compileWaves(def.waves, `${path}.waves`, behaviors.length),
  };
}
