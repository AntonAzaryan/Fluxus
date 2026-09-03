/**
 * ПЛОСКАЯ ФОРМА ОДНОЙ ТАБЛИЦЕЙ — единственное объявление колонок «на сущность»
 * потока тиков (change `fog-observer-inputs`, design D6). Из неё выводятся:
 *
 * - ёмкость колонок (`Extractor.ensureCapacity`) — цикл, а не строка на колонку;
 * - объём, который экстракция отдаёт каналу за тик (`CHANNEL_COLUMNS`,
 *   `extractChannelValues`, `performance-budget` PERF-2);
 * - раскладка кодека оболочки (`client-ts/src/codec.ts`, SHELL-3): секции
 *   группируются по ширине элемента, порядок внутри группы — порядок этого
 *   списка.
 *
 * Прежде новая колонка правилась в шести местах при одном страже числа; теперь
 * — в одном, и подорожание доставки видно в диффе эталона стоимости той же
 * правкой. Порядок ВНУТРИ группы значим (он и есть порядок секции кодека),
 * порядок групп между собой — нет: их раскладывает кодек, от широких к узким.
 *
 * Отдельным модулем, а не рядом с `ExtractedTick`, по двум причинам: читает её
 * не только экстрактор (кодек выводит из неё раскладку), и зависимости у неё
 * нет ВООБЩЕ — ни от формы, ни от мира. Смысл самих колонок описан там, где они
 * объявлены полями (`extractor.ts`).
 */

/** Конструктор массива колонки — четыре ширины элемента, которыми живёт форма. */
export type ChannelArray =
  | Float64ArrayConstructor
  | Float32ArrayConstructor
  | Int32ArrayConstructor
  | Uint8ArrayConstructor;

/** Значение колонки — массив одной из четырёх ширин. */
export type ChannelArrayValue = Float64Array | Float32Array | Int32Array | Uint8Array;

/** Одна колонка плоской формы: имя поля `ExtractedTick` и тип её массива. */
export interface ChannelColumn {
  /** Имя поля в `ExtractedTick` — оно же имя секции в раскладке кодека. */
  readonly name: string;
  readonly array: ChannelArray;
}

/**
 * Колонки «на сущность». Секции статов (`statIndex`/`statValue`) и дельта пола
 * сюда не входят: они не «колонка на сущность», а разреженные пары со своей
 * длиной, и ёмкость им считает сам экстрактор по числу объявленных статов.
 */
export const CHANNEL_LAYOUT: readonly ChannelColumn[] = [
  { name: 'id', array: Float64Array },
  { name: 'x', array: Float32Array },
  { name: 'y', array: Float32Array },
  { name: 'facingYaw', array: Float32Array },
  { name: 'aimYaw', array: Float32Array },
  { name: 'motionPhase', array: Float32Array },
  { name: 'flightPhase', array: Float32Array },
  { name: 'timeScale', array: Float32Array },
  { name: 'kind', array: Int32Array },
  { name: 'level', array: Uint8Array },
  { name: 'simLevel', array: Uint8Array },
  { name: 'flags', array: Uint8Array },
  { name: 'motion', array: Uint8Array },
  { name: 'statCount', array: Uint8Array },
];

/**
 * Колонок плоской формы НА СУЩНОСТЬ — длина таблицы, то есть множитель объёма,
 * который экстракция отдаёт каналу за тик (PERF-2).
 *
 * Экспортируется РАДИ СВЕРКИ: расхождение с раскладкой кодека стережёт тест на
 * стороне оболочки, где эта раскладка и живёт («сущность стоит каналу ровно
 * объявленных колонок», `client-ts/test/codec.test.ts`) — он берёт это число
 * отсюда, а не повторяет его своим.
 */
export const CHANNEL_COLUMNS = CHANNEL_LAYOUT.length;

/** Имена колонок заданной ширины в порядке таблицы — вход раскладки кодека. */
export function channelColumnsOf(array: ChannelArray): readonly string[] {
  return CHANNEL_LAYOUT.filter((column) => column.array === array).map((column) => column.name);
}

/**
 * Колонки заданной ёмкости по таблице: `capacity` элементов каждая. Запись идёт
 * по имени поля — единственная точка, где типизация ослаблена ради
 * ЕДИНСТВЕННОГО объявления колонок; расхождение имени с полем `ExtractedTick`
 * ловит roundtrip кодека, где то же имя читается обратно.
 */
export function channelColumns(capacity: number): Record<string, ChannelArrayValue> {
  const columns: Record<string, ChannelArrayValue> = {};
  for (const column of CHANNEL_LAYOUT) columns[column.name] = new column.array(capacity);
  return columns;
}

/** Те же колонки в существующую форму — рост ёмкости при росте сцены (SHELL-3). */
export function growChannelColumns(target: Record<string, ChannelArrayValue>, capacity: number): void {
  for (const column of CHANNEL_LAYOUT) target[column.name] = new column.array(capacity);
}

// ------------------------------------------------- биты колонки `flags`

/** Бит колонки `flags`: скорость выше порога — состояние `move` (REND-4). */
export const ENTITY_MOVING = 1;
/** Бит колонки `flags`: у сущности override уровня (TERR-4) — наклон по поверхности не применяется (REND-10). */
export const ENTITY_LEVEL_OVERRIDE = 2;
/** Сдвиг битов состояний в колонке `flags`: бит i+STATE_BITS_SHIFT — i-я компонента `stateComponents`. */
export const STATE_BITS_SHIFT = 2;
/** Колонка `flags` — u8: биты 0..1 заняты, под состояния остаётся 6 бит. */
export const MAX_STATE_COMPONENTS = 6;
