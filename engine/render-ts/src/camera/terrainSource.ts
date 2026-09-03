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
import { levelFieldSampler, type HeightSampler } from '../visualSurface.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { CameraBounds, CameraSources } from './rig.js';

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
 * Поверхность и границы камеры из сетки террейна (CAM-2, CAM-3). Высота — та
 * же ВИЗУАЛЬНАЯ ПОВЕРХНОСТЬ (REND-9), по которой построена геометрия террейна
 * и посажены инстансы: источник приходит опцией, как подсистемам террейна и
 * воды. Точки за сеткой прижимаются к крайним клеткам.
 *
 * Источника нет — полем служит уровень клетки (REND-7), той же единственной
 * выборкой `levelFieldSampler`, какой берёт поле вода в сборке без порта
 * поверхности (REND-35): второй копии формулы «высота по уровням» здесь не
 * заводится. Разница между ветвями видна там, где поле от уровней отличается:
 * лощина кривизны и walkable-настил декорации — по уровням камера их не
 * замечает и держит цель на плоской ступени.
 *
 * Сетка живёт ссылкой, а не снимается при вызове: документная доставка
 * декларативна и приезжает НОВЫМ объектом (REND-14), и снимок молча отвечал бы
 * по прежней арене (CAM-7). Переподать источник конвейеру всё равно нужно —
 * `setGrid` меняет ответы источника, а не состояние камеры.
 */
export function terrainGroundApi(
  grid: TerrainGrid,
  heightStep: number,
  surface?: VisualSurfaceSource,
): TerrainCameraSource {
  let levels: HeightSampler = levelFieldSampler(grid, heightStep);
  let bounds: CameraBounds = gridBounds(grid, grid.tileSize / FIXED_ONE);
  return {
    // Замыкание, а не метод: потребитель отрывает его от объекта и передаёт полем.
    groundHeightAt: (x: number, y: number): number => {
      // Поверхность спрашивается КАЖДЫЙ раз, а не запоминается при сборке: до
      // `init` источника её ещё нет, и она появляется под уже отданным набором
      // (REND-9), а сетку под собой она переживает.
      const field = surface?.current;
      return field == null ? levels(x, y) : field.heightAt(x, y);
    },
    get bounds(): CameraBounds {
      return bounds;
    },
    setGrid(next: TerrainGrid): void {
      levels = levelFieldSampler(next, heightStep);
      bounds = gridBounds(next, next.tileSize / FIXED_ONE);
    },
  };
}

const gridBounds = (grid: TerrainGrid, tile: number): CameraBounds => ({
  minX: 0,
  minY: 0,
  maxX: grid.width * tile,
  maxY: grid.height * tile,
});
