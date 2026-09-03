/**
 * Материалы террейна (REND-7): пол, стенки обрывов и юбка границы пола. Три
 * разделяемых материала на всю арену — по одному на ярус геометрии, а не по
 * одному на чанк: чанки делят их и потому не растят число программ.
 *
 * Отдельно от подсистемы, потому что это её ЕДИНСТВЕННАЯ точка создания
 * ресурсов GPU помимо геометрии чанков, и учёт памяти (PERF-8) читается в одном
 * месте: владелец `terrain`, вид `material`. Текстурирование (REND-39) эти же
 * материалы дорабатывает — подменяет цвет пола смесью слотов и кладёт карту
 * покрытия стенкам, — поэтому его вход описан типом `TerrainTilesetMaterials`
 * рядом с ним (`terrainTileset.ts`).
 */
import * as THREE from 'three';
import { own } from '../footprint.js';
import type { TerrainTilesetMaterials } from './terrainTileset.js';

/** Цвета трёх ярусов; нет текстурирования — арена рисуется ими (REND-7). */
export interface TerrainMaterialColors {
  readonly floor: number;
  readonly wall: number;
  readonly skirt: number;
}

/** Общее у трёх: шершавая неметаллическая поверхность под светом сцены. */
const SURFACE = { roughness: 0.95, metalness: 0 } as const;

/**
 * Три материала под владением подсистемы (PERF-8). Стенки и юбка двусторонние:
 * камера обходит арену кругом, и обратная сторона обрыва обязана рисоваться.
 */
export function createTerrainMaterials(colors: TerrainMaterialColors): TerrainTilesetMaterials {
  return {
    floor: own(
      'material',
      'terrain',
      new THREE.MeshStandardMaterial({ color: colors.floor, ...SURFACE }),
    ),
    wall: own(
      'material',
      'terrain',
      new THREE.MeshStandardMaterial({ color: colors.wall, ...SURFACE, side: THREE.DoubleSide }),
    ),
    skirt: own(
      'material',
      'terrain',
      new THREE.MeshStandardMaterial({ color: colors.skirt, ...SURFACE, side: THREE.DoubleSide }),
    ),
  };
}
