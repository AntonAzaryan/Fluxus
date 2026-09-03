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
  queryInto,
  world,
  type EntityId,
  type QuerySpec,
  type TerrainGrid,
  type TickResult,
  type WorldState,
} from '@fluxus/core';

/** Пустая дельта — общий неизменяемый список: пол не менялся (REND-26). */
const EMPTY_DELTA: readonly number[] = [];

/** Тег singleton-сущности террейна — конвенция `terrainPrefab` ядра. */
const TERRAIN_TAG = 'terrain';

/**
 * Носитель карты пола: тег террейна плюс сам компонент. Константа модуля —
 * объект спецификации на вызов был бы аллокацией пути извлечения (REND-26).
 */
const TERRAIN_SPEC: QuerySpec = { all: [FLOOR_COMPONENT], withTag: TERRAIN_TAG };

export class FloorMirror {
  /** Текущее зеркало: байт на клетку, row-major. Мутирует только `sync`. */
  readonly bits: Uint8Array;
  /**
   * Сколько клеток сравнил последний `sync` — вход счётчика стоимости стадии
   * экстракции (`performance-budget` PERF-2, PERF-3). Величиной, а не стоком:
   * сток читает шов потока тиков один раз на вызов (`extractor.ts`), а зеркало о
   * стоке не знает — и ранний выход «террейна в мире нет» честно даёт ноль
   * просмотренных клеток вместо полной карты.
   */
  lastScanned = 0;
  private readonly grid: TerrainGrid;
  /** Имена полей-слов компонента пола в порядке возрастания индекса слова. */
  private fields: readonly string[] | null = null;
  private entity: EntityId | null = null;
  /**
   * Буфер поиска носителя — на ОДНУ запись: носитель singleton'ный (TERR-6), и
   * первый совпавший он и есть. `listAlive` выделял здесь массив размером в мир
   * — редко (носитель кэшируется), но по той же дороге, которую REND-26 закрыл
   * для остального пути извлечения.
   */
  private readonly candidate = new Float64Array(1);

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
    this.lastScanned = 0;
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
      this.lastScanned += Math.max(0, top - base);
    }
    return changed;
  }

  /**
   * Пары «клетка, бит» изменившихся клеток для доставки (TERR-6 → REND-7), либо
   * пустой список. Карта перечитывается ТОЛЬКО когда дельта тика тронула
   * компонент пола либо мир разорвался (`force`: rewind мог откатить пол без
   * дельты, а первое извлечение не с чем сравнивать).
   *
   * Список пар выделяется лишь тогда, когда пол реально менялся, — это событие
   * сцены, а не тик, и REND-26 такую аллокацию разрешает явно. Просмотренные
   * клетки остаются в `lastScanned`: сток стоимости читается вызывающим один
   * раз на извлечение (PERF-3).
   */
  delta(state: WorldState, result: TickResult, force: boolean): readonly number[] {
    this.lastScanned = 0;
    const floorDirty = result.changes.changedEntities(FLOOR_COMPONENT).size > 0;
    if (!floorDirty && !force) return EMPTY_DELTA;
    const changed = this.sync(state);
    if (changed.length === 0) return EMPTY_DELTA;
    const pairs: number[] = [];
    for (const cell of changed) pairs.push(cell, this.bits[cell]!);
    return pairs;
  }

  private findEntity(state: WorldState): EntityId | null {
    if (this.entity !== null && world.isAlive(state, this.entity)) return this.entity;
    // Буфер короче отбора не ошибка (QUERY-3): записана ПЕРВАЯ совпавшая, а
    // носителей карты пола в мире один. Ноль совпавших — сцены без террейна.
    const found = queryInto(state, TERRAIN_SPEC, this.candidate);
    this.entity = found === 0 ? null : this.candidate[0]!;
    return this.entity;
  }
}
