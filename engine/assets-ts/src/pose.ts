/**
 * Поза скелета в момент времени — вход запекания производных (ASSET-11).
 *
 * Сэмплирование каналов и обход иерархии живут здесь, а не в `derivatives.ts`,
 * потому что это отдельный вопрос: «какова поза скелета в момент t» — и ответ
 * на него один и тот же, во что бы его потом ни раскладывали (VAT, границы,
 * будущая LOD-цепочка).
 *
 * Правила сэмплирования — формата, а не вкуса: канал без ключей оставляет
 * величину позы покоя, ступенчатый канал не интерполируется, время за
 * пределами ключей зажимается крайним значением.
 */
import type { ChannelKeys, NormalizedModel, NormalizedSequence } from './model.js';
import { composeTrs, identityMat4, invertAffine, multiplyMat4 } from './mat4.js';

/** Локальная поза покоя: TRS каждой кости из `NormalizedBone`, 10 чисел на кость. */
export interface RestPose {
  /** `[px, py, pz, qx, qy, qz, qw, sx, sy, sz]` на кость. */
  readonly trs: Float64Array;
  /** Мировые матрицы позы покоя. */
  readonly world: Float64Array;
}

export const TRS_STRIDE = 10;

/** Переиспользуемые буферы одного прохода по кадрам. */
export interface PoseScratch {
  readonly trs: Float64Array;
  readonly local: Float64Array;
  readonly done: Uint8Array;
}

export function restPose(model: NormalizedModel): RestPose {
  const count = model.bones.length;
  const trs = new Float64Array(count * TRS_STRIDE);
  model.bones.forEach((bone, i) => {
    const base = i * TRS_STRIDE;
    trs[base] = bone.position[0];
    trs[base + 1] = bone.position[1];
    trs[base + 2] = bone.position[2];
    trs[base + 3] = bone.rotation[0];
    trs[base + 4] = bone.rotation[1];
    trs[base + 5] = bone.rotation[2];
    trs[base + 6] = bone.rotation[3];
    trs[base + 7] = bone.scale[0];
    trs[base + 8] = bone.scale[1];
    trs[base + 9] = bone.scale[2];
  });
  const world = new Float64Array(count * 16);
  hierarchyWorld(model, trs, { trs, local: new Float64Array(16), done: new Uint8Array(count) }, world);
  return { trs, world };
}

/**
 * Мировые матрицы костей из локальных TRS. Порядок обхода — порядок индексов
 * модели; родитель с индексом больше своего ребёнка (формат такого не обещает)
 * обработался бы по устаревшей матрице, поэтому такие цепочки досчитываются
 * повторным проходом, пока все не станут разрешены.
 */
export function hierarchyWorld(
  model: NormalizedModel,
  trs: Float64Array,
  scratch: PoseScratch,
  out: Float64Array,
): void {
  const count = model.bones.length;
  const { local, done } = scratch;
  done.fill(0);
  let resolved = 0;
  let guard = 0;
  while (resolved < count && guard++ <= count) {
    for (let i = 0; i < count; i++) {
      if (done[i] === 1) continue;
      const parent = model.bones[i]!.parentIndex;
      const hasParent = parent >= 0 && parent < count;
      if (hasParent && done[parent] !== 1) continue;
      composeTrs(trs, i * TRS_STRIDE, local, 0);
      if (hasParent) multiplyMat4(out, parent * 16, local, 0, out, i * 16);
      else out.set(local, i * 16);
      done[i] = 1;
      resolved++;
    }
  }
  // Цикл в иерархии (кость сама себе предок) оставил бы матрицы нулевыми:
  // единичная — единственный осмысленный ответ, и он же не роняет запекание.
  for (let i = 0; i < count; i++) {
    if (done[i] === 0) identityMat4(out, i * 16);
  }
}

/**
 * Матрицы обратной привязки. Явно заданную (`inverseBind` кости) берём как
 * есть: у форматов вроде glTF она сплошь и рядом НЕ равна инверсии позы покоя,
 * и вывод из позы дал бы искажённый скининг. Не заданную выводим из позы покоя
 * — так она честно выводится у MDX. Правило то же, что у детального яруса
 * (`render-ts/model/build.ts`): второго ответа на этот вопрос быть не должно.
 */
export function inverseBindOf(model: NormalizedModel, rest: RestPose): Float64Array {
  const count = model.bones.length;
  const out = new Float64Array(count * 16);
  for (let i = 0; i < count; i++) {
    const given = model.bones[i]!.inverseBind;
    if (given !== null && given.length >= 16) {
      for (let k = 0; k < 16; k++) out[i * 16 + k] = given[k]!;
    } else {
      invertAffine(rest.world, i * 16, out, i * 16);
    }
  }
  return out;
}

/**
 * Мировые матрицы костей в момент `time` секвенции. Канал без ключей оставляет
 * величину позы покоя: секвенция описывает то, что двигается, и молча обнулять
 * остальное значило бы схлопывать модель.
 */
export function poseAt(
  model: NormalizedModel,
  rest: RestPose,
  sequence: NormalizedSequence | null,
  time: number,
  scratch: PoseScratch,
  out: Float64Array,
): void {
  const trs = scratch.trs;
  trs.set(rest.trs);
  if (sequence !== null) {
    for (const track of sequence.boneTracks) {
      const bone = track.boneIndex;
      if (bone < 0 || bone >= model.bones.length) continue;
      const base = bone * TRS_STRIDE;
      if (track.position !== undefined) sampleChannel(track.position, 3, time, trs, base);
      if (track.rotation !== undefined) sampleRotation(track.rotation, time, trs, base + 3);
      if (track.scale !== undefined) sampleChannel(track.scale, 3, time, trs, base + 7);
    }
  }
  hierarchyWorld(model, trs, scratch, out);
}

/**
 * Отрезок ключей вокруг времени: индекс левого ключа и доля внутри отрезка.
 * Время за пределами ключей зажимается — трек описывает своё окно и за ним
 * держит крайнее значение.
 */
function segmentOf(times: Float32Array, time: number): { index: number; t: number } {
  const last = times.length - 1;
  if (last <= 0 || time <= times[0]!) return { index: 0, t: 0 };
  if (time >= times[last]!) return { index: last - 1, t: 1 };
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid]! <= time) low = mid;
    else high = mid;
  }
  const span = times[low + 1]! - times[low]!;
  return { index: low, t: span > 0 ? (time - times[low]!) / span : 0 };
}

/**
 * Ключ, значение которого держится в этой точке отрезка. Доля `1` бывает только
 * при выходе за последний ключ (`segmentOf` зажимает время), и держится там
 * ПОСЛЕДНИЙ ключ, а не левый конец отрезка: иначе ступенчатый трек в конце
 * клипа откатывался бы к своему началу.
 */
function stepIndex(index: number, t: number, count: number): number {
  return Math.min(t >= 1 ? index + 1 : index, count - 1);
}

/**
 * Векторный канал в `out[base .. base+dim)`.
 *
 * ОГОВОРКА ПРО `cubic`: нормализованное представление несёт значения ключей без
 * касательных (ASSET-5 — glTF CUBICSPLINE приезжает средним блоком тройки),
 * поэтому сплайн здесь считается линейно. Расхождение с детальным ярусом, где
 * тем же данным THREE подставляет свою оценку касательных, известное: клипы
 * контента ступенчатые и линейные, а честный сплайн потребует касательных в
 * самом представлении.
 */
function sampleChannel(
  keys: ChannelKeys,
  dim: number,
  time: number,
  out: Float64Array,
  base: number,
): void {
  const count = Math.floor(keys.values.length / dim);
  if (count === 0) return;
  const { index, t } = segmentOf(keys.times, time);
  const a = stepIndex(index, t, count) * dim;
  if (keys.interpolation === 'step' || t === 0 || index + 1 >= count) {
    for (let k = 0; k < dim; k++) out[base + k] = keys.values[a + k]!;
    return;
  }
  const b = (index + 1) * dim;
  for (let k = 0; k < dim; k++) {
    const from = keys.values[a + k]!;
    out[base + k] = from + (keys.values[b + k]! - from) * t;
  }
}

/** Канал поворота: тот же отрезок, но смешивание — slerp по кратчайшей дуге. */
function sampleRotation(keys: ChannelKeys, time: number, out: Float64Array, base: number): void {
  const count = Math.floor(keys.values.length / 4);
  if (count === 0) return;
  const { index, t } = segmentOf(keys.times, time);
  const a = stepIndex(index, t, count) * 4;
  if (keys.interpolation === 'step' || t === 0 || index + 1 >= count) {
    for (let k = 0; k < 4; k++) out[base + k] = keys.values[a + k]!;
    return;
  }
  const b = (index + 1) * 4;
  slerp(keys.values, a, keys.values, b, t, out, base);
}

/** Slerp кватернионов по кратчайшей дуге; почти сонаправленные — линейно. */
function slerp(
  from: Float32Array,
  fromBase: number,
  to: Float32Array,
  toBase: number,
  t: number,
  out: Float64Array,
  base: number,
): void {
  let x = to[toBase]!;
  let y = to[toBase + 1]!;
  let z = to[toBase + 2]!;
  let w = to[toBase + 3]!;
  const ax = from[fromBase]!;
  const ay = from[fromBase + 1]!;
  const az = from[fromBase + 2]!;
  const aw = from[fromBase + 3]!;
  let dot = ax * x + ay * y + az * z + aw * w;
  if (dot < 0) {
    dot = -dot;
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  let ka = 1 - t;
  let kb = t;
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(dot, 1));
    const sin = Math.sin(theta);
    ka = Math.sin((1 - t) * theta) / sin;
    kb = Math.sin(t * theta) / sin;
  }
  let ox = ax * ka + x * kb;
  let oy = ay * ka + y * kb;
  let oz = az * ka + z * kb;
  let ow = aw * ka + w * kb;
  const length = Math.hypot(ox, oy, oz, ow);
  if (length > 0) {
    ox /= length;
    oy /= length;
    oz /= length;
    ow /= length;
  }
  out[base] = ox;
  out[base + 1] = oy;
  out[base + 2] = oz;
  out[base + 3] = ow;
}
