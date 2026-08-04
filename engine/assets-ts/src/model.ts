/**
 * Нормализованная модель — рендер-агностичное представление (ASSET-5).
 * Описывает только то, что потребляет рендер: меши со скинингом, скелет,
 * клипы, слоты текстур. Формат-специфика (структура MDX, окна секвенций,
 * правила geoset-альфы) остаётся внутри загрузчика.
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
  /** Слоты текстур модели; скины подменяют их по номеру. */
  readonly textureSlots: readonly TextureSlotRef[];
  /** Высота bbox по Z — для нормализации масштаба инстанса рендером. */
  readonly height: number;
}

/**
 * Узел скелета. `pivot` — ЛОКАЛЬНАЯ позиция покоя относительно родителя
 * (глобальный pivot узла минус глобальный pivot родителя); у корня
 * (`parentIndex === -1`) — глобальная позиция.
 */
export interface NormalizedBone {
  readonly index: number;
  readonly name: string;
  readonly parentIndex: number;
  readonly pivot: readonly [number, number, number];
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
  /** Индекс в `textureSlots` — из материала части; при отсутствии — 0. */
  readonly textureSlot: number;
}

export interface NormalizedSequence {
  readonly name: string;
  /** Секунды, всегда >= 0.001. */
  readonly duration: number;
  readonly boneTracks: readonly BoneTrack[];
  readonly partVisibility: readonly PartVisibilityTrack[];
}

/** Ключи одного канала: времена и значения, по `dim` значений на ключ. */
export interface ChannelKeys {
  readonly times: Float32Array;
  readonly values: Float32Array;
}

/** Ключи каналов одной кости внутри секвенции; времена — секунды от её начала. */
export interface BoneTrack {
  readonly boneIndex: number;
  /**
   * 3 значения на ключ; значения УЖЕ абсолютные локальные позиции —
   * rest-pivot кости плюс смещение ключа (в MDX это Translation).
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
 * Слот текстуры модели. `path` — путь к файлу текстуры либо null: слот
 * объявлен, но файла за ним нет (в MDX так выглядят replaceable-слоты
 * team color). Слот без пути остаётся в списке, чтобы нумерация была сквозной:
 * скины манифеста подменяют текстуры по НОМЕРУ слота.
 */
export interface TextureSlotRef {
  readonly slot: number;
  readonly path: string | null;
}
