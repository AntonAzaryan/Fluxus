/**
 * Туман войны в рендере (задачи 2 и 3, FOW-7, FOW-9, FOW-10): геометрия маски
 * видимости — круг с градиентом края и LoS-обрезкой по cliff-отрезкам, — отбор
 * наблюдателей своей команды из доставленного состояния и подсистема за
 * контрактом REND-8 с пост-проходом и обновлением конфига в рантайме.
 *
 * WebGL здесь нет: пост-проход проверяется записывающим стабом рендерера —
 * подсистема требует от него структурный минимум (`FogRendererLike`).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createTerrainGrid, type TerrainGrid } from '@game-mvp/core';
import type { PresentationFog } from '@game-mvp/assets';
import {
  FogDirtyBlocks,
  FogSubsystem,
  VisibilityMask,
  edgeGradient,
  fogRectOf,
  fogSegmentsOf,
  createCostCounters,
  resolveFogConfig,
  segmentCasts,
  withCostSink,
  DEFAULT_FOG_CONFIG,
  type EntityView,
  type RenderContext,
} from '../src/index.js';
import {
  RendererSpy,
  buildFogMask,
  fakeCanvas,
  type FakeCanvas,
  flatGrid,
  fogCanvasFactory,
  makeEntityView,
  makeRenderContext,
  makeTickView,
} from './fixtures.js';

// ------------------------------------------------------------------- стенд

/** Арена 8×8 по клетке в мировую единицу; одна возвышенная клетка (4, 4). */
function gridWithPillar(): TerrainGrid {
  const levels = Array.from({ length: 8 }, (_, y) => (y === 4 ? '00001000' : '00000000'));
  const flags = Array.from({ length: 8 }, () => '........');
  return createTerrainGrid({ width: 8, height: 8, tileSize: 65536, levels, flags });
}

const STATS = { visionRadius: 'vision', team: 'team' } as const;

function observerView(
  id: number,
  x: number,
  y: number,
  team: number,
  vision: number,
  level = 0,
): EntityView {
  return makeEntityView(id, {
    currX: x,
    currY: y,
    prevX: x,
    prevY: y,
    currLevel: level,
    prevLevel: level,
    stats: new Map([
      [STATS.team, team],
      [STATS.visionRadius, vision],
    ]),
  });
}

// ---------------------------------------------------- 2.1: круг и градиент

describe('FOW-7: reveal-круг с градиентом края', () => {
  it('в круге светло, вне круга — туман', () => {
    const mask = new VisibilityMask(fogRectOf(flatGrid()), 4);
    mask.reveal({ x: 4, y: 4, radius: 3, level: 0 }, 0.5, []);
    expect(mask.valueAt(4, 4)).toBe(1);
    expect(mask.valueAt(4 + 2, 4)).toBeGreaterThan(0);
    // Вне радиуса и вне прямоугольника маски — туман без исключений.
    expect(mask.valueAt(4 + 3.5, 4)).toBe(0);
    expect(mask.valueAt(-1, 4)).toBe(0);
  });

  it('градиент края монотонно спадает с расстоянием и не даёт ступени (FOW-7)', () => {
    const mask = new VisibilityMask(fogRectOf(flatGrid()), 8);
    mask.reveal({ x: 4, y: 4, radius: 3, level: 0 }, 1.5, []);
    let previous = Number.POSITIVE_INFINITY;
    for (let distance = 0; distance <= 3.5; distance += 1 / 8) {
      const value = mask.valueAt(4 + distance, 4);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }
    // Сама функция градиента монотонна и на краю обнуляется.
    expect(edgeGradient(0, 3, 1)).toBe(1);
    expect(edgeGradient(2.5, 3, 1)).toBeGreaterThan(0);
    expect(edgeGradient(2.5, 3, 1)).toBeLessThan(1);
    expect(edgeGradient(3, 3, 1)).toBe(0);
  });

  it('нулевая ширина градиента — резкий край, а не отказ', () => {
    const mask = new VisibilityMask(fogRectOf(flatGrid()), 4);
    mask.reveal({ x: 4, y: 4, radius: 2, level: 0 }, 0, []);
    expect(mask.valueAt(4 + 1.5, 4)).toBe(1);
    expect(mask.valueAt(4 + 2.5, 4)).toBe(0);
  });

  it('два наблюдателя складываются максимумом: пересечение не темнее', () => {
    const mask = new VisibilityMask(fogRectOf(flatGrid()), 4);
    mask.reveal({ x: 3, y: 4, radius: 2, level: 0 }, 0.5, []);
    const single = mask.valueAt(4, 4);
    mask.reveal({ x: 5, y: 4, radius: 2, level: 0 }, 0.5, []);
    expect(mask.valueAt(4, 4)).toBeGreaterThanOrEqual(single);
  });
});

// ------------------------------------------------- 2.2: LoS-обрезка тенями

describe('FOW-9: 2D shadow-casting по cliff-отрезкам', () => {
  it('точка за обрывом в радиусе — под туманом, в обход обрыва — открыта', () => {
    const grid = gridWithPillar();
    const segments = fogSegmentsOf(grid);
    // Возвышенная клетка (4, 4) даёт cliff-отрезки по своему периметру (TERR-5).
    expect(segments.length).toBeGreaterThanOrEqual(4);
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    mask.reveal({ x: 2.5, y: 4.5, radius: 6, level: 0 }, 0.25, segments);
    // Прямо за клеткой — тень, хотя точка в радиусе (FOW-9).
    expect(mask.valueAt(6.5, 4.5)).toBe(0);
    // Луч в обход клетки укрытия не пересекает — точка открыта.
    expect(mask.valueAt(6.5, 6.5)).toBeGreaterThan(0);
    // Перед укрытием света тень не отнимает.
    expect(mask.valueAt(3.5, 4.5)).toBeGreaterThan(0);
  });

  it('наблюдатель ровно на линии блокирующего ребра — тень, а не протечка света (FOW-9)', () => {
    // Вертикальное ребро x = 4, y ∈ [4, 5], нижняя сторона — запад. Наблюдатель
    // стоит на самом отрезке: угловая растеризация вырождается (offset = 0), и
    // без отдельной ветки буфер оставался бы пустым — весь круг светился бы.
    // Симуляция для этой позиции даёт hit на нулевой дистанции — маска обязана
    // отвечать туманом (расхождение приближения — в сторону тумана).
    const segment = { x1: 4, y1: 4, x2: 4, y2: 5, levelNeg: 0, levelPos: 1 };
    const mask = new VisibilityMask({ x: 0, y: 0, width: 8, height: 8 }, 4);
    mask.reveal({ x: 4, y: 4.5, radius: 3, level: 0 }, 0.25, [segment]);
    expect(mask.valueAt(2.5, 4.5)).toBe(0);
    expect(mask.valueAt(5.5, 4.5)).toBe(0);
    expect(mask.valueAt(4.1, 3.1)).toBe(0);
  });

  it('диагональный отрезок укрытия — ошибка вызова, а не молча неверная тень (FOW-9)', () => {
    const mask = new VisibilityMask({ x: 0, y: 0, width: 8, height: 8 }, 4);
    const diagonal = { x1: 0, y1: 0, x2: 5, y2: 5, levelNeg: 0, levelPos: 1 };
    expect(() => {
      mask.reveal({ x: 2, y: 2, radius: 3, level: 0 }, 0.25, [diagonal]);
    }).toThrow(/осевым/);
  });

  it('кромка тени — полутон, а не ступень: радиальный фронт и сторона конуса (FOW-7)', () => {
    const grid = gridWithPillar();
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    mask.reveal({ x: 2.5, y: 4.5, radius: 6, level: 0 }, 0.25, fogSegmentsOf(grid));
    // Полутон делает smooth() — один блюр после всех reveal, как в подсистеме:
    // полярный срез жёсткий и на фронте тени, и на её угловых сторонах.
    mask.smooth();
    const noFullJump = (values: readonly number[]): void => {
      let maxJump = 0;
      for (let i = 1; i < values.length; i++) {
        maxJump = Math.max(maxJump, Math.abs(values[i]! - values[i - 1]!));
      }
      expect(maxJump).toBeLessThan(1);
      // Полутон в полосе существует: между светом и тенью есть промежуточное значение.
      expect(values.some((value) => value > 0 && value < 1)).toBe(true);
    };
    // Радиальный фронт: скан вдоль луча через отбрасывающее тень левое ребро
    // клетки (x = 4) — перед ребром светло, за ним тень, скачка на весь
    // диапазон нет (расхождение приближения — в сторону тумана, FOW-9).
    const radial: number[] = [];
    for (let wx = 3.0625; wx <= 5.0; wx += 0.25) radial.push(mask.valueAt(wx, 4.5));
    expect(radial[0]).toBeGreaterThan(0);
    expect(radial[radial.length - 1]).toBe(0);
    noFullJump(radial);
    // Сторона конуса (силуэт от угла клетки (4, 4)): скан поперёк границы
    // свет/тень на x = 5.625 — ровно та диагональная кромка, где жёсткий
    // полярный срез без блюра давал лесенку.
    const across: number[] = [];
    for (let wy = 3.0625; wy <= 4.0; wy += 0.25) across.push(mask.valueAt(5.625, wy));
    expect(across[0]).toBeGreaterThan(0);
    expect(across[across.length - 1]).toBeLessThan(0.5);
    noFullJump(across);
  });

  it('тени направленные: наблюдатель на плато, нижний уровень за ребром открыт (PHYS-13)', () => {
    const grid = gridWithPillar();
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    // Наблюдатель на возвышенной клетке (4, 4): для всех четырёх её рёбер он
    // на верхней стороне — свои рёбра прозрачны, и пол внизу открыт во все
    // стороны, как и симуляция, которая цель внизу доставляет (FOW-9, FOW-5).
    mask.reveal({ x: 4.5, y: 4.5, radius: 4, level: 1 }, 0.25, fogSegmentsOf(grid));
    expect(mask.valueAt(2.5, 4.5)).toBeGreaterThan(0);
    expect(mask.valueAt(6.5, 4.5)).toBeGreaterThan(0);
    expect(mask.valueAt(4.5, 2.5)).toBeGreaterThan(0);
    expect(mask.valueAt(4.5, 6.5)).toBeGreaterThan(0);
  });

  it('тени направленные: наблюдатель на полу, возвышение за ребром в тени (PHYS-13)', () => {
    const grid = gridWithPillar();
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    mask.reveal({ x: 2.5, y: 4.5, radius: 6, level: 0 }, 0.25, fogSegmentsOf(grid));
    // Верх клетки — за её левым ребром; наблюдатель на нижней стороне, тень
    // остаётся (FOW-9): картинка согласована с фильтром высоты симуляции.
    expect(mask.valueAt(4.5, 4.5)).toBe(0);
  });

  it('свой уровень через низину: плато того же уровня открыто, из низины — в тени (FOW-9)', () => {
    // Плато слева (колонки 0–1) и справа (колонки 6–7), низина посередине.
    const levels = Array.from({ length: 8 }, () => '11000011');
    const flags = Array.from({ length: 8 }, () => '........');
    const grid = createTerrainGrid({ width: 8, height: 8, tileSize: 65536, levels, flags });
    const segments = fogSegmentsOf(grid);
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    // Наблюдатель на левом плато (уровень 1): оба ребра не выше его уровня —
    // открыты и низина, и плато того же уровня за ней (PHYS-13, FOW-5).
    mask.reveal({ x: 1.5, y: 4.5, radius: 7, level: 1 }, 0.25, segments);
    expect(mask.valueAt(4.5, 4.5)).toBeGreaterThan(0);
    expect(mask.valueAt(6.5, 4.5)).toBeGreaterThan(0);
    // Из низины (уровень 0) дальнее плато — за ребром выше уровня: тень.
    const fromDip = new VisibilityMask(fogRectOf(grid), 4);
    fromDip.reveal({ x: 3.5, y: 4.5, radius: 7, level: 0 }, 0.25, segments);
    expect(fromDip.valueAt(6.5, 4.5)).toBe(0);
  });

  it('segmentCasts: тень только от рёбер выше уровня наблюдателя (FOW-9, PHYS-13)', () => {
    const edge = { x1: 4, y1: 4, x2: 4, y2: 5, levelNeg: 0, levelPos: 1 };
    expect(segmentCasts(0, edge)).toBe(true); // наблюдатель ниже верхней стороны — тень
    expect(segmentCasts(1, edge)).toBe(false); // свой уровень — ребро прозрачно
    expect(segmentCasts(2, edge)).toBe(false); // сверху — прозрачно тем более
    // Ребро с равными уровнями сторон выше наблюдателя — тень; на его уровне — нет.
    const wall = { x1: 4, y1: 4, x2: 4, y2: 5, levelNeg: 2, levelPos: 2 };
    expect(segmentCasts(1, wall)).toBe(true);
    expect(segmentCasts(2, wall)).toBe(false);
  });
});

// ------------------- задача 1.3: двойной буфер и порционные проходы растра

describe('порционная перестройка растра маски (design D1, D2)', () => {
  const OBSERVERS = [
    { x: 2.5, y: 4.5, radius: 6, level: 0 },
    { x: 6.5, y: 6.5, radius: 3, level: 0 },
  ];
  const EDGE = 0.25;

  /** Синхронная перестройка — эталон, с которым сверяется порционная. */
  function synchronous(grid: TerrainGrid): VisibilityMask {
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    const segments = fogSegmentsOf(grid);
    mask.clear();
    for (const observer of OBSERVERS) mask.reveal(observer, EDGE, segments);
    mask.smooth();
    return mask;
  }

  /** Та же перестройка порциями по `rows` строк — фазы в порядке design D1. */
  function chunked(grid: TerrainGrid, rows: number): VisibilityMask {
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    const segments = fogSegmentsOf(grid);
    mask.beginBuild();
    for (let y = 0; y < mask.height; y += rows) {
      mask.clearRows(y, Math.min(y + rows, mask.height) - 1);
    }
    for (const observer of OBSERVERS) {
      mask.prepareReveal(observer, EDGE, segments);
      for (let y = mask.revealFirstRow; y <= mask.revealLastRow; y += rows) {
        mask.revealRows(y, Math.min(y + rows - 1, mask.revealLastRow));
      }
    }
    for (const pass of ['horizontal', 'vertical'] as const) {
      for (let y = 0; y < mask.height; y += rows) {
        mask.smoothRows(pass, y, Math.min(y + rows, mask.height) - 1);
      }
    }
    return mask;
  }

  it('порционная сборка побитово равна синхронной при любой нарезке', () => {
    const grid = gridWithPillar();
    const reference = synchronous(grid);
    expect(reference.data.some((value) => value > 0)).toBe(true);
    for (const rows of [1, 3, 7, 32]) {
      const built = chunked(grid, rows);
      // До публикации передний растр пуст — сборка шла в задний.
      expect(built.data.every((value) => value === 0)).toBe(true);
      built.commit(null);
      expect(built.data, `нарезка по ${rows} строк`).toEqual(reference.data);
    }
  });

  it('commit атомарен: до него потребители видят прежний растр целиком', () => {
    const grid = gridWithPillar();
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    const segments = fogSegmentsOf(grid);
    // Первая публикация: единственный наблюдатель у левого края.
    mask.beginBuild();
    mask.clearRows(0, mask.height - 1);
    mask.prepareReveal(OBSERVERS[0]!, EDGE, segments);
    mask.revealRows(mask.revealFirstRow, mask.revealLastRow);
    mask.smoothRows('horizontal', 0, mask.height - 1);
    mask.smoothRows('vertical', 0, mask.height - 1);
    mask.commit(null);
    const published = Uint8Array.from(mask.data);
    expect(mask.valueAt(2.5, 4.5)).toBe(1);

    // Вторая перестройка, растянутая на порции: каждый шаг сверяется с
    // опубликованным растром — полупостроенного состояния не наблюдает никто.
    mask.beginBuild();
    for (let y = 0; y < mask.height; y++) {
      mask.clearRows(y, y);
      expect(mask.data).toEqual(published);
    }
    mask.prepareReveal(OBSERVERS[1]!, EDGE, segments);
    for (let y = mask.revealFirstRow; y <= mask.revealLastRow; y++) {
      mask.revealRows(y, y);
      expect(mask.data).toEqual(published);
    }
    mask.smoothRows('horizontal', 0, mask.height - 1);
    mask.smoothRows('vertical', 0, mask.height - 1);
    expect(mask.data).toEqual(published);

    mask.commit(null);
    // И только своп ссылок сменил картинку — разом и целиком.
    expect(mask.data).not.toEqual(published);
    expect(mask.valueAt(6.5, 6.5)).toBe(1);
    expect(mask.valueAt(2.5, 4.5)).toBe(0);
  });

  it('грязное окно на commit — блоки, где растр действительно изменился (design D5)', () => {
    const grid = flatGrid(16);
    const mask = new VisibilityMask(fogRectOf(grid), 4); // 64×64 текселя, 4×4 блока
    const dirty = new FogDirtyBlocks(mask.width, mask.height);
    expect(dirty.cols).toBe(4);
    expect(dirty.rows).toBe(4);

    // Первая публикация: свет в левом нижнем углу арены.
    mask.beginBuild();
    mask.clearRows(0, mask.height - 1);
    mask.prepareReveal({ x: 2, y: 2, radius: 2, level: 0 }, 0.25, []);
    mask.revealRows(mask.revealFirstRow, mask.revealLastRow);
    const compared = mask.commit(dirty);
    // Сравнение прошло по всему растру, а в набор попал только тронутый угол.
    expect(compared).toBeGreaterThan(0);
    expect(dirty.count).toBeGreaterThan(0);
    expect(dirty.count).toBeLessThan(dirty.cols * dirty.rows);
    expect(dirty.isDirty(0, 0)).toBe(true);
    expect(dirty.isDirty(3, 3)).toBe(false);

    // Устоявшиеся блоки снимаются с набора, а блок ПРЕРВАННОГО рассеивания
    // остаётся в нём и после следующей публикации (объединение, design D5).
    for (let row = 0; row < dirty.rows; row++) {
      for (let column = 0; column < dirty.cols; column++) {
        if (column !== 0 || row !== 0) continue;
        dirty.settle(column, row);
      }
    }
    const stillDirty = dirty.count - 1;
    dirty.flushSettled();
    expect(dirty.count).toBe(stillDirty);
    expect(dirty.isDirty(0, 0)).toBe(false);

    mask.beginBuild();
    mask.clearRows(0, mask.height - 1);
    mask.prepareReveal({ x: 14, y: 14, radius: 2, level: 0 }, 0.25, []);
    mask.revealRows(mask.revealFirstRow, mask.revealLastRow);
    mask.commit(dirty);
    // Угол, который погас, и угол, который зажёгся, — оба в окне.
    expect(dirty.isDirty(0, 0)).toBe(true);
    expect(dirty.isDirty(3, 3)).toBe(true);
  });
});

// ------------------------------ 2.3 и 3: подсистема, наблюдатели и конфиг

describe('FOW-7, FOW-9: отбор наблюдателей из доставленного состояния (design D4)', () => {
  function subsystemWith(entities: EntityView[]): FogSubsystem {
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      createCanvas: fogCanvasFactory(),
    });
    fog.init(makeRenderContext());
    fog.syncTick(makeTickView(entities));
    // Растр строит КАДР порциями, а не доставка (change
    // `fog-mask-budgeted-rebuild`, design D1): геометрию смотрим на
    // опубликованной маске.
    buildFogMask(fog);
    return fog;
  }

  it('наблюдатель своей команды открывает маску, круг видимого врага — нет', () => {
    const fog = subsystemWith([
      observerView(1, 2.5, 2.5, 0, 3),
      // Видимый враг: доставлен со своими статами Vision — маску игрока его
      // круг открывать не должен (design D4).
      observerView(2, 6, 6, 1, 3),
    ]);
    expect(fog.visibility.valueAt(2.5, 2.5)).toBe(1);
    expect(fog.visibility.valueAt(6, 6)).toBe(0);
  });

  it('союзник той же команды открывает свой круг наравне с героем', () => {
    const fog = subsystemWith([
      observerView(1, 2, 2, 0, 2),
      observerView(3, 6, 6, 0, 2),
    ]);
    // Полутон smooth() стоит ≤ пары градаций у кромок — «открыт» с допуском.
    expect(fog.visibility.valueAt(6, 6)).toBeGreaterThan(0.98);
  });

  it('радиус reveal консервативнее доставленного: коэффициент из конфига (FOW-9)', () => {
    const fog = subsystemWith([observerView(1, 4, 4, 0, 3)]);
    const conservatism = DEFAULT_FOG_CONFIG.conservatism;
    // Точка между визуальным (3 × коэффициент) и симуляционным (3) радиусом —
    // уже туман: визуал консервативнее геймплея (FOW-9).
    const between = 3 * (conservatism + 1) * 0.5;
    expect(between).toBeLessThan(3);
    // Блюр smooth() переносит ≤ полтекселя света за геометрию — «туман» с
    // допуском пары градаций; запас консервативности его перекрывает (FOW-9).
    expect(fog.visibility.valueAt(4 + between, 4)).toBeLessThan(0.05);
    // Внутри визуального радиуса свет есть.
    expect(fog.visibility.valueAt(4 + 3 * conservatism - 0.5, 4)).toBeGreaterThan(0);
  });

  it('пока статы героя не доставлены, маска не строится и конвейер прежний', () => {
    const fog = new FogSubsystem({ grid: flatGrid(), stats: STATS, hero: () => null });
    const ctx = makeRenderContext();
    fog.init(ctx);
    fog.syncTick(makeTickView([observerView(2, 1, 1, 0, 3)]));
    const renderer = new RendererSpy();
    fog.render(renderer, new THREE.PerspectiveCamera());
    // Ровно прямой рендер: ни render target, ни второго прохода (design D2).
    expect(renderer.rendered).toEqual([ctx.scene]);
    expect(renderer.targets).toEqual([]);
  });
});

describe('FOW-7: рассеивание тумана не мгновенное', () => {
  function dissolvingSubsystem(config?: PresentationFog): FogSubsystem {
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      ...(config === undefined ? {} : { config }),
      createCanvas: fogCanvasFactory(),
    });
    fog.init(makeRenderContext());
    return fog;
  }

  it('открытие зоны — сходимость по времени рассеивания, а не скачок', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 1 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    buildFogMask(fog);
    // Целевая маска уже открыта, показанная — ещё туман: рассеивание идёт кадрами.
    expect(fog.visibility.valueAt(4, 4)).toBe(1);
    expect(fog.shownAt(4, 4)).toBe(0);
    fog.updateFrame(0.25, 0);
    const partial = fog.shownAt(4, 4);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    fog.updateFrame(2, 0);
    expect(fog.shownAt(4, 4)).toBe(1);
  });

  it('закрытие зоны симметрично: свет гаснет постепенно', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 1 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    buildFogMask(fog);
    fog.updateFrame(2, 0);
    expect(fog.shownAt(4, 4)).toBe(1);
    // Наблюдатель ушёл: целевая маска в точке погасла, показанная — гаснет.
    fog.syncTick(makeTickView([observerView(1, 20, 20, 0, 3)]));
    buildFogMask(fog);
    expect(fog.visibility.valueAt(4, 4)).toBe(0);
    fog.updateFrame(0.25, 0);
    const fading = fog.shownAt(4, 4);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    fog.updateFrame(2, 0);
    expect(fog.shownAt(4, 4)).toBe(0);
  });

  it('замороженный мир не рассеивает туман: dt со знаком хода мира (REND-25)', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 1 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    // Кадры с нулевым `dt` перестройку доводят до публикации — она про
    // доставку, а не про ход мира, — а рассеивание не двигают ни на градацию.
    buildFogMask(fog);
    fog.updateFrame(0, 0);
    expect(fog.shownAt(4, 4)).toBe(0);
  });

  it('разрыв непрерывности мира — снап показанной маски в самой доставке (REND-2)', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 1 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)], { snapAll: true }));
    // Ни порций, ни рассеивания: перемотка публикует маску синхронно.
    expect(fog.rebuilds).toBe(1);
    expect(fog.rebuilding).toBe(false);
    expect(fog.shownAt(4, 4)).toBe(1);
  });

  it('нулевое время рассеивания — мгновенно, как раньше (FOW-10)', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 0 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    // «Мгновенно» — про рассеивание, а не про доставку: показанная маска
    // становится целевой прямо на публикации, без единого кадра сходимости.
    buildFogMask(fog);
    expect(fog.shownAt(4, 4)).toBe(1);
  });
});

describe('FOW-7, FOW-10: пост-проход и обновление конфига в рантайме', () => {
  function activeSubsystem(): { fog: FogSubsystem; ctx: RenderContext } {
    const ctx = makeRenderContext();
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      createCanvas: fogCanvasFactory(),
    });
    fog.init(ctx);
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    buildFogMask(fog);
    return { fog, ctx };
  }

  it('с активным туманом кадр идёт в render target, затем полноэкранный проход', () => {
    const { fog, ctx } = activeSubsystem();
    const renderer = new RendererSpy();
    fog.render(renderer, new THREE.PerspectiveCamera());
    // Сцена — в target, пост-сцена — на экран (design D2).
    expect(renderer.rendered).toHaveLength(2);
    expect(renderer.rendered[0]).toBe(ctx.scene);
    expect(renderer.rendered[1]).not.toBe(ctx.scene);
    expect(renderer.targets).toHaveLength(2);
    expect(renderer.targets[0]).toBeInstanceOf(THREE.WebGLRenderTarget);
    expect(renderer.targets[0]?.depthTexture).toBeInstanceOf(THREE.DepthTexture);
    expect(renderer.targets[1]).toBeNull();
  });

  it('смена силы затемнения применяется без пересоздания подсистемы (FOW-10)', () => {
    const { fog } = activeSubsystem();
    const maskBefore = fog.visibility;
    const layerBefore = fog.fog;
    expect(fog.config.strength).toBe(DEFAULT_FOG_CONFIG.strength);

    fog.applyConfig({ strength: 0.9 });

    // Тот же объект подсистемы, тот же растр маски, тот же объект слоя — а
    // сила уже новая, и стабильный слой миникарты видит её геттером (design D6).
    expect(fog.config.strength).toBe(0.9);
    expect(fog.visibility).toBe(maskBefore);
    expect(fog.fog).toBe(layerBefore);
    expect(fog.fog?.strength).toBe(0.9);
  });

  it('смена разрешения пересобирает только растр маски (FOW-10)', () => {
    const { fog } = activeSubsystem();
    const maskBefore = fog.visibility;

    fog.applyConfig({ resolution: 8 });

    expect(fog.visibility).not.toBe(maskBefore);
    expect(fog.visibility.texelsPerUnit).toBe(8);
    // До ближайшей перестройки маска нового разрешения не построена — конвейер
    // прежний, а после доставки и её кадров туман возвращается.
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    buildFogMask(fog);
    expect(fog.visibility.valueAt(4, 4)).toBe(1);
  });

  it('слой миникарты — стабильный объект «канвас + прямоугольник мира» (design D6)', () => {
    const { fog } = activeSubsystem();
    const layer = fog.fog;
    expect(layer).not.toBeNull();
    expect(layer?.world).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    fog.syncTick(makeTickView([observerView(1, 2, 2, 0, 3)]));
    buildFogMask(fog);
    expect(fog.fog).toBe(layer);
  });

  it('умолчания документированы и действуют без секции fog (FOW-10)', () => {
    expect(resolveFogConfig(undefined)).toEqual(DEFAULT_FOG_CONFIG);
    expect(resolveFogConfig({ strength: 0.3 }).strength).toBe(0.3);
    expect(resolveFogConfig({ strength: 0.3 }).edgeWidth).toBe(DEFAULT_FOG_CONFIG.edgeWidth);
  });
});

// ------------------------- 4.3: перестройка только при изменении входов (D4)

/**
 * Стенд кэша сигнатуры и коалесинга: подсистема с записывающими канвасами и
 * управляемым бюджетом порции. `rebuilds` здесь — число ОПУБЛИКОВАННЫХ
 * перестроек: доставка сама по себе растра не строит (design D1, D3).
 */
function cachedSubsystem(budget?: number): {
  fog: FogSubsystem;
  canvases: FakeCanvas[];
} {
  const canvases: FakeCanvas[] = [];
  const fog = new FogSubsystem({
    grid: gridWithPillar(),
    stats: STATS,
    hero: () => 1,
    ...(budget === undefined ? {} : { rebuildBudget: budget }),
    createCanvas: (width, height) => {
      const canvas = fakeCanvas();
      canvas.width = width;
      canvas.height = height;
      canvases.push(canvas);
      return canvas;
    },
  });
  fog.init(makeRenderContext());
  return { fog, canvases };
}

describe('design D4: сигнатура входов — перестройка маски только при изменении', () => {
  it('неизменные входы — ни перестройки маски, ни блита слоя миникарты', () => {
    const { fog, canvases } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(1);
    // Рассеивание доигрывается одним большим шагом: дальше сцена устоялась.
    fog.updateFrame(10, 0);
    const puts = canvases[0]!.puts;

    // Та же доставка: позиции, радиусы и уровни наблюдателей не изменились —
    // стоя на месте, ни доставка, ни кадр за туман не платят (design D4).
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilds).toBe(1);
    expect(fog.rebuilding).toBe(false);
    expect(canvases[0]!.puts).toBe(puts);
  });

  it('смена позиции, уровня или конфига инвалидирует сигнатуру', () => {
    const { fog } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(1);

    // Сдвиг наблюдателя.
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3)]));
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(2);

    // Только уровень (та же позиция): слот сигнатуры — доставленный currLevel.
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3, 1)]));
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(3);

    // Значение конфига, влияющее на растр (FOW-10): ширина градиента.
    fog.applyConfig({ edgeWidth: 2.5 });
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3, 1)]));
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(4);

    // После перестройки кэш снова держит.
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3, 1)]));
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilds).toBe(4);
  });

  it('второй наблюдатель в доставке — другие входы, перестройка', () => {
    const { fog } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    buildFogMask(fog);
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3), observerView(3, 6, 6, 0, 2)]));
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(2);
  });
});

// ------------- задача 2.4: бюджетная перестройка, коалесинг и атомарность

describe('бюджетная перестройка маски и коалесинг доставок (design D1–D3)', () => {
  /**
   * Бюджет в половину площади маски стенда (32×32): полная перестройка стоит
   * около пяти площадей и гарантированно не влезает в один кадр — порции
   * растягиваются на десяток.
   */
  const SLOW = 512;

  it('доставка растра не трогает: его строят порции кадра', () => {
    const { fog, canvases } = cachedSubsystem(SLOW);
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));

    // Ни перестройки, ни слоя миникарты: доставка только положила вход.
    expect(fog.rebuilds).toBe(0);
    expect(fog.rebuilding).toBe(false);
    expect(canvases).toHaveLength(0);
    // Маска не построена — конвейер кадра прежний, прямой рендер (FOW-7).
    const renderer = new RendererSpy();
    fog.render(renderer, new THREE.PerspectiveCamera());
    expect(renderer.targets).toEqual([]);

    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilding).toBe(true);
    expect(fog.rebuilds).toBe(0);
  });

  it('две доставки в полёте — одна перестройка от последней, промежуточная не строится', () => {
    const { fog } = cachedSubsystem(SLOW);
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    fog.updateFrame(1 / 60, 0); // перестройка началась и в кадр не влезла

    // Две доставки поверх полётной: конфляция «важен только последний вход».
    fog.syncTick(makeTickView([observerView(1, 3.5, 4.5, 0, 3)]));
    fog.syncTick(makeTickView([observerView(1, 6.5, 6.5, 0, 3)]));

    // Первая перестройка ДОСТРАИВАЕТСЯ — рестарта нет, иначе при доставках
    // чаще перестройки маска не продвигалась бы никогда (design D3).
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(1);
    expect(fog.visibility.valueAt(2.5, 4.5)).toBe(1);
    expect(fog.visibility.valueAt(6.5, 6.5)).toBe(0);

    // Следом идёт ОДНА перестройка — от последней доставки; промежуточная
    // (3.5, 4.5) не строится вовсе.
    buildFogMask(fog);
    expect(fog.rebuilds).toBe(2);
    expect(fog.visibility.valueAt(6.5, 6.5)).toBe(1);
    expect(fog.visibility.valueAt(2.5, 4.5)).toBe(0);
    // И третьей перестройки нет: отложенных входов не осталось.
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilds).toBe(2);
    expect(fog.rebuilding).toBe(false);
  });

  it('маска продвигается, даже когда доставка приходит каждый кадр', () => {
    const { fog } = cachedSubsystem(SLOW);
    for (let frame = 0; frame < 200; frame++) {
      // Наблюдатель ползёт: каждая доставка несёт новые входы.
      fog.syncTick(makeTickView([observerView(1, 2.5 + frame * 0.01, 4.5, 0, 3)]));
      fog.updateFrame(1 / 60, 0);
    }
    // Перестройки публикуются, а не начинаются заново вечно (design D3).
    expect(fog.rebuilds).toBeGreaterThan(0);
  });

  it('полурастра не видит никто: каждый кадр маска целиком построена', () => {
    const { fog } = cachedSubsystem(SLOW);
    // Первая перестройка — публикуется целиком, до неё маска пуста.
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    const frames = buildFogMask(fog);
    expect(frames).toBeGreaterThan(1);
    const published = Uint8Array.from(fog.visibility.data);
    expect(published.some((value) => value > 0)).toBe(true);

    // Вторая перестройка с ДРУГИМИ входами: пока она идёт, потребители читают
    // прежний растр — ни наполовину очищенного, ни наполовину открытого
    // состояния не бывает.
    fog.syncTick(makeTickView([observerView(1, 6.5, 6.5, 0, 3)]));
    for (let frame = 0; frame < 200; frame++) {
      fog.updateFrame(1 / 60, 0);
      if (fog.rebuilds === 2) break;
      expect(fog.visibility.data).toEqual(published);
    }
    expect(fog.rebuilds).toBe(2);
    expect(fog.visibility.data).not.toEqual(published);
  });

  it('перемотка бросает перестройку в полёте и публикует маску синхронно (REND-2)', () => {
    const { fog } = cachedSubsystem(SLOW);
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilding).toBe(true);

    fog.syncTick(makeTickView([observerView(1, 6.5, 6.5, 0, 3)], { snapAll: true }));

    // Снап опубликовал маску телепорта прямо в доставке, а брошенная
    // перестройка прежнего мира не достраивается и не публикуется следом.
    expect(fog.rebuilds).toBe(1);
    expect(fog.rebuilding).toBe(false);
    expect(fog.shownAt(6.5, 6.5)).toBe(1);
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilds).toBe(1);
  });

  it('смена разрешения в полёте бросает порции: достраивать некуда', () => {
    const { fog } = cachedSubsystem(SLOW);
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilding).toBe(true);

    fog.applyConfig({ resolution: 8 });
    expect(fog.rebuilding).toBe(false);
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilds).toBe(0);

    // Растр нового разрешения строится ближайшей доставкой и её кадрами.
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    buildFogMask(fog);
    expect(fog.visibility.texelsPerUnit).toBe(8);
    expect(fog.visibility.valueAt(2.5, 4.5)).toBe(1);
  });

  it('окно рассеивания сжимается по мере схождения, а устоявшаяся сцена платит ноль', () => {
    const { fog, canvases } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 4.5, 4.5, 0, 3)]));
    buildFogMask(fog);

    // Кадры рассеивания идут по грязным блокам (design D5): работа убывает по
    // мере схождения и обнуляется, когда показанная маска догнала целевую.
    const visited: number[] = [];
    for (let frame = 0; frame < 64; frame++) {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        fog.updateFrame(1 / 60, 0);
      });
      visited.push(counters.fogDissolveTexels);
      if (counters.fogDissolveTexels === 0) break;
    }
    expect(visited.length).toBeGreaterThan(2);
    expect(visited[0]).toBeGreaterThan(0);
    expect(visited[visited.length - 1]).toBe(0);
    // Ни один кадр не дороже предыдущего: окно только сжимается.
    for (let i = 1; i < visited.length; i++) {
      expect(visited[i]).toBeLessThanOrEqual(visited[i - 1]!);
    }

    // Устоявшаяся сцена: ни прохода, ни загрузки текстуры, ни блита миникарты.
    const puts = canvases[0]!.puts;
    const idle = createCostCounters();
    withCostSink(idle, () => {
      fog.updateFrame(1 / 60, 0);
    });
    expect(idle.fogDissolveTexels).toBe(0);
    expect(idle.fogMaskUploadBytes).toBe(0);
    expect(idle.fogMinimapTexels).toBe(0);
    expect(canvases[0]!.puts).toBe(puts);
  });

  it('блит идёт грязным прямоугольником, и ряды в нём перевёрнуты (design D5)', () => {
    // Арена 16×16 при разрешении 4 — маска 64×64 текселя, то есть 4×4 блока по
    // 16: прямоугольник окна тогда читается блоками, а не «примерно там».
    const corner = (x: number, y: number): FakeCanvas => {
      const canvases: FakeCanvas[] = [];
      const fog = new FogSubsystem({
        grid: flatGrid(16),
        stats: STATS,
        hero: () => 1,
        createCanvas: (width, height) => {
          const canvas = fakeCanvas();
          canvas.width = width;
          canvas.height = height;
          canvases.push(canvas);
          return canvas;
        },
      });
      fog.init(makeRenderContext());
      fog.syncTick(makeTickView([observerView(1, x, y, 0, 1.5)]));
      buildFogMask(fog);
      fog.updateFrame(1 / 60, 0);
      return canvases[0]!;
    };

    // Наблюдатель у начала мира: его свет лежит в НИЖНИХ рядах растра (ряд 0 —
    // минимальный `y` мира), а миникарта рисует мир `+Y` вверх — значит в
    // канвасе это НИЖНЯЯ полоса.
    const low = corner(2, 2);
    // Первый блит — полный (два аргумента), дальше идут кадры рассеивания с
    // грязным прямоугольником (шесть).
    expect(low.putRects[0]).toEqual([0, 0]);
    const lowRect = low.putRects[low.putRects.length - 1]!;
    expect(lowRect).toHaveLength(6);
    expect(lowRect.slice(0, 2)).toEqual([0, 0]);
    const [, , lowX, lowY, lowWidth, lowHeight] = lowRect as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    // Границы блочные, и полоса прижата к НИЗУ канваса.
    expect(lowX % 16).toBe(0);
    expect(lowWidth % 16).toBe(0);
    expect(lowY + lowHeight).toBe(64);
    expect(lowX).toBe(0);

    // Зеркальный наблюдатель у дальнего угла: та же полоса, но у ВЕРХА канваса.
    const high = corner(14, 14);
    const highRect = high.putRects[high.putRects.length - 1]!;
    expect(highRect).toHaveLength(6);
    const [, , highX, highY, , highHeight] = highRect as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(highY).toBe(0);
    expect(highHeight).toBe(lowHeight);
    expect(highX).toBe(64 - lowWidth);
  });

  it('блит считается прямоугольником, а не суммой блоков окна (PERF-3)', () => {
    // Арена 16×16 при разрешении 4 — маска 64×64 текселя, 4×4 блока по 16.
    const fog = new FogSubsystem({
      grid: flatGrid(16),
      stats: STATS,
      hero: () => 1,
      createCanvas: fogCanvasFactory(),
    });
    fog.init(makeRenderContext());
    // Двое наблюдателей: герой в углу (2, 2) и союзник в дальнем углу (14, 14).
    fog.syncTick(
      makeTickView([observerView(1, 2, 2, 0, 1.5), observerView(3, 14, 14, 0, 1.5)]),
    );
    buildFogMask(fog);
    fog.updateFrame(10, 0); // рассеивание доиграно, окно пусто

    // Союзник переезжает в (14, 2): гаснет верхний блок столбца и зажигается
    // нижний, а между ними — устоявшаяся полоса, которая в окно не входит.
    fog.syncTick(
      makeTickView([observerView(1, 2, 2, 0, 1.5), observerView(3, 14, 2, 0, 1.5)]),
    );
    buildFogMask(fog);

    const frame = createCostCounters();
    withCostSink(frame, () => {
      fog.updateFrame(1 / 60, 0);
    });
    // Проход схождения идёт по грязным блокам — их два, по 16×16 текселей…
    expect(frame.fogDissolveTexels).toBe(2 * 16 * 16);
    // …а в канвас уезжает их ОБЩИЙ прямоугольник: столбец блоков во всю высоту
    // маски. Считать сумму блоков значило бы занижать работу главного потока
    // ровно там, где окно разрежено (кольцо рассеивания вокруг наблюдателя).
    expect(frame.fogMinimapTexels).toBe(16 * 64);
    expect(frame.fogMinimapTexels).toBeGreaterThan(frame.fogDissolveTexels);
  });

  it('блит миникарты идёт каденсом, финальный доводит канвас до целевой (design D5)', () => {
    const canvases: FakeCanvas[] = [];
    const fog = new FogSubsystem({
      grid: flatGrid(16),
      stats: STATS,
      hero: () => 1,
      config: { dissolveSeconds: 0.4 },
      createCanvas: (width, height) => {
        const canvas = fakeCanvas();
        canvas.width = width;
        canvas.height = height;
        canvases.push(canvas);
        return canvas;
      },
    });
    fog.init(makeRenderContext());
    fog.syncTick(makeTickView([observerView(1, 8, 8, 0, 3)]));
    buildFogMask(fog);
    const canvas = canvases[0]!;

    // Свежее окно рассеивания блитует первым же кадром, не дожидаясь каденса.
    const dt = 1 / 240;
    fog.updateFrame(dt, 0);
    const opened = canvas.puts;
    expect(opened).toBeGreaterThan(1); // полный блит публикации + оконный

    // Дальше кадры копят окно: до шага каденса (1/30 с — восемь кадров по
    // 1/240) канвас не трогается, показанная маска при этом движется покадрово.
    const shownBefore = fog.shownAt(8, 8);
    for (let frame = 0; frame < 7; frame++) fog.updateFrame(dt, 0);
    expect(canvas.puts).toBe(opened);
    expect(fog.shownAt(8, 8)).toBeGreaterThan(shownBefore);
    // Восьмой кадр набирает каденс — блит одного накопленного прямоугольника.
    fog.updateFrame(dt, 0);
    expect(canvas.puts).toBe(opened + 1);

    // Рассеивание доигрывается: блитов сильно меньше, чем кадров, а финальный
    // блит по схождении обязателен — канвас показывает целевую маску.
    let frames = 0;
    const putsBefore = canvas.puts;
    while (frames < 400) {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        fog.updateFrame(dt, 0);
      });
      frames++;
      if (counters.fogDissolveTexels === 0) break;
    }
    expect(frames).toBeGreaterThan(30);
    expect(canvas.puts - putsBefore).toBeLessThan(frames / 4);
    // Центр обзора полностью открыт и в канвасе: альфа тумана там нулевая.
    const image = canvas.image!;
    const tx = Math.floor(8 * 4);
    const ty = Math.floor(8 * 4);
    const alpha = image.data[((image.height - 1 - ty) * image.width + tx) * 4 + 3]!;
    expect(fog.shownAt(8, 8)).toBe(1);
    expect(alpha).toBe(0);
  });

  it('смена тона перекрашивает слой миникарты событием правки (FOW-10, HUD-6)', () => {
    const { fog, canvases } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    buildFogMask(fog);
    fog.updateFrame(10, 0); // рассеивание доиграно, окно пусто
    const canvas = canvases[0]!;
    const puts = canvas.puts;
    const red = (): number => canvas.image!.data[0]!;
    expect(red()).toBe(0x0e); // умолчание `#0e1420`

    fog.applyConfig({ color: '#ff0000' });

    // Тон в растр не входит, и перестройка вернула бы байт в байт тот же растр
    // с пустым окном рассеивания: слой обязан перекраситься СОБЫТИЕМ правки,
    // иначе миникарта осталась бы прежнего тона навсегда.
    expect(canvas.puts).toBe(puts + 1);
    expect(red()).toBe(0xff);
    expect(fog.config.color).toBe('#ff0000');
    // Перестройки при этом не заводится: сигнатура входов растра не изменилась.
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    fog.updateFrame(1 / 60, 0);
    expect(fog.rebuilds).toBe(1);
  });

  it('прерванное рассеивание доигрывается: неустоявшийся блок остаётся в окне', () => {
    const { fog } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    buildFogMask(fog);
    fog.updateFrame(1 / 60, 0); // рассеивание началось и не сошлось
    const midway = fog.shownAt(2.5, 4.5);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);

    // Новая доставка публикует другую маску ПОСРЕДИ рассеивания: блоки, не
    // достигшие прежней цели, остаются в окне (объединение, design D5), и
    // сходимость доигрывается — до конца и без застрявших текселей.
    fog.syncTick(makeTickView([observerView(1, 6.5, 6.5, 0, 3)]));
    buildFogMask(fog);
    for (let frame = 0; frame < 64; frame++) fog.updateFrame(1 / 60, 0);
    expect(fog.shownAt(6.5, 6.5)).toBe(1);
    expect(fog.shownAt(2.5, 4.5)).toBe(0);
  });

  it('порционная сборка побитово равна синхронной на тех же входах', () => {
    // Один и тот же вход двумя путями: бюджетным (порции по строкам) и
    // синхронным (снап). Растры обязаны совпасть байт в байт — иначе картинка
    // зависела бы от того, как её нарезали (design D1).
    const budgeted = cachedSubsystem(SLOW).fog;
    budgeted.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3), observerView(3, 6, 6, 0, 2)]));
    expect(buildFogMask(budgeted)).toBeGreaterThan(1);

    const snapped = cachedSubsystem().fog;
    snapped.syncTick(
      makeTickView([observerView(1, 2.5, 4.5, 0, 3), observerView(3, 6, 6, 0, 2)], {
        snapAll: true,
      }),
    );

    expect(budgeted.visibility.data).toEqual(snapped.visibility.data);
  });
});
