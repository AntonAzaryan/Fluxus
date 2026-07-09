/**
 * Uniform Grid Broad-Phase
 * 
 * Разбиение пространства на ячейки для быстрого поиска пар коллизий.
 * Ключ по XY-ячейке.
 */

import { Fixed } from '../fixed/fixed';

/**
 * Ключ ячейки (строка "x,y")
 */
interface CellKey {
  x: number;
  y: number;
}

function makeKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Uniform Grid для broad-phase
 */
export class UniformGrid {
  private cellSize: Fixed;
  private cells: Map<string, bigint[]> = new Map();

  constructor(cellSize: Fixed) {
    this.cellSize = cellSize;
  }

  /**
   * Получить координаты ячейки для позиции
   */
  getCell(x: Fixed, y: Fixed): CellKey {
    const cellX = Number(x / this.cellSize);
    const cellY = Number(y / this.cellSize);
    return { x: cellX, y: cellY };
  }

  /**
   * Добавить сущность в сетку
   */
  add(entityId: bigint, x: Fixed, y: Fixed): void {
    const cell = this.getCell(x, y);
    const key = makeKey(cell.x, cell.y);
    
    const entities = this.cells.get(key) || [];
    entities.push(entityId);
    this.cells.set(key, entities);
  }

  /**
   * Получить сущности из ячейки и соседних (для проверки коллизий)
   */
  getNearby(x: Fixed, y: Fixed): bigint[] {
    const cell = this.getCell(x, y);
    const nearby: bigint[] = [];

    // Проверяем текущую и все соседние ячейки (3x3)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = makeKey(cell.x + dx, cell.y + dy);
        const entities = this.cells.get(key);
        if (entities) {
          nearby.push(...entities);
        }
      }
    }

    return nearby;
  }

  /**
   * Очистить сетку
   */
  clear(): void {
    this.cells.clear();
  }

  /**
   * Получить все пары для проверки (из одних ячеек)
   */
  getPairs(): Array<[bigint, bigint]> {
    const pairs: Array<[bigint, bigint]> = [];
    const seen = new Set<string>();

    for (const entities of this.cells.values()) {
      // Сортируем для детерминизма
      entities.sort((a, b) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      });

      // Все пары внутри ячейки
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const a = entities[i];
          const b = entities[j];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          
          if (!seen.has(key)) {
            seen.add(key);
            if (a < b) {
              pairs.push([a, b]);
            } else {
              pairs.push([b, a]);
            }
          }
        }
      }
    }

    return pairs;
  }
}
