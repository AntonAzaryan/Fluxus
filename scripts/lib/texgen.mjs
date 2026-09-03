/**
 * Общие кирпичи генераторов текстур (`scripts/gen-*-textures.mjs`): детерминированный
 * генератор случайных чисел, периодические шумы и запись PNG. Всё тайлится по
 * построению — решётки шума и точек Ворли берутся по модулю периода, — поэтому
 * текстура, собранная из этих функций на единичном квадрате `[0, 1)²`,
 * бесшовна без дополнительной обработки краёв.
 *
 * Формат PNG пишется прямо здесь (IHDR/IDAT/IEND поверх `zlib`): зависимость
 * ради трёх чанков была бы дороже, чем сами чанки.
 */
import { deflateSync, crc32 } from 'node:zlib';

/** xorshift32 с фиксированным зерном: повторный запуск даёт те же байты. */
export function xorshift32(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export const smooth = (t) => t * t * (3 - 2 * t);
export const wrap = (i, n) => ((i % n) + n) % n;
export const clamp01 = (t) => Math.min(Math.max(t, 0), 1);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Периодический value-шум: решётка `cells × cells` со случайными узлами, интерполяция smoothstep. */
export function periodicValueNoise(cells, random) {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const at = (ix, iy) => lattice[wrap(iy, cells) * cells + wrap(ix, cells)];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

/** Сумма октав периодического шума: `[{ cells, amp }]` → функция `(u, v) → число`. */
export function periodicOctaves(octaves, random) {
  const layers = octaves.map((octave) => ({ ...octave, sample: periodicValueNoise(octave.cells, random) }));
  return (u, v) => {
    let sum = 0;
    for (const layer of layers) sum += layer.amp * layer.sample(u, v);
    return sum;
  };
}

/**
 * Периодический Ворли: одна точка на ячейку, возвращает `(F1, F2, id)` — два
 * ближайших расстояния в единицах ячейки и индекс ближайшей ячейки.
 */
export function periodicWorley(cells, random) {
  const points = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    points[i * 2] = random();
    points[i * 2 + 1] = random();
  }
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let f1 = Number.POSITIVE_INFINITY;
    let f2 = Number.POSITIVE_INFINITY;
    let id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx;
        const iy = cy + dy;
        const cell = wrap(iy, cells) * cells + wrap(ix, cells);
        const px = ix + points[cell * 2];
        const py = iy + points[cell * 2 + 1];
        const d = Math.hypot(px - x, py - y);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = cell;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return [f1, f2, id];
  };
}

/**
 * Холст RGB с плавающей точкой и тороидальными координатами: штрих, ушедший за
 * край, продолжается с противоположного, поэтому мазки тайлятся так же, как шум.
 */
export function createCanvas(size) {
  const data = new Float32Array(size * size * 3);
  const index = (x, y) => (wrap(y, size) * size + wrap(x, size)) * 3;
  return {
    size,
    data,
    /** Записать цвет пикселя целиком. */
    set(x, y, r, g, b) {
      const i = index(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    },
    /** Смешать цвет с пикселем по альфе (обычное наложение). */
    blend(x, y, r, g, b, alpha) {
      const i = index(x, y);
      data[i] = lerp(data[i], r, alpha);
      data[i + 1] = lerp(data[i + 1], g, alpha);
      data[i + 2] = lerp(data[i + 2], b, alpha);
    },
    /**
     * Мягкий мазок: полилиния из точек `(x, y)` с шириной `width` в текселях;
     * каждая точка кладётся в окрестность 3×3 с гауссовым весом.
     */
    stroke(points, r, g, b, alpha, width) {
      const sigma = Math.max(width * 0.5, 0.35);
      for (const [px, py] of points) {
        const cx = Math.round(px);
        const cy = Math.round(py);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ddx = cx + dx - px;
            const ddy = cy + dy - py;
            const weight = Math.exp(-(ddx * ddx + ddy * ddy) / (2 * sigma * sigma));
            if (weight < 0.02) continue;
            this.blend(cx + dx, cy + dy, r, g, b, clamp01(alpha * weight));
          }
        }
      }
    },
    /** Пиксели в 8 бит RGB, построчно сверху вниз. */
    toRgb8() {
      const pixels = Buffer.alloc(size * size * 3);
      for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round(clamp01(data[i]) * 255);
      return pixels;
    },
  };
}

/** `#rrggbb` → три компоненты [0, 1]. */
export function rgbOf(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [Math.floor(value / 0x10000) / 255, (Math.floor(value / 0x100) % 0x100) / 255, (value % 0x100) / 255];
}

/** PNG без палитры и чересстрочности: 8 бит, тип цвета 0 (серый) или 2 (RGB). */
export function encodePng(width, height, channels, pixels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0, 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
