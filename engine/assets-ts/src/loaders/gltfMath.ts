/**
 * Минимальная 4x4/кватернионная арифметика загрузчика glTF: конвертация осей и
 * запекание трансформа неприкреплённых-к-скину узлов (экипировка) в
 * bind-пространство.
 *
 * Своя, а не из рендер-библиотеки: модуль ассетов рендер-агностичен (ASSET-5).
 * Обоснование самих правил конвертации — в заголовке `gltf.ts`.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
/** Column-major 4x4, как `NormalizedBone.inverseBind`. */
export type Mat4 = Float32Array;

/** Mc: поворот +90° вокруг X, глTF Y-вверх → канон Z-вверх: (x,y,z) → (x,-z,y). */
export function axisConvertVec3(v: Vec3): [number, number, number] {
  return [v[0], -v[2], v[1]];
}

/** Кватернион Mc: поворот +90° вокруг X. */
export const MC_QUAT: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** Хэмилтоново произведение: `a ⊗ b` — сперва `b`, затем `a`. */
export function quatMultiply(a: Quat, b: Quat): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** `Mc⁻¹` 4x4 (column-major): обратный поворот, (x,y,z) → (x,z,-y). */
// prettier-ignore
export const MC_INVERSE: Mat4 = Float32Array.from([
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
]);

/** `a · b` (column-major, «сперва b, затем a»). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** TRS → 4x4 (column-major), стандартная композиция T · R · S. */
export function mat4Compose(t: Vec3, q: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  // prettier-ignore
  return Float32Array.from([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** Точка через 4x4 (со смещением). */
export function mat4TransformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Направление через линейную часть 4x4 (без смещения, без учёта неравномерного масштаба). */
export function mat4TransformDirection(m: Mat4, v: Vec3): [number, number, number] {
  const [x, y, z] = v;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}
