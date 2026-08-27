/**
 * Debug-сборка (FP-4) и канал диагностики ядра (DIAG-1..4).
 *
 * Диагностика покидает ядро push-вызовом sink'а в момент возникновения записи
 * (DIAG-1). Накопления внутри ядра нет намеренно: буфер записей пришлось бы
 * держать в `SimulationState`, а оттуда он попал бы в снапшот и восстанавливался
 * перемоткой (SNAP-1) и стал бы читаемым изнутри симуляции по соседству с шиной
 * событий (DIAG-7). Push вдобавок переживает исключение из тика — а именно тогда
 * записи и нужны.
 *
 * Контекст тика — переменная уровня модуля, и это НЕ прежний `setAssertSink`.
 * Разница принципиальная: sink больше не живёт в модуле, он живёт на
 * `Simulation` (DI-5), а сюда лишь устанавливается на время одного
 * синхронного тика и снимается после — с сохранением предыдущего значения.
 * Тики двух симуляций в одном процессе не переплетаются, поэтому записи одной
 * никогда не уйдут в приёмник другой. Именно эта развязка и была нужна: у
 * модульного sink'а её не было.
 */
import type {
  CommandOutcome,
  DiagnosticCode,
  DiagnosticData,
  DiagnosticKind,
  DiagnosticLevel,
  DiagnosticRecord,
  DiagnosticsSink,
  TraceLevel,
} from './types.js';

/**
 * Debug-сборка (FP-4): статически подставляемое бандлером условие, а не рантайм-флаг.
 * В релизе `DEBUG === false`, и все ветки с assert вырезаются минификатором.
 */
export const DEBUG: boolean =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
  typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Счётчики текущей системы для записи `systemEnd` (DIAG-3). */
interface SystemCounters {
  queries: number;
  matched: number;
  commands: number;
  applied: number;
  events: number;
}

/** Состояние диагностики на время одного тика. Не состояние симуляции: в снапшот не входит (DIAG-7). */
export interface DiagnosticsContext {
  readonly sink: DiagnosticsSink;
  readonly trace: TraceLevel;
  readonly tick: number;
  system: string | undefined;
  seq: number;
  counters: SystemCounters;
  /**
   * Счётчики объёма работы тика (PERF-3). Плоские целые поля прямо в контексте,
   * а не вложенный объект: контекст и так заводится один на тик, поэтому учёт
   * не добавляет ни одной аллокации, а сквозь системы счётчики копятся (в
   * отличие от `counters`, которые обнуляются на границе каждой системы).
   */
  costCommandsApplied: number;
  costExpressions: number;
  costBroadPhasePairs: number;
  costNpcNeighbors: number;
  costRaycasts: number;
}

const TRACE_ORDER: Readonly<Record<TraceLevel, number>> = { off: 0, systems: 1, full: 2 };

let current: DiagnosticsContext | undefined;

function zeroCounters(): SystemCounters {
  return { queries: 0, matched: 0, commands: 0, applied: 0, events: 0 };
}

/**
 * Исполняет тело тика с установленным контекстом диагностики. Без sink'а тело
 * зовётся напрямую: выключенная диагностика стоит одного сравнения на тик.
 *
 * Предыдущее значение сохраняется и возвращается в `finally` — реплей внутри
 * перемотки (REW-2) зовёт `advance()` из уже идущего прогона, и обрыв
 * исключением не должен оставить чужой контекст установленным.
 */
export function withDiagnostics<T>(
  sink: DiagnosticsSink | undefined,
  tick: number,
  body: () => T,
): T {
  if (sink === undefined) return body();
  const previous = current;
  const ctx: DiagnosticsContext = {
    sink,
    trace: sink.trace,
    tick,
    system: undefined,
    seq: 0,
    counters: zeroCounters(),
    costCommandsApplied: 0,
    costExpressions: 0,
    costBroadPhasePairs: 0,
    costNpcNeighbors: 0,
    costRaycasts: 0,
  };
  current = ctx;
  try {
    const value = body();
    // Сводка стоимости — последней записью тика (PERF-3): раньше объём работы
    // ещё неполон. Вложенный прогон (реплей внутри перемотки, REW-2) отчитается
    // своей записью со своим `tick` — счётчики живут в контексте, а он у каждого
    // прогона свой.
    recordTickCost(ctx);
    return value;
  } finally {
    current = previous;
  }
}

function atLeast(level: TraceLevel): DiagnosticsContext | undefined {
  if (current === undefined) return undefined;
  return TRACE_ORDER[current.trace] >= TRACE_ORDER[level] ? current : undefined;
}

/** Контекст, если включён хотя бы уровень границ систем (DIAG-3). Границы пишет сам этот модуль — наружу не выходит. */
function traceSystems(): DiagnosticsContext | undefined {
  return atLeast('systems');
}

/** Контекст, если включён полный поток команд и событий (DIAG-3). */
export function traceFull(): DiagnosticsContext | undefined {
  return atLeast('full');
}

/** Номер записи резервируется в момент её возникновения — он и задаёт порядок (DIAG-2). */
export function nextSeq(ctx: DiagnosticsContext): number {
  return ctx.seq++;
}

interface RecordOptions {
  /** Заранее зарезервированный номер: команда нумеруется при заказе, а пишется на flush (DIAG-5). */
  readonly seq?: number;
  readonly data?: DiagnosticData;
  readonly outcome?: CommandOutcome;
  readonly message?: string;
}

export function record(
  ctx: DiagnosticsContext,
  kind: DiagnosticKind,
  level: DiagnosticLevel,
  code: DiagnosticCode,
  options: RecordOptions = {},
): void {
  const entry: DiagnosticRecord = {
    tick: ctx.tick,
    seq: options.seq ?? ctx.seq++,
    ...(ctx.system !== undefined ? { system: ctx.system } : {}),
    kind,
    level,
    code,
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    // Текст — только в debug-сборке: он не API (DIAG-2), а в релизе ещё и лишние байты.
    ...(DEBUG && options.message !== undefined ? { message: options.message } : {}),
  };
  deliver(ctx, entry);
}

/**
 * DIAG-4: sink MUST NOT бросать. В debug-сборке нарушение контракта ловится и
 * превращается в жёсткую границу — тихо проглотить его нельзя, брошенное из
 * середины flush исключение оставило бы мир мутированным частично. В релизе за
 * перехват не платим.
 */
function deliver(ctx: DiagnosticsContext, entry: DiagnosticRecord): void {
  if (!DEBUG) {
    ctx.sink.record(entry);
    return;
  }
  try {
    ctx.sink.record(entry);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invariant violated: sink диагностики бросил исключение (DIAG-4): ${reason}`);
  }
}

// ------------------------------------------------------- границы систем (DIAG-3)

/** Начало системы: имя проставляется здесь, счётчики обнуляются. */
export function beginSystem(name: string): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.system = name;
  ctx.counters = zeroCounters();
  const traced = traceSystems();
  if (traced !== undefined) record(traced, 'systemBegin', 'info', 'SYSTEM_BEGIN');
}

/** Окончание системы: счётчики уходят записью, имя снимается. */
export function endSystem(): void {
  const ctx = current;
  if (ctx === undefined) return;
  const traced = traceSystems();
  if (traced !== undefined) {
    const c = ctx.counters;
    record(traced, 'systemEnd', 'info', 'SYSTEM_END', {
      data: {
        queries: c.queries,
        matched: c.matched,
        commands: c.commands,
        applied: c.applied,
        events: c.events,
      },
    });
  }
  ctx.system = undefined;
}

/** Отбор запроса — ответ на самый частый отказ JSON-системы: пустой `matched` (DIAG-3). */
export function countQuery(matched: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.counters.queries++;
  ctx.counters.matched += matched;
}

export function countCommands(issued: number, applied: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.counters.commands += issued;
  ctx.counters.applied += applied;
  // Тот же исход, снятый в той же точке, идёт и в сводку стоимости тика
  // (PERF-3): счётчик системы обнуляется на её границе, счётчик тика копится
  // сквозь все системы. Одна калитка на оба — второй вызов из flush'а стоил бы
  // ещё одного чтения контекста на каждую систему каждого тика.
  ctx.costCommandsApplied += applied;
}

export function countEvent(): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.counters.events++;
}

// -------------------------------------------- счётчики стоимости тика (PERF-3)
//
// Объём выполненной работы в машинно-независимых единицах: сравнивать их
// эталоном можно без поправок на железо. Ни часов, ни случайности здесь нет —
// значения остаются чистой функцией входа симуляции (DIAG-6).
//
// Калитка та же, что у счётчиков систем выше: без подключённого приёмника
// `current` пуст, и учёт не исполняется вовсе — этого и требует PERF-3 от
// инструментирования. В горячих циклах счёт идёт в локальную переменную, а сюда
// приходит готовой суммой: на кандидата broad-phase приходится ровно одно
// целочисленное сложение, а не вызов.

/** Вычисленный узел выражения DSL — одно применение оператора (PERF-3). */
export function countCostExpression(): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costExpressions++;
}

/**
 * Кандидаты broad-phase ФИЗИКИ, осмотренные за один запрос (PERF-3). Покрывает
 * оба её источника кандидатов: кандидатов статики, выданных обходом клеток
 * сетки на каждый запрос (`PhysicsWorld.collect`), и кандидатов динамики,
 * осмотренных линейным обходом препятствий на каждого движущегося (динамика не
 * индексируется — `physics.ts`). Кандидат, отсеянный маской слоёв или тегом,
 * считается наравне с прошедшим: работа по его осмотру уже сделана.
 *
 * Выборка соседей платформы поведения NPC сюда НЕ входит: у неё свой счётчик
 * ниже. Общий счётчик на двоих прятал бы регрессию одной стороны за шумом
 * другой — на сцене с сотнями агентов их выборка соседей превосходит работу
 * физики на порядок, и подорожавший луч в такой сумме был бы не виден вовсе.
 */
export function countCostBroadPhase(pairs: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costBroadPhasePairs += pairs;
}

/**
 * Соседи-агенты, осмотренные за один запрос к сетке платформы поведения NPC
 * (`npc-behavior` NPC-6, NPC-9). Единица та же, что у кандидатов broad-phase, —
 * осмотренный кандидат, — но величина другая: она растёт числом агентов и
 * плотностью толпы, а не составом статики сцены.
 */
export function countCostNpcNeighbors(examined: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costNpcNeighbors += examined;
}

/** Вызов детерминированного raycast Physics API (PERF-3). */
export function countCostRaycast(): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costRaycasts++;
}

/**
 * Сводка объёма работы тика — одна запись на тик (PERF-3) обычной формы DIAG-2:
 * без отметки реального времени и данных окружения, номер — из той же сквозной
 * нумерации, что и трейс. Уровень — границы систем (DIAG-3): счётчики стоимости
 * — та же штатная телеметрия, что и счётчики систем, и полного потока команд
 * для них не нужно.
 *
 * Имени системы у записи нет: она пишется, когда `endSystem` уже снял его, и
 * принадлежит тику целиком.
 *
 * `commandsApplied` — ПРИМЕНЁННЫЕ команды, а не заказанные. Отброшенная команда
 * (адресат уже мёртв, поле не то) в счёт не идёт намеренно: сводка описывает
 * исполненную работу тика, и заказ, не дошедший до мира, работой мира не стал.
 * Заказанные команды видны рядом — в `commands` записи SYSTEM_END (DIAG-3), где
 * тот же исход снят с точностью до системы; имена намеренно разные, потому что
 * величины разные.
 *
 * Контракт числа записей:
 *
 * - тик вне состояния Running (Paused, Rewinding) сводки не получает вовсе —
 *   его и не было; число записей равно числу исполненных Running-тиков;
 * - оборванный тик сводки не получает: его объём работы неполон, и запись
 *   соврала бы о нём. Записи, выданные до обрыва, при этом уже у приёмника
 *   (DIAG-1);
 * - реплей внутри перемотки (REW-2) выдаёт записи ЗАНОВО для уже отчитанных
 *   номеров тиков, поэтому сумма за сессию считает переигранные тики дважды.
 *   Это намеренно: переигранный тик — настоящая исполненная работа, и в
 *   стоимость прогона она входит наравне с первой.
 */
function recordTickCost(ctx: DiagnosticsContext): void {
  if (TRACE_ORDER[ctx.trace] < TRACE_ORDER.systems) return;
  record(ctx, 'tickCost', 'info', 'TICK_COST', {
    data: {
      commandsApplied: ctx.costCommandsApplied,
      expressions: ctx.costExpressions,
      broadPhasePairs: ctx.costBroadPhasePairs,
      npcNeighbors: ctx.costNpcNeighbors,
      raycasts: ctx.costRaycasts,
    },
  });
}

// ------------------------------------------------------ примитивы FP-4

/**
 * Мягкая диагностика (FP-4): при нарушении условия НЕ бросает исключение и не влияет на
 * результат вызвавшей операции — сообщение уходит только в sink. Одинаково в debug и release.
 * Вызывающий код сам решает, звать ли её под `if (DEBUG)` (обычно да — не платить за вызов в release).
 */
export function assert(condition: boolean, message: string, code: DiagnosticCode = 'ASSERT'): void {
  if (condition) return;
  const ctx = current;
  if (ctx === undefined) return;
  record(ctx, 'assert', 'warn', code, { message });
}

/**
 * Жёсткая граница (FP-4/ID-1): бросает исключение в ОБОИХ режимах сборки. Только для мест,
 * где нарушение не имеет детерминированного продолжения (рождение EntityId, аллокация и т.п.).
 *
 * Запись уходит ДО броска: в этом и смысл push-канала (DIAG-1) — отчёта о тике,
 * из которого её можно было бы прочитать, в этом случае не существует.
 */
export function assertInvariant(
  condition: boolean,
  message: string,
  code: DiagnosticCode = 'INVARIANT',
): void {
  if (condition) return;
  const ctx = current;
  if (ctx !== undefined) record(ctx, 'invariant', 'error', code, { message });
  throw new Error(`invariant violated: ${message}`);
}
