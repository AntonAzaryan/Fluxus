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
export const FOG_DIRTY_BLOCK = 16;

/**
 * Набор блоков, в которых показанная маска ещё не сошлась с целевой.
 *
 * Блоки снимаются с набора ДВУМЯ шагами (`settle` → `flushSettled`): блит
 * миникарты читает набор ПОСЛЕ прохода схождения, и блок, снятый прямо в
 * проходе, не доехал бы в канвас последним своим значением.
 */
export class FogDirtyBlocks {
  readonly cols: number;
  readonly rows: number;
  private readonly flags: Uint8Array;
  /** Блоки, устоявшиеся в текущем проходе; снимаются `flushSettled`. */
  private readonly settled: Int32Array;
  private settledCount = 0;
  private live = 0;

  constructor(width: number, height: number) {
    this.cols = Math.max(1, Math.ceil(width / FOG_DIRTY_BLOCK));
    this.rows = Math.max(1, Math.ceil(height / FOG_DIRTY_BLOCK));
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

/** Различаются ли растры в прямоугольнике [x0, x1) × [y0, y1). */
function differs(
  previous: Uint8Array,
  next: Uint8Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): boolean {
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
