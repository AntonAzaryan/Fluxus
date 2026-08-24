/**
 * Рельеф сцены глазами мозга — уровни клеток и наличие пола (`terrain` TERR-1,
 * TERR-3).
 *
 * Приезжает СБОРКОЙ, а не наблюдением, и это не обход границы честности BOT-3,
 * а её точное прочтение. Граница нормирует источник СОСТОЯНИЯ мира —
 * персональные снапшоты и факты слота; иммутабельная часть террейна состоянием
 * не является вовсе: она входит в `worldInit` и не снапшотится (TERR-6),
 * контент-пак клиент резолвит локально (`netcode` NET-16), и человек с тем же
 * клиентом видит тот же рельеф нарисованным. Тот же довод и тот же путь, что у
 * центра арены (ARENA-1), который мозг уже получает сборкой: величина живёт в
 * ассете сцены, а не в компоненте.
 *
 * Пол читается из АССЕТА, а не из компонента (TERR-6): живая карта пола
 * меняется снятием клеток по ходу матча, и следить за ней мозг мог бы только
 * через снапшот. Пока сцена демо пол не снимает, разницы нет; когда начнёт —
 * бот будет прыгать через дыру, которой уже нет, и не заметит появившуюся. Это
 * известное упрощение, а не недосмотр: цена ошибки — лишний прыжок.
 *
 * Fixed → float здесь же, на границе (BOT-5): внутрь мозга уезжают мировые
 * единицы обычными числами.
 */
import { cellAt, createTerrainGrid, fixed, type SceneDef, type TerrainGrid } from '@fluxus/core';

export interface BotTerrain {
  /** Размер клетки в мировых единицах (TERR-2): шаг, которым имеет смысл щупать рельеф. */
  readonly tileSize: number;
  /** Уровень клетки под точкой (TERR-1, TERR-4); вне сетки — ближайшая клетка. */
  levelAt(x: number, y: number): number;
  /** Есть ли пол в клетке под точкой (TERR-3). */
  hasFloorAt(x: number, y: number): boolean;
}

function view(grid: TerrainGrid): BotTerrain {
  const cell = (x: number, y: number): number =>
    cellAt(grid, { x: fixed.fromFloat(x), y: fixed.fromFloat(y) });
  return {
    tileSize: fixed.toFloat(grid.tileSize),
    levelAt: (x, y) => grid.levels[cell(x, y)] ?? 0,
    hasFloorAt: (x, y) => (grid.floor[cell(x, y)] ?? 0) !== 0,
  };
}

/**
 * Рельеф сцены для мозга; `undefined` — сцена без террейна (DI-3: такая сцена
 * тикает штатно, и обрывов в ней нет по построению).
 *
 * Разбор — тот же `createTerrainGrid`, которым сцену поднимает ядро: второй
 * реализации чтения ассета не заводится, иначе бот видел бы рельеф не тот, по
 * которому его двигает физика.
 */
export function botTerrain(scene: SceneDef): BotTerrain | undefined {
  if (scene.terrain === undefined) return undefined;
  return view(createTerrainGrid(scene.terrain));
}
