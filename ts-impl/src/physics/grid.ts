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
   * Получить все пары-кандидаты для проверки.
   *
   * Для каждой занятой ячейки берём её сущности ВМЕСТЕ с сущностями из 8
   * соседних ячеек (окрестность 3×3) и образуем пары. Раньше пары строились
   * только внутри одной ячейки, из-за чего тела по разные стороны границы
   * ячейки (напр. игрок и стена) никогда не сталкивались. Broad-phase лишь
   * над-аппроксимирует — ложные пары отбросит narrow-phase.
   */
  getPairs(): Array<[bigint, bigint]> {
    const pairs: Array<[bigint, bigint]> = [];
    const seen = new Set<string>();

    // Детерминированный порядок обхода ячеек
    const cellKeys = [...this.cells.keys()].sort();

    for (const key of cellKeys) {
      const [cxStr, cyStr] = key.split(',');
      const cx = Number(cxStr);
      const cy = Number(cyStr);

      // Собрать кандидатов из ячейки и соседних 3×3
      const candidates: bigint[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbor = this.cells.get(makeKey(cx + dx, cy + dy));
          if (neighbor) candidates.push(...neighbor);
        }
      }

      // Сортируем для детерминизма
      candidates.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const a = candidates[i];
          const b = candidates[j];
          if (a === b) continue;
          const lo = a < b ? a : b;
          const hi = a < b ? b : a;
          const pairKey = `${lo},${hi}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          pairs.push([lo, hi]);
        }
      }
    }

    // Порядок ячеек в Map не гарантирует порядок (min_id, max_id) между парами
    // из разных ячеек — сортируем итоговый список явно (contract §8).
    pairs.sort((x, y) => {
      if (x[0] < y[0]) return -1;
      if (x[0] > y[0]) return 1;
      if (x[1] < y[1]) return -1;
      if (x[1] > y[1]) return 1;
      return 0;
    });

    return pairs;
  }
}
