/**
 * Террейн (TERR-1..7): height field как входной ассет, запрос уровня и
 * производная cliff-геометрия.
 *
 * Собственных систем здесь нет намеренно (Purpose спеки): карта уровней —
 * иммутабельная часть `worldInit` (DET-1) и живёт рядом с систем-реестром, а
 * карта пола — обычный компонент на singleton-сущности (TERR-6), поэтому она
 * снапшотится и откатывается без нового механизма.
 */
import { INT32_MAX, distSqLe } from '../math/fixed.js';
import { getField, hasComponent, type PrefabDef } from '../ecs/world.js';
import {
  LEVEL_OVERRIDE_COMPONENT,
  POSITION_COMPONENT,
  type CliffEdge,
  type ComponentSchema,
  type EntityId,
  type Fixed,
  type SystemContext,
  type TerrainApi,
  type TerrainGrid,
  type Vec2,
  type WorldState,
} from '../types.js';

/** Индекс символа в алфавите и есть уровень клетки (TERR-3). */
const LEVEL_ALPHABET = '0123456789ABCDEF';

/**
 * Алфавит флагового слоя (TERR-3: вне `0-9A-F`). Один символ на клетку, а не
 * набор флагов: рампа без пола смысла не имеет, а карта читается глазами.
 */
const FLAG_ALPHABET = '.^_';
const FLAG_RAMP = 1;
const FLAG_NO_FLOOR = 2;

/** Компонент карты пола и prefab её носителя — порождаются из размеров сетки. */
export const FLOOR_COMPONENT = 'TerrainFloor';
export const TERRAIN_PREFAB = 'Terrain';

/** Ассет террейна: то, что пишет редактор (ED-10) и читает загрузчик сцены. */
export interface TerrainDef {
  readonly width: number;
  readonly height: number;
  /** Размер клетки в Q16.16 — поле ассета, а не константа ядра (TERR-2). */
  readonly tileSize: number;
  /** Одна строка на ряд, один символ `0-9A-F` на клетку (TERR-3). */
  readonly levels: readonly string[];
  /** Та же форма, алфавит `.` обычная / `^` рампа / `_` нет пола (TERR-3). */
  readonly flags: readonly string[];
}

/** Разбирает и валидирует ассет; cliff-геометрия выводится здесь же (TERR-5). */
export function createTerrainGrid(def: TerrainDef): TerrainGrid {
  const { width, height, tileSize } = def;
  if (!Number.isInteger(width) || width < 1) throw new Error('TERR-2: "width" — целое ≥ 1');
  if (!Number.isInteger(height) || height < 1) throw new Error('TERR-2: "height" — целое ≥ 1');
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new Error('TERR-2: "tileSize" — целое ≥ 1 в Q16.16 (FP-1)');
  }
  // Арена целиком обязана помещаться в Q16.16: иначе мировые координаты
  // дальней клетки не выразимы, а обнаружится это в первом же расчёте.
  if (width * tileSize > INT32_MAX || height * tileSize > INT32_MAX) {
    throw new Error(`TERR-2: сетка ${width}×${height} по ${tileSize} не помещается в i32 (FP-1)`);
  }

  const levels = readMap(def.levels, width, height, 'levels', LEVEL_ALPHABET);
  const flags = readMap(def.flags, width, height, 'flags', FLAG_ALPHABET);

  const ramps = new Uint8Array(levels.length);
  const floor = new Uint8Array(levels.length);
  for (let i = 0; i < flags.length; i++) {
    ramps[i] = flags[i] === FLAG_RAMP ? 1 : 0;
    floor[i] = flags[i] === FLAG_NO_FLOOR ? 0 : 1;
  }

  const grid: TerrainGrid = { width, height, tileSize, levels, ramps, floor, cliffs: [] };
  validateRampWidth(grid);
  return { ...grid, cliffs: buildCliffs(grid) };
}

function readMap(
  rows: readonly string[],
  width: number,
  height: number,
  what: string,
  alphabet: string,
): Uint8Array {
  if (!Array.isArray(rows) || rows.length !== height) {
    throw new Error(`TERR-2: карта "${what}" — ${rows?.length ?? 0} рядов вместо ${height}`);
  }
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    if (row.length !== width) {
      throw new Error(`TERR-2: карта "${what}", ряд ${y} — ${row.length} клеток вместо ${width}`);
    }
    for (let x = 0; x < width; x++) {
      const value = alphabet.indexOf(row[x]!);
      if (value < 0) {
        throw new Error(
          `TERR-3: карта "${what}", клетка (${x}, ${y}): символ "${row[x]}" вне алфавита "${alphabet}"`,
        );
      }
      cells[y * width + x] = value;
    }
  }
  return cells;
}

/**
 * TERR-7: одиночная клетка-рампа запрещена — на ней агент клинит.
 *
 * ponytail: проверяется необходимое условие «есть соседняя рампа того же
 * уровня», а не полная ширина перехода: направление подъёма из карты не
 * выводится без разбора связных групп. Полная проверка — вместе с навигацией,
 * которая и задаёт диаметр агента (TERR-7).
 */
function validateRampWidth(grid: TerrainGrid): void {
  const { width, height, ramps, levels } = grid;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!ramps[i]) continue;
      const wide = neighbours(x, y, width, height).some(
        (j) => ramps[j] === 1 && levels[j] === levels[i],
      );
      if (!wide) {
        throw new Error(`TERR-7: рампа в клетке (${x}, ${y}) уже двух клеток — агенты застрянут`);
      }
    }
  }
}

function neighbours(x: number, y: number, width: number, height: number): number[] {
  const out: number[] = [];
  if (x > 0) out.push(y * width + x - 1);
  if (x + 1 < width) out.push(y * width + x + 1);
  if (y > 0) out.push((y - 1) * width + x);
  if (y + 1 < height) out.push((y + 1) * width + x);
  return out;
}

/**
 * TERR-5: переход проходим при равных уровнях либо при перепаде в единицу,
 * если хотя бы одна клетка — рампа. Остальные границы становятся отрезками
 * cliff-геометрии; теги (блокировка движения и обзора) у всех одинаковы, и
 * навешивает их физика при регистрации коллайдеров (этап 13).
 *
 * ponytail: соседние отрезки не сливаются в один — длинный обрыв даёт цепочку
 * отрезков по клетке. Слияние коллинеарных участков — когда broad-phase
 * упрётся в их количество.
 */
function buildCliffs(grid: TerrainGrid): CliffEdge[] {
  const { width, height, tileSize, levels, ramps } = grid;
  const edges: CliffEdge[] = [];
  const passable = (a: number, b: number): boolean => {
    const delta = Math.abs(levels[a]! - levels[b]!);
    if (delta === 0) return true;
    return delta === 1 && (ramps[a] === 1 || ramps[b] === 1);
  };

  // Порядок обхода — построчный, сосед справа перед соседом снизу (DET-6).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x + 1 < width && !passable(i, i + 1)) {
        const edgeX = (x + 1) * tileSize;
        edges.push({ from: { x: edgeX, y: y * tileSize }, to: { x: edgeX, y: (y + 1) * tileSize } });
      }
      if (y + 1 < height && !passable(i, i + width)) {
        const edgeY = (y + 1) * tileSize;
        edges.push({ from: { x: x * tileSize, y: edgeY }, to: { x: (x + 1) * tileSize, y: edgeY } });
      }
    }
  }
  return edges;
}

/** Индекс клетки под точкой. Начало сетки — мировой ноль; вне сетки берётся ближайшая клетка. */
export function cellAt(grid: TerrainGrid, position: Vec2): number {
  const x = clamp(Math.floor(position.x / grid.tileSize), grid.width - 1);
  const y = clamp(Math.floor(position.y / grid.tileSize), grid.height - 1);
  return y * grid.width + x;
}

function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

// ------------------------------------------------------- карта пола (TERR-6)

/** Слов по 32 клетки: карта пола — битовая маска, а полей у компонента только скалярные (ECS-3). */
function wordCount(grid: TerrainGrid): number {
  return Math.ceil((grid.width * grid.height) / 32);
}

/** Имена дополнены нулями до одной длины: иначе лексикографический порядок в plain-форме (SER-6) даёт w0, w10, w2. */
function wordName(index: number, total: number): string {
  return `w${String(index).padStart(String(total - 1).length, '0')}`;
}

/**
 * Схема компонента карты пола. Порождается из размеров сетки, а не пишется
 * руками: число слов — функция от арены, и рассинхрон схемы с ассетом означал
 * бы молча обрезанную карту.
 *
 * ponytail: SoA аллоцирует `capacity` int32 на каждое поле, то есть на каждые
 * 32 клетки. Для арены в тысячи клеток дешевле массивные поля в ECS — вводить
 * их до того, как размер арены известен, незачем.
 */
export function floorComponentSchema(grid: TerrainGrid): ComponentSchema {
  const total = wordCount(grid);
  const fields: Record<string, 'i32'> = {};
  for (let i = 0; i < total; i++) fields[wordName(i, total)] = 'i32';
  return { name: FLOOR_COMPONENT, fields };
}

/** Prefab singleton-сущности террейна: начальное состояние пола из флагов ассета. */
export function terrainPrefab(grid: TerrainGrid): PrefabDef {
  const total = wordCount(grid);
  const words = new Int32Array(total);
  for (let cell = 0; cell < grid.floor.length; cell++) {
    if (grid.floor[cell]) words[cell >>> 5]! |= 1 << (cell & 31);
  }
  const values: Record<string, number> = {};
  for (let i = 0; i < total; i++) values[wordName(i, total)] = words[i]!;
  return { name: TERRAIN_PREFAB, components: { [FLOOR_COMPONENT]: values }, tags: ['terrain'] };
}

/**
 * Снятие пола в области вокруг мировой позиции (TERR-8). Механизм ядра: всё,
 * что знает про слова и биты карты, живёт здесь — в языке систем ни битовой
 * арифметики, ни вычисляемых имён полей нет и быть не должно (EXPR-2).
 *
 * Область — круг по ЦЕНТРАМ клеток, тем же правилом, что фильтр `withinRadius`
 * Query API: `distSqLe` переиспользуется, а не повторяется, иначе «в радиусе»
 * разошлось бы между запросом и действием при первой же правке. Без радиуса
 * берётся клетка под точкой (`cellAt`, тотальный по TERR-4) — а не круг
 * нулевого радиуса: тот не накрыл бы центр клетки, не совпади точка с ним.
 */
export function carveFloor(ctx: SystemContext, at: Vec2, radius?: Fixed): void {
  const terrain = ctx.terrain;
  if (terrain === undefined) throw new Error('TERR-8: снятие пола в сцене без террейна');
  if (radius !== undefined && radius < 0) {
    throw new Error(`TERR-8: радиус снятия пола не может быть отрицательным, получено ${radius}`);
  }
  const { grid, floorEntity } = terrain;
  const total = wordCount(grid);

  /**
   * Слово карты → пара «как было, как стало». Исходное значение читается через
   * буфер (CMD-5): мир до flush снятий этого тика не видит, и второе снятие,
   * прочитав его напрямую, вернуло бы биты, погашенные первым.
   *
   * ponytail: карта живёт вызов, а не тик. Действие срабатывает по
   * геймплейному событию, поэтому в дисциплину аллокаций горячего пути пока не
   * попадает; переиспользуемый буфер — когда профиль покажет систему, зовущую
   * снятие на каждую сущность запроса.
   */
  const words = new Map<number, { readonly before: number; after: number }>();
  const clear = (cell: number): void => {
    const index = cell >>> 5;
    let word = words.get(index);
    if (word === undefined) {
      const field = wordName(index, total);
      const before =
        ctx.commands.peekField(floorEntity, FLOOR_COMPONENT, field) ??
        ctx.get(floorEntity, FLOOR_COMPONENT, field);
      word = { before, after: before };
      words.set(index, word);
    }
    word.after &= ~(1 << (cell & 31));
  };

  if (radius === undefined) {
    clear(cellAt(grid, at));
  } else {
    const { tileSize, width, height } = grid;
    // Центр клетки при нечётном `tileSize` в Q16.16 не представим — сдвиг
    // усекает вниз, и это часть нормы (TERR-8), а не округление на вкус.
    const half = tileSize >> 1;
    // Границы — заведомо надмножество с запасом в клетку: принадлежность решает
    // точный целочисленный тест ниже. Поэтому конвенция деления отрицательных
    // (floor у JS против усечения у Rust) на результат не влияет — надмножеством
    // границы остаются при любой из них, а парность даёт `distSqLe`.
    const lo = (v: number, max: number): number => clamp(Math.floor(v / tileSize) - 1, max);
    const hi = (v: number, max: number): number => clamp(Math.floor(v / tileSize) + 1, max);
    const xLo = lo(at.x - radius, width - 1);
    const xHi = hi(at.x + radius, width - 1);
    const yLo = lo(at.y - radius, height - 1);
    const yHi = hi(at.y + radius, height - 1);
    // Обход построчный — как нумерация клеток (TERR-6) и сборка обрывов (TERR-5).
    for (let y = yLo; y <= yHi; y++) {
      for (let x = xLo; x <= xHi; x++) {
        const dx = x * tileSize + half - at.x;
        const dy = y * tileSize + half - at.y;
        if (distSqLe(dx, dy, radius)) clear(y * width + x);
      }
    }
  }

  // Команда — одна на слово и только на изменившееся: карта пола участвует в
  // dirty-дельте (TERR-6), и запись прежнего значения объявила бы изменение,
  // которого не было. Порядок — по возрастанию индекса слова (TERR-8).
  for (const index of [...words.keys()].sort((a, b) => a - b)) {
    const word = words.get(index)!;
    if (word.after === word.before) continue;
    ctx.commands.setField(floorEntity, FLOOR_COMPONENT, wordName(index, total), word.after);
  }
}

// ------------------------------------------------------------------- запросы

/**
 * Запрос уровня и пола (TERR-4). Замыкается на мир и на сущность-носителя
 * карты пола: сетка иммутабельна, а пол читается из компонента и потому
 * следует за снапшотами и откатами.
 */
export function createTerrainApi(
  world: WorldState,
  grid: TerrainGrid,
  floorEntity: EntityId,
): TerrainApi {
  const levelAt = (position: Vec2): number => grid.levels[cellAt(grid, position)]!;
  const total = wordCount(grid);
  return {
    grid,
    floorEntity,
    levelAt,
    /** ARENA-6: явный override приоритетнее производного значения. */
    levelOf: (entity) =>
      hasComponent(world, entity, LEVEL_OVERRIDE_COMPONENT)
        ? getField(world, entity, LEVEL_OVERRIDE_COMPONENT, 'level')
        : levelAt({
            x: getField(world, entity, POSITION_COMPONENT, 'x'),
            y: getField(world, entity, POSITION_COMPONENT, 'y'),
          }),
    hasFloorAt: (position) => {
      const cell = cellAt(grid, position);
      const word = getField(world, floorEntity, FLOOR_COMPONENT, wordName(cell >>> 5, total));
      return (word & (1 << (cell & 31))) !== 0;
    },
  };
}
