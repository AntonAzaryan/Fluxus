/**
 * Таблица цветокоррекции кадра (`rendering` REND-34) — разбор формата `.cube` и
 * его загрузчик в реестре (ASSET-3). Всё headless в Node (ASSET-5): ни GPU, ни
 * рендер-библиотеки здесь нет — модуль отдаёт числа, а трёхмерную текстуру из
 * них строит потребитель.
 */
import { describe, expect, it } from 'vitest';
import {
  AssetService,
  LUT_ASSET_KIND,
  MAX_LUT_SIZE,
  cubeLutLoader,
  parseCubeLut,
  type AssetState,
  type ColorLut,
  type Handle,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

/** Тождественная таблица стороны `size`: цвет узла — его же координаты. */
function identityCube(size: number, header = `LUT_3D_SIZE ${size}`): string {
  const lines = [`TITLE "тождество"`, header];
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${r / last} ${g / last} ${b / last}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function expectErrors(text: string, ...patterns: RegExp[]): string[] {
  const result = parseCubeLut(text);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('ожидался провал разбора');
  for (const pattern of patterns) {
    expect(
      result.errors.some((e) => pattern.test(e)),
      `нет ошибки под ${pattern}; есть:\n${result.errors.join('\n')}`,
    ).toBe(true);
  }
  return result.errors;
}

describe('REND-34: разбор `.cube`', () => {
  it('таблица разбирается в сторону и плоский массив, красный меняется первым', () => {
    const result = parseCubeLut(identityCube(2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lut.size).toBe(2);
    // `size³` троек: восемь узлов куба 2×2×2.
    expect(result.lut.data.length).toBe(8 * 3);
    // Первый узел — чёрный, второй — красный: порядок «красный первым» и есть
    // тот порядок, которого ждёт трёхмерная текстура потребителя.
    expect([...result.lut.data.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...result.lut.data.subarray(3, 6)]).toEqual([1, 0, 0]);
    // Последний — белый.
    expect([...result.lut.data.subarray(21, 24)]).toEqual([1, 1, 1]);
  });

  it('комментарии, пустые строки и единичный домен — законная часть файла', () => {
    const text = [
      '# сохранено редактором цвета',
      '',
      'TITLE "look"',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 1 1 1',
      'LUT_3D_SIZE 2',
      ...identityCube(2).split('\n').slice(2),
    ].join('\n');
    const result = parseCubeLut(text);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('находка называет НОМЕР СТРОКИ: таблица правится в редакторе цвета', () => {
    const broken = identityCube(2).replace('1 0 0', '1 0 очень');
    expectErrors(broken, /строка 4: компоненты RGB — конечные числа/);
    const short = identityCube(2).split('\n').slice(0, -3).join('\n');
    expectErrors(short, /троек — решётке 2³ нужно ровно 8/);
  });

  it('сторона вне границ и её отсутствие отвергаются адресно', () => {
    expectErrors(identityCube(2, 'LUT_3D_SIZE 1'), /LUT_3D_SIZE — целое из \[2, 64\]/);
    expectErrors(
      identityCube(2, `LUT_3D_SIZE ${MAX_LUT_SIZE + 1}`),
      /LUT_3D_SIZE — целое из \[2, 64\]/,
    );
    expectErrors(identityCube(2, 'LUT_3D_SIZE 2.5'), /LUT_3D_SIZE — целое/);
    expectErrors(
      identityCube(2).split('\n').filter((line) => !line.startsWith('LUT_3D_SIZE')).join('\n'),
      /LUT_3D_SIZE: обязательное поле/,
    );
  });

  it('одномерная таблица и неединичный домен — отказ, а не молчаливая подмена', () => {
    // Кривая на канал — другой механизм выборки; подставить вместо неё
    // трёхмерную значило бы нарисовать не то, что в файле.
    expectErrors('LUT_1D_SIZE 32\n0 0 0\n', /одномерная таблица \(LUT_1D_SIZE\) не поддерживается/);
    expectErrors(
      identityCube(2).replace('TITLE "тождество"', 'DOMAIN_MAX 4 4 4'),
      /DOMAIN_MAX поддерживается только единичный/,
    );
  });

  it('строка не той формы отвергается адресно, а не пропускается', () => {
    expectErrors(identityCube(2).replace('0 0 0', '0 0'), /ожидалась тройка RGB/);
  });
});

describe('ASSET-3: загрузчик `.cube` в реестре', () => {
  async function load(id: string, text: string): Promise<AssetState<ColorLut>> {
    const svc = new AssetService(new MemoryAssetSource(new Map([[id, bytesOf(text)]])));
    svc.registerLoader(cubeLutLoader);
    const handle: Handle<ColorLut> = svc.request(LUT_ASSET_KIND, id);
    return settled(svc, handle);
  }

  it('вид `lut` и расширение `.cube`: файл приезжает таблицей', async () => {
    const state = await load('visuals/luts/warm.cube', identityCube(2));
    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.data.size).toBe(2);
  });

  it('невалидный файл — `failed` с причиной, называющей строку, а не исключение', async () => {
    const state = await load('visuals/luts/broken.cube', 'LUT_3D_SIZE 2\n0 0 0\n');
    expect(state.status).toBe('failed');
    if (state.status !== 'failed') return;
    expect(state.reason).toContain('visuals/luts/broken.cube');
    expect(state.reason).toMatch(/троек/);
  });
});
