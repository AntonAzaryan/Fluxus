/**
 * Вода демо-арены: секция `water` её парного документа (`rendering` REND-35) и
 * рябь от юнитов (REND-36).
 *
 * Механизм проверен в `render-ts` — регионы, глубинная текстура, отбор
 * источников, ручки качества; здесь проверяется КОНТЕНТ, которого у движка нет
 * и быть не может: что карта водоёма ложится на настоящую сетку дуэльной арены,
 * что урез подобран между дном лощины кривизны и полом нулевого уровня (design
 * D8), что вода демо не требует ни одного текстурного ассета — и что работа
 * подсистемы видна счётчикам стоимости, то есть попадает и в бенч стадии кадра
 * (`performance-budget` PERF-2, PERF-7).
 *
 * Документы читаются прямо из дерева контента: демо — игра, и `content/` ему
 * принадлежит (CONT-4).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import {
  validateCurvatureMap,
  validatePresentationScene,
  type AssetService,
  type PresentationWater,
  type TerrainCurvatureMap,
} from '@fluxus/assets';
import {
  VisualSurfaceSource,
  WaterSubsystem,
  createCostCounters,
  resolveWaterConfig,
  withCostSink,
  type RenderContext,
} from '@fluxus/render';
import curvatureJson from '../../../content/visuals/arena-curvature.json';
import presentationJson from '../../../content/scenes/duel.presentation.json';
import sceneJson from '../../../content/scenes/duel.scene.json';

/** Шаг высоты сборки демо (REND-7) — тот же, что в `app/main.ts`. */
const HEIGHT_STEP = 0.6;

const WATER = (presentationJson as unknown as { water: PresentationWater }).water;

interface SceneTerrain {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly levels: string[];
  readonly flags: string[];
}

function duelGrid(): TerrainGrid {
  const terrain = (sceneJson as unknown as { terrain: SceneTerrain }).terrain;
  return createTerrainGrid(terrain);
}

function duelCurvature(): TerrainCurvatureMap {
  const result = validateCurvatureMap(curvatureJson);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

interface Rig {
  readonly water: WaterSubsystem;
  readonly warnings: string[];
  readonly requests: string[];
  readonly grid: TerrainGrid;
}

/** Сцена демо глазами воды: та же сетка, та же карта кривизны, тот же шаг. */
function makeRig(): Rig {
  const grid = duelGrid();
  const requests: string[] = [];
  const warnings: string[] = [];
  const assets = {
    request: (kind: string, id: string) => {
      requests.push(`${kind} ${id}`);
      return { kind, id };
    },
    state: () => ({ status: 'loading' }),
    subscribe: () => () => {},
  } as unknown as AssetService;
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets,
    config: { heightStep: HEIGHT_STEP },
  };
  const surface = new VisualSurfaceSource(grid);
  surface.setCurvature(duelCurvature());
  const water = new WaterSubsystem({
    grid,
    surface,
    config: WATER,
    warn: (message) => warnings.push(message),
  });
  water.init(ctx);
  return { water, warnings, requests, grid };
}

/** Глубина в мировой точке — та же выборка, что делает фрагмент (REND-35). */
function depthAt(rig: Rig, wx: number, wy: number): number {
  const body = rig.water.drawnBodies[0]!;
  const rect = body.material.uniforms.uDepthRect!.value as THREE.Vector4;
  const texture = body.material.uniforms.tDepth!.value as THREE.DataTexture;
  const width = texture.image.width;
  const height = texture.image.height;
  const tx = Math.min(Math.max(Math.floor(((wx - rect.x) / rect.z) * width), 0), width - 1);
  const ty = Math.min(Math.max(Math.floor(((wy - rect.y) / rect.w) * height), 0), height - 1);
  const data = texture.image.data as Uint16Array;
  return THREE.DataUtils.fromHalfFloat(data[ty * width + tx]!);
}

describe('REND-35: водоём демо лежит в лощине карты кривизны (design D8)', () => {
  it('секция проходит валидацию против настоящей сетки арены', () => {
    const grid = duelGrid();
    const result = validatePresentationScene(presentationJson, {
      terrain: { width: grid.width, height: grid.height },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.water).toBeDefined();
    expect(WATER.cells).toHaveLength(grid.height);
    for (const row of WATER.cells) expect(row.length).toBe(grid.width);
  });

  it('сим-слой сцены о воде не знает ни байтом (PRES-4)', () => {
    // Ни поля `water`, ни любого другого следа: вода — чистая презентация, и
    // `worldInit`, снапшоты и golden матчей от неё не двигаются.
    expect(Object.keys(sceneJson as object)).not.toContain('water');
    expect(JSON.stringify(sceneJson)).not.toContain('water');
  });

  it('урез между дном лощины и полом нулевого уровня: берег внутри карты', () => {
    const rig = makeRig();
    rig.water.updateFrame(0, 0);
    expect(rig.water.drawnBodies).toHaveLength(1);

    const body = resolveWaterConfig(WATER)!.bodies[0]!;
    // Урез ниже пола нулевого уровня (иначе вода стояла бы на ровном месте) и
    // выше дна лощины (иначе водоёма не было бы вовсе, ASSET-7: смещения карты
    // кривизны — целые доли шага высоты).
    expect(body.surfaceLevel).toBeLessThan(0);
    expect(body.surfaceLevel).toBeGreaterThan(-0.25);

    // Дно лощины: глубина положительна — вода видна.
    expect(depthAt(rig, 8.5, 9.5)).toBeGreaterThan(0);
    // Кромка карты: поле выше уреза — берег, фрагмент отбрасывается. Линию воды
    // рисует пересечение уреза полем, а не граница клеток (REND-35).
    expect(depthAt(rig, 22.5, 5.5)).toBeLessThanOrEqual(0);
  });

  it('вода демо не требует ни одного текстурного ассета (путь procedural)', () => {
    const rig = makeRig();
    expect(resolveWaterConfig(WATER)!.bodies[0]!.detail.source).toBe('procedural');
    expect(rig.requests).toEqual([]);
    expect(rig.warnings).toEqual([]);
  });

  it('работа воды видна счётчикам стоимости — значит и стадиям бенча (PERF-2)', () => {
    // `npm run bench:demo` мерит стадии кадра главного потока: покадровое
    // обновление подсистем идёт стадией `present`, а прозрачный проход воды —
    // стадией `draw`. Здесь проверяется машинная половина того же утверждения:
    // подсистема действительно делает работу на сцене демо, а не молчит.
    const rig = makeRig();
    const counters = createCostCounters();
    withCostSink(counters, () => {
      rig.water.updateFrame(0.016, 0.5);
    });
    expect(counters.waterBodiesDrawn).toBe(1);
    expect(counters.waterQuads).toBeGreaterThan(0);
    // Первый кадр заполняет глубинную текстуру целиком — охват региона на
    // квадрат плотности выборки (REND-35).
    expect(counters.waterDepthTexels).toBeGreaterThan(0);
  });
});
