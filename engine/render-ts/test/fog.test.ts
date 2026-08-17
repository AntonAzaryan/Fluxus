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
import type { AssetService } from '@game-mvp/assets';
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
  type FogSegment,
  type RenderContext,
} from '../src/index.js';
import { makeEntityView, makeTickView } from './fixtures.js';

// ------------------------------------------------------------------- стенд

/** Арена 8×8 по клетке в мировую единицу; одна возвышенная клетка (4, 4). */
function gridWithPillar(): TerrainGrid {
  const levels = Array.from({ length: 8 }, (_, y) => (y === 4 ? '00001000' : '00000000'));
  const flags = Array.from({ length: 8 }, () => '........');
  return createTerrainGrid({ width: 8, height: 8, tileSize: 65536, levels, flags });
}

/** Ровная арена без укрытий — геометрии круга ничего не режет. */
function flatGrid(): TerrainGrid {
  return createTerrainGrid({
    width: 8,
    height: 8,
    tileSize: 65536,
    levels: Array.from({ length: 8 }, () => '00000000'),
    flags: Array.from({ length: 8 }, () => '........'),
  });
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

function makeContext(): RenderContext {
  return {
    scene: new THREE.Scene(),
    assets: {} as AssetService,
    config: { heightStep: 0.6 },
  };
}

/** Записывающий стаб рендерера: подсистеме нужен структурный минимум. */
class RendererSpy {
  readonly rendered: THREE.Object3D[] = [];
  readonly targets: (THREE.WebGLRenderTarget | null)[] = [];
  render(scene: THREE.Object3D): void {
    this.rendered.push(scene);
  }
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void {
    this.targets.push(target);
  }
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(64, 48);
  }
}

/** Канвас слоя миникарты без DOM: записывает блит, контекст минимальный. */
function fakeCanvas(): FogLayerCanvas & { puts: number } {
  const canvas = {
    width: 0,
    height: 0,
    puts: 0,
    getContext: () => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: () => {
        canvas.puts++;
      },
    }),
  };
  return canvas;
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

  it('кромка тени — полутон частичного покрытия, а не ступень (FOW-7)', () => {
    const grid = gridWithPillar();
    const mask = new VisibilityMask(fogRectOf(grid), 4);
    mask.reveal({ x: 2.5, y: 4.5, radius: 6, level: 0 }, 0.25, fogSegmentsOf(grid));
    // Скан текселей поперёк кромки тени — вдоль луча через отбрасывающее её
    // левое ребро клетки (x = 4): перед ребром светло, за ним тень, между ними
    // полоса полутона ~1 текселя полярного depth-буфера (design D3). Скачка на
    // весь диапазон между соседями нет — кромка полутоновая, а не ступень;
    // тень при этом остаётся тенью (расхождение приближения — в сторону
    // тумана, FOW-9).
    const values: number[] = [];
    for (let wx = 3.0625; wx <= 5.0; wx += 0.25) values.push(mask.valueAt(wx, 4.5));
    expect(values[0]).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBe(0);
    let maxJump = 0;
    for (let i = 1; i < values.length; i++) maxJump = Math.max(maxJump, Math.abs(values[i]! - values[i - 1]!));
    expect(maxJump).toBeLessThan(1);
    // Полутон в полосе существует: между светом и тенью есть промежуточное значение.
    expect(values.some((value) => value > 0 && value < 1)).toBe(true);
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

  it('segmentCasts: тень только с нижней стороны, на линии и при равных уровнях — тень (FOW-9)', () => {
    const edge: FogSegment = { x1: 4, y1: 4, x2: 4, y2: 5, levelNeg: 0, levelPos: 1 };
    expect(segmentCasts(2.5, 4.5, edge)).toBe(true); // нижняя сторона — тень
    expect(segmentCasts(5.5, 4.5, edge)).toBe(false); // верхняя — ребро прозрачно
    // Наблюдатель ровно на линии — нижняя сторона: расхождение в сторону тумана.
    expect(segmentCasts(4, 4.5, edge)).toBe(true);
    // Равные уровни — тень с обеих сторон, как блок вырожденного ребра (PHYS-13).
    const flat: FogSegment = { ...edge, levelPos: 0 };
    expect(segmentCasts(2.5, 4.5, flat)).toBe(true);
    expect(segmentCasts(5.5, 4.5, flat)).toBe(true);
  });
});

// ------------------------------ 2.3 и 3: подсистема, наблюдатели и конфиг

describe('FOW-7, FOW-9: отбор наблюдателей из доставленного состояния (design D4)', () => {
  function subsystemWith(entities: EntityView[]): FogSubsystem {
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      createCanvas: (width, height) => {
        const canvas = fakeCanvas();
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
    });
    fog.init(makeContext());
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
    expect(fog.visibility.valueAt(6, 6)).toBe(1);
  });

  it('радиус reveal консервативнее доставленного: коэффициент из конфига (FOW-9)', () => {
    const fog = subsystemWith([observerView(1, 4, 4, 0, 3)]);
    const conservatism = DEFAULT_FOG_CONFIG.conservatism;
    // Точка между визуальным (3 × коэффициент) и симуляционным (3) радиусом —
    // уже туман: визуал консервативнее геймплея (FOW-9).
    const between = 3 * (conservatism + 1) * 0.5;
    expect(between).toBeLessThan(3);
    expect(fog.visibility.valueAt(4 + between, 4)).toBe(0);
    // Внутри визуального радиуса свет есть.
    expect(fog.visibility.valueAt(4 + 3 * conservatism - 0.5, 4)).toBeGreaterThan(0);
  });

  it('пока статы героя не доставлены, маска не строится и конвейер прежний', () => {
    const fog = new FogSubsystem({ grid: flatGrid(), stats: STATS, hero: () => null });
    const ctx = makeContext();
    fog.init(ctx);
    fog.syncTick(makeTickView([observerView(2, 1, 1, 0, 3)]));
    const renderer = new RendererSpy();
    fog.render(renderer, new THREE.PerspectiveCamera());
    // Ровно прямой рендер: ни render target, ни второго прохода (design D2).
    expect(renderer.rendered).toEqual([ctx.scene]);
    expect(renderer.targets).toEqual([]);
  });
});

describe('FOW-7, FOW-10: пост-проход и обновление конфига в рантайме', () => {
  function activeSubsystem(): { fog: FogSubsystem; ctx: RenderContext } {
    const ctx = makeContext();
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      createCanvas: (width, height) => {
        const canvas = fakeCanvas();
        canvas.width = width;
        canvas.height = height;
        return canvas;
      },
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
    fog.init(makeContext());
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
