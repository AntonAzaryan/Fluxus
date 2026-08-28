/**
 * Секвенции glTF в нормализованное представление (ASSET-5): каналы узлов
 * переносятся ключами с их режимом интерполяции, а не выпрямляются в линейные.
 *
 * ОГОВОРКА ПРО CUBICSPLINE: спецификация кладёт на ключ тройку (in-tangent,
 * value, out-tangent) — берётся средний блок, то есть само значение, а режим
 * записывается линейным. Это фиксация поведения, а не потеря: касательных
 * нормализованное представление не несёт, и играна такая кривая была бы линейно
 * (то же упрощение, что у `mdxLoader` для Hermite/Bezier).
 *
 * Правила конвертации осей — в заголовке `gltf.ts`: у КОРНЕВОГО узла (без
 * родителя) трансляция и поворот переводятся в канон, у остальных остаются
 * локальными, а масштаб не конвертируется никогда.
 */
import type { BoneTrack, ChannelKeys, Interpolation, NormalizedSequence } from '../model.js';
import { readAccessor } from './gltfAccessor.js';
import type { GltfAnimation, GltfAnimationChannel, GltfDocument } from './gltfDocument.js';
import { MC_QUAT, axisConvertVec3, quatMultiply, type Quat } from './gltfMath.js';

const LINE_TYPE: Readonly<Record<string, Interpolation>> = {
  LINEAR: 'linear',
  STEP: 'step',
  CUBICSPLINE: 'linear', // упрощение: берём только значение ключа, без касательных
};

/** Каналы одного узла, собранные по ходу разбора секвенции. */
interface NodeTracks {
  position?: ChannelKeys;
  rotation?: ChannelKeys;
  scale?: ChannelKeys;
}

/** Тройка чисел ключа трансляции и масштаба. */
type Vec = readonly [number, number, number];

/** Путь канала, который модель скелета умеет; остальные (`weights`) не поддержаны. */
type TrackPath = 'translation' | 'rotation' | 'scale';

function isTrackPath(path: string): path is TrackPath {
  return path === 'translation' || path === 'rotation' || path === 'scale';
}

/** Значения ключей канала в канонических осях; `dim` — 4 у поворота, 3 у остальных. */
function convertKeyValues(
  rawOut: Float64Array,
  keyCount: number,
  path: TrackPath,
  dim: number,
  cubic: boolean,
  isRoot: boolean,
): Float32Array {
  const values = new Float32Array(keyCount * dim);
  for (let k = 0; k < keyCount; k++) {
    const at = cubic ? k * dim * 3 + dim : k * dim;
    values.set(convertKey(rawOut, at, path, isRoot), k * dim);
  }
  return values;
}

/** Один ключ канала: перевод осей зависит от пути и от того, корневой ли узел. */
function convertKey(
  rawOut: Float64Array,
  at: number,
  path: TrackPath,
  isRoot: boolean,
): readonly number[] {
  if (path === 'translation') {
    const t: Vec = [rawOut[at]!, rawOut[at + 1]!, rawOut[at + 2]!];
    return isRoot ? axisConvertVec3(t) : t;
  }
  if (path === 'rotation') {
    const q: Quat = [rawOut[at]!, rawOut[at + 1]!, rawOut[at + 2]!, rawOut[at + 3]!];
    return isRoot ? quatMultiply(MC_QUAT, q) : [...q];
  }
  // scale — не конвертируется
  return [rawOut[at]!, rawOut[at + 1]!, rawOut[at + 2]!];
}

/**
 * Один канал в таблицу треков узла. Возвращает время последнего ключа — по нему
 * секвенция набирает длительность, и канал непонятного пути (`weights`) в неё
 * всё равно засчитывается: он длится столько же, сколько остальные.
 */
function readChannel(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  anim: GltfAnimation,
  channel: GltfAnimationChannel,
  parentOf: Int32Array,
  tracksByNode: Map<number, NodeTracks>,
): number {
  const targetNode = channel.target.node;
  if (targetNode == null) return 0; // 'weights' и т.п. без узла — вне модели скелета
  const sampler = anim.samplers[channel.sampler];
  if (sampler == null) return 0;
  const times = readAccessor(doc, buffers, sampler.input, false).values;
  const last = times.length > 0 ? times[times.length - 1]! : 0;

  const path = channel.target.path;
  if (!isTrackPath(path)) return last; // 'weights' — не поддержан
  const dim = path === 'rotation' ? 4 : 3;
  const rawOut = readAccessor(doc, buffers, sampler.output, false).values;
  const keys: ChannelKeys = {
    times: Float32Array.from(times),
    values: convertKeyValues(
      rawOut,
      times.length,
      path,
      dim,
      sampler.interpolation === 'CUBICSPLINE',
      parentOf[targetNode] === -1,
    ),
    interpolation: LINE_TYPE[sampler.interpolation ?? 'LINEAR'] ?? 'linear',
  };

  const entry = tracksByNode.get(targetNode) ?? {};
  if (path === 'translation') entry.position = keys;
  else if (path === 'rotation') entry.rotation = keys;
  else entry.scale = keys;
  tracksByNode.set(targetNode, entry);
  return last;
}

/** Одна секвенция: её треки по узлам и её длительность. */
function normalizeSequence(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  parentOf: Int32Array,
  anim: GltfAnimation,
): NormalizedSequence {
  const tracksByNode = new Map<number, NodeTracks>();
  let duration = 0.001;
  for (const channel of anim.channels) {
    duration = Math.max(duration, readChannel(doc, buffers, anim, channel, parentOf, tracksByNode));
  }
  const boneTracks: BoneTrack[] = [...tracksByNode.entries()].map(([boneIndex, t]) =>
    Object.freeze({
      boneIndex,
      ...(t.position ? { position: Object.freeze(t.position) } : {}),
      ...(t.rotation ? { rotation: Object.freeze(t.rotation) } : {}),
      ...(t.scale ? { scale: Object.freeze(t.scale) } : {}),
    }),
  );
  return Object.freeze({
    name: anim.name ?? 'sequence',
    duration,
    boneTracks: Object.freeze(boneTracks),
    partVisibility: Object.freeze([]), // glTF не знает видимости частей по секвенции
  });
}

/** Все секвенции документа в порядке `doc.animations`. */
export function normalizeSequences(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  parentOf: Int32Array,
): NormalizedSequence[] {
  return (doc.animations ?? []).map((anim) => normalizeSequence(doc, buffers, parentOf, anim));
}
