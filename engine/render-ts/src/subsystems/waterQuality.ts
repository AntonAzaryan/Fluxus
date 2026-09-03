/**
 * Ручки качества подсистемы воды (`render-quality` QUAL-1, QUAL-3) — их имена,
 * границы и объявление. Отдельно от подсистемы по той же причине, что у
 * террейна: это ДАННЫЕ — перечень рычагов и их семантика, — и читаются они
 * целиком, не перемежаясь кодом тел и перезаполнения глубины.
 */
import { WATER_MAX_RIPPLE_SOURCES } from '@fluxus/assets';
import type { QualityDeclaration } from '../types.js';

/**
 * Ручки качества подсистемы (`render-quality` QUAL-1, QUAL-3; design D7) — все
 * три ПОТОЛКИ с семантикой `min(авторское, потолок)`: пресет вправе удешевить
 * воду, но MUST NOT поднять её выше авторской и MUST NOT тронуть документ сцены.
 */
export const WATER_RIPPLE_SOURCES = 'water.rippleSources';
export const WATER_DETAIL_LAYERS = 'water.detailLayers';
export const WATER_DEPTH_TEXELS_PER_CELL = 'water.depthTexelsPerCell';

/**
 * Верхняя граница потолка источников — предел uniform-векторов (REND-36, D5).
 * Число берётся у формата секции (`@fluxus/assets`), а не набирается здесь
 * заново: тем же числом валидация ограничивает АВТОРСКОЕ значение, и разойдись
 * они — потолок пресета и предел документа стали бы двумя разными правилами.
 */
export const MAX_RIPPLE_SOURCES = WATER_MAX_RIPPLE_SOURCES;
/** Выше четырёх слоёв деталь перестаёт читаться, а фрагмент дорожает линейно. */
export const MAX_DETAIL_LAYERS = 4;
/** Шестнадцать текселей на клетку — предел, за которым берег уже не уточняется. */
export const MAX_DEPTH_TEXELS_PER_CELL = 16;
/** Объявление ручек подсистемы (QUAL-1): зовётся один раз, при регистрации. */
export function waterQualityDeclaration(subsystem: string): QualityDeclaration {
  return {
    subsystem,
    knobs: [
      {
        name: WATER_RIPPLE_SOURCES,
        cost: 'источники ряби: каждое кольцо считается на каждом фрагменте воды (REND-36)',
        semantics: 'ceiling',
        default: Number.POSITIVE_INFINITY,
        min: 0,
        max: MAX_RIPPLE_SOURCES,
      },
      {
        name: WATER_DETAIL_LAYERS,
        cost: 'слои детали поверхности: семплы карты нормалей либо октавы шума на фрагмент (REND-35)',
        semantics: 'ceiling',
        default: Number.POSITIVE_INFINITY,
        min: 1,
        max: MAX_DETAIL_LAYERS,
      },
      {
        name: WATER_DEPTH_TEXELS_PER_CELL,
        cost: 'тексели глубинных текстур тел: работа перезаполнения растёт квадратом плотности (REND-35)',
        semantics: 'ceiling',
        default: Number.POSITIVE_INFINITY,
        min: 1,
        max: MAX_DEPTH_TEXELS_PER_CELL,
      },
    ],
  };
}
