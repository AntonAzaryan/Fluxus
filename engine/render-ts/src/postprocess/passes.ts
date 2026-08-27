/**
 * Исходники шейдеров полноэкранных проходов пост-обработки (REND-34, design D1)
 * и словарь операторов сведения яркости (design D3) — только текст программы и
 * имена: цели, униформы и порядок проходов держит цепочка (`chain.ts`), как у
 * тумана GLSL живёт врозь с состоянием кадра (`fog/postPass.ts`).
 *
 * ## Почему свои проходы, а не EffectComposer (design D1)
 *
 * Composer владел бы порядком проходов и промежуточными целями, а по FOW-7 и
 * REND-31 ими обязаны владеть подсистемы: маска тумана — финальный проход
 * кадра, и её вход — выход ЭТИХ проходов. Новой зависимости при этом не
 * появляется — пакет и так собран на three.
 *
 * ## Почему формулы — чанки three (design D3)
 *
 * Операторы берутся из `ShaderChunk.tonemapping_pars_fragment` и включаются
 * define'ом материала: формулы не переписываются и совпадают с материальным
 * путём three до последнего коэффициента. `renderer.toneMapping` при этом
 * остаётся `NoToneMapping` — сведение делает ЭТОТ проход, а не материалы сцены,
 * иначе оно применилось бы к кадру дважды.
 */
import * as THREE from 'three';
import type { ColorLut } from '@fluxus/assets';
import type { ToneMappingOperator } from './config.js';

/** Ярусов пирамиды bloom (design D4): пять — как у схемы UnrealBloomPass. */
export const BLOOM_LEVELS = 5;

/**
 * Имя функции чанка three по оператору документа (design D3). `none` в словаре
 * нет: у него нет и прохода — сведение не выполняется вовсе.
 *
 * Словарь неполон намеренно: `CineonToneMapping` чанка в закрытый словарь
 * секции (REND-34) не входит, и заводить ему имя здесь значило бы обещать
 * оператор, которого документ не примет.
 */
const TONE_MAPPING_FUNCTIONS: Readonly<Record<ToneMappingOperator, string | null>> = Object.freeze({
  none: null,
  linear: 'LinearToneMapping',
  reinhard: 'ReinhardToneMapping',
  aces: 'ACESFilmicToneMapping',
  agx: 'AgXToneMapping',
  neutral: 'NeutralToneMapping',
});

/** Функция чанка для оператора; `null` — сведения нет (оператор `none`). */
export function toneMappingFunction(operator: ToneMappingOperator): string | null {
  return TONE_MAPPING_FUNCTIONS[operator];
}

/** Полноэкранный квад 2×2 в NDC, вершины насквозь — как у пост-прохода тумана. */
const FULLSCREEN_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Проход порога (REND-34): в пирамиду уходит только то, что ЯРЧЕ порога, и
 * порог меряется в линейных значениях ДО сведения яркости — цель сцены хранит
 * рабочее пространство, а оператор работает проходом ниже по цепочке.
 *
 * Яркость — линейная luma Rec.709: она же лежит в основе `LuminanceFormat`
 * three и совпадает с тем, что глаз читает как «ярко». Вклад берётся долей
 * превышения, а не срезом: тексель чуть ярче порога входит в свечение чуть-чуть,
 * и кромка светящегося тела не режется ступенью.
 */
const BLOOM_THRESHOLD_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform float uThreshold;

void main() {
  vec3 color = texture2D(tScene, vUv).rgb;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float over = max(0.0, luma - uThreshold);
  gl_FragColor = vec4(color * (over / max(luma, 1e-5)), 1.0);
}
`;

/**
 * Даунсемпл яруса пирамиды (design D4): разделяемый тент 3×3 по текселям
 * ИСТОЧНИКА. Ярус вдвое мельче предыдущего, поэтому размытие идёт не шириной
 * ядра, а самой пирамидой: широкий ореол собирается из мелких ярусов проходом
 * сведения, а не двадцатью тапами на каждом.
 */
const BLOOM_DOWNSAMPLE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform vec2 uTexel;

void main() {
  vec3 sum = texture2D(tSource, vUv).rgb * 4.0;
  sum += texture2D(tSource, vUv + vec2(uTexel.x, 0.0)).rgb * 2.0;
  sum += texture2D(tSource, vUv - vec2(uTexel.x, 0.0)).rgb * 2.0;
  sum += texture2D(tSource, vUv + vec2(0.0, uTexel.y)).rgb * 2.0;
  sum += texture2D(tSource, vUv - vec2(0.0, uTexel.y)).rgb * 2.0;
  sum += texture2D(tSource, vUv + uTexel).rgb;
  sum += texture2D(tSource, vUv - uTexel).rgb;
  sum += texture2D(tSource, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
  sum += texture2D(tSource, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
  gl_FragColor = vec4(sum / 16.0, 1.0);
}
`;

/**
 * Проход сведения — последний проход ЦЕПОЧКИ (REND-34): свечение пирамиды в
 * кадр, затем оператор. Оба вклада в одном проходе намеренно: разделять их
 * значило бы завести лишнюю полноэкранную цель и лишний проход ради порядка,
 * который и так соблюдён — свечение собрано из ДОТОНЕМАПНЫХ значений (порог
 * применён выше по цепочке), а оператор применяется к сумме.
 *
 * Финальным проходом КАДРА он не является: поверх ложится маска тумана (FOW-7),
 * и при построенной маске этот проход пишет не на экран, а в цель, которую
 * читает маскирующий проход.
 *
 * `#include <colorspace_fragment>` обязателен и здесь, и он же решает, кодировать
 * ли выход: three собирает `linearToOutputTexel` по НАЗНАЧЕНИЮ прохода — при
 * записи в цель это тождество (рабочее пространство сохраняется для маски), при
 * выводе на канвас — sRGB-кодирование. Одного текста программы поэтому хватает
 * на оба назначения.
 */
export const RESOLVE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;

#ifdef POST_BLOOM
uniform sampler2D tBloom0;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform sampler2D tBloom3;
uniform sampler2D tBloom4;
uniform float uStrength;
uniform float uRadius;

/**
 * Вес яруса: узкий ореол — вклад крупных ярусов, широкий — мелких. Униформа
 * uRadius переводит одно в другое зеркалом веса, как композит UnrealBloomPass.
 */
float bloomWeight(float factor) {
  return mix(factor, 1.2 - factor, uRadius);
}
#endif

#ifdef POST_TONE_MAPPING
#include <tonemapping_pars_fragment>
#endif

#ifdef POST_LUT
uniform sampler3D tLut;
uniform float uLutSize;
uniform float uLutAmount;

/**
 * Выборка таблицы цвета (REND-34).
 *
 * ДОМЕН ТАБЛИЦЫ — ОТОБРАЖАЕМЫЙ КАДР, а не линейное рабочее пространство:
 * .cube-файл автор снимает в пакете цветокоррекции с той картинки, которую
 * видит, то есть с sRGB-кодированных значений («таблица авторится по итоговому
 * виду кадра», REND-34). Поэтому вход кодируется в sRGB перед выборкой, а
 * результат раскодируется обратно — проход остаётся в линейном пространстве и
 * не зависит от своего НАЗНАЧЕНИЯ (цель или канвас), как и весь остальной
 * resolve. Отдав таблице линейные значения, мы кормили бы её не тем доменом, и
 * грейд читался бы неверно на всём кадре, а не в крайних точках.
 *
 * Обе функции переноса объявлены префиксом фрагментного шейдера three
 * (чанк colorspace_pars_fragment), тем же, откуда берётся linearToOutputTexel
 * для include colorspace_fragment ниже.
 *
 * Координата узла берётся в ЦЕНТРЕ текселя — иначе линейная фильтрация на краях
 * решётки тянула бы значение за её границу и крайние цвета кадра поехали бы. Та
 * же нормировка, что у эталонных реализаций формата .cube: масштаб (N-1)/N плюс
 * полтекселя.
 */
vec3 lutLookup(vec3 rgb) {
  vec3 encoded = sRGBTransferOETF(vec4(clamp(rgb, 0.0, 1.0), 1.0)).rgb;
  vec3 scale = vec3((uLutSize - 1.0) / uLutSize);
  vec3 offset = vec3(1.0 / (2.0 * uLutSize));
  vec3 graded = texture(tLut, scale * encoded + offset).rgb;
  return sRGBTransferEOTF(vec4(graded, 1.0)).rgb;
}
#endif

void main() {
  vec3 color = texture2D(tScene, vUv).rgb;

  #ifdef POST_BLOOM
  vec3 glow = bloomWeight(1.0) * texture2D(tBloom0, vUv).rgb;
  glow += bloomWeight(0.8) * texture2D(tBloom1, vUv).rgb;
  glow += bloomWeight(0.6) * texture2D(tBloom2, vUv).rgb;
  glow += bloomWeight(0.4) * texture2D(tBloom3, vUv).rgb;
  glow += bloomWeight(0.2) * texture2D(tBloom4, vUv).rgb;
  color += uStrength * glow;
  #endif

  #ifdef POST_TONE_MAPPING
  color = POST_TONE_MAPPING(color);
  #endif

  // LUT — ПОСЛЕ сведения яркости и ДО кодирования цветового пространства
  // (REND-34): таблица авторится по сведённому кадру, а место до кодирования
  // выбрано потому, что кодирование зависит от НАЗНАЧЕНИЯ прохода (цель или
  // канвас), и коррекция после него давала бы два разных кадра из одной таблицы.
  #ifdef POST_LUT
  color = mix(color, lutLookup(color), uLutAmount);
  #endif

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Трёхмерная текстура из данных ассета таблицы цвета (REND-34, ASSET-5): ассет
 * отдаёт разделяемые ЧИСЛА, а GPU-объект строит потребитель — здесь.
 *
 * Формат — RGBA8, а не float: таблица применяется ПОСЛЕ сведения яркости, то
 * есть к отображаемому диапазону [0, 1], и восьми бит на канал ей ровно
 * столько, сколько несёт сам кадр. Линейная фильтрация байтовой текстуры
 * гарантирована везде, а у float она требует расширения, которого на слабом
 * железе может не быть, — то есть ровно там, где LUT и нужен вместо теней.
 */
export function createLutTexture(lut: ColorLut): THREE.Data3DTexture {
  const size = lut.size;
  const texels = size * size * size;
  const data = new Uint8Array(texels * 4);
  for (let index = 0; index < texels; index++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = lut.data[index * 3 + channel] ?? 0;
      data[index * 4 + channel] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
    data[index * 4 + 3] = 255;
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  // Значения таблицы — СЫРЫЕ: и вход, и выход выборки живут в отображаемом
  // домене, а переносы делает сам шейдер (`lutLookup`). Объявленное цветовое
  // пространство заставило бы три конвертировать их за нас, и перенос
  // применился бы дважды.
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Края решётки — крайние цвета кадра: повтор или зеркало завернули бы белое
  // в чёрное. Зажим по всем трём осям, включая третью (`wrapR`).
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Материал полноэкранного прохода: глубина ему не нужна ни на чтение, ни на запись. */
function fullscreenMaterial(
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  defines?: Record<string, string>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    ...(defines === undefined ? {} : { defines }),
    depthTest: false,
    depthWrite: false,
  });
}

/** Материал прохода порога (REND-34): вход — цель сцены, порог — униформа. */
export function createThresholdMaterial(threshold: number): THREE.ShaderMaterial {
  return fullscreenMaterial(BLOOM_THRESHOLD_FRAGMENT, {
    tScene: { value: null },
    uThreshold: { value: threshold },
  });
}

/** Материал одного даунсемпла пирамиды: у каждого яруса свой (design D4). */
export function createDownsampleMaterial(): THREE.ShaderMaterial {
  return fullscreenMaterial(BLOOM_DOWNSAMPLE_FRAGMENT, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
  });
}

/**
 * Материал прохода сведения. Оператор и наличие свечения — DEFINE'Ы (design D3):
 * их смена пересобирает ОДИН этот материал — событие правки (ED-15), а не
 * кадровый путь; материалы сцены при этом не перекомпилируются вовсе.
 *
 * Экспозиция названа именем чанка (`toneMappingExposure`) намеренно: чанк
 * объявляет её сам, а рендерер на обновлении материала кладёт в программу своё
 * `renderer.toneMappingExposure`. Униформа материала грузится ПОСЛЕ него
 * (`WebGLRenderer.setProgram`), поэтому действует авторское число секции, а не
 * состояние рендерера, которого этот пакет не держит.
 */
export function createResolveMaterial(config: {
  readonly operator: ToneMappingOperator;
  readonly exposure: number;
  readonly bloom: boolean;
  readonly strength: number;
  readonly radius: number;
  /** Загруженная таблица цвета либо `null` — её наличие включает define POST_LUT. */
  readonly lut: THREE.Data3DTexture | null;
  readonly lutAmount: number;
}): THREE.ShaderMaterial {
  const operator = toneMappingFunction(config.operator);
  const uniforms: Record<string, THREE.IUniform> = { tScene: { value: null } };
  const defines: Record<string, string> = {};
  if (operator !== null) {
    defines.POST_TONE_MAPPING = operator;
    uniforms.toneMappingExposure = { value: config.exposure };
  }
  if (config.bloom) {
    defines.POST_BLOOM = '';
    for (let level = 0; level < BLOOM_LEVELS; level++) uniforms[`tBloom${level}`] = { value: null };
    uniforms.uStrength = { value: config.strength };
    uniforms.uRadius = { value: config.radius };
  }
  const lut = config.lut;
  if (lut !== null) {
    defines.POST_LUT = '';
    uniforms.tLut = { value: lut };
    uniforms.uLutSize = { value: lut.image.width };
    uniforms.uLutAmount = { value: config.lutAmount };
  }
  // `glslVersion` НЕ поднимается до GLSL3, хотя `sampler3D` — тип из GLSL ES
  // 3.00, и поднимать его не нужно: не-raw `ShaderMaterial` three компилирует
  // как `#version 300 es` всегда (`WebGLProgram`, ветка
  // `isRawShaderMaterial !== true`), а `precision <p> sampler3D` объявляет её
  // `generatePrecision`. Явный GLSL3, наоборот, СНИМАЕТ шим GLSL1-записи —
  // `layout(location = 0) out highp vec4 pc_fragColor` и
  // `#define gl_FragColor pc_fragColor` три добавляет только при
  // `glslVersion !== GLSL3`, — и текст этого прохода, пишущий `gl_FragColor` и
  // подключающий `<colorspace_fragment>`, перестал бы компилироваться на каждом
  // кадре с таблицей. Головой такое не ловится: программы здесь компилирует GPU,
  // а тесты пакета headless, — поэтому версия закреплена тестом.
  return fullscreenMaterial(RESOLVE_FRAGMENT, uniforms, defines);
}
