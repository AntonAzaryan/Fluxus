/**
 * Грязное окно рассеивания маски тумана (FOW-7, design D5 change
 * `fog-mask-budgeted-rebuild`) — блочная сетка над растром и проход схождения по
 * ней.
 *
 * Зачем окно: показанная маска догоняет целевую не мгновенно, и до этой правки
 * КАЖДЫЙ кадр рассеивания шёл по всему растру — вместе с загрузкой текстуры и
 * блитом миникарты. После скачка обзора (смена уровня наблюдателя) окно держится
 * секунды, и всё это время кадр платил полную цену разрешения маски. Здесь оно
 * ограничено блоками, в которых показанная маска реально не сошлась с целевой:
 * работа кадра пропорциональна неустоявшейся области, а устоявшаяся сцена платит
 * ноль.
 */
import { costSink } from '../cost.js';

/**
 * Сторона блока окна, тексели. Шестнадцать — компромисс сетки: набор флагов на
 * дуэльную маску 384×384 умещается в 576 байт, а блок при этом достаточно мелок,
 * чтобы окно сжималось по мере схождения, а не держало весь растр.
 */
const FOG_DIRTY_BLOCK = 16;

/**
 * Прямоугольник растра маски в текселях, границы ВКЛЮЧИТЕЛЬНЫЕ; пустой —
 * `x1 < x0`. Накопленное окно блита миникарты живёт в такой форме: блит идёт
 * каденсом, а не каждым кадром рассеивания, и прямоугольник объединяет окна
 * кадров, прошедших с последнего блита.
 */
export interface FogTexelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Пустой прямоугольник на месте: следующий `unionInto` начнёт с чистого листа. */
function resetTexelRect(rect: FogTexelRect): void {
  rect.x0 = Number.MAX_SAFE_INTEGER;
  rect.y0 = Number.MAX_SAFE_INTEGER;
  rect.x1 = -1;
  rect.y1 = -1;
}

/**
 * Каденс блита слоя миникарты в окне рассеивания, секунды мирового времени.
 * Кадр рассеивания ведёт показанную маску и её текстуру ПОКАДРОВО — картинку
 * основного вида каденс не трогает, — а канвас миникарты перерисовывается не
 * чаще этого шага: на высоком fps попиксельный блит и `putImageData` каждый
 * кадр были заметной долей просадки при скачке обзора, притом что поверхность
 * миникарты мельче кадра на порядок (HUD-6 точности основного вида там не
 * требует). Детерминизм счётчиков не задет: каденс считается от доставленного
 * `dt`, а не от часов машины (PERF-3).
 */
const FOG_MINIMAP_BLIT_SECONDS = 1 / 30;

/**
 * Накопитель окна блита миникарты между кадрами каденса: окна пропущенных
 * кадров объединяются прямоугольником, и очередной блит переписывает его
 * целиком — последнее значение каждого когда-либо грязного блока доезжает в
 * канвас всегда. Финальный блит по схождении окна решает вызывающий: окно
 * кончилось — блит обязателен независимо от каденса.
 */
export class FogBlitCadence {
  private readonly pending: FogTexelRect = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private due = 0;

  constructor() {
    resetTexelRect(this.pending);
  }

  /** Окно, накопленное с прошлого блита, — аргумент оконного блита слоя. */
  get region(): FogTexelRect {
    return this.pending;
  }

  /** Свежее окно рассеивания: первый его кадр блитует немедленно. */
  prime(): void {
    this.due = FOG_MINIMAP_BLIT_SECONDS;
  }

  /** Блит случился (оконный или полный) — накопление с чистого листа. */
  reset(): void {
    resetTexelRect(this.pending);
    this.due = 0;
  }

  /**
   * Окно кадра — в накопитель, время кадра — в счёт каденса; `true` — каденс
   * набран, пора блитовать. Зовётся ДО `flushSettled`: блок, устоявшийся в
   * этом кадре, обязан попасть в ближайший блит последним своим значением.
   */
  advance(dirty: FogDirtyBlocks, elapsed: number): boolean {
    dirty.unionInto(this.pending);
    this.due += elapsed;
    return this.due >= FOG_MINIMAP_BLIT_SECONDS;
  }
}

/**
 * Набор блоков, в которых показанная маска ещё не сошлась с целевой.
 *
 * Блоки снимаются с набора ДВУМЯ шагами (`settle` → `flushSettled`): окно
 * кадра уходит в накопленный прямоугольник блита ПОСЛЕ прохода схождения, и
 * блок, снятый прямо в проходе, не доехал бы в канвас последним своим
 * значением.
 */
export class FogDirtyBlocks {
  readonly cols: number;
  readonly rows: number;
  /** Размер растра в текселях — правая и верхняя границы неполных блоков. */
  private readonly width: number;
  private readonly height: number;
  private readonly flags: Uint8Array;
  /** Блоки, устоявшиеся в текущем проходе; снимаются `flushSettled`. */
  private readonly settled: Int32Array;
  private settledCount = 0;
  private live = 0;

  constructor(width: number, height: number) {
    this.cols = Math.max(1, Math.ceil(width / FOG_DIRTY_BLOCK));
    this.rows = Math.max(1, Math.ceil(height / FOG_DIRTY_BLOCK));
    this.width = width;
    this.height = height;
    this.flags = new Uint8Array(this.cols * this.rows);
    this.settled = new Int32Array(this.flags.length);
  }

  /** Блоков в наборе; ноль — рассеивание сошлось. */
  get count(): number {
    return this.live;
  }

  get empty(): boolean {
    return this.live === 0;
  }

  clear(): void {
    this.flags.fill(0);
    this.live = 0;
    this.settledCount = 0;
  }

  isDirty(column: number, row: number): boolean {
    return this.flags[row * this.cols + column] === 1;
  }

  /** Блок устоялся в текущем проходе — снимется после блита (`flushSettled`). */
  settle(column: number, row: number): void {
    this.settled[this.settledCount++] = row * this.cols + column;
  }

  /**
   * Объединяет тексельный bbox ТЕКУЩЕГО набора блоков в прямоугольник —
   * накопление окна блита миникарты между кадрами каденса. Зовётся ДО
   * `flushSettled`: блок, устоявшийся в этом кадре, обязан попасть в ближайший
   * блит последним своим значением.
   */
  unionInto(rect: FogTexelRect): void {
    if (this.live === 0) return;
    for (let row = 0; row < this.rows; row++) {
      const y0 = row * FOG_DIRTY_BLOCK;
      const y1 = Math.min(y0 + FOG_DIRTY_BLOCK, this.height) - 1;
      for (let column = 0; column < this.cols; column++) {
        if (this.flags[row * this.cols + column] !== 1) continue;
        const x0 = column * FOG_DIRTY_BLOCK;
        const x1 = Math.min(x0 + FOG_DIRTY_BLOCK, this.width) - 1;
        if (x0 < rect.x0) rect.x0 = x0;
        if (x1 > rect.x1) rect.x1 = x1;
        if (y0 < rect.y0) rect.y0 = y0;
        if (y1 > rect.y1) rect.y1 = y1;
      }
    }
  }

  /** Снимает с набора блоки, устоявшиеся с прошлого `flushSettled`. */
  flushSettled(): void {
    for (let i = 0; i < this.settledCount; i++) {
      const at = this.settled[i]!;
      if (this.flags[at] === 1) {
        this.flags[at] = 0;
        this.live--;
      }
    }
    this.settledCount = 0;
  }

  /**
   * Блоки, различающиеся у двух растров, — в набор (design D5). Уже грязный
   * блок не сравнивается вовсе: он остаётся в наборе при любом исходе, и это
   * ровно то объединение с неустоявшимися блоками прошлого окна, которого
   * требует прерванное рассеивание.
   *
   * Возвращает число сравнённых текселей — объём работы разметки (PERF-3).
   */
  markChanged(previous: Uint8Array, next: Uint8Array, width: number, height: number): number {
    let compared = 0;
    for (let row = 0; row < this.rows; row++) {
      const y0 = row * FOG_DIRTY_BLOCK;
      const y1 = Math.min(y0 + FOG_DIRTY_BLOCK, height);
      for (let column = 0; column < this.cols; column++) {
        const at = row * this.cols + column;
        if (this.flags[at] === 1) continue;
        const x0 = column * FOG_DIRTY_BLOCK;
        const x1 = Math.min(x0 + FOG_DIRTY_BLOCK, width);
        compared += (y1 - y0) * (x1 - x0);
        if (!differs(previous, next, width, x0, x1, y0, y1)) continue;
        this.flags[at] = 1;
        this.live++;
      }
    }
    return compared;
  }
}

/**
 * 32-битные виды растров для пословного сравнения в `differs`. Кэш по буферу:
 * маска живёт двойным буфером со свопом ссылок, видов ровно два на подсистему,
 * и заводить их на каждую публикацию было бы аллокацией в горячем пути.
 */
const WORD_VIEWS = new WeakMap<Uint8Array, Uint32Array>();

function wordsOf(raster: Uint8Array): Uint32Array {
  let view = WORD_VIEWS.get(raster);
  if (view === undefined) {
    view = new Uint32Array(raster.buffer, raster.byteOffset, raster.byteLength >> 2);
    WORD_VIEWS.set(raster, view);
  }
  return view;
}

/**
 * Различаются ли растры в прямоугольнике [x0, x1) × [y0, y1).
 *
 * Быстрый путь сравнивает по четыре текселя словом: разметка окна на публикации
 * идёт по ВСЕМУ ещё чистому растру (`markChanged`), и побайтовый обход был
 * заметной долей кадра публикации. Равенство слов не зависит от порядка байтов
 * машины — детерминизм разметки не задет (PERF-3). Кромочные блоки с границами
 * не по слову сравниваются как раньше, побайтово.
 */
function differs(
  previous: Uint8Array,
  next: Uint8Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): boolean {
  if ((width & 3) === 0 && (x0 & 3) === 0 && ((x1 - x0) & 3) === 0 && (previous.byteOffset & 3) === 0 && (next.byteOffset & 3) === 0) {
    const p = wordsOf(previous);
    const n = wordsOf(next);
    const rowWords = width >> 2;
    const from = x0 >> 2;
    const count = (x1 - x0) >> 2;
    for (let y = y0; y < y1; y++) {
      const row = y * rowWords + from;
      for (let i = 0; i < count; i++) {
        if (p[row + i] !== n[row + i]) return true;
      }
    }
    return false;
  }
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      if (previous[row + x] !== next[row + x]) return true;
    }
  }
  return false;
}

/**
 * Проход схождения показанной маски к целевой по грязным блокам (FOW-7): шаг
 * `step` градаций за кадр, открытие и закрытие зоны симметричны. Устоявшиеся
 * блоки помечаются, но с набора снимаются позже — после блита миникарты.
 *
 * Возвращает число пройденных текселей — работу окна за кадр (PERF-3).
 */
export function dissolveWindow(
  target: Uint8Array,
  shown: Uint8Array,
  width: number,
  height: number,
  dirty: FogDirtyBlocks,
  step: number,
): number {
  let visited = 0;
  for (let row = 0; row < dirty.rows; row++) {
    const y0 = row * FOG_DIRTY_BLOCK;
    const y1 = Math.min(y0 + FOG_DIRTY_BLOCK, height);
    for (let column = 0; column < dirty.cols; column++) {
      if (!dirty.isDirty(column, row)) continue;
      const x0 = column * FOG_DIRTY_BLOCK;
      const x1 = Math.min(x0 + FOG_DIRTY_BLOCK, width);
      visited += (y1 - y0) * (x1 - x0);
      if (settleBlock(target, shown, width, x0, x1, y0, y1, step)) dirty.settle(column, row);
    }
  }
  // Сток читается один раз на проход, не на тексель (PERF-3).
  const cost = costSink();
  if (cost !== undefined) cost.fogDissolveTexels += visited;
  return visited;
}

/** Схождение одного блока; true — блок достиг цели и уходит из окна. */
function settleBlock(
  target: Uint8Array,
  shown: Uint8Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  step: number,
): boolean {
  let settled = true;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const at = row + x;
      const want = target[at]!;
      const have = shown[at]!;
      if (have === want) continue;
      const diff = want - have;
      if (diff > step) {
        shown[at] = have + step;
        settled = false;
      } else if (diff < -step) {
        shown[at] = have - step;
        settled = false;
      } else {
        shown[at] = want;
      }
    }
  }
  return settled;
}
