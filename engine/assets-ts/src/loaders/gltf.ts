/**
 * Загрузчик glTF 2.0 поверх ручного разбора JSON — без THREE.js и DOM
 * (ASSET-5), в духе `mdxLoader`. Разбирает обе упаковки одного и того же
 * формата:
 *
 * - `.gltf` — JSON плюс внешний `.bin` (геометрия/скелет/анимации) и внешние
 *   `.png`-текстуры, читаемые через `ctx.read` относительно ID модели (ASSET-3);
 * - `.glb` — двоичный контейнер: 12-байтовый заголовок, чанк JSON и чанк BIN,
 *   то есть ровно те же JSON и буфер, что у `.gltf` лежат по разным файлам.
 *   Изображения внутри контейнера декодируются здесь же и приезжают в модель
 *   встроенными слотами (`TextureSlotEmbedded`) — распаковывать `.glb` на
 *   части руками больше не нужно.
 *
 * Загрузчик один на оба расширения, и вид упаковки определяется СИГНАТУРОЙ
 * СОДЕРЖИМОГО (`glTF`), а не именем файла: второй загрузчик означал бы две
 * реализации одного формата, которые неизбежно разъедутся, а имя файла — не
 * свойство данных.
 *
 * ПОДДЕРЖАННОЕ ПОДМНОЖЕСТВО (осознанно уже, чем весь glTF 2.0):
 * - Один буфер: внешний (`buffers[0].uri`), BIN-чанк контейнера либо
 *   base64-data-URI внутри самого JSON — три упаковки одного и того же буфера,
 *   и все три отдаёт штатный экспортёр Blender («Separate», «Binary»,
 *   «Embedded»). Sparse-accessor'ы не разбираются — внятная ошибка вместо
 *   молчаливой потери данных.
 * - Из встроенных изображений (BIN-чанк или data-URI) декодируется PNG
 *   (модульный `decodePng`); формат без декодера (JPEG) даёт слот без источника
 *   и предупреждение.
 * - Примитивы TRIANGLES (mode по умолчанию); каждый primitive — отдельная ЧАСТЬ
 *   модели (`NormalizedMesh`), как геосет в MDX: экспортёр режет меш по
 *   материалам, и взять из mesh только первый primitive значило бы тихо потерять
 *   геометрию всех прочих материалов.
 * - Интерполяция каналов LINEAR и STEP переносятся как есть; CUBICSPLINE
 *   упрощается до LINEAR по значению ключа (без внутренней/внешней
 *   касательной) — как и `mdxLoader` для Hermite/Bezier, это фиксация
 *   поведения, а не потеря: играна она и так была бы линейно.
 *
 * КОНВЕРТАЦИЯ ОСЕЙ (module.ts: канон — правая тройка, Z вверх): glTF — правая
 * тройка, Y вверх. Свойство ЛОКАЛЬНЫХ трансформаций твёрдой иерархии узлов:
 * поворот всей сцены на фиксированную Mc не меняет ЛОКАЛЬНЫЕ TRS дочерних
 * узлов относительно родителя (мировые матрицы у обоих отличаются на Mc
 * слева на каждом уровне, а при вычислении Local = World(parent)^-1 · World
 * этот множитель схлопывается). Меняются только: (1) TRS настоящих корневых
 * узлов (без родителя) — им Mc применяется явно; (2) сырые вершинные данные
 * (position/normal) — они не часть цепочки локальных трансформаций, а точки
 * в bind-пространстве, и Mc к ним применяется напрямую; (3) inverseBind —
 * матрица, отображающая bind-пространство в пространство сустава, домножается
 * на Mc⁻¹ справа, чтобы компенсировать переход bind-пространства. Доказательство
 * (World_new(n) = Mc · World_orig(n) индукцией по глубине, отсюда и все три
 * правила) — в design-заметках приложения; здесь только код.
 *
 * РАСКЛАДКА ПО МОДУЛЯМ. Здесь — сборка модели из стадий и сам загрузчик реестра;
 * форма файла и разбор контейнера — `gltfDocument.ts`, чтение accessor'ов —
 * `gltfAccessor.ts`, арифметика конвертации — `gltfMath.ts`, части модели —
 * `gltfMesh.ts`, секвенции — `gltfAnimation.ts`. Формат один, и заголовок у
 * него один — этот.
 */
import type { AssetLoader, LoaderContext } from '../types.js';
import type {
  NormalizedBone,
  NormalizedMaterial,
  NormalizedModel,
  TextureSlotRef,
} from '../model.js';
import type { DecodedImage } from '../image.js';
import { resolveDependencyPath } from '../service.js';
import { freezeNormalizedModel, heightOfPositions } from './normalized.js';
import { decodePng, isPng } from './png.js';
import { readAccessor } from './gltfAccessor.js';
import {
  MC_INVERSE,
  MC_QUAT,
  axisConvertVec3,
  mat4Compose,
  mat4Multiply,
  quatMultiply,
  type Mat4,
} from './gltfMath.js';
import { normalizeMeshes } from './gltfMesh.js';
import { normalizeSequences } from './gltfAnimation.js';
import { dataUriBytes, isDataUri, isGlb, parseGlb } from './gltfDocument.js';
import type { GltfDocument, GltfImage, GltfMaterial, GltfNode } from './gltfDocument.js';
import { reasonOf } from '../validation.js';

// ============================================================= normalize

/** Индекс родителя каждого узла из `children[]` (glTF не хранит обратную ссылку). */
function buildParentIndex(nodes: readonly GltfNode[]): Int32Array {
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    for (const child of n.children ?? []) parent[child] = i;
  });
  return parent;
}

/** Мировые матрицы покоя всех узлов в СЫРОМ (Y-вверх) пространстве — для запекания экипировки. */
function buildRestWorldMatrices(nodes: readonly GltfNode[], parent: Int32Array): Mat4[] {
  const local = nodes.map((n) =>
    mat4Compose(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]),
  );
  const world = new Array<Mat4 | undefined>(nodes.length);
  // Родитель всегда имеет меньший индекс, чем ребёнок, в порядке glTF? Гарантии
  // нет — обходим по возрастанию и на лету пере-вычисляем, если родитель ещё не готов.
  const resolve = (i: number): Mat4 => {
    if (world[i] !== undefined) return world[i];
    const p = parent[i]!;
    const m = p === -1 ? local[i]! : mat4Multiply(resolve(p), local[i]!);
    world[i] = m;
    return m;
  };
  return nodes.map((_n, i) => resolve(i));
}

/**
 * Байты изображения, лежащего внутри буфера (`.glb` или общий `.bin`).
 * Возвращает null, если ссылка битая: это повод для предупреждения, а не для
 * отказа грузить модель целиком.
 */
function imageBytes(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  bufferViewIndex: number,
): Uint8Array | null {
  const bv = doc.bufferViews[bufferViewIndex];
  if (bv == null) return null;
  const buffer = buffers[bv.buffer];
  if (buffer == null) return null;
  const start = bv.byteOffset ?? 0;
  return buffer.subarray(start, start + bv.byteLength);
}

/**
 * Сила эмиссии материала (ASSET-5) — из расширения
 * `KHR_materials_emissive_strength`. Умолчание расширения и умолчание отсутствия
 * расширения совпадают и равны 1: файл без него обязан давать вид байт-в-байт
 * как до появления поля.
 *
 * Значение, не являющееся конечным неотрицательным числом, читается как 1: у
 * отрицательной силы прочтения нет вовсе (она вывернула бы эмиссию в
 * отрицательный цвет), а сверху границы нет — единица и есть точка, за которой
 * начинается HDR-свечение, пересекающее порог bloom (`rendering` REND-34).
 */
function emissiveStrengthOf(material: GltfMaterial | undefined): number {
  const strength = material?.extensions?.KHR_materials_emissive_strength?.emissiveStrength;
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0) return 1;
  return strength;
}

/**
 * Декодирование встроенных изображений — ОДИН РАЗ НА АССЕТ и один раз на
 * изображение: несколько текстур могут ссылаться на один `images[i]`, и второй
 * прогон декодера дал бы вторую копию пикселей у того же ассета.
 *
 * Формат без декодера (JPEG) и битые байты не роняют загрузку модели: слот
 * останется без источника, а причина уйдёт предупреждением. Модель без одной
 * текстуры полезнее, чем не загрузившаяся модель; отдельного канала
 * предупреждений у `LoaderContext` сегодня нет, поэтому `console.warn` — тем
 * же способом, каким `AssetService` сообщает о бросившем подписчике.
 */
/**
 * Байты встроенного изображения записи `images[i]`: base64-data-URI либо кусок
 * буфера. `null` — источника нет (внешний файл — это слот-ссылка, не наше дело)
 * либо ссылка битая; во втором случае причина уже сказана предупреждением.
 */
function embeddedImageBytes(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  image: GltfImage,
  index: number,
  assetId: string,
): Uint8Array | null {
  if (image.uri != null) {
    if (!isDataUri(image.uri)) return null; // внешний файл — слот-ссылка, не наше дело
    try {
      return dataUriBytes(image.uri);
    } catch (e) {
      console.warn(
        `ассет "${assetId}": встроенное изображение ${index} — ${reasonOf(e)}; слот останется без текстуры`,
      );
      return null;
    }
  }
  if (image.bufferView == null) return null; // пустая запись: ни файла, ни байтов
  const bytes = imageBytes(doc, buffers, image.bufferView);
  if (bytes === null) {
    console.warn(
      `ассет "${assetId}": встроенное изображение ${index} ссылается на несуществующий bufferView ${image.bufferView} — слот останется без текстуры`,
    );
  }
  return bytes;
}

/**
 * Декодирование встроенных изображений — ОДИН РАЗ НА АССЕТ и один раз на
 * изображение: несколько текстур могут ссылаться на один `images[i]`, и второй
 * прогон декодера дал бы вторую копию пикселей у того же ассета.
 *
 * Формат без декодера (JPEG) и битые байты не роняют загрузку модели: слот
 * останется без источника, а причина уйдёт предупреждением. Модель без одной
 * текстуры полезнее, чем не загрузившаяся модель; отдельного канала
 * предупреждений у `LoaderContext` сегодня нет, поэтому `console.warn` — тем
 * же способом, каким `AssetService` сообщает о бросившем подписчике.
 */
async function decodeEmbeddedImages(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  assetId: string,
): Promise<Map<number, DecodedImage>> {
  const decoded = new Map<number, DecodedImage>();
  for (const [i, image] of (doc.images ?? []).entries()) {
    const bytes = embeddedImageBytes(doc, buffers, image, i, assetId);
    if (bytes === null) continue;
    if (!isPng(bytes)) {
      console.warn(
        `ассет "${assetId}": встроенное изображение ${i} (${image.mimeType ?? 'неизвестный тип'}) — декодера нет, поддержан только PNG; слот останется без текстуры`,
      );
      continue;
    }
    // `decodePng` ждёт ArrayBuffer, а срез буфера — вид на чужой: копируем
    // ровно этот кусок, иначе декодер увидел бы соседние чанки контейнера.
    const own = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(own).set(bytes);
    try {
      decoded.set(i, await decodePng(own, `${assetId}#image${i}`));
    } catch (e) {
      console.warn(
        `ассет "${assetId}": встроенное изображение ${i} не декодировалось — ${reasonOf(e)}; слот останется без текстуры`,
      );
    }
  }
  return decoded;
}

async function normalizeGltf(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  assetId: string,
): Promise<NormalizedModel> {
  if (!doc.asset.version.startsWith('2.')) {
    throw new Error(`glTF: неподдержанная версия "${doc.asset.version}" (нужна 2.x)`);
  }
  const nodes = doc.nodes;
  const parentOf = buildParentIndex(nodes);
  const restWorld = buildRestWorldMatrices(nodes, parentOf);

  // ============================================================ A. Скелет
  //
  // Скинов в документе может быть несколько (два персонажа одним экспортом),
  // поэтому inverseBind собираются со ВСЕХ; сустав, общий для двух скинов,
  // оставляет матрицу первого — `NormalizedBone` держит одну матрицу на узел.
  const inverseBindByNode = new Map<number, Mat4>();
  for (const skin of doc.skins ?? []) {
    if (skin.inverseBindMatrices == null) continue;
    const ibm = readAccessor(doc, buffers, skin.inverseBindMatrices, false);
    skin.joints.forEach((nodeIndex, j) => {
      if (inverseBindByNode.has(nodeIndex)) return;
      const raw = Float32Array.from(ibm.values.subarray(j * 16, j * 16 + 16));
      inverseBindByNode.set(nodeIndex, mat4Multiply(raw, MC_INVERSE));
    });
  }

  const bones: NormalizedBone[] = nodes.map((n, i) => {
    const isRoot = parentOf[i] === -1;
    const rawT = n.translation ?? [0, 0, 0];
    const rawR = n.rotation ?? [0, 0, 0, 1];
    const rawS = n.scale ?? [1, 1, 1];
    const position = isRoot ? axisConvertVec3(rawT) : [...rawT];
    const rotation = isRoot ? quatMultiply(MC_QUAT, rawR) : [...rawR];
    return Object.freeze({
      index: i,
      name: n.name ?? `node${i}`,
      parentIndex: parentOf[i]!,
      position: Object.freeze(position as [number, number, number]),
      rotation: Object.freeze(rotation as [number, number, number, number]),
      scale: Object.freeze([...rawS] as [number, number, number]),
      inverseBind: inverseBindByNode.get(i) ?? null,
    });
  });

  // ============================================================= B. Меши
  const { meshes, defaultMaterialIndex, usesDefaultMaterial } = normalizeMeshes(
    doc,
    buffers,
    restWorld,
  );

  // ========================================================= C. Материалы
  const textures = doc.textures ?? [];
  const images = doc.images ?? [];
  // Строка материала по умолчанию (`undefined` — все значения из умолчаний
  // формата) добавляется в конец, если её кто-то занял, либо если своих
  // материалов у документа нет вовсе: меш обязан на что-то ссылаться.
  const materialsSource: readonly (GltfMaterial | undefined)[] =
    usesDefaultMaterial || defaultMaterialIndex === 0
      ? [...(doc.materials ?? []), undefined]
      : (doc.materials ?? []);
  const materials: NormalizedMaterial[] = materialsSource.map((m) => {
    const pbr = m?.pbrMetallicRoughness;
    return Object.freeze({
      baseColorFactor: Object.freeze((pbr?.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number]),
      baseColorTexture: pbr?.baseColorTexture?.index ?? null,
      metallicFactor: pbr?.metallicFactor ?? 1,
      roughnessFactor: pbr?.roughnessFactor ?? 1,
      normalTexture: m?.normalTexture?.index ?? null,
      emissiveFactor: Object.freeze((m?.emissiveFactor ?? [0, 0, 0]) as [number, number, number]),
      emissiveTexture: m?.emissiveTexture?.index ?? null,
      // Сила эмиссии — из расширения (ASSET-5); файл без расширения даёт 1, то
      // есть вид байт-в-байт как до появления поля. Отрицательное значение
      // расширением не описано и прочтения не имеет — оно гасило бы эмиссию в
      // отрицательный цвет; такой файл читается как «силы нет», то есть 1.
      // Наверх значение не клампится: единица и есть точка, выше которой
      // начинается HDR (REND-34).
      emissiveStrength: emissiveStrengthOf(m),
      alphaMode: m?.alphaMode === 'MASK' ? 'mask' : m?.alphaMode === 'BLEND' ? 'blend' : 'opaque',
      alphaCutoff: m?.alphaCutoff ?? 0.5,
      doubleSided: m?.doubleSided ?? false,
    });
  });

  // ====================================================== D. Слоты текстур
  //
  // Слот = индекс в `textures[]` (совпадает с тем, на что ссылаются материалы
  // выше), и номер слота от вида источника не зависит — скин подменяет по
  // номеру (REND-6). Три источника, ровно три варианта `TextureSlotRef`:
  // внешний `uri` — путь, разрешённый от ID модели (ASSET-3); `bufferView` —
  // уже декодированные пиксели контейнера; всё остальное (в том числе
  // недекодируемый формат) — слот без источника.
  const embedded = await decodeEmbeddedImages(doc, buffers, assetId);
  const textureSlots: TextureSlotRef[] = textures.map((t, slot) => {
    const image = images[t.source];
    if (image?.uri != null && !isDataUri(image.uri)) {
      return Object.freeze({
        slot,
        source: 'file' as const,
        path: resolveDependencyPath(assetId, image.uri),
      });
    }
    const pixels = embedded.get(t.source);
    if (pixels !== undefined) {
      return Object.freeze({ slot, source: 'embedded' as const, image: pixels });
    }
    return Object.freeze({ slot, source: 'none' as const });
  });

  // ======================================================== E. Секвенции
  const sequences = normalizeSequences(doc, buffers, parentOf);

  // ============================================================ F. Высота
  const height = heightOfPositions(meshes.map((mesh) => mesh.positions));

  return freezeNormalizedModel({ bones, meshes, sequences, materials, textureSlots, height });
}

/**
 * Загрузчик glTF для реестра сервиса (ASSET-3) — оба расширения одним
 * загрузчиком (см. заголовок файла). Разбор JSON и добывание буфера
 * различаются, вся нормализация — общая.
 */
export const gltfLoader: AssetLoader<NormalizedModel> = {
  kind: 'model',
  extensions: ['.gltf', '.glb'],
  async load(bytes: ArrayBuffer, ctx: LoaderContext): Promise<NormalizedModel> {
    const container = isGlb(bytes) ? parseGlb(bytes, ctx.id) : null;
    const text = container?.json ?? new TextDecoder('utf-8').decode(bytes);

    let doc: GltfDocument;
    try {
      doc = JSON.parse(text) as GltfDocument;
    } catch (e) {
      throw new Error(`ассет "${ctx.id}": не удалось распарсить glTF JSON — ${reasonOf(e)}`);
    }
    // Три упаковки одного буфера: data-URI внутри JSON, файл рядом по `uri`,
    // BIN-чанк контейнера. Буфер без `uri` — это BIN-чанк, а не ошибка: так
    // его и задаёт спецификация.
    const only = doc.buffers.length === 1 ? doc.buffers[0] : undefined;
    if (only === undefined) {
      throw new Error(`ассет "${ctx.id}": поддержан ровно один buffer, получено ${doc.buffers.length}`);
    }
    const bufferUri = only.uri;
    let buffer: Uint8Array;
    if (bufferUri != null && isDataUri(bufferUri)) {
      try {
        buffer = dataUriBytes(bufferUri);
      } catch (e) {
        throw new Error(`ассет "${ctx.id}": буфер — ${reasonOf(e)}`);
      }
    } else if (bufferUri != null) {
      buffer = new Uint8Array(await ctx.read(bufferUri));
    } else if (container?.bin != null) {
      buffer = container.bin;
    } else {
      throw new Error(`ассет "${ctx.id}": buffers[0] без внешнего uri и без BIN-чанка`);
    }

    return normalizeGltf(doc, [buffer], ctx.id);
  },
};
