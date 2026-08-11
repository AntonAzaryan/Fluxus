import { describe, expect, it } from 'vitest';
import {
  AssetService,
  CURVATURE_SCALE,
  curvatureLoader,
  resolveSurfaceAlign,
  validateCurvatureMap,
  validateManifest,
  type TerrainCurvatureMap,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

// Сетка 4×3 клетки → узлы 5×4.
const validDoc = {
  width: 4,
  height: 3,
  rows: [
    [0, 0, 1, 7, 40],
    [0, -1, 0, -7, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, -33],
  ],
};

function expectErrors(doc: unknown, ...patterns: RegExp[]): void {
  const result = validateCurvatureMap(doc);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('ожидался провал валидации');
  for (const pattern of patterns) {
    expect(
      result.errors.some((e) => pattern.test(e)),
      `нет ошибки под ${pattern}; есть:\n${result.errors.join('\n')}`,
    ).toBe(true);
  }
}

describe('validateCurvatureMap (ASSET-7)', () => {
  it('валидная карта: узловые смещения разобраны как есть', () => {
    const result = validateCurvatureMap(validDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const map = result.map;
    expect(map.width).toBe(4);
    expect(map.height).toBe(3);
    expect(Array.from(map.offsets.subarray(0, 5))).toEqual([0, 0, 1, 7, 40]);
    expect(Array.from(map.offsets.subarray(5, 10))).toEqual([0, -1, 0, -7, 0]);
  });

  it('амплитуда больше шага уровня валидна: предела у формата нет', () => {
    // |40| > CURVATURE_SCALE — смещение больше целого шага высоты; читаемость
    // перепадов обеспечивает cliff-кромка (REND-9), а не ограничение ассета.
    expect(Math.abs(40) / CURVATURE_SCALE).toBeGreaterThan(1);
    const result = validateCurvatureMap(validDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.map.offsets[4]).toBe(40);
    expect(result.map.offsets[19]).toBe(-33);
  });

  it('нецелое или нечисловое значение отвергается с адресом узла', () => {
    expectErrors(
      { width: 1, height: 1, rows: [[0, 0.5], [0, 0]] },
      /rows\[0\], узел 1: .*получено 0\.5/,
    );
    expectErrors(
      { width: 1, height: 1, rows: [[0, 0], ['x', 0]] },
      /rows\[1\], узел 0: .*получено string/,
    );
    // За безопасным целым диапазоном JSON — отказ, а не молчаливое усечение.
    expectErrors(
      { width: 1, height: 1, rows: [[0, 0], [0, 2 ** 53]] },
      /rows\[1\], узел 1/,
    );
  });

  it('прежний строковый формат отвергается адресно', () => {
    expectErrors(
      { width: 4, height: 3, rows: ['..17', '.a.g', '....'] },
      /прежний per-cell формат/,
    );
  });

  it('рваная узловая сетка отвергается, а не достраивается', () => {
    expectErrors(
      { width: 4, height: 1, rows: [[0, 0, 0, 0, 0], [0, 0, 0]] },
      /rows\[1\]: узлов 3, а width \+ 1 = 5/,
    );
    expectErrors(
      { width: 1, height: 3, rows: [[0, 0], [0, 0]] },
      /rows: рядов 2, а узловых рядов height \+ 1 = 4/,
    );
  });

  it('не-объект, кривые размеры и неизвестные поля — внятные ошибки', () => {
    expectErrors(null, /ожидался объект.*null/);
    expectErrors({ width: 0, height: 1, rows: [[]] }, /width: ожидалось целое > 0/);
    expectErrors({ width: 1, height: 1.5, rows: [[]] }, /height: ожидалось целое > 0/);
    expectErrors({ width: 1, height: 1, rows: [[0, 0], [0, 0]], extra: 1 }, /extra: неизвестное поле/);
    expectErrors({ width: 1, height: 1, rows: 7 }, /rows: ожидался массив числовых рядов/);
  });
});

describe('curvatureLoader (ASSET-3, ASSET-7)', () => {
  it('загружает карту через сервис под видом terrain-curvature', async () => {
    const source = new MemoryAssetSource(
      new Map([['visuals/curve.json', bytesOf(JSON.stringify(validDoc))]]),
    );
    const service = new AssetService(source);
    service.registerLoader(curvatureLoader);
    const state = await settled(
      service,
      service.request<TerrainCurvatureMap>('terrain-curvature', 'visuals/curve.json'),
    );
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.data.width).toBe(4);
    expect(state.data.offsets[3]).toBe(7);
  });

  it('невалидная карта — failed с адресом узла', async () => {
    const doc = { width: 1, height: 1, rows: [[0, 0], [0, 1.25]] };
    const source = new MemoryAssetSource(
      new Map([['visuals/bad.json', bytesOf(JSON.stringify(doc))]]),
    );
    const service = new AssetService(source);
    service.registerLoader(curvatureLoader);
    const state = await settled(
      service,
      service.request<TerrainCurvatureMap>('terrain-curvature', 'visuals/bad.json'),
    );
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') return;
    expect(state.reason).toMatch(/rows\[1\], узел 1/);
  });
});

describe('surfaceAlign и terrain в манифесте (ASSET-6)', () => {
  const entity = { model: 'm.mdx' };

  it('валидные параметры наклона и ссылка на карту кривизны проходят', () => {
    const result = validateManifest({
      entities: { unit: { ...entity, surfaceAlign: { factor: 0.5, maxAngleDeg: 20 } } },
      surfaceAlign: { factor: 1 },
      terrain: { curvatureMap: 'visuals/curve.json' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entities.unit!.surfaceAlign).toEqual({ factor: 0.5, maxAngleDeg: 20 });
    expect(result.manifest.terrain?.curvatureMap).toBe('visuals/curve.json');
  });

  it('resolveSurfaceAlign: запись → дефолт манифеста → дефолт спеки (factor 1)', () => {
    const own = { factor: 0, maxAngleDeg: 5 };
    expect(resolveSurfaceAlign({}, { ...entity, surfaceAlign: own })).toEqual(own);
    expect(resolveSurfaceAlign({ surfaceAlign: { factor: 0.3 } }, entity)).toEqual({ factor: 0.3 });
    expect(resolveSurfaceAlign({}, entity)).toEqual({ factor: 1 });
    expect(resolveSurfaceAlign({}, undefined)).toEqual({ factor: 1 });
  });

  it('невалидные параметры наклона — внятные ошибки', () => {
    const bad = (doc: unknown, pattern: RegExp): void => {
      const result = validateManifest(doc);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.errors.some((e) => pattern.test(e)),
        result.errors.join('\n'),
      ).toBe(true);
    };
    bad(
      { entities: { u: { ...entity, surfaceAlign: { factor: 2 } } } },
      /surfaceAlign\.factor: .*\[0\.\.1\]/,
    );
    bad({ entities: { u: { ...entity, surfaceAlign: {} } } }, /surfaceAlign\.factor: обязательное/);
    bad(
      { entities: { u: { ...entity, surfaceAlign: { factor: 1, maxAngleDeg: -1 } } } },
      /maxAngleDeg: ожидалось неотрицательное/,
    );
    bad({ entities: {}, terrain: { curvatureMap: '' } }, /terrain\.curvatureMap: ожидался asset id/);
    bad({ entities: {}, terrain: { foo: 1 } }, /terrain\.foo: неизвестное поле/);
  });
});
