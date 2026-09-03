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
import { own } from '../footprint.js';

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
 * Разделяемый тент 3×3 — ядро И даунсемпла, и апсемпла пирамиды bloom (design
 * D4). Веса вынесены ЧИСЛАМИ, а не зашиты в текст программы, по одной причине:
 * по ним считается профиль свечения в тестах, и списанное рядом второе ядро
 * разошлось бы с шейдером молча.
 *
 * Смещения — в текселях ИСТОЧНИКА (`uTexel`), веса нормированы суммой 16.
 */
export const BLOOM_TENT_KERNEL: readonly { readonly dx: number; readonly dy: number; readonly weight: number }[] =
  Object.freeze([
    { dx: 0, dy: 0, weight: 4 },
    { dx: 1, dy: 0, weight: 2 },
    { dx: -1, dy: 0, weight: 2 },
    { dx: 0, dy: 1, weight: 2 },
    { dx: 0, dy: -1, weight: 2 },
    { dx: 1, dy: 1, weight: 1 },
    { dx: -1, dy: -1, weight: 1 },
    { dx: 1, dy: -1, weight: 1 },
    { dx: -1, dy: 1, weight: 1 },
  ]);

/** Сумма весов ядра — нормировка тента; считается из него же, а не пишется рядом. */
export const BLOOM_TENT_WEIGHT_SUM = BLOOM_TENT_KERNEL.reduce((sum, tap) => sum + tap.weight, 0);

/** Текст выборки тента: одно и то же ядро в двух проходах пирамиды. */
function tentSampler(sampler: string): string {
  const taps = BLOOM_TENT_KERNEL.map(
    (tap) =>
      `  sum += texture2D(${sampler}, vUv + vec2(${tap.dx.toFixed(1)}, ${tap.dy.toFixed(1)}) * uTexel).rgb * ${tap.weight.toFixed(1)};`,
  ).join('\n');
  return `vec3 tent() {\n  vec3 sum = vec3(0.0);\n${taps}\n  return sum / ${BLOOM_TENT_WEIGHT_SUM.toFixed(1)};\n}`;
}

/**
 * Даунсемпл яруса пирамиды (design D4): тент 3×3 по текселям ИСТОЧНИКА. Ярус
 * вдвое мельче предыдущего, поэтому размытие идёт не шириной ядра, а самой
 * пирамидой — но собирается оно ПРОГРЕССИВНЫМ АПСЕМПЛОМ (см. ниже), а не
 * сложением всех ярусов в сведении.
 */
export const BLOOM_DOWNSAMPLE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform vec2 uTexel;

${tentSampler('tSource')}

void main() {
  gl_FragColor = vec4(tent(), 1.0);
}
`;

/**
 * Апсемпл яруса пирамиды (design D4, находка L-7 аудита 2026-09-03): тент 3×3 по
 * текселям МЕЛКОГО яруса, добавляемый к крупному аддитивным блендингом.
 *
 * Пирамида без апсемпла — коробчатые ореолы. Мелкий ярус (кадр/32 — это 60×34
 * текселя на 1080p) билинейно растянутый сразу на весь кадр даёт вокруг яркой
 * точки звезду и ступени, а не свечение: между его текселями нет ничего, кроме
 * прямой интерполяции. Схемы без гауссианы на каждом ярусе (CoD, Dual-Kawase)
 * ТРЕБУЮТ цепочки апсемплов 4→3→2→1→0 — размытие в них и собирается тентом на
 * каждой ступени вверх, а не одним растяжением.
 *
 * Вклад мелкого яруса — `uScale`: им управляет авторская ширина свечения
 * (`bloom.radius`, REND-34). Сложение идёт блендингом, а не чтением цели: читать
 * и писать одну цель в проходе нельзя.
 */
export const BLOOM_UPSAMPLE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSource;
uniform vec2 uTexel;
uniform float uScale;

${tentSampler('tSource')}

void main() {
  gl_FragColor = vec4(tent() * uScale, 1.0);
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
// Свечение приходит ОДНОЙ текстурой — вершиной пирамиды, в которую уже собраны
// все её ярусы цепочкой апсемплов (design D4, L-7). Ширина ореола живёт там же:
// её задаёт вклад мелких ярусов на каждой ступени вверх, а не веса здесь.
uniform sampler2D tBloom0;
uniform float uStrength;
#endif

#ifdef POST_TONE_MAPPING
#include <tonemapping_pars_fragment>
#endif

// Экспозиция БЕЗ оператора (REND-34): при операторе none формулы сведения в
// проходе нет, но авторское число секции обязано действовать — иначе одно и то
// же поле работало бы при одних операторах и молча ничего не значило при
// другом. Униформа названа так же, как в чанке three (toneMappingExposure):
// смысл у неё тот же — множитель яркости перед выводом, — и правится она одним
// кодом на оба случая (pushUniforms).
#ifdef POST_EXPOSURE
uniform float toneMappingExposure;
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
  color += uStrength * texture2D(tBloom0, vUv).rgb;
  #endif

  #ifdef POST_TONE_MAPPING
  color = POST_TONE_MAPPING(color);
  #endif

  // Место то же, что у оператора: чанк three умножает на экспозицию ВНУТРИ
  // формулы, то есть после сложения со свечением, — и голое умножение стоит
  // там же, иначе два способа записать «ярче» разошлись бы порядком.
  #ifdef POST_EXPOSURE
  color *= toneMappingExposure;
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
  const texture = own('texture', 'postprocess', new THREE.Data3DTexture(data, size, size, size));
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
  return own(
    'material',
    'postprocess',
    new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader,
      uniforms,
      ...(defines === undefined ? {} : { defines }),
      depthTest: false,
      depthWrite: false,
    }),
  );
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
 * Вклад мелкого яруса в крупный на одной ступени апсемпла — из авторской ширины
 * свечения (`bloom.radius`, REND-34). Узкий ореол (`radius = 0`) оставляет
 * мелким ярусам малую долю: свечение собирается почти целиком из крупных, то
 * есть жмётся к источнику. Широкий (`radius = 1`) отдаёт им почти всё, и ореол
 * расходится на весь кадр.
 *
 * Границы 0.35 и 0.95, а не 0 и 1: на нуле цепочка апсемплов выродилась бы в
 * вершину пирамиды без ярусов вовсе (то есть в отсутствие свечения), а на
 * единице каждая ступень удваивала бы вклад мелкого яруса — свечение росло бы
 * само по себе, без правки силы.
 */
export function bloomUpsampleScale(radius: number): number {
  const clamped = radius < 0 ? 0 : radius > 1 ? 1 : radius;
  return 0.35 + 0.6 * clamped;
}

/**
 * Материал одной ступени апсемпла (design D4, L-7): тент мелкого яруса,
 * ДОБАВЛЯЕМЫЙ к крупному. Блендинг аддитивный — крупный ярус в проходе читать
 * нельзя, он же и цель.
 */
export function createUpsampleMaterial(): THREE.ShaderMaterial {
  const material = fullscreenMaterial(BLOOM_UPSAMPLE_FRAGMENT, {
    tSource: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uScale: { value: 1 },
  });
  material.blending = THREE.AdditiveBlending;
  material.transparent = true;
  return material;
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
  } else {
    // Оператора нет — экспозиция всё равно действует, голым умножением
    // (REND-34): проход сведения на этой сцене существует (его завёл bloom либо
    // таблица цвета), и молча терять авторское число в нём нельзя.
    defines.POST_EXPOSURE = '';
    uniforms.toneMappingExposure = { value: config.exposure };
  }
  if (config.bloom) {
    defines.POST_BLOOM = '';
    // Одна текстура вместо пяти: ярусы уже сложены цепочкой апсемплов в вершину
    // пирамиды (design D4, L-7), и сведение читает ровно её.
    uniforms.tBloom0 = { value: null };
    uniforms.uStrength = { value: config.strength };
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
