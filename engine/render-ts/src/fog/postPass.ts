/**
 * Полноэкранный пост-проход тумана (design D2): текст его программы и
 * одноканальная текстура маски, которую он сэмплирует. Материал, униформы и
 * render target держит подсистема (`subsystems/fog.ts`). Врозь потому, что это
 * разные вещи: здесь — GLSL, который читают глазами, и обёртка растра, которая
 * от него неотделима, там — состояние кадра, которое читают тестами.
 */
import * as THREE from 'three';
import type { VisibilityMask } from './mask.js';


/** Полноэкранный треугольник не нужен: квад 2×2 в NDC, вершины насквозь. */
export const POST_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Реконструкция мировых XY по глубине и обратной view-projection (design D2):
 * фрагмент вне прямоугольника маски — туман (консервативность FOW-9 действует
 * и на края арены). Билинейный сэмпл маски сглаживает артефакты реконструкции
 * на кромках геометрии (design Risks); бикубический B-сплайн (`maskBicubic`)
 * доглаживает кромку тумана сверх билинейного.
 */
export const POST_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tMask;
uniform mat4 uInvViewProj;
uniform vec4 uMaskRect;
/** Размер текселя маски в её UV — вход бикубической выборки. */
uniform vec2 uMaskTexel;
uniform float uStrength;
uniform vec3 uColor;

/**
 * Бикубическая выборка маски B-сплайном через четыре билинейных тапа: кромка
 * тумана глаже билинейной на любом ракурсе камеры (FOW-7) — ромбы текселей не
 * читаются. Сглаживание симметрично, и ядро шириной ~2 текселя перекрыто
 * консервативным запасом радиуса (FOW-9).
 */
float maskBicubic(vec2 uv) {
  vec2 coord = uv / uMaskTexel - 0.5;
  vec2 f = fract(coord);
  vec2 base = (coord - f + 0.5) * uMaskTexel;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 p0 = base + (w1 / g0 - 1.0) * uMaskTexel;
  vec2 p1 = base + (w3 / g1 + 1.0) * uMaskTexel;
  float s00 = texture2D(tMask, vec2(p0.x, p0.y)).r;
  float s10 = texture2D(tMask, vec2(p1.x, p0.y)).r;
  float s01 = texture2D(tMask, vec2(p0.x, p1.y)).r;
  float s11 = texture2D(tMask, vec2(p1.x, p1.y)).r;
  return mix(mix(s00, s10, g1.x), mix(s01, s11, g1.x), g1.y);
}

void main() {
  vec4 scene = texture2D(tScene, vUv);
  float depth = texture2D(tDepth, vUv).x;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  vec2 xy = world.xy / world.w;
  vec2 uv = (xy - uMaskRect.xy) / uMaskRect.zw;
  float lit = 0.0;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    lit = maskBicubic(uv);
  }
  gl_FragColor = vec4(mix(scene.rgb, uColor, uStrength * (1.0 - lit)), scene.a);
  // Render target хранит рабочее (линейное) пространство: прямой вывод на
  // канвас три конвертирует сам, а ShaderMaterial обязан явно — без этих
  // строк весь кадр выводится линейным, то есть равномерно темнее (REND-1).
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Одноканальная текстура поверх растра маски; фильтрация билинейная (design D2). */
export function createMaskTexture(mask: VisibilityMask, shown: Uint8Array): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    shown,
    mask.width,
    mask.height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Однобайтовые ряды: без выравнивания в 1 байт ряд шириной не кратной 4
  // читался бы со сдвигом (правило распаковки GL, дефолт — 4).
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  // Счётчика здесь нет намеренно (PERF-3). Создание текстуры трафика не
  // порождает: three грузит растр на GPU по ВЕРСИИ, поднятой `needsUpdate`, и
  // взведённый здесь флаг сливается с флагом ближайшей публикации в одну
  // загрузку. Считать её дважды — приписать пустой байт: и на первой
  // перестройке, и на смене разрешения (там маска пересобирается и `built`
  // сбрасывается) счёт снимает единственное место — `publishTexture`.
  return texture;
}
