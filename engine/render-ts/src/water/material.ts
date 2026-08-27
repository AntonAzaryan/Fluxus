/**
 * Материал воды (`rendering` REND-35, design D2, D3) — ОДНО фрагментное ядро и
 * два источника детали за общим интерфейсом семпла.
 *
 * Компилятора GLSL в гейте нет: WebGL-контекста у пакета не бывает (design D9).
 * Текст здесь стережёт тест сборки (`test/water.test.ts`) — что каждое имя
 * униформы, использованное в собранном фрагменте, в нём же и объявлено, в обоих
 * вариантах `#define` и при рябе и без неё; САМА программа компилируется только
 * у потребителя — `npm run demo` и `npm run bench:demo`.
 *
 * Ядро считает, в таком порядке: глубину из глубинной текстуры тела (design
 * D1), глубинный цвет с управляемым бэндингом, полосу пены у берега, возмущение
 * нормали (деталь плюс рябь REND-36), Fresnel-tint и блик направленного света
 * сцены. На выходе — ЛИНЕЙНЫЙ цвет (REND-34): сведение яркости, bloom, LUT и
 * маска тумана идут после, штатной цепочкой кадра, и собственного
 * полноэкранного прохода вода не добавляет.
 *
 * ## Деталь — `#define`, а не второй материал
 *
 * `sampleWaterDetail(world, t) → (наклон.xy, шум пены)` реализуется одним из
 * двух блоков: `procedural` — октавы value-шума, НИ ОДНОГО текстурного ассета
 * (умолчание и фолбэк недоступной текстуры), `textured` — tileable-нормали,
 * шум пены и необязательный flow map по ID дерева контента (ASSET-2). Всё остальное —
 * глубина, берег, бэндинг, пена, рябь — считается одинаково, поэтому
 * наблюдаемое поведение от источника детали не зависит (REND-35).
 *
 * ## Свет приходит механизмом three, а не соседней подсистемой
 *
 * `lights: true` — и рендерер сам кладёт в программу источники СЦЕНЫ
 * (`ambientLightColor`, `directionalLights`). Ссылки на подсистему освещения у
 * воды нет и не будет: подсистемы за общим контрактом друг о друге не знают
 * (REND-8), а второго перечня источников света в пакете быть не должно.
 */
import * as THREE from 'three';
import {
  WATER_FRESNEL_F0,
  WATER_FRESNEL_STRENGTH,
  WATER_MAX_OPACITY,
  WATER_SHININESS,
  WATER_SKY_TINT,
  WATER_SPECULAR,
  type WaterBodyConfig,
} from './config.js';

/** Позиция меша — уже мировая (меш строится в мировых координатах, REND-7). */
const WATER_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vViewPosition;

void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 viewPosition = viewMatrix * vec4(vWorld, 1.0);
  vViewPosition = -viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}
`;

/** Программный источник детали: две-три октавы value-шума, ноль ассетов. */
const DETAIL_PROCEDURAL = /* glsl */ `
float waterHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float waterNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = waterHash(cell);
  float b = waterHash(cell + vec2(1.0, 0.0));
  float c = waterHash(cell + vec2(0.0, 1.0));
  float d = waterHash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 sampleWaterDetail(vec2 world, float t) {
  vec2 uv = world / uDetailScale;
  vec2 slope = vec2(0.0);
  float foam = 0.0;
  float amp = 1.0;
  float total = 0.0;
  const float e = 0.08;
  for (int i = 0; i < WATER_DETAIL_LAYERS; i++) {
    float octave = 1.0 + float(i) * 1.7;
    float dir = mod(float(i), 2.0) < 0.5 ? 1.0 : -0.6;
    vec2 p = uv * octave + vec2(0.7, -0.4) * (t * uDetailSpeed * dir / uDetailScale);
    float h = waterNoise(p);
    slope += amp * octave * vec2(waterNoise(p + vec2(e, 0.0)) - h, waterNoise(p + vec2(0.0, e)) - h) / e;
    foam += amp * h;
    total += amp;
    amp *= 0.5;
  }
  return vec3(slope / max(total, 1e-4), foam / max(total, 1e-4));
}
`;

/** Текстурный источник детали: tileable-нормали, шум пены и flow map (ASSET-2). */
const DETAIL_TEXTURED = /* glsl */ `
uniform sampler2D tDetailNormal;
uniform sampler2D tDetailFoam;
#ifdef WATER_FLOW_MAP
uniform sampler2D tDetailFlow;
#endif

vec3 sampleWaterDetail(vec2 world, float t) {
  vec2 uv = world / uDetailScale;
#ifdef WATER_FLOW_MAP
  vec2 flow = texture2D(tDetailFlow, uv * 0.25).xy * 2.0 - 1.0;
#else
  vec2 flow = vec2(0.7, -0.4);
#endif
  vec2 slope = vec2(0.0);
  float total = 0.0;
  for (int i = 0; i < WATER_DETAIL_LAYERS; i++) {
    float octave = 1.0 + float(i) * 1.7;
    float dir = mod(float(i), 2.0) < 0.5 ? 1.0 : -0.6;
    vec2 p = uv * octave + flow * (t * uDetailSpeed * dir / uDetailScale);
    slope += (texture2D(tDetailNormal, p).xy * 2.0 - 1.0) * octave;
    total += 1.0;
  }
  float foam = texture2D(tDetailFoam, uv * 0.5 + flow * (t * uDetailSpeed * 0.3 / uDetailScale)).r;
  return vec3(slope / max(total, 1e-4), foam);
}
`;

/** Кольца ряби от uniform-источников (REND-36): вершины не двигаются. */
const RIPPLES = /* glsl */ `
uniform vec4 uRipples[WATER_RIPPLES];
uniform vec3 uRippleWave;

vec2 waterRippleSlope(vec2 world) {
  vec2 slope = vec2(0.0);
  for (int i = 0; i < WATER_RIPPLES; i++) {
    vec4 source = uRipples[i];
    if (source.w <= 0.0) continue;
    vec2 delta = world - source.xy;
    // Имя не distance: так называется встроенная функция GLSL, и переменная
    // её бы затенила — законно по спецификации, но разнобой драйверов на этом
    // ловится дороже, чем стоит короткое имя.
    float radius = length(delta);
    if (radius < 1e-4) continue;
    float front = uRippleWave.y * source.z;
    float phase = uRippleWave.x * (radius - front);
    float age = max(0.0, 1.0 - source.z * uRippleWave.z);
    slope += (delta / radius) * (cos(phase) * source.w * age * exp(-radius * 0.6));
  }
  return slope;
}
`;

const WATER_FRAGMENT_HEAD = /* glsl */ `
#include <common>
#include <lights_pars_begin>

varying vec3 vWorld;
varying vec3 vViewPosition;

uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uFoamColor;
uniform vec3 uSkyTint;
uniform sampler2D tDepth;
uniform vec4 uDepthRect;
uniform float uMaxDepth;
uniform float uBanding;
uniform float uFoamWidth;
uniform float uFoamHardness;
uniform float uTime;
uniform float uDetailScale;
uniform float uDetailSpeed;
uniform float uDetailStrength;
uniform float uMaxOpacity;
uniform float uFresnelF0;
uniform float uFresnelStrength;
uniform float uSpecular;
uniform float uShininess;

/**
 * Ступени глубинного цвета: 0 и 1 — плавный градиент, N >= 2 — cel-бэнды со
 * СГЛАЖЕННОЙ кромкой (design D3).
 *
 * Кромка шириной в один экранный шаг градиента (fwidth): у почти горизонтальной
 * плоскости воды при изометрии полоса бэнда занимает десятки пикселей, и
 * жёсткая граница ползёт по ней ступеньками пикселей — тем самым алиасингом,
 * ради которого сглаживание в решении и названо. Шире делать нельзя: бэнды
 * расплылись бы в градиент, и cel-заливка перестала бы быть cel-заливкой.
 */
float waterBanded(float t) {
  if (uBanding < 2.0) return t;
  float scaled = t * uBanding;
  float index = floor(scaled);
  float edge = clamp(fwidth(scaled), 1e-4, 0.5);
  float blend = smoothstep(1.0 - edge, 1.0, scaled - index);
  return clamp(min(index + blend, uBanding - 1.0) / (uBanding - 1.0), 0.0, 1.0);
}
`;

const WATER_FRAGMENT_MAIN = /* glsl */ `
void main() {
  vec2 world = vWorld.xy;
  // Глубина = урез − поле (REND-35). Берег здесь и рождается: клеточная карта
  // лишь ограничила меш, а линию воды рисует знак этой разности.
  float depth = texture2D(tDepth, (world - uDepthRect.xy) / uDepthRect.zw).r;
  if (depth <= 0.0) discard;

  vec3 detail = sampleWaterDetail(world, uTime);
  vec2 slope = detail.xy * uDetailStrength;
#if WATER_RIPPLES > 0
  slope += waterRippleSlope(world);
#endif
  vec3 normal = normalize(vec3(-slope, 1.0));

  float t = clamp(depth / uMaxDepth, 0.0, 1.0);
  vec3 albedo = mix(uShallowColor, uDeepColor, waterBanded(t));

  // Полоса пены живёт ГЛУБИНОЙ, а не границей клеток: она следует берегу.
  float band = 1.0 - smoothstep(0.0, max(uFoamWidth, 1e-4), depth);
  float ragged = clamp(band * (0.55 + 0.9 * detail.z), 0.0, 1.0);
  float foam = mix(ragged, smoothstep(0.45, 0.55, ragged), uFoamHardness);
  albedo = mix(albedo, uFoamColor, foam);

  vec3 viewNormal = normalize((viewMatrix * vec4(normal, 0.0)).xyz);
  vec3 viewDir = normalize(vViewPosition);
  vec3 irradiance = ambientLightColor;
  vec3 specular = vec3(0.0);
#if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    vec3 toLight = directionalLights[i].direction;
    irradiance += directionalLights[i].color * max(dot(viewNormal, toLight), 0.0);
    vec3 halfDir = normalize(toLight + viewDir);
    specular += directionalLights[i].color * pow(max(dot(viewNormal, halfDir), 0.0), uShininess);
  }
#endif

  float facing = clamp(dot(normal, normalize(cameraPosition - vWorld)), 0.0, 1.0);
  float fresnel = uFresnelF0 + (1.0 - uFresnelF0) * pow(1.0 - facing, 5.0);
  float tint = clamp(fresnel * uFresnelStrength, 0.0, 1.0);
  vec3 color = mix(albedo * irradiance, uSkyTint * irradiance, tint);
  color += specular * uSpecular;

  // Мелкая вода прозрачнее глубокой — дно обязано читаться; пена и блик
  // скользящего угла, наоборот, укрывают его.
  float alpha = mix(0.35, uMaxOpacity, t);
  alpha = mix(max(alpha, foam), 1.0, tint);
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

/**
 * Сборка фрагментного текста под источник детали и наличие ряби (design D2).
 * Блок ряби ВЫРЕЗАЕТСЯ из текста, а не гасится препроцессором: тело с нулевым
 * пределом источников не должно нести ни строки кода, которого оно не считает,
 * — так «рябь выключена» видно в самой программе, а не только в её `#define`.
 */
export function waterFragmentShader(textured: boolean, ripples: number): string {
  return `${WATER_FRAGMENT_HEAD}
${ripples > 0 ? RIPPLES : ''}
${textured ? DETAIL_TEXTURED : DETAIL_PROCEDURAL}
${WATER_FRAGMENT_MAIN}`;
}

/** Что материалу нужно сверх авторской записи тела: действующие потолки и текстуры. */
export interface WaterMaterialInput {
  readonly body: WaterBodyConfig;
  /** Мировая высота уреза и шаг высоты — перевод шкалы уровней (REND-7). */
  readonly heightStep: number;
  /** Действующее число слоёв детали — авторское под потолком (QUAL-1). */
  readonly layers: number;
  /** Действующий предел источников ряби — авторский под потолком; 0 — ряби нет. */
  readonly rippleSources: number;
  /** Глубинная текстура тела (design D1). */
  readonly depth: THREE.Texture;
  /** Мировой охват глубинной текстуры: origin.xy, size.xy. */
  readonly depthRect: THREE.Vector4;
  /** Загруженные текстуры детали; отсутствие — procedural-фолбэк (REND-35). */
  readonly detailNormal?: THREE.Texture | null;
  readonly detailFoam?: THREE.Texture | null;
  readonly detailFlow?: THREE.Texture | null;
}

/**
 * Материал тела воды: прозрачный, без записи глубины (design D6) — порядок
 * прозрачных задаёт `renderOrder` меша, а не этот материал.
 *
 * Текстурный источник выбирается ДАННЫМИ тела и наличием ассетов: `textured`
 * без загруженной карты нормалей означает procedural-деталь и предупреждение
 * (REND-35), и решение это принимает подсистема — здесь только следствие.
 */
export function createWaterMaterial(input: WaterMaterialInput): THREE.ShaderMaterial {
  const { body } = input;
  const textured =
    body.detail.source === 'textured' &&
    input.detailNormal != null &&
    input.detailFoam != null;
  const defines: Record<string, string> = {
    WATER_DETAIL_LAYERS: String(Math.max(1, Math.floor(input.layers))),
    WATER_RIPPLES: String(Math.max(0, Math.floor(input.rippleSources))),
  };
  if (textured) {
    defines.WATER_DETAIL_TEXTURED = '';
    if (input.detailFlow != null) defines.WATER_FLOW_MAP = '';
  }
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.lights,
    {
      uShallowColor: { value: null },
      uDeepColor: { value: null },
      uFoamColor: { value: null },
      uSkyTint: { value: null },
      tDepth: { value: null },
      uDepthRect: { value: null },
      uMaxDepth: { value: 0 },
      uBanding: { value: 0 },
      uFoamWidth: { value: 0 },
      uFoamHardness: { value: 0 },
      uTime: { value: 0 },
      uDetailScale: { value: 1 },
      uDetailSpeed: { value: 0 },
      uDetailStrength: { value: 0 },
      uMaxOpacity: { value: WATER_MAX_OPACITY },
      uFresnelF0: { value: WATER_FRESNEL_F0 },
      uFresnelStrength: { value: WATER_FRESNEL_STRENGTH },
      uSpecular: { value: WATER_SPECULAR },
      uShininess: { value: WATER_SHININESS },
      uRipples: { value: new Float32Array(4 * Math.max(1, input.rippleSources)) },
      uRippleWave: { value: new THREE.Vector3() },
      tDetailNormal: { value: null },
      tDetailFoam: { value: null },
      tDetailFlow: { value: null },
    },
  ]);
  const material = new THREE.ShaderMaterial({
    vertexShader: WATER_VERTEX,
    fragmentShader: waterFragmentShader(textured, input.rippleSources),
    uniforms,
    defines,
    lights: true,
    transparent: true,
    depthWrite: false,
  });
  applyWaterUniforms(material, input, textured);
  return material;
}

/**
 * Числа записи тела в униформы материала: перевод шкалы уровней в мировую
 * (REND-7), цвета и параметры волны. Вызывается сборкой материала — правка
 * секции в рантайме (ED-15) идёт пересборкой тела, потому что `#define`
 * источника детали, числа слоёв и предела источников ряби живут в программе.
 */
function applyWaterUniforms(
  material: THREE.ShaderMaterial,
  input: WaterMaterialInput,
  textured: boolean,
): void {
  const { body, heightStep } = input;
  const u = material.uniforms;
  setColor(u.uShallowColor!, body.shallowColor);
  setColor(u.uDeepColor!, body.deepColor);
  setColor(u.uFoamColor!, body.foamColor);
  setColor(u.uSkyTint!, WATER_SKY_TINT);
  u.tDepth!.value = input.depth;
  u.uDepthRect!.value = input.depthRect;
  // Величины секции — в ШКАЛЕ УРОВНЕЙ (REND-35); в мировую их переводит рендер
  // своим шагом высоты (REND-7), и это единственная точка перевода.
  u.uMaxDepth!.value = body.maxDepth * heightStep;
  u.uFoamWidth!.value = body.foamWidth * heightStep;
  u.uBanding!.value = body.banding;
  u.uFoamHardness!.value = body.foamHardness;
  u.uDetailScale!.value = body.detail.scale;
  u.uDetailSpeed!.value = body.detail.speed;
  u.uDetailStrength!.value = body.detail.strength;
  u.tDetailNormal!.value = textured ? (input.detailNormal ?? null) : null;
  u.tDetailFoam!.value = textured ? (input.detailFoam ?? null) : null;
  u.tDetailFlow!.value = textured ? (input.detailFlow ?? null) : null;
  const wave = u.uRippleWave!.value as THREE.Vector3;
  wave.set(
    (2 * Math.PI) / Math.max(body.ripples.wavelength, 1e-4),
    body.ripples.speed,
    1 / Math.max(body.ripples.decaySeconds, 1e-4),
  );
}

/**
 * Линейный цвет конфигурации — в `THREE.Color` униформы БЕЗ второго переноса
 * (REND-34): перенос sRGB → линейное сделан один раз, на приёме секции
 * (`water/config.ts`), и повторять его здесь значило бы затемнить воду дважды.
 * Объект униформы переиспользуется: правка секции — событие, а не кадр, но
 * лишний `THREE.Color` на каждое число всё равно ни к чему.
 */
function setColor(uniform: THREE.IUniform, color: { r: number; g: number; b: number }): void {
  const current = uniform.value as THREE.Color | null;
  const target = current instanceof THREE.Color ? current : new THREE.Color();
  target.setRGB(color.r, color.g, color.b, THREE.LinearSRGBColorSpace);
  uniform.value = target;
}
