/**
 * Запечённые производные модели (ASSET-12): данные, посчитанные заранее из
 * нормализованного представления (ASSET-5) ради стоимости кадра батчевого
 * яруса (`rendering` REND-20).
 *
 * Здесь живут производные САМОЙ МОДЕЛИ — те, что разделяются всеми её
 * инстансами и всеми записями манифеста, которые на неё ссылаются:
 *
 * - **bone-VAT**: матрицы скининга костей по кадрам, разложенные текстурными
 *   данными, — по ним скиннинг выполняется на GPU без пер-инстансного скелета;
 * - **таблица клипов**: смещение, длительность и зацикленность каждой
 *   секвенции, согласованные с раскладкой VAT;
 * - **консервативные границы по всем клипам** — вход отсечения (REND-21);
 * - **маска видимости частей по кадрам**: то, что у детального яруса делает
 *   `BooleanKeyframeTrack`, здесь становится данными кадра (design, Risks).
 *
 * Здесь — формат производных и проход по кадрам, который их наполняет; поза
 * скелета в момент времени живёт в `pose.ts`, границы и маска видимости — в
 * `clipCoverage.ts`, матрицы — в `mat4.ts`.
 *
 * Производные записи манифеста (набор вариантов скинов) живут отдельно —
 * `skinVariants.ts`: они производны от ЗАПИСИ (ASSET-6), а не от модели, и
 * разделяются не теми же потребителями. LOD-цепочки (ASSET-12, REND-22) здесь
 * пока нет — она приходит вместе с выбором уровня, а не раньше него.
 *
 * Модуль остаётся рендер-агностичным (ASSET-5): наружу идут TypedArray и
 * описания раскладки, а не объекты GPU-API. Ни THREE, ни браузера, ни GPU —
 * запекание считается и проверяется в Node.
 *
 * ДЕТЕРМИНИЗМ (ASSET-12) держится тем, что запекание — чистая функция входа и
 * параметров: фиксированная частота сэмплирования, никакого `Date.now`,
 * никакого рандома, никакого обхода неупорядоченных структур. Одинаковый вход
 * даёт побитово одинаковые буферы — иначе кэш и сверка артефактов теряют смысл.
 *
 * Математика — обычный double: модуль presentation-стороны, запрет float
 * действует на симуляцию, в которую отсюда хода нет (ASSET-1).
 */
import type { NormalizedMesh, NormalizedModel, NormalizedSequence } from './model.js';
import { bakePartVisibility, boneRadii, emptyBounds, growBoundsByBone } from './clipCoverage.js';
import { multiplyMat4 } from './mat4.js';
import { TRS_STRIDE, inverseBindOf, poseAt, restPose, type PoseScratch } from './pose.js';
import type { ModelSurfaceBounds } from './surface.js';

// ------------------------------------------------------------------ формат

/**
 * Текселей RGBA32F на матрицу одной кости: четыре столбца матрицы 4×4. Матрица
 * аффинная (3×4 плюс дополняющий столбец), но столбцами она читается вершинным
 * шейдером одной выборкой на тексель — и раскладка называется тем, что в ней
 * лежит, а не тем, сколько в ней смысла.
 */
export const VAT_TEXELS_PER_BONE = 4;

/** Частота сэмплирования клипов по умолчанию, кадров в секунду. */
export const DEFAULT_BAKE_FPS = 30;

/** Параметры запекания — часть его входа: детерминизм считается по паре (модель, параметры). */
export interface BakeParams {
  /**
   * Частота сэмплирования клипов, кадров в секунду. Шаг кадров ровно `1/fps`:
   * потребителю остаётся перевести фазу клипа в номер строки умножением, а не
   * поиском по таблице времён.
   */
  readonly fps?: number;
}

/**
 * Bone-VAT: матрицы скининга костей по кадрам. Строка текстуры — кадр, в строке
 * подряд лежат кости в порядке индексов модели, по `VAT_TEXELS_PER_BONE`
 * текселей на кость.
 *
 * Матрица кости — `boneWorld × inverseBind`, то есть ровно то, чем скининг
 * умножает вершину: вершинному шейдеру не остаётся ни иерархии, ни привязки.
 */
export interface BoneVat {
  /** Ширина в текселях: `boneCount × VAT_TEXELS_PER_BONE`. */
  readonly width: number;
  /** Высота в текселях: всего кадров (строка покоя плюс кадры всех клипов). */
  readonly height: number;
  readonly boneCount: number;
  /** RGBA32F подряд: `width × height × 4` значений, строка за строкой. */
  readonly data: Float32Array;
}

/**
 * Клип в раскладке VAT. `offset` — номер первой строки, `length` — сколько
 * строк занято; время кадра `k` клипа — `k / fps`, обрезанное длительностью.
 */
export interface BakedClip {
  /** Имя секвенции модели: по нему запись манифеста и находит клип (REND-4). */
  readonly name: string;
  readonly offset: number;
  readonly length: number;
  /** Длительность секвенции, секунды. */
  readonly duration: number;
  /**
   * Клип замкнут: поза последнего кадра совпадает с позой первого, и
   * зацикленное воспроизведение не даёт скачка. Это СВОЙСТВО ДАННЫХ, а не
   * политика воспроизведения — зацикливать ли клип, решает рендер по таблице
   * записи манифеста (REND-4), и здесь ему сообщают лишь то, чего он сам о
   * запечённых кадрах не знает.
   */
  readonly loop: boolean;
}

/**
 * Маска видимости частей по кадрам. Бит `j` кадра `f` — видима ли часть
 * `parts[j]`. То же, что трек видимости даёт детальному ярусу, но для батчевой
 * записи, у которой отдельного меша на часть нет.
 */
export interface BakedPartVisibility {
  /** Идентификаторы частей (`NormalizedMesh.partId`) в порядке битов. */
  readonly parts: readonly number[];
  /** Слов по 32 бита на кадр: `ceil(parts.length / 32)`. */
  readonly wordsPerFrame: number;
  /** `wordsPerFrame × frameCount` слов, кадр за кадром. */
  readonly mask: Uint32Array;
}

/**
 * Уровень LOD-цепочки (ASSET-12, `rendering` REND-22): упрощённые геометрии тех
 * же частей модели. Отдельный тип, а не голый массив мешей, — уровню предстоит
 * обрасти собственными данными (порог автора, бюджет), и менять при этом
 * сигнатуру производных не придётся.
 */
export interface BakedLodLevel {
  readonly meshes: readonly NormalizedMesh[];
}

/** Запечённые производные одной модели (ASSET-12). */
export interface BakedDerivatives {
  /** Частота сэмплирования, с которой запечены кадры. */
  readonly fps: number;
  readonly vat: BoneVat;
  /** Клипы в порядке секвенций модели. */
  readonly clips: readonly BakedClip[];
  /**
   * Строка позы покоя — она же поза модели без клипов вовсе. Всегда есть:
   * запись, которой клип не назначен (decoration, REND-18), должна быть чем-то
   * нарисована, а «нет кадра» такой записи не бывает.
   */
  readonly restFrame: number;
  /** Консервативные границы по всем кадрам всех клипов — вход REND-21. */
  readonly bounds: ModelSurfaceBounds;
  readonly partVisibility: BakedPartVisibility;
  /**
   * Цепочка уровней детализации от грубого к грубейшему (`rendering` REND-22);
   * пустая — у модели цепочки нет, и рисуется она единственным уровнем. Данные
   * приходят из модели (`NormalizedModel.lodMeshes`) как есть: запекание их не
   * ПОРОЖДАЕТ — децимация геометрии авторская работа, а не производная.
   */
  readonly lod: readonly BakedLodLevel[];
}

/**
 * Ответ на запрос производных (ASSET-12): они есть — либо их нет, и отсутствие
 * НАЗВАНО. Молчаливого `null` здесь нет намеренно: рендер обязан предупредить
 * об отсутствии один раз на модель (REND-20), а предупреждение без причины
 * ничего не сообщает.
 */
export type ModelDerivatives =
  | { readonly ok: true; readonly derivatives: BakedDerivatives }
  | { readonly ok: false; readonly reason: string };

// ------------------------------------------------------------- запекание

/**
 * Запекает производные модели (ASSET-12). Чистая функция: одинаковый вход и
 * одинаковые параметры дают побитово одинаковый результат.
 *
 * Модель без костей запечь нечем — скиннинг батчевого яруса выполняется по
 * матрицам костей, и без скелета их взять неоткуда; такая модель остаётся
 * употребимой детальным ярусом (REND-20), и `bakeDerivatives` называет причину.
 */
export function bakeDerivatives(model: NormalizedModel, params: BakeParams = {}): ModelDerivatives {
  const fps = params.fps ?? DEFAULT_BAKE_FPS;
  if (!(fps > 0) || !Number.isFinite(fps)) {
    return { ok: false, reason: `частота сэмплирования должна быть положительной, получено ${fps}` };
  }
  const boneCount = model.bones.length;
  if (boneCount === 0) {
    return { ok: false, reason: 'у модели нет костей: матрицы скининга брать неоткуда' };
  }

  // A. Раскладка кадров: строка покоя, затем клипы подряд в порядке секвенций.
  const clips: BakedClip[] = [];
  let frameCount = 1;
  for (const sequence of model.sequences) {
    const length = frameLengthOf(sequence.duration, fps);
    clips.push({
      name: sequence.name,
      offset: frameCount,
      length,
      duration: sequence.duration,
      loop: false, // проставляется по запечённым кадрам ниже
    });
    frameCount += length;
  }

  // B. Поза покоя и обратная привязка — общий вход всех кадров.
  const rest = restPose(model);
  const inverseBind = inverseBindOf(model, rest);

  const vat: BoneVat = {
    width: boneCount * VAT_TEXELS_PER_BONE,
    height: frameCount,
    boneCount,
    data: new Float32Array(boneCount * VAT_TEXELS_PER_BONE * 4 * frameCount),
  };

  // C. Границы: радиус влияния кости считается один раз по бинд-позе, а по
  // кадрам двигается только её сфера (см. `boneRadii`).
  const radii = boneRadii(model, inverseBind);
  const bounds = emptyBounds();

  // Скретчи запекания живут на весь проход: кадров у клипов сотни, и заводить
  // на каждый свои буферы значило бы платить за запекание мусором.
  const scratch: PoseScratch = {
    trs: new Float64Array(boneCount * TRS_STRIDE),
    local: new Float64Array(16),
    done: new Uint8Array(boneCount),
  };
  const world = new Float64Array(boneCount * 16);
  const skin = new Float64Array(16);

  const writeFrame = (row: number, sequence: NormalizedSequence | null, time: number): void => {
    poseAt(model, rest, sequence, time, scratch, world);
    for (let bone = 0; bone < boneCount; bone++) {
      multiplyMat4(world, bone * 16, inverseBind, bone * 16, skin, 0);
      writeBoneTexels(vat, row, bone, skin);
      growBoundsByBone(bounds, world, bone * 16, radii[bone]!);
    }
  };

  writeFrame(0, null, 0);
  model.sequences.forEach((sequence, i) => {
    const clip = clips[i]!;
    for (let k = 0; k < clip.length; k++) {
      writeFrame(clip.offset + k, sequence, Math.min(k / fps, sequence.duration));
    }
  });

  // D. Замкнутость клипа — сравнение запечённых кадров, а не догадка о формате.
  const closed = clips.map((clip) => framesEqual(vat, clip.offset, clip.offset + clip.length - 1));

  return {
    ok: true,
    derivatives: {
      fps,
      vat,
      clips: clips.map((clip, i) => ({ ...clip, loop: closed[i]! })),
      restFrame: 0,
      bounds: { min: [bounds[0]!, bounds[1]!, bounds[2]!], max: [bounds[3]!, bounds[4]!, bounds[5]!] },
      partVisibility: bakePartVisibility(model, clips, fps, frameCount),
      // Цепочка переносится из модели как есть: уровня, которого в данных нет,
      // запекание не выдумывает (REND-22 — модель без цепочки рисуется одним
      // уровнем, и это прежнее поведение).
      lod: (model.lodMeshes ?? []).map((meshes) => ({ meshes })),
    },
  };
}

/**
 * Сколько кадров занимает клип длительности `duration` при частоте `fps`. Шаг
 * ровно `1/fps`, последний кадр лежит на конце клипа или сразу за ним (время
 * кадра обрезается длительностью) — так фаза переводится в номер строки
 * умножением, а клип нулевой длины остаётся одним кадром.
 */
function frameLengthOf(duration: number, fps: number): number {
  if (!(duration > 0)) return 1;
  return Math.max(1, Math.round(duration * fps)) + 1;
}

// ------------------------------------------------------------------ VAT

/** Матрица кости в строку кадра: четыре текселя — четыре столбца матрицы. */
function writeBoneTexels(vat: BoneVat, row: number, bone: number, matrix: Float64Array): void {
  const base = (row * vat.width + bone * VAT_TEXELS_PER_BONE) * 4;
  for (let k = 0; k < 16; k++) vat.data[base + k] = matrix[k]!;
}

/** Совпадают ли две строки VAT побитово — этим и определяется замкнутость клипа. */
function framesEqual(vat: BoneVat, a: number, b: number): boolean {
  if (a === b) return true;
  const stride = vat.width * 4;
  const baseA = a * stride;
  const baseB = b * stride;
  for (let k = 0; k < stride; k++) {
    if (vat.data[baseA + k] !== vat.data[baseB + k]) return false;
  }
  return true;
}

// --------------------------------------------------------------- кэш

/**
 * Кэш производных по идентичности ассета (ASSET-2, ASSET-12): запекание — один
 * раз на модель, а не на инстанс и не на потребителя. Ключ — сам объект модели,
 * поэтому производные умирают вместе с ассетом, а не переживают его.
 */
const derivativesCache = new WeakMap<NormalizedModel, Map<string, ModelDerivatives>>();

/**
 * Производные модели из кэша; при первом запросе — запекает (ASSET-12).
 * Одинаковый вход даёт ТОТ ЖЕ объект: разделение производных потребителями этим
 * и наблюдаемо, а десять батчевых инстансов одной модели не запекают ничего
 * по десять раз.
 */
export function modelDerivatives(
  model: NormalizedModel,
  params: BakeParams = {},
): ModelDerivatives {
  let byParams = derivativesCache.get(model);
  if (byParams === undefined) {
    byParams = new Map();
    derivativesCache.set(model, byParams);
  }
  const signature = String(params.fps ?? DEFAULT_BAKE_FPS);
  let baked = byParams.get(signature);
  if (baked === undefined) {
    baked = bakeDerivatives(model, params);
    byParams.set(signature, baked);
  }
  return baked;
}
