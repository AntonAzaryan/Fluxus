/**
 * Матрицы 4×4 для запекания производных модели (ASSET-12) — своя маленькая
 * реализация вместо библиотеки по той же причине, по какой её нет у всего
 * модуля: `assets-ts` рендер-агностичен (ASSET-5), а матрицы нужны ему ровно
 * здесь и ровно в этом объёме.
 *
 * Раскладка — column-major по 16 чисел, как у glTF `inverseBindMatrices` и как
 * у THREE: привязку модели тогда можно брать байт в байт, не переставляя
 * элементы. Все функции пишут в переданный буфер по смещению — запекание идёт
 * по сотням кадров, и заводить объект на матрицу незачем.
 */

/** Единичная матрица в `out[base .. base+16)`. */
export function identityMat4(out: Float64Array, base: number): void {
  for (let k = 0; k < 16; k++) out[base + k] = 0;
  out[base] = 1;
  out[base + 5] = 1;
  out[base + 10] = 1;
  out[base + 15] = 1;
}

/** Матрица 4×4 (column-major) из TRS: поворот кватерниона, масштаб по столбцам. */
export function composeTrs(trs: Float64Array, trsBase: number, out: Float64Array, base: number): void {
  const x = trs[trsBase + 3]!;
  const y = trs[trsBase + 4]!;
  const z = trs[trsBase + 5]!;
  const w = trs[trsBase + 6]!;
  const sx = trs[trsBase + 7]!;
  const sy = trs[trsBase + 8]!;
  const sz = trs[trsBase + 9]!;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  out[base] = (1 - (yy + zz)) * sx;
  out[base + 1] = (xy + wz) * sx;
  out[base + 2] = (xz - wy) * sx;
  out[base + 3] = 0;
  out[base + 4] = (xy - wz) * sy;
  out[base + 5] = (1 - (xx + zz)) * sy;
  out[base + 6] = (yz + wx) * sy;
  out[base + 7] = 0;
  out[base + 8] = (xz + wy) * sz;
  out[base + 9] = (yz - wx) * sz;
  out[base + 10] = (1 - (xx + yy)) * sz;
  out[base + 11] = 0;
  out[base + 12] = trs[trsBase]!;
  out[base + 13] = trs[trsBase + 1]!;
  out[base + 14] = trs[trsBase + 2]!;
  out[base + 15] = 1;
}

/** `out = a × b`, column-major; `out` вправе совпадать с `a` или `b`. */
export function multiplyMat4(
  a: Float64Array,
  aBase: number,
  b: Float64Array,
  bBase: number,
  out: Float64Array,
  outBase: number,
): void {
  const result = MULTIPLY_SCRATCH;
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[aBase + k * 4 + row]! * b[bBase + column * 4 + k]!;
      result[column * 4 + row] = sum;
    }
  }
  for (let k = 0; k < 16; k++) out[outBase + k] = result[k]!;
}

const MULTIPLY_SCRATCH = new Float64Array(16);

/**
 * Инверсия аффинной матрицы: обращается линейная часть 3×3, сдвиг переносится
 * ею же. Вырожденная линейная часть (нулевой масштаб кости) даёт единичную —
 * такая кость ничего не двигает, и лучший ответ здесь «не трогать», а не NaN.
 */
export function invertAffine(source: Float64Array, base: number, out: Float64Array, outBase: number): void {
  const m = (column: number, row: number): number => source[base + column * 4 + row]!;
  const a = m(0, 0);
  const b = m(1, 0);
  const c = m(2, 0);
  const d = m(0, 1);
  const e = m(1, 1);
  const f = m(2, 1);
  const g = m(0, 2);
  const h = m(1, 2);
  const i = m(2, 2);
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (det === 0 || !Number.isFinite(det)) {
    identityMat4(out, outBase);
    return;
  }
  const inv = 1 / det;
  const r00 = (e * i - f * h) * inv;
  const r01 = (c * h - b * i) * inv;
  const r02 = (b * f - c * e) * inv;
  const r10 = (f * g - d * i) * inv;
  const r11 = (a * i - c * g) * inv;
  const r12 = (c * d - a * f) * inv;
  const r20 = (d * h - e * g) * inv;
  const r21 = (b * g - a * h) * inv;
  const r22 = (a * e - b * d) * inv;
  const tx = m(3, 0);
  const ty = m(3, 1);
  const tz = m(3, 2);
  out[outBase] = r00;
  out[outBase + 1] = r10;
  out[outBase + 2] = r20;
  out[outBase + 3] = 0;
  out[outBase + 4] = r01;
  out[outBase + 5] = r11;
  out[outBase + 6] = r21;
  out[outBase + 7] = 0;
  out[outBase + 8] = r02;
  out[outBase + 9] = r12;
  out[outBase + 10] = r22;
  out[outBase + 11] = 0;
  out[outBase + 12] = -(r00 * tx + r01 * ty + r02 * tz);
  out[outBase + 13] = -(r10 * tx + r11 * ty + r12 * tz);
  out[outBase + 14] = -(r20 * tx + r21 * ty + r22 * tz);
  out[outBase + 15] = 1;
}

/** Точка через аффинную матрицу — без деления на w: последняя строка единична. */
export function transformPoint(
  matrix: Float64Array,
  base: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  for (let row = 0; row < 3; row++) {
    out[row] =
      matrix[base + row]! * x +
      matrix[base + 4 + row]! * y +
      matrix[base + 8 + row]! * z +
      matrix[base + 12 + row]!;
  }
}
