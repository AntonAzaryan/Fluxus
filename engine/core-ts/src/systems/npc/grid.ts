/**
 * Равномерная сетка по ДИНАМИЧЕСКИМ агентам (`npc-behavior` NPC-6): выборка
 * соседей за время, растущее числом соседей, а не квадратом числа агентов.
 * Полного перебора пар агентов здесь нет и быть не должно — именно его NPC-6
 * запрещает.
 *
 * ## Почему это не broad-phase физики
 *
 * `physics` PHYS-5 прямо запрещает индексировать динамику в своей сетке, и
 * основание там весомое: `Position` вправе писать любая система, поэтому
 * индекс, снятый в начале тика, к моменту запроса ИЗ ДРУГОЙ СИСТЕМЫ может не
 * соответствовать миру. Здесь этого класса ошибки нет по построению: сетка
 * наполняется и опрашивается ВНУТРИ одного прогона одной системы, между
 * наполнением и запросом мир не меняется (мутации идут через Command Buffer и
 * применяются на flush после системы, CMD-2), и пережить тик она не может —
 * состоянием симуляции не является и в снапшот не входит. Ровно это и
 * нормирует NPC-6.
 *
 * ## Аллокаций на тик нет ни одной
 *
 * Все буферы живут на экземпляре и переиспользуются; растут они только когда
 * растёт сам мир, а не каждый тик. Отображение «клетка → цепочка» — открытая
 * адресация в типизированных массивах, а не `Map`: у карты каждая занятая
 * клетка стоила бы записи на КАЖДОМ наполнении, то есть аллокации,
 * пропорциональной числу агентов, — ровно того, что аллокационная дисциплина
 * ядра запрещает на горячем пути тика. Очистки таблицы тоже нет: поколение
 * наполнения — счётчик, и запись прошлого наполнения опознаётся по нему.
 */
import { distSqLe } from '../../math/fixed.js';
import { countCostNpcNeighbors } from '../../debug.js';
import type { Fixed } from '../../types.js';

/** Пустой список — голова цепочки клетки, в которой никого нет. */
const EMPTY = -1;

/** Множитель перемешивания ключа клетки: нечётный, с хорошо размазанными битами. */
const MIX = 0x9e3779b1;

/** Минимальная ёмкость таблицы клеток; дальше — степень двойки над числом записей. */
const MIN_BUCKETS = 64;

/** Буфер кадра до первого запроса: своего у сетки нет, он всегда приходит извне. */
const EMPTY_OUT = new Int32Array(0);

export class NpcGrid {
  private readonly cellSize: Fixed;
  private xs: Int32Array;
  private ys: Int32Array;
  /** Следующий элемент цепочки своей клетки либо `EMPTY`. */
  private next: Int32Array;
  /** Ключ клетки, лежащей в этой ячейке таблицы. */
  private bucketKey: Int32Array;
  /** Голова цепочки этой клетки. */
  private bucketHead: Int32Array;
  /** Поколение наполнения, в котором ячейка занята; иначе она свободна. */
  private bucketStamp: Int32Array;
  private mask: number;
  private generation = 0;
  /** Осмотренные кандидаты последнего запроса — счётчик стоимости (PERF-3). */
  private examined = 0;
  /** Предел осмотра текущего запроса; ставит его вызывающий (NPC-6). */
  private budget = 0;
  /** Кадр текущего запроса: буфер вызывающего и число собранного в нём. */
  private out: Int32Array = EMPTY_OUT;
  private found = 0;

  constructor(cellSize: Fixed, capacity = 32) {
    this.cellSize = cellSize;
    this.xs = new Int32Array(capacity);
    this.ys = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
    const buckets = MIN_BUCKETS;
    this.bucketKey = new Int32Array(buckets);
    this.bucketHead = new Int32Array(buckets);
    this.bucketStamp = new Int32Array(buckets);
    this.mask = buckets - 1;
  }

  /**
   * Клетка по мировой координате. `floor`, а не усечение к нулю: арена бывает
   * левее и ниже начала координат, а наполнение и запрос обязаны пользоваться
   * ОДНИМ отображением — тогда сосед лежит в той клетке, в которой его ищут,
   * при любой конвенции (то же рассуждение, что в broad-phase статики).
   */
  private cell(coordinate: Fixed): number {
    return Math.floor(coordinate / this.cellSize);
  }

  /**
   * Ключ клетки: пара координат, упакованная в i32 по 16 бит на ось. Клетки,
   * отстоящие на 65536 друг от друга, делят ключ — на арене такой дистанции не
   * бывает, а если бы была, ответ остался бы верным: кандидат всё равно
   * проверяется расстоянием, и совпадение ключа лишь добавило бы осмотренных.
   */
  private static key(cx: number, cy: number): number {
    return ((cx & 0xffff) << 16) | (cy & 0xffff);
  }

  /**
   * Ячейка таблицы под этот ключ: своя либо первая свободная по линейному
   * пробированию. Коэффициент заполнения держится не выше половины, поэтому
   * цепочка проб коротка, а бесконечной она быть не может по построению.
   */
  private bucket(key: number): number {
    let index = (Math.imul(key, MIX) >>> 16) & this.mask;
    while (this.bucketStamp[index] === this.generation && this.bucketKey[index] !== key) {
      index = (index + 1) & this.mask;
    }
    return index;
  }

  /** Готовит сетку к наполнению на `expected` записей; буферы растут только вверх. */
  begin(expected: number): void {
    if (expected > this.xs.length) {
      // Рост — не на каждый тик, а на каждое расширение мира: ёмкость
      // удваивается, поэтому число расширений логарифмично числу агентов.
      let capacity = this.xs.length;
      while (capacity < expected) capacity *= 2;
      this.xs = new Int32Array(capacity);
      this.ys = new Int32Array(capacity);
      this.next = new Int32Array(capacity);
    }
    // Занятых клеток не больше, чем записей; вдвое больший стол держит пробы
    // короткими.
    let buckets = MIN_BUCKETS;
    while (buckets < expected * 2) buckets *= 2;
    if (buckets > this.bucketKey.length) {
      this.bucketKey = new Int32Array(buckets);
      this.bucketHead = new Int32Array(buckets);
      this.bucketStamp = new Int32Array(buckets);
      this.mask = buckets - 1;
      // Свежая таблица занята нулями, а поколение с них и начинается: сдвигаем
      // счётчик, чтобы ни одна ячейка не выглядела занятой этим наполнением.
      this.generation = 0;
    }
    this.generation++;
  }

  /** Кладёт запись с индексом `slot` (позиция в выборке вызывающего) в её клетку. */
  add(slot: number, x: Fixed, y: Fixed): void {
    this.xs[slot] = x;
    this.ys[slot] = y;
    const key = NpcGrid.key(this.cell(x), this.cell(y));
    const index = this.bucket(key);
    if (this.bucketStamp[index] !== this.generation) {
      this.bucketStamp[index] = this.generation;
      this.bucketKey[index] = key;
      this.bucketHead[index] = EMPTY;
    }
    this.next[slot] = this.bucketHead[index]!;
    this.bucketHead[index] = slot;
  }

  /**
   * Индексы соседей в радиусе, кроме `self`: кладутся в `out`, возвращается их
   * число.
   *
   * Ограничены ОБЕ величины (NPC-6). Собранные соседи — размером `out`: буфер
   * принадлежит вызывающему, и молчаливого роста в горячем цикле не бывает.
   * ОСМОТРЕННЫЕ — параметром `budget`, и в них входят и звенья цепочек, и сами
   * пробы клеток: клеток в развёртке радиуса квадратично много, а кандидат,
   * отброшенный радиусом, собранным не становится, — предел, считающий одних
   * собранных, поэтому не был бы пределом работы вовсе.
   *
   * Осмотренные уходят в счётчики стоимости тика (PERF-3) СВОИМ счётчиком:
   * работа сетки агентов и работа broad-phase физики — разные величины, и
   * складывать их в одну значило бы прятать регрессию одной за шумом другой
   * (NPC-9).
   */
  neighbors(
    self: number,
    x: Fixed,
    y: Fixed,
    radius: Fixed,
    out: Int32Array,
    budget: number,
  ): number {
    this.examined = 0;
    this.budget = budget;
    this.found = 0;
    this.out = out;
    const centerX = this.cell(x);
    const centerY = this.cell(y);
    const rings = this.cell(radius + this.cellSize) - this.cell(0);
    for (let ring = 0; ring <= rings; ring++) {
      if (!this.sweepRing(ring, centerX, centerY, self, x, y, radius)) break;
    }
    countCostNpcNeighbors(this.examined);
    return this.found;
  }

  /**
   * Клетки на чебышёвском расстоянии `ring` от центральной, в фиксированном
   * порядке. Кольцами наружу, а не строкой развёртки, ровно ради предела
   * осмотра: исчерпав его, запрос теряет САМЫЕ ДАЛЬНИЕ клетки, а не случайный
   * угол области, — то есть вырождается в поиск в меньшем радиусе, а не в
   * поиск не там. Возвращает `false`, когда идти дальше незачем.
   */
  private sweepRing(
    ring: number,
    centerX: number,
    centerY: number,
    self: number,
    x: Fixed,
    y: Fixed,
    radius: Fixed,
  ): boolean {
    if (ring === 0) return this.sweepCell(centerX, centerY, self, x, y, radius);
    for (let dx = -ring; dx <= ring; dx++) {
      if (!this.sweepCell(centerX + dx, centerY - ring, self, x, y, radius)) return false;
      if (!this.sweepCell(centerX + dx, centerY + ring, self, x, y, radius)) return false;
    }
    for (let dy = -ring + 1; dy <= ring - 1; dy++) {
      if (!this.sweepCell(centerX - ring, centerY + dy, self, x, y, radius)) return false;
      if (!this.sweepCell(centerX + ring, centerY + dy, self, x, y, radius)) return false;
    }
    return true;
  }

  /** Одна клетка кольца: проба и её цепочка. `false` — предел исчерпан. */
  private sweepCell(
    cx: number,
    cy: number,
    self: number,
    x: Fixed,
    y: Fixed,
    radius: Fixed,
  ): boolean {
    // Проба клетки — тоже осмотр: клеток в развёртке радиуса квадратично много,
    // и не считать их значило бы обещать предел, которого нет.
    this.examined++;
    if (this.examined >= this.budget) return false;
    this.found = this.collectCell(cx, cy, self, x, y, radius, this.out, this.found);
    return this.found < this.out.length && this.examined < this.budget;
  }

  /**
   * Цепочка одной клетки: слоты в радиусе дописываются в `out`, обход
   * прерывается на заполнении буфера — предел выборки принадлежит вызывающему.
   * Отдельным методом, а не третьим вложенным циклом: глубина вложенности —
   * ранний признак того, что цикл пора называть по имени.
   */
  private collectCell(
    cx: number,
    cy: number,
    self: number,
    x: Fixed,
    y: Fixed,
    radius: Fixed,
    out: Int32Array,
    from: number,
  ): number {
    const index = this.bucket(NpcGrid.key(cx, cy));
    if (this.bucketStamp[index] !== this.generation) return from;
    let found = from;
    let slot = this.bucketHead[index]!;
    while (slot !== EMPTY && found < out.length && this.examined < this.budget) {
      this.examined++;
      const nextSlot = this.next[slot]!;
      if (slot !== self && distSqLe(this.xs[slot]! - x, this.ys[slot]! - y, radius)) {
        out[found] = slot;
        found++;
      }
      slot = nextSlot;
    }
    return found;
  }

  /** Координата записи — читается вызывающим по индексу соседа. */
  xAt(slot: number): Fixed {
    return this.xs[slot]!;
  }

  yAt(slot: number): Fixed {
    return this.ys[slot]!;
  }
}
