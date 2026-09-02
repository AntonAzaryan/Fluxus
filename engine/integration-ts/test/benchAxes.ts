/**
 * Оси масштабирования синтетической нагрузки рендера (`performance-budget`
 * PERF-6) — общая часть двух гейтов: стоимости работы (`cost.test.ts`) и
 * занятой памяти (`footprint.test.ts`).
 *
 * Данные здесь, а не в одном из тестов, ровно потому, что обоим нужна ОДНА И ТА
 * ЖЕ нагрузка: разъехавшись, оси мерили бы разные сцены под одним именем, и
 * отношение L/S в двух эталонах перестало бы читаться вместе. Каждая ось
 * двигает РОВНО одну величину — иначе отношение L/S нечему было бы приписать.
 */
import { benchGrid, PresentationBench, type SyntheticLoad } from './benchLoad.js';
import type { QualityPreset } from '@fluxus/render';
import { BENCH_PRESETS } from './benchLoad.js';

/** Сторона синтетической арены в клетках — общая у всех осей. */
export const SCALING_EXTENT = 16;

/** Шаг решётки укрытий по умолчанию: без укрытий теневой путь маски мёртв (FOW-9). */
const SCALING_PILLARS = 4;

export const BASE_LOAD: SyntheticLoad = {
  entities: 64,
  observers: 4,
  vision: 1.5,
  extent: SCALING_EXTENT,
  shots: 4,
};

export interface ScalingSize {
  /** Величина оси — то единственное, чем размеры и различаются. */
  readonly magnitude: number;
  readonly pillarStep: number;
  readonly resolution: number;
  readonly load: SyntheticLoad;
  /**
   * Документ пресета размера; нет — базовый ультра-документ стенда. Отличаться
   * от него вправе ровно та ось, чья величина ЕСТЬ значение ручки: у террейна
   * плотность разбиения приходит только потолком пресета (QUAL-1) — авторское
   * значение живёт конфигом рендера и осью быть не может.
   */
  readonly preset?: QualityPreset;
}

export interface ScalingAxis {
  readonly axis: string;
  readonly small: ScalingSize;
  readonly large: ScalingSize;
}

function size(magnitude: number, over: Partial<ScalingSize> = {}): ScalingSize {
  return {
    magnitude,
    pillarStep: SCALING_PILLARS,
    resolution: 4,
    load: BASE_LOAD,
    ...over,
  };
}

/** Сколько cliff-отрезков даёт решётка укрытий шагом `step` — величина своей оси. */
function segmentsOf(step: number): number {
  return benchGrid(SCALING_EXTENT, step).cliffs.length;
}

/**
 * Документ оси разбиения террейна: базовый ультра плюс потолок (QUAL-1). Ручка
 * потолочная, поэтому действующая плотность — min(конфига рендера, потолка), и
 * величиной оси служит именно потолок: он один и приходит извне подсистемы.
 */
function tessellationCeiling(ceiling: number): QualityPreset {
  return Object.freeze({ ...BENCH_PRESETS.ultra, 'terrain.curvatureTessellation': ceiling });
}

/** Оси и их размеры S/L (PERF-6). */
export const SCALING_AXES: readonly ScalingAxis[] = [
  {
    axis: 'entities',
    small: size(32, { load: { ...BASE_LOAD, entities: 32 } }),
    large: size(256, { load: { ...BASE_LOAD, entities: 256 } }),
  },
  {
    axis: 'fogObservers',
    small: size(4, { load: { ...BASE_LOAD, observers: 4 } }),
    large: size(32, { load: { ...BASE_LOAD, observers: 32 } }),
  },
  {
    axis: 'cliffSegments',
    small: size(segmentsOf(8), { pillarStep: 8 }),
    large: size(segmentsOf(2), { pillarStep: 2 }),
  },
  {
    axis: 'maskResolution',
    small: size(4, { resolution: 4 }),
    large: size(8, { resolution: 8 }),
  },
  {
    // Число событий одноразового эффекта в доставке (REND-24): выстрелы —
    // единственная работа частиц, которую двигает СВОЯ величина, а не состав
    // сущностей; оболочки типов при этом стоят на месте, и отношение L/S
    // приписывается частицам целиком.
    axis: 'particleShots',
    small: size(4, { load: { ...BASE_LOAD, shots: 4 } }),
    large: size(32, { load: { ...BASE_LOAD, shots: 32 } }),
  },
  {
    // Потолок плотности разбиения клеток с кривизной (REND-9, QUAL-1): пол
    // растёт его КВАДРАТОМ, стенки — линейно, и обе зависимости читаются
    // отношением L/S. Авторская плотность конфига рендера у обоих размеров одна.
    axis: 'terrainTessellation',
    small: size(2, { preset: tessellationCeiling(2) }),
    large: size(4, { preset: tessellationCeiling(4) }),
  },
];

/**
 * Презентационный стенд одного размера оси.
 *
 * Базовый документ осей — ультра, то есть без потолков (стенд без пресета берёт
 * его сам): ось «разрешение маски» ДВИГАЕТ ту самую величину, которую потолок
 * ограничивает, и второй пресет мерил бы здесь не рост от разрешения, а работу
 * min() — она проверена на матчах (QUAL-4) и в `render-ts`. Ось разбиения
 * террейна — исключение по механике, а не по вкусу: авторская плотность
 * приходит конфигом рендера, и подвинуть её снаружи можно только потолком.
 *
 * Строится стенд ВЫЗЫВАЮЩИМ, а не этим модулем «заодно с доставкой»: гейт
 * стоимости держит сборку ВНЕ замера (её работа — не доставка), а гейт памяти —
 * ВНУТРИ (ресурсы, заведённые сборкой, и есть занятая память).
 */
export function benchFor(config: ScalingSize): PresentationBench {
  return new PresentationBench({
    grid: benchGrid(SCALING_EXTENT, config.pillarStep),
    resolution: config.resolution,
    ...(config.preset !== undefined ? { preset: config.preset } : {}),
  });
}
