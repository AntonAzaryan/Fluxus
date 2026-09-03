/**
 * Текстурирование дуэльной арены: раздел `terrain` манифеста визуалов
 * (`assets` ASSET-6), карта раскраски клеток (ASSET-15) и материал смешивания
 * слотов (`rendering` REND-39).
 *
 * Механизм проверен в `render-ts` и `assets-ts` — веса вершин, текст шейдера,
 * потолок пресета, находки валидации; здесь проверяется КОНТЕНТ, которого у
 * движка нет: что карта лежит на настоящей сетке арены, что её слоты объявлены
 * tileset'ом (иначе потребитель предупреждает и рисует последним слотом), что
 * названные текстуры лежат в дереве контента, и что на этих данных подсистема
 * действительно текстурирует пол, не сказав ни слова в канал предупреждений.
 *
 * Документы читаются прямо из дерева контента: демо — игра, и `content/` ему
 * принадлежит (CONT-4).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import {
  manifestAssetRefs,
  validateManifest,
  validateTerrainPaint,
  type AssetState,
  type AssetService,
  type TerrainPaintMap,
  type VisualManifest,
} from '@fluxus/assets';
import {
  TERRAIN_PAINT_ATTRIBUTE,
  TerrainSubsystem,
  createCostCounters,
  withCostSink,
  type RenderContext,
} from '@fluxus/render';
import manifestJson from '../../../content/visuals/manifest.json';
import paintJson from '../../../content/visuals/duel.paint.json';
import sceneJson from '../../../content/scenes/duel.scene.json';

/** Шаг высоты сборки демо (REND-7) — тот же, что в `app/main.ts`. */
const HEIGHT_STEP = 0.6;

/** Корень дерева контента: ID ассета — путь от него (ASSET-2). */
const CONTENT_ROOT = join(import.meta.dirname, '../../../content');

const MANIFEST = manifestJson as unknown as VisualManifest;

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

function duelPaint(): TerrainPaintMap {
  const result = validateTerrainPaint(paintJson);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.map;
}

function terrainSection(): NonNullable<VisualManifest['terrain']> {
  const section = MANIFEST.terrain;
  if (section?.tileset === undefined || section.paintMap === undefined) {
    throw new Error('в манифесте демо нет tileset\'а либо карты раскраски');
  }
  return section;
}

/** Стаб модуля ассетов: карта раскраски настоящая, текстуры — заглушки 2×2. */
function makeAssets(paint: TerrainPaintMap): {
  service: AssetService;
  requests: string[];
} {
  const requests: string[] = [];
  const image = { width: 2, height: 2, format: 'rgba8' as const, pixels: new Uint8Array(16) };
  const service = {
    registerLoader(): void {},
    request(kind: string, id: string) {
      requests.push(`${kind} ${id}`);
      return { kind, id };
    },
    state(): AssetState<unknown> {
      return { status: 'loading' };
    },
    subscribe(handle: { kind: string; id: string }, cb: (s: AssetState<unknown>) => void) {
      cb(handle.kind === 'terrain-paint' ? { status: 'ready', data: paint } : { status: 'ready', data: image });
      return () => {};
    },
    retry(): void {},
  } as unknown as AssetService;
  return { service, requests };
}

describe('REND-39: текстурирование дуэльной арены — данные контента', () => {
  it('раздел terrain проходит валидацию манифеста, а его ссылки лежат в дереве', () => {
    const result = validateManifest(manifestJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = terrainSection();
    const refs = manifestAssetRefs(result.manifest).filter((ref) => ref.path[0] === 'terrain');
    // Ссылки раздела перечислены полностью: карта кривизны (ASSET-7), карта
    // раскраски и текстура каждого слота, включая породу стенок. Опечатка в
    // пути означала бы предупреждение на каждом запуске демо — поэтому
    // существование файлов держит этот тест.
    expect(refs.map((ref) => ref.kind).sort()).toEqual(
      [
        'terrain-curvature',
        'terrain-paint',
        ...section.tileset!.slots.map(() => 'texture'),
        'texture',
      ].sort(),
    );
    for (const ref of refs) expect(existsSync(join(CONTENT_ROOT, ref.asset))).toBe(true);
  });

  it('карта раскраски лежит на настоящей сетке арены и не выходит за tileset', () => {
    const grid = duelGrid();
    const paint = duelPaint();
    expect([paint.width, paint.height]).toEqual([grid.width, grid.height]);
    // Слот за пределом объявленных — предупреждение потребителя и заливка
    // последним слотом (REND-39): у контента демо такого быть не должно.
    const declared = terrainSection().tileset!.slots.length;
    expect(Math.max(...paint.slots)).toBeLessThan(declared);
    // Арена не одноцветна: ради шва на границе покрытий всё и затевалось.
    expect(new Set(paint.slots).size).toBeGreaterThan(1);
  });

  it('на этих данных подсистема текстурирует пол и молчит в канал предупреждений', () => {
    const section = terrainSection();
    const assets = makeAssets(duelPaint());
    const warnings: string[] = [];
    const subsystem = new TerrainSubsystem(duelGrid(), {
      tileset: section.tileset!,
      paintMap: section.paintMap!,
      warn: (message) => warnings.push(message),
    });
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: HEIGHT_STEP },
    };
    const counters = createCostCounters();
    withCostSink(counters, () => {
      subsystem.init(ctx);
    });
    expect(warnings).toEqual([]);
    // Спрошено ровно названное разделом: карта и текстуры слотов.
    expect(assets.requests).toContain(`terrain-paint ${section.paintMap!}`);
    for (const slot of section.tileset!.slots) expect(assets.requests).toContain(`texture ${slot.texture}`);
    expect(assets.requests).toContain(`texture ${section.tileset!.wall!.texture}`);

    // Веса слотов доехали до геометрии пола: без атрибута шейдер смешивать
    // нечему, и арена осталась бы одноцветной.
    const meshes = ctx.scene.children.filter(
      (node): node is THREE.Mesh => node instanceof THREE.Mesh,
    );
    const painted = meshes.filter((mesh) =>
      mesh.geometry.hasAttribute(TERRAIN_PAINT_ATTRIBUTE),
    ).length;
    expect(painted).toBeGreaterThan(0);
    expect(counters.terrainPaintVertices).toBeGreaterThan(0);
  });
});
