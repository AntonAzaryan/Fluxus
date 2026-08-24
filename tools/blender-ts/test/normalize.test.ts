/**
 * Нормализация трансформа и `extras`. Главное здесь — ЗНАКИ соответствия осей:
 * они зафиксированы конвенцией (`CONVENTIONS.md`, BLND-3) и пиннятся этой
 * фикстурой (design, решение 5). Правка знаков ломает эти тесты первыми, и это
 * их назначение: смена соответствия — смена формата конвейера, а не настройка.
 */
import { describe, expect, it } from 'vitest';
import { coerceExtra, decompose, localMatrixOf, multiplyMatrices, normalizeDocument } from '../src/normalize.js';
import { fixture, objectNamed, objectsOf } from './support.js';

/** Долей оборота, с точностью заведомо мельче шага PRES-3 (10⁻⁴). */
const TURN_PRECISION = 6;

describe('BLND-3: соответствие осей зафиксировано', () => {
  const objects = objectsOf('axes.gltf');

  it('мировые (x, y) — это glTF (x, −z), вертикаль — glTF y', () => {
    const object = objectNamed(objects, 'at-two-five-minus-three');
    expect(object.x).toBe(2);
    expect(object.y).toBe(3);
    expect(object.elevation).toBe(5);
  });

  it('поворот вокруг +Y на четверть оборота даёт yaw = 0.25', () => {
    expect(objectNamed(objects, 'quarter-turn').yaw).toBeCloseTo(0.25, TURN_PRECISION);
  });

  it('yaw приводится к [0, 1): отрицательный поворот — тот же курс', () => {
    // −90° вокруг +Y: кватернион (0, sin(−45°), 0, cos(−45°)).
    const half = Math.SQRT1_2;
    const matrix = localMatrixOf({ rotation: [0, -half, 0, half] });
    expect(decompose(matrix).yaw).toBeCloseTo(0.75, TURN_PRECISION);
  });

  it('крошечный отрицательный поворот даёт yaw = 0, а не 1: [0, 1) держится и на краю', () => {
    // У курса тоньше пол-ulp сумма `turns + 1` округляется в double ровно в 1,
    // а полный оборот — тот же курс, что 0: единица наружу не выходит (BLND-4).
    const matrix = localMatrixOf({ rotation: [0, -3.5e-17, 0, 1] });
    expect(decompose(matrix).yaw).toBe(0);
  });

  it('родительство не двигает объект: трансформы перемножаются', () => {
    const child = objectNamed(objects, 'child');
    expect([child.x, child.y]).toEqual([3, 4]);
  });
});

describe('BLND-3: трансформ приходит двумя формами', () => {
  it('матрица и TRS дают одно и то же', () => {
    const trs = { translation: [1, 2, -3], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 2, 2] };
    const matrix = localMatrixOf(trs);
    const fromMatrix = decompose(localMatrixOf({ matrix }));
    const fromTrs = decompose(matrix);
    expect(fromMatrix.x).toBeCloseTo(fromTrs.x, TURN_PRECISION);
    expect(fromMatrix.y).toBeCloseTo(fromTrs.y, TURN_PRECISION);
    expect(fromMatrix.yaw).toBeCloseTo(fromTrs.yaw, TURN_PRECISION);
    expect(fromMatrix.scale).toBeCloseTo(2, TURN_PRECISION);
  });

  it('единичная матрица — нейтраль умножения', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const matrix = localMatrixOf({ translation: [3, 0, -4] });
    expect(multiplyMatrices(identity, matrix)).toEqual(matrix);
  });

  it('масштаб читается по столбцам и признаётся неодинаковым по осям', () => {
    const stretched = objectNamed(objectsOf('warnings.gltf'), 'stretched-statue');
    expect(stretched.scale).toBeCloseTo(2, TURN_PRECISION);
    expect(stretched.uniformScale).toBe(false);
    expect(stretched.mirrored).toBe(false);
  });

  it('зеркальный трансформ виден отдельно: длины столбцов знака не несут', () => {
    // Масштаб −1 по оси X: разложение отдаёт положительный масштаб и курс,
    // отличающийся на пол-оборота, — зеркала ни одна величина не выражает.
    const mirrored = decompose(localMatrixOf({ scale: [-1, 1, 1] }));
    expect(mirrored.mirrored).toBe(true);
    expect(mirrored.scale).toBeCloseTo(1, TURN_PRECISION);
    expect(mirrored.yaw).toBeCloseTo(0.5, TURN_PRECISION);
    expect(decompose(localMatrixOf({ scale: [2, 2, 2] })).mirrored).toBe(false);
  });
});

describe('BLND-3: семантика приходит из custom properties, а не из имени', () => {
  it('объект без семантических свойств семантики не получает', () => {
    expect(objectNamed(objectsOf('placements.gltf'), 'marker-center').semantics).toEqual([]);
  });

  it('семантика и её значение читаются из extras', () => {
    const hero = objectNamed(objectsOf('placements.gltf'), 'zeta-hero');
    expect(hero.semantics).toEqual(['prefab']);
    expect(hero.semanticValue).toBe('Hero');
  });

  it('маркер terrain семантичен без строкового значения', () => {
    const grid = objectNamed(objectsOf('grid.gltf'), 'terrain-grid');
    expect(grid.semantics).toEqual(['terrain']);
    expect(grid.mesh).toBe(0);
  });

  it('два семантических свойства видны оба — разбирается это генерацией слоя', () => {
    expect(objectNamed(objectsOf('errors.gltf'), 'both-layers').semantics).toEqual(['prefab', 'visual']);
  });
});

describe('BLND-3: коэрция типов extras', () => {
  it('скаляры проходят как есть, массив из одного элемента разворачивается', () => {
    expect(coerceExtra('Hero')).toBe('Hero');
    expect(coerceExtra(2)).toBe(2);
    expect(coerceExtra(true)).toBe(true);
    expect(coerceExtra([1.5])).toBe(1.5);
  });

  it('несворачиваемое значение отбрасывается: придумывать ему скаляр импорт не вправе', () => {
    expect(coerceExtra(null)).toBe(null);
    expect(coerceExtra([1, 2])).toBe(null);
    expect(coerceExtra({ a: 1 })).toBe(null);
  });

  it('несворачиваемое свойство не попадает в объект источника', () => {
    const objects = normalizeDocument({
      json: { nodes: [{ name: 'node', extras: { prefab: 'Hero', tags: [1, 2] } }] },
      binaryChunk: null,
    });
    expect(objects[0]?.extras).toEqual({ prefab: 'Hero' });
  });
});

describe('BLND-4: обход детерминирован', () => {
  it('объекты разбираются один раз, даже если документ перечисляет их дважды', () => {
    const objects = normalizeDocument(fixture('axes.gltf'));
    expect(objects.map((object) => object.node)).toEqual([0, 1, 2, 3]);
  });
});
