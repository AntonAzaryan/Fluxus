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
 * D1), возмущение нормали (деталь плюс рябь REND-36), глубинный цвет с
 * управляемым бэндингом, каустику на мелководье, полосу пены у берега,
 * Fresnel-tint и блик направленного света сцены. На выходе — ЛИНЕЙНЫЙ цвет
 * (REND-34): сведение яркости, bloom, LUT и маска тумана идут после, штатной
 * цепочкой кадра, и собственного полноэкранного прохода вода не добавляет.
 *
 * ## Что делает воду водой под изометрией
 *
 * Камера смотрит под ~50° и не двигается, поэтому зеркальное отражение неба
 * и блик солнца сами по себе почти не работают: Френель у такого угла —
 * единицы процентов, а зеркальная конфигурация с солнцем случается лишь в
 * одной фазе суточного цикла. Живость поверхности даёт другое: диффузное
 * освещение ВОЗМУЩЁННОЙ нормали (рябь читается светотенью), каустика на
 * мелководье, рваная и набегающая пена у берега и дно, просвечивающее через
 * мелкую воду. Блик остаётся — нормированный Blinn-Phong под Френелем Шлика,
 * то есть искры там и только там, где наклон ряби ловит солнце.
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
 * (`ambientLightColor`, `directionalLights`) и их теневые карты
 * (`directionalShadowMap`, REND-30). Ссылки на подсистему освещения у воды нет
 * и не будет: подсистемы за общим контрактом друг о друге не знают (REND-8), а
 * второго перечня источников света и второй теневой карты в пакете быть не
 * должно — тень читается штатными чанками три, теми же, что у остальной сцены.
 */
import * as THREE from 'three';
import {
  WATER_CAUSTICS,
  WATER_FRESNEL_F0,
  WATER_FRESNEL_STRENGTH,
  WATER_MAX_OPACITY,
  WATER_MIN_OPACITY,
  WATER_SHININESS,
  WATER_SKY_TINT,
  WATER_SPECULAR,
  type WaterBodyConfig,
} from './config.js';
import { uniformOf } from '../uniforms.js';
import { own } from '../footprint.js';

/**
 * Позиция меша — уже мировая (меш строится в мировых координатах, REND-7).
 *
 * Координаты теневых карт считает штатный чанк три: ему нужна `worldPosition`
 * ровно этим именем, и `vDirectionalShadowCoord` он объявляет и заполняет сам.
 * Нормали у геометрии воды нет (плоскость на урезе), поэтому `HAS_NORMAL` три
 * не определяет и нормального смещения тени в чанке не будет — для плоскости
 * оно и не нужно.
 */
const WATER_VERTEX = /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>

varying vec3 vWorld;
varying vec3 vViewPosition;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorld = worldPosition.xyz;
  vec4 viewPosition = viewMatrix * worldPosition;
  vViewPosition = -viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
  #include <shadowmap_vertex>
}
`;

/**
 * Программный источник детали: две-три октавы value-шума, ноль ассетов.
 * Наклон — градиент шума; слои с шагом масштаба 1.7 и встречным сносом,
 * веса убывают с частотой, чтобы мелкий слой оживлял, а не зашумлял.
 */
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
  float total = 0.0;
  const float e = 0.08;
  for (int i = 0; i < WATER_DETAIL_LAYERS; i++) {
    float octave = 1.0 + float(i) * 1.7;
    float dir = mod(float(i), 2.0) < 0.5 ? 1.0 : -0.6;
    float weight = inversesqrt(octave);
    vec2 p = uv * octave + vec2(0.7, -0.4) * (t * uDetailSpeed * dir / uDetailScale);
    float h = waterNoise(p);
    slope += weight * vec2(waterNoise(p + vec2(e, 0.0)) - h, waterNoise(p + vec2(0.0, e)) - h) / e;
    foam += weight * h;
    total += weight;
  }
  return vec3(slope / max(total, 1e-4), foam / max(total, 1e-4));
}

float sampleWaterCaustic(vec2 world, float t) {
  vec2 uv = world / (uDetailScale * 0.6);
  vec2 drift = vec2(0.7, -0.4) * (t * uDetailSpeed / uDetailScale);
  float a = 1.0 - abs(2.0 * waterNoise(uv + drift) - 1.0);
  float b = 1.0 - abs(2.0 * waterNoise(uv * 1.31 + vec2(0.37, 0.61) - drift * 0.8) - 1.0);
  float c = min(a, b);
  return c * c * c;
}
`;

/**
 * Текстурный источник детали: tileable-нормали, шум пены и flow map (ASSET-2).
 * Карта нормалей читается в стандартной раскладке (`rg` — xy нормали), поэтому
 * наклон — её xy со знаком минус. Нечётные слои берутся с переставленными
 * осями: одна и та же карта в трёх масштабах иначе выдаёт себя решёткой.
 * Шум пены — по каналам: R — сеть каустики, G — пятна рваной кромки, B —
 * зерно пузырьков внутри пены (`scripts/gen-water-textures.mjs`).
 */
const DETAIL_TEXTURED = /* glsl */ `
uniform sampler2D tDetailNormal;
uniform sampler2D tDetailFoam;
#ifdef WATER_FLOW_MAP
uniform sampler2D tDetailFlow;
#endif

vec2 waterFlow(vec2 uv) {
#ifdef WATER_FLOW_MAP
  return texture2D(tDetailFlow, uv * 0.25).xy * 2.0 - 1.0;
#else
  return vec2(0.7, -0.4);
#endif
}

vec3 sampleWaterDetail(vec2 world, float t) {
  vec2 uv = world / uDetailScale;
  vec2 flow = waterFlow(uv);
  vec2 slope = vec2(0.0);
  float total = 0.0;
  for (int i = 0; i < WATER_DETAIL_LAYERS; i++) {
    float octave = 1.0 + float(i) * 1.7;
    bool odd = mod(float(i), 2.0) >= 0.5;
    float dir = odd ? -0.6 : 1.0;
    float weight = inversesqrt(octave);
    vec2 p = (odd ? uv.yx : uv) * octave + flow * (t * uDetailSpeed * dir / uDetailScale);
    vec2 n = texture2D(tDetailNormal, p).xy * 2.0 - 1.0;
    slope -= (odd ? n.yx : n) * weight;
    total += weight;
  }
  vec3 grain = texture2D(tDetailFoam, uv * 1.5 + flow * (t * uDetailSpeed * 0.3 / uDetailScale)).rgb;
  return vec3(slope / max(total, 1e-4), grain.g * (0.8 + 0.2 * grain.b));
}

float sampleWaterCaustic(vec2 world, float t) {
  vec2 uv = world / (uDetailScale * 0.6);
  vec2 drift = waterFlow(uv) * (t * uDetailSpeed / uDetailScale);
  float a = texture2D(tDetailFoam, uv + drift).r;
  float b = texture2D(tDetailFoam, uv.yx * 1.31 + vec2(0.37, 0.61) - drift * 0.8).r;
  return min(a, b) * 1.6 + (a + b) * 0.1;
}
`;

/**
 * Кольца ряби от uniform-источников (REND-36): вершины не двигаются.
 *
 * Одно кольцо — ОДИН расходящийся гребень, а не набор концентрических: косинус
 * окном прижат к фронту `front = скорость × возраст`, и вне окна кольца нет.
 * Окно — гауссиана по расстоянию до фронта с σ в половину длины волны
 * (`uRippleWave.w` = `1/(2σ²)`), то есть гребень шириной примерно в волну:
 * рябь от шага читается расходящимся кругом, а не рисунком на воде вокруг
 * юнита. Амплитуда падает С ФРОНТОМ (`/(1 + front)`), а не с расстоянием от
 * центра: гаснет само кольцо по мере расхождения, и точка его рождения ничем
 * не выделена — это и есть кольцо, оставленное позади, а не нимб источника.
 *
 * Бюджет фрагмента прежний: РОВНО один `exp` и один `cos` на источник, и
 * дороже перехода к следу картинка не стала (QUAL-3, PERF-3).
 */
const RIPPLES = /* glsl */ `
uniform vec4 uRipples[WATER_RIPPLES];
uniform vec4 uRippleWave;

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
    float offset = radius - front;
    float phase = uRippleWave.x * offset;
    float fade = max(0.0, 1.0 - source.z * uRippleWave.z);
    float window = exp(-offset * offset * uRippleWave.w);
    slope += (delta / radius) * (cos(phase) * source.w * fade * window / (1.0 + front));
  }
  return slope;
}
`;

const WATER_FRAGMENT_HEAD = /* glsl */ `
#include <common>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>

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
uniform float uCaustics;
uniform float uMinOpacity;
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
  // Глубина для пены зашумлена — кромка рваная, а не контур поля; сама линия
  // воды (discard выше) остаётся точной линией пересечения уреза полем.
  float w = max(uFoamWidth, 1e-4);
  float noise = detail.z;
  float ragged = depth + (noise - 0.5) * w * 0.8;
  float shore = 1.0 - smoothstep(0.0, w, ragged);
  float breath = 0.5 + 0.5 * sin(uTime * 1.3 + noise * 6.2832);
  float crest = smoothstep(0.25, 0.7, shore * (0.6 + 0.5 * noise + 0.2 * breath));
  // Набегающие гребни: тонкие линии, идущие к берегу по глубине.
  float lap = (1.0 - smoothstep(w, 2.5 * w, ragged)) *
    smoothstep(0.85, 0.97, 0.5 + 0.5 * sin(ragged / w * 3.0 - uTime * 2.0 + noise * 0.8));
  float mixed = clamp(crest + 0.5 * lap, 0.0, 1.0);
  float foam = mix(mixed, smoothstep(0.4, 0.6, mixed), uFoamHardness);

  // Каустика — сеть света на мелководье; с глубиной гаснет вместе с дном, а
  // под пеной её нет: пена — на поверхности, сеть — на дне под ней.
  float caustic = sampleWaterCaustic(world, uTime);
  float shallow = 1.0 - t;
  albedo *= 1.0 + caustic * uCaustics * shallow * shallow * (1.0 - foam);
  albedo = mix(albedo, uFoamColor, foam);

  vec3 viewNormal = normalize((viewMatrix * vec4(normal, 0.0)).xyz);
  vec3 viewDir = normalize(vViewPosition);
  float facing = clamp(dot(viewNormal, viewDir), 0.0, 1.0);
  float fresnel = uFresnelF0 + (1.0 - uFresnelF0) * pow(1.0 - facing, 5.0);

  vec3 irradiance = ambientLightColor;
  vec3 specular = vec3(0.0);
#if NUM_DIR_LIGHTS > 0
  // Переменные подняты НАД циклом, а сам цикл помечен unroll_loop_start:
  // массивы теневых сэмплеров индексируются только константой, поэтому три
  // разворачивает такие циклы сама — а разворот склеивает тела без скобок, и
  // объявление внутри стало бы повторным. Тот же приём и по той же причине,
  // что в lights_fragment_begin самой библиотеки.
  vec3 toLight;
  float lit;
  float shade;
  vec3 halfDir;
  float ndh;
  float vdh;
  float schlick;
  float lobe;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  DirectionalLightShadow waterShadow;
  #endif
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    toLight = directionalLights[ i ].direction;
    lit = max(dot(viewNormal, toLight), 0.0);
    // Тень читается ТОЙ ЖЕ картой, что у остальной сцены (REND-30): река под
    // кэшированной тенью плато обязана быть в тени, иначе вода — единственная
    // поверхность кадра, освещённая как на солнце. Стоимость — одна выборка на
    // фрагмент, и её нет вовсе, когда режим теней сцены выключен: без
    // USE_SHADOWMAP этот блок в программу не попадает (QUAL-1, ручка
    // lighting.shadowMode), поэтому своей ручки вода не заводит.
    shade = 1.0;
    #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
    waterShadow = directionalLightShadows[ i ];
    shade = receiveShadow ? getShadow( directionalShadowMap[ i ], waterShadow.shadowMapSize, waterShadow.shadowIntensity, waterShadow.shadowBias, waterShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
    #endif
    lit *= shade;
    irradiance += directionalLights[ i ].color * lit;
    halfDir = normalize(toLight + viewDir);
    ndh = max(dot(viewNormal, halfDir), 0.0);
    vdh = max(dot(viewDir, halfDir), 0.0);
    // Шлик по полувектору: у воды в упор отражается ~2%, и блик обязан это
    // помнить — иначе солнце заливает всю плоскость одним пятном.
    schlick = uFresnelF0 + (1.0 - uFresnelF0) * pow(1.0 - vdh, 5.0);
    // Нормированный Blinn-Phong, (n + 8) / 8π: острее лепесток — ярче искра.
    lobe = pow(ndh, uShininess) * (uShininess + 8.0) / 25.1327;
    // Блик гаснет вместе с диффузным: искра в тени плато — та же ложь о свете.
    specular += directionalLights[ i ].color * lobe * schlick * min(lit * 4.0, 1.0);
  }
  #pragma unroll_loop_end
#endif

  float tint = clamp(fresnel * uFresnelStrength, 0.0, 1.0);
  vec3 color = mix(albedo * irradiance, uSkyTint * irradiance, tint);
  specular *= uSpecular;
  color += specular;

  // Мелкая вода прозрачнее глубокой — дно обязано читаться; пена, искра и
  // блик скользящего угла, наоборот, укрывают его.
  float alpha = mix(uMinOpacity, uMaxOpacity, t);
  alpha = max(alpha, foam);
  alpha = max(alpha, clamp(dot(specular, vec3(0.3333)), 0.0, 1.0));
  alpha = mix(alpha, 1.0, tint);
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
      uCaustics: { value: WATER_CAUSTICS },
      uMinOpacity: { value: WATER_MIN_OPACITY },
      uMaxOpacity: { value: WATER_MAX_OPACITY },
      uFresnelF0: { value: WATER_FRESNEL_F0 },
      uFresnelStrength: { value: WATER_FRESNEL_STRENGTH },
      uSpecular: { value: WATER_SPECULAR },
      uShininess: { value: WATER_SHININESS },
      uRipples: { value: new Float32Array(4 * Math.max(1, input.rippleSources)) },
      uRippleWave: { value: new THREE.Vector4() },
      tDetailNormal: { value: null },
      tDetailFoam: { value: null },
      tDetailFlow: { value: null },
    },
  ]);
  const material = own(
    'material',
    'water',
    new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX,
      fragmentShader: waterFragmentShader(textured, input.rippleSources),
      uniforms,
      defines,
      lights: true,
      transparent: true,
      depthWrite: false,
    }),
  );
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
  setColor(uniformOf(material, 'uShallowColor'), body.shallowColor);
  setColor(uniformOf(material, 'uDeepColor'), body.deepColor);
  setColor(uniformOf(material, 'uFoamColor'), body.foamColor);
  setColor(uniformOf(material, 'uSkyTint'), WATER_SKY_TINT);
  uniformOf(material, 'tDepth').value = input.depth;
  uniformOf(material, 'uDepthRect').value = input.depthRect;
  // Величины секции — в ШКАЛЕ УРОВНЕЙ (REND-35); в мировую их переводит рендер
  // своим шагом высоты (REND-7), и это единственная точка перевода.
  uniformOf(material, 'uMaxDepth').value = body.maxDepth * heightStep;
  uniformOf(material, 'uFoamWidth').value = body.foamWidth * heightStep;
  uniformOf(material, 'uBanding').value = body.banding;
  uniformOf(material, 'uFoamHardness').value = body.foamHardness;
  uniformOf(material, 'uDetailScale').value = body.detail.scale;
  uniformOf(material, 'uDetailSpeed').value = body.detail.speed;
  uniformOf(material, 'uDetailStrength').value = body.detail.strength;
  uniformOf(material, 'tDetailNormal').value = textured ? (input.detailNormal ?? null) : null;
  uniformOf(material, 'tDetailFoam').value = textured ? (input.detailFoam ?? null) : null;
  uniformOf(material, 'tDetailFlow').value = textured ? (input.detailFlow ?? null) : null;
  const wave = uniformOf(material, 'uRippleWave').value as THREE.Vector4;
  const wavelength = Math.max(body.ripples.wavelength, 1e-4);
  wave.set(
    (2 * Math.PI) / wavelength,
    body.ripples.speed,
    1 / Math.max(body.ripples.decaySeconds, 1e-4),
    // Коэффициент окна гребня: σ в половину длины волны, то есть `1/(2σ²)` —
    // это `2/λ²`. Считается здесь, а не во фрагменте: число постоянно на всё
    // тело, и делить его на каждом фрагменте не за чем.
    2 / (wavelength * wavelength),
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
