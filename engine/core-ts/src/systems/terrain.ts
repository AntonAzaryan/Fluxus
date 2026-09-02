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

// ------------------------------------------------- запись карт ассета (TERR-3)

/**
 * Обратный ход к разбору: символ карты по значению клетки. Ассет террейна
 * пишет редактор (ED-10), а правило текстового представления — ядра, и второй
 * его реализации у потребителя быть не должно (ED-1, CORE-3).
 *
 * Наружу уходит запись, а не сами алфавиты: таблицу потребитель обязан
 * индексировать правильно, а «уровень 16» на ней молча даёт `undefined` —
 * значение вне диапазона отвергает по TERR-3 сама запись, в точке записи.
 * Отказ — `null`, как у разбора символа карты кривизны (`assets` ASSET-7): не
 * бросок, потому что вызывающий строит собственное сообщение об ошибке своего
 * слоя, а `try/catch` вокруг записи одной клетки его бы только запутал.
 */
export function terrainLevelChar(level: number): string | null {
  return Number.isInteger(level) ? (LEVEL_ALPHABET[level] ?? null) : null;
}

/** Наибольший выразимый уровень (TERR-3) — длина алфавита, а не второе число. */
export const TERRAIN_LEVEL_MAX = LEVEL_ALPHABET.length - 1;

/**
 * Имена видов клетки — по одному на символ `FLAG_ALPHABET` и в его порядке:
 * список именует позиции алфавита, а не повторяет его. Один символ описывает
 * клетку целиком (TERR-3), поэтому это перечисление, а не набор флагов.
 */
export const TERRAIN_CELL_KINDS = ['plain', 'ramp', 'noFloor'] as const;
export type TerrainCellKind = (typeof TERRAIN_CELL_KINDS)[number];

/** Вид клетки → символ карты флагов; неизвестное имя — `null` (TERR-3). */
export function terrainFlagChar(kind: string): string | null {
  const index = (TERRAIN_CELL_KINDS as readonly string[]).indexOf(kind);
  return index < 0 ? null : FLAG_ALPHABET[index]!;
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
  validateRampSide(grid);
  return { ...grid, cliffs: buildCliffs(grid) };
}

/**
 * `rows` объявлен `unknown`, а не `readonly string[]`: карта приезжает из
 * ассета сцены, то есть из JSON, и объявленный тип был бы обещанием, которого
 * никто не давал. Проверки ниже — единственное, что превращает её в массив
 * строк, поэтому и ряд проверяется на строковость: ряд-число дальше по коду
 * дал бы `undefined` из `indexOf` и сообщение про алфавит вместо сообщения про
 * форму карты.
 */
function readMap(
  rows: unknown,
  width: number,
  height: number,
  what: string,
  alphabet: string,
): Uint8Array {
  if (!Array.isArray(rows) || rows.length !== height) {
    const got = Array.isArray(rows) ? rows.length : 0;
    throw new Error(`TERR-2: карта "${what}" — ${got} рядов вместо ${height}`);
  }
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row: unknown = rows[y];
    if (typeof row !== 'string') {
      throw new Error(`TERR-2: карта "${what}", ряд ${y} — не строка`);
    }
    if (row.length !== width) {
      throw new Error(`TERR-2: карта "${what}", ряд ${y} — ${row.length} клеток вместо ${width}`);
    }
    for (let x = 0; x < width; x++) {
      // Длина ряда уже сверена с шириной выше: символ по индексу есть.
      const symbol = row[x]!;
      const value = alphabet.indexOf(symbol);
      if (value < 0) {
        throw new Error(
          `TERR-3: карта "${what}", клетка (${x}, ${y}): символ "${symbol}" вне алфавита "${alphabet}"`,
        );
      }
      cells[y * width + x] = value;
    }
  }
  return cells;
}

/**
 * TERR-7: рампа уже двух клеток запрещена — на ней агент клинит. Ширина
 * меряется ПОПЕРЁК подъёма, и в этом вся проверка.
 *
 * Ось подъёма клетки-рампы — та, вдоль которой у неё есть сосед другого уровня:
 * по ней агент и переходит с уровня на уровень. Ширина перехода — соседняя
 * клетка-рампа ТОГО ЖЕ уровня по перпендикулярной оси; соседняя рампа другого
 * уровня шириной не является, она следующая ступень того же подъёма. Две рампы
 * одного уровня, стоящие друг за другом по направлению подъёма, — по-прежнему
 * дорожка в одну клетку, и здесь она отвергается.
 *
 * Осей подъёма может быть две: угловая рампа заводит на плато и вбок, и вперёд.
 * Достаточно ширины поперёк одной из них — по широкой стороне такая рампа
 * проходима, и требовать ширины по обеим значило бы отвергнуть штатную
 * геометрию (рампа в углу площадки). Осей может не быть ни одной: флаг рампы на
 * ровном месте перехода не образует, поперечной для него считается любая ось.
 */
function validateRampWidth(grid: TerrainGrid): void {
  const { width, height, ramps } = grid;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (ramps[y * width + x] !== 1) continue;
      const axes = rampAxes(grid, x, y);
      if (rampWideEnough(axes)) continue;
      const across = (axes & (RISE_X | RISE_Y)) === 0 ? '' : ' поперёк подъёма';
      throw new Error(
        `TERR-7: рампа в клетке (${x}, ${y}) уже двух клеток${across} — агенты застрянут`,
      );
    }
  }
}

/** Биты разбора соседей клетки-рампы по осям (TERR-7): подъём и ширина. */
const RISE_X = 1;
const RISE_Y = 2;
const WIDE_X = 4;
const WIDE_Y = 8;

/**
 * Четыре соседа клетки-рампы, разобранные по осям: сосед ДРУГОГО уровня даёт
 * подъём по своей оси, соседняя рампа ТОГО ЖЕ уровня — ширину по ней. Список
 * соседей теряет ровно то, на чём стоит правило, — ось, по которой сосед стоит.
 */
function rampAxes(grid: TerrainGrid, x: number, y: number): number {
  const level = grid.levels[y * grid.width + x]!;
  return (
    neighbourAxis(grid, level, x - 1, y, RISE_X, WIDE_X) |
    neighbourAxis(grid, level, x + 1, y, RISE_X, WIDE_X) |
    neighbourAxis(grid, level, x, y - 1, RISE_Y, WIDE_Y) |
    neighbourAxis(grid, level, x, y + 1, RISE_Y, WIDE_Y)
  );
}

/** Вклад одного соседа: за краем сетки соседа нет, и подъёма с шириной он не даёт. */
function neighbourAxis(
  grid: TerrainGrid,
  level: number,
  x: number,
  y: number,
  rise: number,
  wide: number,
): number {
  const { width, height, ramps, levels } = grid;
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  const j = y * width + x;
  if (levels[j] !== level) return rise;
  return ramps[j] === 1 ? wide : 0;
}

/** TERR-7: ширина считается поперёк подъёма; без подъёма годится любая ось. */
function rampWideEnough(axes: number): boolean {
  if ((axes & (RISE_X | RISE_Y)) === 0) return (axes & (WIDE_X | WIDE_Y)) !== 0;
  return (
    ((axes & RISE_X) !== 0 && (axes & WIDE_Y) !== 0) ||
    ((axes & RISE_Y) !== 0 && (axes & WIDE_X) !== 0)
  );
}

/**
 * TERR-5: флаг рампы принадлежит НИЖНЕЙ клетке перехода, который он открывает,
 * — клетка-рампа MUST NOT иметь соседа по стороне с уровнем на единицу ниже, не
 * помеченного рампой. Цепочка склона проходит проверку: нижняя клетка шага —
 * тоже рампа.
 *
 * Сторона флага — инвариант модели, а не стиль карты: от неё зависит уровень
 * сущности на рампе (TERR-4), а через него — видимость (`fog-of-war` FOW-5).
 * С флагом на верхней стороне сущность на подъёме несёт уже верхний уровень:
 * снизу она не видна, а плато открывается ей с подошвы.
 */
function validateRampSide(grid: TerrainGrid): void {
  const { width, height, ramps, levels } = grid;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!ramps[i]) continue;
      const level = levels[i]!;
      for (const j of neighbours(x, y, width, height)) {
        const below = levels[j]!;
        if (ramps[j] === 1 || below !== level - 1) continue;
        // Координаты соседа — обратный ход к его индексу.
        //
        // DET-2, условие 5: делимое `j - nx` кратно ширине, поэтому частное
        // целое и от конвенции округления не зависит. Ограничено оно, как и в
        // `wordCount`, не проверкой, а аллокацией: `j` — индекс в `levels` и
        // `ramps`, то есть меньше площади сетки, а карты уровней и флагов уже
        // лежат в `Uint8Array` этой длины — площадь помещается в память
        // процесса и до 2^53 не дотягивается. Отрицательным делимое не бывает
        // (индекс неотрицателен, `nx` — остаток от него): условие 4
        // неприменимо.
        const nx = j % width;
        const ny = (j - nx) / width;
        throw new Error(
          `TERR-5: рампа в клетке (${x}, ${y}) уровня ${level} стоит на верхней стороне перехода: ` +
            `сосед (${nx}, ${ny}) уровня ${below} ниже на единицу и рампой не помечен — ` +
            `флаг рампы принадлежит нижней клетке пары`,
        );
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
 * TERR-5: переход между клетками с общей стороной проходим при равных уровнях
 * либо при перепаде в единицу, если хотя бы одна клетка — рампа.
 *
 * Функция модуля, а не замыкание внутри cliff-геометрии: тот же предикат — и
 * единственное правило проходимости границы у поиска пути (`pathfinding`
 * NAV-7), который берёт его отсюда. Две копии правила означали бы, что «пройти
 * можно» значит разное у обрыва и у маршрута — ровно тот класс расхождения,
 * который CORE-3 объявляет дефектом.
 */
export function terrainStepPassable(
  levels: Uint8Array,
  ramps: Uint8Array,
  a: number,
  b: number,
): boolean {
  const delta = Math.abs(levels[a]! - levels[b]!);
  if (delta === 0) return true;
  return delta === 1 && (ramps[a] === 1 || ramps[b] === 1);
}

/**
 * TERR-5: границы, непроходимые по `terrainStepPassable`, становятся отрезками
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

  // Порядок обхода — построчный, сосед справа перед соседом снизу (DET-6).
  // Уровни сторон пишутся в отрезок здесь же (TERR-5): `levelNeg` — клетка с
  // меньшей координатой по нормали ребра, `levelPos` — с большей (PHYS-11).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x + 1 < width && !terrainStepPassable(levels, ramps, i, i + 1)) {
        const edgeX = (x + 1) * tileSize;
        edges.push({
          from: { x: edgeX, y: y * tileSize },
          to: { x: edgeX, y: (y + 1) * tileSize },
          levelNeg: levels[i]!,
          levelPos: levels[i + 1]!,
        });
      }
      if (y + 1 < height && !terrainStepPassable(levels, ramps, i, i + width)) {
        const edgeY = (y + 1) * tileSize;
        edges.push({
          from: { x: x * tileSize, y: edgeY },
          to: { x: (x + 1) * tileSize, y: edgeY },
          levelNeg: levels[i]!,
          levelPos: levels[i + width]!,
        });
      }
    }
  }
  return edges;
}

/**
 * Индекс клетки под точкой. Начало сетки — мировой ноль; вне сетки берётся
 * ближайшая клетка.
 *
 * DET-2, условия 3 и 5: делимое — мировая координата в Q16.16, то есть `i32`,
 * по модулю меньше 2^31; делитель `tileSize` — целое ≥ 1 (TERR-2). Промежуток
 * из 2^53 не выходит, и приведённое частное точно.
 *
 * Условие 4: делимое БЫВАЕТ отрицательным — координата слева от начала сетки, —
 * и `floor` хост-языка расходится там с усечением к нулю второй реализации
 * ядра. Расхождение ненаблюдаемо, и держит это не порядок строк, а `clamp`
 * ниже: любое отрицательное частное он зажимает в `0`, а обе конвенции на
 * отрицательном частном дают отрицательное же значение (`floor` — меньшее,
 * усечение — `0` либо `-0`). Клетка поэтому одна и та же при любой конвенции;
 * закреплено тестом на отрицательной мировой координате в `terrain.test.ts`.
 */
export function cellAt(grid: TerrainGrid, position: Vec2): number {
  const x = clamp(Math.floor(position.x / grid.tileSize), grid.width - 1);
  const y = clamp(Math.floor(position.y / grid.tileSize), grid.height - 1);
  return y * grid.width + x;
}

function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

// ------------------------------------------------------- карта пола (TERR-6)

/**
 * Слов по 32 клетки: карта пола — битовая маска, а полей у компонента только
 * скалярные (ECS-3).
 *
 * DET-2, условие 5: делимое — `width * height`, площадь сетки. Оба множителя
 * положительные целые (TERR-2), и произведение ограничено не проверкой, а
 * аллокацией: карты уровней и флагов уже лежат в `Uint8Array` этой длины, то
 * есть площадь помещается в память процесса и до 2^53 не дотягивается.
 * Отрицательным делимое не бывает — условие 4 неприменимо.
 */
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

  if (radius === undefined) clear(cellAt(grid, at));
  else carveCircle(grid, at, radius, clear);

  // Команда — одна на слово и только на изменившееся: карта пола участвует в
  // dirty-дельте (TERR-6), и запись прежнего значения объявила бы изменение,
  // которого не было. Порядок — по возрастанию индекса слова (TERR-8).
  for (const [index, word] of [...words].sort((a, b) => a[0] - b[0])) {
    if (word.after === word.before) continue;
    ctx.commands.setField(floorEntity, FLOOR_COMPONENT, wordName(index, total), word.after);
  }
}

// ------------------------------------------------------------------- запросы

/**
 * Клетки круга снятия (TERR-8): круг по ЦЕНТРАМ клеток, тем же правилом, что
 * фильтр `withinRadius` Query API.
 *
 * Границы — заведомо надмножество с запасом в клетку: принадлежность решает
 * точный целочисленный тест внутри. Поэтому конвенция деления отрицательных
 * (floor у JS против усечения у Rust) на результат не влияет — надмножеством
 * границы остаются при любой из них, а парность даёт `distSqLe`.
 *
 * DET-2, условия 3 и 5: делимое — `at.x ± radius`, сумма двух `i32`, считанная
 * обычной арифметикой, то есть по модулю меньше 2^32; делитель `tileSize` —
 * целое ≥ 1 (TERR-2). Промежуток из 2^53 не выходит, частное приводится к
 * целому. Условие 4 снято доводом выше: приведённое частное проходит дальше
 * через `clamp` и точный тест `distSqLe`, стирающие разницу конвенций (тот же
 * довод — у `hasFloorWithin`).
 */
function carveCircle(grid: TerrainGrid, at: Vec2, radius: Fixed, clear: (cell: number) => void): void {
  const { tileSize, width, height } = grid;
  // Центр клетки при нечётном `tileSize` в Q16.16 не представим — сдвиг
  // усекает вниз, и это часть нормы (TERR-8), а не округление на вкус.
  const half = tileSize >> 1;
  const xLo = cellLo(at.x - radius, tileSize, width - 1);
  const xHi = cellHi(at.x + radius, tileSize, width - 1);
  const yLo = cellLo(at.y - radius, tileSize, height - 1);
  const yHi = cellHi(at.y + radius, tileSize, height - 1);
  // Обход построчный — как нумерация клеток (TERR-6) и сборка обрывов (TERR-5).
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const dx = x * tileSize + half - at.x;
      const dy = y * tileSize + half - at.y;
      if (distSqLe(dx, dy, radius)) clear(y * width + x);
    }
  }
}

/**
 * Нижняя граница обхода в клетках, с запасом в клетку.
 *
 * DET-2, условие 4 — площадка с отрицательным делимым: координата края круга
 * левее нуля даёт отрицательное частное, и `floor` расходится с усечением к
 * нулю на единицу. Конвенция здесь — `floor`; разницу стирает `clamp`: при
 * `value < 0` частное под обеими конвенциями не больше нуля, минус клетка
 * запаса — не больше −1, и обе границы зажимаются в 0. Граница промежутка и
 * условия 3, 5 — в доводе у `carveCircle`.
 */
function cellLo(value: Fixed, tileSize: number, max: number): number {
  return clamp(Math.floor(value / tileSize) - 1, max);
}

/**
 * Верхняя граница обхода в клетках, с запасом в клетку.
 *
 * DET-2, условие 4: конвенция — `floor`. При отрицательном `value` усечение к
 * нулю дало бы границу на клетку правее (0 против 1 при `value` в
 * `(−tileSize, 0)`), но лишняя клетка — только запас окна: её центр лежит
 * правее правого края круга, и точный тест `distSqLe` в `carveCircle` её
 * отсеивает. Надмножество остаётся надмножеством при любой конвенции.
 */
function cellHi(value: Fixed, tileSize: number, max: number): number {
  return clamp(Math.floor(value / tileSize) + 1, max);
}

/**
 * Ближайшая к точке координата прямоугольника клетки по одной оси (ARENA-5).
 * Функция модуля, а не замыкание-помощник: опорную проверку зовут на каждом
 * тике для каждой сущности с ненулевой опорой, и замыкание на вызов было бы
 * аллокацией, пропорциональной сцене.
 */
function nearestOnCell(value: Fixed, min: Fixed, size: Fixed): Fixed {
  if (value < min) return min;
  const max = min + size;
  return value > max ? max : value;
}

/**
 * Пересекает ли круг хотя бы одну клетку с полом (ARENA-5). Обход построчный
 * (TERR-6); на результат порядок не влияет — это проверка существования, и
 * ранний выход детерминизма не трогает.
 *
 * Границы — надмножество с запасом в клетку, как в `carveCircle`:
 * принадлежность решает точный тест внутри, поэтому конвенция деления
 * отрицательных (floor у JS против усечения у Rust) роли не играет.
 *
 * DET-2, условия 3 и 5: четыре деления с делимым `position.x|y ± radius` —
 * сумма двух `i32` обычной арифметикой, по модулю меньше 2^32, делитель
 * `tileSize` целый ≥ 1 (TERR-2). Делимое бывает отрицательным, и условие 4
 * снято тем же доводом, что в `carveCircle`: частное уходит в `clamp`, а
 * принадлежность решает точный `distSqLe` — надмножеством границы остаются
 * при любой конвенции.
 */
function floorWithin(
  grid: TerrainGrid,
  floorBit: (cell: number) => boolean,
  position: Vec2,
  radius: Fixed,
): boolean {
  const { tileSize, width, height } = grid;
  const xLo = cellLo(position.x - radius, tileSize, width - 1);
  const xHi = cellHi(position.x + radius, tileSize, width - 1);
  const yLo = cellLo(position.y - radius, tileSize, height - 1);
  const yHi = cellHi(position.y + radius, tileSize, height - 1);
  let sawCell = false;
  for (let y = yLo; y <= yHi; y++) {
    for (let x = xLo; x <= xHi; x++) {
      const nx = nearestOnCell(position.x, x * tileSize, tileSize);
      const ny = nearestOnCell(position.y, y * tileSize, tileSize);
      if (!distSqLe(nx - position.x, ny - position.y, radius)) continue;
      sawCell = true;
      if (floorBit(y * width + x)) return true;
    }
  }
  // Круг не задел ни одной клетки — сущность далеко за краем сетки.
  // Отвечает ближайшая клетка (тотальность TERR-4): тик не падает.
  return sawCell ? false : floorBit(cellAt(grid, position));
}

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
  const floorBit = (cell: number): boolean => {
    const word = getField(world, floorEntity, FLOOR_COMPONENT, wordName(cell >>> 5, total));
    return (word & (1 << (cell & 31))) !== 0;
  };
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
    hasFloorAt: (position) => floorBit(cellAt(grid, position)),
    /**
     * Опорная проверка (ARENA-5): пересекает ли круг хотя бы одну клетку с
     * полом. Правило намеренно НЕ правило области снятия (TERR-8, круг по
     * центрам клеток): для опоры оно давало бы «нет опоры» у маленькой
     * сущности посреди клетки, чей центр вне её малого круга. Здесь —
     * ближайшая точка прямоугольника клетки, включающее сравнение квадратов.
     */
    hasFloorWithin: (position, radius) =>
      radius <= 0 ? floorBit(cellAt(grid, position)) : floorWithin(grid, floorBit, position, radius),
  };
}
