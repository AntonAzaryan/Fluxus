/**
 * Нормализованная модель — рендер-агностичное и ФОРМАТНО-НЕЙТРАЛЬНОЕ
 * представление (ASSET-5). Описывает только то, что потребляет рендер: меши со
 * скинингом, скелет, клипы, материалы, слоты текстур. Специфика исходного
 * формата (структура MDX, окна секвенций, правила geoset-альфы; у glTF — свои
 * accessors и primitives) остаётся внутри загрузчика.
 *
 * КАНОНИЧЕСКОЕ ПРОСТРАНСТВО МОДУЛЯ: правая тройка, ось Z вверх, одна единица
 * длины модели = одна мировая единица. Приведение к нему — обязанность
 * загрузчика: формат с Y-вверх конвертируется при разборе, а не при построении
 * инстанса. Соглашение зафиксировано именно здесь, потому что негласное оно
 * наследуется от первого поддержанного формата и ломается на втором. Z-вверх
 * выбрано не ради MDX, а потому что в нём уже живут террейн (высота — Z),
 * процедурный контроль костей и рендер.
 *
 * Ассет разделяется всеми инстансами, поэтому модель иммутабельна: все поля и
 * массивы объявлены `readonly`, а загрузчик замораживает контейнеры через
 * `Object.freeze`. Инстансы строят из этих данных свои пер-инстансные и
 * GPU-объекты, не трогая исходник.
 *
 * ЧЕСТНАЯ ОГОВОРКА: содержимое TypedArray заморозить нельзя — `Object.freeze`
 * на типизированном массиве бросает TypeError, а `readonly Float32Array` в TS
 * не существует (индексная запись типами не запрещается). Поэтому защита здесь
 * двухслойная и неполная: типы и заморозка КОНТЕЙНЕРОВ (объектов и массивов)
 * гарантируются, а неизменность байтов внутри буферов остаётся дисциплиной
 * потребителя. Имитировать заморозку буферов (копии, Proxy) мы не стали:
 * копирование убило бы главный смысл разделяемого ассета — единственный буфер
 * на все инстансы.
 */
import type { DecodedImage } from './image.js';

export interface NormalizedModel {
  /** Индекс в массиве = boneIndex в треках и skinIndices. */
  readonly bones: readonly NormalizedBone[];
  /**
   * По одному мешу на часть модели (геосет в MDX, primitive в glTF). Скрытые
   * через `hiddenParts` манифеста здесь НЕ выкидываются — фильтрация видимости
   * по манифесту дело рендера.
   */
  readonly meshes: readonly NormalizedMesh[];
  readonly sequences: readonly NormalizedSequence[];
  /** Материалы модели; меш ссылается на них по индексу. */
  readonly materials: readonly NormalizedMaterial[];
  /** Слоты текстур модели; скины подменяют их по номеру. */
  readonly textureSlots: readonly TextureSlotRef[];
  /** Высота bbox по Z (канонической вертикали) — для нормализации масштаба. */
  readonly height: number;
}

/**
 * Узел скелета с ПОЛНОЙ позой покоя. Позиция локальна относительно родителя
 * (у корня, `parentIndex === -1`, — глобальная), поворот — кватернион
 * `(x, y, z, w)`, масштаб покомпонентный.
 *
 * Поза покоя не сводится к одной трансляции, даже если у первого поддержанного
 * формата это так: у MDX узлы в покое без поворотов, у glTF повороты и масштаб
 * в узлах — норма, и представление «только pivot» молча теряло бы позу.
 */
export interface NormalizedBone {
  readonly index: number;
  readonly name: string;
  readonly parentIndex: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  /**
   * Матрица обратной привязки скининга, 16 чисел column-major, или null.
   *
   * null означает «выводится из позы покоя» — то, что для MDX делается неявно
   * и верно. Форматы, где привязка задана явно (glTF `inverseBindMatrices`),
   * обязаны её заполнить: там она сплошь и рядом не совпадает с позой покоя,
   * и вывод из позы даёт искажённый скининг.
   */
  readonly inverseBind: Float32Array | null;
}

export interface NormalizedMesh {
  /**
   * Индекс части в исходной модели — им оперируют манифест (`hiddenParts`) и
   * треки видимости. Что именно считать «частью», решает загрузчик формата.
   */
  readonly partId: number;
  readonly positions: Float32Array;
  /** null, если в модели нормалей нет или их длина не совпадает с позициями. */
  readonly normals: Float32Array | null;
  readonly uvs: Float32Array | null;
  readonly indices: Uint16Array | Uint32Array;
  /** 4 индекса кости на вершину. */
  readonly skinIndices: Uint16Array;
  /** 4 веса на вершину, нормированы (сумма = 1). */
  readonly skinWeights: Float32Array;
  /** Индекс в `materials`. */
  readonly materialIndex: number;
}

/**
 * Материал в терминах metallic/roughness — пересечение того, что описывает ядро
 * современных форматов, и того, что напрямую ложится на материал рендера: ни
 * трансляции, ни потерь.
 *
 * Карты ссылаются на НОМЕР СЛОТА текстуры, а не на путь. Слот — строка таблицы
 * `textureSlots`, и именно её подменяет скин манифеста (ASSET-6). Так материалы
 * и скины сосуществуют без второго механизма подмены, а скин заодно может
 * подменить не только базовый цвет, но и карту нормалей.
 */
export interface NormalizedMaterial {
  /**
   * RGBA-множитель базового цвета; при наличии карты умножается на неё.
   * Цветовые компоненты ЛИНЕЙНЫЕ (не sRGB) — как в glTF и как в рабочем
   * пространстве рендера: иначе каждый потребитель гадал бы, что ему приехало.
   */
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly baseColorTexture: number | null;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly normalTexture: number | null;
  readonly emissiveFactor: readonly [number, number, number];
  readonly emissiveTexture: number | null;
  /** `mask` отсекает по `alphaCutoff`, `blend` смешивает, `opaque` игнорирует альфу. */
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
}

export interface NormalizedSequence {
  readonly name: string;
  /** Секунды, всегда >= 0.001. */
  readonly duration: number;
  readonly boneTracks: readonly BoneTrack[];
  readonly partVisibility: readonly PartVisibilityTrack[];
}

/**
 * Как интерполировать между ключами канала. Режим приезжает из формата, а не
 * подразумевается: клип, записанный ступенчато или сплайном, выпрямленный в
 * линейный, — это тихо испорченная анимация.
 */
export type Interpolation = 'step' | 'linear' | 'cubic';

/** Ключи одного канала: времена и значения, по `dim` значений на ключ. */
export interface ChannelKeys {
  readonly times: Float32Array;
  readonly values: Float32Array;
  readonly interpolation: Interpolation;
}

/** Ключи каналов одной кости внутри секвенции; времена — секунды от её начала. */
export interface BoneTrack {
  readonly boneIndex: number;
  /**
   * 3 значения на ключ; значения УЖЕ абсолютные локальные позиции —
   * позиция покоя кости плюс смещение ключа (в MDX это Translation).
   */
  readonly position?: ChannelKeys;
  /** Кватернионы, 4 значения на ключ. */
  readonly rotation?: ChannelKeys;
  /** 3 значения на ключ. */
  readonly scale?: ChannelKeys;
}

/**
 * Видимость части модели в секвенции: 0/1, ступенчато. Концевые ключи `t=0` и
 * `t=duration` присутствуют всегда, времена строго возрастают — секвенция
 * полностью задаёт состояние части и не «наследует» его от предыдущего клипа.
 * Из чего трек добывается (geoset-альфа в MDX и т.п.) — дело загрузчика.
 */
export interface PartVisibilityTrack {
  readonly partId: number;
  readonly times: Float32Array;
  readonly visible: Uint8Array;
}

/**
 * Слот текстуры модели — РАЗМЕЧЕННОЕ ОБЪЕДИНЕНИЕ по полю `source` (ASSET-5).
 * Источником пикселей слота бывает файл дерева контента, встроенное в сам файл
 * модели изображение, либо ничего.
 *
 * Почему объединение, а не «путь плюс необязательные пиксели»: два
 * необязательных поля допускают состояние «заданы оба», у которого нет смысла,
 * и каждый потребитель изобретал бы своё правило приоритета. Размеченное
 * объединение делает невыразимым то, чего не бывает, и заставляет `switch`
 * по `source` пройти все три случая — компилятор проверит полноту.
 *
 * СКВОЗНАЯ НУМЕРАЦИЯ: `slot` — номер строки в `textureSlots`, и он не зависит
 * от вида источника. Слот без источника из списка не выкидывается, иначе
 * поехали бы номера соседей: скины манифеста подменяют текстуру по НОМЕРУ
 * слота (`rendering` REND-6), а материалы (`NormalizedMaterial`) по нему же
 * ссылаются на свои карты.
 */
export type TextureSlotRef = TextureSlotFile | TextureSlotEmbedded | TextureSlotNone;

/** Слот-ссылка: пиксели лежат отдельным файлом дерева контента. */
export interface TextureSlotFile {
  readonly slot: number;
  readonly source: 'file';
  /**
   * Путь от корня дерева контента (ASSET-2), уже разрешённый загрузчиком
   * относительно ID модели (ASSET-3) — потребителю остаётся запросить его
   * ассетом вида `texture`.
   */
  readonly path: string;
}

/**
 * Слот со встроенным изображением: пиксели приехали внутри самого файла модели
 * (формат-контейнер вроде `.glb`) и уже декодированы.
 *
 * Декодирование сделано ЗАГРУЗЧИКОМ — один раз на ассет, а не на инстанс:
 * ассет существует ровно затем, чтобы дорогая работа разделялась всеми
 * потребителями (ASSET-5, то же самое там сказано про недекодированные байты).
 */
export interface TextureSlotEmbedded {
  readonly slot: number;
  readonly source: 'embedded';
  readonly image: DecodedImage;
}

/**
 * Слот без источника: объявлен, но пикселей за ним нет. Так выглядят
 * replaceable-слоты MDX (team color, цвет игрока) и встроенное изображение
 * формата, для которого в модуле нет декодера. Потребитель оставляет карту
 * материала пустой — но номер слота занят и подменяем скином, как любой другой.
 */
export interface TextureSlotNone {
  readonly slot: number;
  readonly source: 'none';
}
