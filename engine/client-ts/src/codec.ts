/**
 * Кодек плоского буфера состояния (SHELL-3, design Decision 3).
 *
 * Писатель и читатель намеренно в одном модуле: раскладка — их общий
 * приватный контракт, рассинхрон ловится roundtrip-тестом в одном потоке.
 * Раскладка не знает о механизме доставки: буфер можно передать transfer'ом,
 * положить в слот SharedArrayBuffer или прочитать в том же потоке — формат
 * одинаков.
 *
 * Через буфер идёт только conflatable-состояние сущностей и дельта пола.
 * События, дословарь kind'ов и terrain-handshake — structured clone в
 * конверте сообщения (SHELL-4, SHELL-5): они мелкие, редкие и разноформенные.
 *
 * Статы (`match-hud` HUD-8) едут РАЗРЕЖЕННО и без имён: имена — словарь
 * сборки, неизменный за сессию, и уезжают один раз в handshake (SHELL-5), а
 * кадр несёт пары «индекс имени → значение» и число пар на сущность. Так
 * буферная дисциплина остаётся прежней: кадр без статов длиннее не стал, а
 * кадр со статами растёт ровно на реально доставленные значения.
 *
 * Кадр по умолчанию ЧАСТИЧНЫЙ (SHELL-3): в нём едут строки только изменившихся
 * сущностей, а исчезнувшие — отдельной секцией идентификаторов. Флаг заголовка
 * объявляет кадр полным (разрыв непрерывности, начало сессии), и тогда набор
 * строк авторитетен: запись без строки у приёмника мертва.
 *
 * Раскладка (все секции подряд, смещения выровнены по типу):
 *   заголовок   u32×8: версия, tick, mode, флаги, count, floorPairs, statPairs, removed
 *   f64×count   — колонки восьмибайтной ширины таблицы (`id`)
 *   removed     f64×removed — идентификаторы исчезнувших (частичный кадр)
 *   statValue   f64×pairs   — значения статов подряд по сущностям (HUD-8)
 *   f32×count   — колонки четырёхбайтной ширины: x, y, facingYaw, aimYaw,
 *                 motionPhase, flightPhase, timeScale
 *   i32×count   — целые четырёхбайтные: kind (индекс словаря, −1 — не рисуется)
 *   statIndex   i32×pairs   — индексы имён статов в том же порядке (HUD-8)
 *   floor       u32×2×pairs — пары (клетка, бит пола)
 *   u8×count    — байтовые: level, simLevel, flags, motion, statCount
 *
 * СОСТАВ секций кодек не объявляет: колонки «на сущность» описаны ОДИН раз
 * таблицей плоской формы (`CHANNEL_LAYOUT` экстрактора, change
 * `fog-observer-inputs` design D6), и раскладка выводится из неё группировкой
 * по ширине элемента. Прежде тот же перечень жил здесь вторым списком и
 * расходился бы с первым молча: новая колонка правилась в шести местах.
 * Порядок групп — от широких к узким: выравнивание секций держится им, а не
 * дополнением между ними.
 */
import { channelColumnsOf, type ExtractedTick, type RenderEvent } from '@fluxus/render';
import type { WorldMode } from '@fluxus/core';

/**
 * 7: частичный кадр — бит «кадр полный», слово «сколько исчезнувших» и их
 * секция (SHELL-3). Обе стороны канала живут в одном пакете — совместимости со
 * старой версией не требуется.
 */
export const CODEC_VERSION = 7;

const HEADER_WORDS = 8;
const HEADER_BYTES = HEADER_WORDS * 4;

const H_VERSION = 0;
const H_TICK = 1;
const H_MODE = 2;
const H_FLAGS = 3;
const H_COUNT = 4;
const H_FLOOR_PAIRS = 5;
const H_STAT_PAIRS = 6;
const H_REMOVED = 7;

const FLAG_IS_REPLAY = 1;
const FLAG_SNAP_ALL = 2;
const FLAG_FRESH_EVENTS = 4;
/**
 * Сменилась ВЕТВЬ истории (SHELL-7) — бит отдельный от `snapAll` намеренно:
 * тот отвечает «рисовать ли тик без интерполяции» (REND-2), а этот — «тот же ли
 * упакованный id принадлежит той же сущности» (NTR-16). Пауза матча (NTR-20)
 * взводит первый и не взводит второй.
 */
const FLAG_BRANCH_CHANGED = 8;
/**
 * Кадр ПОЛНЫЙ: набор строк авторитетен (SHELL-3). Признак заголовка, а не
 * вывод из числа строк: полный кадр пустого мира и частичный кадр без
 * изменений выглядят одинаково, а означают противоположное — «все умерли»
 * против «ничего не менялось».
 */
const FLAG_FULL = 16;

/**
 * Имена колонок по ширине элемента — из таблицы плоской формы, в её порядке.
 * Считаются один раз на модуль: таблица неизменна за сессию.
 */
const F64_NAMES = channelColumnsOf(Float64Array);
const F32_NAMES = channelColumnsOf(Float32Array);
const I32_NAMES = channelColumnsOf(Int32Array);
const U8_NAMES = channelColumnsOf(Uint8Array);

const MODES: readonly WorldMode[] = ['Running', 'Paused', 'Rewinding'];

/** Кратно 8: секция id (f64) идёт сразу за заголовком. */
const align8 = (bytes: number): number => (bytes + 7) & ~7;

/**
 * То же выравнивание, но без 32-битной арифметики: полный размер кадра
 * считается по `count` из заголовка, то есть по недоверенному числу, и
 * побитовое `&` увело бы 2^35 в мелкое положительное — проверка размера
 * прошла бы, а разбор упал бы сырым RangeError из конструктора TypedArray.
 */
const align8Safe = (bytes: number): number => Math.ceil(bytes / 8) * 8;

/**
 * Смещения секций кадра. Колонки внутри секции идут подряд в порядке таблицы
 * плоской формы, поэтому их собственных полей здесь нет: смещение колонки —
 * начало её секции плюс её порядковый номер в группе, умноженный на `count`.
 *
 * Колонка выражает ОТСУТСТВИЕ значения содержимым, а не отсутствием секции:
 * `NaN` у курса, цели и фаз, единица у персональной шкалы (TIME-3) — раскладка
 * по содержимому кадра не ветвится (SHELL-3).
 */
interface Layout {
  f64: number;
  removed: number;
  statValue: number;
  f32: number;
  i32: number;
  statIndex: number;
  floor: number;
  u8: number;
  total: number;
}

function layout(count: number, floorPairs: number, statPairs: number, removed: number): Layout {
  const f64 = align8(HEADER_BYTES);
  // Секции идентификаторов и значений статов идут сразу за колонками той же
  // ширины — все восьмибайтные, и выравнивание держится без дополнения.
  const removedAt = f64 + count * F64_NAMES.length * 8;
  const statValue = removedAt + removed * 8;
  const f32 = statValue + statPairs * 8;
  const i32 = f32 + count * F32_NAMES.length * 4;
  const statIndex = i32 + count * I32_NAMES.length * 4;
  const floor = statIndex + statPairs * 4;
  const u8 = floor + floorPairs * 8;
  // Полный размер выровнен по 8: буфер из пула остаётся пригоден под секцию
  // f64 при любом count, и целочисленные view поверх всего кадра законны.
  return {
    f64,
    removed: removedAt,
    statValue,
    f32,
    i32,
    statIndex,
    floor,
    u8,
    total: align8Safe(u8 + count * U8_NAMES.length),
  };
}

/** Колонки формы по имени — общий вход записи и чтения раскладки. */
type ColumnBag = Record<string, Float64Array | Float32Array | Int32Array | Uint8Array>;

/**
 * Те же колонки как ПОЛЯ прочитанного тика: тип выводится из самой формы —
 * второго списка имён у кодека нет. Секции статов идут мимо таблицы и
 * дописываются явно.
 */
type ColumnFields = {
  [K in keyof ExtractedTick as ExtractedTick[K] extends Float64Array | Float32Array | Int32Array | Uint8Array
    ? K
    : never]: ExtractedTick[K];
};

/** Сколько байт нужно под тик; вход для перевыделения пула (SHELL-3). */
export function requiredBytes(
  count: number,
  floorPairs: number,
  statPairs = 0,
  removed = 0,
): number {
  return layout(count, floorPairs, statPairs, removed).total;
}

/**
 * Переопределяемая при записи часть заголовка: sender аккумулирует флаги и
 * дельту пола за невиденные main'ом тики (SHELL-4), сущности всегда берутся
 * из последнего extract'а.
 */
export interface WriteOverrides {
  readonly snapAll: boolean;
  /** Сменилась ветвь истории за окно доставки (SHELL-7) — ИЛИ по окну, как `snapAll`. */
  readonly branchChanged: boolean;
  readonly freshEvents: boolean;
  /** Плоские пары (клетка, бит) — аккумулированная дельта, later-wins. */
  readonly floorDelta: ArrayLike<number>;
}

/** Пишет тик в буфер. Буфер обязан вмещать `requiredBytes`; проверка — на вызывающем. */
export function writeTick(
  buffer: ArrayBuffer,
  ext: ExtractedTick,
  overrides?: WriteOverrides,
): void {
  const count = ext.count;
  const floorDelta = overrides?.floorDelta ?? ext.floorDelta;
  const floorPairs = floorDelta.length >>> 1;
  const statPairs = ext.statPairs;
  const removed = ext.removedCount;
  const at = layout(count, floorPairs, statPairs, removed);
  if (buffer.byteLength < at.total) {
    throw new Error(`codec: буфер ${buffer.byteLength} байт, нужно ${at.total}`);
  }
  const snapAll = overrides?.snapAll ?? ext.snapAll;
  const branchChanged = overrides?.branchChanged ?? ext.branchChanged;
  const freshEvents = overrides?.freshEvents ?? ext.freshEvents;

  // Режим — индекс в закрытой таблице. Неизвестное имя раньше молча
  // записывалось нулём, то есть кадр уезжал с `Running` вместо настоящего
  // режима: приёмник, читающий rewind по `mode`, не отличил бы это от правды.
  // Появление четвёртого `WorldMode` без правки таблицы — ошибка сборки, и
  // сказать об этом должен writer, у которого на руках имя.
  const mode = MODES.indexOf(ext.mode);
  if (mode < 0) throw new Error(`codec: неизвестный режим мира "${ext.mode}"`);

  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  header[H_VERSION] = CODEC_VERSION;
  header[H_TICK] = ext.tick;
  header[H_MODE] = mode;
  header[H_FLAGS] =
    (ext.isReplay ? FLAG_IS_REPLAY : 0) |
    (snapAll ? FLAG_SNAP_ALL : 0) |
    (freshEvents ? FLAG_FRESH_EVENTS : 0) |
    (branchChanged ? FLAG_BRANCH_CHANGED : 0) |
    (ext.full ? FLAG_FULL : 0);
  header[H_COUNT] = count;
  header[H_FLOOR_PAIRS] = floorPairs;
  header[H_STAT_PAIRS] = statPairs;
  header[H_REMOVED] = removed;

  // Колонки перекладываются по таблице плоской формы, секция за секцией:
  // порядок внутри секции — порядок таблицы, и второго перечня имён у кодека
  // нет. Каждая секция — один view поверх буфера, колонки ложатся в него
  // подряд смещением `номер в группе × count`.
  const columns = ext as unknown as ColumnBag;
  const f64 = new Float64Array(buffer, at.f64, count * F64_NAMES.length);
  for (const [i, name] of F64_NAMES.entries()) {
    f64.set(columnOf(columns, name).subarray(0, count), i * count);
  }
  new Float64Array(buffer, at.removed, removed).set(ext.removed.subarray(0, removed));
  new Float64Array(buffer, at.statValue, statPairs).set(ext.statValue.subarray(0, statPairs));
  const f32 = new Float32Array(buffer, at.f32, count * F32_NAMES.length);
  for (const [i, name] of F32_NAMES.entries()) {
    f32.set(columnOf(columns, name).subarray(0, count), i * count);
  }
  const i32 = new Int32Array(buffer, at.i32, count * I32_NAMES.length);
  for (const [i, name] of I32_NAMES.entries()) {
    i32.set(columnOf(columns, name).subarray(0, count), i * count);
  }
  new Int32Array(buffer, at.statIndex, statPairs).set(ext.statIndex.subarray(0, statPairs));
  const floor = new Uint32Array(buffer, at.floor, floorPairs * 2);
  // `floorPairs` посчитан из длины самого `floorDelta`, поэтому индекс внутри.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- инвариант описан строкой выше
  for (let i = 0; i < floorPairs * 2; i++) floor[i] = floorDelta[i]!;
  const u8 = new Uint8Array(buffer, at.u8, count * U8_NAMES.length);
  for (const [i, name] of U8_NAMES.entries()) {
    u8.set(columnOf(columns, name).subarray(0, count), i * count);
  }
}

/**
 * Колонка формы по имени таблицы. Отсутствие имени — рассинхрон таблицы с
 * формой, а не состояние кадра: молча записанный нуль уехал бы к подсистемам
 * величиной, которой не было.
 */
function columnOf(columns: ColumnBag, name: string): Float64Array | Float32Array | Int32Array | Uint8Array {
  const column = columns[name];
  if (column === undefined) throw new Error(`codec: колонки "${name}" нет в плоской форме`);
  return column;
}

/** Словарь статов сборки, которая их не объявила (HUD-8): статов не бывает. */
const EMPTY_STAT_NAMES: readonly string[] = [];

/**
 * Слово заголовка кадра. Функцией, а не `header[i]!` в каждом чтении: длину
 * заголовка вызывающий уже проверил (`HEADER_BYTES`), поэтому `undefined`
 * здесь — артефакт `noUncheckedIndexedAccess`, а не состояние кадра. Одно
 * место, называющее это вслух, честнее семи восклицательных знаков.
 */
function headerWord(header: Uint32Array, index: number): number {
  const value = header[index];
  if (value === undefined) throw new Error(`codec: слово заголовка ${index} за краем кадра`);
  return value;
}

/**
 * Прочитанный тик: колонки — view'ы В БУФЕР, валидные до его возврата
 * (transfer детачит их). Потребитель обязан выпить всё синхронно —
 * `ViewBuffer.apply` так и делает. `events`/`kindTable` кодек не заполняет:
 * их подставляет получатель из конверта (SHELL-4, SHELL-5).
 */
export function readTick(
  buffer: ArrayBuffer,
  events: readonly RenderEvent[],
  kindTable: readonly string[],
  statNames: readonly string[] = EMPTY_STAT_NAMES,
): ExtractedTick {
  // Заголовок читается только после проверки, что он вообще есть: на буфере
  // короче восьми слов конструктор Uint32Array бросит RangeError, и разговор о
  // версии раскладки не состоится вовсе.
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`codec: кадр ${buffer.byteLength} байт, заголовок — ${HEADER_BYTES}`);
  }
  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  const version = headerWord(header, H_VERSION);
  if (version !== CODEC_VERSION) {
    throw new Error(`codec: версия раскладки ${version}, читатель ждёт ${CODEC_VERSION}`);
  }
  const count = headerWord(header, H_COUNT);
  const floorPairs = headerWord(header, H_FLOOR_PAIRS);
  const statPairs = headerWord(header, H_STAT_PAIRS);
  const removed = headerWord(header, H_REMOVED);
  const at = layout(count, floorPairs, statPairs, removed);
  /**
   * `count`/`floorPairs` приезжают из заголовка, то есть определяют раскладку
   * данными самого кадра. Без этой проверки несогласованный кадр вылетал бы
   * сырым RangeError из конструктора TypedArray — исключением про смещение и
   * длину, по которому не видно, что не так с кадром. Проверка симметрична
   * той, что делает `writeTick`, и называет то же самое.
   */
  if (buffer.byteLength < at.total) {
    throw new Error(
      `codec: кадр ${buffer.byteLength} байт, заголовок обещает ${at.total} (count=${count}, floorPairs=${floorPairs}, statPairs=${statPairs}, removed=${removed})`,
    );
  }
  const modeIndex = headerWord(header, H_MODE);
  const mode = MODES[modeIndex];
  if (mode === undefined) {
    throw new Error(`codec: режим мира ${modeIndex} вне таблицы из ${MODES.length}`);
  }
  const flags = headerWord(header, H_FLAGS);
  // Колонки — view'ы В БУФЕР по той же таблице, что их писала: секция, номер в
  // группе, `count` элементов. Собираются в тот же объект, что и остальные поля
  // формы; расхождение имени с полем `ExtractedTick` не выразимо — имя одно.
  const columns: ColumnBag = {};
  for (const [i, name] of F64_NAMES.entries()) {
    columns[name] = new Float64Array(buffer, at.f64 + i * count * 8, count);
  }
  for (const [i, name] of F32_NAMES.entries()) {
    columns[name] = new Float32Array(buffer, at.f32 + i * count * 4, count);
  }
  for (const [i, name] of I32_NAMES.entries()) {
    columns[name] = new Int32Array(buffer, at.i32 + i * count * 4, count);
  }
  for (const [i, name] of U8_NAMES.entries()) {
    columns[name] = new Uint8Array(buffer, at.u8 + i * count, count);
  }
  return {
    ...(columns as unknown as ColumnFields),
    tick: headerWord(header, H_TICK),
    mode,
    isReplay: (flags & FLAG_IS_REPLAY) !== 0,
    snapAll: (flags & FLAG_SNAP_ALL) !== 0,
    branchChanged: (flags & FLAG_BRANCH_CHANGED) !== 0,
    freshEvents: (flags & FLAG_FRESH_EVENTS) !== 0,
    full: (flags & FLAG_FULL) !== 0,
    removed: new Float64Array(buffer, at.removed, removed),
    removedCount: removed,
    count,
    floorDelta: new Uint32Array(buffer, at.floor, floorPairs * 2),
    statNames,
    statIndex: new Int32Array(buffer, at.statIndex, statPairs),
    statValue: new Float64Array(buffer, at.statValue, statPairs),
    statPairs,
    events,
    kindTable,
  };
}
