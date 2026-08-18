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
  FogSubsystem,
  VisibilityMask,
  edgeGradient,
  fogRectOf,
  fogSegmentsOf,
  resolveFogConfig,
  segmentCasts,
  DEFAULT_FOG_CONFIG,
  type EntityView,
  type FogLayerCanvas,
  type RenderContext,
} from '../src/index.js';
import {
  RendererSpy,
  fakeCanvas,
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
    fog.updateFrame(2, 0);
    expect(fog.shownAt(4, 4)).toBe(1);
    // Наблюдатель ушёл: целевая маска в точке погасла, показанная — гаснет.
    fog.syncTick(makeTickView([observerView(1, 20, 20, 0, 3)]));
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
    fog.updateFrame(0, 0);
    expect(fog.shownAt(4, 4)).toBe(0);
  });

  it('разрыв непрерывности мира — снап показанной маски (REND-2)', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 1 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)], { snapAll: true }));
    expect(fog.shownAt(4, 4)).toBe(1);
  });

  it('нулевое время рассеивания — мгновенно, как раньше (FOW-10)', () => {
    const fog = dissolvingSubsystem({ dissolveSeconds: 0 });
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
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
    // До ближайшей доставки маска нового разрешения не построена — конвейер
    // прежний, а после доставки туман возвращается.
    fog.syncTick(makeTickView([observerView(1, 4, 4, 0, 3)]));
    expect(fog.visibility.valueAt(4, 4)).toBe(1);
  });

  it('слой миникарты — стабильный объект «канвас + прямоугольник мира» (design D6)', () => {
    const { fog } = activeSubsystem();
    const layer = fog.fog;
    expect(layer).not.toBeNull();
    expect(layer?.world).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    fog.syncTick(makeTickView([observerView(1, 2, 2, 0, 3)]));
    expect(fog.fog).toBe(layer);
  });

  it('умолчания документированы и действуют без секции fog (FOW-10)', () => {
    expect(resolveFogConfig(undefined)).toEqual(DEFAULT_FOG_CONFIG);
    expect(resolveFogConfig({ strength: 0.3 }).strength).toBe(0.3);
    expect(resolveFogConfig({ strength: 0.3 }).edgeWidth).toBe(DEFAULT_FOG_CONFIG.edgeWidth);
  });
});

// ------------------------- 4.3: перестройка только при изменении входов (D4)

describe('design D4: сигнатура входов — перестройка маски только при изменении', () => {
  function cachedSubsystem(): { fog: FogSubsystem; canvases: (FogLayerCanvas & { puts: number })[] } {
    const canvases: (FogLayerCanvas & { puts: number })[] = [];
    const fog = new FogSubsystem({
      grid: gridWithPillar(),
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
    return { fog, canvases };
  }

  it('неизменные входы — ни перестройки маски, ни блита слоя миникарты', () => {
    const { fog, canvases } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    expect(fog.rebuilds).toBe(1);
    const puts = canvases[0]!.puts;

    // Та же доставка: позиции, радиусы и уровни наблюдателей не изменились —
    // стоя на месте, кадр не платит за туман ничего (design D4).
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    expect(fog.rebuilds).toBe(1);
    expect(canvases[0]!.puts).toBe(puts);
  });

  it('смена позиции, уровня или конфига инвалидирует сигнатуру', () => {
    const { fog } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    expect(fog.rebuilds).toBe(1);

    // Сдвиг наблюдателя.
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3)]));
    expect(fog.rebuilds).toBe(2);

    // Только уровень (та же позиция): слот сигнатуры — доставленный currLevel.
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3, 1)]));
    expect(fog.rebuilds).toBe(3);

    // Значение конфига, влияющее на растр (FOW-10): ширина градиента.
    fog.applyConfig({ edgeWidth: 2.5 });
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3, 1)]));
    expect(fog.rebuilds).toBe(4);

    // После перестройки кэш снова держит.
    fog.syncTick(makeTickView([observerView(1, 2.75, 4.5, 0, 3, 1)]));
    expect(fog.rebuilds).toBe(4);
  });

  it('второй наблюдатель в доставке — другие входы, перестройка', () => {
    const { fog } = cachedSubsystem();
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3)]));
    fog.syncTick(makeTickView([observerView(1, 2.5, 4.5, 0, 3), observerView(3, 6, 6, 0, 2)]));
    expect(fog.rebuilds).toBe(2);
  });
});
