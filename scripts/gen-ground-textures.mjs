#!/usr/bin/env node
/**
 * Генератор покрытий террейна (`rendering` REND-7, покрытие пола и стенок):
 * `content/visuals/textures/ground-grass.png` — тайлящаяся трава для площадок
 * пола и `content/visuals/textures/ground-cliff.png` — тайлящаяся земля со
 * слоями и камнем для стенок обрывов и юбки. Запуск: `npm run textures:ground`.
 *
 * Это ВРЕМЕННЫЕ покрытия: одно на весь пол и одно на все стенки, пока
 * текстурирование террейна не приехало раскраской клеток из Blender (стаб
 * `terrain-texturing`). Рисуются под изометрическую камеру и
 * стилизованный арт демо: крупные пятна тона, мазки-травинки и слои породы, а
 * не фотограмметрия, которая на таком масштабе сворачивается в шум.
 *
 * Детерминированно (xorshift32 с фиксированным зерном) и тайлится по
 * построению: шумы периодические, мазки кладутся на тороидальный холст.
 * Лицензировать нечего — изображение целиком выведено из формул этого файла
 * (см. `content/visuals/textures/CREDITS.md`).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  clamp01,
  createCanvas,
  encodePng,
  lerp,
  periodicOctaves,
  periodicValueNoise,
  periodicWorley,
  rgbOf,
  smooth,
  xorshift32,
} from './lib/texgen.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = `${ROOT}content/visuals/textures/`;

/** Сторона обеих текстур в текселях; период тайла — вся сторона. */
const SIZE = 512;
const SEED = 0x6ea5_5eed;

// ------------------------------------------------------------------ трава

/** Тона травы: тёмный и светлый концы градиента и пятна сухой земли. */
const GRASS = {
  dark: rgbOf('#4a7a2a'),
  light: rgbOf('#8bb542'),
  dry: rgbOf('#8e8556'),
  /** Октавы пятен тона: крупные острова светлого и тёмного. */
  tone: [
    { cells: 3, amp: 0.5 },
    { cells: 7, amp: 0.3 },
    { cells: 17, amp: 0.2 },
  ],
  /** Пятна сухой земли: порог по низкочастотному шуму. */
  dryPatches: [
    { cells: 4, amp: 0.65 },
    { cells: 9, amp: 0.35 },
  ],
  dryThreshold: [0.62, 0.74],
  /** Мазки-травинки: число, длина и отклонение от вертикали. */
  blades: { count: 16000, minLength: 6, maxLength: 16, tilt: 0.5, width: 1.4, alpha: 0.55 },
  /** Редкие искры: цветки и тёмные крапины. */
  flowers: { count: 160, color: rgbOf('#efe08a') },
  specks: { count: 500 },
};

function grassMap() {
  const random = xorshift32(SEED);
  const tone = periodicOctaves(GRASS.tone, random);
  const dry = periodicOctaves(GRASS.dryPatches, random);
  const canvas = createCanvas(SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const t = clamp01(tone(u, v));
      let r = lerp(GRASS.dark[0], GRASS.light[0], t);
      let g = lerp(GRASS.dark[1], GRASS.light[1], t);
      let b = lerp(GRASS.dark[2], GRASS.light[2], t);
      const [lo, hi] = GRASS.dryThreshold;
      const patch = smooth(clamp01((dry(u, v) - lo) / (hi - lo)));
      r = lerp(r, GRASS.dry[0], patch);
      g = lerp(g, GRASS.dry[1], patch);
      b = lerp(b, GRASS.dry[2], patch);
      canvas.set(x, y, r, g, b);
    }
  }
  // Травинки: короткие мазки, чуть светлее либо темнее подложки, с наклоном
  // около вертикали — под камерой, смотрящей на север, вертикаль тайла и есть
  // «вверх» экрана.
  const { blades } = GRASS;
  for (let i = 0; i < blades.count; i++) {
    const x0 = random() * SIZE;
    const y0 = random() * SIZE;
    const length = lerp(blades.minLength, blades.maxLength, random());
    const angle = -Math.PI / 2 + (random() - 0.5) * 2 * blades.tilt;
    const bend = (random() - 0.5) * 0.6;
    const shade = 0.75 + random() * 0.5;
    const base = canvas.data.slice(
      (((y0 | 0) % SIZE) * SIZE + ((x0 | 0) % SIZE)) * 3,
      (((y0 | 0) % SIZE) * SIZE + ((x0 | 0) % SIZE)) * 3 + 3,
    );
    const points = [];
    const steps = Math.ceil(length);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const a = angle + bend * t;
      points.push([x0 + Math.cos(a) * length * t, y0 + Math.sin(a) * length * t]);
    }
    canvas.stroke(points, base[0] * shade, base[1] * shade * 1.05, base[2] * shade * 0.9, blades.alpha, blades.width);
  }
  for (let i = 0; i < GRASS.flowers.count; i++) {
    const x = random() * SIZE;
    const y = random() * SIZE;
    const [r, g, b] = GRASS.flowers.color;
    canvas.stroke([[x, y]], r, g, b, 0.85, 1.2);
  }
  for (let i = 0; i < GRASS.specks.count; i++) {
    const x = random() * SIZE;
    const y = random() * SIZE;
    canvas.stroke([[x, y]], 0.12, 0.2, 0.08, 0.5, 1.0);
  }
  return canvas.toRgb8();
}

// ------------------------------------------------------------------ обрыв

/** Тона породы: земля, тёмные прослойки, светлый камень. */
const CLIFF = {
  soil: rgbOf('#7a6248'),
  dark: rgbOf('#4e3d2e'),
  stone: rgbOf('#9a8668'),
  /** Пятна тона по всей стенке. */
  tone: [
    { cells: 3, amp: 0.5 },
    { cells: 8, amp: 0.3 },
    { cells: 19, amp: 0.2 },
  ],
  /** Горизонтальные прослойки: число на тайл, искривление слоя шумом, острота гребня. */
  strata: { bands: 7, warp: 0.09, sharpness: 1.8 },
  /**
   * Вкрапления камней: ячейки Ворли на искривлённой шумом области, тёмный шов
   * по границе; появляются не всюду — только там, где маска низкочастотного
   * шума выше порога, иначе стенка читается брусчаткой, а не срезом земли.
   */
  stones: { cells: 7, seam: 0.1, relief: 0.3, warp: 0.07, mask: [0.45, 0.6] },
  specks: { count: 900 },
};

function cliffMap() {
  const random = xorshift32(SEED ^ 0x0c1f_0c1f);
  const tone = periodicOctaves(CLIFF.tone, random);
  const warp = periodicValueNoise(4, random);
  const stoneWarpU = periodicValueNoise(5, random);
  const stoneWarpV = periodicValueNoise(5, random);
  const stoneMask = periodicOctaves(
    [
      { cells: 3, amp: 0.6 },
      { cells: 7, amp: 0.4 },
    ],
    random,
  );
  const stones = periodicWorley(CLIFF.stones.cells, random);
  const stoneShade = new Float32Array(CLIFF.stones.cells * CLIFF.stones.cells);
  for (let i = 0; i < stoneShade.length; i++) stoneShade[i] = random();
  const canvas = createCanvas(SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const t = clamp01(tone(u, v));
      let r = lerp(CLIFF.dark[0], CLIFF.soil[0], t);
      let g = lerp(CLIFF.dark[1], CLIFF.soil[1], t);
      let b = lerp(CLIFF.dark[2], CLIFF.soil[2], t);
      // Прослойки: волна по вертикали, искривлённая шумом, с второй гармоникой
      // для неровной толщины; гребень — светлый камень, ложбина — тёмная земля.
      const { strata } = CLIFF;
      const phase = (v + (warp(u, v) - 0.5) * strata.warp * 2) * strata.bands * Math.PI * 2;
      const wave = 0.7 * Math.sin(phase) + 0.3 * Math.sin(phase * 2.3 + 1.0);
      const band = Math.pow(clamp01((wave + 1) / 2), strata.sharpness);
      r = lerp(r, CLIFF.stone[0], band * 0.6);
      g = lerp(g, CLIFF.stone[1], band * 0.6);
      b = lerp(b, CLIFF.stone[2], band * 0.6);
      // Камни: каждая ячейка чуть своего тона, шов между ячейками темнее; вся
      // группа гаснет маской там, где стенка — просто земля.
      const { stones: cfg } = CLIFF;
      const su = u + (stoneWarpU(u, v) - 0.5) * cfg.warp * 2;
      const sv = v * 0.6 + (stoneWarpV(u, v) - 0.5) * cfg.warp * 2;
      const [f1, f2, id] = stones(su, sv);
      const seam = 1 - clamp01((f2 - f1) / cfg.seam);
      const relief = (stoneShade[id] - 0.5) * cfg.relief;
      const presence = smooth(clamp01((stoneMask(u, v) - cfg.mask[0]) / (cfg.mask[1] - cfg.mask[0])));
      const light = 1 + (relief - seam * 0.4) * presence;
      canvas.set(x, y, r * light, g * light, b * light);
    }
  }
  for (let i = 0; i < CLIFF.specks.count; i++) {
    const x = random() * SIZE;
    const y = random() * SIZE;
    const bright = random() < 0.5;
    canvas.stroke([[x, y]], bright ? 0.62 : 0.2, bright ? 0.55 : 0.15, bright ? 0.42 : 0.1, 0.5, 1.1);
  }
  return canvas.toRgb8();
}

const grass = encodePng(SIZE, SIZE, 3, grassMap());
writeFileSync(`${OUT_DIR}ground-grass.png`, grass);
const cliff = encodePng(SIZE, SIZE, 3, cliffMap());
writeFileSync(`${OUT_DIR}ground-cliff.png`, cliff);
process.stdout.write(
  `ground-grass.png: ${SIZE}×${SIZE} RGB, ${grass.length} байт\n` +
    `ground-cliff.png: ${SIZE}×${SIZE} RGB, ${cliff.length} байт\n`,
);
