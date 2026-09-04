/**
 * Конфигурация воды — ДАННЫЕ, а не механизм (`rendering` REND-35): секция
 * `water` парного presentation-документа (`presentation-scene` PRES-2),
 * документированные умолчания и их слияние. Живёт отдельно от подсистемы
 * (`subsystems/water.ts`) тем же швом, что конфигурация тумана (FOW-10),
 * освещения (REND-29) и пост-обработки (REND-34): числа здесь правит дизайнер
 * данными, а подсистема ниже — их потребитель.
 *
 * Потолки пресета качества (QUAL-1) сюда не попадают намеренно: они
 * ограничивают ДЕЙСТВУЮЩЕЕ значение в подсистеме и авторскую секцию не трогают
 * ни байтом (QUAL-3).
 *
 * ## Цвет конвертируется на приёме
 *
 * В документе цвет записан `#rrggbb` в sRGB — так его видит глаз в палитре
 * редактора и так его читает автор в диффе. Материал же выдаёт ЛИНЕЙНЫЙ цвет
 * (REND-34: из материалов кадра выходит линейный цвет, сведение яркости идёт
 * после), поэтому перенос делается ровно один раз — здесь, на приёме секции.
 * Явной функцией, а не через `THREE.Color`, потому что величина обязана быть
 * проверяемой числом: тест сверяет перенос с формулой sRGB, а не с состоянием
 * глобального `ColorManagement` библиотеки.
 */
import type {
  PresentationWater,
  PresentationWaterBody,
  PresentationWaterDetail,
  PresentationWaterDetailSource,
  PresentationWaterRipples,
} from '@fluxus/assets';

/** Линейный цвет — три компоненты [0, 1] рабочего пространства кадра (REND-34). */
export interface LinearColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Действующая деталь поверхности (REND-35): источник и его числа. */
export interface WaterDetailConfig {
  readonly source: PresentationWaterDetailSource;
  /** Слоёв детали: октав шума у `procedural`, семплов карты у `textured`. */
  readonly layers: number;
  /** Мировых единиц на период детали. */
  readonly scale: number;
  /** Скорость сноса детали, мировых единиц в секунду. */
  readonly speed: number;
  /** Сила возмущения нормали. */
  readonly strength: number;
  /** ID ассетов текстурной детали (ASSET-2); `null` — ассет не назван. */
  readonly normalMap: string | null;
  readonly foamNoise: string | null;
  readonly flowMap: string | null;
}

/** Действующая рябь (REND-36): авторские числа тела до потолка пресета. */
export interface WaterRipplesConfig {
  readonly sources: number;
  readonly wavelength: number;
  readonly speed: number;
  readonly amplitude: number;
  readonly decaySeconds: number;
  /** Порог скорости источника, мировых единиц ЗА ТИК (REND-36). */
  readonly minSpeed: number;
}

/**
 * Действующая запись тела — секция с закрытыми дырами. Плоская: вложенность
 * есть у авторского документа (там она группирует правку), а подсистеме нужны
 * значения, и лишний уровень она бы только разворачивала.
 */
export interface WaterBodyConfig {
  /** Урез в шкале уровней террейна; в мировую высоту его переводит рендер (REND-7). */
  readonly surfaceLevel: number;
  readonly shallowColor: LinearColor;
  readonly deepColor: LinearColor;
  /** Глубина полного цвета в шкале уровней. */
  readonly maxDepth: number;
  /** Число цветовых бэндов; 0 — плавный градиент (design D3). */
  readonly banding: number;
  /** Глубина, на которой гаснет пена, в шкале уровней. */
  readonly foamWidth: number;
  readonly foamColor: LinearColor;
  readonly foamHardness: number;
  readonly detail: WaterDetailConfig;
  readonly ripples: WaterRipplesConfig;
}

/** Действующая секция целиком: клеточная карта как есть и разобранные тела. */
export interface WaterRenderConfig {
  readonly cells: readonly string[];
  readonly bodies: readonly WaterBodyConfig[];
}

/**
 * Перенос sRGB → линейное пространство, канал (IEC 61966-2-1). Та самая
 * формула, которую применяет `THREE.Color` при включённом управлении цветом;
 * выписана здесь, чтобы величина оставалась проверяемой числом.
 */
function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * Цвет документа (`#rrggbb`, sRGB) в линейный (REND-34). Форму строки к этому
 * моменту уже проверила валидация секции (PRES-2), поэтому разбор здесь прямой.
 */
export function linearColorOf(hex: string): LinearColor {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: srgbChannelToLinear(Math.floor(value / 0x10000) / 255),
    g: srgbChannelToLinear((Math.floor(value / 0x100) % 0x100) / 255),
    b: srgbChannelToLinear((value % 0x100) / 255),
  };
}

/**
 * Документированные умолчания детали (REND-35). Источник `procedural` —
 * умолчание не по вкусу, а по требованию: вода обязана рисоваться полностью, не
 * загрузив ни одного текстурного ассета, — и он же фолбэк `textured`-тела, чьи
 * текстуры недоступны либо ещё не доехали.
 *
 * - `layers: 2` — две октавы шума читаются как рябь и не как решётка; третья
 *   стоит фрагменту столько же, сколько первые две вместе;
 * - `scale: 3` — период детали в три мировые единицы: крупнее юнита, мельче
 *   водоёма, поэтому масштаб читается при изометрической камере;
 * - `speed: 0.12` — снос заметен, но не «течёт рекой»: у стоячей воды движение
 *   должно читаться как дыхание поверхности;
 * - `strength: 0.35` — возмущение нормали, при котором блик дробится, а форма
 *   дна сквозь воду ещё читается.
 */
export const DEFAULT_WATER_DETAIL: WaterDetailConfig = Object.freeze({
  source: 'procedural',
  layers: 2,
  scale: 3,
  speed: 0.12,
  strength: 0.35,
  normalMap: null,
  foamNoise: null,
  flowMap: null,
} satisfies WaterDetailConfig);

/**
 * Документированные умолчания ряби (REND-36).
 *
 * - `sources: 8` — половина верхнего предела: столько КОЛЕЦ считает фрагмент, а
 *   идущий юнит держит их несколько сразу (`ripples.ts`), то есть восемь — это
 *   пара следов на дуэльной арене; потолок пресета режет число вниз (QUAL-1);
 * - `wavelength: 1.2` и `speed: 1.6` — гребень шире юнита и обгоняет его шаг:
 *   рябь читается расходящимся следом, а не облаком вокруг;
 * - `decaySeconds: 1.6` — след живёт около двух шагов и не копится в кашу; он
 *   же задаёт каденс: кольцо роняется вчетверо чаще, чем гаснет;
 * - `minSpeed: 0.01` мировой единицы ЗА ТИК — ниже этого сущность стоит, и
 *   поднимать от неё волну значило бы рябить от дрожания интерполяции.
 */
export const DEFAULT_WATER_RIPPLES: WaterRipplesConfig = Object.freeze({
  sources: 8,
  wavelength: 1.2,
  speed: 1.6,
  amplitude: 0.5,
  decaySeconds: 1.6,
  minSpeed: 0.01,
} satisfies WaterRipplesConfig);

/**
 * Умолчания записи тела (REND-35). Подобраны под stylized — арт-пресет демо
 * (design D3): `banding: 3` даёт cel-бэнды, жёсткая кромка пены — рисованный
 * берег. Semi-realistic получается теми же полями данными (`banding: 0`, мягкая
 * пена, `detail.source: "textured"`), без единой ветки в коде.
 *
 * `maxDepth: 0.5` — полшага уровня: на такой глубине вода уже «глубокая», и
 * лощина кривизны (амплитуда которой меньше полушага, REND-9) читается
 * градиентом целиком, а не одним цветом.
 */
export const DEFAULT_WATER_BODY = Object.freeze({
  maxDepth: 0.5,
  banding: 3,
  foamWidth: 0.08,
  foamColor: '#e8f4f7',
  foamHardness: 0.75,
});

/**
 * Плотность глубинной текстуры тела — текселей на клетку (design D1). Параметр
 * РЕНДЕРА, как шаг высоты и плотность разбиения кривизны (REND-7, REND-9):
 * авторского значения в документе у него нет, потолок пресета клампит его вниз
 * (`water.depthTexelsPerCell`, QUAL-1). Четыре текселя на клетку дают берегу
 * четверть клетки разрешения — на изометрии линия воды уже читается как линия,
 * а не как лесенка.
 */
export const DEFAULT_WATER_DEPTH_TEXELS_PER_CELL = 4;

/**
 * Отражательная способность воды при взгляде в упор (F0) — физическая
 * константа, а не настройка картинки: у воды это ≈0.02. Числом здесь потому,
 * что менять его нечему — материал у всех тел один, и «вода с другим F0» была
 * бы уже не водой.
 */
export const WATER_FRESNEL_F0 = 0.02;

/**
 * Доля неба, подмешиваемая на скользящих углах (Fresnel-tint). При изометрии
 * взгляд к воде почти постоянен, и весь диапазон Френеля отрабатывает узкая
 * полоса у дальнего берега — там подмес и виден.
 */
export const WATER_FRESNEL_STRENGTH = 0.6;

/** Тон подмеса — холодное небо изометрии; линейный (REND-34). */
export const WATER_SKY_TINT: LinearColor = Object.freeze(linearColorOf('#9fc6e8'));

/** Резкость блика направленного света: чем выше, тем мельче искры на ряби. */
export const WATER_SHININESS = 140;

/**
 * Сила блика направленного света сцены (REND-29) на поверхности воды. Лепесток
 * в материале нормирован и взвешен Френелем Шлика — то есть в упор отражает
 * ~2% света, — и множитель здесь возвращает искре яркость солнца: интенсивность
 * направленного источника сцены задана под диффузное освещение, а отражение
 * солнечного диска в воде на порядок ярче освещённой им земли.
 */
export const WATER_SPECULAR = 8;

/**
 * Сила каустики — сети света на мелководье; гаснет к глубине полного цвета.
 * Множитель яркости мелкого цвета: 0 — сети нет, 1 — линия сети вдвое ярче.
 */
export const WATER_CAUSTICS = 0.4;

/**
 * Непрозрачность у самого берега и на глубине полного цвета. У берега дно
 * должно читаться — иначе мелководье выглядит крашеным стеклом, — но и не
 * настолько, чтобы вода читалась цветом дна: половина — та доля, при которой
 * цвет мелкой воды ещё свой, а дно под ним ещё видно.
 */
export const WATER_MIN_OPACITY = 0.5;
export const WATER_MAX_OPACITY = 0.92;

function detailOf(section?: PresentationWaterDetail): WaterDetailConfig {
  const fallback = DEFAULT_WATER_DETAIL;
  return {
    source: section?.source ?? fallback.source,
    layers: section?.layers ?? fallback.layers,
    scale: section?.scale ?? fallback.scale,
    speed: section?.speed ?? fallback.speed,
    strength: section?.strength ?? fallback.strength,
    normalMap: section?.normalMap ?? fallback.normalMap,
    foamNoise: section?.foamNoise ?? fallback.foamNoise,
    flowMap: section?.flowMap ?? fallback.flowMap,
  };
}

function ripplesOf(section?: PresentationWaterRipples): WaterRipplesConfig {
  const fallback = DEFAULT_WATER_RIPPLES;
  return {
    sources: section?.sources ?? fallback.sources,
    wavelength: section?.wavelength ?? fallback.wavelength,
    speed: section?.speed ?? fallback.speed,
    amplitude: section?.amplitude ?? fallback.amplitude,
    decaySeconds: section?.decaySeconds ?? fallback.decaySeconds,
    minSpeed: section?.minSpeed ?? fallback.minSpeed,
  };
}

/** Запись тела поверх умолчаний: отсутствующее поле — умолчание (PRES-2). */
function resolveWaterBody(body: PresentationWaterBody): WaterBodyConfig {
  const fallback = DEFAULT_WATER_BODY;
  return {
    surfaceLevel: body.surfaceLevel,
    shallowColor: linearColorOf(body.shallowColor),
    deepColor: linearColorOf(body.deepColor),
    maxDepth: body.maxDepth ?? fallback.maxDepth,
    banding: body.banding ?? fallback.banding,
    foamWidth: body.foam?.width ?? fallback.foamWidth,
    foamColor: linearColorOf(body.foam?.color ?? fallback.foamColor),
    foamHardness: body.foam?.hardness ?? fallback.foamHardness,
    detail: detailOf(body.detail),
    ripples: ripplesOf(body.ripples),
  };
}

/**
 * Секция документа поверх умолчаний; `null` — секции нет, и сцена без воды
 * (REND-35): кадр рисуется байт-в-байт как до появления подсистемы, с нулевой
 * стоимостью (PERF-2). «Нет секции» и «секция с пустым списком тел» здесь
 * различимы намеренно: пустой список — авторское «водоёмов пока нет», и карта
 * при нём обязана оставаться проверенной.
 */
export function resolveWaterConfig(section?: PresentationWater): WaterRenderConfig | null {
  if (section === undefined) return null;
  return {
    cells: section.cells,
    bodies: section.bodies.map(resolveWaterBody),
  };
}
