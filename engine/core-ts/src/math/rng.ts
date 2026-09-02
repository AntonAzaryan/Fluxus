/**
 * Детерминированный PRNG с именованными стримами (RNG-1..RNG-7).
 * Алгоритм, хеш и развёртка seed зафиксированы в спеке дословно — здесь
 * ничего не меняется "для качества", только побитовая парность с Rust (CORE-2).
 */
import { assertInvariant } from '../debug.js';
import type { Fixed, RngStream, RngStreams } from '../types.js';

// ------------------------------------------------------------------- fnv-1a

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** UTF-8 без BOM — TextEncoder никогда не добавляет BOM, поэтому голый вызов достаточен. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** FNV-1a 32, побайтно (RNG-3). `Math.imul` — иначе `hash * prime` на числах у границы u32 вылетает за 53-битный safe integer. */
export function fnv1a32(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS;
  // Обход байтов, а не индексов: хеш считается на загрузке (сид стрима, хеш
  // контент-пака), в горячий путь тика не входит, и протокол итератора здесь
  // ничего не стоит.
  for (const byte of bytes) {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

// --------------------------------------------------------------- splitmix32

/** Один шаг splitmix32 (RNG-7): аккумулятор `z` — вход следующего шага, `r` — выход. */
export function splitmix32(z: number): { z: number; r: number } {
  const nz = (z + 0x9e3779b9) >>> 0;
  let r = nz;
  r = (r ^ (r >>> 16)) >>> 0;
  r = Math.imul(r, 0x21f0aaad) >>> 0;
  r = (r ^ (r >>> 15)) >>> 0;
  r = Math.imul(r, 0x735a2d97) >>> 0;
  r = (r ^ (r >>> 15)) >>> 0;
  return { z: nz, r };
}

/** Вырожденное (0,0,0,0) MUST NOT возникать (RNG-1) — развёртка обязана его исключать (RNG-7). */
export function fixDegenerateState(state: Uint32Array): Uint32Array {
  if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) {
    state[3] = 1;
  }
  return state;
}

/**
 * seed = hash(worldSeed, streamName) (RNG-3), развёрнутый в состояние xorshift128
 * четырьмя шагами splitmix32 (RNG-7). Байтовый поток в hash: worldSeed как 4 байта
 * little-endian, затем UTF-8 байты имени — порядок и endianness зафиксированы
 * в спеке дословно, здесь произвольно менять нельзя.
 */
export function seedStateFromName(worldSeed: number, streamName: string): Uint32Array {
  const seed = worldSeed >>> 0;
  const nameBytes = utf8Bytes(streamName);
  const bytes = new Uint8Array(4 + nameBytes.length);
  bytes[0] = seed & 0xff;
  bytes[1] = (seed >>> 8) & 0xff;
  bytes[2] = (seed >>> 16) & 0xff;
  bytes[3] = (seed >>> 24) & 0xff;
  bytes.set(nameBytes, 4);

  const hash = fnv1a32(bytes);
  const state = new Uint32Array(4);
  let z = hash;
  for (let i = 0; i < 4; i++) {
    const step = splitmix32(z);
    z = step.z;
    state[i] = step.r;
  }
  return fixDegenerateState(state);
}

// ----------------------------------------------------------------- 64-бит

/**
 * Точное 32x32->64 умножение без BigInt: раскладываем оба множителя на
 * 16-битные половины (тот же приём, что и в fixed.ts mul), поскольку прямое
 * `a * b` для полных u32 вылетает за 53-битный safe integer.
 *
 * DET-2, условия 2, 3 и 5: границы промежутков выписаны по строкам ниже,
 * максимум — `t < 2^49`, то есть строго меньше 2^53; единственное делимое `t`
 * неотрицательно, поэтому условие 4 о конвенции округления неприменимо.
 */
function mulU32(a: number, b: number): { hi: number; lo: number } {
  const aHi = a >>> 16;
  const aLo = a & 0xffff;
  const bHi = b >>> 16;
  const bLo = b & 0xffff;

  const lowPart = aLo * bLo; // < 2^32, точно в double
  const cross = aHi * bLo + aLo * bHi; // < 2^33, точно в double
  const t = cross * 0x10000 + lowPart; // < 2^49, всё ещё точно в double

  const hi = (aHi * bHi + Math.floor(t / 0x100000000)) >>> 0;
  const lo = t >>> 0; // `>>> 0` = mod 2^32, ровно то, что нужно для младшего слова
  return { hi, lo };
}

// --------------------------------------------------------------- xorshift128

/**
 * xorshift128 (Marsaglia, 2003), состояние (x, y, z, w) по RNG-1. Каждый шаг
 * нормализуется через `>>> 0`: JS `<<`/`^` работают в 32-битном int-домене,
 * но интерпретировать результат как unsigned u32 нужно явно.
 */
export class XorShift128Stream implements RngStream {
  private x: number;
  private y: number;
  private z: number;
  private w: number;

  constructor(state: Uint32Array) {
    // `!` — длина всегда 4 по контракту RngStream.setState/конструктора, noUncheckedIndexedAccess об этом не знает.
    this.x = state[0]! >>> 0;
    this.y = state[1]! >>> 0;
    this.z = state[2]! >>> 0;
    this.w = state[3]! >>> 0;
  }

  next(): number {
    const x = this.x;
    const w = this.w;
    const t = (x ^ (x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = w;
    this.w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.w;
  }

  /** Lemire multiply-shift с отбраковкой — детерминированно и воспроизводимо в Rust (без float). */
  nextBelow(bound: number): number {
    // Верхняя граница — часть формулы, а не запас (RNG-8): алгоритм описан над
    // `s = bound как u32`, и `bound = 2^32` дал бы `s = 0`, порог «не число» и
    // вечный ноль на выходе без единого исключения. Диапазон 1…2^32−1 закрыт
    // жёстко в обоих режимах сборки, как и нижняя граница (FP-4).
    assertInvariant(
      Number.isInteger(bound) && bound > 0 && bound <= 0xffff_ffff,
      'nextBelow: bound должен быть целым в диапазоне 1…2^32−1',
      'RNG_BOUND_INVALID',
    );
    const s = bound >>> 0;
    const threshold = ((-s) >>> 0) % s; // (2^32 - s) mod s — граница отбраковки для равномерности
    let hi: number;
    let lo: number;
    do {
      const x = this.next();
      const product = mulU32(x, s);
      hi = product.hi;
      lo = product.lo;
    } while (lo < threshold);
    return hi;
  }

  /** Старшие 16 бит генератора — дробная часть Q16.16, то есть значение в [0, 1). */
  nextFixed(): Fixed {
    return this.next() >>> 16;
  }

  getState(): Uint32Array {
    return Uint32Array.of(this.x, this.y, this.z, this.w);
  }

  setState(state: Uint32Array): void {
    this.x = state[0]! >>> 0;
    this.y = state[1]! >>> 0;
    this.z = state[2]! >>> 0;
    this.w = state[3]! >>> 0;
  }
}

// -------------------------------------------------------------------- реестр

export interface RngSnapshotEntry {
  readonly name: string;
  readonly state: Uint32Array;
}

export interface RngRegistry {
  /** RngStreams для конкретной системы: `stream()` = основной стрим, `stream(sub)` = `"{systemName}/{sub}"` (RNG-4, RNG-7). */
  forSystem(systemName: string): RngStreams;
  /** Состояние всех когда-либо созданных стримов — для snapshot (RNG-5). */
  snapshot(): RngSnapshotEntry[];
  /** Восстановление состояния из snapshot (rewind). */
  restore(entries: readonly RngSnapshotEntry[]): void;
}

/**
 * Стримы создаются лениво по имени и кешируются в реестре (design.md: "RNG:
 * стримы создаются лениво") — повторный `stream()` продолжает последовательность,
 * а не пересидивает её заново.
 */
export function createRngRegistry(worldSeed: number): RngRegistry {
  const streams = new Map<string, XorShift128Stream>();
  // Обёртки мемоизируются: tick() зовёт forSystem на каждую систему каждый
  // тик, без кеша это аллокация на ровном месте. Обёртка без состояния —
  // делегирует в getOrCreate, поэтому переживает и restore().
  const wrappers = new Map<string, RngStreams>();

  function getOrCreate(name: string): XorShift128Stream {
    let s = streams.get(name);
    if (s === undefined) {
      s = new XorShift128Stream(seedStateFromName(worldSeed, name));
      streams.set(name, s);
    }
    return s;
  }

  return {
    forSystem(systemName: string): RngStreams {
      let wrapper = wrappers.get(systemName);
      if (wrapper === undefined) {
        wrapper = {
          stream(subStream?: string): RngStream {
            const name = subStream === undefined ? systemName : `${systemName}/${subStream}`;
            return getOrCreate(name);
          },
        };
        wrappers.set(systemName, wrapper);
      }
      return wrapper;
    },
    snapshot(): RngSnapshotEntry[] {
      return Array.from(streams, ([name, stream]) => ({ name, state: stream.getState() }));
    },
    restore(entries: readonly RngSnapshotEntry[]): void {
      streams.clear();
      for (const entry of entries) {
        streams.set(entry.name, new XorShift128Stream(entry.state));
      }
    },
  };
}
