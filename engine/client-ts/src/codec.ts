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
 * Раскладка (все секции подряд, смещения выровнены по типу):
 *   заголовок   u32×8: версия, tick, mode, флаги, count, floorPairs, резерв×2
 *   id          f64×count   — 48-битный generational EntityId, точен во f64
 *   x, y        f32×count   — мировые координаты (уже float, REND-1)
 *   facingYaw   f32×count   — NaN: стоит, курс не обновлять
 *   aimYaw      f32×count   — NaN: цели нет
 *   motionPhase f32×count   — фаза манёвра локомоушена, NaN: манёвра нет (REND-12)
 *   kind        i32×count   — индекс в словаре kind'ов, −1: не рисуется
 *   floor       u32×2×pairs — пары (клетка, бит пола)
 *   level       u8×count
 *   flags       u8×count    — бит 0: moving
 *   motion      u8×count    — состояние машины локомоушена (LOC-3, REND-4)
 */
import type { ExtractedTick, RenderEvent } from '@game-mvp/render';
import type { WorldMode } from '@game-mvp/core';

/** 2: добавлены колонки состояния и фазы манёвра локомоушена (REND-4, REND-12). */
export const CODEC_VERSION = 2;

const HEADER_WORDS = 8;
const HEADER_BYTES = HEADER_WORDS * 4;

const H_VERSION = 0;
const H_TICK = 1;
const H_MODE = 2;
const H_FLAGS = 3;
const H_COUNT = 4;
const H_FLOOR_PAIRS = 5;

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

/** Сколько f32-колонок идёт подряд в секции `f32`: x, y, facingYaw, aimYaw, motionPhase. */
const F32_COLUMNS = 5;

interface Layout {
  id: number;
  f32: number; // x, затем y, facingYaw, aimYaw, motionPhase подряд
  kind: number;
  floor: number;
  level: number;
  flags: number;
  motion: number;
  total: number;
}

function layout(count: number, floorPairs: number): Layout {
  const id = align8(HEADER_BYTES);
  const f32 = id + count * 8;
  const kind = f32 + count * 4 * F32_COLUMNS;
  const floor = kind + count * 4;
  const level = floor + floorPairs * 8;
  const flags = level + count;
  const motion = flags + count;
  // Полный размер выровнен по 8: буфер из пула остаётся пригоден под секцию
  // f64 при любом count, и целочисленные view поверх всего кадра законны.
  return { id, f32, kind, floor, level, flags, motion, total: align8Safe(motion + count) };
}

/** Сколько байт нужно под тик; вход для перевыделения пула (SHELL-3). */
export function requiredBytes(count: number, floorPairs: number): number {
  return layout(count, floorPairs).total;
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
  const at = layout(count, floorPairs);
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

  new Float64Array(buffer, at.id, count).set(ext.id.subarray(0, count));
  const f32 = new Float32Array(buffer, at.f32, count * F32_COLUMNS);
  f32.set(ext.x.subarray(0, count), 0);
  f32.set(ext.y.subarray(0, count), count);
  f32.set(ext.facingYaw.subarray(0, count), count * 2);
  f32.set(ext.aimYaw.subarray(0, count), count * 3);
  f32.set(ext.motionPhase.subarray(0, count), count * 4);
  new Int32Array(buffer, at.kind, count).set(ext.kind.subarray(0, count));
  const floor = new Uint32Array(buffer, at.floor, floorPairs * 2);
  for (let i = 0; i < floorPairs * 2; i++) floor[i] = floorDelta[i]!;
  new Uint8Array(buffer, at.level, count).set(ext.level.subarray(0, count));
  new Uint8Array(buffer, at.flags, count).set(ext.flags.subarray(0, count));
  new Uint8Array(buffer, at.motion, count).set(ext.motion.subarray(0, count));
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
): ExtractedTick {
  // Заголовок читается только после проверки, что он вообще есть: на буфере
  // короче восьми слов конструктор Uint32Array бросит RangeError, и разговор о
  // версии раскладки не состоится вовсе.
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`codec: кадр ${buffer.byteLength} байт, заголовок — ${HEADER_BYTES}`);
  }
  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  if (header[H_VERSION] !== CODEC_VERSION) {
    throw new Error(`codec: версия раскладки ${header[H_VERSION]}, читатель ждёт ${CODEC_VERSION}`);
  }
  const count = header[H_COUNT]!;
  const floorPairs = header[H_FLOOR_PAIRS]!;
  const at = layout(count, floorPairs);
  /**
   * `count`/`floorPairs` приезжают из заголовка, то есть определяют раскладку
   * данными самого кадра. Без этой проверки несогласованный кадр вылетал бы
   * сырым RangeError из конструктора TypedArray — исключением про смещение и
   * длину, по которому не видно, что не так с кадром. Проверка симметрична
   * той, что делает `writeTick`, и называет то же самое.
   */
  if (buffer.byteLength < at.total) {
    throw new Error(
      `codec: кадр ${buffer.byteLength} байт, заголовок обещает ${at.total} (count=${count}, floorPairs=${floorPairs})`,
    );
  }
  const mode = MODES[header[H_MODE]!];
  if (mode === undefined) {
    throw new Error(`codec: режим мира ${header[H_MODE]} вне таблицы из ${MODES.length}`);
  }
  const flags = header[H_FLAGS]!;
  const f32 = at.f32;
  return {
    tick: header[H_TICK]!,
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
    kind: new Int32Array(buffer, at.kind, count),
    floorDelta: new Uint32Array(buffer, at.floor, floorPairs * 2),
    level: new Uint8Array(buffer, at.level, count),
    flags: new Uint8Array(buffer, at.flags, count),
    motion: new Uint8Array(buffer, at.motion, count),
    events,
    kindTable,
  };
}
