/**
 * Конфигурация освещения сцены — ДАННЫЕ, а не механизм: секция `lighting`
 * парного presentation-документа (PRES-2), документированные умолчания и их
 * слияние. Живёт отдельно от подсистемы (`subsystems/lighting.ts`) по той же
 * причине, по которой политика живёт отдельно от механизма, и ровно тем же
 * швом, что конфигурация тумана (FOW-10): числа здесь правит дизайнер данными,
 * а подсистема ниже — их потребитель.
 *
 * Потолок пресета качества (QUAL-1) сюда не попадает намеренно: он ограничивает
 * ДЕЙСТВУЮЩЕЕ значение в подсистеме и авторскую секцию не трогает ни байтом.
 *
 * Умолчания списаны один в один с захардкоженного света, который до появления
 * подсистемы держали демо (`game/demo-ts/app/main.ts`) и вьюпорт редактора
 * (`editor/ui-ts/src/areas/sceneStage.ts`): сцена без секции обязана рисоваться
 * тем же кадром, что рисовалась.
 */
import type {
  PresentationLighting,
  PresentationShadowMode,
} from '@game-mvp/assets';
import { PRESENTATION_SHADOW_MODES } from '@game-mvp/assets';

/** Режим теней сцены — словарь формата, а не второй его перечень. */
export type ShadowMode = PresentationShadowMode;

/**
 * Действующая конфигурация освещения — секция `lighting` с закрытыми дырами.
 * Плоская: вложенность есть у авторского документа (там она группирует правку),
 * а подсистеме нужны значения, и лишний уровень она бы только разворачивала.
 */
export interface LightingRenderConfig {
  /** Тон рассеянного света, `#rrggbb`. */
  readonly ambientColor: string;
  /** Интенсивность рассеянного света. */
  readonly ambientIntensity: number;
  /** Тон направленного источника, `#rrggbb`. */
  readonly directionalColor: string;
  /** Суммарная интенсивность направленного источника — до деления на ярусы. */
  readonly directionalIntensity: number;
  /** Откуда светит источник: смещение его позиции от цели, мировые единицы. */
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  /** Режим теней: `none` < `hybrid` < `full` по стоимости. */
  readonly shadowMode: ShadowMode;
  /** Сторона карты теней в текселях. */
  readonly shadowMapSize: number;
  /**
   * Доля интенсивности, отданная кэшированной карте статики в `hybrid`;
   * остальное достаётся покадровой карте. Вне `hybrid` источник один, и доля
   * не применяется.
   */
  readonly staticShare: number;
}

/**
 * Документированные значения по умолчанию: свет работает и без секции
 * `lighting`. Ambient и направленный источник — ровно те числа, что до
 * появления подсистемы стояли в коде потребителей; тени по умолчанию выключены,
 * то есть сцена без секции платит за них ноль и выглядит как прежде.
 */
export const DEFAULT_LIGHTING_CONFIG: LightingRenderConfig = Object.freeze({
  ambientColor: '#ffffff',
  ambientIntensity: 0.65,
  directionalColor: '#ffffff',
  directionalIntensity: 1.7,
  directionX: 8,
  directionY: -12,
  directionZ: 18,
  shadowMode: 'none',
  // Половина типовой карты теней: у арены на десять игроков ортографический
  // фрустум обтягивает всю сетку, и 2048 текселей на её сторону — та плотность,
  // на которой кромка тени юнита ещё не пилится. Потолок пресета правит это
  // значение вниз (QUAL-1), вверх его правит только автор сцены.
  shadowMapSize: 2048,
  // Ровно пополам: в `hybrid` тень статики и тень динамики гасят по половине
  // вклада источника, и ни один ярус не выглядит нарисованным «поверх» другого.
  staticShare: 0.5,
} satisfies LightingRenderConfig);

/**
 * Ранг режима теней — его место в порядке стоимости (`none` < `hybrid` <
 * `full`). Существует ради потолка пресета: `min` над перечислением считается
 * по рангу, и второго определения этого порядка быть не должно.
 */
export function shadowModeRank(mode: ShadowMode): number {
  return PRESENTATION_SHADOW_MODES.indexOf(mode);
}

/** Дешевейший из двух режимов — семантика `ceiling` над перечислением (QUAL-1). */
export function minShadowMode(a: ShadowMode, b: ShadowMode): ShadowMode {
  return shadowModeRank(a) <= shadowModeRank(b) ? a : b;
}

/** Секция документа поверх умолчаний: отсутствующее поле — умолчание (PRES-2). */
export function resolveLightingConfig(section?: PresentationLighting): LightingRenderConfig {
  const ambient = section?.ambient;
  const directional = section?.directional;
  const direction = directional?.direction;
  const shadows = section?.shadows;
  const fallback = DEFAULT_LIGHTING_CONFIG;
  return {
    ambientColor: ambient?.color ?? fallback.ambientColor,
    ambientIntensity: ambient?.intensity ?? fallback.ambientIntensity,
    directionalColor: directional?.color ?? fallback.directionalColor,
    directionalIntensity: directional?.intensity ?? fallback.directionalIntensity,
    directionX: direction?.x ?? fallback.directionX,
    directionY: direction?.y ?? fallback.directionY,
    directionZ: direction?.z ?? fallback.directionZ,
    shadowMode: shadows?.mode ?? fallback.shadowMode,
    shadowMapSize: shadows?.mapSize ?? fallback.shadowMapSize,
    staticShare: shadows?.staticShare ?? fallback.staticShare,
  };
}
