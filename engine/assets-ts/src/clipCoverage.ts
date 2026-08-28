/**
 * Что клипы модели ПОКРЫВАЮТ — две производные ASSET-12, у которых один вход
 * (кадры всех клипов) и один смысл «по всем клипам, а не по бинд-позе»:
 *
 * - консервативные границы: объём, в котором модель остаётся в любом кадре
 *   любого клипа, — вход отсечения (`rendering` REND-21);
 * - маска видимости частей по кадрам: то, что у детального яруса делает трек
 *   видимости, для батчевой записи, у которой меша на часть нет.
 */
import type { NormalizedMesh, NormalizedModel } from './model.js';
import type { BakedPartVisibility } from './derivatives.js';
import { transformPoint } from './mat4.js';

/**
 * Радиус влияния кости в её собственных осях: самая далёкая вершина из тех, на
 * которые кость влияет. Считается один раз по бинд-позе — по кадрам двигается
 * только сфера кости, а не вершины.
 *
 * Так границы получаются КОНСЕРВАТИВНЫМИ по построению (REND-21): скинутая
 * вершина — выпуклая комбинация точек `M_i · v`, а каждая из них лежит в сфере
 * своей кости, значит и комбинация лежит в объединении сфер.
 */
export function boneRadii(model: NormalizedModel, inverseBind: Float64Array): Float64Array {
  const radii = new Float64Array(model.bones.length);
  const point = new Float64Array(3);
  for (const mesh of model.meshes) {
    const vertices = Math.floor(mesh.positions.length / 3);
    for (let v = 0; v < vertices; v++) growRadiiByVertex(radii, inverseBind, mesh, v, point);
  }
  return radii;
}

/**
 * Вклад одной вершины в радиусы влияния всех костей, которым она принадлежит.
 * Модульная функция с явными аргументами, а не замыкание в цикле: вызывается
 * она на каждую вершину каждого меша, и объекта на итерацию здесь быть не
 * должно. `point` — тот же переиспользуемый буфер, что у вызывающего.
 */
function growRadiiByVertex(
  radii: Float64Array,
  inverseBind: Float64Array,
  mesh: NormalizedMesh,
  v: number,
  point: Float64Array,
): void {
  for (let k = 0; k < 4; k++) {
    const weight = mesh.skinWeights[v * 4 + k] ?? 0;
    if (weight <= 0) continue;
    const bone = mesh.skinIndices[v * 4 + k] ?? 0;
    if (bone >= radii.length) continue;
    transformPoint(
      inverseBind,
      bone * 16,
      mesh.positions[v * 3]!,
      mesh.positions[v * 3 + 1]!,
      mesh.positions[v * 3 + 2]!,
      point,
    );
    const distance = Math.hypot(point[0]!, point[1]!, point[2]!);
    if (distance > radii[bone]!) radii[bone] = distance;
  }
}

/** `[minX, minY, minZ, maxX, maxY, maxZ]`, пустой объём — перевёрнутый. */
export function emptyBounds(): Float64Array {
  return Float64Array.from([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
}

/** Объём пуст: ни одна сфера в него не попала, и он так и остался перевёрнутым. */
export function boundsEmpty(bounds: Float64Array): boolean {
  return !(bounds[0]! <= bounds[3]!);
}

/**
 * Расширяет объём вершинами модели в бинд-позе. Запасной путь для модели, у
 * которой скелет есть, а весов скиннинга нет ни у одной вершины: радиусы
 * влияния костей тогда нулевые, сферы пусты, и объединять нечего — объём
 * остался бы перевёрнутым, а отсечение по перевёрнутому вырезало бы модель из
 * кадра насовсем (`rendering` REND-21). Нарисована при этом она вполне: без
 * весов вершины стоят ровно там, где лежат в данных.
 */
export function growBoundsByBindPose(bounds: Float64Array, model: NormalizedModel): void {
  for (const mesh of model.meshes) {
    const vertices = Math.floor(mesh.positions.length / 3);
    for (let v = 0; v < vertices; v++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[v * 3 + axis]!;
        if (value < bounds[axis]!) bounds[axis] = value;
        if (value > bounds[3 + axis]!) bounds[3 + axis] = value;
      }
    }
  }
}

/** Расширяет объём сферой кости в этом кадре: центр — начало кости, радиус — с её масштабом. */
export function growBoundsByBone(
  bounds: Float64Array,
  world: Float64Array,
  base: number,
  radius: number,
): void {
  if (radius <= 0) return;
  // Норма Фробениуса линейной части — верхняя оценка спектральной: масштаб и
  // сдвиг кости растягивают радиус не сильнее неё, и объём остаётся объемлющим.
  let squared = 0;
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) squared += world[base + column * 4 + row]! ** 2;
  }
  const scaled = radius * Math.sqrt(squared);
  for (let axis = 0; axis < 3; axis++) {
    const center = world[base + 12 + axis]!;
    if (center - scaled < bounds[axis]!) bounds[axis] = center - scaled;
    if (center + scaled > bounds[3 + axis]!) bounds[3 + axis] = center + scaled;
  }
}

// ------------------------------------------------------------- видимость

/**
 * Место клипа в раскладке кадров — ровно то, что нужно маске: где начинается
 * клип и сколько кадров занял. Полная запись клипа (`BakedClip`) знает больше,
 * и требовать её здесь значило бы связать маску с форматом VAT.
 */
export interface ClipRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * Маска видимости частей по кадрам. Часть без трека в секвенции видима — как и
 * у детального яруса, где отсутствующий трек оставляет меш нарисованным.
 * Ступенчатость трека здесь буквальна: видимость двоичная, интерполировать в
 * ней нечего.
 */
export function bakePartVisibility(
  model: NormalizedModel,
  clips: readonly ClipRange[],
  fps: number,
  frameCount: number,
): BakedPartVisibility {
  const parts = [...new Set(model.meshes.map((mesh) => mesh.partId))].sort((a, b) => a - b);
  const wordsPerFrame = Math.ceil(parts.length / 32);
  const mask = new Uint32Array(wordsPerFrame * frameCount);
  if (parts.length === 0) return { parts, wordsPerFrame, mask };
  const bitOf = new Map(parts.map((part, i) => [part, i]));

  // Всё видимо по умолчанию; треки только ГАСЯТ то, что назвали.
  mask.fill(0xffffffff);
  // Хвостовые биты последнего слова частям не соответствуют — держим их нулём,
  // чтобы буфер побитово зависел только от данных модели (ASSET-12).
  const tail = parts.length % 32;
  if (tail !== 0) {
    const last = wordsPerFrame - 1;
    const keep = (1 << tail) - 1;
    for (let frame = 0; frame < frameCount; frame++) {
      mask[frame * wordsPerFrame + last] = (mask[frame * wordsPerFrame + last]! & keep) >>> 0;
    }
  }

  model.sequences.forEach((sequence, i) => {
    const clip = clips[i]!;
    for (const track of sequence.partVisibility) {
      const bit = bitOf.get(track.partId);
      if (bit === undefined) continue;
      for (let k = 0; k < clip.length; k++) {
        const time = Math.min(k / fps, sequence.duration);
        if (visibleAt(track.times, track.visible, time)) continue;
        const word = (clip.offset + k) * wordsPerFrame + (bit >> 5);
        mask[word] = (mask[word]! & ~(1 << (bit % 32))) >>> 0;
      }
    }
  });
  return { parts, wordsPerFrame, mask };
}

/** Видимость трека в момент времени: ступенчато, ключ держится до следующего. */
function visibleAt(times: Float32Array, visible: Uint8Array, time: number): boolean {
  if (times.length === 0) return true;
  let value = visible[0] !== 0;
  for (let k = 0; k < times.length; k++) {
    if (times[k]! > time) break;
    value = visible[k] !== 0;
  }
  return value;
}
