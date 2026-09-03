#!/usr/bin/env node
/**
 * Генератор текстур детали воды (`rendering` REND-35, источник `textured`):
 * `content/visuals/textures/water-normal.png` — тайлящаяся карта нормалей
 * спокойной воды и `content/visuals/textures/water-foam.png` — тайлящийся
 * шум пены и каустики по каналам: R — сеть Ворли (каустика на дне), G — пятна
 * value-шума (рваная кромка пены), B — пузырьки (зерно внутри пены).
 * Запуск: `npm run textures:water` из корня.
 *
 * Зачем свой генератор, а не ассет из сети: деталь воды рисуется под
 * изометрической камерой в один-два периода на экран, и у неё должен быть
 * СВОЙ частотный состав — крупные пологие волны с мелкой рябью поверх, а не
 * штормовая крошка фотограмметрии, которая на таком масштабе сворачивается в
 * шум. Здесь спектр задан числом, и его можно подкрутить, а не искать заново.
 *
 * Детерминированно: свой xorshift32 с фиксированным зерном, поэтому повторный
 * запуск даёт те же байты, и дифф текстуры — это дифф формулы. Тайлится по
 * построению: волны с целым числом периодов на сторону, решётки шума и точек
 * Ворли — по модулю периода. Лицензировать нечего: изображение целиком выведено
 * из формул этого файла (см. `content/visuals/textures/CREDITS.md`).
 *
 * Общие кирпичи — генератор чисел, периодические шумы, запись PNG — в
 * `scripts/lib/texgen.mjs`, одни на все генераторы текстур репозитория.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng, periodicValueNoise, periodicWorley, smooth, wrap, xorshift32 } from './lib/texgen.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = `${ROOT}content/visuals/textures/`;

/** Сторона обеих текстур в текселях; период тайла — вся сторона. */
const SIZE = 512;

/**
 * Карта нормалей — поле высот `h(u, v)` на единичном тайле: сумма направленных
 * волн с целым волновым вектором (тайлится) и двух октав периодического
 * value-шума. Нормаль — из градиента поля, крутизна нормирована так, чтобы
 * максимальный наклон был `MAX_SLOPE`: сила возмущения в шейдере умножает его
 * дальше, и запас здесь означал бы двойное управление одной величиной.
 */
const MAX_SLOPE = 0.5;
const SEED = 0x5eed_0a7e;

/** Направленные волны: волновой вектор в периодах на тайл, доля амплитуды, острота гребня. */
const WAVES = [
  { kx: 2, ky: 1, amp: 1.0, crest: 1.6 },
  { kx: -1, ky: 3, amp: 0.7, crest: 1.4 },
  { kx: 3, ky: -2, amp: 0.55, crest: 1.3 },
  { kx: 1, ky: -4, amp: 0.35, crest: 1.2 },
  { kx: 5, ky: 2, amp: 0.28, crest: 1.2 },
  { kx: -4, ky: -5, amp: 0.18, crest: 1.1 },
  { kx: 7, ky: 3, amp: 0.12, crest: 1.0 },
  { kx: -6, ky: 8, amp: 0.08, crest: 1.0 },
];

/** Октавы периодического value-шума: период решётки в ячейках на тайл и доля амплитуды. */
const NOISE_OCTAVES = [
  { cells: 5, amp: 0.45 },
  { cells: 11, amp: 0.2 },
  { cells: 23, amp: 0.07 },
];

/**
 * Каустика (канал R) — сеть Ворли: яркие линии там, где два ближайших центра
 * равноудалены (`F2 − F1 → 0`), в два масштаба, с мягким уровнем яркости от
 * value-шума, чтобы сеть не была одинаково яркой всюду.
 */
const WORLEY_LAYERS = [
  { cells: 7, amp: 1.0, width: 0.3 },
  { cells: 13, amp: 0.55, width: 0.26 },
];

/**
 * Искривление области Ворли: прямые рёбра ячеек — геометрия, а не вода.
 * Координата сдвигается периодическим шумом на эту долю тайла, и рёбра сети
 * гнутся, как линии каустики на дне.
 */
const WARP = { cells: 3, amount: 0.05 };

/** Пятна пены (канал G): октавы value-шума и порог контраста, чтобы пятна были пятнами. */
const FOAM_OCTAVES = [
  { cells: 6, amp: 0.6 },
  { cells: 14, amp: 0.3 },
  { cells: 31, amp: 0.1 },
];

/** Пузырьки (канал B): мелкий Ворли по расстоянию до центра ячейки. */
const BUBBLES = { cells: 29, radius: 0.55 };

function heightField() {
  const random = xorshift32(SEED);
  const phases = WAVES.map(() => random() * Math.PI * 2);
  const octaves = NOISE_OCTAVES.map((octave) => ({
    ...octave,
    sample: periodicValueNoise(octave.cells, random),
  }));
  return (u, v) => {
    let h = 0;
    WAVES.forEach((wave, i) => {
      const theta = Math.PI * 2 * (wave.kx * u + wave.ky * v) + phases[i];
      // Гребень острее ложбины: `sin` поднимается к единице степенью выше 1.
      const crest = Math.pow((Math.sin(theta) + 1) / 2, wave.crest);
      h += wave.amp * (crest - 0.5);
    });
    for (const octave of octaves) h += octave.amp * (octave.sample(u, v) - 0.5);
    return h;
  };
}

function normalMap() {
  const height = heightField();
  const field = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) field[y * SIZE + x] = height(x / SIZE, y / SIZE);
  }
  // Градиент центральной разностью по тору; шкала подбирается по максимуму.
  const gx = new Float32Array(SIZE * SIZE);
  const gy = new Float32Array(SIZE * SIZE);
  let peak = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const dx = field[y * SIZE + wrap(x + 1, SIZE)] - field[y * SIZE + wrap(x - 1, SIZE)];
      const dy = field[wrap(y + 1, SIZE) * SIZE + x] - field[wrap(y - 1, SIZE) * SIZE + x];
      gx[i] = dx;
      gy[i] = dy;
      peak = Math.max(peak, Math.hypot(dx, dy));
    }
  }
  const scale = MAX_SLOPE / Math.max(peak, 1e-9);
  const pixels = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    // Стандартная раскладка карты нормалей: xy — компоненты нормали (−∂h),
    // z — вверх; в шейдере наклон читается как `−(rg × 2 − 1)`.
    const nx = -gx[i] * scale;
    const ny = -gy[i] * scale;
    const len = Math.hypot(nx, ny, 1);
    pixels[i * 3] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
    pixels[i * 3 + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
    pixels[i * 3 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
  }
  return pixels;
}

function foamMap() {
  const random = xorshift32(SEED ^ 0x0f0a_0f0a);
  const layers = WORLEY_LAYERS.map((layer) => ({ ...layer, sample: periodicWorley(layer.cells, random) }));
  const level = periodicValueNoise(4, random);
  const warpU = periodicValueNoise(WARP.cells, random);
  const warpV = periodicValueNoise(WARP.cells, random);
  const foamOctaves = FOAM_OCTAVES.map((octave) => ({
    ...octave,
    sample: periodicValueNoise(octave.cells, random),
  }));
  const bubbles = periodicWorley(BUBBLES.cells, random);
  const pixels = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u0 = x / SIZE;
      const v0 = y / SIZE;
      const u = u0 + (warpU(u0, v0) - 0.5) * WARP.amount * 2;
      const v = v0 + (warpV(u0, v0) - 0.5) * WARP.amount * 2;
      let web = 0;
      for (const layer of layers) {
        const [f1, f2] = layer.sample(u, v);
        const edge = 1 - Math.min((f2 - f1) / layer.width, 1);
        web += layer.amp * edge * edge;
      }
      const shade = 0.55 + 0.45 * level(u0, v0);
      const caustic = Math.pow(Math.min(web * shade, 1), 1.4);

      let blot = 0;
      for (const octave of foamOctaves) blot += octave.amp * octave.sample(u0, v0);
      const foam = smooth(Math.min(Math.max((blot - 0.45) / 0.25, 0), 1));

      const [f1] = bubbles(u0, v0);
      const bubble = 1 - Math.min(f1 / BUBBLES.radius, 1);

      const i = (y * SIZE + x) * 3;
      pixels[i] = Math.round(caustic * 255);
      pixels[i + 1] = Math.round(foam * 255);
      pixels[i + 2] = Math.round(bubble * bubble * 255);
    }
  }
  return pixels;
}

const normal = encodePng(SIZE, SIZE, 3, normalMap());
writeFileSync(`${OUT_DIR}water-normal.png`, normal);
const foam = encodePng(SIZE, SIZE, 3, foamMap());
writeFileSync(`${OUT_DIR}water-foam.png`, foam);
process.stdout.write(
  `water-normal.png: ${SIZE}×${SIZE} RGB, ${normal.length} байт\n` +
    `water-foam.png: ${SIZE}×${SIZE} RGB, ${foam.length} байт\n`,
);
