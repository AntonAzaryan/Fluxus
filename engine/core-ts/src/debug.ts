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
  costAbilityCandidates: number;
  costBroadPhasePairs: number;
  costBuffCandidates: number;
  costBuffSteps: number;
  costCommandsApplied: number;
  costEventsEmitted: number;
  costExpressions: number;
  costNavNodes: number;
  costNpcNeighbors: number;
  costProjectileSteps: number;
  costRaycasts: number;
  costTweenSteps: number;
  costVisibilityPairs: number;
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
    costAbilityCandidates: 0,
    costBroadPhasePairs: 0,
    costBuffCandidates: 0,
    costBuffSteps: 0,
    costCommandsApplied: 0,
    costEventsEmitted: 0,
    costExpressions: 0,
    costNavNodes: 0,
    costNpcNeighbors: 0,
    costProjectileSteps: 0,
    costRaycasts: 0,
    costTweenSteps: 0,
    costVisibilityPairs: 0,
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
  // Та же эмиссия, снятая в той же точке, идёт и в сводку стоимости тика
  // (PERF-3): счётчик системы обнуляется на её границе, счётчик тика копится
  // сквозь все системы. Одна калитка на все три величины — по тому же доводу,
  // что у `countCommands`: вторая калитка рядом стоила бы ещё одного чтения
  // контекста на КАЖДОМ событии, а событий за тик больше, чем систем.
  ctx.costEventsEmitted++;
  // Длина журнала событий за тик (PERF-8). Считается ЭМИССИЯ, а не читается
  // длина шины перед сбросом: шина чистится в начале СЛЕДУЮЩЕГО тика
  // (`runSystems`), и снятая там длина уехала бы в чужую запись. Внутри тика
  // журнал только растёт, поэтому число эмиссий равно и длине на конец тика, и
  // её пику — и по тому же построению `eventsPeak` сводки размера состояния
  // численно совпадает с `eventsEmitted` сводки стоимости. Строки при этом
  // разные и остаются разными: там занятое состояние, здесь работа платформ,
  // которые событие произвели, и сводки живут порознь.
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
//
// Строка у каждой платформы ядра СВОЯ, и это норма требования, а не вкус
// (PERF-3): на нагрузке, где работа одной платформы превосходит работу другой
// на порядок, регрессия меньшей в общей сумме не видна. Платформа, чья работа
// за тик растёт контентом, заводит здесь счётчик или объявляет свою стоимость
// константной — тот же долг, что `render-quality` QUAL-3 возлагает на фичу
// рендера.

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
 * Кандидаты, осмотренные сканом таргетинга способности (`ability-system` ABIL-5,
 * PERF-3). Единица — сущность, дошедшая до тела скана: кандидат, отброшенный
 * фигурой шага или предикатом контента, считается наравне с выбранным — работа
 * по его осмотру уже сделана (тот же учёт, что у кандидатов broad-phase).
 *
 * Своя строка, а не сумма с кандидатами физики: скан идёт запросом к миру на
 * КАЖДОЕ подтверждение шага и растёт населённостью сцены, а не составом её
 * статики. Сложи их в одну строку — и скан, начавший обходить весь мир вместо
 * радиуса, утонул бы в обходе клеток сетки физики.
 */
export function countCostAbilityCandidates(examined: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costAbilityCandidates += examined;
}

/**
 * Снаряды, продвинутые за тик (`ability-system` ABIL-9, PERF-3). Единица — снаряд,
 * дошедший до разбора попаданий и исчерпания; полёт как таковой здесь не
 * считается, его интегрирует физика и считает своими счётчиками (PHYS-8).
 *
 * Своя строка: число снарядов в воздухе растёт темпом стрельбы сцены, а не
 * числом её сущностей, и в общей сумме платформы способностей залп из сотни
 * снарядов был бы неотличим от одного каста по сотне целей.
 */
export function countCostProjectileSteps(steps: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costProjectileSteps += steps;
}

/**
 * Инстансы баффов, обработанные проходами платформы (`buff-system` BUFF-1..BUFF-6,
 * PERF-3). Единица — инстанс, обработанный ОДНИМ проходом: наложение и ход —
 * два прохода по одному и тому же набору (условие воспроизводимости, см. шапку
 * `abilities/buffs.ts`), и оба считаются, потому что оба исполнены.
 *
 * Своя строка рядом с `buffCandidates`: этот счётчик растёт линейно числом
 * живых инстансов, а поиск хозяина — произведением наложений на инстансы, и
 * именно РАСХОЖДЕНИЕ двух строк называет виновника квадратичности.
 */
export function countCostBuffSteps(steps: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costBuffSteps += steps;
}

/**
 * Инстансы, осмотренные поиском стакающегося хозяина (`buff-system` BUFF-3,
 * PERF-3). Единица — осмотренный инстанс: перебор идёт по всем живым, и
 * отброшенный чужой целью или чужим определением считается наравне с найденным.
 *
 * Своя строка: собственного индекса «цель → инстансы» платформа не строит (он
 * был бы состоянием вне мира, TICK-4), поэтому величина растёт произведением
 * наложений на инстансы. Именно её квадратичность и должен называть эталон
 * стоимости строкой диффа, а не общая сумма работы баффов.
 */
export function countCostBuffCandidates(examined: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costBuffCandidates += examined;
}

/**
 * Пары «наблюдатель × цель», дошедшие до проверки видимости (`fog-of-war`
 * FOW-5, PERF-3). Единица — пара: кандидат наблюдателя, отобранный запросом в
 * радиус, независимо от того, чем он отсеян дальше — маской стелса, уровнем или
 * укрытием.
 *
 * Отдельного счётчика линии видимости рядом нет намеренно: она идёт лучом
 * Physics API и уже посчитана в `raycasts` — второй счётчик обещал бы одну
 * работу дважды (тот же довод, что у `navNodes`).
 *
 * Своя строка: величина растёт ПРОИЗВЕДЕНИЕМ наблюдателей на цели (кандидаты
 * берутся запросом на каждого наблюдателя), и в общей сумме тика этот рост
 * читался бы как подорожавшая работа кого угодно.
 */
export function countCostVisibilityPairs(pairs: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costVisibilityPairs += pairs;
}

/**
 * Твины, продвинутые за тик (`time-system` TWEEN-1, PERF-3). Единица — твин,
 * обработанный проходом системы: и продолженный, и завершившийся на этом тике,
 * — работа шага у них одна и та же.
 *
 * Своя строка: число твинов растёт подачей сцены (каждый эффект, каждая
 * анимация значения), а не населённостью мира, и с работой платформ способностей
 * в одной сумме их движения не различить.
 */
export function countCostTweenSteps(steps: number): void {
  const ctx = current;
  if (ctx === undefined) return;
  ctx.costTweenSteps += steps;
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
 * Состав `data` — по строке на платформу ядра, чья работа за тик растёт
 * контентом (PERF-3): буфер команд и выражения DSL, кандидаты broad-phase и
 * лучи физики, узлы поиска пути, соседи платформы поведения NPC, кандидаты
 * таргетинга, шаги снарядов и инстансы баффов платформы способностей, пары
 * видимости, шаги твинов и события шины. Поля в алфавитном порядке — тем же
 * порядком их укладывает канонический JSON эталона (SER-6).
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
      abilityCandidates: ctx.costAbilityCandidates,
      broadPhasePairs: ctx.costBroadPhasePairs,
      buffCandidates: ctx.costBuffCandidates,
      buffSteps: ctx.costBuffSteps,
      commandsApplied: ctx.costCommandsApplied,
      eventsEmitted: ctx.costEventsEmitted,
      expressions: ctx.costExpressions,
      navNodes: ctx.costNavNodes,
      npcNeighbors: ctx.costNpcNeighbors,
      projectileSteps: ctx.costProjectileSteps,
      raycasts: ctx.costRaycasts,
      tweenSteps: ctx.costTweenSteps,
      visibilityPairs: ctx.costVisibilityPairs,
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
