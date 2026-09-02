/**
 * Поиск пути по сетке террейна (`pathfinding` NAV-7, NAV-8): A* по 4-связности,
 * целые стоимости, манхэттенская эвристика, нормативный tie-break.
 *
 * Ни одного float и ни одного корня здесь нет и быть не может (NAV-2,
 * `determinism-core` CORE-2): стоимость перехода — единица, эвристика —
 * манхэттен в КЛЕТКАХ, приоритет — их целая сумма. Мировые координаты в поиск не
 * входят вовсе; в них переводит найденный коридор сглаживание (NAV-10).
 *
 * ## Аллокаций на запрос нет ни одной
 *
 * `gScore`, `parent`, поколенческие метки и куча живут на экземпляре и
 * переиспользуются между запросами. Очистки массивов между запросами тоже нет:
 * поколение запроса — счётчик, и запись прошлого запроса опознаётся по нему (тот
 * же приём, что у сетки соседей NPC, `systems/npc/grid.ts`). Куча растёт только
 * вверх и только когда её не хватило, то есть после прогрева не растёт вовсе.
 *
 * Наблюдаемым это не делает ничего (NAV-2): переиспользуемые буферы полностью
 * перезаписываются в пределах поколения, и результат запроса остаётся функцией
 * одних лишь аргументов и запечённой сборки.
 */
import { navStepOpen, type NavGrid } from './bake.js';
import type { PathStatus } from '../../types.js';

/** Клетки в куче лежат тройками `[f, g, cell]`. */
const HEAP_STRIDE = 3;

/** Начальная ёмкость кучи в тройках; дальше — удвоение под нужду запроса. */
const HEAP_MIN = 64;

/**
 * Порог, за которым счётчик поколений перезаводится: `Int32Array` хранит метки,
 * и переполнение сделало бы старую запись «свежей». Перезавод стоит одной
 * заливки массивов на два миллиарда запросов.
 */
const GENERATION_MAX = 0x7ffffffe;

/** Родитель стартовой клетки: цепочка коридора кончается на ней. */
const NO_PARENT = -1;

export class NavSearch {
  private readonly nav: NavGrid;
  private readonly width: number;
  private readonly size: number;
  /** Достигнутая стоимость от старта, в переходах (NAV-8). */
  private readonly gScore: Int32Array;
  /** Клетка, из которой пришли; действителен в пределах поколения. */
  private readonly parent: Int32Array;
  /** Поколение, в котором клетка получила стоимость. */
  private readonly seen: Int32Array;
  /** Поколение, в котором клетка РАСКРЫТА (закрыта для повторного раскрытия). */
  private readonly closed: Int32Array;
  private heap: Int32Array;
  /** Байты рабочих структур; пересчитывается только при перевыделении кучи. */
  private bytesValue = 0;
  private heapSize = 0;
  private generation = 0;
  /** Коридор клеток от старта к цели — результат последнего успешного поиска. */
  readonly corridor: Int32Array;
  corridorLength = 0;
  /** Раскрытых узлов последнего запроса — единица бюджета (NAV-5) и стоимости (PERF-3). */
  expansions = 0;

  /**
   * Ёмкость кучи открытых узлов в СЛОТАХ массива (PERF-8) — величина занятого,
   * а не работы. Растёт только перевыделением под нужду запроса (`grow`) и не
   * падает никогда: буфер живёт на экземпляре и переиспользуется между
   * запросами (см. шапку файла). Наружу отдаётся ради записи `TICK_FOOTPRINT`;
   * ход поиска от чтения не меняется (NAV-2).
   */
  get heapCapacity(): number {
    return this.heap.length;
  }

  /**
   * Байты РАБОЧИХ СТРУКТУР поиска (PERF-8): пять массивов по клетке сетки
   * (`gScore`, `parent`, `seen`, `closed`, `corridor`) плюс куча открытых узлов.
   * Куча из них наименьшая и от размера карты не зависит вовсе — по одной её
   * ёмкости рост памяти поиска на большей арене не читался бы ни одним байтом.
   *
   * Величина машинно-независима — это `byteLength` типизированных массивов — и
   * считается ОДИН раз: при создании и при перевыделении кучи. Запрос её только
   * читает: на горячем пути суммирования нет.
   */
  get bytes(): number {
    return this.bytesValue;
  }

  constructor(nav: NavGrid) {
    this.nav = nav;
    this.width = nav.grid.width;
    this.size = nav.grid.width * nav.grid.height;
    this.gScore = new Int32Array(this.size);
    this.parent = new Int32Array(this.size);
    this.seen = new Int32Array(this.size);
    this.closed = new Int32Array(this.size);
    this.corridor = new Int32Array(this.size);
    this.heap = new Int32Array(HEAP_MIN * HEAP_STRIDE);
    this.measure();
  }

  /** Сумма байтов рабочих структур — считается при создании и при регросте. */
  private measure(): void {
    this.bytesValue =
      this.gScore.byteLength +
      this.parent.byteLength +
      this.seen.byteLength +
      this.closed.byteLength +
      this.corridor.byteLength +
      this.heap.byteLength;
  }

  /**
   * Ищет путь от клетки к клетке. `budget` — предел РАСКРЫТИЙ узла (NAV-5), и
   * его исчерпание отличимо от недостижимости самим статусом.
   *
   * Стартовая клетка раскрывается, даже если она непроходима или тесна для
   * запроса: агент в ней уже стоит, и отказ по её собственной проходимости
   * означал бы `unreachable` для всякого, кого прижало к стене (NAV-5). Все
   * остальные клетки проходят полную проверку — пола, зазора и перепада.
   */
  run(from: number, to: number, minClearance: number, budget: number): PathStatus {
    this.beginGeneration();
    this.expansions = 0;
    this.corridorLength = 0;
    this.heapSize = 0;

    this.gScore[from] = 0;
    this.parent[from] = NO_PARENT;
    this.seen[from] = this.generation;
    this.push(this.heuristic(from, to), 0, from);

    while (this.heapSize > 0) {
      const cell = this.pop();
      if (cell < 0) continue;
      if (this.expansions >= budget) return 'budgetExhausted';
      this.expansions++;
      if (cell === to) {
        this.buildCorridor(from, to);
        return 'found';
      }
      this.expand(cell, to, minClearance);
    }
    return 'unreachable';
  }

  /**
   * Соседи клетки в НОРМАТИВНОМ порядке (NAV-8): по возрастанию линейного
   * индекса `y * width + x` — сверху, слева, справа, снизу. Порядок наблюдаем:
   * при равной стоимости он и решает, какой из равных путей вернётся.
   */
  private expand(cell: number, to: number, minClearance: number): void {
    const width = this.width;
    // Остаток неотрицательного делимого на `width ≥ 1` (TERR-2) — DET-2,
    // условие 5; отрицательным делимое не бывает.
    const x = cell % width;
    if (cell >= width) this.relax(cell, cell - width, to, minClearance);
    if (x > 0) this.relax(cell, cell - 1, to, minClearance);
    if (x + 1 < width) this.relax(cell, cell + 1, to, minClearance);
    if (cell + width < this.size) this.relax(cell, cell + width, to, minClearance);
  }

  /**
   * Переход в соседнюю клетку стоимостью в единицу (NAV-8). Родитель
   * переписывается только СТРОГИМ улучшением: путь той же стоимости, пришедший
   * позже, родителя не трогает — этого прямо требует tie-break NAV-8.
   */
  private relax(from: number, to: number, goal: number, minClearance: number): void {
    if (this.closed[to] === this.generation) return;
    if (!navStepOpen(this.nav, from, to, minClearance)) return;
    const tentative = this.gScore[from]! + 1;
    if (this.seen[to] === this.generation && this.gScore[to]! <= tentative) return;
    this.seen[to] = this.generation;
    this.gScore[to] = tentative;
    this.parent[to] = from;
    this.push(tentative + this.heuristic(to, goal), tentative, to);
  }

  /**
   * Манхэттенская эвристика в клетках (NAV-8): на 4-связности с единичной
   * стоимостью перехода она допустима и согласована, поэтому раскрытая клетка
   * уже имеет минимальную стоимость и повторно не раскрывается.
   *
   * DET-2, условия 3 и 5: делимые `cell` и `goal` — линейные индексы клеток,
   * неотрицательные и меньшие площади сетки (та помещается в память, то есть
   * далеко не дотягивает до 2^53); делитель `width` — целое ≥ 1 (TERR-2).
   * Отрицательным делимое не бывает — условие 4 неприменимо.
   */
  private heuristic(cell: number, goal: number): number {
    const width = this.width;
    const dx = (cell % width) - (goal % width);
    const dy = Math.floor(cell / width) - Math.floor(goal / width);
    return Math.abs(dx) + Math.abs(dy);
  }

  /** Коридор клеток: разворачивает цепочку родителей от цели к старту. */
  private buildCorridor(from: number, to: number): void {
    let length = 0;
    for (let cell = to; cell !== NO_PARENT; cell = this.parent[cell]!) {
      this.corridor[length++] = cell;
      if (cell === from) break;
    }
    // Разворот на месте: коридор нужен от старта к цели, а цепочка родителей
    // ведёт обратно. Копии не заводится — буфер и так один на экземпляр.
    for (let head = 0, tail = length - 1; head < tail; head++, tail--) {
      const swap = this.corridor[head]!;
      this.corridor[head] = this.corridor[tail]!;
      this.corridor[tail] = swap;
    }
    this.corridorLength = length;
  }

  /**
   * Новое поколение запроса. Заливка массивов — только на переполнении счётчика:
   * поколение и заведено затем, чтобы её не делать (NAV-2 это ненаблюдаемо).
   */
  private beginGeneration(): void {
    if (this.generation >= GENERATION_MAX) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.generation = 0;
    }
    this.generation++;
  }

  // ------------------------------------------------------------ куча запроса
  //
  // Двоичная куча на `Int32Array` тройками `[f, g, cell]`. Ключ сравнения —
  // тот самый порядок, который NAV-8 объявляет нормативным: меньший приоритет
  // `f`, при равенстве — БОЛЬШАЯ достигнутая стоимость `g`, при равенстве и её
  // — меньший линейный индекс клетки. Стоимость хранится в самой записи, а не
  // читается из `gScore`: улучшенная позже клетка иначе меняла бы ключ уже
  // лежащей в куче записи, и порядок раскрытия перестал бы быть функцией
  // аргументов.

  private push(f: number, g: number, cell: number): void {
    if ((this.heapSize + 1) * HEAP_STRIDE > this.heap.length) this.grow();
    const heap = this.heap;
    let index = this.heapSize++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const base = parent * HEAP_STRIDE;
      if (!NavSearch.before(f, g, cell, heap[base]!, heap[base + 1]!, heap[base + 2]!)) break;
      NavSearch.copy(heap, parent, index);
      index = parent;
    }
    NavSearch.write(heap, index, f, g, cell);
  }

  /**
   * Снимает корень. Возвращает `-1` для УСТАРЕВШЕЙ записи — той, чья клетка уже
   * раскрыта или уже достигнута дешевле: ленивое удаление дешевле поиска записи
   * в куче, а раскрытием такая запись не становится и бюджета не тратит.
   */
  private pop(): number {
    const heap = this.heap;
    const g = heap[1]!;
    const cell = heap[2]!;
    this.heapSize--;
    if (this.heapSize > 0) {
      NavSearch.copy(heap, this.heapSize, 0);
      this.sink();
    }
    if (this.closed[cell] === this.generation) return -1;
    if (this.gScore[cell]! < g) return -1;
    this.closed[cell] = this.generation;
    return cell;
  }

  private sink(): void {
    const heap = this.heap;
    const size = this.heapSize;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= size) break;
      const right = left + 1;
      let best = left;
      if (
        right < size &&
        NavSearch.before(
          heap[right * HEAP_STRIDE]!,
          heap[right * HEAP_STRIDE + 1]!,
          heap[right * HEAP_STRIDE + 2]!,
          heap[left * HEAP_STRIDE]!,
          heap[left * HEAP_STRIDE + 1]!,
          heap[left * HEAP_STRIDE + 2]!,
        )
      ) {
        best = right;
      }
      if (
        !NavSearch.before(
          heap[best * HEAP_STRIDE]!,
          heap[best * HEAP_STRIDE + 1]!,
          heap[best * HEAP_STRIDE + 2]!,
          heap[index * HEAP_STRIDE]!,
          heap[index * HEAP_STRIDE + 1]!,
          heap[index * HEAP_STRIDE + 2]!,
        )
      ) {
        break;
      }
      NavSearch.swap(heap, best, index);
      index = best;
    }
  }

  private grow(): void {
    const grown = new Int32Array(this.heap.length * 2);
    grown.set(this.heap);
    this.heap = grown;
    this.measure();
  }

  /** Ключ NAV-8: `f` меньше, затем `g` БОЛЬШЕ, затем индекс клетки меньше. */
  private static before(
    fa: number,
    ga: number,
    ca: number,
    fb: number,
    gb: number,
    cb: number,
  ): boolean {
    if (fa !== fb) return fa < fb;
    if (ga !== gb) return ga > gb;
    return ca < cb;
  }

  private static write(heap: Int32Array, slot: number, f: number, g: number, cell: number): void {
    const base = slot * HEAP_STRIDE;
    heap[base] = f;
    heap[base + 1] = g;
    heap[base + 2] = cell;
  }

  private static copy(heap: Int32Array, from: number, to: number): void {
    const source = from * HEAP_STRIDE;
    NavSearch.write(heap, to, heap[source]!, heap[source + 1]!, heap[source + 2]!);
  }

  private static swap(heap: Int32Array, a: number, b: number): void {
    const base = a * HEAP_STRIDE;
    const f = heap[base]!;
    const g = heap[base + 1]!;
    const cell = heap[base + 2]!;
    NavSearch.copy(heap, b, a);
    NavSearch.write(heap, b, f, g, cell);
  }
}
