/**
 * История недавних поз оболочки — вход ленты-следа (REND-23, design D6).
 *
 * Кольцевой буфер фиксированной длины на оболочку: кадр кладёт в него ОДНУ
 * запись и переписывает вершины полосы, поэтому аллокаций, растущих с числом
 * следов или с их длиной, у кадрового пути нет (REND-26). Длина фиксируется при
 * взятии узла — она и есть длина следа.
 *
 * Позы берутся ИНТЕРПОЛИРОВАННЫЕ (REND-2), а не доставленные: лента рисуется в
 * кадре, и рваться на кадрах между доставками ей нечем. Собственного игрового
 * состояния у истории нет: разрыв непрерывности (REND-2) её сбрасывает, и
 * телепортированный снаряд не тянет за собой полосу через всю арену.
 */
export class EffectTrail {
  /** Позиции по три числа на выборку; кольцо длиной `samples`. */
  private readonly points: Float32Array;
  private readonly samples: number;
  /** Индекс СЛЕДУЮЩЕЙ записи; голова — предыдущая по кольцу. */
  private head = 0;
  private count = 0;

  constructor(samples: number) {
    this.samples = Math.max(2, Math.floor(samples));
    this.points = new Float32Array(this.samples * 3);
  }

  /** Сколько выборок реально положено: `1` — след ещё в одну точку. */
  get filled(): number {
    return this.count;
  }

  get capacity(): number {
    return this.samples;
  }

  /** История заново: следующая выборка станет головой одноточечного следа. */
  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Ещё одна поза кадра. Переполнение вытесняет самую старую — это кольцо. */
  push(x: number, y: number, z: number): void {
    const at = this.head * 3;
    this.points[at] = x;
    this.points[at + 1] = y;
    this.points[at + 2] = z;
    this.head = (this.head + 1) % this.samples;
    if (this.count < this.samples) this.count++;
  }

  /**
   * Выборка по возрасту: `0` — голова (поза этого кадра), `filled - 1` — хвост.
   * Пишет в `out` три числа начиная с `at` и ничего не аллоцирует.
   */
  read(age: number, out: Float32Array, at: number): void {
    const index = (this.head - 1 - age + this.samples * 2) % this.samples;
    const from = index * 3;
    out[at] = this.points[from]!;
    out[at + 1] = this.points[from + 1]!;
    out[at + 2] = this.points[from + 2]!;
  }
}
