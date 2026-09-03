/**
 * Ручки качества подсистемы террейна (`render-quality` QUAL-1, QUAL-3) — их
 * имена и объявление. Отдельно от подсистемы, потому что это ДАННЫЕ: перечень
 * рычагов, их семантика и границы читаются целиком и не перемежаются кодом
 * пересборки чанков, а имя ручки принадлежит владельцу — подсистеме террейна.
 */
import { TERRAIN_MAX_SLOTS } from './terrainTileset.js';
import type { QualityDeclaration } from '../types.js';

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1): плотность разбиения
 * клетки с кривизной — ПОТОЛОК над значением конфига рендера (REND-9), а не
 * значение вместо него (design D3).
 */
export const TERRAIN_TESSELLATION = 'terrain.curvatureTessellation';

/**
 * Вторая ручка качества (QUAL-1, QUAL-3): потолок числа СМЕШИВАЕМЫХ слотов
 * покрытия (REND-39). Потолок ниже числа слотов tileset'а сливает его хвост в
 * последний оставшийся слот — выборок в фрагменте становится меньше, арена
 * беднеет покрытиями, но не чернеет; единица означает покрытие первым слотом
 * без смешивания вовсе.
 */
export const TERRAIN_TEXTURE_SLOTS = 'terrain.textureSlots';

/** Объявление ручек подсистемы (QUAL-1): зовётся один раз, при регистрации. */
export function terrainQualityDeclaration(subsystem: string): QualityDeclaration {
  return {
    subsystem,
    knobs: [
      {
        name: TERRAIN_TESSELLATION,
        cost:
          'вершины и треугольники визуальной поверхности: клетка с кривизной даёт N×N подклеток, ' +
          'кромки стенок и юбки обрыва под ней делятся на N пролётов (REND-9, REND-7)',
        semantics: 'ceiling',
        // Потолка нет — действует значение конфига рендера (REND-9).
        default: Number.POSITIVE_INFINITY,
        min: 1,
        max: 16,
      },
      {
        name: TERRAIN_TEXTURE_SLOTS,
        cost: 'выборки текстур покрытия на фрагмент пола: слот — одна выборка (REND-39)',
        semantics: 'ceiling',
        default: Number.POSITIVE_INFINITY,
        min: 1,
        max: TERRAIN_MAX_SLOTS,
      },
    ],
  };
}
