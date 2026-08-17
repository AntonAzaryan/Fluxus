/**
 * Счётчики стоимости рендера (`performance-budget` PERF-3) — зеркало
 * diagnostics-стока ядра (`core-ts/src/debug.ts`) на стороне главного потока.
 *
 * ## Что это
 *
 * Плоская структура именованных счётчиков объёма работы: сколько текселей маски
 * просмотрено, сколько тестов «субсэмпл × отрезок» выполнено, сколько байтов
 * ушло в текстуру, сколько инстансов тронуто на доставке и в кадре. Единицы —
 * машинно-независимые (PERF-3): на одной и той же нагрузке значения совпадают
 * побитово на любой машине, потому что ни времени, ни случайности в них нет.
 * Времени здесь не место и по конструкции: часы (`Date`, `performance`) этот
 * модуль не читает — wall-time стерегут сторожа PERF-5, а не счётчики.
 *
 * ## Почему сток, а не поля объектов
 *
 * Ровно по причине DIAG-1: накопление внутри измеряемого объекта пришлось бы
 * где-то держать, обнулять и не забыть про него в следующей подсистеме. Сток
 * инжектируется снаружи на время замера, и всё, что делают инструментированные
 * места, — инкремент в заранее созданное поле. Аллокаций на горячем пути от
 * этого не прибавляется: объектных литералов API не принимает (PERF-3), только
 * `+=` в готовые числа.
 *
 * ## Инертность
 *
 * Сток по умолчанию отсутствует, и тогда учёт НЕ ИСПОЛНЯЕТСЯ: каждое
 * инструментированное место читает `costSink()` один раз на вызов (не на
 * тексель) и при `undefined` не делает ничего — ровно как `countQuery` ядра.
 * Обычный матч не платит за бенчмарк ничем, кроме одного сравнения на границе
 * операции (PERF-3, сценарий «Выключенный учёт бесплатен»).
 *
 * Сток — переменная уровня модуля, устанавливаемая на время замера, а не поле
 * подсистемы: инструментируются в том числе свободные функции и объекты, до
 * которых сборка не дотягивается (`VisibilityMask` живёт и вне подсистемы).
 * Главный поток однопоточный, замер синхронный — переплетения двух стоков,
 * от которого защищается `withDiagnostics` ядра, здесь взяться неоткуда;
 * предыдущее значение всё равно сохраняется и возвращается в `finally`.
 */

/**
 * Стадия конвейера, к которой относится счётчик (PERF-2). Рендер занимает две
 * из объявленных стадий: приём доставки (`syncTick`) и покадровое обновление
 * (`frame`); тик и канал считает воркер-сторона, GPU headless не виден вовсе.
 */
export type CostStage = 'syncTick' | 'frame';

/**
 * Счётчики объёма работы рендера. Все поля — плоские числа, инкрементируемые на
 * месте; ни вложенных структур, ни массивов: структура создаётся один раз на
 * замер и переживает его целиком.
 */
export interface RenderCostCounters {
  // ------------------------------------------------- стадия syncTick: доставка

  /**
   * Доставки presentation-состояния подсистемам (`PresentationStage`): и
   * публикация продюсера, и гашение его набора при смене (REND-11) — обход
   * подсистем один и тот же, и стоит он одинаково.
   */
  syncTickDeliveries: number;
  /** Вызовы `syncTick` подсистем — доставка × число зарегистрированных подсистем. */
  syncTickSubsystems: number;
  /** Инстансы, тронутые доставкой: сущности состояния × подсистемы. */
  syncTickInstances: number;
  /** Инстансы декораций, розданные подсистемам (REND-18). */
  syncTickDecorationInstances: number;
  /**
   * Сущности доставки, просмотренные отбором наблюдателей своей команды
   * (FOW-7, design D4): отбор идёт по всему состоянию, а не по наблюдателям, —
   * стоимость перестройки растёт и от числа сущностей.
   */
  fogEntitiesScanned: number;
  /** Наблюдатели, для которых строился reveal-полигон (FOW-7). */
  fogRevealCalls: number;
  /** Тесты «отрезок укрытия в радиусе наблюдателя» при отборе теней (FOW-9). */
  fogSegmentRangeTests: number;
  /** Укрытия, отобранные в радиус наблюдателя, — суммарно по наблюдателям (FOW-9). */
  fogNearSegments: number;
  /** Тексели маски, обнулённые в начале перестройки (`clear`, design D1). */
  fogMaskClearTexels: number;
  /** Тексели маски, просмотренные reveal-циклом (прямоугольник наблюдателя, FOW-7). */
  fogMaskTexels: number;
  /** Тексели маски, в которые reveal записал свет. */
  fogMaskTexelsWritten: number;
  /** Тесты «субсэмпл × отрезок» теневого покрытия (`litSubsamples`, FOW-9). */
  fogSubsampleTests: number;
  /** Байты растра маски, отданные в `DataTexture` (загрузка на GPU, design D2). */
  fogMaskUploadBytes: number;
  /** Тексели блита маски в канвас слоя миникарты (HUD-6, design D6). */
  fogMinimapTexels: number;

  // ---------------------------------------------------- стадия frame: кадр

  /** Кадры, розданные подсистемам (`PresentationStage.frame`, REND-2). */
  frameCalls: number;
  /** Вызовы `updateFrame` подсистем — кадр × число зарегистрированных подсистем. */
  frameSubsystems: number;
  /** Инстансы, тронутые кадром: живые сущности последней доставки × подсистемы. */
  frameInstances: number;
  /** Проходы рендерера, заказанные подсистемой тумана: прямой и пост (design D2). */
  fogRenderPasses: number;
}

/**
 * Стадия каждого счётчика (PERF-2) — машинно-читаемая атрибуция: отчёт замера
 * группирует счётчики по стадии, а не по догадке о смысле имени. Перечень
 * полный: счётчик без стадии не существует, и тест это стережёт.
 */
export const COST_COUNTER_STAGES: Readonly<Record<keyof RenderCostCounters, CostStage>> =
  Object.freeze({
    syncTickDeliveries: 'syncTick',
    syncTickSubsystems: 'syncTick',
    syncTickInstances: 'syncTick',
    syncTickDecorationInstances: 'syncTick',
    fogEntitiesScanned: 'syncTick',
    fogRevealCalls: 'syncTick',
    fogSegmentRangeTests: 'syncTick',
    fogNearSegments: 'syncTick',
    fogMaskClearTexels: 'syncTick',
    fogMaskTexels: 'syncTick',
    fogMaskTexelsWritten: 'syncTick',
    fogSubsampleTests: 'syncTick',
    fogMaskUploadBytes: 'syncTick',
    fogMinimapTexels: 'syncTick',
    frameCalls: 'frame',
    frameSubsystems: 'frame',
    frameInstances: 'frame',
    fogRenderPasses: 'frame',
  });

/** Свежая структура счётчиков — все поля нулями. Создаётся раз на замер. */
export function createCostCounters(): RenderCostCounters {
  return {
    syncTickDeliveries: 0,
    syncTickSubsystems: 0,
    syncTickInstances: 0,
    syncTickDecorationInstances: 0,
    fogEntitiesScanned: 0,
    fogRevealCalls: 0,
    fogSegmentRangeTests: 0,
    fogNearSegments: 0,
    fogMaskClearTexels: 0,
    fogMaskTexels: 0,
    fogMaskTexelsWritten: 0,
    fogSubsampleTests: 0,
    fogMaskUploadBytes: 0,
    fogMinimapTexels: 0,
    frameCalls: 0,
    frameSubsystems: 0,
    frameInstances: 0,
    fogRenderPasses: 0,
  };
}

let current: RenderCostCounters | undefined;

/**
 * Подключённый сток или `undefined`. Инструментированное место читает его ОДИН
 * раз на вызов и держит в локальной переменной: проверка стока на каждом
 * текселе была бы той самой стоимостью учёта, которой PERF-3 не допускает.
 */
export function costSink(): RenderCostCounters | undefined {
  return current;
}

/**
 * Подключает сток и возвращает предыдущий — для замеров, чьи границы не
 * укладываются в один синхронный вызов (кадры идут циклом планировщика).
 * Снимать обязан вызывающий: `attachCostSink(previous)`.
 */
export function attachCostSink(
  sink: RenderCostCounters | undefined,
): RenderCostCounters | undefined {
  const previous = current;
  current = sink;
  return previous;
}

/**
 * Исполняет тело замера с подключённым стоком. Предыдущее значение
 * возвращается в `finally`: обрыв исключением не должен оставить чужой сток
 * подключённым (то же соображение, что у `withDiagnostics` ядра).
 *
 * Отсутствие стока выражается тем, что этой обёртки нет вовсе, — параметр
 * необязательным не делается намеренно: «замер без стока» не замер.
 */
export function withCostSink<T>(sink: RenderCostCounters, body: () => T): T {
  const previous = current;
  current = sink;
  try {
    return body();
  } finally {
    current = previous;
  }
}
