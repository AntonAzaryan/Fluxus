/**
 * Поверхность и границы камеры над сеткой террейна (CAM-2, CAM-3, CAM-7) —
 * набор, инжектируемый в конвейер.
 *
 * Отдельно от самой камеры, потому что это её ИСТОЧНИК: камера знает про
 * `CameraSources`, а не про террейн, и второй такой же источник (плоская арена,
 * сцена редактора без сетки) появляется, не трогая рига. Приём сетки — точка
 * входной границы (REND-1, TERR-2): границы и высоты ниже считаются во float,
 * fixed-point глубже не проникает.
 */
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import type { CameraBounds, CameraSources } from './rig.js';

/** Индекс клетки в пределах сетки: точка за ней прижимается к крайней клетке. */
const clampCell = (value: number, size: number): number => Math.min(Math.max(value, 0), size - 1);

/**
 * Источник поверхности и границ камеры над сеткой террейна — набор,
 * инжектируемый в конвейер (CAM-7), плюс вход смены сетки под ним.
 */
export interface TerrainCameraSource extends CameraSources {
  readonly groundHeightAt: (x: number, y: number) => number;
  readonly bounds: CameraBounds;
  /** Сетка, по которой отвечает источник: правка документа, RESIZE арены. */
  setGrid(grid: TerrainGrid): void;
}

/**
 * Поверхность и границы камеры из сетки террейна (CAM-2, CAM-3): уровень
 * клифа клетки под точкой × шаг высоты; точки за сеткой прижимаются к
 * крайним клеткам. Читает те же данные, что рендер террейна (REND-7).
 *
 * Сетка живёт ссылкой, а не снимается при вызове: документная доставка
 * декларативна и приезжает НОВЫМ объектом (REND-14), и снимок молча отвечал бы
 * по прежней арене (CAM-7). Переподать источник конвейеру всё равно нужно —
 * `setGrid` меняет ответы источника, а не состояние камеры.
 */
export function terrainGroundApi(grid: TerrainGrid, heightStep: number): TerrainCameraSource {
  let current = grid;
  let tile = grid.tileSize / FIXED_ONE;
  let bounds: CameraBounds = gridBounds(grid, tile);
  return {
    // Замыкание, а не метод: потребитель отрывает его от объекта и передаёт полем.
    groundHeightAt: (x: number, y: number): number => {
      const cx = clampCell(Math.floor(x / tile), current.width);
      const cy = clampCell(Math.floor(y / tile), current.height);
      return current.levels[cy * current.width + cx]! * heightStep;
    },
    get bounds(): CameraBounds {
      return bounds;
    },
    setGrid(next: TerrainGrid): void {
      current = next;
      tile = next.tileSize / FIXED_ONE;
      bounds = gridBounds(next, tile);
    },
  };
}

const gridBounds = (grid: TerrainGrid, tile: number): CameraBounds => ({
  minX: 0,
  minY: 0,
  maxX: grid.width * tile,
  maxY: grid.height * tile,
});
