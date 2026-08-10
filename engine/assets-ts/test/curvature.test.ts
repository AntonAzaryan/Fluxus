import { describe, expect, it } from 'vitest';
import {
  AssetService,
  CURVATURE_SCALE,
  curvatureLoader,
  curvatureOffsetOf,
  resolveSurfaceAlign,
  validateCurvatureMap,
  validateManifest,
  type TerrainCurvatureMap,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

const validDoc = {
  width: 4,
  height: 3,
  rows: ['..17', '.a.g', '....'],
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
  it('валидная карта: смещения разобраны по алфавиту', () => {
    const result = validateCurvatureMap(validDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const map = result.map;
    expect(map.width).toBe(4);
    expect(map.height).toBe(3);
    expect(Array.from(map.offsets.subarray(0, 4))).toEqual([0, 0, 1, 7]);
    expect(Array.from(map.offsets.subarray(4, 8))).toEqual([0, -1, 0, -7]);
  });

  it('максимум шкалы меньше полушага высоты (инвариант REND-9)', () => {
    // 7/16 < 1/2 — ограничение амплитуды обеспечено алфавитом по построению.
    expect(7 / CURVATURE_SCALE).toBeLessThan(0.5);
    expect(curvatureOffsetOf('7')).toBe(7);
    expect(curvatureOffsetOf('g')).toBe(-7);
    expect(curvatureOffsetOf('.')).toBe(0);
  });

  it('символ вне алфавита отвергается с адресом клетки', () => {
    expectErrors({ width: 2, height: 1, rows: ['.8'] }, /rows\[0\], клетка 1: символ "8"/);
    expectErrors({ width: 2, height: 1, rows: ['.h'] }, /символ "h"/);
    // Верхний регистр невалиден: одно текстовое представление у карты.
    expectErrors({ width: 2, height: 1, rows: ['.A'] }, /символ "A"/);
    expectErrors({ width: 2, height: 1, rows: ['.0'] }, /символ "0"/);
  });

  it('рваная сетка отвергается, а не достраивается', () => {
    expectErrors({ width: 4, height: 2, rows: ['....', '...'] }, /rows\[1\]: длина 3, а width = 4/);
    expectErrors({ width: 2, height: 3, rows: ['..', '..'] }, /rows: рядов 2, а height = 3/);
  });

  it('не-объект, кривые размеры и неизвестные поля — внятные ошибки', () => {
    expectErrors(null, /ожидался объект.*null/);
    expectErrors({ width: 0, height: 1, rows: [''] }, /width: ожидалось целое > 0/);
    expectErrors({ width: 1, height: 1.5, rows: ['.'] }, /height: ожидалось целое > 0/);
    expectErrors({ width: 1, height: 1, rows: ['.'], extra: 1 }, /extra: неизвестное поле/);
    expectErrors({ width: 1, height: 1, rows: '.' }, /rows: ожидался массив строк/);
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

  it('невалидная карта — failed с адресом клетки', async () => {
    const doc = { width: 2, height: 1, rows: ['.z'] };
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
    expect(state.reason).toMatch(/rows\[0\], клетка 1/);
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
