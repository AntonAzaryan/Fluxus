/**
 * Визуальная поверхность террейна (REND-9): гладкость внутри уровня (C1 —
 * сходятся и высота, и наклон), точный перепад на cliff-границе (узел двигает
 * оба уровня одним значением), произвольная амплитуда без стенок, источник
 * поверхности с догрузкой карты и несовпадением сетки.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@fluxus/core';
import {
  validateCurvatureMap,
  type NormalizedModel,
  type TerrainCurvatureMap,
} from '@fluxus/assets';
import {
  VisualSurfaceSource,
  buildFloorGeometry,
  buildWallGeometry,
  cornerLevels,
  createVisualSurface,
  type RenderContext,
  type SurfaceNormal,
  type WalkablePlacement,
} from '../src/index.js';
import { makeAssets } from './fixtures.js';

const STEP = 0.5;

function curvatureOf(width: number, height: number, rows: number[][]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

/**
 * Модель настила: плоский квад на высоте 1 в канонических осях модели — тем же
 * видом, каким её отдаёт загрузчик (ASSET-5). Нужен только walkable-вклад.
 */
function deckModel(): NormalizedModel {
  const positions = new Float32Array([-0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, 1, -0.5, 0.5, 1]);
  return {
    bones: [],
    meshes: [
      {
        partId: 0,
        positions,
        normals: null,
        uvs: null,
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        skinIndices: new Uint16Array(4 * 4),
        skinWeights: new Float32Array(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat()),
        materialIndex: 0,
      },
    ],
    sequences: [],
    materials: [
      {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: null,
        metallicFactor: 0,
        roughnessFactor: 1,
        normalTexture: null,
        emissiveFactor: [0, 0, 0],
        emissiveTexture: null,
        emissiveStrength: 1,
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
      },
    ],
    textureSlots: [],
    height: 1,
  };
}

/** Карта из нулей с одним узлом (nx, ny) = value. */
function bumpAt(width: number, height: number, nx: number, ny: number, value: number) {
  const rows = Array.from({ length: height + 1 }, () => new Array<number>(width + 1).fill(0));
  rows[ny]![nx] = value;
  return curvatureOf(width, height, rows);
}

/** Карта, где столбец узлов nx равен value, остальное — нули. */
function columnAt(width: number, height: number, nx: number, value: number) {
  const rows = Array.from({ length: height + 1 }, () => new Array<number>(width + 1).fill(0));
  for (const row of rows) row[nx] = value;
  return curvatureOf(width, height, rows);
}

/** Карта, целиком заполненная value. */
function uniform(width: number, height: number, value: number) {
  const rows = Array.from({ length: height + 1 }, () => new Array<number>(width + 1).fill(value));
  return curvatureOf(width, height, rows);
}

/** 4×2, плоский уровень 0. */
function flatGrid() {
  return createTerrainGrid({
    width: 4,
    height: 2,
    tileSize: FIXED_ONE,
    levels: ['0000', '0000'],
    flags: ['....', '....'],
  });
}

/** 4×4, плоский уровень 0 — плато, по которому рисуется кривизна. */
function plateauGrid() {
  return createTerrainGrid({
    width: 4,
    height: 4,
    tileSize: FIXED_ONE,
    levels: ['0000', '0000', '0000', '0000'],
    flags: ['....', '....', '....', '....'],
  });
}

/** 2×2: левый столбец — уровень 0, правый — уровень 1, рамп нет. */
function cliffGrid() {
  return createTerrainGrid({
    width: 2,
    height: 2,
    tileSize: FIXED_ONE,
    levels: ['01', '01'],
    flags: ['..', '..'],
  });
}

/** Сетка из карт уровней и флагов — общая форма фикстур правила углов. */
function gridOf(levels: readonly string[], flags: readonly string[]) {
  return createTerrainGrid({
    width: levels[0]!.length,
    height: levels.length,
    tileSize: FIXED_ONE,
    levels: [...levels],
    flags: [...flags],
  });
}

/**
 * 4×2: уровни 0,1,2,3 по x, три нижние клетки пар помечены рампами — длинный
 * склон в несколько уровней. Рампы идут парой по y: одиночная запрещена (TERR-7).
 */
const chainGrid = () => gridOf(['0123', '0123'], ['^^^.', '^^^.']);

/** Та же цепочка, но последний переход без рампы — склон упирается в обрыв. */
const chainToCliffGrid = () => gridOf(['0123', '0123'], ['^^..', '^^..']);

/** 2×2: рампа уровня 0 против плато уровня 1 — одиночная пара «рампа + плато». */
const rampToPlateauGrid = () => gridOf(['01', '01'], ['^.', '^.']);

/**
 * 2×2: плато уровня 1 слева, рампа уровня 0 справа — та же пара, зеркальная по
 * оси x. Флаг стоит на НИЖНЕЙ клетке (TERR-5), поэтому склон — правая клетка, и
 * тянется её западное ребро.
 */
const rampFromLowlandGrid = () => gridOf(['10', '10'], ['.^', '.^']);

/**
 * 3×3: клетку-рампу (1,1) уровня 1 заявляют два ребра — запад тянет вверх, к
 * уровню 2, а юг подавлен нижней рампой и заявляет свой уровень 1. Угол c01
 * достаётся обоим, и спор решает порядок рёбер, а не знак перепада.
 */
const conflictGrid = () => gridOf(['211', '211', '200'], ['.^^', '.^^', '.^^']);

/** То же, но север — НИЖНЯЯ РАМПА: её притяжение вниз подавлено (REND-9). */
const suppressedConflictGrid = () => gridOf(['200', '211', '211'], ['.^^', '.^^', '...']);

/**
 * 3×2, уровни 0,1,1 по x: столбец x = 0 (уровень 0) помечается рампой флагом —
 * парой по y, одиночная запрещена (TERR-7). Правка ОДНОГО ЛИШЬ флага: уровни в
 * обоих состояниях те же, и обе карты проходят загрузку (TERR-5).
 */
function rampFlagGrid(westRamp: boolean) {
  const row = `${westRamp ? '^' : '.'}..`;
  return gridOf(['011', '011'], [row, row]);
}

/**
 * 3×2: цепочка рамп в столбцах x = 0 (уровень 0) и x = 1 (уровень 1), хвост
 * x = 2 либо вровень с рампой, либо поднят до уровня 2. Правка одного лишь
 * УРОВНЯ хвоста — флаги в обоих состояниях те же.
 */
function rampTailGrid(raised: boolean) {
  const row = raised ? '012' : '011';
  return gridOf([row, row], ['^^.', '^^.']);
}

const normal = (): SurfaceNormal => ({ x: 0, y: 0, z: 0 });

describe('createVisualSurface (REND-9)', () => {
  it('без кривизны совпадает со ступенями: высота — уровень × шаг, нормаль вертикальна', () => {
    const surface = createVisualSurface(cliffGrid(), STEP, null);
    expect(surface.hasCurvature).toBe(false);
    expect(surface.heightAt(0.5, 0.5)).toBeCloseTo(0, 6);
    expect(surface.heightAt(1.5, 0.5)).toBeCloseTo(STEP, 6);
    const n = surface.normalAt(0.5, 0.5, normal());
    expect(n.z).toBeCloseTo(1, 6);
  });

  it('выпуклость поднимает поверхность, вогнутость опускает; высота непрерывна внутри уровня', () => {
    const grid = flatGrid();
    // Столбец узлов x=1 поднят, x=3 опущен: бугор у клетки 1, впадина у клетки 3.
    const surface = createVisualSurface(
      grid,
      STEP,
      curvatureOf(4, 2, [
        [0, 16, 0, -16, 0],
        [0, 16, 0, -16, 0],
        [0, 16, 0, -16, 0],
      ]),
    );
    expect(surface.heightAt(1.2, 1)).toBeGreaterThan(0);
    expect(surface.heightAt(2.8, 1)).toBeLessThan(0);
    // Высота непрерывна на границах клеток.
    for (const border of [1, 2, 3]) {
      expect(surface.heightAt(border - 1e-6, 0.7)).toBeCloseTo(surface.heightAt(border + 1e-6, 0.7), 4);
    }
    // На склоне бугра нормаль отклонена от вертикали и смотрит от вершины.
    const slope = surface.normalAt(0.7, 1.0, normal());
    expect(slope.x).toBeLessThan(-1e-3); // вершина восточнее — нормаль валится на запад
    expect(slope.z).toBeGreaterThan(0.9); // амплитуда мала — наклон умеренный
  });

  it('на границе клеток одного уровня сходятся и высота, и наклон (C1)', () => {
    // Узловые смещения разные по обеим осям — иначе тангенциальная производная
    // нулевая с обеих сторон и сравнивать было бы нечего.
    const surface = createVisualSurface(
      plateauGrid(),
      STEP,
      curvatureOf(4, 4, [
        [0, 7, -7, 0, 3],
        [7, 0, -7, 5, 0],
        [-7, 5, 0, 0, 2],
        [0, 0, 7, 1, 0],
        [2, 0, 0, 4, 0],
      ]),
    );

    let tilted = 0;
    const probe = (ax: number, ay: number, bx: number, by: number): void => {
      expect(surface.heightAt(ax, ay)).toBeCloseTo(surface.heightAt(bx, by), 5);
      const before = surface.normalAt(ax, ay, normal());
      const after = surface.normalAt(bx, by, normal());
      // Хребта в узле нет: наклон по обе стороны границы один и тот же.
      expect(before.x).toBeCloseTo(after.x, 4);
      expect(before.y).toBeCloseTo(after.y, 4);
      expect(before.z).toBeCloseTo(after.z, 4);
      if (Math.hypot(before.x, before.y) > 1e-3) tilted++;
    };

    for (const border of [1, 2, 3]) {
      for (const along of [0.3, 1.7, 2.5, 3.4]) {
        probe(border - 1e-6, along, border + 1e-6, along); // вертикальные границы
        probe(along, border - 1e-6, along, border + 1e-6); // горизонтальные
      }
    }
    // Проверка не вырождена: на границах поверхность местами наклонена.
    expect(tilted).toBeGreaterThan(0);
    // И внутри клетки наклон точно есть — сглаживание не сплющило рельеф.
    expect(Math.abs(surface.normalAt(1.5, 1.5, normal()).x)).toBeGreaterThan(1e-3);
  });

  it('амплитуда произвольна: холм выше шага уровня легален и стенок не порождает', () => {
    const grid = flatGrid();
    // |40| > 32 — рельеф крупнее целого шага высоты; предела формата нет (ASSET-7).
    const surface = createVisualSurface(grid, STEP, uniform(4, 2, 40));
    expect(surface.heightAt(2, 1)).toBeCloseTo((40 / 32) * STEP, 5);
    expect(surface.heightAt(2, 1)).toBeGreaterThan(STEP);
    // Кривизна не порождает cliff-геометрию: стенок на плоской арене нет (REND-9).
    const walls = buildWallGeometry(grid, STEP, surface);
    expect(walls.positions.length).toBe(0);
  });

  it('узел на cliff-границе двигает оба уровня одним значением: перепад точен, стенка вертикальна', () => {
    const grid = cliffGrid();
    // Весь столбец узлов кромки x=1 поднят.
    const surface = createVisualSurface(grid, STEP, columnAt(2, 2, 1, 16));
    // Кромка низины и кромка плато поднялись на одно и то же 16/32 шага.
    expect(surface.heightInCell(0, 0, 1, 0.5)).toBeCloseTo((16 / 32) * STEP, 5);
    expect(surface.heightInCell(1, 0, 1, 0.5)).toBeCloseTo(STEP + (16 / 32) * STEP, 5);
    // Перепад — ровно ступень: обрыв нельзя «закопать» кривизной по построению.
    expect(surface.heightInCell(1, 0, 1, 0.5) - surface.heightInCell(0, 0, 1, 0.5)).toBeCloseTo(
      STEP,
      6,
    );
  });

  it('кривизна вдали от кромки не трогает соседний уровень: своих узлов у него нет', () => {
    const grid = cliffGrid();
    // Поднят только дальний столбец узлов плато x=2; узлы кромки x=1 нулевые.
    const surface = createVisualSurface(grid, STEP, columnAt(2, 2, 2, 16));
    // Низина плоская: все её узлы нулевые.
    expect(surface.heightAt(0.5, 1)).toBeCloseTo(0, 6);
    const n = surface.normalAt(0.5, 1, normal());
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.y).toBeCloseTo(0, 6);
    // Плато наклонено к дальнему краю, высоты на кромке расходятся на ступень.
    expect(Math.abs(surface.normalInCell(1, 0, 1.5, 0.5, normal()).x)).toBeGreaterThan(1e-2);
    expect(surface.heightInCell(1, 0, 1, 0.5) - surface.heightInCell(0, 0, 1, 0.5)).toBeCloseTo(
      STEP,
      6,
    );
  });

  it('через cliff-границу не усредняются нормали: кромка плато не скругляется', () => {
    const grid = cliffGrid();
    // Кривизна меняется вдоль кромки: узел (1, 1) поднят — плато и низина
    // наклонены вдоль границы, но каждая клетка считает нормаль по своим углам.
    const surface = createVisualSurface(grid, STEP, bumpAt(2, 2, 1, 1, 16));
    const lower = surface.normalInCell(0, 0, 1, 0.5, normal());
    const upper = surface.normalInCell(1, 0, 1, 0.5, normal());
    // Одна и та же мировая точка на кромке даёт две нормали — свою у каждого
    // уровня; усреднить их некому, потому что усреднения нет вовсе.
    expect(Math.abs(lower.y)).toBeGreaterThan(1e-2);
    expect(Math.abs(upper.y)).toBeGreaterThan(1e-2);
    // Высоты на кромке расходятся ровно на ступень — силуэт остался резким.
    expect(surface.heightInCell(1, 0, 1, 0.5) - surface.heightInCell(0, 0, 1, 0.5)).toBeCloseTo(
      STEP,
      6,
    );
  });

  it('за краем сетки отвечает ближайшая клетка — запрос тотален', () => {
    const surface = createVisualSurface(cliffGrid(), STEP, null);
    expect(surface.heightAt(-5, -5)).toBeCloseTo(0, 6);
    expect(surface.heightAt(50, 50)).toBeCloseTo(STEP, 6);
    expect(surface.normalAt(-5, 0.5, normal()).z).toBeCloseTo(1, 6);
  });
});

describe('углы рампы и цепочки рамп (REND-9)', () => {
  it('общее ребро пары смежных рамп лежит на уровне верхней клетки', () => {
    const grid = chainGrid();
    // Нижняя клетка пары дотягивается вверх, верхняя вниз не спускается.
    expect(cornerLevels(grid, 0, 0)).toEqual([0, 1, 1, 0]);
    expect(cornerLevels(grid, 1, 0)).toEqual([1, 2, 2, 1]);
    expect(cornerLevels(grid, 2, 0)).toEqual([2, 3, 3, 2]);
    // Верх склона рампой не помечен — плоская площадка своего уровня (REND-7).
    expect(cornerLevels(grid, 3, 0)).toEqual([3, 3, 3, 3]);
    // В общих узлах пар база едина: посреди склона разрыва нет.
    for (let x = 0; x + 1 < 4; x++) {
      const left = cornerLevels(grid, x, 0);
      const right = cornerLevels(grid, x + 1, 0);
      expect([left[1], left[2]]).toEqual([right[0], right[3]]);
    }
  });

  it('одиночная рампа смыкается с плато притяжением вверх — с любой стороны', () => {
    // Притяжение вверх к плато — правило до обобщения, байт-в-байт.
    expect(cornerLevels(rampToPlateauGrid(), 0, 0)).toEqual([0, 1, 1, 0]);
    // Зеркальная пара: флаг рампы принадлежит нижней клетке (TERR-5), поэтому
    // склон — правая клетка, и вверх тянется её западное ребро.
    expect(cornerLevels(rampFromLowlandGrid(), 1, 0)).toEqual([1, 0, 0, 1]);
    // Клетка без рампы плоская на своём уровне при любых соседях.
    expect(cornerLevels(rampToPlateauGrid(), 1, 0)).toEqual([1, 1, 1, 1]);
    expect(cornerLevels(rampFromLowlandGrid(), 0, 0)).toEqual([1, 1, 1, 1]);
  });

  it('cliff-узел остаётся двузначным: смыкание пар не переносит значение через стенку', () => {
    const grid = chainToCliffGrid();
    expect(grid.cliffs.length).toBeGreaterThan(0);
    // Пара рамп сомкнута по верхней клетке...
    expect(cornerLevels(grid, 0, 0)).toEqual([0, 1, 1, 0]);
    expect(cornerLevels(grid, 1, 0)).toEqual([1, 2, 2, 1]);
    // ...а через стенку узел двузначен: кромка низины 2, кромка плато 3.
    expect(cornerLevels(grid, 2, 0)).toEqual([2, 2, 2, 2]);
    expect(cornerLevels(grid, 3, 0)).toEqual([3, 3, 3, 3]);
  });

  it('конфликт двух рёбер в одном углу решает фиксированный порядок W, E, N, S', () => {
    // Угол c01 (индекс 3) заявляют запад (притяжение вверх, уровень 2) и юг
    // (подавленная нижней рампой заявка, свой уровень 1): достаётся он
    // последнему по порядку ребру (S), а не большему из уровней.
    expect(cornerLevels(conflictGrid(), 1, 1)).toEqual([2, 1, 1, 1]);
  });

  it('подавленная заявка — свой уровень клетки, а не отсутствие заявки', () => {
    const grid = suppressedConflictGrid();
    // Север — нижняя рампа: ребро остаётся на своём уровне 1 и по тому же
    // порядку рёбер перебивает западное притяжение вверх.
    expect(cornerLevels(grid, 1, 1)).toEqual([1, 1, 1, 2]);
    // Пара по вертикали сомкнута: нижняя рампа дотянулась до того же уровня.
    expect(cornerLevels(grid, 1, 0)).toEqual([0, 0, 1, 1]);
  });

  it('пол цепочки рамп не рвётся на общем ребре пары: щели без cliff-стенки нет', () => {
    const grid = chainGrid();
    expect(grid.cliffs.length).toBe(0); // все переходы проходимы — стенок нет
    const floor = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2);
    // На границах клеток x = 1, 2, 3 у вершин обеих клеток одна высота:
    // разрыв посреди склона был бы вертикальной щелью без cliff-геометрии.
    for (const border of [1, 2, 3]) {
      const heights = new Set<number>();
      for (let v = 0; v < floor.positions.length; v += 3) {
        if (Math.abs(floor.positions[v]! - border) < 1e-6) heights.add(floor.positions[v + 2]!);
      }
      expect([...heights]).toEqual([border * STEP]);
    }
    expect(buildWallGeometry(grid, STEP).indices.length).toBe(0);
    // Тот же пол выборкой поля без кривизны: база у геометрии и поля одна.
    const field = buildFloorGeometry(
      grid,
      grid.floor,
      STEP,
      0,
      0,
      4,
      2,
      createVisualSurface(grid, STEP, null),
    );
    expect([...field.positions]).toEqual([...floor.positions]);
  });

  it('кисть уровня пересчитывает углы соседа: прямоугольник расширяется на клетку', () => {
    const surface = createVisualSurface(rampTailGrid(false), STEP, null);
    // Хвост вровень с рампой — тянуть её восточному ребру некуда.
    expect(surface.cornerHeights(1, 0)).toEqual([STEP, STEP, STEP, STEP]);
    // Мазок поднял столбец x = 2 и отдан прямоугольником ИЗМЕНИВШИХСЯ клеток:
    // зависимость угла рампы от уровня СОСЕДА покрыта расширением на клетку —
    // соседей поверхность пересчитывает сама.
    surface.update(rampTailGrid(true), null, 2, 0, 2, 1);
    expect(surface.cornerHeights(1, 0)).toEqual([STEP, 2 * STEP, 2 * STEP, STEP]);
    // Дальний от правки конец цепочки не поехал: расширение — ровно на клетку.
    expect(surface.cornerHeights(0, 0)).toEqual([0, STEP, STEP, 0]);
  });
});

describe('геометрия с кривизной (REND-9)', () => {
  it('пол с поверхностью повторяет её форму; без поверхности — прежние ступени', () => {
    const grid = flatGrid();
    const surface = createVisualSurface(grid, STEP, uniform(4, 2, 7));
    const curved = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2, surface);
    const flat = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2);
    // Все углы подняты на равномерное поле 7/32 шага.
    let raised = 0;
    for (let i = 2; i < curved.positions.length; i += 3) {
      const z = curved.positions[i]!;
      expect(z).toBeCloseTo((7 / 32) * STEP, 6);
      if (z > 0) raised++;
    }
    expect(raised).toBeGreaterThan(0);
    for (let i = 2; i < flat.positions.length; i += 3) expect(flat.positions[i]).toBe(0);
  });

  it('сцена без карты кривизны собирает ТУ ЖЕ геометрию, что карта из одних нулей', () => {
    const grid = flatGrid();
    // Карта задана, но пустая: узловые смещения нулевые — клетка остаётся одним
    // квадом, и позиции совпадают с прежними ступенями побитово.
    const empty = createVisualSurface(grid, STEP, uniform(4, 2, 0));
    const none = createVisualSurface(grid, STEP, null);
    const withMap = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2, empty);
    const withSurface = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2, none);
    const stairs = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2);

    // Пре-change ожидание: квад на клетку, четыре вершины, все на нуле.
    expect(stairs.positions.length).toBe(4 * 2 * 4 * 3);
    expect(withMap.positions.length).toBe(stairs.positions.length);
    expect([...withMap.positions]).toEqual([...stairs.positions]);
    expect([...withSurface.positions]).toEqual([...stairs.positions]);
    expect([...withMap.indices]).toEqual([...stairs.indices]);
    // Нормали пустой карты — вертикали площадки, как и у ступеней.
    for (let i = 0; i < withMap.normals!.length; i += 3) {
      expect(withMap.normals![i]).toBeCloseTo(0, 6);
      expect(withMap.normals![i + 1]).toBeCloseTo(0, 6);
      expect(withMap.normals![i + 2]).toBeCloseTo(1, 6);
    }
    // Стенок на плоской арене нет ни там, ни там; на обрыве без кривизны —
    // прежний одиночный квад на отрезок.
    const cliff = cliffGrid();
    const flatCliff = createVisualSurface(cliff, STEP, uniform(2, 2, 0));
    const wallsPlain = buildWallGeometry(cliff, STEP);
    const wallsField = buildWallGeometry(cliff, STEP, flatCliff);
    expect([...wallsField.positions]).toEqual([...wallsPlain.positions]);
  });

  it('стенка тянется до фактических визуальных кромок (skirt)', () => {
    const grid = cliffGrid();
    const surface = createVisualSurface(grid, STEP, columnAt(2, 2, 1, 16));
    const walls = buildWallGeometry(grid, STEP, surface);
    // Верхние кромки стенок идут по полю плато, а не по level × step.
    const tops: number[] = [];
    for (let i = 0; i < walls.positions.length; i += 3) {
      const z = walls.positions[i + 2]!;
      if (z > STEP / 2) tops.push(z);
    }
    expect(tops.length).toBeGreaterThan(0);
    for (let i = 0; i < walls.positions.length; i += 3) {
      const y = walls.positions[i + 1]!;
      const z = walls.positions[i + 2]!;
      if (z <= STEP / 2) continue;
      // Кромка — выборка поля верхней клетки в той же точке отрезка.
      const cellY = Math.min(Math.max(Math.floor(y - 1e-9), 0), 1);
      expect(z).toBeCloseTo(surface.heightInCell(1, cellY, 1, y), 6);
    }
  });
});

describe('VisualSurfaceSource (ASSET-7 → REND-9)', () => {
  function makeCtx() {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    return { assets, ctx };
  }

  it('до готовности карты поверхность плоская; по готовности подменяется и зовёт подписчиков', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid(), { curvatureMapId: 'visuals/curve.json' });
    let changes = 0;
    source.onChange(() => changes++);
    source.init(ctx);
    source.init(ctx); // идемпотентность: обе подсистемы зовут init
    expect(source.current?.hasCurvature).toBe(false);
    expect(assets.requests.filter((r) => r.kind === 'terrain-curvature').length).toBe(1);

    assets.resolve('terrain-curvature', 'visuals/curve.json', bumpAt(4, 2, 2, 1, 16));
    expect(changes).toBe(1);
    expect(source.current?.hasCurvature).toBe(true);
    expect(source.current!.heightAt(2, 1)).toBeGreaterThan(0);
  });

  it('несовпадение сетки — предупреждение и рендер без кривизны (ASSET-7)', () => {
    const { assets, ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), {
      curvatureMapId: 'visuals/wrong.json',
      warn: (m) => warnings.push(m),
    });
    source.init(ctx);
    assets.resolve('terrain-curvature', 'visuals/wrong.json', uniform(3, 3, 0));
    expect(warnings.some((w) => w.includes('не совпадает с сеткой'))).toBe(true);
    expect(source.current?.hasCurvature).toBe(false);
  });

  it('ошибка загрузки — предупреждение и плоские ступени', () => {
    const { assets, ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), {
      curvatureMapId: 'visuals/missing.json',
      warn: (m) => warnings.push(m),
    });
    source.init(ctx);
    assets.fail('terrain-curvature', 'visuals/missing.json', 'файл недоступен');
    expect(warnings.some((w) => w.includes('не загрузилась'))).toBe(true);
    expect(source.current?.hasCurvature).toBe(false);
  });

  it('без curvatureMapId ассеты не запрашиваются — плоские ступени без предупреждений', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    source.init(ctx);
    expect(assets.requests.length).toBe(0);
    expect(source.current?.hasCurvature).toBe(false);
  });
});

describe('VisualSurfaceSource: документные входы (ED-10, ED-11, ED-15)', () => {
  function makeCtx() {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: STEP },
    };
    return { assets, ctx };
  }

  /** 4×2, клетка (x, 0) поднята на уровень 1 — результат кисти уровня (ED-10). */
  function raisedGrid(x: number) {
    const row = `${'0'.repeat(x)}1${'0'.repeat(3 - x)}`;
    return createTerrainGrid({
      width: 4,
      height: 2,
      tileSize: FIXED_ONE,
      levels: [row, '0000'],
      flags: ['....', '....'],
    });
  }

  it('карта кривизны из памяти применяется без ассета и зовёт подписчиков списком клеток', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    const changes: (readonly number[] | null)[] = [];
    source.onChange((cells) => changes.push(cells));
    source.init(ctx);

    source.setCurvature(bumpAt(4, 2, 2, 1, 16));
    expect(assets.requests.length).toBe(0); // документ, а не ассет
    expect(source.current!.hasCurvature).toBe(true);
    expect(source.current!.heightAt(2, 1)).toBeGreaterThan(0);
    // Узел — общий угол четырёх клеток (1, 2, 5, 6), и подписчик получил их
    // ОКРЕСТНОСТЬ — тот же прямоугольник ±1, каким поверхность пересчитала
    // углы: угол клетки зависит от уровней и флагов рампы соседей (REND-9), и
    // подписчик, метящий ровно названные клетки (вода REND-35), иначе оставил
    // бы соседнюю рампу от прежнего поля. «Вся поверхность» (null) это по-
    // прежнему не: за пределами окрестности не помечено ничего.
    expect(changes).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);

    // Снятие карты возвращает плоские ступени REND-7.
    source.setCurvature(null);
    expect(source.current!.hasCurvature).toBe(false);
    expect(source.current!.heightAt(2, 1)).toBeCloseTo(0, 6);
  });

  it('карта из памяти главнее догруженного ассета: она и есть текущий документ', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid(), { curvatureMapId: 'visuals/curve.json' });
    source.init(ctx);
    source.setCurvature(bumpAt(4, 2, 2, 1, 16));

    assets.resolve('terrain-curvature', 'visuals/curve.json', bumpAt(4, 2, 4, 1, 16));
    // Ассет не перебил правку: поднят узел кисти, а не узел ассета.
    expect(source.current!.heightAt(2, 1)).toBeGreaterThan(0);
    expect(source.current!.heightAt(3.9, 0.5)).toBeCloseTo(0, 4);
  });

  it('несовпадение сетки карты из памяти — предупреждение и игнор (ASSET-7)', () => {
    const { ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), { warn: (m) => warnings.push(m) });
    source.init(ctx);
    source.setCurvature(uniform(3, 3, 0));
    expect(warnings.some((w) => w.includes('не совпадает с сеткой'))).toBe(true);
    expect(source.current!.hasCurvature).toBe(false);
  });

  it('setGrid принимает пересчитанную ядром сетку: высоты идут за уровнями (TERR-5)', () => {
    const { ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    const changes: (readonly number[] | null)[] = [];
    source.onChange((cells) => changes.push(cells));
    source.init(ctx);
    expect(source.current!.heightAt(1.5, 0.5)).toBeCloseTo(0, 6);

    const raised = raisedGrid(1);
    // Обрывы вывело ядро; источник поверхности их не выводит (ED-1).
    expect(raised.cliffs.length).toBeGreaterThan(0);
    source.setGrid(raised);
    expect(source.current!.heightAt(1.5, 0.5)).toBeCloseTo(STEP, 6);
    expect(source.current!.cornerHeights(1, 0)).toEqual([STEP, STEP, STEP, STEP]);
    // Соседняя клетка осталась внизу: правка не «перетекла» через границу.
    expect(source.current!.heightAt(2.5, 0.5)).toBeCloseTo(0, 6);
    // Изменилась клетка 1, уведомлена её окрестность ±1 — ровно то, что
    // пересчитала поверхность (REND-9); клетка 3 (x = 3) в неё не входит.
    expect(changes).toEqual([[0, 1, 2, 4, 5, 6]]);

    // Сетка, отличающаяся только полом, поверхности не видна — подписчики молчат.
    source.setGrid(raisedGrid(1));
    expect(changes.length).toBe(1);
  });

  it('правка одного флага рампы уведомляет её клетками, а сосед остаётся на месте', () => {
    const { ctx } = makeCtx();
    const source = new VisualSurfaceSource(rampFlagGrid(false));
    const changes: (readonly number[] | null)[] = [];
    source.onChange((cells) => changes.push(cells));
    source.init(ctx);
    expect(source.current!.cornerHeights(0, 0)).toEqual([0, 0, 0, 0]);

    // Уровни прежние, изменился только флаг столбца x = 0 (кисть рампы ED-10).
    source.setGrid(rampFlagGrid(true));
    // Флаг сменился у клеток 0 и 3 (столбец x = 0), уведомлена их окрестность
    // ±1: угол рампы тянется к проходимому соседу, и его высота меняется от
    // ЧУЖОГО флага (REND-9).
    expect(changes).toEqual([[0, 1, 3, 4]]);
    // Помеченная клетка стала склоном: её восточное ребро тянется вверх.
    expect(source.current!.cornerHeights(0, 0)).toEqual([0, STEP, STEP, 0]);
    // А сосед остался плоским: на карте, прошедшей загрузку, нижний сосед
    // рампы сам помечен рампой (TERR-5), и за чужим флагом угол не едет.
    expect(source.current!.cornerHeights(1, 0)).toEqual([STEP, STEP, STEP, STEP]);
  });

  it('смена ОДНОГО tileSize переконфигурирует реестр walkable и зовёт подписчиков', () => {
    // Другой шаг клетки — другой перевод мира в клетки: диапазоны клеток
    // walkable-записей посчитаны прежним шагом (REND-9), и оставить реестр как
    // есть значило бы держать вклад настила привязанным к прежней раскладке.
    const { ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    source.init(ctx);
    const changes: (readonly number[] | null)[] = [];
    source.onChange((cells) => changes.push(cells));

    const deck: WalkablePlacement = {
      x: 0.5,
      y: 0.5,
      yaw: 0,
      tiltFactor: 0,
      tiltMaxRad: null,
      scale: 1,
      model: deckModel(),
    };
    source.setWalkable(1, deck);
    // Настил накрывает клетку (0, 0) при клетке в одну мировую единицу.
    expect(source.current!.hasCellWalkable(0, 0)).toBe(true);
    expect(source.current!.hasCellWalkable(2, 0)).toBe(false);
    changes.length = 0;

    // Та же арена в клетках, но клетка вдвое мельче: тот же настил накрывает
    // вдвое больше клеток.
    source.setGrid(
      createTerrainGrid({
        width: 4,
        height: 2,
        tileSize: FIXED_ONE / 2,
        levels: ['0000', '0000'],
        flags: ['....', '....'],
      }),
    );
    expect(changes).toEqual([null]);
    expect(source.current!.hasCellWalkable(2, 0)).toBe(true);
  });

  it('правка рядом с рампой уведомляет и её: инкрементальное обновление равно полному', () => {
    // Клетка 1 — рампа: её углы тянутся к проходимому соседу (TERR-5), поэтому
    // подъём КЛЕТКИ 2 двигает поле в клетке 1. Подписчик, метящий ровно
    // названные клетки (вода REND-35), обязан услышать про обе.
    const { ctx } = makeCtx();
    const source = new VisualSurfaceSource(
      createTerrainGrid({
        width: 4,
        height: 2,
        tileSize: FIXED_ONE,
        levels: ['0000', '0000'],
        flags: ['....', '....'],
      }),
    );
    source.init(ctx);
    const changes: (readonly number[] | null)[] = [];
    source.onChange((cells) => changes.push(cells));

    // Кисть подняла столбец x = 2 и пометила столбец x = 1 рампой (ED-10):
    // изменились клетки 1, 2, 5, 6, а поле поехало и в клетке 0 — угол рампы
    // тянется к соседу.
    source.setGrid(
      createTerrainGrid({
        width: 4,
        height: 2,
        tileSize: FIXED_ONE,
        levels: ['0010', '0010'],
        flags: ['.^..', '.^..'],
      }),
    );
    expect(source.current!.cornerHeights(1, 0)).toEqual([0, STEP, STEP, 0]);
    const notified = new Set(changes[0]);
    for (const cell of [1, 2, 5, 6]) expect(notified.has(cell), `клетка ${cell}`).toBe(true);
    // И соседи изменившихся — тоже: их углы пересчитаны тем же прямоугольником.
    expect(notified.has(0)).toBe(true);
    expect(notified.has(3)).toBe(true);
  });

  it('кривизна безразлична к уровням: подъём клетки сдвигает базу, узлы остаются', () => {
    const { ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    source.init(ctx);
    // Столбец узлов x=2 — граница клеток 1 и 2, пока обе на уровне 0.
    const lift = (16 / 32) * STEP;
    source.setCurvature(columnAt(4, 2, 2, 16));
    expect(source.current!.heightAt(2 - 1e-6, 0.5)).toBeCloseTo(lift, 4);
    expect(source.current!.heightAt(2 + 1e-6, 0.5)).toBeCloseTo(lift, 4);

    // Клетка 1 поднялась: её кромка — база плюс то же узловое смещение, кромка
    // соседа — только смещение; перепад между ними ровно ступень (REND-9).
    source.setGrid(raisedGrid(1));
    expect(source.current!.heightInCell(1, 0, 2, 0.5)).toBeCloseTo(STEP + lift, 4);
    expect(source.current!.heightInCell(2, 0, 2, 0.5)).toBeCloseTo(lift, 4);
  });
});
