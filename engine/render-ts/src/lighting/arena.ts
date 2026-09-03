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
import type * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';

/**
 * Радиус арены, когда сетки террейна подсистеме не дали (превью ассета ED-20,
 * тесты): фрустумы теневых камер обтягивать нечего, и берётся величина порядка
 * демо-арены — тени тогда есть, но качество их подсистеме не обещано.
 */
const DEFAULT_ARENA_RADIUS = 32;

/**
 * Запас по высоте над верхним уровнем арены, мировые единицы: в коробку обязаны
 * помещаться не только ступени террейна, но и то, что на них стоит, — модели,
 * башни, декорации. Четыре единицы — высота типовой декорации арены (модель
 * юнита вдвое ниже); занижен он был бы виден срезанной тенью статуи, а завышен
 * стоит лишь чуть меньшей плотности текселей.
 */
const CASTER_HEIGHT_MARGIN = 4;

/**
 * Границы арены, по которым обтянуты теневые камеры. Это КОРОБКА, а не круг:
 * ортографический фрустум теневой камеры обтягивается по проекции её восьми
 * углов в пространство света (design D6), и диагональный радиус для этого
 * слишком груб — он описывает арену окружностью и тратит тексели на пустоту за
 * её углами. Радиус при этом остаётся: им меряется удаление источника и по нему
 * же берётся точка взгляда, когда камеры кадра подсистеме не дали (REND-33).
 */
export interface ArenaExtent {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  /** Размеры коробки арены в мировых единицах: сетка и запас по высоте. */
  readonly sizeX: number;
  readonly sizeY: number;
  /** Нижняя и верхняя грани коробки, мировые единицы (высота уровней + запас). */
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Границы арены из сетки террейна; нет сетки — умолчательный радиус и коробка
 * того же размера. `heightStep` — шаг высоты рендера (REND-7): в мировую высоту
 * уровни переводит он, и без него коробка знала бы только план арены.
 */
export function arenaExtent(grid: TerrainGrid | undefined, heightStep = 1): ArenaExtent {
  if (grid === undefined) {
    const side = DEFAULT_ARENA_RADIUS * Math.SQRT2;
    return {
      centerX: 0,
      centerY: 0,
      radius: DEFAULT_ARENA_RADIUS,
      sizeX: side,
      sizeY: side,
      minZ: 0,
      maxZ: CASTER_HEIGHT_MARGIN,
    };
  }
  const tile = grid.tileSize / FIXED_ONE;
  const width = grid.width * tile;
  const height = grid.height * tile;
  // Вырожденная сетка (нулевые размеры) не должна схлопывать фрустум в точку:
  // источник тогда стоял бы в центре арены и не светил бы вовсе.
  const radius = Math.max(Math.hypot(width, height) / 2, 1);
  return {
    centerX: width / 2,
    centerY: height / 2,
    radius,
    sizeX: Math.max(width, 1),
    sizeY: Math.max(height, 1),
    // Пол арены — нулевой уровень; ниже него уходит только юбка обрыва, теней
    // она не отбрасывает и в коробку не входит.
    minZ: 0,
    maxZ: topLevel(grid) * heightStep + CASTER_HEIGHT_MARGIN,
  };
}

/** Наибольший уровень сетки — верх ступеней террейна (TERR-3, REND-7). */
function topLevel(grid: TerrainGrid): number {
  let top = 0;
  for (const level of grid.levels) if (level > top) top = level;
  return top;
}

/**
 * Наводит направленный источник по направлению «откуда светит» — смещению его
 * позиции от цели (REND-29). Живёт здесь, а не в подсистеме, потому что наводка
 * — производная ГРАНИЦ АРЕНЫ и ничего больше, и одним путём наводятся все
 * направленные источники сцены: солнце, его динамический ярус (REND-30) и
 * контровой источник.
 *
 * Работа фиксированного размера и без аллокаций (REND-26): её делает и кадр
 * перехода цикла времени суток (REND-32).
 */
export function aimDirectional(
  light: THREE.DirectionalLight,
  extent: ArenaExtent,
  dx: number,
  dy: number,
  dz: number,
): void {
  const length = Math.hypot(dx, dy, dz);
  // Нулевое направление — вырожденная секция: источник тогда светит сверху,
  // а не исчезает; отвергать её — дело валидации формата (PRES-2).
  const unit = length > 0 ? 1 / length : 0;
  const distance = extent.radius * 2;
  light.position.set(
    extent.centerX + dx * unit * distance,
    extent.centerY + dy * unit * distance,
    length > 0 ? dz * unit * distance : distance,
  );
  light.target.position.set(extent.centerX, extent.centerY, 0);
  light.target.updateMatrixWorld();
}
