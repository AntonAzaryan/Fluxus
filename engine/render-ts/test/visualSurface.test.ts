/**
 * Визуальная поверхность террейна (REND-9): гладкость внутри уровня (C1 —
 * сходятся и высота, и наклон), отсутствие «перетекания» кривизны через
 * cliff-границу, амплитуда меньше полушага, источник поверхности с догрузкой
 * карты и несовпадением сетки.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@game-mvp/core';
import { validateCurvatureMap, type TerrainCurvatureMap } from '@game-mvp/assets';
import {
  VisualSurfaceSource,
  buildFloorGeometry,
  buildWallGeometry,
  createVisualSurface,
  type RenderContext,
  type SurfaceNormal,
} from '../src/index.js';
import { makeAssets } from './fixtures.js';

const STEP = 0.5;

function curvatureOf(width: number, height: number, rows: string[]): TerrainCurvatureMap {
  const result = validateCurvatureMap({ width, height, rows });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
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

  it('выпуклость поднимает поверхность, вогнутость опускает; высота и нормаль непрерывны внутри уровня', () => {
    const grid = flatGrid();
    const surface = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['.7g.', '.7g.']));
    // Центры клеток: бугор под "7", впадина под "g".
    expect(surface.heightAt(1.5, 1)).toBeGreaterThan(0);
    expect(surface.heightAt(2.5, 1)).toBeLessThan(0);
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
    // Смещения разные по обеим осям — иначе тангенциальная производная нулевая
    // с обеих сторон и сравнивать было бы нечего.
    const surface = createVisualSurface(
      plateauGrid(),
      STEP,
      curvatureOf(4, 4, ['.7g.', '7.g5', 'g5..', '..71']),
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

  it('амплитуда ограничена меньше полушага: бугор не прочитывается как соседний уровень (REND-7)', () => {
    const grid = flatGrid();
    // Максимальная выпуклость всюду — предельный случай алфавита.
    const surface = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['7777', '7777']));
    for (const [x, y] of [[0.5, 0.5], [1.5, 1.5], [3.5, 0.5], [2, 1]] as const) {
      expect(Math.abs(surface.heightAt(x, y))).toBeLessThan(STEP / 2);
    }
  });

  it('кривизна не перетекает через cliff-границу: плато вздувается, низина не тронута', () => {
    const grid = cliffGrid();
    // Вся кривизна — на правом столбце (уровень 1).
    const surface = createVisualSurface(grid, STEP, curvatureOf(2, 2, ['.7', '.7']));
    // Углы низины на самой границе x=1 остаются на нулевой высоте.
    expect(surface.heightAt(1 - 1e-6, 0.5)).toBeCloseTo(0, 5);
    expect(surface.heightAt(1 - 1e-6, 1.5)).toBeCloseTo(0, 5);
    // Плато у границы поднято.
    expect(surface.heightAt(1 + 1e-6, 1)).toBeGreaterThan(STEP);
    // Нормаль в низине вертикальна: чужая кривизна на неё не влияет.
    const n = surface.normalAt(0.5, 1, normal());
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.y).toBeCloseTo(0, 6);
  });

  it('через cliff-границу не усредняются и нормали: кромка плато не скругляется', () => {
    const grid = cliffGrid();
    // Кривизна только у верхней клетки плато — плато наклонено вдоль кромки.
    const surface = createVisualSurface(grid, STEP, curvatureOf(2, 2, ['.7', '..']));
    const lower = surface.normalInCell(0, 0, 1, 0.5, normal());
    const upper = surface.normalInCell(1, 0, 1, 0.5, normal());
    // Одна и та же мировая точка на кромке: снизу — нормаль низины, сверху —
    // нормаль плато. Усреднить их некому, потому что усреднения нет вовсе.
    expect(lower.x).toBeCloseTo(0, 6);
    expect(lower.y).toBeCloseTo(0, 6);
    expect(lower.z).toBeCloseTo(1, 6);
    expect(Math.abs(upper.y)).toBeGreaterThan(1e-2);
    // И высоты на кромке расходятся на ступень — силуэт остался резким.
    expect(surface.heightInCell(1, 0, 1, 0.5) - surface.heightInCell(0, 0, 1, 0.5)).toBeGreaterThan(
      STEP / 2,
    );
  });

  it('за краем сетки отвечает ближайшая клетка — запрос тотален', () => {
    const surface = createVisualSurface(cliffGrid(), STEP, null);
    expect(surface.heightAt(-5, -5)).toBeCloseTo(0, 6);
    expect(surface.heightAt(50, 50)).toBeCloseTo(STEP, 6);
    expect(surface.normalAt(-5, 0.5, normal()).z).toBeCloseTo(1, 6);
  });
});

describe('геометрия с кривизной (REND-9)', () => {
  it('пол с поверхностью повторяет её форму; без поверхности — прежние ступени', () => {
    const grid = flatGrid();
    const surface = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['7777', '7777']));
    const curved = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2, surface);
    const flat = buildFloorGeometry(grid, grid.floor, STEP, 0, 0, 4, 2);
    // Все внутренние углы подняты, но меньше полушага.
    let raised = 0;
    for (let i = 2; i < curved.positions.length; i += 3) {
      const z = curved.positions[i]!;
      expect(z).toBeLessThan(STEP / 2);
      if (z > 0) raised++;
    }
    expect(raised).toBeGreaterThan(0);
    for (let i = 2; i < flat.positions.length; i += 3) expect(flat.positions[i]).toBe(0);
  });

  it('сцена без карты кривизны собирает ТУ ЖЕ геометрию, что карта из одних точек', () => {
    const grid = flatGrid();
    // Карта задана, но пустая: узловые смещения нулевые — клетка остаётся одним
    // квадом, и позиции совпадают с прежними ступенями побитово.
    const empty = createVisualSurface(grid, STEP, curvatureOf(4, 2, ['....', '....']));
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
    const flatCliff = createVisualSurface(cliff, STEP, curvatureOf(2, 2, ['..', '..']));
    const wallsPlain = buildWallGeometry(cliff, STEP);
    const wallsField = buildWallGeometry(cliff, STEP, flatCliff);
    expect([...wallsField.positions]).toEqual([...wallsPlain.positions]);
  });

  it('стенка тянется до фактических визуальных кромок (skirt)', () => {
    const grid = cliffGrid();
    const surface = createVisualSurface(grid, STEP, curvatureOf(2, 2, ['.7', '.7']));
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

    assets.resolve('terrain-curvature', 'visuals/curve.json', curvatureOf(4, 2, ['.7..', '....']));
    expect(changes).toBe(1);
    expect(source.current?.hasCurvature).toBe(true);
    expect(source.current!.heightAt(1.5, 0.5)).toBeGreaterThan(0);
  });

  it('несовпадение сетки — предупреждение и рендер без кривизны (ASSET-7)', () => {
    const { assets, ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), {
      curvatureMapId: 'visuals/wrong.json',
      warn: (m) => warnings.push(m),
    });
    source.init(ctx);
    assets.resolve('terrain-curvature', 'visuals/wrong.json', curvatureOf(3, 3, ['...', '...', '...']));
    expect(warnings.some((w) => /не совпадает с сеткой/.test(w))).toBe(true);
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
    expect(warnings.some((w) => /не загрузилась/.test(w))).toBe(true);
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

    source.setCurvature(curvatureOf(4, 2, ['.7..', '....']));
    expect(assets.requests.length).toBe(0); // документ, а не ассет
    expect(source.current!.hasCurvature).toBe(true);
    expect(source.current!.heightAt(1.5, 0.5)).toBeGreaterThan(0);
    // Изменилась одна клетка — её и получил подписчик, а не «вся поверхность».
    expect(changes).toEqual([[1]]);

    // Снятие карты возвращает плоские ступени REND-7.
    source.setCurvature(null);
    expect(source.current!.hasCurvature).toBe(false);
    expect(source.current!.heightAt(1.5, 0.5)).toBeCloseTo(0, 6);
  });

  it('карта из памяти главнее догруженного ассета: она и есть текущий документ', () => {
    const { assets, ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid(), { curvatureMapId: 'visuals/curve.json' });
    source.init(ctx);
    source.setCurvature(curvatureOf(4, 2, ['.7..', '....']));

    assets.resolve('terrain-curvature', 'visuals/curve.json', curvatureOf(4, 2, ['...7', '....']));
    // Ассет не перебил правку: поднята клетка кисти, а не клетка ассета.
    expect(source.current!.heightAt(1.5, 0.5)).toBeGreaterThan(0);
    expect(source.current!.heightAt(3.5, 0.5)).toBeCloseTo(0, 6);
  });

  it('несовпадение сетки карты из памяти — предупреждение и игнор (ASSET-7)', () => {
    const { ctx } = makeCtx();
    const warnings: string[] = [];
    const source = new VisualSurfaceSource(flatGrid(), { warn: (m) => warnings.push(m) });
    source.init(ctx);
    source.setCurvature(curvatureOf(3, 3, ['...', '...', '...']));
    expect(warnings.some((w) => /не совпадает с сеткой/.test(w))).toBe(true);
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
    expect(changes).toEqual([[1]]);

    // Сетка, отличающаяся только полом, поверхности не видна — подписчики молчат.
    source.setGrid(raisedGrid(1));
    expect(changes.length).toBe(1);
  });

  it('кривизна пересчитывается по новым уровням: cliff-граница держит её на месте', () => {
    const { ctx } = makeCtx();
    const source = new VisualSurfaceSource(flatGrid());
    source.init(ctx);
    // Кривизна на клетках 1 и 2, пока обе на уровне 0 — усреднение их связывает.
    source.setCurvature(curvatureOf(4, 2, ['.77.', '....']));
    const joined = source.current!.heightAt(2 - 1e-6, 0.5);
    expect(joined).toBeGreaterThan(0);

    // Клетка 1 поднялась: угол на границе усредняется только по своему уровню.
    source.setGrid(raisedGrid(1));
    expect(source.current!.heightAt(2 - 1e-6, 0.5)).toBeGreaterThan(STEP);
    expect(source.current!.heightAt(2 + 1e-6, 0.5)).toBeLessThan(STEP / 2);
  });
});
