/**
 * Границы арены для подсистемы освещения (REND-29, design D6): по ним
 * обтягиваются ортографические фрустумы теневых камер и по ним же берётся точка
 * взгляда, когда камеры кадра подсистеме не дали (REND-33, отбор локальных
 * источников).
 *
 * Отдельным модулем, а не полем подсистемы: это чистая производная сетки
 * террейна, и точка входной границы (REND-1, TERR-2) — `tileSize` приезжает в
 * Q16.16, дальше только float.
 */
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';

/**
 * Радиус арены, когда сетки террейна подсистеме не дали (превью ассета ED-20,
 * тесты): фрустумы теневых камер обтягивать нечего, и берётся величина порядка
 * демо-арены — тени тогда есть, но качество их подсистеме не обещано.
 */
export const DEFAULT_ARENA_RADIUS = 32;

/** Границы арены, по которым обтянуты теневые камеры. */
export interface ArenaExtent {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}

/** Границы арены из сетки террейна; нет сетки — умолчательный радиус. */
export function arenaExtent(grid: TerrainGrid | undefined): ArenaExtent {
  if (grid === undefined) {
    return { centerX: 0, centerY: 0, radius: DEFAULT_ARENA_RADIUS };
  }
  const tile = grid.tileSize / FIXED_ONE;
  const width = grid.width * tile;
  const height = grid.height * tile;
  // Вырожденная сетка (нулевые размеры) не должна схлопывать фрустум в точку:
  // источник тогда стоял бы в центре арены и не светил бы вовсе.
  const radius = Math.max(Math.hypot(width, height) / 2, 1);
  return { centerX: width / 2, centerY: height / 2, radius };
}
