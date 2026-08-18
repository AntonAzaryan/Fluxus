/**
 * Отладочный источник визуальной поверхности (`terrain.surface`, RDBG-1) —
 * объявляет его подсистема террейна в точке своей регистрации (REND-27).
 *
 * Показывает то поле высот, по которому построена геометрия арены и посажены
 * инстансы (REND-9): контур клеток идёт ПО ПОВЕРХНОСТИ — по кривизне, рампам и
 * walkable-настилам, — а не по плоскости уровня. Разойдись эти два, и «инстанс
 * висит в воздухе» перестало бы быть видимым глазом.
 *
 * В дампе — размеры сетки, размер клетки, разбиение кривизны и агрегаты:
 * гистограмма уровней, число рамп, клеток без пола и накрытых настилом. Растра
 * высот в дампе нет (RDBG-7) — арена в тысячи клеток бесполезна обеим граням.
 */
import type { TerrainGrid } from '@game-mvp/core';
import type { VisualSurface } from '../visualSurface.js';
import { DebugRows, type DebugColor, type DebugDraw, type DebugProbe, type DebugSource } from './contract.js';

/** Цвет контура клеток и цвет рампы: рампа выделена — она и есть проходимость. */
const GRID_COLOR: DebugColor = 0x60a0c0;
const RAMP_COLOR: DebugColor = 0xffd479;
const WALKABLE_COLOR: DebugColor = 0x90ff90;
const HOLE_COLOR: DebugColor = 0xff6060;
/**
 * Потолок перечня клеток (RDBG-7). В перечень идут только ЗНАЧИМЫЕ клетки —
 * рампа, дыра в полу, кривизна или накрытие walkable-настилом: ровная клетка на
 * своём уровне не несёт информации ни человеку, ни модели, а арена целиком
 * превратила бы наложение в кашу, а дамп — в растр под другим именем.
 */
const CELL_CAP = 512;

/** Одна клетка перечня: адрес, уровень и признаки, по которым она нарисована. */
export interface DebugCellRow {
  cellX: number;
  cellY: number;
  level: number;
  ramp: boolean;
  floor: boolean;
  walkable: boolean;
  curved: boolean;
}

export interface DebugTerrainProbe extends DebugProbe {
  readonly widthCells: number;
  readonly heightCells: number;
  /** Размер клетки в мировых единицах (TERR-2). */
  readonly tileWorldUnits: number;
  /** Высота одного уровня террейна в мировых единицах (REND-7). */
  readonly heightStepWorldUnits: number;
  /** Подклеток на клетку с кривизной по каждой оси (REND-9, QUAL-1). */
  readonly curvatureTessellation: number;
  /** Клеток по уровням: индекс — уровень, значение — сколько клеток (TERR-1). */
  readonly cellsByLevel: readonly number[];
  readonly rampCells: number;
  readonly holeCells: number;
  readonly curvedCells: number;
  readonly walkableCells: number;
  /** Отрезков обрывов производной геометрии (TERR-5). */
  readonly cliffSegments: number;
}

/** Что источнику нужно от подсистемы террейна. */
export interface TerrainDebugAccess {
  grid(): TerrainGrid;
  /** Визуальная поверхность (REND-9); null — ещё не построена. */
  surface(): VisualSurface | null;
  /** Зеркало живой карты пола доставки (TERR-6); null — сцена без пола. */
  floorBits(): Uint8Array | null;
  tileWorldUnits(): number;
  heightStepWorldUnits(): number;
  curvatureTessellation(): number;
}

export function terrainSurfaceDebugSource(
  access: TerrainDebugAccess,
): DebugSource<DebugTerrainProbe> {
  const rows = new DebugRows<DebugCellRow>(CELL_CAP, () => ({
    cellX: 0,
    cellY: 0,
    level: 0,
    ramp: false,
    floor: true,
    walkable: false,
    curved: false,
  }));
  const probe = {
    widthCells: 0,
    heightCells: 0,
    tileWorldUnits: 0,
    heightStepWorldUnits: 0,
    curvatureTessellation: 0,
    cellsByLevel: [] as number[],
    rampCells: 0,
    holeCells: 0,
    curvedCells: 0,
    walkableCells: 0,
    cliffSegments: 0,
    cells: rows.list,
    noData: undefined as string | undefined,
  };

  return {
    id: 'terrain.surface',
    title: 'визуальная поверхность и проходимость',
    probe(): DebugTerrainProbe {
      const surface = access.surface();
      if (surface === null) {
        probe.noData = 'визуальная поверхность ещё не построена (REND-9)';
        return probe;
      }
      probe.noData = undefined;
      const grid = access.grid();
      const floorBits = access.floorBits();
      const levels: number[] = probe.cellsByLevel;
      levels.length = 0;
      let ramps = 0;
      let holes = 0;
      let curved = 0;
      let walkable = 0;
      rows.begin();
      for (let y = 0; y < grid.height; y += 1) {
        for (let x = 0; x < grid.width; x += 1) {
          const cell = y * grid.width + x;
          const level = grid.levels[cell] ?? 0;
          levels[level] = (levels[level] ?? 0) + 1;
          const ramp = grid.ramps[cell] === 1;
          const floor = (floorBits ?? grid.floor)[cell] === 1;
          const onSurface = surface.hasCellWalkable(x, y);
          const bent = surface.hasCellCurvature(x, y);
          if (ramp) ramps += 1;
          if (!floor) holes += 1;
          if (bent) curved += 1;
          if (onSurface) walkable += 1;
          // Ровная клетка на своём уровне в перечень не идёт: она полностью
          // описана агрегатами, а наложением была бы шумом.
          if (!ramp && floor && !onSurface && !bent) continue;
          const row = rows.next();
          if (row === null) continue;
          row.cellX = x;
          row.cellY = y;
          row.level = level;
          row.ramp = ramp;
          row.floor = floor;
          row.walkable = onSurface;
          row.curved = bent;
        }
      }
      rows.end();
      for (let i = 0; i < levels.length; i += 1) levels[i] ??= 0;
      probe.widthCells = grid.width;
      probe.heightCells = grid.height;
      probe.tileWorldUnits = access.tileWorldUnits();
      probe.heightStepWorldUnits = access.heightStepWorldUnits();
      probe.curvatureTessellation = access.curvatureTessellation();
      probe.rampCells = ramps;
      probe.holeCells = holes;
      probe.curvedCells = curved;
      probe.walkableCells = walkable;
      probe.cliffSegments = grid.cliffs.length;
      return probe;
    },
    draw(value: DebugTerrainProbe, out: DebugDraw): void {
      const tile = value.tileWorldUnits;
      const list = value.cells as { items: readonly DebugCellRow[] };
      for (const row of list.items) {
        const x0 = row.cellX * tile;
        const y0 = row.cellY * tile;
        const x1 = x0 + tile;
        const y1 = y0 + tile;
        const color = !row.floor
          ? HOLE_COLOR
          : row.walkable
            ? WALKABLE_COLOR
            : row.ramp
              ? RAMP_COLOR
              : GRID_COLOR;
        // Клетка кладётся НА визуальную поверхность (REND-9): высоту углов
        // берёт сам примитив выборкой того же поля, по которому построен пол.
        out.polygon([x0, y0, x1, y0, x1, y1, x0, y1], color);
      }
      // Кромка арены: по ней видно и размер сетки, и то, что перечень усечён
      // потолком, а не кончился вместе с ареной.
      const w = value.widthCells * tile;
      const h = value.heightCells * tile;
      out.polyline([0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0], GRID_COLOR, true);
    },
  };
}
