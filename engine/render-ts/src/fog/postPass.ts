/**
 * Исходники шейдеров полноэкранного пост-прохода тумана (design D2) — только
 * текст программы: материал, униформы и render target держит подсистема
 * (`subsystems/fog.ts`). Врозь потому, что это разные вещи: здесь — GLSL,
 * который читают глазами, там — состояние кадра, которое читают тестами.
 */

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
 * на кромках геометрии (design Risks).
 */
export const POST_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tMask;
uniform mat4 uInvViewProj;
uniform vec4 uMaskRect;
uniform float uStrength;
uniform vec3 uColor;
void main() {
  vec4 scene = texture2D(tScene, vUv);
  float depth = texture2D(tDepth, vUv).x;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  vec2 xy = world.xy / world.w;
  vec2 uv = (xy - uMaskRect.xy) / uMaskRect.zw;
  float lit = 0.0;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    lit = texture2D(tMask, uv).r;
  }
  gl_FragColor = vec4(mix(scene.rgb, uColor, uStrength * (1.0 - lit)), scene.a);
  // Render target хранит рабочее (линейное) пространство: прямой вывод на
  // канвас три конвертирует сам, а ShaderMaterial обязан явно — без этих
  // строк весь кадр выводится линейным, то есть равномерно темнее (REND-1).
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
