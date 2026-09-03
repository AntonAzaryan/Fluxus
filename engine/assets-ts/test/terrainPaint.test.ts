/**
 * Карта раскраски террейна (ASSET-15): формат документа, адресные находки
 * валидации, загрузчик реестра и tileset в разделе `terrain` манифеста
 * (ASSET-6). Пара к `curvature.test.ts` — та проверяет узловую карту рельефа,
 * эта клеточную карту покрытий.
 */
import { describe, expect, it } from 'vitest';
import {
  AssetService,
  TERRAIN_PAINT_MAX_SLOT,
  manifestAssetRefs,
  terrainPaintLoader,
  validateManifest,
  validateTerrainPaint,
  type TerrainPaintMap,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, expectValidationErrors, settled } from './helpers.js';

/** Сетка 4×3: два слота полосами — на границе виден шов, ради которого всё. */
const validDoc = { width: 4, height: 3, rows: ['0011', '0011', '0211'] };

function expectErrors(doc: unknown, ...patterns: RegExp[]): void {
  expectValidationErrors(validateTerrainPaint(doc), patterns);
}

describe('validateTerrainPaint (ASSET-15)', () => {
  it('валидная карта: слоты разобраны по клеткам row-major', () => {
    const result = validateTerrainPaint(validDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.map.width, result.map.height]).toEqual([4, 3]);
    expect([...result.map.slots]).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 1, 1]);
  });

  it('алфавит шире предела рендера намеренно: цифра 9 валидна', () => {
    // Сколько слотов смешивает рендер, решает REND-39; валидации ассета tileset
    // не виден вовсе — тот же приём, что у неограниченной амплитуды ASSET-7.
    const result = validateTerrainPaint({ width: 2, height: 1, rows: ['09'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.map.slots]).toEqual([0, TERRAIN_PAINT_MAX_SLOT]);
  });

  it('символ вне алфавита — находка с координатой клетки', () => {
    expectErrors({ width: 2, height: 1, rows: ['0x'] }, /rows\[0\], клетка 1: символ "x" вне алфавита/);
  });

  it('рваная сетка — находка с адресом ряда, а не молчаливое дополнение', () => {
    expectErrors({ width: 4, height: 2, rows: ['0011', '001'] }, /rows\[1\]: клеток 3, а width = 4/);
    expectErrors({ width: 2, height: 3, rows: ['00', '11'] }, /rows: рядов 2, а height = 3/);
  });

  it('состав документа закрыт, размеры — целые больше нуля', () => {
    expectErrors({ ...validDoc, extra: 1 }, /extra: неизвестное поле/);
    expectErrors({ width: 0, height: 1, rows: ['0'] }, /width: ожидалось целое > 0/);
    expectErrors({ width: 1, height: 1, rows: 7 }, /rows: ожидался массив текстовых рядов/);
    expectErrors(42, /ожидался объект документа карты раскраски/);
  });

  it('находки собираются ВСЕ разом: правка руками не должна быть угадыванием', () => {
    const result = validateTerrainPaint({ width: 2, height: 2, rows: ['0a', '0b'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
  });
});

describe('terrainPaintLoader (ASSET-3, ASSET-15)', () => {
  it('загружает карту через сервис под видом terrain-paint', async () => {
    const source = new MemoryAssetSource(
      new Map([['visuals/duel.paint.json', bytesOf(JSON.stringify(validDoc))]]),
    );
    const service = new AssetService(source);
    service.registerLoader(terrainPaintLoader);
    const state = await settled(
      service,
      service.request<TerrainPaintMap>('terrain-paint', 'visuals/duel.paint.json'),
    );
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.data.width).toBe(4);
    expect(state.data.slots[9]).toBe(2);
  });

  it('невалидная карта — failed с адресом клетки', async () => {
    const source = new MemoryAssetSource(
      new Map([['visuals/bad.json', bytesOf(JSON.stringify({ width: 2, height: 1, rows: ['0z'] }))]]),
    );
    const service = new AssetService(source);
    service.registerLoader(terrainPaintLoader);
    const state = await settled(
      service,
      service.request<TerrainPaintMap>('terrain-paint', 'visuals/bad.json'),
    );
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') return;
    expect(state.reason).toMatch(/rows\[0\], клетка 1/);
  });
});

describe('tileset и карта раскраски в манифесте (ASSET-6, ASSET-15)', () => {
  const slots = [{ texture: 'visuals/textures/grass.png', period: 6 }];

  it('валидный раздел проходит, а ссылки попадают в перечень ассетов', () => {
    const result = validateManifest({
      entities: { unit: { model: 'm.mdx' } },
      terrain: {
        curvatureMap: 'visuals/curve.json',
        paintMap: 'visuals/duel.paint.json',
        tileset: { slots, wall: { texture: 'visuals/textures/cliff.png', period: 2 } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.terrain?.tileset?.slots[0]?.period).toBe(6);

    // Перечень ссылок — то, чем прогреватель и проверка дерева узнают об
    // ассетах раздела: карта едет своим видом, текстуры слотов — текстурами.
    const refs = manifestAssetRefs(result.manifest);
    const kinds = new Map(refs.map((ref) => [ref.asset, ref.kind]));
    expect(kinds.get('visuals/duel.paint.json')).toBe('terrain-paint');
    expect(kinds.get('visuals/textures/grass.png')).toBe('texture');
    expect(kinds.get('visuals/textures/cliff.png')).toBe('texture');
  });

  it('невалидный tileset — адресные находки, а не молчаливый пропуск', () => {
    const bad = (doc: unknown, pattern: RegExp): void => {
      const result = validateManifest(doc);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.errors.some((e) => pattern.test(e)),
        result.errors.join('\n'),
      ).toBe(true);
    };
    const entities = { u: { model: 'm.mdx' } };
    bad({ entities, terrain: { tileset: { slots: [] } } }, /tileset\.slots: ожидался непустой массив/);
    bad(
      { entities, terrain: { tileset: { slots: [{ texture: 'a.png', period: 0 }] } } },
      /tileset\.slots\[0\]\.period: ожидался мировой период тайла > 0/,
    );
    bad(
      { entities, terrain: { tileset: { slots: [{ period: 1 }] } } },
      /tileset\.slots\[0\]\.texture: ожидался asset id текстуры/,
    );
    bad(
      { entities, terrain: { tileset: { slots, extra: 1 } } },
      /tileset\.extra: неизвестное поле/,
    );
    bad({ entities, terrain: { paintMap: '' } }, /terrain\.paintMap: ожидался asset id карты раскраски/);
  });
});
