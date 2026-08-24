/**
 * Broad-phase физики (PHYS-5): равномерная сетка по статическим коллайдерам и
 * запросы к ней. Модуль отделён от `physics.ts` по границе самой спеки — фаза
 * широкой выборки не знает ни ECS, ни террейна, ни разрешения движения: ей
 * известны только прямоугольники, их теги и слои.
 *
 * Динамику сетка НЕ индексирует, и это норма PHYS-5, а не упрощение: `Position`
 * вправе писать любая система, поэтому индекс динамики, снятый в начале тика, к
 * моменту запроса из другой системы может не соответствовать миру.
 */
import * as fixed from '../math/fixed.js';
import { overlaps, type Bounds, type StaticCollider } from './collisionGeometry.js';
import { countCostBroadPhase } from '../debug.js';
import type { Fixed } from '../types.js';

const DEFAULT_CELL_SIZE = fixed.fromInt(4);

/**
 * Равномерная сетка по статике. Динамика обходится по живым позициям в порядке
 * возрастания индекса сущности (QUERY-2) — там, где она нужна, то есть в
 * системе разрешения движения и в луче.
 *
 * ponytail: индексировать динамику имеет смысл, когда её станут сотни;
 * пока это лишний инвариант, который легко нарушить молча.
 */
export class PhysicsWorld {
  private readonly cells = new Map<number, number[]>();
  /** Метка последнего запроса на каждый коллайдер — дешёвая дедупликация по клеткам. */
  private readonly stamp: Int32Array;
  private queryId = 0;
  // Поля объявлены явно, а не parameter properties: `bin/sim.mjs` исполняет
  // исходники через strip-only режим node, который их не поддерживает (CLI-1).
  readonly statics: readonly StaticCollider[];
  readonly cellSize: Fixed;

  constructor(statics: readonly StaticCollider[], cellSize: Fixed = DEFAULT_CELL_SIZE) {
    this.statics = statics;
    this.cellSize = cellSize;
    this.stamp = new Int32Array(statics.length);
    for (let i = 0; i < statics.length; i++) {
      const s = statics[i]!;
      for (let cy = this.cell(s.minY); cy <= this.cell(s.maxY); cy++) {
        for (let cx = this.cell(s.minX); cx <= this.cell(s.maxX); cx++) {
          const key = cx * 131072 + cy;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  /**
   * Клетка сетки по мировой координате.
   *
   * DET-2, условия 3 и 5: делимое — координата в Q16.16, то есть `i32` по
   * модулю меньше 2^31; делитель `cellSize` — положительное целое Q16.16.
   * Промежуток из 2^53 не выходит, частное приводится к целому.
   *
   * Условие 4: делимое БЫВАЕТ отрицательным (арена левее и ниже начала
   * координат), и `floor` расходится там с усечением к нулю. Расхождение
   * ненаблюдаемо, и держится это не на выборе `floor`, а на том, что вставка в
   * индекс и запрос по нему пользуются ОДНОЙ этой функцией: при любой конвенции
   * отображение остаётся разбиением плоскости на клетки, коллайдер лежит в той
   * же клетке, в которой его ищут, и набор кандидатов совпадает. Обход клеток
   * идёт по возрастанию, а результат сортируется по индексу статики (DET-6),
   * поэтому и порядок от конвенции не зависит. Закреплено тестом на статике с
   * отрицательными координатами в `physics.test.ts`.
   */
  private cell(coordinate: Fixed): number {
    return Math.floor(coordinate / this.cellSize);
  }

  /**
   * Статика, чей AABB пересекает `bounds` и у которой есть тег `tag`; без тега
   * — вся статика, попавшая в `bounds` (PHYS-6: маска ФИЛЬТРУЕТ, и её
   * отсутствие фильтром быть не может). Порядок — по индексу (DET-6).
   */
  query(bounds: Bounds, tag?: string): StaticCollider[] {
    return this.collect(bounds, tag, undefined);
  }

  /** Статика, чей AABB пересекает `bounds` и чей `layer` попал в маску (PHYS-2). Порядок — по индексу (DET-6). */
  queryByLayer(bounds: Bounds, mask: number): StaticCollider[] {
    return this.collect(bounds, undefined, mask);
  }

  /**
   * Общий обход клеток обоих запросов: фильтр — тег (raycast; без тега фильтра
   * нет вовсе) либо маска слоёв (движение, сенсоры).
   *
   * ponytail: один запрос стоит двух массивов — индексов кандидатов и выданных
   * коллайдеров, — а зовут его на каждом шаге оси каждого движущегося и ещё раз
   * на его сенсоры. Снимается переиспользуемым буфером на `PhysicsWorld` либо
   * обходом через колбэк; и то и другое — когда профиль на реальной сцене
   * покажет эти аллокации, а не по вкусу.
   */
  private collect(bounds: Bounds, tag: string | undefined, mask: number | undefined): StaticCollider[] {
    this.queryId++;
    const found: number[] = [];
    // Объём работы broad-phase — осмотренные кандидаты (PERF-3). Считается в
    // локальную переменную, а не вызовом на каждого: в горячем цикле это ровно
    // одно целочисленное сложение, а сумма уходит наружу один раз за запрос.
    let pairs = 0;
    for (let cy = this.cell(bounds.minY); cy <= this.cell(bounds.maxY); cy++) {
      for (let cx = this.cell(bounds.minX); cx <= this.cell(bounds.maxX); cx++) {
        for (const index of this.cells.get(cx * 131072 + cy) ?? []) {
          if (this.stamp[index] === this.queryId) continue;
          this.stamp[index] = this.queryId;
          pairs++;
          const s = this.statics[index]!;
          const rejected = mask === undefined ? tag !== undefined && !s.tags.includes(tag) : (s.layer & mask) === 0;
          if (rejected) continue;
          if (!overlaps(bounds, s)) continue;
          found.push(index);
        }
      }
    }
    countCostBroadPhase(pairs);
    found.sort((a, b) => a - b);
    return found.map((index) => this.statics[index]!);
  }
}
