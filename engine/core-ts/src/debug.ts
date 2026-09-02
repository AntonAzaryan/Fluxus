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
  /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition --
   * `?.` здесь не лишний, и выражение сознательно оставлено дословным.
   * Типы Node обещают, что `process.env` есть всегда, но эта строка исполняется
   * и там, где `process` — shim бандлера без `env`, и там, где глобали нет
   * вовсе (браузер, воркер); отсюда обе проверки. Переписать их через
   * промежуточную переменную нельзя: бандлер подставляет значение вместо
   * ТЕКСТА `process.env.NODE_ENV`, и на этой подстановке держится вырезание
   * веток assert в релизе (FP-4). */
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
  costNavNodes: number;
  costNpcNeighbors: number;
  costRaycasts: number;
  /**
   * Величины занятой памяти тика (PERF-8). Живут теми же плоскими целыми
   * полями контекста и по той же причине, что счётчики стоимости выше:
   * контекст заводится один на тик, поэтому учёт не стоит ни одной аллокации.
   *
   * Арифметика у них ДРУГАЯ: у стоимости `+=`, здесь — либо снимок величины на
   * момент записи (мир), либо максимум за тик (буфер команд, куча поиска пути),
   * либо длина, которая внутри тика только растёт (журнал событий). Память —
   * состояние, а не работа, и «сколько всего» для неё бессмысленно.
   */
  footWorldBytes: number;
  footEntitiesAlive: number;
  footEntitiesFree: number;
  footTagEntries: number;
  footCommandsPeak: number;
  footEvents: number;
  footNavHeapCapacity: number;
  footNavBytes: number;
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
    costNavNodes: 0,
    costNpcNeighbors: 0,
    costRaycasts: 0,
    footWorldBytes: 0,
    footEntitiesAlive: 0,
    footEntitiesFree: 0,
    footTagEntries: 0,
    footCommandsPeak: 0,
    footEvents: 0,
    footNavHeapCapacity: 0,
    footNavBytes: 0,
  };
  current = ctx;
  try {
    const value = body();
    // Сводка стоимости — последней записью тика (PERF-3): раньше объём работы
    // ещё неполон. Вложенный прогон (реплей внутри перемотки, REW-2) отчитается
    // своей записью со своим `tick` — счётчики живут в контексте, а он у каждого
    // прогона свой.
    recordTickCost(ctx);
    // Сводка размера состояния — следом за сводкой работы (PERF-8) и по тем же
    // правилам: последней записью штатно завершённого тика, тем же контрактом
    // числа записей. Порядок двух сводок между собой фиксирован здесь: он и
    // задаёт их номера в тике, а номер — часть побитовой сверки трейса (DIAG-6).
    recordTickFootprint(ctx);
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

/**
 * Контекст сводки размера состояния (PERF-8), если её вообще будут писать —
 * то есть на уровне границ систем и выше (DIAG-3).
 *
 * Наружу выходит потому, что величины мира знает только сам мир (`ecs/world.ts`),
 * а сюда они приезжают готовыми числами. Проверка ЗДЕСЬ, а не там: обход тегов
 * стоит O(сущностей с тегами), и на выключенной диагностике его быть не должно
 * вовсе — это ровно та инертность, которой PERF-8 требует от учёта.
 */
export function tickFootprint(): DiagnosticsContext | undefined {
  return atLeast('systems');
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
 *
 * Сигнал идёт ИСКЛЮЧЕНИЕМ, а не записью потока, и кода в словаре DIAG-2 у него
 * поэтому нет: сообщить о сломанном приёмнике через него же нельзя, а
 * объявленный код обещал бы подписчику сигнал, которого не будет никогда.
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
  // Пиковая длина журнала команд за тик (PERF-8), снятая в той же точке и той
  // же калиткой: `flush` зовёт этот счётчик прямо перед очисткой журнала, то
  // есть `issued` здесь и есть длина буфера на момент сброса. Максимум, а не
  // сумма: буфер флашится в конце каждой системы, и памяти он занимает столько,
  // сколько в самой длинной из них.
  if (issued > ctx.footCommandsPeak) ctx.footCommandsPeak = issued;
}

export function countEvent(): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.counters.events++;
  // Длина журнала событий за тик (PERF-8). Считается ЭМИССИЯ, а не читается
  // длина шины перед сбросом: шина чистится в начале СЛЕДУЮЩЕГО тика
  // (`runSystems`), и снятая там длина уехала бы в чужую запись. Внутри тика
  // журнал только растёт, поэтому число эмиссий равно и длине на конец тика, и
  // её пику.
  ctx.footEvents++;
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

/**
 * Работа одного запроса пути (`pathfinding` NAV-5, NAV-10): раскрытые узлы A*
 * плюс пробы клеток обхода видимости. Единица та же, что у кандидатов
 * broad-phase, — осмотренная клетка, — и обе половины считаются в одну строку
 * намеренно: это ровно та работа, которую ограничивает бюджет поиска (NAV-5),
 * и разделять её счётчиками значило бы обещать бюджету две единицы.
 *
 * Своя строка, а не сумма с соседями: работа навигации растёт размером арены и
 * числом перезапросов, а не составом статики и не плотностью толпы, — в общем
 * счётчике её регрессия утонула бы (тот же довод, что у `npcNeighbors`).
 */
export function countCostNavNodes(nodes: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costNavNodes += nodes;
}

/**
 * Величины занятой памяти навигации (`pathfinding` NAV-5, PERF-8): ёмкость кучи
 * открытых узлов и байты рабочих структур поиска вместе с запечённой сеткой.
 * Обе — величины занятого, а не работы: они живут на сборке навигации и растут
 * только перевыделением, поэтому пик за тик и текущее значение у них совпадают.
 *
 * Одна калитка на обе: запрос пути зовёт её один раз, а два вызова на запрос
 * стоили бы второго чтения контекста на каждом поиске каждого агента.
 * Максимум берётся всё равно — запросов за тик много, и записать в поле
 * последний из них значило бы отдать эталону не пик.
 */
export function countNavFootprint(heapCapacity: number, bytes: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  if (heapCapacity > ctx.footNavHeapCapacity) ctx.footNavHeapCapacity = heapCapacity;
  if (bytes > ctx.footNavBytes) ctx.footNavBytes = bytes;
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
      navNodes: ctx.costNavNodes,
      npcNeighbors: ctx.costNpcNeighbors,
      raycasts: ctx.costRaycasts,
    },
  });
}

/**
 * Сводка размера состояния тика — одна запись на тик (PERF-8) обычной формы
 * DIAG-2, рядом со сводкой стоимости и тем же контрактом числа записей:
 * оборванный тик её не получает, тик вне `Running` не получает тоже, реплей
 * перемотки (REW-2) выдаёт её заново.
 *
 * Величины машинно-независимы: байты типизированных массивов мира, числа
 * сущностей, тегов, команд и узлов кучи. Байтов кучи среды исполнения здесь нет
 * и быть не может (PERF-8): они меняются с версией среды при неизменном коде, и
 * эталоном стать не могут — их зона у сторожа PERF-10.
 *
 * - `worldBytes` — ёмкость хранилища мира: колонки плоской таблицы полей, слова
 *   масок и типизированные массивы индекса сущностей. Константа мира,
 *   посчитанная при его создании, — запись её только читает;
 * - `entitiesAlive`, `entitiesFree` — живые сущности и слоты, ждущие
 *   переиспользования (ID-2, ID-6): пара, по которой видно и населённость мира,
 *   и возврат слотов оборотом;
 * - `tagEntries` — записей тегов суммарно по сущностям;
 * - `commandsPeak`, `eventsPeak` — длины буфера команд и журнала событий за тик;
 * - `navHeapCapacity` — ёмкость кучи открытых узлов поиска пути (NAV-5);
 * - `navBytes` — байты рабочих структур поиска (пять массивов по клетке) и
 *   запечённой сетки: они растут площадью арены, а ёмкость кучи — нет, и по
 *   одной ей рост памяти навигации не читался бы вовсе.
 *
 * Имени системы у записи нет: она принадлежит тику целиком — как и сводка
 * стоимости, и по той же причине.
 */
function recordTickFootprint(ctx: DiagnosticsContext): void {
  if (TRACE_ORDER[ctx.trace] < TRACE_ORDER.systems) return;
  record(ctx, 'tickFootprint', 'info', 'TICK_FOOTPRINT', {
    data: {
      worldBytes: ctx.footWorldBytes,
      entitiesAlive: ctx.footEntitiesAlive,
      entitiesFree: ctx.footEntitiesFree,
      tagEntries: ctx.footTagEntries,
      commandsPeak: ctx.footCommandsPeak,
      eventsPeak: ctx.footEvents,
      navHeapCapacity: ctx.footNavHeapCapacity,
      navBytes: ctx.footNavBytes,
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
