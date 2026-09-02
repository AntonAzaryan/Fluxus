/**
 * Помощник сторожей памяти (`performance-budget` PERF-10, PERF-11) — рядом с
 * калибровкой машины (`calibration.ts`) и по той же логике: механизм здесь,
 * пороги и нагрузки — в тестах.
 *
 * ## Что здесь есть и зачем
 *
 * - `forceGc()` и `sampleMemory()` — проба ЗАНЯТОЙ памяти после принудительной
 *   полной сборки: то, что удержано (PERF-10). Мусор, ещё не собранный, такая
 *   проба стирает по построению — в этом и смысл;
 * - `observeGc()` и `allocationWindow()` — проба ПОРОЖДЁННОГО мусора между
 *   сборками (PERF-11): число малых сборок за прогон и байты, занятые окном
 *   тиков, внутри которого сборщик не сработал ни разу.
 *
 * Два прибора смотрят на одну кучу в противоположных фазах, и один без другого
 * слеп на половину: сборка перед пробой стирает мусор, а окно без сборки не
 * отличает удержанное от временного.
 *
 * ## Почему флаг включается на лету
 *
 * `--expose-gc` командной строкой пришлось бы прописывать в конфиг раннера, то
 * есть всем прогонам сразу — и попакетным, и гейту. `v8.setFlagsFromString`
 * включает его на время вызова прямо здесь, а функцию сборки даёт
 * `vm.runInNewContext('gc')`: работает и в worker thread, и в fork, и конфиг
 * vitest от сторожей не зависит вовсе.
 *
 * ## Чего эти числа НЕ являются
 *
 * Эталоном (PERF-10, PERF-11): байты кучи и число сборок зависят от версии
 * среды исполнения и размера её молодого поколения, а не только от кода.
 * Ассертить их уровень нельзя ни в каком виде — только РОСТ между точками
 * устоявшегося состояния и только на порядок. Точный учёт того, чем движок
 * владеет сам, остаётся за PERF-8 и PERF-9.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';
import { PerformanceObserver, constants, type PerformanceEntry } from 'node:perf_hooks';

/** Проба занятой памяти: куча изолята и байты буферов вне неё. */
export interface MemorySample {
  /** Байты кучи среды исполнения ЭТОГО изолята после полной сборки. */
  readonly heapUsed: number;
  /** Байты `ArrayBuffer`'ов — колонки мира, буферы канала, растры маски. */
  readonly arrayBuffers: number;
}

/** Рост между двумя пробами — и абсолютный, и отнесённый к началу окна. */
export interface MemoryGrowth {
  readonly heapUsed: number;
  readonly arrayBuffers: number;
  /**
   * Рост ЗАНЯТОЙ ПАМЯТИ, отнесённый к занятой памяти в НАЧАЛЕ окна. Ассертится
   * именно он (PERF-10): уровень — функция среды исполнения, отношение — нет.
   *
   * Занятая память здесь — куча ПЛЮС байты буферов, обе величины, которые
   * называет требование. Одной кучи мало: колонки мира, буферы канала и растры
   * маски живут в `ArrayBuffer`'ах ВНЕ кучи изолята, и утечка типизированного
   * массива в куче почти не видна — она видна в буферах.
   */
  readonly ratio: number;
}

let collect: (() => void) | undefined;

/**
 * Функция принудительной сборки. Флаг снимается сразу же: включённый
 * `--expose-gc` — это глобальный `gc()` в каждом модуле процесса, а он здесь
 * нужен ровно этому помощнику.
 */
function gcFunction(): () => void {
  if (collect !== undefined) return collect;
  setFlagsFromString('--expose-gc');
  try {
    collect = runInNewContext('gc') as () => void;
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
  return collect;
}

/**
 * Сколько раз подряд зовётся сборка. Дважды, а не единожды: первый проход
 * оставляет объекты, ставшие недостижимыми ИМЕННО в нём (цепочки, слабые
 * колбэки), и одиночная сборка систематически завышала бы пробу.
 */
const GC_PASSES = 2;

/** Принудительная полная сборка мусора — перед каждой пробой занятой памяти. */
export function forceGc(): void {
  const gc = gcFunction();
  for (let i = 0; i < GC_PASSES; i++) gc();
}

/** Проб в одном замере: берётся МИНИМУМ — дрожание умеет только завысить. */
const SAMPLES = 3;

/**
 * Занятая память после полной сборки. Минимум из нескольких проб, каждой со
 * своей сборкой: та же логика, что у калибровки машины — планировщик и сборщик
 * умеют сделать пробу только больше, никогда меньше, поэтому минимум и есть
 * самая устойчивая оценка.
 */
export function sampleMemory(): MemorySample {
  let heapUsed = Number.POSITIVE_INFINITY;
  let arrayBuffers = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SAMPLES; i++) {
    forceGc();
    const usage = process.memoryUsage();
    if (usage.heapUsed < heapUsed) heapUsed = usage.heapUsed;
    if (usage.arrayBuffers < arrayBuffers) arrayBuffers = usage.arrayBuffers;
  }
  return { heapUsed, arrayBuffers };
}

/** Рост между пробами. Отношение считается к НАЧАЛУ окна (PERF-10). */
export function growthOf(before: MemorySample, after: MemorySample): MemoryGrowth {
  const heapUsed = after.heapUsed - before.heapUsed;
  const arrayBuffers = after.arrayBuffers - before.arrayBuffers;
  const occupied = before.heapUsed + before.arrayBuffers;
  return {
    heapUsed,
    arrayBuffers,
    ratio: occupied > 0 ? (heapUsed + arrayBuffers) / occupied : 0,
  };
}

/** Мегабайты пробы — для печати `[bench]`, а не для ассерта. */
export function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} МиБ`;
}

// ------------------------------------------- давление на сборщик (PERF-11)

/** Сборки по виду за окно наблюдения. */
export interface GcCounts {
  /** Малые сборки молодого поколения (scavenge) — главная величина PERF-11. */
  minor: number;
  /** Полные сборки: на устоявшемся режиме их единицы, и растут они иначе. */
  major: number;
  incremental: number;
  weakCallback: number;
  total: number;
}

/** Наблюдатель событий сборщика: считает записи по виду в заранее созданные поля. */
export interface GcWatch {
  /**
   * Снимает накопленное. Записи `gc` приезжают ЧЕРЕЗ ЦИКЛ СОБЫТИЙ, а не
   * синхронно из тела тика, поэтому окно закрывается одним оборотом цикла и
   * `takeRecords()` до чтения — иначе синхронный цикл тиков не увидел бы своих
   * же сборок.
   */
  take(): Promise<GcCounts>;
  /** Отключает наблюдателя: чужих сборок в своё окно он считать не должен. */
  stop(): void;
}

function zeroCounts(): GcCounts {
  return { minor: 0, major: 0, incremental: 0, weakCallback: 0, total: 0 };
}

/** Вид сборки записи наблюдателя; `detail` типизирован средой как деталь GC. */
function countEntry(counts: GcCounts, entry: PerformanceEntry): void {
  const kind = (entry as { detail?: { kind?: number } }).detail?.kind;
  counts.total++;
  if (kind === constants.NODE_PERFORMANCE_GC_MINOR) counts.minor++;
  else if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) counts.major++;
  else if (kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) counts.incremental++;
  else if (kind === constants.NODE_PERFORMANCE_GC_WEAKCB) counts.weakCallback++;
}

/**
 * Наблюдатель событий сборщика на время одного окна. Заводится и отключается
 * ВНУТРИ теста: соседние файлы того же изолята идут своим чередом, и их сборки
 * в чужое окно попадать не должны.
 */
export function observeGc(): GcWatch {
  const counts = zeroCounts();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) countEntry(counts, entry);
  });
  observer.observe({ entryTypes: ['gc'] });
  return {
    take: async (): Promise<GcCounts> => {
      await tick();
      for (const entry of observer.takeRecords()) countEntry(counts, entry);
      return { ...counts };
    },
    stop: (): void => {
      observer.disconnect();
    },
  };
}

/** Результат поиска окна тиков без сборки (PERF-11). */
export interface AllocationWindow {
  /** Нашлось ли окно, внутри которого сборщик не сработал ни разу. */
  readonly found: boolean;
  /** Ширина окна в тиках — она укорачивается вдвое на каждой неудачной попытке. */
  readonly ticks: number;
  /**
   * Байты, занятые окном; при `found: false` числом не является.
   *
   * Считается куча ПЛЮС байты буферов — по той же причине, по какой их считает
   * вместе `growthOf`: подложки типизированных массивов живут ВНЕ кучи изолята,
   * и мусор, состоящий из них (колонка мира, буфер канала, растр на сущность),
   * по одной куче был бы невидим вовсе.
   */
  readonly bytes: number;
  /** Сборок внутри последнего окна: при `found: true` — ноль по построению. */
  readonly collections: number;
  readonly attempts: number;
}

/** Сколько раз окно укорачивается вдвое, прежде чем сторож скажет «не нашлось». */
const WINDOW_ATTEMPTS = 5;

/** Занятое СЕЙЧАС, без сборки: куча изолята плюс байты буферов вне неё. */
function occupied(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/**
 * Байты, занятые окном тиков, ВНУТРИ которого сборщик не сработал ни разу
 * (PERF-11): принудительная сборка (чистое молодое поколение), затем `ticks`
 * тиков синхронно, затем оборот цикла событий и чтение записей наблюдателя.
 *
 * Сборка внутри окна делает разность бессмысленной — она стёрла бы часть
 * порождённого, — поэтому окно укорачивается вдвое и попытка повторяется. Не
 * нашлось за `WINDOW_ATTEMPTS` попыток — результат так и говорит, а не выдаёт
 * ноль за измеренное: тик, аллоцирующий больше молодого поколения, сам по себе
 * читается как давление на сборщик, и сторож печатает это прямо.
 */
export async function allocationWindow(
  run: (ticks: number) => void,
  ticks: number,
  attempts: number = WINDOW_ATTEMPTS,
): Promise<AllocationWindow> {
  let width = ticks;
  let collections = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Сборка ДО наблюдателя: её собственные события окну не принадлежат.
    forceGc();
    const watch = observeGc();
    const before = occupied();
    run(width);
    const after = occupied();
    const counts = await watch.take();
    watch.stop();
    collections = counts.total;
    if (collections === 0) {
      return { found: true, ticks: width, bytes: after - before, collections: 0, attempts: attempt };
    }
    width = Math.max(1, Math.floor(width / 2));
  }
  return { found: false, ticks: width, bytes: 0, collections, attempts };
}
