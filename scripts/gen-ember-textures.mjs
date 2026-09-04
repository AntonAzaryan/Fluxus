#!/usr/bin/env node
/**
 * Генератор АТЛАСА КАДРОВ уголька (`assets` ASSET-14, флипбук):
 * `content/visuals/textures/ember-flipbook.png` — сетка 4×4 из шестнадцати
 * кадров 64×64, по которым эмиттер ведёт кадр частицы поведением
 * `FrameOverLife`. Запуск: `npm run textures:ember` из корня.
 *
 * Зачем свой генератор, а не лист от художника: флипбук — это не картинка, а
 * ПОСЛЕДОВАТЕЛЬНОСТЬ, и в ней важно ровно то, что задаётся числом, — как
 * уголёк остывает и распадается по фазе жизни. Здесь эта фаза записана
 * формулой, поэтому дифф текстуры есть дифф формулы, а не «художник перерисовал
 * иначе». Настоящий лист заменяет этот файл правкой контента и кода не требует
 * (ASSET-14: новый эффект — ассет плюс запись манифеста).
 *
 * Детерминированно: свой xorshift32 с фиксированным зерном (общий кирпич
 * `scripts/lib/texgen.mjs`), поэтому повторный запуск даёт те же байты.
 * Искры одного кадра — те же искры на всех кадрах: их углы и скорости
 * разыгрываются ОДИН раз, до цикла по кадрам, и кадр отличается только фазой.
 *
 * Альфы у файла нет намеренно: атлас — карта эмиттера со СЛОЖЕНИЕМ
 * (`blending: 2` документа эффекта), где чёрное не добавляет ничего и работает
 * прозрачностью. Отдельный канал прозрачности здесь был бы вторым описанием
 * того же — и первым, что разъедется с палитрой кадра.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clamp01, encodePng, lerp, rgbOf, xorshift32 } from './lib/texgen.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = `${ROOT}content/visuals/textures/`;

/** Сетка атласа: столбцы × строки кадров. Те же числа — `uTileCount`/`vTileCount` документа эффекта. */
const COLUMNS = 4;
const ROWS = 4;
/** Сторона одного кадра в текселях. */
const FRAME = 64;
const FRAMES = COLUMNS * ROWS;

const SEED = 0x0e_be_4a11;

/**
 * Палитра остывания: цвет ядра по фазе жизни. Уголёк начинается почти белым,
 * желтеет, краснеет и уходит в тёмный багрянец — дальше его гасит яркость.
 */
const HEAT = [
  { at: 0.0, color: '#fff6d2' },
  { at: 0.25, color: '#ffd170' },
  { at: 0.55, color: '#ff8a2a' },
  { at: 0.8, color: '#e0380c' },
  { at: 1.0, color: '#5a0a02' },
];

/** Ядро: доля половины кадра в начале и в конце жизни. */
const CORE_FROM = 0.34;
const CORE_TO = 0.1;
/** Сколько искр разлетается от ядра. */
const SPARKS = 9;
/** Разлёт искры в долях половины кадра: от начала жизни к концу. */
const SPARK_FROM = 0.12;
const SPARK_TO = 0.82;
/** Радиус искры в долях половины кадра в начале жизни. */
const SPARK_RADIUS = 0.13;

/** Цвет ядра на фазе `t` — кусочно-линейная интерполяция палитры остывания. */
function heatAt(t) {
  let lo = HEAT[0];
  let hi = HEAT[HEAT.length - 1];
  for (let i = 1; i < HEAT.length; i++) {
    if (t <= HEAT[i].at) {
      lo = HEAT[i - 1];
      hi = HEAT[i];
      break;
    }
  }
  const span = hi.at - lo.at;
  const k = span <= 0 ? 0 : clamp01((t - lo.at) / span);
  const a = rgbOf(lo.color);
  const b = rgbOf(hi.color);
  return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
}

/**
 * Мягкое пятно: яркость `1` в центре и `0` на границе радиуса, сглаженная
 * `t²(3 − 2t)`. Та же формула, что режет квад эмиттера в круг у `fire-soft.png`,
 * — здесь она рисует и ядро, и каждую искру.
 */
function blob(dx, dy, radius) {
  if (radius <= 0) return 0;
  const r = Math.hypot(dx, dy) / radius;
  if (r >= 1) return 0;
  const t = 1 - r;
  return t * t * (3 - 2 * t);
}

/** Искры: углы, скорости и размеры разыгрываются один раз на весь атлас. */
function sparks() {
  const random = xorshift32(SEED);
  const list = [];
  for (let i = 0; i < SPARKS; i++) {
    list.push({
      // Угол — равномерный сектор с разбросом: голый равномерный угол собирает
      // искры в видимые лучи «звезды», а сектор со сдвигом их разводит.
      angle: ((i + random()) / SPARKS) * Math.PI * 2,
      speed: 0.55 + 0.45 * random(),
      size: 0.6 + 0.7 * random(),
      // Своя фаза угасания: искры гаснут не разом.
      fade: 1.1 + 0.9 * random(),
    });
  }
  return list;
}

/** Кадр `index` из `FRAMES`: фаза жизни `t = index / (FRAMES − 1)`. */
function drawFrame(pixels, atlasWidth, col, row, index, dust) {
  const t = index / (FRAMES - 1);
  const half = FRAME / 2;
  const core = lerp(CORE_FROM, CORE_TO, t) * half;
  const glow = Math.pow(1 - t, 1.2);
  const [cr, cg, cb] = heatAt(t);
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      // Ядро плюс его широкий ореол: без ореола уголёк на сложении выглядит
      // вырезанным кружком, а не свечением.
      let value = blob(dx, dy, core) + 0.35 * blob(dx, dy, core * 2.6);
      for (const spark of dust) {
        const travel = lerp(SPARK_FROM, SPARK_TO, t) * spark.speed * half;
        const sx = dx - Math.cos(spark.angle) * travel;
        const sy = dy - Math.sin(spark.angle) * travel;
        const radius = SPARK_RADIUS * spark.size * (1 - t) * half;
        value += 0.8 * Math.pow(1 - t, spark.fade) * blob(sx, sy, radius);
      }
      const level = clamp01(value) * glow;
      const at = ((row * FRAME + y) * atlasWidth + col * FRAME + x) * 3;
      pixels[at] = Math.round(clamp01(cr * level) * 255);
      pixels[at + 1] = Math.round(clamp01(cg * level) * 255);
      pixels[at + 2] = Math.round(clamp01(cb * level) * 255);
    }
  }
}

const width = COLUMNS * FRAME;
const height = ROWS * FRAME;
const pixels = Buffer.alloc(width * height * 3);
const dust = sparks();
for (let index = 0; index < FRAMES; index++) {
  drawFrame(pixels, width, index % COLUMNS, Math.floor(index / COLUMNS), index, dust);
}
const png = encodePng(width, height, 3, pixels);
writeFileSync(`${OUT_DIR}ember-flipbook.png`, png);
process.stdout.write(
  `ember-flipbook.png: ${width}×${height} RGB, сетка ${COLUMNS}×${ROWS} по ${FRAME}px, ${png.length} байт\n`,
);
