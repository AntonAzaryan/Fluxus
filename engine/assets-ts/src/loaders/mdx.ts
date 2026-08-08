/**
 * Загрузчик MDX (Warcraft 3) поверх парсера `war3-model` — первый загрузчик
 * моделей реестра (ASSET-3). Перенёс парсинговую половину знаний удалённого
 * прототипа ts-render: иерархию костей, окна секвенций, правила geoset-альфы,
 * bbox-высоту. THREE-половина (построение сцены, скелета, клипов) живёт
 * в рендере — сюда ей нельзя (ASSET-5).
 */

import { parseMDX } from 'war3-model';
import type { model as MdlModel } from 'war3-model';
import type { AssetLoader, LoaderContext } from '../types.js';
import type {
  BoneTrack,
  ChannelKeys,
  Interpolation,
  NormalizedBone,
  NormalizedMaterial,
  NormalizedMesh,
  NormalizedModel,
  NormalizedSequence,
  PartVisibilityTrack,
  TextureSlotRef,
} from '../model.js';

/** Порог альфы, выше которого геосет считается видимым. */
const ALPHA_VISIBLE = 0.1;

/** Частота кадров MDX: времена ключей — миллисекунды, в секвенциях тоже. */
const MS_PER_SECOND = 1000;

/**
 * Считать ли альфу геосета настоящей анимацией видимости.
 *
 * У типичных WC3-моделей одноключевые GeosetAnim — placeholder базового тела
 * (в SkeletonBarbarian все они = 0 на служебном кадре, но геосет обязан быть
 * виден всегда). Реальные тумблеры вариантов (Defend/Death) имеют >= 2 ключей
 * и действительно переключают видимость по секвенциям. Поэтому треки видимости
 * строим ТОЛЬКО из многоключевой альфы — иначе базовое тело исчезнет целиком.
 */
function isAnimatedAlpha(a: MdlModel.AnimVector | number | undefined): a is MdlModel.AnimVector {
  return a != null && typeof a !== 'number' && !!a.Keys && a.Keys.length >= 2;
}

/** Значение альфы на кадре: последний ключ с Frame <= frame, иначе первый. */
function evalAlphaAt(alpha: MdlModel.AnimVector, frame: number): number {
  const keys = alpha.Keys;
  let val = keys[0]!.Vector[0] ?? 1;
  for (const k of keys) {
    if (k.Frame <= frame) val = k.Vector[0] ?? 1;
    else break;
  }
  return val;
}

/**
 * Ключи канала внутри окна секвенции `[s0, s1]`, времена в секундах от её
 * начала. `base` — по-компонентное смещение значений: для Translation сюда
 * передаётся rest-pivot кости, чтобы в треке лежали УЖЕ абсолютные локальные
 * позиции (rp + d, как в прототипе). Времена строго возрастают — дубликаты
 * по времени отбрасываются (первый побеждает).
 */
function channelInWindow(
  v: MdlModel.AnimVector | undefined,
  s0: number,
  s1: number,
  dim: number,
  base?: readonly number[],
): ChannelKeys | null {
  if (!v || !v.Keys || v.Keys.length === 0) return null;
  const kept: { t: number; vec: ArrayLike<number> }[] = [];
  let lastT = -Infinity;
  for (const key of v.Keys) {
    if (key.Frame < s0 || key.Frame > s1) continue;
    const t = (key.Frame - s0) / MS_PER_SECOND;
    if (t <= lastT) continue;
    lastT = t;
    kept.push({ t, vec: key.Vector });
  }
  if (kept.length === 0) return null;
  const times = new Float32Array(kept.length);
  const values = new Float32Array(kept.length * dim);
  kept.forEach((k, i) => {
    times[i] = k.t;
    for (let c = 0; c < dim; c++) {
      values[i * dim + c] = (base?.[c] ?? 0) + (k.vec[c] ?? 0);
    }
  });
  return { times, values, interpolation: interpolationOf(v) };
}

/**
 * Режим интерполяции канала (ASSET-5): режим приезжает из формата, а не
 * подразумевается.
 *
 * MDX знает четыре: DontInterp, Linear, Hermite, Bezier. Первый — ступенчатый,
 * второй — линейный, и оба ложатся на канонические один в один. Эрмит и безье
 * в `cubic` НЕ переводятся сознательно: это другая параметризация (у MDX
 * касательные лежат в отдельных полях ключей InTan/OutTan, у канонического
 * кубического сплайна — своя раскладка значений), и честный перевод — отдельная
 * работа с проверкой на глаз. Сегодня они и так проигрываются линейно, поэтому
 * `linear` здесь — фиксация существующего поведения, а не потеря.
 */
/**
 * `LineType.DontInterp` числом: `war3-model` объявляет `LineType` как enum
 * только в типах, рантайм-значения у него нет — импортировать нечего. Аннотация
 * привязывает литерал к тому же enum'у, поэтому сравнение ниже сопоставляет
 * члены одного типа, а не число со значением из формата.
 */
const LINE_TYPE_DONT_INTERP: MdlModel.LineType = 0;

function interpolationOf(v: MdlModel.AnimVector): Interpolation {
  return v.LineType === LINE_TYPE_DONT_INTERP ? 'step' : 'linear';
}

/**
 * Трек видимости геосета из многоключевой альфы для окна `[s0, s1]`.
 *
 * В WC3 альфа геосета практически всегда бинарная (ключи 0/1 со ступенчатой
 * интерполяцией) — поэтому нормализуем её в 0/1 по порогу, а не в opacity.
 * Концевые ключи (t=0 и t=dur) добавляем всегда, чтобы секвенция полностью
 * задавала состояние геосета и не «наследовала» его от предыдущего клипа.
 */
function buildVisibilityTrack(
  alpha: MdlModel.AnimVector,
  s0: number,
  s1: number,
  dur: number,
): { times: Float32Array; visible: Uint8Array } {
  const times: number[] = [];
  const visible: number[] = [];
  const push = (t: number, a: number): void => {
    // время должно строго возрастать — дубликаты по времени отбрасываем
    if (times.length && t <= times[times.length - 1]!) return;
    times.push(t);
    visible.push(a >= ALPHA_VISIBLE ? 1 : 0);
  };

  push(0, evalAlphaAt(alpha, s0));
  for (const k of alpha.Keys) {
    if (k.Frame <= s0 || k.Frame >= s1) continue;
    push((k.Frame - s0) / MS_PER_SECOND, k.Vector[0] ?? 1);
  }
  push(dur, evalAlphaAt(alpha, s1));

  return { times: Float32Array.from(times), visible: Uint8Array.from(visible) };
}

/**
 * Слот текстуры материала — из его ПЕРВОГО слоя.
 *
 * Допущение MVP: у многослойных материалов WC3 первый слой нередко
 * team-color-подложка (replaceable-слот), а диффузная текстура — последний
 * слой; для MVP этого достаточно, потому что скины манифеста в любом случае
 * подменяют слоты по номеру (решение 8 change'а add-render-assets-mvp).
 * Анимированный TextureID сводим к первому ключу.
 */
function layerTextureSlot(mdl: MdlModel.Model, material: MdlModel.Material | undefined): number {
  const tid = material?.Layers[0]?.TextureID;
  let slot = 0;
  if (typeof tid === 'number') slot = tid;
  else if (tid?.Keys?.length) slot = tid.Keys[0]!.Vector[0] ?? 0;
  return slot >= 0 && slot < mdl.Textures.length ? slot : 0;
}

/**
 * Значения, которыми MDX-модель заполняет металличность/шероховатость: ровно
 * те, что до этого изменения были зашиты в конструкторе материала рендера.
 * MDX не описывает PBR вовсе, поэтому переезд из кода в данные — это перенос
 * умолчаний, а не появление новой информации; зато рендер перестаёт решать за
 * ассет, и формат, который PBR описывает, приедет со своими значениями.
 */
// Это тот же цвет, что был в рендере как 0xb8b8b0, только переведённый из sRGB
// в линейный: `baseColorFactor` по контракту линеен, а 0xb8b8b0 — sRGB-запись.
const MDX_BASE_COLOR: readonly [number, number, number, number] = [0.479, 0.479, 0.434, 1];
const MDX_METALLIC = 0.05;
const MDX_ROUGHNESS = 0.85;

/**
 * Материалы модели: по одному на материал MDX, индекс совпадает с MaterialID.
 *
 * Режимы фильтрации WC3 (Transparent/Blend/Additive) в `alphaMode` НЕ
 * переносятся: рендер их сегодня не применяет, а включить прозрачность значит
 * получить сортировку по глубине и все её артефакты — это отдельная работа с
 * проверкой на глаз, а не побочный эффект правки контракта.
 */
function buildMaterials(mdl: MdlModel.Model): NormalizedMaterial[] {
  const source = mdl.Materials.length > 0 ? mdl.Materials : [undefined];
  return source.map((material) =>
    Object.freeze({
      baseColorFactor: MDX_BASE_COLOR,
      baseColorTexture: layerTextureSlot(mdl, material),
      metallicFactor: MDX_METALLIC,
      roughnessFactor: MDX_ROUGHNESS,
      normalTexture: null,
      emissiveFactor: Object.freeze([0, 0, 0] as [number, number, number]),
      emissiveTexture: null,
      alphaMode: 'opaque' as const,
      alphaCutoff: 0.5,
      doubleSided: true,
    }),
  );
}

/** Нормализация распарсенной MDX-модели в рендер-агностичное представление. */
export function normalizeMdx(mdl: MdlModel.Model): NormalizedModel {
  // ==========================================================================
  // A. Скелет: все ноды (кости, хелперы, аттачи) — на них ссылаются и треки,
  // и группы скиннинга. ObjectId — идентификатор ноды в MDX; boneIndex
  // нормализованной модели — индекс в mdl.Nodes.
  // ==========================================================================
  const nodes = mdl.Nodes;
  const boneIndexById = new Map<number, number>();
  nodes.forEach((n, i) => boneIndexById.set(n.ObjectId, i));

  /** Локальная rest-позиция ноды: pivot минус pivot родителя (как в прототипе). */
  const localPivot = (n: MdlModel.Node): readonly [number, number, number] => {
    const p = n.PivotPoint;
    const parentIdx = n.Parent != null ? boneIndexById.get(n.Parent) : undefined;
    if (parentIdx == null) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    const pp = nodes[parentIdx]!.PivotPoint;
    return [(p[0] ?? 0) - (pp[0] ?? 0), (p[1] ?? 0) - (pp[1] ?? 0), (p[2] ?? 0) - (pp[2] ?? 0)];
  };

  // Поза покоя MDX исчерпывается pivot'ом: повороты и масштаб узлов в покое
  // единичны, а обратная привязка выводится из позы (inverseBind: null) — это
  // и раньше делалось неявно, теперь просто сказано вслух. Формат, где поза
  // богаче (glTF), заполнит все три канала и матрицы привязки сам.
  const bones: NormalizedBone[] = nodes.map((n, i) =>
    Object.freeze({
      index: i,
      name: n.Name,
      // Parent ссылается на ObjectId; нерезолвящийся родитель = корень (-1)
      parentIndex: n.Parent != null ? (boneIndexById.get(n.Parent) ?? -1) : -1,
      position: Object.freeze(localPivot(n)),
      rotation: Object.freeze([0, 0, 0, 1] as [number, number, number, number]),
      scale: Object.freeze([1, 1, 1] as [number, number, number]),
      inverseBind: null,
    }),
  );

  const materials = buildMaterials(mdl);

  // ==========================================================================
  // B. Меши: по одному на геосет, скрытые манифестом здесь не выкидываются.
  // Скиннинг MDX — группы VertexGroup -> Groups (списки ObjectId), веса
  // равномерные по числу костей группы (максимум 4).
  // ==========================================================================
  const meshes: NormalizedMesh[] = mdl.Geosets.map((g, gi) => {
    const vcount = g.Vertices.length / 3;
    const skinIndices = new Uint16Array(vcount * 4);
    const skinWeights = new Float32Array(vcount * 4);

    for (let v = 0; v < vcount; v++) {
      const grp = g.Groups[g.VertexGroup[v] ?? 0] ?? [];
      const n = Math.min(grp.length, 4);
      for (let k = 0; k < n; k++) {
        skinIndices[v * 4 + k] = boneIndexById.get(grp[k]!) ?? 0;
        skinWeights[v * 4 + k] = 1 / n;
      }
      // вершина без группы: жёсткая привязка к кости 0, иначе схлопнется в ноль
      if (n === 0) skinWeights[v * 4] = 1;
    }

    return Object.freeze({
      partId: gi,
      positions: g.Vertices,
      normals: g.Normals && g.Normals.length === g.Vertices.length ? g.Normals : null,
      uvs: g.TVertices[0] ?? null,
      indices: g.Faces,
      skinIndices,
      skinWeights,
      materialIndex: g.MaterialID >= 0 && g.MaterialID < materials.length ? g.MaterialID : 0,
    });
  });

  // ==========================================================================
  // C. Секвенции: ключи каналов режутся по окну [s0, s1] и переводятся в
  // секунды от начала секвенции; Translation получает прибавку rest-pivot.
  // ==========================================================================
  const alphaByGeoset = new Map<number, MdlModel.AnimVector | number>();
  for (const ga of mdl.GeosetAnims ?? []) {
    alphaByGeoset.set(ga.GeosetId, ga.Alpha);
  }

  const sequences: NormalizedSequence[] = mdl.Sequences.map((seq) => {
    const s0 = seq.Interval[0] ?? 0;
    const s1 = seq.Interval[1] ?? 0;
    const dur = Math.max((s1 - s0) / MS_PER_SECOND, 0.001);

    const boneTracks: BoneTrack[] = [];
    nodes.forEach((n, i) => {
      const position = channelInWindow(n.Translation, s0, s1, 3, bones[i]!.position);
      const rotation = channelInWindow(n.Rotation, s0, s1, 4);
      const scale = channelInWindow(n.Scaling, s0, s1, 3);
      if (!position && !rotation && !scale) return;
      // Поля BoneTrack readonly (ASSET-5), поэтому каналы подмешиваются
      // спредом при конструировании, а не дописываются после.
      boneTracks.push(
        Object.freeze({
          boneIndex: i,
          ...(position ? { position: Object.freeze(position) } : {}),
          ...(rotation ? { rotation: Object.freeze(rotation) } : {}),
          ...(scale ? { scale: Object.freeze(scale) } : {}),
        }),
      );
    });

    const partVisibility: PartVisibilityTrack[] = [];
    mdl.Geosets.forEach((_g, gi) => {
      const alpha = alphaByGeoset.get(gi);
      if (!isAnimatedAlpha(alpha)) return; // одноключевые placeholder'ы игнорируем
      const { times, visible } = buildVisibilityTrack(alpha, s0, s1, dur);
      partVisibility.push(Object.freeze({ partId: gi, times, visible }));
    });

    return Object.freeze({
      name: seq.Name,
      duration: dur,
      boneTracks: Object.freeze(boneTracks),
      partVisibility: Object.freeze(partVisibility),
    });
  });

  // ==========================================================================
  // D. Слоты текстур: Image как слот-ссылка, пустой Image — слот без источника.
  //
  // Пустой путь в MDX — это replaceable-слот (ReplaceableId: team color,
  // цвет игрока и т.п.). Такие слоты приезжают сюда как `source: 'none'` и
  // остаются в списке ради сквозной нумерации (см. `TextureSlotRef`), но САМ
  // ReplaceableId в нормализованную модель не переносится: это WC3-понятие,
  // рендеру его сегодня некуда деть. Понадобится team color — вернётся
  // отдельной фичей (со своей моделью «слот красится параметром инстанса», а не
  // голым числом из MDX); спекулятивно обобщать один неиспользуемый
  // идентификатор мы не стали.
  //
  // Встроенных изображений у MDX не бывает — текстуры WC3 всегда отдельный
  // файл, — поэтому вариант `source: 'embedded'` здесь и не возникает.
  // ==========================================================================
  const textureSlots: TextureSlotRef[] = mdl.Textures.map((t, i) =>
    Object.freeze(
      t.Image
        ? ({ slot: i, source: 'file', path: t.Image } as const)
        : ({ slot: i, source: 'none' } as const),
    ),
  );

  // ==========================================================================
  // E. Высота bbox по Z — для нормализации масштаба инстанса рендером.
  // ==========================================================================
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const g of mdl.Geosets) {
    const arr = g.Vertices;
    for (let k = 2; k < arr.length; k += 3) {
      const z = arr[k]!;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const height = Math.max(maxZ - minZ, 1e-3);

  // Ассет разделяется всеми инстансами (ASSET-5): корень и все контейнеры
  // замораживаем, чтобы случайная запись в поле модели падала, а не тихо
  // портила данные соседям. Содержимое TypedArray заморозить невозможно —
  // см. оговорку в model.ts.
  return Object.freeze({
    bones: Object.freeze(bones),
    meshes: Object.freeze(meshes),
    sequences: Object.freeze(sequences),
    materials: Object.freeze(materials),
    textureSlots: Object.freeze(textureSlots),
    height,
  });
}

/** Загрузчик MDX для реестра сервиса (ASSET-3). */
export const mdxLoader: AssetLoader<NormalizedModel> = {
  kind: 'model',
  extensions: ['.mdx'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): NormalizedModel {
    let mdl: MdlModel.Model;
    try {
      mdl = parseMDX(bytes);
    } catch (e) {
      throw new Error(
        `ассет "${ctx.id}": не удалось распарсить MDX — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return normalizeMdx(mdl);
  },
};
