/**
 * Зеркало карты пола (TERR-6) на стороне рендера.
 *
 * Живое состояние пола лежит в компоненте `TerrainFloor` singleton-сущности
 * террейна битовыми словами `w0..wN`. Рендер обязан скопировать нужное в
 * `onTick` (OBS-3), поэтому здесь держится собственный побайтовый слепок
 * (1 = пол есть) и диффом вычисляются изменившиеся клетки — вход для
 * пересборки геометрии террейна (REND-7).
 */
import {
  FLOOR_COMPONENT,
  world,
  type EntityId,
  type TerrainGrid,
  type WorldState,
} from '@fluxus/core';

/** Тег singleton-сущности террейна — конвенция `terrainPrefab` ядра. */
const TERRAIN_TAG = 'terrain';

export class FloorMirror {
  /** Текущее зеркало: байт на клетку, row-major. Мутирует только `sync`. */
  readonly bits: Uint8Array;
  private readonly grid: TerrainGrid;
  /** Имена полей-слов компонента пола в порядке возрастания индекса слова. */
  private fields: readonly string[] | null = null;
  private entity: EntityId | null = null;

  constructor(grid: TerrainGrid) {
    this.grid = grid;
    // Начальное состояние — из ассета: до первого тика мир совпадает с ним.
    this.bits = new Uint8Array(grid.floor);
  }

  /**
   * Перечитывает карту пола из мира и возвращает индексы изменившихся клеток.
   * Вызывать в `onTick` и только когда дельта тика тронула компонент пола
   * (либо при разрыве непрерывности — rewind мог откатить пол без дельты).
   */
  sync(state: WorldState): number[] {
    const entity = this.findEntity(state);
    if (entity === null) return [];
    if (this.fields === null) {
      const schema = world.componentSchema(state, FLOOR_COMPONENT);
      if (schema === undefined) return [];
      // Имена слов дополнены нулями до одной длины (см. terrain.ts ядра),
      // поэтому лексикографическая сортировка и есть порядок слов.
      this.fields = Object.keys(schema.fields).sort();
    }

    const changed: number[] = [];
    const cells = this.grid.width * this.grid.height;
    for (let word = 0; word < this.fields.length; word++) {
      const value = world.getField(state, entity, FLOOR_COMPONENT, this.fields[word]!);
      const base = word * 32;
      const top = Math.min(base + 32, cells);
      for (let cell = base; cell < top; cell++) {
        const bit = (value >>> (cell - base)) & 1;
        if (this.bits[cell] !== bit) {
          this.bits[cell] = bit;
          changed.push(cell);
        }
      }
    }
    return changed;
  }

  private findEntity(state: WorldState): EntityId | null {
    if (this.entity !== null && world.isAlive(state, this.entity)) return this.entity;
    this.entity = null;
    const alive = world.listAlive(state);
    for (const candidate of alive) {
      if (
        world.hasTag(state, candidate, TERRAIN_TAG) &&
        world.hasComponent(state, candidate, FLOOR_COMPONENT)
      ) {
        this.entity = candidate;
        break;
      }
    }
    return this.entity;
  }
}
