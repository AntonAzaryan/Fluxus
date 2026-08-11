/**
 * Перечень ЗАКОММИЧЕННЫХ бинарных фикстур экспорта и то, из чего каждая
 * собирается (задача 10.1, BLND-7, `game-content` CONT-4).
 *
 * ## Почему они вообще есть
 *
 * Тесты конвейера идут от закоммиченных фикстур и Blender не зовут (BLND-7).
 * Рукописные `.gltf` рядом закрывают формат — их читают глазами в ревью, — но не
 * закрывают КОНТЕЙНЕР: `.glb` кладёт рядом со сценой аддон (BLND-8), его читает
 * правило синхронизации (BLND-2), и разбор заголовка, выравнивания чанков и
 * бинарного буфера до сих пор проверялся только на контейнерах, собранных в
 * памяти внутри самого теста. Такая проверка не отличает «разбор верен» от
 * «сборка и разбор ошибаются согласованно», и первый же экспорт настоящего
 * Blender попал бы в ту разницу.
 *
 * ## Почему они генерируются, а не написаны
 *
 * Бинарный файл в ревью нечитаем: base64 бинарного чанка не говорит ни о чём, и
 * фикстура-блоб доказывала бы меньше, чем строка `'0011'` рядом с ожиданием.
 * Поэтому источник у них ЧИТАЕМЫЙ и лежит здесь: рукописные `.gltf` и карты
 * рядами алфавитов TERR-3/ASSET-7 (`support.ts`). Ревьюят этот файл, а `.glb`
 * рядом — его вывод, и совпадение вывода с деревом проверяет тест
 * (`fixtures.test.ts`), а не дисциплина автора.
 *
 * Пере-собрать: `node tools/blender-ts/test/fixtures/build.mjs`.
 *
 * ## Почему перечень здесь, а не в самом скрипте
 *
 * Потребителей у него два — скрипт, который пишет файлы, и тест, который
 * сверяет написанное, — и перечень, скопированный в тест, разошёлся бы со
 * скриптом молча: тест сверял бы фикстуру со своей копией её же определения.
 */
import {
  CURVATURE_GRID,
  TERRAIN_FLAGS,
  TERRAIN_GRID,
  TERRAIN_LEVELS,
  fixtureBytes,
  flagCells,
  gridGlb,
  gridSource,
  levelHeights,
  packGlb,
} from './support.js';

/** Закоммиченная фикстура: имя файла, зачем она и как её собрать. */
export interface GeneratedFixture {
  readonly name: string;
  /** Что именно эта фикстура закрывает — то же, что стоит в README рядом. */
  readonly why: string;
  build(): Uint8Array;
}

/** JSON рукописной фикстуры: контейнер собирается ИЗ НЕЁ, а не рядом с ней. */
function jsonOf(name: string): unknown {
  return JSON.parse(new TextDecoder().decode(fixtureBytes(name)));
}

/**
 * Узлы размещений полной фикстуры. Без мешей: сим-размещение экспортируется
 * empty'ем, а decoration геометрию несёт, но импорту она не нужна — из
 * трансформа берутся позиция, курс и масштаб (BLND-3). Имена задают порядок
 * записей (BLND-4), и заданы они так, чтобы порядок читался.
 */
const PLACEMENT_NODES: readonly Record<string, unknown>[] = [
  // Мировые (x, y) ← glTF (x, −z): клетка (1, 2) сетки 4×4.
  { name: 'a-hero', translation: [1, 0, -2], extras: { prefab: 'Hero', 'Player.slot': 1 } },
  { name: 'b-rock', translation: [3, 0, -1], extras: { prefab: 'Rock' } },
  {
    name: 'c-statue',
    translation: [2.5, 0, -0.5],
    scale: [1.5, 1.5, 1.5],
    extras: { visual: 'Statue' },
  },
];

/** Grid-объект террейна с одной клеткой между уровнями (BLND-9 — отказ, не округление). */
function fractionalTerrain(): Uint8Array {
  const heights = levelHeights(TERRAIN_LEVELS);
  heights[2]![1] = 1.4;
  return gridGlb([{ ...TERRAIN_GRID, heights }]);
}

/** Grid-объект террейна с рампой шириной в одну клетку (TERR-7 — тот же отказ, что у кисти ED-10). */
function narrowRampTerrain(): Uint8Array {
  const flags = ['....', '.^..', '....', '....'];
  return gridGlb([
    {
      ...TERRAIN_GRID,
      heights: levelHeights(['0000', '0000', '1111', '1111']),
      ramp: flagCells(flags, '^'),
      noFloor: flagCells(flags, '_'),
    },
  ]);
}

/** Полный источник: размещения, terrain-объект и curvature-объект одним файлом. */
function fullSource(): Uint8Array {
  const grids = gridSource([TERRAIN_GRID, CURVATURE_GRID]);
  const nodes = [...(grids.json.nodes as Record<string, unknown>[]), ...PLACEMENT_NODES];
  return packGlb(
    { ...grids.json, nodes, scenes: [{ nodes: nodes.map((_, index) => index) }] },
    grids.binary,
  );
}

export const GENERATED_FIXTURES: readonly GeneratedFixture[] = Object.freeze([
  {
    name: 'placements.glb',
    why: 'контейнер той же сцены размещений, что и рукописный placements.gltf: разбор заголовка и JSON-чанка на закоммиченных байтах',
    build: () => packGlb(jsonOf('placements.gltf')),
  },
  {
    name: 'errors.glb',
    why: 'контейнер ошибочных случаев (BLND-6): отказ обязан приходить одинаково из обеих форм',
    build: () => packGlb(jsonOf('errors.gltf')),
  },
  {
    name: 'terrain-grid.glb',
    why: `terrain-объект с картами ${TERRAIN_LEVELS.join('/')} и ${TERRAIN_FLAGS.join('/')} (BLND-9): клеточные данные приезжают бинарным чанком`,
    build: () => gridGlb([TERRAIN_GRID]),
  },
  {
    name: 'curvature-grid.glb',
    why: 'curvature-объект (BLND-10): узловые смещения в бинарном чанке, квантование к решётке 1/32 ASSET-7',
    build: () => gridGlb([CURVATURE_GRID]),
  },
  {
    name: 'full.glb',
    why: 'полный источник сцены: размещения, decoration, terrain- и curvature-объекты одним файлом — вход сквозной проверки (задача 10.2)',
    build: fullSource,
  },
  {
    name: 'terrain-fractional.glb',
    why: 'клетка между уровнями (BLND-9): импорт отказывает с адресом клетки, а не округляет',
    build: fractionalTerrain,
  },
  {
    name: 'terrain-narrow-ramp.glb',
    why: 'рампа шириной в одну клетку (TERR-7): отказ той же реализацией, что подсвечивает это у кисти ED-10',
    build: narrowRampTerrain,
  },
]);
