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
 * Раскладка (все секции подряд, смещения выровнены по типу):
 *   заголовок   u32×8: версия, tick, mode, флаги, count, floorPairs, statPairs, резерв
 *   id          f64×count   — 48-битный generational EntityId, точен во f64
 *   statValue   f64×pairs   — значения статов подряд по сущностям (HUD-8)
 *   x, y        f32×count   — мировые координаты (уже float, REND-1)
 *   facingYaw   f32×count   — NaN: стоит, курс не обновлять
 *   aimYaw      f32×count   — NaN: цели нет
 *   motionPhase f32×count   — фаза манёвра локомоушена, NaN: манёвра нет (REND-12)
 *   flightPhase f32×count   — фаза полёта, NaN: сущность не летит (REND-12)
 *   timeScale   f32×count   — персональная шкала времени, 1: обычный темп (REND-38)
 *   kind        i32×count   — индекс в словаре kind'ов, −1: не рисуется
 *   statIndex   i32×pairs   — индексы имён статов в том же порядке (HUD-8)
 *   floor       u32×2×pairs — пары (клетка, бит пола)
 *   level       u8×count
 *   flags       u8×count    — бит 0: moving
 *   motion      u8×count    — состояние машины локомоушена (LOC-3, REND-4)
 *   statCount   u8×count    — сколько пар статов у сущности (HUD-8)
 */
import type { ExtractedTick, RenderEvent } from '@fluxus/render';
import type { WorldMode } from '@fluxus/core';

/** 5: добавлена колонка персональной шкалы времени сущности (REND-38). */
export const CODEC_VERSION = 5;

const HEADER_WORDS = 8;
const HEADER_BYTES = HEADER_WORDS * 4;

const H_VERSION = 0;
const H_TICK = 1;
const H_MODE = 2;
const H_FLAGS = 3;
const H_COUNT = 4;
const H_FLOOR_PAIRS = 5;
const H_STAT_PAIRS = 6;

const FLAG_IS_REPLAY = 1;
const FLAG_SNAP_ALL = 2;
const FLAG_FRESH_EVENTS = 4;

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
 * Сколько f32-колонок идёт подряд в секции `f32`: x, y, facingYaw, aimYaw,
 * motionPhase, flightPhase, timeScale. Фаза полёта — колонка, а не отдельная
 * секция «есть или нет»: раскладка не ветвится по содержимому кадра (SHELL-3),
 * а её ОТСУТСТВИЕ у сущности выражено `NaN` — тем же способом, что у курса и
 * цели. Персональная шкала времени (REND-38) — колонка по той же причине, и
 * «шкалы нет» она выражает единицей: множитель обычного темпа (TIME-3).
 */
const F32_COLUMNS = 7;

interface Layout {
  id: number;
  statValue: number;
  f32: number; // x, затем y, facingYaw, aimYaw, motionPhase, flightPhase, timeScale подряд
  kind: number;
  statIndex: number;
  floor: number;
  level: number;
  flags: number;
  motion: number;
  statCount: number;
  total: number;
}

function layout(count: number, floorPairs: number, statPairs: number): Layout {
  const id = align8(HEADER_BYTES);
  // Секция f64 статов идёт сразу за id — обе восьмибайтные, и выравнивание
  // держится без дополнения между ними.
  const statValue = id + count * 8;
  const f32 = statValue + statPairs * 8;
  const kind = f32 + count * 4 * F32_COLUMNS;
  const statIndex = kind + count * 4;
  const floor = statIndex + statPairs * 4;
  const level = floor + floorPairs * 8;
  const flags = level + count;
  const motion = flags + count;
  const statCount = motion + count;
  // Полный размер выровнен по 8: буфер из пула остаётся пригоден под секцию
  // f64 при любом count, и целочисленные view поверх всего кадра законны.
  return {
    id,
    statValue,
    f32,
    kind,
    statIndex,
    floor,
    level,
    flags,
    motion,
    statCount,
    total: align8Safe(statCount + count),
  };
}

/** Сколько байт нужно под тик; вход для перевыделения пула (SHELL-3). */
export function requiredBytes(count: number, floorPairs: number, statPairs = 0): number {
  return layout(count, floorPairs, statPairs).total;
}

/**
 * Переопределяемая при записи часть заголовка: sender аккумулирует флаги и
 * дельту пола за невиденные main'ом тики (SHELL-4), сущности всегда берутся
 * из последнего extract'а.
 */
export interface WriteOverrides {
  readonly snapAll: boolean;
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
  const at = layout(count, floorPairs, statPairs);
  if (buffer.byteLength < at.total) {
    throw new Error(`codec: буфер ${buffer.byteLength} байт, нужно ${at.total}`);
  }
  const snapAll = overrides?.snapAll ?? ext.snapAll;
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
    (freshEvents ? FLAG_FRESH_EVENTS : 0);
  header[H_COUNT] = count;
  header[H_FLOOR_PAIRS] = floorPairs;
  header[H_STAT_PAIRS] = statPairs;

  new Float64Array(buffer, at.id, count).set(ext.id.subarray(0, count));
  new Float64Array(buffer, at.statValue, statPairs).set(ext.statValue.subarray(0, statPairs));
  const f32 = new Float32Array(buffer, at.f32, count * F32_COLUMNS);
  f32.set(ext.x.subarray(0, count), 0);
  f32.set(ext.y.subarray(0, count), count);
  f32.set(ext.facingYaw.subarray(0, count), count * 2);
  f32.set(ext.aimYaw.subarray(0, count), count * 3);
  f32.set(ext.motionPhase.subarray(0, count), count * 4);
  f32.set(ext.flightPhase.subarray(0, count), count * 5);
  f32.set(ext.timeScale.subarray(0, count), count * 6);
  new Int32Array(buffer, at.kind, count).set(ext.kind.subarray(0, count));
  new Int32Array(buffer, at.statIndex, statPairs).set(ext.statIndex.subarray(0, statPairs));
  const floor = new Uint32Array(buffer, at.floor, floorPairs * 2);
  // `floorPairs` посчитан из длины самого `floorDelta`, поэтому индекс внутри.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- инвариант описан строкой выше
  for (let i = 0; i < floorPairs * 2; i++) floor[i] = floorDelta[i]!;
  new Uint8Array(buffer, at.level, count).set(ext.level.subarray(0, count));
  new Uint8Array(buffer, at.flags, count).set(ext.flags.subarray(0, count));
  new Uint8Array(buffer, at.motion, count).set(ext.motion.subarray(0, count));
  new Uint8Array(buffer, at.statCount, count).set(ext.statCount.subarray(0, count));
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
  const at = layout(count, floorPairs, statPairs);
  /**
   * `count`/`floorPairs` приезжают из заголовка, то есть определяют раскладку
   * данными самого кадра. Без этой проверки несогласованный кадр вылетал бы
   * сырым RangeError из конструктора TypedArray — исключением про смещение и
   * длину, по которому не видно, что не так с кадром. Проверка симметрична
   * той, что делает `writeTick`, и называет то же самое.
   */
  if (buffer.byteLength < at.total) {
    throw new Error(
      `codec: кадр ${buffer.byteLength} байт, заголовок обещает ${at.total} (count=${count}, floorPairs=${floorPairs}, statPairs=${statPairs})`,
    );
  }
  const modeIndex = headerWord(header, H_MODE);
  const mode = MODES[modeIndex];
  if (mode === undefined) {
    throw new Error(`codec: режим мира ${modeIndex} вне таблицы из ${MODES.length}`);
  }
  const flags = headerWord(header, H_FLAGS);
  const f32 = at.f32;
  return {
    tick: headerWord(header, H_TICK),
    mode,
    isReplay: (flags & FLAG_IS_REPLAY) !== 0,
    snapAll: (flags & FLAG_SNAP_ALL) !== 0,
    freshEvents: (flags & FLAG_FRESH_EVENTS) !== 0,
    count,
    id: new Float64Array(buffer, at.id, count),
    x: new Float32Array(buffer, f32, count),
    y: new Float32Array(buffer, f32 + count * 4, count),
    facingYaw: new Float32Array(buffer, f32 + count * 8, count),
    aimYaw: new Float32Array(buffer, f32 + count * 12, count),
    motionPhase: new Float32Array(buffer, f32 + count * 16, count),
    flightPhase: new Float32Array(buffer, f32 + count * 20, count),
    timeScale: new Float32Array(buffer, f32 + count * 24, count),
    kind: new Int32Array(buffer, at.kind, count),
    floorDelta: new Uint32Array(buffer, at.floor, floorPairs * 2),
    level: new Uint8Array(buffer, at.level, count),
    flags: new Uint8Array(buffer, at.flags, count),
    motion: new Uint8Array(buffer, at.motion, count),
    statNames,
    statCount: new Uint8Array(buffer, at.statCount, count),
    statIndex: new Int32Array(buffer, at.statIndex, statPairs),
    statValue: new Float64Array(buffer, at.statValue, statPairs),
    statPairs,
    events,
    kindTable,
  };
}
